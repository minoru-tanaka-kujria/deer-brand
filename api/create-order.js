/**
 * Vercel Serverless Function
 * POST /api/create-order
 */

import Stripe from "stripe";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getAdminApp, verifyAuth } from "./_lib/auth.js";
import { calculateTotal } from "./_lib/products.js";
import { setCorsHeaders, handlePreflight } from "./_lib/cors.js";
import {
  sendOrderConfirmationEmail,
  triggerPrintfulOrder,
} from "./_lib/post-payment.js";

// モジュールスコープでキャッシュ
const _stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY.trim(), {
      apiVersion: "2024-04-10",
    })
  : null;

const STATUS_ORDER = {
  pending_payment: 0,
  printful_failed: 0,
  paid: 1,
  preparing: 2,
  printing: 2,
  shipped: 3,
  delivered: 4,
};

function canAdvanceStatus(currentStatus, nextStatus) {
  return (
    (STATUS_ORDER[nextStatus] ?? -1) >= (STATUS_ORDER[currentStatus] ?? -1)
  );
}

// 価格に関わるフィールドは必ず reservedOrder（Stripe Intent作成時に検証済み）を採用し、
// クライアント改竄による金額差異を遮断する。表示系の productName/placementName/colorName
// のみ body から補完可能とする。
function normalizeCheckoutItem(body, fallbackItem) {
  const source = fallbackItem ?? {};
  return {
    // 価格決定フィールド（body を信用しない、reservedOrder 固定）
    item: source.item ?? body?.item ?? body?.product,
    placementId: source.placementId ?? body?.placementId ?? body?.placement,
    colorId: source.colorId ?? body?.colorId ?? body?.color ?? null,
    size: source.size ?? body?.size ?? null,
    petCount: Number(source.petCount ?? body?.petCount ?? 1),
    style: source.style ?? body?.style ?? body?.styleId ?? null,
    // 表示系（body 優先で補完可）
    productName: body?.productName ?? source.productName ?? null,
    placementName:
      source.placementName ?? body?.placementName ?? body?.placement ?? null,
    colorName: source.colorName ?? body?.colorName ?? body?.color ?? null,
    petNames: Array.isArray(body?.petNames)
      ? body.petNames
          .filter((name) => typeof name === "string" && name.trim())
          .slice(0, 10)
      : Array.isArray(source.petNames)
        ? source.petNames
        : [],
  };
}

// アート画像URLの検証: HTTPSかつ許可ドメインのみ受理（SSRF・悪意URL対策）
const ALLOWED_ART_HOSTS = new Set([
  "custom.deer.gift",
  "deer.gift",
  "firebasestorage.googleapis.com",
  "replicate.delivery",
  "pbxt.replicate.delivery",
  "tjzk.replicate.delivery",
  "storage.googleapis.com",
]);
function sanitizeArtImageUrl(url) {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    if (!ALLOWED_ART_HOSTS.has(u.hostname)) return null;
    return url;
  } catch (_e) {
    return null;
  }
}

// ストレージ系 URL については uid 所有確認を行う。
// art-composites/{uid}/... のパスに uid が含まれるべき。
// 他人のアップロード済みアートを横取りして注文する攻撃を防ぐ。
function isArtUrlOwnedBy(url, uid) {
  if (!url || !uid) return false;
  try {
    const u = new URL(url);
    const pathname = decodeURIComponent(u.pathname);
    if (
      u.hostname === "storage.googleapis.com" ||
      u.hostname === "firebasestorage.googleapis.com"
    ) {
      return pathname.includes(`/${uid}/`);
    }
    // replicate.delivery の URL はハッシュベースでリンクが分からないため
    // 所有確認できない。この場合は "owned" とは判定せず false を返す。
    return false;
  } catch (_e) {
    return false;
  }
}

// Replicate の配信 URL は ~24h で失効するため、そのまま注文に保存すると
// 後日マイページやサポート対応で画像が表示できなくなる。
// 恒久保存対象として検出し、Storage に fetch→upload しておく。
const EPHEMERAL_ART_HOSTS = new Set([
  "replicate.delivery",
  "pbxt.replicate.delivery",
  "tjzk.replicate.delivery",
]);
function isEphemeralArtUrl(url) {
  try {
    return EPHEMERAL_ART_HOSTS.has(new URL(url).hostname);
  } catch (_e) {
    return false;
  }
}

// data: URL を Firebase Storage にアップロードして https URL 化。
// フレーム/ワッペン合成結果はブラウザ canvas で作られた data URL で届くため、
// Printful 等が要求する public URL に変換する必要がある。
// 戻り値: { url, source: "direct-https"|"data-upload"|"remote-upload"|"none" }
async function resolveArtImageUrl(rawUrl, { uid, orderId }) {
  if (typeof rawUrl !== "string") {
    return { url: null, source: "none", error: null };
  }
  // まずは https として直接受理できるか
  const directHttps = sanitizeArtImageUrl(rawUrl);
  if (directHttps) {
    // Replicate 等の短命 URL は注文保存前に Storage に fetch+upload して恒久化。
    // 失敗したら direct-https のまま返す（注文自体は続行、画像だけ将来切れる）。
    if (isEphemeralArtUrl(directHttps)) {
      try {
        const { uploadRemoteUrlToStorage } =
          await import("./_lib/art-upload.js");
        const persisted = await uploadRemoteUrlToStorage(directHttps, {
          uid,
          orderId,
        });
        if (persisted) {
          const sanitized = sanitizeArtImageUrl(persisted);
          if (sanitized) return { url: sanitized, source: "remote-upload" };
        }
        console.warn(
          "[create-order] remote persist produced unusable url, keeping original",
        );
      } catch (e) {
        console.warn(
          "[create-order] remote persist failed, keeping ephemeral url:",
          e?.message || e,
        );
      }
    }
    return { url: directHttps, source: "direct-https" };
  }
  // data: URL なら Storage にアップロードして https 化
  if (rawUrl.startsWith("data:")) {
    const { uploadDataUrlToStorage } = await import("./_lib/art-upload.js");
    try {
      const uploaded = await uploadDataUrlToStorage(rawUrl, { uid, orderId });
      if (uploaded) {
        const sanitized = sanitizeArtImageUrl(uploaded);
        if (sanitized) return { url: sanitized, source: "data-upload" };
        return {
          url: null,
          source: "none",
          error: "UPLOADED_URL_REJECTED_BY_SANITIZER",
        };
      }
      return {
        url: null,
        source: "none",
        error: "UPLOAD_RETURNED_NULL",
      };
    } catch (e) {
      console.error(
        "[create-order] data URL upload failed:",
        e && e.message ? e.message : e,
      );
      return {
        url: null,
        source: "none",
        error: `UPLOAD_FAILED:${e?.message || "unknown"}`,
      };
    }
  }
  return { url: null, source: "none", error: "UNSUPPORTED_ART_URL_SCHEME" };
}

function sanitizeShipping(shipping) {
  if (!shipping || typeof shipping !== "object") return null;
  return {
    fullName: shipping.fullName ?? shipping.name ?? "",
    email: shipping.email ?? "",
    phone: shipping.phone ?? "",
    zip: shipping.zip ?? "",
    prefecture: shipping.prefecture ?? "",
    address1: shipping.address1 ?? "",
    address2: shipping.address2 ?? "",
  };
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  let authUser;
  try {
    authUser = await verifyAuth(req);
  } catch (error) {
    console.error("[create-order] auth error:", error);
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  const {
    paymentIntentId,
    orderId: requestedOrderId,
    shippingAddress,
    artImageUrl,
    isGift,
    giftMessage,
    ordererInfo,
  } = req.body ?? {};
  if (!paymentIntentId && !requestedOrderId) {
    return res.status(400).json({ error: "INVALID_REQUEST" });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!stripeSecretKey) {
    console.error("[create-order] missing STRIPE_SECRET_KEY");
    return res.status(500).json({ error: "CONFIG_ERROR" });
  }

  const db = getFirestore(getAdminApp());
  const stripe = _stripe; // CONFIG_ERROR チェック済みなので必ず非null

  try {
    let paymentIntent = null;
    let orderId = requestedOrderId ?? "";

    if (paymentIntentId) {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      orderId = paymentIntent.metadata?.orderId ?? "";
      const paymentIntentUserId = paymentIntent.metadata?.userId ?? "";

      if (!orderId || paymentIntent.status !== "succeeded") {
        return res.status(400).json({ error: "INVALID_PAYMENT" });
      }
      if (paymentIntentUserId !== authUser.uid) {
        return res.status(403).json({ error: "FORBIDDEN" });
      }

      const duplicateSnap = await db
        .collection("orders")
        .where("paymentIntentId", "==", paymentIntentId)
        .get();
      const duplicateDocs = duplicateSnap.docs.filter(
        (doc) => doc.id !== orderId,
      );
      if (duplicateDocs.length > 0) {
        return res.status(409).json({ error: "PAYMENT_INTENT_ALREADY_USED" });
      }
    }

    const orderRef = db.collection("orders").doc(orderId);
    const userRef = db.collection("users").doc(authUser.uid);

    // data: URL の場合は Firebase Storage にアップロードして https 化してから
    // transaction に入る。トランザクション内で非同期 upload を走らせると競合する。
    const artResolution = await resolveArtImageUrl(artImageUrl, {
      uid: authUser.uid,
      orderId,
    });
    const resolvedArtImageUrl = artResolution.url;

    // クライアントが artImageUrl を送ってきたのに null に解決された場合は、
    // 「data URL upload 失敗」「URL が許可ドメイン外」等の障害を意味する。
    // reservedOrder.artImageUrl が無い状態でそのまま確定すると、生写真未確定のまま
    // Printful に流れる or 永久保留となるため 500 で拒否する。
    if (
      typeof artImageUrl === "string" &&
      artImageUrl.length > 0 &&
      !resolvedArtImageUrl
    ) {
      console.error(
        "[create-order] art image resolution failed:",
        artResolution.error,
      );
      return res.status(500).json({
        error: "ART_IMAGE_UNAVAILABLE",
        detail: artResolution.error,
      });
    }

    // direct-https の場合のみ所有確認を行う。data-upload はサーバ側で path を
    // 組み立てているので uid 付与されており安全。replicate.delivery はハッシュ
    // ベースで所有確認できないため許容（実被害低め、Replicate が生成URLを推測困難）。
    if (
      artResolution.source === "direct-https" &&
      resolvedArtImageUrl &&
      (resolvedArtImageUrl.includes("storage.googleapis.com") ||
        resolvedArtImageUrl.includes("firebasestorage.googleapis.com")) &&
      !isArtUrlOwnedBy(resolvedArtImageUrl, authUser.uid)
    ) {
      console.error(
        "[create-order] art image ownership mismatch:",
        authUser.uid,
      );
      return res.status(403).json({ error: "ART_IMAGE_NOT_OWNED" });
    }

    const result = await db.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) {
        throw new Error("ORDER_NOT_RESERVED");
      }

      const reservedOrder = orderSnap.data();
      if (reservedOrder.uid !== authUser.uid) {
        throw new Error("FORBIDDEN");
      }
      if (
        (reservedOrder.paymentIntentId ?? null) !== (paymentIntentId ?? null)
      ) {
        throw new Error("PAYMENT_MISMATCH");
      }
      if (
        reservedOrder.status !== "pending_payment" &&
        reservedOrder.status !== "paid"
      ) {
        throw new Error("ORDER_ALREADY_FINALIZED");
      }

      const item = normalizeCheckoutItem(req.body, reservedOrder.items?.[0]);
      const expectedAmount = calculateTotal({
        item: item.item,
        placement: item.placementId,
        color: item.colorId,
        size: item.size,
        petCount: item.petCount,
        couponDiscount: reservedOrder.couponDiscount ?? 0,
        igDiscount: reservedOrder.igDiscount ?? 0,
      });

      if (expectedAmount !== reservedOrder.amount) {
        throw new Error("AMOUNT_MISMATCH");
      }
      if (paymentIntent && expectedAmount !== paymentIntent.amount) {
        throw new Error("AMOUNT_MISMATCH");
      }

      const subtotal = calculateTotal({
        item: item.item,
        placement: item.placementId,
        color: item.colorId,
        size: item.size,
        petCount: item.petCount,
        couponDiscount: 0,
        igDiscount: 0,
      });
      if (expectedAmount === 0 && reservedOrder.couponDiscount !== subtotal) {
        throw new Error("INVALID_FREE_ORDER");
      }
      if (expectedAmount === 0 && reservedOrder.status !== "paid") {
        throw new Error("INVALID_FREE_ORDER");
      }

      const nextStatus = canAdvanceStatus(reservedOrder.status, "paid")
        ? "paid"
        : reservedOrder.status;
      const now = new Date();
      tx.set(
        orderRef,
        {
          orderId,
          uid: authUser.uid,
          email: authUser.email,
          emailVerified: authUser.emailVerified,
          items: [item],
          product: item.item,
          productName: item.productName,
          placement: item.placementName,
          placementId: item.placementId,
          style: item.style,
          color: item.colorId,
          size: item.size,
          petCount: item.petCount,
          petNames: item.petNames,
          // reservedOrder.artImageUrl は Stripe intent 作成時に書かれた可能性があるが、
          // その URL が期限切れ (Replicate delivery の署名付き等) の場合がある。
          // 新しく解決した URL を常に優先する。
          artImageUrl:
            resolvedArtImageUrl ??
            sanitizeArtImageUrl(reservedOrder.artImageUrl) ??
            null,
          total: expectedAmount,
          amount: expectedAmount,
          paymentIntentId,
          couponCode: reservedOrder.couponCode ?? null,
          couponDiscount: reservedOrder.couponDiscount ?? 0,
          igDiscount: reservedOrder.igDiscount ?? 0,
          shippingAddress:
            sanitizeShipping(shippingAddress) ??
            reservedOrder.shippingAddress ??
            null,
          isGift: !!isGift,
          giftMessage:
            typeof giftMessage === "string" ? giftMessage.slice(0, 200) : "",
          ordererInfo: isGift
            ? {
                name: String(ordererInfo?.name || "").slice(0, 100),
                email: String(ordererInfo?.email || "").slice(0, 200),
                phone: String(ordererInfo?.phone || "").slice(0, 20),
              }
            : null,
          status: nextStatus,
          paidAt: reservedOrder.paidAt ?? now,
          finalizedAt: now,
          updatedAt: now,
        },
        { merge: true },
      );
      tx.set(
        userRef,
        {
          orders: FieldValue.arrayUnion(orderId),
          updatedAt: now,
        },
        { merge: true },
      );

      return { orderId, couponCode: reservedOrder.couponCode ?? null };
    });

    // クーポン使用確定（P0-3）
    if (result.couponCode) {
      try {
        const couponRef = db.collection("coupons").doc(result.couponCode);
        const userRef2 = db.collection("users").doc(authUser.uid);
        await db.runTransaction(async (tx2) => {
          const [cSnap, uSnap] = await Promise.all([
            tx2.get(couponRef),
            tx2.get(userRef2),
          ]);
          const c = cSnap.data();
          if (!c || c.isActive === false) return;
          const maxUses = c.maxUses == null ? Infinity : Number(c.maxUses);
          if ((c.usedCount ?? 0) >= maxUses) return;
          if (
            uSnap.exists &&
            (uSnap.data().appliedCoupons ?? []).includes(result.couponCode)
          )
            return;
          tx2.update(couponRef, {
            usedCount: FieldValue.increment(1),
            updatedAt: new Date(),
          });
          tx2.set(
            userRef2,
            { appliedCoupons: FieldValue.arrayUnion(result.couponCode) },
            { merge: true },
          );
        });
      } catch (couponErr) {
        console.warn("[create-order] coupon usage mark failed:", couponErr);
      }
    }

    // 後処理（メール・Printful発注）を必ず実行する。
    // Webhook先行時は artImageUrl 未設定で両方スキップされるが、
    // ここで artImageUrl 含む完全な状態から再実行することで確実に処理される。
    // 冪等性は各関数内で保証（confirmationEmailSentAt / printfulOrderId チェック）。
    const finalOrderSnap = await db
      .collection("orders")
      .doc(result.orderId)
      .get();
    const finalOrder = finalOrderSnap.data();
    if (finalOrder) {
      sendOrderConfirmationEmail(db, finalOrder, result.orderId).catch((e) =>
        console.warn("[create-order] email error:", e),
      );
      triggerPrintfulOrder(db, finalOrder, result.orderId).catch((e) =>
        console.warn("[create-order] printful error:", e),
      );
    }

    return res.status(201).json(result);
  } catch (error) {
    console.error("[create-order] error:", error);

    if (error.message === "ORDER_NOT_RESERVED") {
      return res.status(400).json({ error: "ORDER_NOT_RESERVED" });
    }
    if (error.message === "FORBIDDEN") {
      return res.status(403).json({ error: "FORBIDDEN" });
    }
    if (
      error.message === "PAYMENT_MISMATCH" ||
      error.message === "AMOUNT_MISMATCH" ||
      error.message === "INVALID_FREE_ORDER" ||
      error.message === "INVALID_ITEM" ||
      error.message === "INVALID_PLACEMENT" ||
      error.message === "INVALID_COLOR" ||
      error.message === "INVALID_SIZE" ||
      error.message === "INVALID_PET_COUNT"
    ) {
      return res.status(400).json({ error: error.message });
    }
    if (error.message === "ORDER_ALREADY_FINALIZED") {
      return res.status(409).json({ error: "ORDER_ALREADY_FINALIZED" });
    }

    return res.status(500).json({ error: "ORDER_CREATE_FAILED" });
  }
}

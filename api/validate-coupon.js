import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp, verifyAuth } from "./_lib/auth.js";
import { consumeRateLimit, getClientIp } from "./_lib/rate-limit.js";
import { setCorsHeaders, handlePreflight } from "./_lib/cors.js";

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 1000;

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === "function") return value.toDate();
  return new Date(value);
}

function assertCouponUsable(coupon, subtotal = 0) {
  if (!coupon) {
    throw new Error("クーポンが見つかりません");
  }
  if (coupon.isActive === false) {
    throw new Error("このクーポンは現在使用できません");
  }

  const expiresAt = toDate(coupon.expiresAt);
  if (expiresAt && expiresAt < new Date()) {
    throw new Error("このクーポンの有効期限が切れています");
  }

  const usedCount = Number(coupon.usedCount ?? 0);
  const rawMaxUses = coupon.maxUses;
  const maxUses =
    rawMaxUses == null || rawMaxUses === ""
      ? Infinity
      : Number.isFinite(Number(rawMaxUses))
        ? Number(rawMaxUses)
        : Infinity;
  if (usedCount >= maxUses) {
    throw new Error("このクーポンは使用上限に達しています");
  }

  const minAmount = Math.max(0, Math.round(Number(coupon.minAmount ?? 0) || 0));
  if (subtotal < minAmount) {
    throw new Error("このクーポンは条件を満たしていません");
  }
}

/** クーポンデータを検証してdiscountを計算する */
function validateCouponData(coupon, subtotal) {
  try {
    assertCouponUsable(coupon, subtotal);
  } catch (error) {
    if (error.message === "このクーポンは条件を満たしていません") {
      const minAmount = Math.max(
        0,
        Math.round(Number(coupon?.minAmount ?? 0) || 0),
      );
      return {
        valid: false,
        message: `このクーポンは¥${minAmount.toLocaleString()}以上のご購入で使えます`,
      };
    }
    return {
      valid: false,
      message:
        error.message === "クーポンが見つかりません"
          ? "このクーポンコードは無効です"
          : error.message,
    };
  }

  // 割引額を計算
  let discount =
    coupon.type === "percent"
      ? Math.floor((subtotal * coupon.discount) / 100)
      : coupon.discount;

  // 割引額が商品金額を超えないよう制限
  discount = Math.min(discount, subtotal);

  const description =
    coupon.description ??
    `クーポン（${coupon.type === "percent" ? coupon.discount + "%" : "¥" + coupon.discount}OFF）`;

  return {
    valid: true,
    discount,
    type: coupon.type,
    message: `${description}：¥${discount.toLocaleString()}割引`,
  };
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let authUser;
  try {
    authUser = await verifyAuth(req);
  } catch (error) {
    console.error("[validate-coupon] auth error:", error);
    return res.status(401).json({ error: "認証が必要です" });
  }

  const body = req.body ?? {};
  const db = getFirestore(getAdminApp());

  try {
    await consumeRateLimit(
      db,
      `coupon_uid_${authUser.uid}`,
      RATE_LIMIT,
      RATE_WINDOW_MS,
    );
    await consumeRateLimit(
      db,
      `coupon_ip_${getClientIp(req)}`,
      RATE_LIMIT,
      RATE_WINDOW_MS,
    );
  } catch (error) {
    console.error("[validate-coupon] rate limit error:", error);
    return res
      .status(429)
      .json({ error: "リクエストが多すぎます。時間をおいてお試しください" });
  }

  // ── action: "use" は廃止 ──
  // 以前は決済前にクーポンを消費していたが、決済キャンセル時にクーポンが消費済み
  // のまま残る問題があったため、使用確定は create-order.js (決済成立後) に一本化。
  // クライアントが誤って古いパスを呼んだ場合は検証だけ行って success を返さない。
  if (body.action === "use") {
    return res.status(410).json({
      success: false,
      error:
        "このエンドポイントは廃止されました。クーポンは注文確定時に自動適用されます。",
      deprecated: true,
    });
  }

  // ── デフォルト: クーポン検証
  const { code, subtotal } = body;

  if (!code || typeof subtotal !== "number") {
    return res.status(400).json({ valid: false, message: "コードが不正です" });
  }

  const upperCode = String(code).trim().toUpperCase();

  // Firestoreからクーポンを取得
  try {
    const snap = await db.collection("coupons").doc(upperCode).get();

    if (!snap.exists) {
      return res
        .status(200)
        .json({ valid: false, message: "このクーポンコードは無効です" });
    }

    const coupon = snap.data();
    const result = validateCouponData(coupon, subtotal);

    return res.status(200).json(result);
  } catch (err) {
    console.error("[validate-coupon] Firestore error:", err);
    return res
      .status(503)
      .json({ valid: false, message: "クーポンを適用できませんでした" });
  }
}

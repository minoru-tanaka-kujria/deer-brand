import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAdminApp, verifyAuth } from "./_lib/auth.js";
import { consumeRateLimit, getClientIp } from "./_lib/rate-limit.js";

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 1000;
const BUSINESS_ERROR_MESSAGES = new Set([
  "クーポンが見つかりません",
  "このクーポンは現在使用できません",
  "このクーポンは使用上限に達しています",
  "このクーポンはすでに使用済みです",
  "このクーポンの有効期限が切れています",
  "このクーポンは条件を満たしていません",
]);

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
  const ALLOWED_ORIGINS = [
    "https://custom.deer.gift",
    "https://deer-brand.vercel.app",
    process.env.ALLOWED_ORIGIN,
  ].filter(Boolean);
  const origin = (req.headers.origin || "").trim();
  const corsOrigin =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/deer-brand[a-z0-9-]*\.vercel\.app$/.test(origin)
      ? origin
      : ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

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

  // ── action: "use" → クーポン使用確定（旧 /api/use-coupon）
  if (body.action === "use") {
    const { code, subtotal } = body;
    if (!code?.trim())
      return res
        .status(400)
        .json({ success: false, error: "クーポンを適用できませんでした" });
    if (typeof subtotal !== "number") {
      return res
        .status(400)
        .json({ success: false, error: "クーポンを適用できませんでした" });
    }
    const upperCode = String(code).trim().toUpperCase();
    try {
      const couponRef = db.collection("coupons").doc(upperCode);
      const userRef = db.collection("users").doc(authUser.uid);
      await db.runTransaction(async (tx) => {
        const [couponSnap, userSnap] = await Promise.all([
          tx.get(couponRef),
          tx.get(userRef),
        ]);
        const coupon = couponSnap.data();
        assertCouponUsable(coupon, subtotal);
        if (
          userSnap.exists &&
          (userSnap.data().appliedCoupons ?? []).includes(upperCode)
        )
          throw new Error("このクーポンはすでに使用済みです");
        tx.update(couponRef, {
          usedCount: FieldValue.increment(1),
          updatedAt: new Date(),
        });
        tx.set(
          userRef,
          { appliedCoupons: FieldValue.arrayUnion(upperCode) },
          { merge: true },
        );
      });
      console.log(
        `[validate-coupon/use] ${upperCode} 使用済み (uid: ${authUser.uid})`,
      );
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("[validate-coupon/use] エラー:", err);
      const isBusinessError = BUSINESS_ERROR_MESSAGES.has(err.message);
      return res.status(isBusinessError ? 400 : 500).json({
        success: false,
        error: isBusinessError ? err.message : "クーポンを適用できませんでした",
      });
    }
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

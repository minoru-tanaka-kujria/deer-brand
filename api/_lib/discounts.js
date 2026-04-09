import crypto from "node:crypto";

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === "function") return value.toDate();
  return new Date(value);
}

export async function resolveCouponDiscount({ db, code, subtotal }) {
  const upperCode = String(code ?? "")
    .trim()
    .toUpperCase();

  if (!upperCode) {
    return { couponCode: null, couponDiscount: 0, coupon: null };
  }

  const snap = await db.collection("coupons").doc(upperCode).get();
  if (!snap.exists) {
    throw new Error("INVALID_COUPON");
  }

  const coupon = snap.data();
  if (coupon.isActive === false) {
    throw new Error("INVALID_COUPON");
  }

  const expiresAt = toDate(coupon.expiresAt);
  if (expiresAt && expiresAt < new Date()) {
    throw new Error("INVALID_COUPON");
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
    throw new Error("INVALID_COUPON");
  }

  const minAmount = Math.max(0, Math.round(Number(coupon.minAmount ?? 0) || 0));
  if (subtotal < minAmount) {
    throw new Error("INVALID_COUPON");
  }

  const discount =
    coupon.type === "percent"
      ? Math.floor((subtotal * Number(coupon.discount ?? 0)) / 100)
      : Math.round(Number(coupon.discount ?? 0));

  return {
    couponCode: upperCode,
    couponDiscount: Math.min(Math.max(0, discount), subtotal),
    coupon,
  };
}

function getIgSecret() {
  return process.env.IG_DISCOUNT_SECRET?.trim() || "";
}

function signIgPayload(payload) {
  return crypto.createHmac("sha256", getIgSecret()).update(payload).digest("hex");
}

export function createIgDiscountToken({ uid, expiresInSeconds = 15 * 60 }) {
  const secret = getIgSecret();
  if (!secret || !uid) return null;

  const payload = JSON.stringify({
    uid,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });

  return `${Buffer.from(payload).toString("base64url")}.${signIgPayload(payload)}`;
}

export function resolveIgDiscount({ token, uid }) {
  if (!token) return 0;

  const secret = getIgSecret();
  if (!secret) {
    throw new Error("INVALID_IG_DISCOUNT");
  }

  const [encodedPayload, signature] = String(token).split(".");
  if (!encodedPayload || !signature) {
    throw new Error("INVALID_IG_DISCOUNT");
  }

  const payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  const expectedSignature = signIgPayload(payload);
  const validSignature =
    signature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));

  if (!validSignature) {
    throw new Error("INVALID_IG_DISCOUNT");
  }

  const parsed = JSON.parse(payload);
  const expiresAt = Number(parsed.exp ?? 0);
  if (!parsed.uid || parsed.uid !== uid || !expiresAt || expiresAt < Math.floor(Date.now() / 1000)) {
    throw new Error("INVALID_IG_DISCOUNT");
  }

  return 500;
}

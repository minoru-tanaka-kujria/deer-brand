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
  return crypto
    .createHmac("sha256", getIgSecret())
    .update(payload)
    .digest("hex");
}

export function createIgDiscountToken({ uid, expiresInSeconds = 15 * 60 }) {
  const secret = getIgSecret();
  if (!secret || !uid) return null;

  const payload = JSON.stringify({
    uid,
    jti: crypto.randomBytes(16).toString("hex"), // ユニークID（再利用防止の鍵）
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });

  return `${Buffer.from(payload).toString("base64url")}.${signIgPayload(payload)}`;
}

/**
 * IG割引トークンを検証し、500円割引を返す。
 * db を渡すと jti ベースで再利用防止（トランザクションで記録）。
 * db が無い場合は署名検証＋期限チェックのみ（金額計算プレビュー用途）。
 */
export async function resolveIgDiscount({
  token,
  uid,
  db = null,
  consume = false,
}) {
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
    crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );

  if (!validSignature) {
    throw new Error("INVALID_IG_DISCOUNT");
  }

  const parsed = JSON.parse(payload);
  const expiresAt = Number(parsed.exp ?? 0);
  if (
    !parsed.uid ||
    parsed.uid !== uid ||
    !expiresAt ||
    expiresAt < Math.floor(Date.now() / 1000)
  ) {
    throw new Error("INVALID_IG_DISCOUNT");
  }

  // db を渡しつつ consume=true なら、jti を使用済みに記録（二重適用防止）
  if (db && consume && parsed.jti) {
    const tokenRef = db.collection("usedIgTokens").doc(parsed.jti);
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(tokenRef);
      if (existing.exists) {
        throw new Error("INVALID_IG_DISCOUNT");
      }
      tx.set(tokenRef, {
        uid,
        usedAt: new Date(),
        // TTL設定推奨: 30日後に自動削除
      });
    });
  } else if (db && parsed.jti) {
    // 事前検証: 既に使用済みなら invalid
    const existing = await db.collection("usedIgTokens").doc(parsed.jti).get();
    if (existing.exists) {
      throw new Error("INVALID_IG_DISCOUNT");
    }
  }

  return 500;
}

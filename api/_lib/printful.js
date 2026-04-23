/**
 * Printful 発注に関する共通定数・ヘルパー
 *
 * post-payment.js (自動発注) と admin-api.js (管理画面手動発注) の両方で使われる。
 * キーは必ず api/_lib/products.js の PRODUCTS キーと一致させること。
 */

// products.js の PRODUCTS キーと 1:1 対応
export const PRINTFUL_PRODUCT_IDS = {
  tshirt: 71, // Bella+Canvas 3001
  hoodie: 380, // Cotton Heritage M2580
  mug: 19, // White Glossy Mug 11oz
  case: 601, // Tough Case for iPhone
  poster: 1, // Enhanced Matte Paper Poster
  postcard: 433, // Standard Postcard
  sticker: 358, // Kiss-Cut Stickers
  "emb-cap": 206, // Classic Dad Hat Yupoong 6245CM
  "emb-hoodie": 380, // Cotton Heritage M2580 (embroidery)
};

export const COLOR_MAP = {
  white: "White",
  black: "Black",
  gray: "Carbon Grey",
  navy: "Navy Blazer",
  pink: "Pink",
  beige: "Natural",
  khaki: "Khaki",
  natural: "Natural",
  glossy: "Glossy",
  matte: "Matte",
  default: "White",
};

export const PLACEMENT_FILE_TYPE = {
  "left-chest": "front",
  center: "front",
  back: "back",
  wrap: "front",
  full: "front",
  front: "front",
};

/**
 * Printful /products/{id}/variants から variant_id を取得。
 * 色・サイズの完全一致 → 色部分一致 → 色完全一致 → 先頭フォールバック の順で探す。
 */
export async function fetchVariantId(productId, colorName, size, apiKey) {
  const res = await fetch(
    `https://api.printful.com/products/${productId}/variants`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `Printful variant 取得失敗 (productId: ${productId}): HTTP ${res.status}`,
    );
  }
  const { result: variants = [] } = await res.json();
  const lColor = (colorName || "").toLowerCase();
  const lSize = (size || "").toUpperCase();
  const exact = variants.find(
    (v) => v.color?.toLowerCase() === lColor && v.size?.toUpperCase() === lSize,
  );
  if (exact) return exact.id;
  const partial = variants.find(
    (v) =>
      v.color?.toLowerCase().includes(lColor) &&
      v.size?.toUpperCase() === lSize,
  );
  if (partial) return partial.id;
  const colorOnly = variants.find((v) => v.color?.toLowerCase() === lColor);
  if (colorOnly) return colorOnly.id;
  const colorPartial = variants.find((v) =>
    v.color?.toLowerCase().includes(lColor),
  );
  if (colorPartial) return colorPartial.id;
  if (variants[0]?.id) return variants[0].id;
  throw new Error(
    `variant 未発見: productId=${productId} color=${colorName} size=${size}`,
  );
}

/**
 * 日本の配送先 (shippingAddress) を Printful recipient へ変換。
 *
 * 住所フォーム: { fullName, email, phone, zip, prefecture, address1, address2 }
 * Printful の city は必須。JP の address1 は通常 市区町村+町名+番地 を含むため、
 * city と address1 の両方に address1 を入れて情報欠落を避ける。
 */
export function buildRecipient(s = {}) {
  const address1 = s.address1 || s.street || "";
  const address2 = s.address2 || "";
  return {
    name: s.fullName || s.name || "",
    address1: address1 || "-",
    address2,
    city: address1 || "-",
    state_code: s.prefecture || s.state || "",
    country_code: "JP",
    zip: (s.zip || s.postalCode || "").replace(/-/g, ""),
    phone: s.phone || "",
    email: s.email || "",
  };
}

/**
 * 注文の placementId / placement から Printful file type を解決。
 * 刺繍商品は常に embroidery。
 */
export function resolveFileType(order) {
  const isEmb = order?.product === "emb-cap" || order?.product === "emb-hoodie";
  if (isEmb) return "embroidery";
  return (
    PLACEMENT_FILE_TYPE[order?.placementId || ""] ||
    PLACEMENT_FILE_TYPE[order?.placement || ""] ||
    "front"
  );
}

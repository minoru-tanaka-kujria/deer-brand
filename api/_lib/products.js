const APPAREL_SIZES = ["S", "M", "L", "XL", "2XL"];

export const PRODUCTS = {
  hoodie: {
    name: "パーカー",
    base: 7980,
    sizes: APPAREL_SIZES,
    colors: [
      { id: "gray", name: "グレー", hex: "#8B8B8B" },
      { id: "navy", name: "ネイビー", hex: "#2C3E5A" },
      { id: "black", name: "ブラック", hex: "#1a1a1a" },
      { id: "pink", name: "ピンク", hex: "#E8B4B8" },
      { id: "white", name: "ホワイト", hex: "#F5F5F0" },
    ],
    placements: [
      { id: "left-chest", name: "左胸ワンポイント", price: 0 },
      { id: "center", name: "胸中央プリント", price: 0 },
      { id: "back", name: "バックプリント", price: 2000 },
    ],
  },
  tshirt: {
    name: "Tシャツ",
    base: 4980,
    sizes: APPAREL_SIZES,
    colors: [
      { id: "white", name: "ホワイト", hex: "#F5F5F0" },
      { id: "black", name: "ブラック", hex: "#1a1a1a" },
      { id: "gray", name: "グレー", hex: "#8B8B8B" },
      { id: "pink", name: "ピンク", hex: "#E8B4B8" },
      { id: "beige", name: "ベージュ", hex: "#D4C5B2" },
    ],
    placements: [
      { id: "left-chest", name: "左胸ワンポイント", price: 0 },
      { id: "center", name: "胸中央プリント", price: 0 },
      { id: "back", name: "バックプリント", price: 1500 },
    ],
  },
  mug: {
    name: "マグカップ",
    base: 3480,
    sizes: [],
    colors: [{ id: "white", name: "ホワイト", hex: "#F5F5F0" }],
    placements: [{ id: "wrap", name: "ラップアラウンド", price: 0 }],
  },
  case: {
    name: "スマホケース",
    base: 4980,
    sizes: [],
    colors: [
      { id: "glossy", name: "グロス", hex: "#E8E8E8" },
      { id: "matte", name: "マット", hex: "#1a1a1a" },
    ],
    placements: [{ id: "back", name: "背面プリント", price: 0 }],
  },
  poster: {
    name: "アートポスター",
    base: 5480,
    sizes: [],
    colors: [
      { id: "white", name: "ホワイトフレーム", hex: "#F5F5F0" },
      { id: "natural", name: "ナチュラルフレーム", hex: "#C4A265" },
      { id: "black", name: "ブラックフレーム", hex: "#1a1a1a" },
    ],
    placements: [{ id: "full", name: "A3サイズ", price: 0 }],
  },
  postcard: {
    name: "ポストカード（5枚セット）",
    base: 1980,
    sizes: [],
    colors: [{ id: "white", name: "マットホワイト", hex: "#F5F5F0" }],
    placements: [{ id: "front", name: "フロントプリント", price: 0 }],
  },
  sticker: {
    name: "カッティングステッカー",
    base: 1980,
    sizes: [],
    colors: [{ id: "default", name: "フルカラー", hex: "#C4A265" }],
    placements: [{ id: "full", name: "ステッカー全面", price: 0 }],
  },
  "emb-cap": {
    name: "刺繍キャップ",
    base: 4980,
    sizes: [],
    colors: [
      { id: "black", name: "ブラック", hex: "#1a1a1a" },
      { id: "navy", name: "ネイビー", hex: "#2C3E5A" },
      { id: "white", name: "ホワイト", hex: "#F5F5F0" },
      { id: "khaki", name: "カーキ", hex: "#8B7D5A" },
    ],
    placements: [{ id: "front", name: "フロントパネル", price: 0 }],
  },
  "emb-hoodie": {
    name: "刺繍パーカー",
    base: 12980,
    sizes: APPAREL_SIZES,
    colors: [
      { id: "black", name: "ブラック", hex: "#1a1a1a" },
      { id: "navy", name: "ネイビー", hex: "#2C3E5A" },
      { id: "gray", name: "グレー", hex: "#8B8B8B" },
      { id: "white", name: "ホワイト", hex: "#F5F5F0" },
    ],
    placements: [
      { id: "left-chest", name: "左胸ワンポイント", price: 0 },
      { id: "back", name: "バック刺繍", price: 3000 },
    ],
  },
};

export const PET_COUNT_PRICES = {
  1: 0,
  2: 1000,
  3: 1500,
  4: 2000,
};

function resolveProduct(item) {
  const product = PRODUCTS[item];
  if (!product) {
    throw new Error("INVALID_ITEM");
  }
  return product;
}

function resolvePlacement(product, placementInput) {
  const placementValue =
    typeof placementInput === "object" && placementInput !== null
      ? placementInput.id ?? placementInput.name
      : placementInput;

  const placement = product.placements.find(
    (entry) => entry.id === placementValue || entry.name === placementValue,
  );

  if (!placement) {
    throw new Error("INVALID_PLACEMENT");
  }

  return placement;
}

function resolveColor(product, colorInput) {
  if (colorInput == null || colorInput === "") return null;
  const color = product.colors.find(
    (entry) => entry.id === colorInput || entry.name === colorInput,
  );
  if (!color) {
    throw new Error("INVALID_COLOR");
  }
  return color;
}

function resolveSize(product, sizeInput) {
  if (!product.sizes.length) return null;
  if (!sizeInput || !product.sizes.includes(sizeInput)) {
    throw new Error("INVALID_SIZE");
  }
  return sizeInput;
}

export function calculateTotal({
  item,
  placement,
  color,
  size,
  petCount = 1,
  couponDiscount = 0,
  igDiscount = 0,
}) {
  const product = resolveProduct(item);
  const placementData = resolvePlacement(product, placement);
  resolveColor(product, color);
  resolveSize(product, size);

  const normalizedPetCount = Number(petCount);
  if (!Number.isInteger(normalizedPetCount) || !(normalizedPetCount in PET_COUNT_PRICES)) {
    throw new Error("INVALID_PET_COUNT");
  }

  const total =
    product.base +
    placementData.price +
    PET_COUNT_PRICES[normalizedPetCount] -
    Math.max(0, Math.round(Number(couponDiscount) || 0)) -
    Math.max(0, Math.round(Number(igDiscount) || 0));

  return Math.max(0, total);
}

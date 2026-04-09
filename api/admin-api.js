/**
 * Vercel Serverless Function
 * POST /api/admin-api
 * Body: { action, adminKey, totpCode, ...params }
 *
 * 認証: adminKey + TOTP二段階認証 + ブルートフォース対策（10回失敗でロック）
 *
 * action 別ルーティング:
 *   "get-orders"            → 注文一覧取得 (params: limit, status)
 *   "update-status"         → ステータス更新 (params: orderId, status)
 *   "create-printful-order" → Printful発注  (params: orderId, artImageUrl)
 */

import { createHash, createHmac } from "crypto";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// ---------------------------------------------------------------------------
// Firebase Admin 初期化
// ---------------------------------------------------------------------------
function getAdminApp() {
  if (getApps().length > 0) return getApps()[0];
  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) 実装 — 外部ライブラリ不要
// ---------------------------------------------------------------------------
function base32Decode(s) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0,
    val = 0;
  const bytes = [];
  for (const c of clean) {
    const idx = alpha.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function verifyTOTP(code, secret) {
  if (!secret || !code) return false;
  const key = base32Decode(secret);
  const now = Math.floor(Date.now() / 1000 / 30);
  for (const w of [-1, 0, 1]) {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(BigInt(now + w));
    const hmac = createHmac("sha1", key).update(buf).digest();
    const off = hmac[19] & 0xf;
    const otp =
      (((hmac[off] & 0x7f) << 24) |
        ((hmac[off + 1] & 0xff) << 16) |
        ((hmac[off + 2] & 0xff) << 8) |
        (hmac[off + 3] & 0xff)) %
      1_000_000;
    if (String(otp).padStart(6, "0") === String(code).trim()) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// アカウントロック管理（Firestore: adminMeta/lockout_{ipHash}）
// ---------------------------------------------------------------------------
const MAX_FAILS = 10;
const LOCK_MS = 30 * 60 * 1000; // 30分

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

function getLockoutRef(db, req) {
  const ipHash = createHash("sha256").update(getClientIp(req)).digest("hex");
  return db.collection("adminMeta").doc(`lockout_${ipHash}`);
}

async function getLockoutStatus(db, req) {
  const snap = await getLockoutRef(db, req).get();
  if (!snap.exists) return { locked: false, failedCount: 0 };
  const d = snap.data();
  if (d.lockedUntil) {
    const until =
      d.lockedUntil.toDate instanceof Function
        ? d.lockedUntil.toDate()
        : new Date(d.lockedUntil);
    if (until > new Date()) {
      return {
        locked: true,
        minutesLeft: Math.ceil((until - new Date()) / 60000),
      };
    }
  }
  return { locked: false, failedCount: d.failedCount ?? 0 };
}

async function recordFailure(db, req) {
  const ref = getLockoutRef(db, req);
  const snap = await ref.get();
  const now = new Date();
  const d = snap.exists ? snap.data() : { failedCount: 0 };

  const lastFailed = d.lastFailedAt?.toDate
    ? d.lastFailedAt.toDate()
    : d.lastFailedAt
      ? new Date(d.lastFailedAt)
      : null;
  const reset = !lastFailed || now - lastFailed > LOCK_MS;
  const newCount = reset ? 1 : (d.failedCount || 0) + 1;
  const lockedUntil =
    newCount >= MAX_FAILS ? new Date(now.getTime() + LOCK_MS) : null;

  await ref.set({ failedCount: newCount, lastFailedAt: now, lockedUntil });
  return { newCount, locked: !!lockedUntil };
}

async function resetFailures(db, req) {
  await getLockoutRef(db, req).set({
    failedCount: 0,
    lastFailedAt: null,
    lockedUntil: null,
  });
}

// ---------------------------------------------------------------------------
// 入力サニタイズ
// ---------------------------------------------------------------------------
function sanitizeStr(v) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, 500);
}

// ---------------------------------------------------------------------------
// Printful 商品マッピング
// ---------------------------------------------------------------------------
const PRINTFUL_PRODUCT_IDS = {
  tshirt: 71,       // Bella+Canvas 3001
  hoodie: 380,      // Cotton Heritage M2580
  mug: 19,          // White Glossy Mug
  case: 601,        // Tough Case for iPhone®
  poster: 1,        // Enhanced Matte Paper Poster
  postcard: 433,    // Standard Postcard
  "emb-cap": 206,   // Classic Dad Hat Yupoong 6245CM
  "emb-hoodie": 380,// Cotton Heritage M2580（刺繍）
  sticker: 358,     // Kiss-Cut Stickers
};

const COLOR_MAP = {
  // tshirt (Bella+Canvas 3001)
  white: "White",
  black: "Black",
  gray: "Carbon Grey",   // hoodie用。tshirtは"Sport Grey"だがvariantルックアップで自動マッチ
  navy: "Navy Blazer",   // hoodie用。tshirtは"Navy"だがvariantルックアップで自動マッチ
  pink: "Pink",          // tshirt="Pink", hoodie="Light Pink"
  beige: "Natural",
  // emb-cap (Yupoong 6245CM)
  khaki: "Khaki",
  // poster
  natural: "Natural",
  // case (Tough Case for iPhone)
  glossy: "Glossy",
  matte: "Matte",
  // fallback
  default: "White",
};

const PLACEMENT_FILE_TYPE = {
  "left-chest": "front",
  center: "front",
  back: "back",
  wrap: "front",
  full: "front",
  front: "front",
};

const VALID_STATUSES = [
  "pending",
  "preparing",
  "shipped",
  "delivered",
  "cancelled",
  "printing",
];

// ---------------------------------------------------------------------------
// Printful variant_id 動的ルックアップ
// ---------------------------------------------------------------------------
async function fetchVariantId(productId, colorName, size, apiKey) {
  const res = await fetch(
    `https://api.printful.com/products/${productId}/variants`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (!res.ok)
    throw new Error(
      `Printful variant取得失敗 (productId: ${productId}): HTTP ${res.status}`,
    );
  const { result: variants = [] } = await res.json();
  const lColor = (colorName || "").toLowerCase();
  const lSize = (size || "").toUpperCase();
  // 1. 色+サイズ完全一致
  const exact = variants.find(
    (v) => v.color?.toLowerCase() === lColor && v.size?.toUpperCase() === lSize,
  );
  if (exact) return exact.id;
  // 2. 色の部分一致+サイズ完全一致（例: "navy" → "Navy Blazer"）
  const partial = variants.find(
    (v) => v.color?.toLowerCase().includes(lColor) && v.size?.toUpperCase() === lSize,
  );
  if (partial) return partial.id;
  // 3. 色完全一致のみ
  const colorOnly = variants.find((v) => v.color?.toLowerCase() === lColor);
  if (colorOnly) return colorOnly.id;
  // 4. 色部分一致のみ
  const colorPartial = variants.find((v) => v.color?.toLowerCase().includes(lColor));
  if (colorPartial) return colorPartial.id;
  // 5. フォールバック
  if (variants[0]?.id) return variants[0].id;
  throw new Error(
    `variant未発見: productId=${productId} color=${colorName} size=${size}`,
  );
}

// ---------------------------------------------------------------------------
// 日本住所フォーマット
// ---------------------------------------------------------------------------
function buildRecipient(addr = {}) {
  return {
    name: addr.name || "",
    address1: addr.address1 || addr.street || "",
    address2: addr.address2 || "",
    city: addr.city || "",
    state_code: addr.prefecture || addr.state || "",
    country_code: "JP",
    zip: (addr.zip || addr.postalCode || "").replace("-", ""),
    phone: addr.phone || "",
    email: addr.email || "",
  };
}

// ---------------------------------------------------------------------------
// アクション: 注文一覧取得
// ---------------------------------------------------------------------------
async function actionGetOrders(db, body) {
  const { limit = 50, status } = body;
  let query = db
    .collection("orders")
    .orderBy("createdAt", "desc")
    .limit(Math.min(Number(limit) || 50, 200));
  if (status) {
    query = db
      .collection("orders")
      .where("status", "==", status)
      .orderBy("createdAt", "desc")
      .limit(Math.min(Number(limit) || 50, 200));
  }
  const snapshot = await query.get();
  const orders = snapshot.docs.map((doc) => {
    const d = doc.data();
    return {
      ...d,
      createdAt: d.createdAt?.toDate?.()?.toISOString() ?? d.createdAt ?? null,
      updatedAt: d.updatedAt?.toDate?.()?.toISOString() ?? d.updatedAt ?? null,
    };
  });
  return { orders };
}

// ---------------------------------------------------------------------------
// アクション: ステータス更新
// ---------------------------------------------------------------------------
async function actionUpdateStatus(db, body) {
  const orderId = sanitizeStr(body.orderId);
  const status = sanitizeStr(body.status);
  if (!orderId)
    throw Object.assign(new Error("orderId は必須です"), { status: 400 });
  if (!VALID_STATUSES.includes(status))
    throw Object.assign(
      new Error(`status は ${VALID_STATUSES.join(", ")} のいずれか`),
      { status: 400 },
    );
  const ref = db.collection("orders").doc(orderId);
  if (!(await ref.get()).exists)
    throw Object.assign(new Error("注文が見つかりません"), { status: 404 });
  await ref.update({ status, updatedAt: new Date() });
  return { success: true };
}

// ---------------------------------------------------------------------------
// アクション: Printful 発注
// ---------------------------------------------------------------------------
async function actionCreatePrintfulOrder(db, body) {
  const orderId = sanitizeStr(body.orderId);
  const artImageUrl = sanitizeStr(body.artImageUrl);
  if (!orderId)
    throw Object.assign(new Error("orderId は必須です"), { status: 400 });
  if (!artImageUrl)
    throw Object.assign(new Error("artImageUrl は必須です"), { status: 400 });

  const printfulApiKey = process.env.PRINTFUL_API_KEY;
  if (!printfulApiKey)
    throw Object.assign(new Error("PRINTFUL_API_KEY not configured"), {
      status: 503,
    });

  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists)
    throw Object.assign(new Error("注文が見つかりません"), { status: 404 });
  const order = orderSnap.data();
  if (order.printfulOrderId) {
    throw Object.assign(new Error("既にPrintful発注済みの注文です"), {
      status: 409,
    });
  }

  const productId = PRINTFUL_PRODUCT_IDS[order.product];
  if (!productId)
    throw Object.assign(new Error(`未対応商品: ${order.product}`), {
      status: 400,
    });

  const colorName = COLOR_MAP[order.color || ""] || "White";
  const variantId = await fetchVariantId(
    productId,
    colorName,
    order.size || "",
    printfulApiKey,
  );
  const isEmb = order.product === "emb-cap" || order.product === "emb-hoodie";
  const fileType = isEmb
    ? "embroidery"
    : PLACEMENT_FILE_TYPE[order.placement || ""] || "front";

  const fileEntry = { url: artImageUrl, type: fileType };
  if (!isEmb) {
    fileEntry.position = {
      area_width: 1800,
      area_height: 2400,
      width: 1800,
      height: 1800,
      top: 300,
      left: 0,
    };
  }

  const printfulBody = {
    recipient: buildRecipient(order.shippingAddress),
    items: [{ variant_id: variantId, quantity: 1, files: [fileEntry] }],
    retail_costs: { currency: "JPY", subtotal: String(order.total ?? 0) },
  };

  const pfRes = await fetch("https://api.printful.com/orders", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${printfulApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(printfulBody),
  });
  const pfData = await pfRes.json();
  if (!pfRes.ok)
    throw Object.assign(
      new Error(
        `Printful APIエラー: ${pfData.result ?? pfData.error ?? "不明"}`,
      ),
      { status: 502 },
    );

  const printfulOrderId = pfData.result?.id ?? null;
  const printfulOrderUrl = printfulOrderId
    ? `https://www.printful.com/dashboard/orders/${printfulOrderId}`
    : null;

  await orderRef.update({
    printfulOrderId,
    printfulOrderUrl,
    artImageUrl,
    status: "printing",
    updatedAt: new Date(),
  });
  return { success: true, printfulOrderId, printfulOrderUrl };
}

function getPublicErrorMessage(status) {
  if (status === 400) return "リクエストが不正です";
  if (status === 404) return "対象が見つかりません";
  if (status === 409) return "この注文は既に処理済みです";
  if (status === 503) return "サービスを利用できません";
  return "処理に失敗しました";
}

// ---------------------------------------------------------------------------
// メインハンドラ
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const ALLOWED_ORIGINS = [
    "https://custom.deer.gift",
    "https://deer-brand.vercel.app",
    process.env.ALLOWED_ORIGIN,
  ].filter(Boolean);
  const origin = (req.headers.origin || "").trim();
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) || origin.endsWith(".vercel.app")
    ? origin
    : ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const body = req.body ?? {};

  let db;
  try {
    db = getFirestore(getAdminApp());
  } catch {
    return res.status(500).json({ error: "サービスエラーが発生しました" });
  }

  // ── ① アカウントロック確認 ──────────────────────────────────────────────
  const lockStatus = await getLockoutStatus(db, req);
  if (lockStatus.locked) {
    return res.status(429).json({
      error: `アカウントがロックされています。${lockStatus.minutesLeft}分後に再試行してください。`,
    });
  }

  // ── ② 管理者キー検証 ───────────────────────────────────────────────────
  const adminSecretKey = process.env.ADMIN_SECRET_KEY;
  if (
    !adminSecretKey ||
    (body.adminKey ?? "").trim() !== adminSecretKey.trim()
  ) {
    const f = await recordFailure(db, req);
    const remaining = Math.max(0, MAX_FAILS - f.newCount);
    const msg = f.locked
      ? "認証に失敗しました。アカウントがロックされました（30分後に解除）。"
      : `認証に失敗しました（残り${remaining}回）。`;
    return res.status(401).json({ error: msg });
  }

  // ── ③ TOTP 検証（ADMIN_TOTP_SECRET が設定されている場合のみ） ──────────
  const totpSecret = process.env.ADMIN_TOTP_SECRET;
  if (totpSecret) {
    const code = sanitizeStr(String(body.totpCode || ""));
    if (!code) {
      // コード未入力 → 失敗カウントせずTOTP入力を促すだけ
      return res.status(401).json({ requiresTOTP: true });
    }
    if (!verifyTOTP(code, totpSecret)) {
      // コードが間違っている → 失敗カウント
      const f = await recordFailure(db, req);
      const remaining = Math.max(0, MAX_FAILS - f.newCount);
      const msg = f.locked
        ? "認証コードが正しくありません。アカウントがロックされました（30分後に解除）。"
        : `認証コードが正しくありません（残り${remaining}回）。`;
      return res.status(401).json({ error: msg, requiresTOTP: true });
    }
  }

  // ── ④ 認証成功 → 失敗カウントリセット ───────────────────────────────────
  await resetFailures(db, req);

  const { action } = body;
  if (!action) return res.status(400).json({ error: "action は必須です" });

  try {
    let result;
    if (action === "get-orders") {
      result = await actionGetOrders(db, body);
    } else if (action === "update-status") {
      result = await actionUpdateStatus(db, body);
    } else if (action === "create-printful-order") {
      result = await actionCreatePrintfulOrder(db, body);
    } else {
      return res.status(400).json({ error: `不明な action: ${action}` });
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error(`[admin-api/${action}] エラー:`, err);
    return res
      .status(err.status || 500)
      .json({ error: getPublicErrorMessage(err.status || 500) });
  }
}

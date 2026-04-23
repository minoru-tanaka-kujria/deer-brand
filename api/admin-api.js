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

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp } from "./_lib/auth.js";
import { setCorsHeaders, handlePreflight } from "./_lib/cors.js";
import {
  PRINTFUL_PRODUCT_IDS,
  COLOR_MAP,
  PLACEMENT_FILE_TYPE,
  fetchVariantId,
  buildRecipient,
} from "./_lib/printful.js";

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

const VALID_STATUSES = [
  "pending",
  "pending_payment",
  "paid",
  "preparing",
  "printing",
  "shipped",
  "delivered",
  "cancelled",
  "printful_failed",
];

// ---------------------------------------------------------------------------
// アクション: 注文一覧取得
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// アクション: エラーレポート一覧取得（js/sentry-init.js が書き込んだ実機エラー）
// ---------------------------------------------------------------------------
async function actionGetErrorReports(db, body) {
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);
  const snap = await db
    .collection("errorReports")
    .orderBy("reportedAt", "desc")
    .limit(limit)
    .get();
  const reports = snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      reportedAt:
        d.reportedAt?.toDate?.()?.toISOString() ?? d.reportedAt ?? null,
      ip: d.ip ?? null,
      userAgent: d.userAgent ?? null,
      referer: d.referer ?? null,
      count: d.count ?? 0,
      errors: d.errors ?? [],
    };
  });
  return { reports, fetched: reports.length };
}

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
const ALLOWED_ART_HOSTS = new Set([
  "custom.deer.gift",
  "deer.gift",
  "firebasestorage.googleapis.com",
  "replicate.delivery",
  "pbxt.replicate.delivery",
  "tjzk.replicate.delivery",
  "storage.googleapis.com",
]);
function validateArtUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (!ALLOWED_ART_HOSTS.has(u.hostname)) return false;
    return true;
  } catch (_e) {
    return false;
  }
}

async function actionCreatePrintfulOrder(db, body) {
  const orderId = sanitizeStr(body.orderId);
  const artImageUrl = sanitizeStr(body.artImageUrl);
  if (!orderId)
    throw Object.assign(new Error("orderId は必須です"), { status: 400 });
  if (!artImageUrl)
    throw Object.assign(new Error("artImageUrl は必須です"), { status: 400 });
  if (!validateArtUrl(artImageUrl))
    throw Object.assign(
      new Error(
        "artImageUrl は https で deer.gift / Firebase Storage / Replicate ドメインのみ受理可能です",
      ),
      { status: 400 },
    );

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
    : PLACEMENT_FILE_TYPE[order.placementId || ""] ||
      PLACEMENT_FILE_TYPE[order.placement || ""] ||
      "front";

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

// ---------------------------------------------------------------------------
// アクション: 要救済注文の一覧取得 & 自動再発注
//   pendingArtRecovery=true の注文 / printful_failed ステータスの注文を洗い出す
// ---------------------------------------------------------------------------
async function actionListPendingOrders(db, _body) {
  const snap = await db
    .collection("orders")
    .where("status", "in", ["paid", "printful_failed"])
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  const pending = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    if (
      (d.pendingArtRecovery === true || d.printfulFailed === true) &&
      !d.printfulOrderId
    ) {
      pending.push({
        orderId: doc.id,
        uid: d.uid,
        email: d.email,
        product: d.product,
        productName: d.productName,
        artImageUrl: d.artImageUrl || null,
        hasArtImage: !!d.artImageUrl,
        pendingArtRecovery: !!d.pendingArtRecovery,
        printfulFailed: !!d.printfulFailed,
        printfulError: d.printfulError || null,
        status: d.status,
        amount: d.amount ?? d.total ?? 0,
        createdAt:
          d.createdAt?.toDate?.()?.toISOString() ?? d.createdAt ?? null,
        updatedAt:
          d.updatedAt?.toDate?.()?.toISOString() ?? d.updatedAt ?? null,
      });
    }
  }
  return { pending };
}

async function actionRetryPrintful(db, body) {
  const orderId = sanitizeStr(body.orderId);
  if (!orderId)
    throw Object.assign(new Error("orderId は必須です"), { status: 400 });
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists)
    throw Object.assign(new Error("注文が見つかりません"), { status: 404 });
  const order = orderSnap.data();
  if (order.printfulOrderId)
    throw Object.assign(new Error("既にPrintful発注済みです"), { status: 409 });
  if (!order.artImageUrl)
    throw Object.assign(
      new Error("artImageUrl が未確定のため自動リトライできません"),
      { status: 400 },
    );

  const { triggerPrintfulOrder } = await import("./_lib/post-payment.js");
  await triggerPrintfulOrder(db, order, orderId);
  const after = (await orderRef.get()).data();
  return {
    success: !!after.printfulOrderId,
    printfulOrderId: after.printfulOrderId || null,
    status: after.status,
    printfulError: after.printfulError || null,
  };
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
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;

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

  // ── ② 管理者キー検証（タイミング攻撃耐性 timingSafeEqual）─────────────
  const adminSecretKey = process.env.ADMIN_SECRET_KEY;
  const providedKey = (body.adminKey ?? "").trim();
  const expectedKey = adminSecretKey ? adminSecretKey.trim() : "";
  const keyMatches = (() => {
    if (!expectedKey) return false;
    const a = Buffer.from(providedKey);
    const b = Buffer.from(expectedKey);
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch (_e) {
      return false;
    }
  })();
  if (!keyMatches) {
    const f = await recordFailure(db, req);
    const remaining = Math.max(0, MAX_FAILS - f.newCount);
    const msg = f.locked
      ? "認証に失敗しました。アカウントがロックされました（30分後に解除）。"
      : `認証に失敗しました（残り${remaining}回）。`;
    return res.status(401).json({ error: msg });
  }

  // ── ③ TOTP 検証（secure-by-default: 未設定時は管理APIを全面ロック）─────
  const totpSecret = process.env.ADMIN_TOTP_SECRET;
  if (!totpSecret) {
    console.error(
      "[admin-api] ADMIN_TOTP_SECRET 未設定のため管理APIを拒否します",
    );
    return res.status(503).json({
      error:
        "管理APIは2要素認証が必須です。環境変数 ADMIN_TOTP_SECRET を設定してください。",
    });
  }
  {
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
    } else if (action === "get-error-reports") {
      result = await actionGetErrorReports(db, body);
    } else if (action === "list-pending-orders") {
      result = await actionListPendingOrders(db, body);
    } else if (action === "retry-printful") {
      result = await actionRetryPrintful(db, body);
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

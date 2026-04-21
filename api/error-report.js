/**
 * /api/error-report
 *
 * POST { errors: [...] }
 *   → { ok: true, stored: N }
 *
 * SENTRY_DSN 未設定でも実機エラーを収集するための軽量エンドポイント。
 * Firestore の errorReports コレクションに append して、後で管理画面から
 * 確認可能にする。
 *
 * 認証: 不要（エラー発生時点で未ログインの場合もあるため）
 * レートリミット: IP ベース 30 req/min
 */

import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp } from "./_lib/auth.js";
import { consumeRateLimit, getClientIp } from "./_lib/rate-limit.js";
import { setCorsHeaders, handlePreflight } from "./_lib/cors.js";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_ERRORS_PER_REQUEST = 50;
const MAX_MSG_LENGTH = 4000;

// Vercel maxDuration は vercel.json の functions で設定する（config export は Vercel 非対応）

function truncate(s, n) {
  if (typeof s !== "string") return s;
  return s.length > n ? s.slice(0, n) + "…[truncated]" : s;
}

export default async function handler(req, res) {
  setCorsHeaders(req, res, "POST, OPTIONS");
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const db = getFirestore(getAdminApp());
  try {
    await consumeRateLimit(
      db,
      `error_report_ip_${getClientIp(req)}`,
      RATE_LIMIT,
      RATE_WINDOW_MS,
    );
  } catch (_) {
    return res.status(429).json({ error: "Too many error reports" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "invalid JSON" });
    }
  }

  const errors = Array.isArray(body?.errors) ? body.errors : null;
  if (!errors || errors.length === 0) {
    return res.status(400).json({ error: "errors 配列が必要です" });
  }
  if (errors.length > MAX_ERRORS_PER_REQUEST) {
    errors.length = MAX_ERRORS_PER_REQUEST;
  }

  // サイズ制限・サニタイズ
  const sanitized = errors.map((e) => ({
    t: typeof e.t === "number" ? e.t : Date.now(),
    type: truncate(e.type || "error", 40),
    message: truncate(e.message, MAX_MSG_LENGTH),
    source: truncate(e.source, 500),
    line: typeof e.line === "number" ? e.line : null,
    col: typeof e.col === "number" ? e.col : null,
    stack: truncate(e.stack, MAX_MSG_LENGTH),
    violatedDirective: truncate(e.violatedDirective, 200),
    blockedURI: truncate(e.blockedURI, 500),
    ctx: e.ctx || null,
  }));

  try {
    await db.collection("errorReports").add({
      reportedAt: new Date(),
      ip: getClientIp(req),
      userAgent: req.headers["user-agent"] || null,
      path: req.headers.referer || null,
      errors: sanitized,
      count: sanitized.length,
    });
    return res.json({ ok: true, stored: sanitized.length });
  } catch (error) {
    console.error("[error-report] Firestore write failed:", error.message);
    return res.status(500).json({ error: "failed to store" });
  }
}

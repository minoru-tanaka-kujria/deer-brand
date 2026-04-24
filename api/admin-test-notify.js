/**
 * 管理者専用：エラー通知の動作テスト用エンドポイント。
 *
 *   POST /api/admin-test-notify
 *   Body: { adminKey: "ADMIN_SECRET_KEY", message?: "..." }
 *
 * notifyError() を発火させて、minorufish@gmail.com に
 *   「修正を Claude に依頼」ボタン付きメールが届くか確認するためだけのもの。
 *
 * 動作確認後は削除して構わない。
 */
import { timingSafeEqual } from "node:crypto";
import { setCorsHeaders, handlePreflight } from "./_lib/cors.js";
import { notifyError } from "./_lib/error-notifier.js";

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const adminKey = String(req.body?.adminKey || "").trim();
  const expected = String(process.env.ADMIN_SECRET_KEY || "").trim();
  const a = Buffer.from(adminKey);
  const b = Buffer.from(expected);
  const ok =
    expected.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  const msg =
    String(req.body?.message || "").trim() ||
    `テスト通知 ${new Date().toISOString()} — error-notifier 動作確認`;

  const fakeErr = new Error(msg);
  fakeErr.stack = `TestError: ${msg}\n    at admin-test-notify (manual test)\n    at user request`;

  const result = await notifyError({
    err: fakeErr,
    route: "POST /api/admin-test-notify (manual)",
    context: {
      triggeredBy: "admin-test-notify",
      timestamp: new Date().toISOString(),
    },
  });

  return res.status(200).json({
    ok: true,
    result,
    note: "minorufish@gmail.com にメールが届くはず。未着の場合は Vercel Function logs を確認。",
  });
}

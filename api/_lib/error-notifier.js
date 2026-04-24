/**
 * 本番エラー → メール (+Slack) 自動通知 + 修正依頼ボタン埋め込み。
 *
 *   notifyError({ err, route, context, level })
 *     → Firestore (errorReports/{id}) に詳細保存
 *     → minorufish@gmail.com (ERROR_REPORT_EMAIL で上書き可) に
 *        サマリ + 「Claudeに自動修正させる」ボタン付き HTML メール送信
 *     → 既存 SLACK_WEBHOOK_URL があれば併せて簡易通知
 *
 * 同じ key (route + err.message ハッシュ) は 5 分間 dedupe。
 */
import crypto from "node:crypto";
import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp } from "./auth.js";
import { sendEmail } from "./email.js";
import { notifySlack } from "./slack-notify.js";

const DEFAULT_REPORT_EMAIL = "minorufish@gmail.com";
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const _dedupe = new Map();

function dedupeHit(key) {
  const last = _dedupe.get(key);
  if (last && Date.now() - last < DEDUPE_WINDOW_MS) return true;
  _dedupe.set(key, Date.now());
  if (_dedupe.size > 200) {
    const oldest = [..._dedupe.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) _dedupe.delete(oldest[0]);
  }
  return false;
}

function shortHash(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
}

function signId(id) {
  const secret = process.env.FIX_DISPATCH_SECRET;
  if (!secret) return "";
  return crypto
    .createHmac("sha256", secret)
    .update(id)
    .digest("hex")
    .slice(0, 32);
}

function buildEmailHtml({ id, sig, route, message, stack, context }) {
  const baseUrl = process.env.PUBLIC_BASE_URL || "https://custom.deer.gift";
  const fixUrl = sig
    ? `${baseUrl}/api/get-user?type=fix-dispatch&id=${encodeURIComponent(id)}&sig=${sig}`
    : "";
  const ctxRows = context
    ? Object.entries(context)
        .map(
          ([k, v]) =>
            `<tr><td style="padding:4px 8px;color:#666;font-size:12px">${escapeHtml(k)}</td><td style="padding:4px 8px;font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(
              typeof v === "string" ? v : JSON.stringify(v),
            )}</td></tr>`,
        )
        .join("")
    : "";
  const stackHtml = stack
    ? `<pre style="background:#f4f4f4;padding:12px;border-radius:6px;font-size:11px;overflow:auto;max-height:280px">${escapeHtml(stack.slice(0, 4000))}</pre>`
    : "";
  const button = fixUrl
    ? `<p style="margin:24px 0">
        <a href="${fixUrl}" style="display:inline-block;background:#1a3a52;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px">🔧 Claudeに自動修正させる</a>
       </p>
       <p style="font-size:11px;color:#999">クリックで Mac mini 上の Claude が修正PRを自動作成します</p>`
    : `<p style="font-size:12px;color:#c00">⚠ FIX_DISPATCH_SECRET が未設定のため自動修正ボタンは無効です</p>`;
  return `<!doctype html><html><body style="font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;color:#222;max-width:680px;margin:0 auto;padding:24px">
    <h2 style="color:#c0392b;margin:0 0 8px">🚨 Deer 本番エラー</h2>
    <p style="color:#666;font-size:13px;margin:0 0 16px">${escapeHtml(new Date().toISOString())}</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:16px;background:#fafafa;border:1px solid #eee;border-radius:6px">
      <tr><td style="padding:4px 8px;color:#666;font-size:12px">エンドポイント</td><td style="padding:4px 8px;font-family:ui-monospace,monospace;font-size:13px"><b>${escapeHtml(route || "(unknown)")}</b></td></tr>
      <tr><td style="padding:4px 8px;color:#666;font-size:12px">メッセージ</td><td style="padding:4px 8px;font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(message || "")}</td></tr>
      ${ctxRows}
    </table>
    ${stackHtml}
    ${button}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="font-size:11px;color:#aaa">エラーID: ${escapeHtml(id)}</p>
   </body></html>`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 本番エラーを通知する（メール + Slack + Firestore 保存）。
 * 失敗しても呼び出し元には例外を投げない（通知失敗で本処理を巻き込まない）。
 */
export async function notifyError({
  err,
  route,
  context,
  level = "error",
} = {}) {
  try {
    const message = err?.message || String(err || "(no message)");
    const stack = err?.stack || "";
    const dedupeKey = `${route || "?"}:${shortHash(message)}`;
    if (dedupeHit(dedupeKey)) {
      return { skipped: "deduped" };
    }

    const id = crypto.randomUUID();
    const sig = signId(id);
    const createdAt = new Date().toISOString();

    // Firestore 保存（失敗しても続行）
    try {
      const db = getFirestore(getAdminApp());
      await db
        .collection("apiErrorReports")
        .doc(id)
        .set({
          id,
          route: route || null,
          message,
          stack,
          context: context || null,
          level,
          createdAt,
          status: "open",
        });
    } catch (e) {
      console.warn("[error-notifier] firestore save failed:", e?.message || e);
    }

    // メール送信
    const to = process.env.ERROR_REPORT_EMAIL || DEFAULT_REPORT_EMAIL;
    const subject = `[Deer 本番エラー] ${route || "?"} — ${String(message).slice(0, 80)}`;
    const html = buildEmailHtml({ id, sig, route, message, stack, context });
    const mail = await sendEmail({ to, subject, html }).catch((e) => ({
      ok: false,
      error: e?.message || String(e),
    }));

    // Slack 併用通知（既存資産）
    await notifySlack({
      level,
      title: `Deer error: ${route || "?"}`,
      text: message,
      context: { id, ...(context || {}) },
      dedupeKey,
    }).catch(() => undefined);

    return { id, mail };
  } catch (e) {
    console.warn("[error-notifier] notifyError failed:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

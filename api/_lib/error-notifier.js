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
  // Vercel env pull で末尾改行が混ざるケースがあるため必ず trim する。
  const secret = process.env.FIX_DISPATCH_SECRET?.trim();
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

  // Claude Code にコピペで貼ればそのまま修正に着手できるプロンプト本体。
  // メールクライアントによっては <pre> の選択範囲が壊れることがあるため、
  // 改行を <br> 化せず生の改行を保ったまま <pre> で出力する。
  const ctxBlockText = context
    ? Object.entries(context)
        .map(
          ([k, v]) =>
            `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
        )
        .join("\n")
    : "(なし)";
  const stackBlockText = stack ? stack.slice(0, 4000) : "(なし)";
  const promptText = `以下の Deer 本番エラーを調査・修正してください。

【エンドポイント】 ${route || "(unknown)"}
【エラーメッセージ】 ${message || ""}
【発生日時】 ${new Date().toISOString()}
【エラーID】 ${id}

【発生時のコンテキスト】
${ctxBlockText}

【スタックトレース】
${stackBlockText}

【お願い】
1. 該当ファイルとコード行を特定して根本原因を説明してください。
2. 修正パッチを当てて、関連する既存テスト・スモークテストを実行してください。
3. 問題なければ main へ push してください（自動デプロイされます）。
4. 完了したら何を直したか・なぜ起きたかを 5 行以内で要約してください。
5. 同じエラーの再発防止策（型・バリデーション・テスト等）も提案してください。`;
  const promptBlock = `<div style="margin:24px 0;border:2px solid #1a3a52;border-radius:8px;background:#fff;overflow:hidden">
      <div style="background:#1a3a52;color:#fff;padding:8px 12px;font-size:13px;font-weight:600">📋 Claude Code に貼り付け用（全文選択 → コピー → チャットに貼る）</div>
      <pre style="margin:0;padding:14px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;background:#fafafa;color:#222;user-select:all;-webkit-user-select:all">${escapeHtml(promptText)}</pre>
     </div>`;

  return `<!doctype html><html><body style="font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;color:#222;max-width:680px;margin:0 auto;padding:24px">
    <h2 style="color:#c0392b;margin:0 0 8px">🚨 Deer 本番エラー</h2>
    <p style="color:#666;font-size:13px;margin:0 0 16px">${escapeHtml(new Date().toISOString())}</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:16px;background:#fafafa;border:1px solid #eee;border-radius:6px">
      <tr><td style="padding:4px 8px;color:#666;font-size:12px">エンドポイント</td><td style="padding:4px 8px;font-family:ui-monospace,monospace;font-size:13px"><b>${escapeHtml(route || "(unknown)")}</b></td></tr>
      <tr><td style="padding:4px 8px;color:#666;font-size:12px">メッセージ</td><td style="padding:4px 8px;font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(message || "")}</td></tr>
      ${ctxRows}
    </table>
    ${stackHtml}
    ${promptBlock}
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
    // from は ERROR_REPORT_FROM か、なければ Resend 検証済みの onboarding@resend.dev を使う。
    // deer.gift ドメインは未verify状態なので、デフォルトの DEFAULT_FROM では 403 になる。
    const to = process.env.ERROR_REPORT_EMAIL?.trim() || DEFAULT_REPORT_EMAIL;
    const from =
      process.env.ERROR_REPORT_FROM?.trim() ||
      "Deer Error <onboarding@resend.dev>";
    const subject = `[Deer 本番エラー] ${route || "?"} — ${String(message).slice(0, 80)}`;
    const html = buildEmailHtml({ id, sig, route, message, stack, context });
    const mail = await sendEmail({ to, subject, html, from }).catch((e) => ({
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

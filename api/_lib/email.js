/**
 * メール送信ヘルパー (Resend)
 *
 * 経緯:
 *   過去コードは SendGrid を前提 (SENDGRID_API_KEY + api.sendgrid.com) だったが、
 *   Vercel env には RESEND_API_KEY しか設定されておらず、全ての注文確認メール・
 *   ステータス通知メールが「API キー未設定」扱いで sigh 送信されない状態だった。
 *   Resend に統一してこのヘルパーへ集約する。
 *
 * 環境変数:
 *   RESEND_API_KEY (必須)
 *   ないしは後方互換として SENDGRID_API_KEY が設定されている場合は SendGrid 経由でも送れる
 *
 * 使い方:
 *   import { sendEmail } from "./_lib/email.js";
 *   await sendEmail({ to, subject, html });
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";
const DEFAULT_FROM = "Deer Brand <noreply@deer.gift>";

/**
 * HTML から簡易的に text/plain を生成するフォールバック。
 * HTML 非対応クライアント・迷惑メール判定対策。
 */
function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 統一メール送信インターフェース。Resend 優先、無ければ SendGrid フォールバック。
 *
 * @param {object} opts
 * @param {string|string[]} opts.to - 宛先メールアドレス (単一 or 配列)
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {string} [opts.text] - text/plain 本文。省略時は html から自動生成
 * @param {string} [opts.from] - 送信元 ("Name <email>" 形式)。省略時は DEFAULT_FROM
 * @param {string} [opts.replyTo] - Reply-To
 * @param {Record<string,string>} [opts.headers] - 追加ヘッダ (List-Unsubscribe 等)
 * @returns {Promise<{ok:boolean, status:number, error?:string}>}
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
  from = DEFAULT_FROM,
  replyTo,
  headers,
}) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length || !recipients[0]) {
    return { ok: false, status: 0, error: "no recipient" };
  }

  const textBody = text || htmlToText(html);
  const defaultReplyTo = replyTo || "support@deer.gift";
  const defaultHeaders = {
    "List-Unsubscribe": "<mailto:support@deer.gift?subject=unsubscribe>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    ...(headers || {}),
  };

  const resendKey = process.env.RESEND_API_KEY;
  const sendgridKey = process.env.SENDGRID_API_KEY;

  if (resendKey) {
    try {
      const payload = {
        from,
        to: recipients,
        subject,
        html,
        text: textBody,
        reply_to: defaultReplyTo,
        headers: defaultHeaders,
      };
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        console.log("[email] sent via Resend to", recipients.join(","));
        return { ok: true, status: res.status };
      }
      const txt = await res.text().catch(() => "");
      const requestId = res.headers.get("x-request-id") || "";
      console.warn(
        "[email] Resend failed:",
        res.status,
        requestId,
        txt.slice(0, 400),
      );
      return {
        ok: false,
        status: res.status,
        error: `${requestId} ${txt}`.trim().slice(0, 500),
      };
    } catch (e) {
      console.warn("[email] Resend error:", e.message);
      return { ok: false, status: 0, error: e.message };
    }
  }

  if (sendgridKey) {
    try {
      const m = /^(.*?)\s*<(.+)>$/.exec(from) || [];
      const fromObj = m[2]
        ? { email: m[2], name: m[1].trim() || undefined }
        : { email: from };
      const sgHeaders = {};
      for (const [k, v] of Object.entries(defaultHeaders)) {
        if (typeof v === "string") sgHeaders[k] = v;
      }
      const body = {
        personalizations: [{ to: recipients.map((e) => ({ email: e })) }],
        from: fromObj,
        reply_to: { email: defaultReplyTo },
        subject,
        content: [
          { type: "text/plain", value: textBody },
          { type: "text/html", value: html },
        ],
        headers: sgHeaders,
      };
      const res = await fetch(SENDGRID_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sendgridKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        console.log("[email] sent via SendGrid to", recipients.join(","));
        return { ok: true, status: res.status };
      }
      const txt = await res.text().catch(() => "");
      const messageId = res.headers.get("x-message-id") || "";
      console.warn(
        "[email] SendGrid failed:",
        res.status,
        messageId,
        txt.slice(0, 400),
      );
      return {
        ok: false,
        status: res.status,
        error: `${messageId} ${txt}`.trim().slice(0, 500),
      };
    } catch (e) {
      console.warn("[email] SendGrid error:", e.message);
      return { ok: false, status: 0, error: e.message };
    }
  }

  console.warn(
    "[email] no API key configured (RESEND_API_KEY or SENDGRID_API_KEY)",
  );
  return { ok: false, status: 0, error: "no_api_key" };
}

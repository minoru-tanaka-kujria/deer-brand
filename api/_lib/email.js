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
 * 統一メール送信インターフェース。Resend 優先、無ければ SendGrid フォールバック。
 *
 * @param {object} opts
 * @param {string|string[]} opts.to - 宛先メールアドレス (単一 or 配列)
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {string} [opts.from] - 送信元 ("Name <email>" 形式)。省略時は DEFAULT_FROM
 * @returns {Promise<{ok:boolean, status:number, error?:string}>}
 */
export async function sendEmail({ to, subject, html, from = DEFAULT_FROM }) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length || !recipients[0]) {
    return { ok: false, status: 0, error: "no recipient" };
  }

  const resendKey = process.env.RESEND_API_KEY;
  const sendgridKey = process.env.SENDGRID_API_KEY;

  if (resendKey) {
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to: recipients, subject, html }),
      });
      if (res.ok) {
        console.log("[email] sent via Resend to", recipients.join(","));
        return { ok: true, status: res.status };
      }
      const txt = await res.text().catch(() => "");
      console.warn("[email] Resend failed:", res.status, txt.slice(0, 200));
      return { ok: false, status: res.status, error: txt.slice(0, 200) };
    } catch (e) {
      console.warn("[email] Resend error:", e.message);
      return { ok: false, status: 0, error: e.message };
    }
  }

  if (sendgridKey) {
    // 後方互換: SENDGRID_API_KEY が環境にセットされていれば SendGrid 経由で送る
    try {
      // "Name <email>" 形式を分解
      const m = /^(.*?)\s*<(.+)>$/.exec(from) || [];
      const fromObj = m[2]
        ? { email: m[2], name: m[1].trim() || undefined }
        : { email: from };
      const res = await fetch(SENDGRID_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sendgridKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: recipients.map((e) => ({ email: e })) }],
          from: fromObj,
          subject,
          content: [{ type: "text/html", value: html }],
        }),
      });
      if (res.ok) {
        console.log("[email] sent via SendGrid to", recipients.join(","));
        return { ok: true, status: res.status };
      }
      const txt = await res.text().catch(() => "");
      console.warn("[email] SendGrid failed:", res.status, txt.slice(0, 200));
      return { ok: false, status: res.status, error: txt.slice(0, 200) };
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

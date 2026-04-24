/**
 * Slack 通知共通ヘルパ。
 *
 * SLACK_WEBHOOK_URL が Vercel env に設定されていれば通知を送る。
 * 未設定なら silent に skip（開発/テスト環境や Slack 無しでも動く）。
 *
 * 使い方:
 *   import { notifySlack } from "./slack-notify.js";
 *   await notifySlack({
 *     level: "error",   // "error" | "warn" | "info"
 *     title: "create-order 500",
 *     text: "ART_IMAGE_UNAVAILABLE: bucket not found",
 *     context: { orderId: "abc", uid: "xyz" },
 *     dedupeKey: "create-order:ART_IMAGE_UNAVAILABLE", // 同じ key は 5分以内なら送らない
 *   });
 */

const LEVEL_EMOJI = {
  error: ":rotating_light:",
  warn: ":warning:",
  info: ":information_source:",
};
const _dedupeCache = new Map(); // key -> lastSentAt

export async function notifySlack({
  level = "info",
  title,
  text,
  context,
  dedupeKey,
} = {}) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { skipped: "no-webhook" };

  if (dedupeKey) {
    const last = _dedupeCache.get(dedupeKey);
    if (last && Date.now() - last < 5 * 60 * 1000) {
      return { skipped: "deduped" };
    }
    _dedupeCache.set(dedupeKey, Date.now());
    // メモリ成長防止: 100 エントリ超えたら古いものから削除
    if (_dedupeCache.size > 100) {
      const oldest = [..._dedupeCache.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) _dedupeCache.delete(oldest[0]);
    }
  }

  const emoji = LEVEL_EMOJI[level] || "";
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *${title || "Deer notification"}*`,
      },
    },
  ];
  if (text)
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```" + String(text).slice(0, 2500) + "```",
      },
    });
  if (context && typeof context === "object") {
    const ctxStr = Object.entries(context)
      .map(
        ([k, v]) =>
          `• *${k}*: ${typeof v === "string" ? v : JSON.stringify(v)}`,
      )
      .join("\n")
      .slice(0, 2500);
    if (ctxStr)
      blocks.push({ type: "section", text: { type: "mrkdwn", text: ctxStr } });
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks,
        text: `${title} — ${text || ""}`.slice(0, 200),
      }),
    });
    if (!resp.ok) {
      console.warn("[slack-notify] webhook responded", resp.status);
      return { ok: false, status: resp.status };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[slack-notify] fetch failed:", e?.message || e);
    return { ok: false, error: e?.message };
  }
}

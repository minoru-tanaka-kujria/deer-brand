/**
 * 修正依頼ディスパッチャ：エラー通知メールの「修正させる」ボタンの遷移先。
 *
 * GET /api/dispatch-fix?id={errorId}&sig={hmac}
 *   1. HMAC 検証（FIX_DISPATCH_SECRET）
 *   2. Firestore apiErrorReports/{id} からエラー詳細を取得
 *   3. Slack の Deer チャンネル (SLACK_DISPATCH_CHANNEL) に
 *      `<@BOT_ID> 以下の本番エラーを修正してください\n...` を chat.postMessage
 *      → Mac mini の slack-socket-bot が app_mention で受信して自動修正開始
 *   4. apiErrorReports/{id}.status = "dispatched" に更新
 *   5. 田中さんのブラウザに「修正開始しました」HTML を返す
 *
 * 必要な環境変数:
 *   - FIX_DISPATCH_SECRET     : HMAC 署名鍵
 *   - SLACK_BOT_TOKEN         : xoxb- (chat.postMessage 用)
 *   - SLACK_DISPATCH_CHANNEL  : C... (deerペットフード鹿 = C02EP0JLERJ)
 *   - SLACK_BOT_USER_ID       : U...   (省略可。なければ "@Claude Code Notify" テキスト)
 */
import crypto from "node:crypto";
import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp } from "./_lib/auth.js";

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";

function verifySig(id, sig) {
  const secret = process.env.FIX_DISPATCH_SECRET;
  if (!secret || !sig) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(id)
    .digest("hex")
    .slice(0, 32);
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function htmlPage({ title, body, color = "#1a3a52" }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    </head><body style="font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;color:#222;max-width:560px;margin:48px auto;padding:24px;text-align:center">
    <h1 style="color:${color};margin:0 0 16px;font-size:22px">${title}</h1>
    <div style="font-size:14px;line-height:1.7;color:#444">${body}</div>
    </body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(405).send(
      htmlPage({
        title: "405 Method Not Allowed",
        body: "GET only",
        color: "#c0392b",
      }),
    );
  }

  const id = String(req.query?.id || "").trim();
  const sig = String(req.query?.sig || "").trim();

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!id || !verifySig(id, sig)) {
    return res.status(403).send(
      htmlPage({
        title: "🚫 認証エラー",
        body: "リンクが改ざんされているか、期限切れです。",
        color: "#c0392b",
      }),
    );
  }

  // Firestore からエラー詳細取得
  let report;
  try {
    const db = getFirestore(getAdminApp());
    const snap = await db.collection("apiErrorReports").doc(id).get();
    if (!snap.exists) {
      return res.status(404).send(
        htmlPage({
          title: "エラー記録が見つかりません",
          body: "古い通知メールの可能性があります。",
          color: "#c0392b",
        }),
      );
    }
    report = snap.data();
    if (report.status === "dispatched") {
      return res.status(200).send(
        htmlPage({
          title: "✅ 既に修正依頼済み",
          body: `このエラーは既にClaudeに依頼済みです。<br><br>Slack「deerペットフード鹿」チャンネルで進捗を確認してください。<br><br><small style="color:#999">エラーID: ${id}</small>`,
        }),
      );
    }
  } catch (e) {
    console.error("[dispatch-fix] firestore get failed:", e?.message);
    return res.status(500).send(
      htmlPage({
        title: "サーバーエラー",
        body: `Firestoreアクセス失敗: ${e?.message || ""}`,
        color: "#c0392b",
      }),
    );
  }

  const botToken = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_DISPATCH_CHANNEL;
  if (!botToken || !channel) {
    return res.status(500).send(
      htmlPage({
        title: "Slack設定が未完了",
        body: "SLACK_BOT_TOKEN または SLACK_DISPATCH_CHANNEL が未設定です。",
        color: "#c0392b",
      }),
    );
  }

  const botUserId = process.env.SLACK_BOT_USER_ID;
  const mention = botUserId ? `<@${botUserId}>` : "@Claude Code Notify";
  const ctxLines = report.context
    ? Object.entries(report.context)
        .map(
          ([k, v]) =>
            `• *${k}*: ${typeof v === "string" ? v : JSON.stringify(v)}`,
        )
        .join("\n")
    : "";
  const stackTrim = String(report.stack || "").slice(0, 1500);

  const slackText = [
    `${mention} 以下のDeer本番エラーを修正してください。`,
    "",
    `*エンドポイント*: \`${report.route || "?"}\``,
    `*メッセージ*: ${report.message}`,
    ctxLines ? `\n*Context*:\n${ctxLines}` : "",
    stackTrim ? `\n*Stack*:\n\`\`\`${stackTrim}\`\`\`` : "",
    "",
    `_エラーID: ${id} / 発生: ${report.createdAt}_`,
    "",
    "原因を特定し、修正PRをmainブランチに対して作成してください。",
    "テストが通ったら自動でpushして構いません。",
  ]
    .filter(Boolean)
    .join("\n");

  // Slack に投稿
  let slackResp;
  try {
    const r = await fetch(SLACK_POST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        text: slackText,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    slackResp = await r.json();
    if (!slackResp.ok) {
      console.error("[dispatch-fix] slack postMessage failed:", slackResp);
      return res.status(502).send(
        htmlPage({
          title: "Slack投稿失敗",
          body: `理由: <code>${slackResp.error || "unknown"}</code>`,
          color: "#c0392b",
        }),
      );
    }
  } catch (e) {
    console.error("[dispatch-fix] slack fetch error:", e?.message);
    return res.status(502).send(
      htmlPage({
        title: "Slack接続失敗",
        body: e?.message || "",
        color: "#c0392b",
      }),
    );
  }

  // status 更新
  try {
    const db = getFirestore(getAdminApp());
    await db
      .collection("apiErrorReports")
      .doc(id)
      .update({
        status: "dispatched",
        dispatchedAt: new Date().toISOString(),
        slackTs: slackResp.ts || null,
        slackChannel: slackResp.channel || channel,
      });
  } catch (e) {
    console.warn("[dispatch-fix] status update failed:", e?.message);
  }

  return res.status(200).send(
    htmlPage({
      title: "✅ 修正依頼を送信しました",
      body: `Mac mini上のClaudeが原因調査と修正PR作成を開始します。<br><br>進捗はSlack「deerペットフード鹿」チャンネルで確認できます。<br><br>修正PR完成後は別途メールでお知らせします。<br><br><small style="color:#999">エラーID: ${id}</small>`,
    }),
  );
}

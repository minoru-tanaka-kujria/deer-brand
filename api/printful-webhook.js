/**
 * Vercel Serverless Function
 * POST /api/printful-webhook
 *
 * Printful からの注文ステータス変更 Webhook を受信する。
 *
 * 対応イベント:
 *   - package_shipped   → orders/{orderId}.status = "shipped"、trackingUrl/trackingCarrier 保存
 *   - order_fulfilled   → orders/{orderId}.status = "shipped"（追加保険）
 *   - order_delivered   → orders/{orderId}.status = "delivered"
 *
 * 認証:
 *   Printful v1 webhooks は HMAC 署名ヘッダーを送らないため、
 *   webhook 登録時に URL クエリ文字列に ?key=<PRINTFUL_WEBHOOK_SECRET> を含め、
 *   受信時に req.query.key が env と一致するかで検証する。
 */

import crypto from "crypto";
import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp } from "./_lib/auth.js";
import { notifyError } from "./_lib/error-notifier.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

const STATUS_ORDER = {
  pending: 0,
  pending_payment: 0,
  printful_failed: 0,
  paid: 1,
  preparing: 2,
  printing: 2,
  shipped: 3,
  delivered: 4,
  cancelled: 5,
};

function canAdvanceStatus(currentStatus, nextStatus) {
  return (
    (STATUS_ORDER[nextStatus] ?? -1) >= (STATUS_ORDER[currentStatus] ?? -1)
  );
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Printful Webhook 認証: URL query string の key を env と timing-safe 比較
// ---------------------------------------------------------------------------
function verifyWebhookKey(receivedKey, secret) {
  if (!receivedKey || !secret) return false;
  const a = Buffer.from(String(receivedKey));
  const b = Buffer.from(String(secret));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// ステータス変更メール送信
// ---------------------------------------------------------------------------
async function sendStatusEmail(db, order, orderId, status, extra = {}) {
  const { sendEmail } = await import("./_lib/email.js");
  if (!order.email) return;

  const name = order.shippingAddress?.fullName || "お客様";
  const itemName =
    (order.items?.[0]?.productName ?? order.productName ?? order.product) || "";
  const amount = (order.total ?? order.amount ?? 0).toLocaleString();
  const itemRow = itemName
    ? `<tr style="border-bottom:1px solid #e8e0d4"><td style="padding:8px;color:#999">商品</td><td style="padding:8px">${itemName}</td></tr>`
    : "";
  const amountRow = amount
    ? `<tr style="border-bottom:1px solid #e8e0d4"><td style="padding:8px;color:#999">合計金額</td><td style="padding:8px;font-weight:600">¥${amount}</td></tr>`
    : "";

  const templates = {
    preparing: {
      subject: `【Deer Brand】制作を開始しました（${orderId}）`,
      statusLabel: "制作中 🎨",
      leadHtml: `<p>ご注文いただいた商品の制作を開始いたしました。</p>`,
      footerHtml: `<p>完成まで通常2〜3営業日ほどお時間をいただきます。<br>発送準備が整い次第、改めてご連絡いたします。</p>`,
      leadText: "ご注文いただいた商品の制作を開始いたしました。",
      footerText:
        "完成まで通常2〜3営業日ほどお時間をいただきます。発送準備が整い次第、改めてご連絡いたします。",
    },
    shipped: {
      subject: `【Deer Brand】発送しました（${orderId}）`,
      statusLabel: "発送済み 📦",
      leadHtml: `<p>ご注文いただいた商品を発送いたしました！</p>`,
      trackingRow: extra.trackingUrl
        ? `<tr style="border-bottom:1px solid #e8e0d4"><td style="padding:8px;color:#999">追跡</td><td style="padding:8px"><a href="${extra.trackingUrl}" style="color:#c4a265">${extra.trackingCarrier || "配送状況を確認"} →</a></td></tr>`
        : "",
      footerHtml: `<p>お届けまで1〜3日ほどお待ちください。</p>`,
      leadText: "ご注文いただいた商品を発送いたしました。",
      footerText: extra.trackingUrl
        ? `追跡URL: ${extra.trackingUrl}\nお届けまで1〜3日ほどお待ちください。`
        : "お届けまで1〜3日ほどお待ちください。",
    },
    delivered: {
      subject: `【Deer Brand】お届けが完了しました（${orderId}）`,
      statusLabel: "お届け完了 🎁",
      leadHtml: `<p>商品のお届けが完了しました。ご利用ありがとうございました。</p>`,
      footerHtml: `<p>商品がお手元に届きましたら、ぜひ感想をレビュー投稿でお聞かせください。<br><a href="https://custom.deer.gift/#reviews" style="color:#c4a265">レビューを書く →</a></p>`,
      leadText: "商品のお届けが完了しました。ご利用ありがとうございました。",
      footerText:
        "商品がお手元に届きましたら、ぜひ感想をレビュー投稿でお聞かせください: https://custom.deer.gift/#reviews",
    },
  };

  const tmpl = templates[status];
  if (!tmpl) return;

  const trackingRow = tmpl.trackingRow || "";

  const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f1eb;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#fffdf8">
<div style="background:#3e2c23;padding:20px;text-align:center">
<h1 style="margin:0;color:#f5f1eb;font-size:20px;font-weight:300;letter-spacing:3px">DEER BRAND</h1>
</div>
<div style="padding:28px 24px">
<p>${name} 様</p>
${tmpl.leadHtml}
<table style="border-collapse:collapse;margin:16px 0;width:100%">
<tr style="border-bottom:1px solid #e8e0d4"><td style="padding:8px;color:#999;width:100px">注文番号</td><td style="padding:8px;font-weight:600">${orderId}</td></tr>
${itemRow}
${amountRow}
<tr style="border-bottom:1px solid #e8e0d4"><td style="padding:8px;color:#999">ステータス</td><td style="padding:8px;color:#c4a265;font-weight:600">${tmpl.statusLabel}</td></tr>
${trackingRow}
</table>
${tmpl.footerHtml}
<p style="color:#5d4037;margin-top:20px">ご不明な点はサポート（<a href="mailto:support@deer.gift" style="color:#c4a265">support@deer.gift</a>）までお問い合わせください。</p>
</div>
<div style="background:#3e2c23;padding:16px;text-align:center">
<p style="margin:0;color:#a08979;font-size:10px">Deer Brand ｜ support@deer.gift</p>
<p style="margin:4px 0 0;color:#6d5c52;font-size:10px"><a href="https://custom.deer.gift/privacy" style="color:#6d5c52">プライバシーポリシー</a></p>
</div></div></body></html>`;

  const textBody = [
    `${name} 様`,
    "",
    tmpl.leadText,
    "",
    `注文番号: ${orderId}`,
    itemName ? `商品: ${itemName}` : "",
    amount ? `合計金額: ¥${amount}` : "",
    `ステータス: ${tmpl.statusLabel}`,
    "",
    tmpl.footerText,
    "",
    "Deer Brand | support@deer.gift",
    "https://custom.deer.gift/privacy",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await sendEmail({
    to: order.email,
    replyTo: "support@deer.gift",
    subject: tmpl.subject,
    html: htmlBody,
    text: textBody,
    headers: {
      "List-Unsubscribe": "<mailto:support@deer.gift?subject=unsubscribe>",
    },
  });
  if (!result.ok) {
    console.warn(
      "[printful-webhook] email failed:",
      result.status,
      result.error,
    );
    if (db) {
      try {
        await db
          .collection("orders")
          .doc(orderId)
          .update({
            [`statusEmailError_${status}`]: {
              status: result.status,
              error: String(result.error || "").slice(0, 500),
              at: new Date(),
            },
            updatedAt: new Date(),
          });
      } catch (markErr) {
        console.warn(
          "[printful-webhook] failed to mark email error:",
          markErr.message,
        );
      }
    }
  } else {
    console.log("[printful-webhook] status email sent:", status);
    if (db) {
      try {
        await db
          .collection("orders")
          .doc(orderId)
          .update({
            [`statusEmailSentAt_${status}`]: new Date(),
            updatedAt: new Date(),
          });
      } catch (_) {
        // best-effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Firestore から printfulOrderId で注文を検索
// ---------------------------------------------------------------------------
async function findOrderByPrintfulId(db, printfulOrderId) {
  const snapshot = await db
    .collection("orders")
    .where("printfulOrderId", "==", printfulOrderId)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { ref: doc.ref, data: doc.data() };
}

// ---------------------------------------------------------------------------
// メインハンドラ
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // Webhook は POST のみ
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const webhookSecret = process.env.PRINTFUL_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    console.error("[printful-webhook] missing PRINTFUL_WEBHOOK_SECRET");
    return res.status(503).json({ error: "SERVICE_UNAVAILABLE" });
  }

  const receivedKey = req.query?.key || "";
  if (!verifyWebhookKey(receivedKey, webhookSecret)) {
    console.error("[printful-webhook] key 不一致");
    return res.status(401).json({ error: "Invalid key" });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    console.error("[printful-webhook] read body error:", error);
    return res.status(400).json({ error: "INVALID_BODY" });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    console.error("[printful-webhook] invalid JSON:", error);
    return res.status(400).json({ error: "INVALID_BODY" });
  }

  const eventType = event?.type || "";
  const eventData = event?.data || {};
  const eventId = String(
    event?.id ??
      eventData?.id ??
      req.headers["x-printful-event-id"] ??
      crypto.createHash("sha256").update(rawBody).digest("hex"),
  );

  console.log(`[printful-webhook] イベント受信: type=${eventType}`);

  try {
    const db = getFirestore(getAdminApp());
    const eventRef = db.collection("webhookEvents").doc(`printful_${eventId}`);

    const existingEvent = await eventRef.get();
    if (existingEvent.exists) {
      return res.status(200).json({ received: true, duplicate: true });
    }

    const printfulOrder = eventData.order || eventData.shipment?.order || {};
    const printfulOrderId = printfulOrder.id ?? eventData.order_id ?? null;

    if (!printfulOrderId) {
      console.warn("[printful-webhook] printfulOrderId が取得できませんでした");
      await eventRef.set({
        provider: "printful",
        eventId,
        type: eventType,
        processedAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        ignored: true,
        reason: "ORDER_ID_MISSING",
      });
      return res.status(200).json({ received: true });
    }

    const found = await findOrderByPrintfulId(db, printfulOrderId);
    if (!found) {
      console.warn(
        `[printful-webhook] 対応する注文が Firestore に見つかりません: printfulOrderId=${printfulOrderId}`,
      );
      await eventRef.set({
        provider: "printful",
        eventId,
        type: eventType,
        printfulOrderId,
        processedAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        ignored: true,
        reason: "ORDER_NOT_FOUND",
      });
      return res.status(200).json({ received: true });
    }

    const { ref: orderRef, data: orderData } = found;
    const now = new Date();
    const updatePayload = { updatedAt: now };
    let nextStatus = null;

    switch (eventType) {
      case "order_created":
        nextStatus = "preparing";
        break;
      case "package_shipped":
      case "order_fulfilled":
        nextStatus = "shipped";
        break;
      case "order_delivered":
        nextStatus = "delivered";
        break;
      default:
        console.log(
          `[printful-webhook] 未対応イベント: type=${eventType}（無視）`,
        );
        await eventRef.set({
          provider: "printful",
          eventId,
          type: eventType,
          printfulOrderId,
          processedAt: now,
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          ignored: true,
          reason: "UNSUPPORTED_EVENT",
        });
        return res.status(200).json({ received: true });
    }

    if (!canAdvanceStatus(orderData.status, nextStatus)) {
      console.log(
        `[printful-webhook] 後退更新をスキップ: current=${orderData.status}, next=${nextStatus}, printfulOrderId=${printfulOrderId}`,
      );
      await eventRef.set({
        provider: "printful",
        eventId,
        type: eventType,
        printfulOrderId,
        processedAt: now,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        ignored: true,
        reason: "STATUS_REGRESSION",
      });
      return res.status(200).json({ received: true });
    }

    updatePayload.status = nextStatus;
    if (eventType === "package_shipped") {
      const shipment = eventData.shipment || {};
      const trackingUrl = shipment.tracking_url || shipment.trackingUrl || null;
      const trackingCarrier = shipment.carrier || shipment.service || null;
      const trackingNumber =
        shipment.tracking_number || shipment.trackingNumber || null;
      if (trackingUrl) updatePayload.trackingUrl = trackingUrl;
      if (trackingCarrier) updatePayload.trackingCarrier = trackingCarrier;
      if (trackingNumber) updatePayload.trackingNumber = trackingNumber;
    }

    await db.runTransaction(async (tx) => {
      const txEventSnap = await tx.get(eventRef);
      if (txEventSnap.exists) {
        return;
      }

      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) {
        throw new Error("ORDER_NOT_FOUND");
      }

      const currentOrder = orderSnap.data();
      if (!canAdvanceStatus(currentOrder.status, nextStatus)) {
        tx.set(eventRef, {
          provider: "printful",
          eventId,
          type: eventType,
          printfulOrderId,
          processedAt: now,
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          ignored: true,
          reason: "STATUS_REGRESSION",
        });
        return;
      }

      tx.update(orderRef, updatePayload);
      tx.set(eventRef, {
        provider: "printful",
        eventId,
        type: eventType,
        printfulOrderId,
        processedAt: now,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        statusApplied: nextStatus,
      });
    });

    // トランザクション外でメール送信（非同期・ノンブロッキング）
    if (
      nextStatus === "preparing" ||
      nextStatus === "shipped" ||
      nextStatus === "delivered"
    ) {
      const latestOrder = (await orderRef.get()).data();
      if (latestOrder) {
        const extra =
          nextStatus === "shipped"
            ? {
                trackingUrl:
                  updatePayload.trackingUrl ?? latestOrder.trackingUrl,
                trackingCarrier:
                  updatePayload.trackingCarrier ?? latestOrder.trackingCarrier,
              }
            : {};
        sendStatusEmail(db, latestOrder, orderRef.id, nextStatus, extra).catch(
          (e) => console.warn("[printful-webhook] email error:", e.message),
        );
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[printful-webhook] エラー:", err);
    notifyError({
      err,
      route: "POST /api/printful-webhook",
      context: {
        eventType: req.body?.type || null,
      },
    }).catch(() => undefined);
    return res.status(500).json({ error: "WEBHOOK_PROCESSING_FAILED" });
  }
}

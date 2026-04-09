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
 *   X-Printful-Signature ヘッダー（HMAC-SHA256）を PRINTFUL_WEBHOOK_SECRET で検証。
 *   env が未設定の場合は署名検証をスキップ（開発用途）。
 */

import crypto from "crypto";
import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp } from "./_lib/auth.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

const STATUS_ORDER = {
  pending: 0,
  pending_payment: 0,
  paid: 1,
  preparing: 2,
  shipped: 3,
  delivered: 4,
};

function canAdvanceStatus(currentStatus, nextStatus) {
  return (STATUS_ORDER[nextStatus] ?? -1) >= (STATUS_ORDER[currentStatus] ?? -1);
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
// Printful Webhook 署名検証
// ---------------------------------------------------------------------------
function verifyPrintfulSignature(rawBody, signature, secret) {
  if (!signature) {
    console.warn(
      "[printful-webhook] X-Printful-Signature ヘッダーが存在しません",
    );
    return false;
  }
  const computed = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const expectedBuffer = Buffer.from(computed, "hex");
  const receivedBuffer = Buffer.from(signature, "hex");
  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
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

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    console.error("[printful-webhook] read body error:", error);
    return res.status(400).json({ error: "INVALID_BODY" });
  }

  const signature = req.headers["x-printful-signature"] || "";

  if (!verifyPrintfulSignature(rawBody, signature, webhookSecret)) {
    console.error("[printful-webhook] 署名検証失敗");
    return res.status(401).json({ error: "Invalid signature" });
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
  const eventId =
    String(
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
        console.log(`[printful-webhook] 未対応イベント: type=${eventType}（無視）`);
        await eventRef.set({
          provider: "printful",
          eventId,
          type: eventType,
          printfulOrderId,
          processedAt: now,
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
      const trackingNumber = shipment.tracking_number || shipment.trackingNumber || null;
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
        statusApplied: nextStatus,
      });
    });

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[printful-webhook] エラー:", err);
    return res.status(500).json({ error: "WEBHOOK_PROCESSING_FAILED" });
  }
}

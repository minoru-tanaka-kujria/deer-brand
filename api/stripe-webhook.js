/**
 * Vercel Serverless Function
 * POST /api/stripe-webhook
 */

import Stripe from "stripe";
import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp } from "./_lib/auth.js";
import {
  sendOrderConfirmationEmail,
  triggerPrintfulOrder,
} from "./_lib/post-payment.js";

// モジュールスコープでキャッシュ
const _stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY.trim(), {
      apiVersion: "2024-04-10",
    })
  : null;

export const config = {
  api: {
    bodyParser: false,
  },
};

const STATUS_ORDER = {
  pending_payment: 0,
  printful_failed: 0,
  paid: 1,
  preparing: 2,
  printing: 2,
  shipped: 3,
  delivered: 4,
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

export default async function handler(req, res) {
  // stripe-webhook はStripeサーバーからのサーバー間通信のため、CORSヘッダー不要
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!stripeSecretKey || !webhookSecret) {
    console.error("[stripe-webhook] missing env");
    return res.status(500).json({ error: "CONFIG_ERROR" });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    console.error("[stripe-webhook] read body error:", error);
    return res.status(400).json({ error: "INVALID_BODY" });
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    return res.status(400).json({ error: "INVALID_SIGNATURE" });
  }

  let event;
  try {
    const stripe = _stripe; // CONFIG_ERROR チェック済みなので必ず非null
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error("[stripe-webhook] signature verification error:", error);
    return res.status(400).json({ error: "INVALID_SIGNATURE" });
  }

  const db = getFirestore(getAdminApp());

  // payment_intent.succeeded の場合、トランザクション外で orderId を参照するため
  let succeededOrderId = null;

  try {
    await db.runTransaction(async (tx) => {
      const eventRef = db.collection("webhookEvents").doc(event.id);
      const eventSnap = await tx.get(eventRef);
      if (eventSnap.exists) {
        return;
      }

      if (event.type === "payment_intent.succeeded") {
        const paymentIntent = event.data.object;
        const orderId = paymentIntent.metadata?.orderId ?? "";
        if (!orderId) {
          throw new Error("ORDER_ID_MISSING");
        }

        const orderRef = db.collection("orders").doc(orderId);
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists) {
          throw new Error("ORDER_NOT_FOUND");
        }

        const order = orderSnap.data();
        if (order.paymentIntentId !== paymentIntent.id) {
          throw new Error("PAYMENT_INTENT_MISMATCH");
        }
        if (
          Number(order.amount ?? order.total ?? -1) !==
          Number(paymentIntent.amount)
        ) {
          throw new Error("AMOUNT_MISMATCH");
        }

        if (order.status === "pending_payment") {
          tx.update(orderRef, {
            status: "paid",
            paidAt: new Date(),
            updatedAt: new Date(),
          });
        }
        // 既に paid 以降のステータスなら何もしない（べき等: 重複webhookを安全に無視）
        succeededOrderId = orderId;
      }

      tx.set(eventRef, {
        eventId: event.id,
        type: event.type,
        processedAt: new Date(),
        // Firestore TTL: 90 日後に自動削除 (コレクションに TTL ポリシー設定要)
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      });
    });

    // トランザクション外で email + Printful を非同期実行（Webhook レスポンスをブロックしない）
    if (succeededOrderId) {
      const orderRef2 = db.collection("orders").doc(succeededOrderId);
      const finalOrder = (await orderRef2.get()).data();
      if (finalOrder) {
        sendOrderConfirmationEmail(db, finalOrder, succeededOrderId).catch(
          (e) => console.warn("[webhook] email error:", e),
        );
        triggerPrintfulOrder(db, finalOrder, succeededOrderId).catch((e) =>
          console.warn("[webhook] printful error:", e),
        );
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("[stripe-webhook] event processing error:", error);
    return res.status(500).json({ error: "WEBHOOK_PROCESSING_FAILED" });
  }
}

/**
 * Vercel Serverless Function
 * POST /api/stripe-webhook
 */

import Stripe from "stripe";
import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp } from "./_lib/auth.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

const STATUS_ORDER = {
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

export default async function handler(req, res) {
  const ALLOWED_ORIGINS = [
    "https://custom.deer.gift",
    "https://deer-brand.vercel.app",
    process.env.ALLOWED_ORIGIN,
  ].filter(Boolean);
  const origin = (req.headers.origin || "").trim();
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) || origin.endsWith(".vercel.app")
    ? origin
    : ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Stripe-Signature",
  );

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
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-04-10" });
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error("[stripe-webhook] signature verification error:", error);
    return res.status(400).json({ error: "INVALID_SIGNATURE" });
  }

  const db = getFirestore(getAdminApp());

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
        if (Number(order.amount ?? order.total ?? -1) !== Number(paymentIntent.amount)) {
          throw new Error("AMOUNT_MISMATCH");
        }

        if (order.status === "pending_payment") {
          tx.update(orderRef, {
            status: "paid",
            paidAt: new Date(),
            updatedAt: new Date(),
          });
        } else if (!canAdvanceStatus(order.status, "paid")) {
          throw new Error("INVALID_STATUS_TRANSITION");
        }
      }

      tx.set(eventRef, {
        eventId: event.id,
        type: event.type,
        processedAt: new Date(),
      });
    });

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("[stripe-webhook] event processing error:", error);
    return res.status(500).json({ error: "WEBHOOK_PROCESSING_FAILED" });
  }
}

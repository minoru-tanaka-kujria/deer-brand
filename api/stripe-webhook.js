/**
 * Vercel Serverless Function
 * POST /api/stripe-webhook
 */

import Stripe from "stripe";
import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp } from "./_lib/auth.js";

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
  paid: 1,
  preparing: 2,
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

// トランザクション外で実行（冪等性のため webhookEvents が既存なら skip）
async function sendOrderConfirmationEmail(order, orderId) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey || !order.email) return;
  const body = {
    personalizations: [{ to: [{ email: order.email }] }],
    from: { email: "noreply@deer.gift", name: "Deer Brand" },
    subject: `【Deer Brand】ご注文を承りました（注文番号: ${orderId}）`,
    content: [
      {
        type: "text/html",
        value: `<p>${order.shippingAddress?.fullName || "お客様"} 様</p>
<p>この度はDeer Brandをご利用いただきありがとうございます。<br>
以下のご注文を承りました。</p>
<table>
<tr><td>注文番号</td><td>${orderId}</td></tr>
<tr><td>商品</td><td>${order.productName || order.product || ""}</td></tr>
<tr><td>スタイル</td><td>${order.style || ""}</td></tr>
<tr><td>合計金額</td><td>¥${(order.total ?? order.amount ?? 0).toLocaleString()}</td></tr>
</table>
<p>制作開始次第、ご連絡いたします。<br>ご不明な点はサポート（support@deer.gift）までお問い合わせください。</p>
<p>Deer Brand チーム</p>`,
      },
    ],
  };
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      console.warn("[stripe-webhook] email send failed:", res.status);
    else
      console.log("[stripe-webhook] confirmation email sent to", order.email);
  } catch (e) {
    console.warn("[stripe-webhook] email error:", e.message);
  }
}

async function triggerPrintfulOrder(db, order, orderId) {
  const apiKey = process.env.PRINTFUL_API_KEY;
  if (!apiKey) return;
  if (!order.artImageUrl) {
    console.warn("[stripe-webhook] Printful skip: no artImageUrl for", orderId);
    return;
  }
  if (order.printfulOrderId) {
    console.log("[stripe-webhook] Printful skip: already ordered", orderId);
    return;
  }

  const PRINTFUL_PRODUCT_IDS = {
    poster: 1,
    "tshirt-unisex": 71,
    "hoodie-pullover": 146,
    "mug-11oz": 19,
    "tote-bag": 587,
    "phone-case": 31,
    "canvas-wrap": 3,
    "sticker-sheet": 505,
    "emb-cap": 167,
    "emb-hoodie": 212,
  };
  const COLOR_MAP = {
    white: "White",
    black: "Black",
    navy: "Navy",
    gray: "Sport Gray",
  };
  const PLACEMENT_FILE_TYPE = {
    front: "front",
    back: "back",
    "left-chest": "front",
  };

  const productId = PRINTFUL_PRODUCT_IDS[order.product];
  if (!productId) {
    console.warn("[stripe-webhook] Printful: unknown product", order.product);
    return;
  }

  try {
    // バリアントID取得
    const varRes = await fetch(
      `https://api.printful.com/products/${productId}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );
    const varData = await varRes.json();
    const colorName = COLOR_MAP[order.color || ""] || "White";
    const variant = (varData.result?.variants || []).find(
      (v) => v.color === colorName && (!order.size || v.size === order.size),
    );
    if (!variant) {
      console.warn("[stripe-webhook] Printful: no variant found");
      return;
    }

    const isEmb = order.product === "emb-cap" || order.product === "emb-hoodie";
    const fileType = isEmb
      ? "embroidery"
      : PLACEMENT_FILE_TYPE[order.placementId || ""] || "front";
    const fileEntry = { url: order.artImageUrl, type: fileType };
    if (!isEmb)
      fileEntry.position = {
        area_width: 1800,
        area_height: 2400,
        width: 1800,
        height: 1800,
        top: 300,
        left: 0,
      };

    const s = order.shippingAddress || {};
    const printfulBody = {
      recipient: {
        name: s.fullName || "",
        address1: s.address1 || "",
        city: s.prefecture || "Tokyo",
        country_code: "JP",
        zip: s.zip || "",
        phone: s.phone || "",
        email: s.email || order.email || "",
      },
      items: [{ variant_id: variant.id, quantity: 1, files: [fileEntry] }],
      retail_costs: { currency: "JPY", subtotal: String(order.total ?? 0) },
    };

    const pfRes = await fetch("https://api.printful.com/orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(printfulBody),
    });
    const pfData = await pfRes.json();
    if (!pfRes.ok) {
      console.error("[stripe-webhook] Printful order failed:", pfData);
      return;
    }

    const printfulOrderId = pfData.result?.id ?? null;
    await db
      .collection("orders")
      .doc(orderId)
      .update({
        printfulOrderId,
        printfulOrderUrl: printfulOrderId
          ? `https://www.printful.com/dashboard/orders/${printfulOrderId}`
          : null,
        status: "printing",
        updatedAt: new Date(),
      });
    console.log("[stripe-webhook] Printful order created:", printfulOrderId);
  } catch (e) {
    console.error("[stripe-webhook] Printful error:", e.message);
  }
}

export default async function handler(req, res) {
  const ALLOWED_ORIGINS = [
    "https://custom.deer.gift",
    "https://deer-brand.vercel.app",
    process.env.ALLOWED_ORIGIN,
  ].filter(Boolean);
  const origin = (req.headers.origin || "").trim();
  const corsOrigin =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/deer-brand[a-z0-9-]*\.vercel\.app$/.test(origin)
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
      });
    });

    // トランザクション外で email + Printful を非同期実行（Webhook レスポンスをブロックしない）
    if (succeededOrderId) {
      const orderRef2 = db.collection("orders").doc(succeededOrderId);
      const finalOrder = (await orderRef2.get()).data();
      if (finalOrder) {
        sendOrderConfirmationEmail(finalOrder, succeededOrderId).catch((e) =>
          console.warn("[webhook] email error:", e),
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

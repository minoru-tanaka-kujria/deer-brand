/**
 * Vercel Serverless Function
 * POST /api/stripe-webhook
 */

import crypto from "node:crypto";
import Stripe from "stripe";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
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

// ── クーポンコード生成ヘルパー ──
function generateCouponCode(prefix) {
  const seg = () =>
    crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 4);
  return `${prefix}-${seg()}-${seg()}`;
}

// ── スタンプ無料クーポン発行（冪等: 既発行ならスキップ） ──
async function issueStampCoupon(db, order, orderId) {
  if (order.stampCouponCode) return order.stampCouponCode;
  const code = generateCouponCode("STAMP");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  try {
    await db.collection("coupons").doc(code).set({
      type: "fixed",
      discount: 4980,
      maxUses: 1,
      usedCount: 0,
      isActive: true,
      description: "うちの子スタンプ無料クーポン",
      expiresAt,
      createdAt: now,
      sourceOrderId: orderId,
    });
    if (order.uid) {
      await db
        .collection("users")
        .doc(order.uid)
        .update({
          availableCoupons: FieldValue.arrayUnion({
            code,
            description: "うちの子スタンプ無料クーポン（¥4,980OFF）",
            discount: 4980,
            expiresAt: expiresAt.toISOString(),
          }),
        });
    }
    await db
      .collection("orders")
      .doc(orderId)
      .update({ stampCouponCode: code });
    console.log("[stripe-webhook] stamp coupon issued:", code);
    return code;
  } catch (e) {
    console.warn("[stripe-webhook] stamp coupon error:", e.message);
    return null;
  }
}

// ── リピート購入クーポン発行（メール用） ──
async function issueRepeatCoupon(db, order, orderId) {
  if (order.repeatCouponCode) return order.repeatCouponCode;
  const code = generateCouponCode("REPEAT");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  try {
    await db.collection("coupons").doc(code).set({
      type: "fixed",
      discount: 300,
      maxUses: 1,
      usedCount: 0,
      isActive: true,
      description: "リピート購入クーポン",
      expiresAt,
      createdAt: now,
      sourceOrderId: orderId,
    });
    if (order.uid) {
      await db
        .collection("users")
        .doc(order.uid)
        .update({
          availableCoupons: FieldValue.arrayUnion({
            code,
            description: "次回¥300OFFクーポン",
            discount: 300,
            expiresAt: expiresAt.toISOString(),
          }),
        });
    }
    await db
      .collection("orders")
      .doc(orderId)
      .update({ repeatCouponCode: code });
    console.log("[stripe-webhook] repeat coupon issued:", code);
    return code;
  } catch (e) {
    console.warn("[stripe-webhook] repeat coupon error:", e.message);
    return null;
  }
}

// ── 注文確認メール送信（スタンプ+リピートクーポン込み） ──
async function sendOrderConfirmationEmail(db, order, orderId) {
  const apiKey = process.env.SENDGRID_API_KEY;
  // ギフト注文時は注文者メールに送信、通常は配送先メールに送信
  const toEmail =
    order.isGift && order.ordererInfo?.email
      ? order.ordererInfo.email
      : order.email;
  if (!apiKey || !toEmail) return;

  // クーポン発行（冪等）
  const stampCode = await issueStampCoupon(db, order, orderId);
  const repeatCode = await issueRepeatCoupon(db, order, orderId);

  const customerName = order.isGift
    ? order.ordererInfo?.name || "お客様"
    : order.shippingAddress?.fullName || "お客様";
  const amount = (order.total ?? order.amount ?? 0).toLocaleString();
  const itemName =
    (order.items?.[0]?.productName ?? order.productName ?? order.product) || "";
  const s = order.shippingAddress || {};
  const shippingBlock = s.fullName
    ? `<p style="margin:0;line-height:1.6">〒${s.zip || ""}<br>${s.prefecture || ""}${s.address1 || ""}${s.address2 || ""}<br>${s.fullName}</p>`
    : "";
  // ギフト注文時の追加セクション
  const giftInfoBlock = order.isGift
    ? `<div style="background:#fff8e1;border:1px solid #c8956c;border-radius:8px;padding:16px;margin:16px 0">
<p style="margin:0 0 8px;font-size:13px;color:#c8956c;font-weight:600">🎁 ギフト注文</p>
<p style="margin:0;font-size:12px;color:#5d4037">お届け先: ${s.fullName || ""} 様<br>金額非表示の納品書でお届けします。</p>
${order.giftMessage ? `<p style="margin:8px 0 0;font-size:12px;color:#666;border-top:1px dashed #e8e0d4;padding-top:8px">💌 ${order.giftMessage}</p>` : ""}
</div>`
    : "";

  const stampSection = stampCode
    ? `<div style="background:#fff8e1;border:2px dashed #c8956c;border-radius:12px;padding:20px;margin:24px 0;text-align:center">
<p style="margin:0 0 8px;font-size:14px;color:#8d6e63">🎁 うちの子スタンプ無料クーポン</p>
<p style="margin:0;font-size:24px;font-weight:bold;letter-spacing:2px;color:#5d4037">${stampCode}</p>
<p style="margin:8px 0 0;font-size:12px;color:#999">有効期限: 90日間 ｜ <a href="https://custom.deer.gift/stamp?coupon=${encodeURIComponent(stampCode)}" style="color:#c8956c">スタンプを作る →</a></p>
</div>`
    : "";

  const repeatSection = repeatCode
    ? `<div style="background:#f1f8e9;border:1px solid #c5e1a5;border-radius:8px;padding:16px;margin:16px 0;text-align:center">
<p style="margin:0 0 4px;font-size:13px;color:#689f38">🎉 次回のご注文で使える ¥300 OFF クーポン</p>
<p style="margin:0;font-size:18px;font-weight:bold;color:#33691e">${repeatCode}</p>
<p style="margin:6px 0 0;font-size:11px;color:#999">有効期限: 60日間</p>
</div>`
    : "";

  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f1eb;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#fffdf8">
<div style="background:#3e2c23;padding:24px;text-align:center">
<h1 style="margin:0;color:#f5f1eb;font-size:22px;font-weight:300;letter-spacing:3px">DEER BRAND</h1>
</div>
<div style="padding:32px 28px">
<p style="font-size:16px;color:#3e2c23">${customerName} 様</p>
<p style="color:#5d4037;line-height:1.8">この度はDeer Brandをご利用いただきありがとうございます。<br>ご注文を承りましたのでお知らせいたします。</p>
<table style="width:100%;border-collapse:collapse;margin:20px 0" cellpadding="8">
<tr style="border-bottom:1px solid #e8e0d4"><td style="color:#999;width:100px">注文番号</td><td style="color:#3e2c23;font-weight:bold">${orderId}</td></tr>
<tr style="border-bottom:1px solid #e8e0d4"><td style="color:#999">商品</td><td style="color:#3e2c23">${itemName}</td></tr>
<tr style="border-bottom:1px solid #e8e0d4"><td style="color:#999">合計金額</td><td style="color:#3e2c23;font-weight:bold">¥${amount}</td></tr>
</table>
${shippingBlock ? `<div style="background:#faf7f2;border-radius:8px;padding:16px;margin:16px 0"><p style="margin:0 0 8px;font-size:13px;color:#999">お届け先</p>${shippingBlock}</div>` : ""}
${giftInfoBlock}
${stampSection}
${repeatSection}
<p style="color:#5d4037;line-height:1.8;margin-top:24px">制作が完了次第、改めてご連絡いたします。<br>通常3〜5営業日でお届けいたします。</p>
<div style="text-align:center;margin:28px 0">
<a href="https://custom.deer.gift/upload" style="display:inline-block;background:#c8956c;color:#fff;text-decoration:none;padding:12px 32px;border-radius:6px;font-size:14px">もう一着つくる →</a>
</div>
</div>
<div style="background:#3e2c23;padding:20px;text-align:center">
<p style="margin:0;color:#a08979;font-size:11px">Deer Brand ｜ <a href="mailto:support@deer.gift" style="color:#c8956c">support@deer.gift</a></p>
<p style="margin:4px 0 0;color:#6d5c52;font-size:10px"><a href="https://custom.deer.gift/tokushoho" style="color:#6d5c52">特定商取引法に基づく表記</a> ｜ <a href="https://custom.deer.gift/privacy" style="color:#6d5c52">プライバシーポリシー</a></p>
</div>
</div>
</body></html>`;

  const body = {
    personalizations: [{ to: [{ email: toEmail }] }],
    from: { email: "noreply@deer.gift", name: "Deer Brand" },
    subject: `【Deer Brand】ご注文ありがとうございます（${orderId}）`,
    content: [{ type: "text/html", value: htmlBody }],
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
        address2: s.address2 || "",
        city: s.prefecture || "Tokyo",
        country_code: "JP",
        zip: s.zip || "",
        phone: s.phone || "",
        email: s.email || order.email || "",
      },
      items: [{ variant_id: variant.id, quantity: 1, files: [fileEntry] }],
      retail_costs: { currency: "JPY", subtotal: String(order.total ?? 0) },
    };
    // ギフト注文: 金額非表示納品書 + メッセージ
    if (order.isGift) {
      printfulBody.gift = {
        subject: "Deer Brand からのギフト",
        message: order.giftMessage || "心を込めてお届けします。",
      };
      printfulBody.packing_slip = {
        email: order.ordererInfo?.email || order.email || "",
        phone: "",
        message: order.giftMessage || "",
        logo_url: "https://custom.deer.gift/img/deer-logo.png",
        store_name: "Deer Brand",
      };
    }

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

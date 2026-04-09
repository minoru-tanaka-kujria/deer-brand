/**
 * Vercel Serverless Function
 * POST /api/stripe-payment-intent
 * Body: { items, shipping, couponCode, igDiscountToken }
 * Response: { clientSecret: string, orderId: string }
 */

import crypto from "node:crypto";
import Stripe from "stripe";
import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp, verifyAuth } from "./_lib/auth.js";
import { resolveCouponDiscount, resolveIgDiscount } from "./_lib/discounts.js";
import { PRODUCTS, calculateTotal } from "./_lib/products.js";

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 1000;

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

function normalizeCheckoutItem(rawItem) {
  const itemId = rawItem?.item ?? rawItem?.product ?? rawItem?.productId;
  const product = PRODUCTS[itemId];
  if (!product) {
    throw new Error("INVALID_ITEM");
  }

  const placementValue = rawItem?.placementId ?? rawItem?.placement ?? rawItem?.placementName;
  const placement = product.placements.find(
    (entry) => entry.id === placementValue || entry.name === placementValue,
  );
  if (!placement) {
    throw new Error("INVALID_PLACEMENT");
  }

  const colorValue = rawItem?.colorId ?? rawItem?.color ?? null;
  const color = colorValue
    ? product.colors.find(
      (entry) => entry.id === colorValue || entry.name === colorValue,
    )
    : null;
  if (colorValue && !color) {
    throw new Error("INVALID_COLOR");
  }

  const sizeValue = rawItem?.size ?? null;
  if (product.sizes.length && (!sizeValue || !product.sizes.includes(sizeValue))) {
    throw new Error("INVALID_SIZE");
  }

  const petCount = Number(rawItem?.petCount ?? 1);

  return {
    item: itemId,
    productName: product.name,
    placementId: placement.id,
    placementName: placement.name,
    colorId: color?.id ?? null,
    colorName: color?.name ?? null,
    size: sizeValue ?? null,
    petCount,
    petNames: Array.isArray(rawItem?.petNames)
      ? rawItem.petNames.filter((name) => typeof name === "string" && name.trim())
      : [],
  };
}

function sanitizeShipping(shipping) {
  if (!shipping || typeof shipping !== "object") return null;
  return {
    fullName: shipping.fullName ?? shipping.name ?? "",
    email: shipping.email ?? "",
    phone: shipping.phone ?? "",
    zip: shipping.zip ?? "",
    prefecture: shipping.prefecture ?? "",
    address1: shipping.address1 ?? "",
    address2: shipping.address2 ?? "",
  };
}

async function consumeRateLimit(db, key) {
  const ref = db.collection("rateLimits").doc(key);
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, {
        count: 1,
        windowStart: new Date(now),
        updatedAt: new Date(now),
      });
      return;
    }

    const data = snap.data();
    const windowStart =
      typeof data.windowStart?.toDate === "function"
        ? data.windowStart.toDate().getTime()
        : new Date(data.windowStart).getTime();

    if (!Number.isFinite(windowStart) || now - windowStart >= RATE_WINDOW_MS) {
      tx.set(
        ref,
        {
          count: 1,
          windowStart: new Date(now),
          updatedAt: new Date(now),
        },
        { merge: true },
      );
      return;
    }

    const nextCount = Number(data.count ?? 0) + 1;
    if (nextCount > RATE_LIMIT) {
      throw new Error("RATE_LIMITED");
    }

    tx.update(ref, {
      count: nextCount,
      updatedAt: new Date(now),
    });
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  let authUser;
  try {
    authUser = await verifyAuth(req);
  } catch (error) {
    console.error("[stripe-payment-intent] auth error:", error);
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  const { items, shipping, couponCode, igDiscountToken } = req.body ?? {};
  if (!Array.isArray(items) || items.length !== 1) {
    return res.status(400).json({ error: "INVALID_ITEMS" });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!stripeSecretKey) {
    console.error("[stripe-payment-intent] missing STRIPE_SECRET_KEY");
    return res.status(500).json({ error: "CONFIG_ERROR" });
  }

  const db = getFirestore(getAdminApp());

  try {
    await consumeRateLimit(db, `payment_uid_${authUser.uid}`);
    await consumeRateLimit(db, `payment_ip_${getClientIp(req)}`);
  } catch (error) {
    console.error("[stripe-payment-intent] rate limit fail-closed:", error);
    return res.status(429).json({ error: "RATE_LIMITED" });
  }

  try {
    const normalizedItem = normalizeCheckoutItem(items[0]);
    const subtotal = calculateTotal({
      item: normalizedItem.item,
      placement: normalizedItem.placementId,
      color: normalizedItem.colorId,
      size: normalizedItem.size,
      petCount: normalizedItem.petCount,
      couponDiscount: 0,
      igDiscount: 0,
    });

    const { couponCode: resolvedCouponCode, couponDiscount } = await resolveCouponDiscount({
      db,
      code: couponCode,
      subtotal,
    });
    const igDiscount = resolveIgDiscount({
      token: igDiscountToken,
      uid: authUser.uid,
    });
    const amount = calculateTotal({
      item: normalizedItem.item,
      placement: normalizedItem.placementId,
      color: normalizedItem.colorId,
      size: normalizedItem.size,
      petCount: normalizedItem.petCount,
      couponDiscount,
      igDiscount,
    });

    if (amount === 0 && couponDiscount !== subtotal) {
      return res.status(400).json({ error: "INVALID_FREE_ORDER" });
    }

    const orderId = crypto.randomUUID();
    const orderData = {
      orderId,
      uid: authUser.uid,
      email: authUser.email,
      emailVerified: authUser.emailVerified,
      amount,
      total: amount,
      items: [normalizedItem],
      shippingAddress: sanitizeShipping(shipping),
      couponCode: resolvedCouponCode,
      couponDiscount,
      igDiscount,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (amount === 0) {
      await db.collection("orders").doc(orderId).set({
        ...orderData,
        paymentIntentId: null,
        status: "paid",
        paidAt: new Date(),
      });

      return res.status(200).json({
        clientSecret: null,
        orderId,
      });
    }

    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: "2024-04-10",
      httpClient: Stripe.createNodeHttpClient(),
    });

    const userSnap = await db.collection("users").doc(authUser.uid).get();
    const customerId = userSnap.exists ? userSnap.data()?.stripeCustomerId ?? null : null;

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount,
        currency: "jpy",
        customer: customerId || undefined,
        metadata: {
          userId: authUser.uid,
          orderId,
        },
        payment_method_types: ["card"],
      },
      {
        idempotencyKey: `pi_${orderId}`,
      },
    );

    await db.collection("orders").doc(orderId).set({
      ...orderData,
      paymentIntentId: paymentIntent.id,
      status: "pending_payment",
    });

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      orderId,
    });
  } catch (error) {
    console.error("[stripe-payment-intent] error:", error);
    if (
      error.message === "INVALID_ITEM" ||
      error.message === "INVALID_PLACEMENT" ||
      error.message === "INVALID_COLOR" ||
      error.message === "INVALID_SIZE" ||
      error.message === "INVALID_COUPON" ||
      error.message === "INVALID_IG_DISCOUNT"
    ) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: "PAYMENT_INTENT_CREATE_FAILED" });
  }
}

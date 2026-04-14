/**
 * Vercel Serverless Function
 * POST /api/create-order
 */

import Stripe from "stripe";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getAdminApp, verifyAuth } from "./_lib/auth.js";
import { calculateTotal } from "./_lib/products.js";
import { setCorsHeaders, handlePreflight } from "./_lib/cors.js";

// モジュールスコープでキャッシュ
const _stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY.trim(), {
      apiVersion: "2024-04-10",
    })
  : null;

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

function normalizeCheckoutItem(body, fallbackItem) {
  const source = fallbackItem ?? {};
  return {
    item: body?.item ?? body?.product ?? source.item,
    productName: body?.productName ?? source.productName ?? null,
    placementId: body?.placementId ?? source.placementId ?? body?.placement,
    placementName:
      body?.placementName ?? source.placementName ?? body?.placement ?? null,
    colorId: body?.colorId ?? source.colorId ?? body?.color ?? null,
    colorName: body?.colorName ?? source.colorName ?? body?.color ?? null,
    size: body?.size ?? source.size ?? null,
    petCount: Number(body?.petCount ?? source.petCount ?? 1),
    petNames: Array.isArray(body?.petNames)
      ? body.petNames.filter((name) => typeof name === "string" && name.trim())
      : Array.isArray(source.petNames)
        ? source.petNames
        : [],
    style: body?.style ?? body?.styleId ?? source.style ?? null,
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

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  let authUser;
  try {
    authUser = await verifyAuth(req);
  } catch (error) {
    console.error("[create-order] auth error:", error);
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  const {
    paymentIntentId,
    orderId: requestedOrderId,
    shippingAddress,
    artImageUrl,
    isGift,
    giftMessage,
    ordererInfo,
  } = req.body ?? {};
  if (!paymentIntentId && !requestedOrderId) {
    return res.status(400).json({ error: "INVALID_REQUEST" });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!stripeSecretKey) {
    console.error("[create-order] missing STRIPE_SECRET_KEY");
    return res.status(500).json({ error: "CONFIG_ERROR" });
  }

  const db = getFirestore(getAdminApp());
  const stripe = _stripe; // CONFIG_ERROR チェック済みなので必ず非null

  try {
    let paymentIntent = null;
    let orderId = requestedOrderId ?? "";

    if (paymentIntentId) {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      orderId = paymentIntent.metadata?.orderId ?? "";
      const paymentIntentUserId = paymentIntent.metadata?.userId ?? "";

      if (!orderId || paymentIntent.status !== "succeeded") {
        return res.status(400).json({ error: "INVALID_PAYMENT" });
      }
      if (paymentIntentUserId !== authUser.uid) {
        return res.status(403).json({ error: "FORBIDDEN" });
      }

      const duplicateSnap = await db
        .collection("orders")
        .where("paymentIntentId", "==", paymentIntentId)
        .get();
      const duplicateDocs = duplicateSnap.docs.filter(
        (doc) => doc.id !== orderId,
      );
      if (duplicateDocs.length > 0) {
        return res.status(409).json({ error: "PAYMENT_INTENT_ALREADY_USED" });
      }
    }

    const orderRef = db.collection("orders").doc(orderId);
    const userRef = db.collection("users").doc(authUser.uid);

    const result = await db.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) {
        throw new Error("ORDER_NOT_RESERVED");
      }

      const reservedOrder = orderSnap.data();
      if (reservedOrder.uid !== authUser.uid) {
        throw new Error("FORBIDDEN");
      }
      if (
        (reservedOrder.paymentIntentId ?? null) !== (paymentIntentId ?? null)
      ) {
        throw new Error("PAYMENT_MISMATCH");
      }
      if (
        reservedOrder.status !== "pending_payment" &&
        reservedOrder.status !== "paid"
      ) {
        throw new Error("ORDER_ALREADY_FINALIZED");
      }

      const item = normalizeCheckoutItem(req.body, reservedOrder.items?.[0]);
      const expectedAmount = calculateTotal({
        item: item.item,
        placement: item.placementId,
        color: item.colorId,
        size: item.size,
        petCount: item.petCount,
        couponDiscount: reservedOrder.couponDiscount ?? 0,
        igDiscount: reservedOrder.igDiscount ?? 0,
      });

      if (expectedAmount !== reservedOrder.amount) {
        throw new Error("AMOUNT_MISMATCH");
      }
      if (paymentIntent && expectedAmount !== paymentIntent.amount) {
        throw new Error("AMOUNT_MISMATCH");
      }

      const subtotal = calculateTotal({
        item: item.item,
        placement: item.placementId,
        color: item.colorId,
        size: item.size,
        petCount: item.petCount,
        couponDiscount: 0,
        igDiscount: 0,
      });
      if (expectedAmount === 0 && reservedOrder.couponDiscount !== subtotal) {
        throw new Error("INVALID_FREE_ORDER");
      }
      if (expectedAmount === 0 && reservedOrder.status !== "paid") {
        throw new Error("INVALID_FREE_ORDER");
      }

      const nextStatus = canAdvanceStatus(reservedOrder.status, "paid")
        ? "paid"
        : reservedOrder.status;
      const now = new Date();
      tx.set(
        orderRef,
        {
          orderId,
          uid: authUser.uid,
          email: authUser.email,
          emailVerified: authUser.emailVerified,
          items: [item],
          product: item.item,
          productName: item.productName,
          placement: item.placementName,
          placementId: item.placementId,
          style: item.style,
          color: item.colorId,
          size: item.size,
          petCount: item.petCount,
          petNames: item.petNames,
          artImageUrl:
            typeof artImageUrl === "string" && artImageUrl.startsWith("http")
              ? artImageUrl
              : (reservedOrder.artImageUrl ?? null),
          total: expectedAmount,
          amount: expectedAmount,
          paymentIntentId,
          couponCode: reservedOrder.couponCode ?? null,
          couponDiscount: reservedOrder.couponDiscount ?? 0,
          igDiscount: reservedOrder.igDiscount ?? 0,
          shippingAddress:
            sanitizeShipping(shippingAddress) ??
            reservedOrder.shippingAddress ??
            null,
          isGift: !!isGift,
          giftMessage:
            typeof giftMessage === "string" ? giftMessage.slice(0, 200) : "",
          ordererInfo: isGift
            ? {
                name: ordererInfo?.name || "",
                email: ordererInfo?.email || "",
                phone: ordererInfo?.phone || "",
              }
            : null,
          status: nextStatus,
          paidAt: reservedOrder.paidAt ?? now,
          finalizedAt: now,
          updatedAt: now,
        },
        { merge: true },
      );
      tx.set(
        userRef,
        {
          orders: FieldValue.arrayUnion(orderId),
          updatedAt: now,
        },
        { merge: true },
      );

      return { orderId, couponCode: reservedOrder.couponCode ?? null };
    });

    // クーポン使用確定（P0-3）
    if (result.couponCode) {
      try {
        const couponRef = db.collection("coupons").doc(result.couponCode);
        const userRef2 = db.collection("users").doc(authUser.uid);
        await db.runTransaction(async (tx2) => {
          const [cSnap, uSnap] = await Promise.all([
            tx2.get(couponRef),
            tx2.get(userRef2),
          ]);
          const c = cSnap.data();
          if (!c || c.isActive === false) return;
          const maxUses = c.maxUses == null ? Infinity : Number(c.maxUses);
          if ((c.usedCount ?? 0) >= maxUses) return;
          if (
            uSnap.exists &&
            (uSnap.data().appliedCoupons ?? []).includes(result.couponCode)
          )
            return;
          tx2.update(couponRef, {
            usedCount: FieldValue.increment(1),
            updatedAt: new Date(),
          });
          tx2.set(
            userRef2,
            { appliedCoupons: FieldValue.arrayUnion(result.couponCode) },
            { merge: true },
          );
        });
      } catch (couponErr) {
        console.warn("[create-order] coupon usage mark failed:", couponErr);
      }
    }

    return res.status(201).json(result);
  } catch (error) {
    console.error("[create-order] error:", error);

    if (error.message === "ORDER_NOT_RESERVED") {
      return res.status(400).json({ error: "ORDER_NOT_RESERVED" });
    }
    if (error.message === "FORBIDDEN") {
      return res.status(403).json({ error: "FORBIDDEN" });
    }
    if (
      error.message === "PAYMENT_MISMATCH" ||
      error.message === "AMOUNT_MISMATCH" ||
      error.message === "INVALID_FREE_ORDER" ||
      error.message === "INVALID_ITEM" ||
      error.message === "INVALID_PLACEMENT" ||
      error.message === "INVALID_COLOR" ||
      error.message === "INVALID_SIZE" ||
      error.message === "INVALID_PET_COUNT"
    ) {
      return res.status(400).json({ error: error.message });
    }
    if (error.message === "ORDER_ALREADY_FINALIZED") {
      return res.status(409).json({ error: "ORDER_ALREADY_FINALIZED" });
    }

    return res.status(500).json({ error: "ORDER_CREATE_FAILED" });
  }
}

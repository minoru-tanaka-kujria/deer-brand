/**
 * Vercel Serverless Function
 * POST /api/stripe-setup-intent
 * Response: { clientSecret: string }
 */

import Stripe from "stripe";
import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp, verifyAuth } from "./_lib/auth.js";

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  let authUser;
  try {
    authUser = await verifyAuth(req);
  } catch (error) {
    console.error("[stripe-setup-intent] auth error:", error);
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!stripeSecretKey) {
    console.error("[stripe-setup-intent] missing STRIPE_SECRET_KEY");
    return res.status(500).json({ error: "CONFIG_ERROR" });
  }

  try {
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-04-10" });
    const db = getFirestore(getAdminApp());
    const userRef = db.collection("users").doc(authUser.uid);
    const userSnap = await userRef.get();

    let customerId = userSnap.exists
      ? (userSnap.data()?.stripeCustomerId ?? null)
      : null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: authUser.email ?? undefined,
        metadata: { userId: authUser.uid },
      });
      customerId = customer.id;
      await userRef.set(
        {
          stripeCustomerId: customerId,
          updatedAt: new Date(),
        },
        { merge: true },
      );
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      metadata: { userId: authUser.uid },
    });

    return res.status(200).json({
      clientSecret: setupIntent.client_secret,
    });
  } catch (error) {
    console.error("[stripe-setup-intent] error:", error);
    return res.status(500).json({ error: "SETUP_INTENT_CREATE_FAILED" });
  }
}

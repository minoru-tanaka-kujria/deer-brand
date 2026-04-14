/**
 * Vercel Serverless Function
 * POST /api/stripe-setup-intent
 * Response: { clientSecret: string }
 */

import Stripe from "stripe";
import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp, verifyAuth } from "./_lib/auth.js";
import { setCorsHeaders, handlePreflight } from "./_lib/cors.js";

// モジュールスコープでキャッシュ
const _stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY.trim(), {
      apiVersion: "2024-04-10",
    })
  : null;

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
    console.error("[stripe-setup-intent] auth error:", error);
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!stripeSecretKey) {
    console.error("[stripe-setup-intent] missing STRIPE_SECRET_KEY");
    return res.status(500).json({ error: "CONFIG_ERROR" });
  }

  try {
    const stripe = _stripe; // CONFIG_ERROR チェック済みなので必ず非null
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

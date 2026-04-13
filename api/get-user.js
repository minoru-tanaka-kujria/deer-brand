/**
 * Vercel Serverless Function
 * GET /api/get-user?uid=xxx
 * Authorization: Bearer <Firebase IDトークン>
 * Response: { user: {...}, paymentMethods: [...] }
 *
 * - Firebase Admin IDトークン検証
 * - Firestoreからユーザーデータ取得
 * - Stripe APIでsavedPaymentMethods取得
 */

import Stripe from "stripe";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getAdminApp } from "./_lib/auth.js";

// モジュールスコープでキャッシュ
const _stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY.trim(), {
      apiVersion: "2024-04-10",
    })
  : null;

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { uid } = req.query;

  if (!uid) {
    return res.status(400).json({ error: "uid クエリパラメータは必須です" });
  }

  // Authorization ヘッダーからIDトークンを取得
  const authHeader = req.headers.authorization ?? "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!idToken) {
    return res.status(401).json({ error: "認証トークンがありません" });
  }

  try {
    const app = getAdminApp();
    const auth = getAuth(app);
    const db = getFirestore(app);

    // IDトークンを検証
    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(idToken);
    } catch (authErr) {
      console.error("[get-user] IDトークン検証失敗:", authErr.message);
      return res.status(401).json({ error: "認証トークンが無効です" });
    }

    // トークン内のuidと要求uidが一致するか確認
    if (decodedToken.uid !== uid) {
      return res
        .status(403)
        .json({ error: "他のユーザーの情報へのアクセスは禁止されています" });
    }

    // Firestoreからユーザーデータ取得
    const userSnap = await db.collection("users").doc(uid).get();

    if (!userSnap.exists) {
      return res.status(404).json({ error: "ユーザーが見つかりません" });
    }

    const userData = userSnap.data();

    // レスポンス用にユーザーデータを整形
    const user = {
      uid,
      stripeCustomerId: userData.stripeCustomerId ?? null,
      savedAddresses: userData.savedAddresses ?? [],
      orders: userData.orders ?? [],
      availableCoupons: userData.availableCoupons ?? [],
      appliedCoupons: userData.appliedCoupons ?? [],
      displayName: userData.displayName ?? null,
      pictureUrl: userData.pictureUrl ?? null,
      email: userData.email ?? null,
      createdAt: userData.createdAt ?? null,
      updatedAt: userData.updatedAt ?? null,
    };

    // Stripe savedPaymentMethodsを取得
    let paymentMethods = [];
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

    if (stripeSecretKey && user.stripeCustomerId) {
      try {
        const stripe = _stripe; // STRIPE_SECRET_KEY が存在する場合のみ到達するため必ず非null
        const pmList = await stripe.paymentMethods.list({
          customer: user.stripeCustomerId,
          type: "card",
        });
        paymentMethods = pmList.data.map((pm) => ({
          id: pm.id,
          brand: pm.card?.brand ?? null,
          last4: pm.card?.last4 ?? null,
          expMonth: pm.card?.exp_month ?? null,
          expYear: pm.card?.exp_year ?? null,
        }));
      } catch (stripeErr) {
        // Stripe取得失敗はログのみ（ユーザーデータは返す）
        console.error(
          "[get-user] Stripe paymentMethods取得失敗:",
          stripeErr.message,
        );
      }
    }

    return res.status(200).json({ user, paymentMethods });
  } catch (err) {
    console.error("[get-user] 予期しないエラー:", err);
    return res
      .status(500)
      .json({ error: err.message ?? "ユーザー情報の取得に失敗しました" });
  }
}

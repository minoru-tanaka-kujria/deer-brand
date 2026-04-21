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
import { setCorsHeaders, handlePreflight } from "./_lib/cors.js";

// モジュールスコープでキャッシュ
const _stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY.trim(), {
      apiVersion: "2024-04-10",
    })
  : null;

export default async function handler(req, res) {
  setCorsHeaders(req, res, "GET, POST, OPTIONS");
  if (handlePreflight(req, res)) return;

  // ── POST /api/get-user?type=error-report ─────────────────────────────
  // ユーザー実機エラーの集約受信。Hobby plan の Function 上限(12)に達しているため
  // 専用 endpoint を作らず get-user に相乗りする。
  if (req.method === "POST" && req.query.type === "error-report") {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    if (errors.length === 0) {
      return res.status(400).json({ error: "errors 配列が必要です" });
    }
    // サイズ制限・サニタイズ（最大50件、各 message は 4KB まで）
    const sanitized = errors.slice(0, 50).map((e) => ({
      t: typeof e?.t === "number" ? e.t : Date.now(),
      type: typeof e?.type === "string" ? e.type.slice(0, 40) : "error",
      message: typeof e?.message === "string" ? e.message.slice(0, 4000) : "",
      source: typeof e?.source === "string" ? e.source.slice(0, 500) : null,
      line: typeof e?.line === "number" ? e.line : null,
      col: typeof e?.col === "number" ? e.col : null,
      stack: typeof e?.stack === "string" ? e.stack.slice(0, 4000) : null,
      violatedDirective:
        typeof e?.violatedDirective === "string"
          ? e.violatedDirective.slice(0, 200)
          : null,
      blockedURI:
        typeof e?.blockedURI === "string" ? e.blockedURI.slice(0, 500) : null,
      ctx: e?.ctx || null,
    }));
    try {
      const db = getFirestore(getAdminApp());
      await db.collection("errorReports").add({
        reportedAt: new Date(),
        ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null,
        userAgent: req.headers["user-agent"]?.slice(0, 500) || null,
        referer: req.headers.referer?.slice(0, 500) || null,
        errors: sanitized,
        count: sanitized.length,
      });
      return res.json({ ok: true, stored: sanitized.length });
    } catch (err) {
      console.error("[error-report] Firestore write failed:", err.message);
      // クライアントに詳細は返さない（PII漏洩防止）
      return res.status(500).json({ error: "failed to store" });
    }
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { uid, type } = req.query;

  // /api/config の代替: ?type=config で公開設定を返す（認証不要）
  if (type === "config") {
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).json({
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
      sentryDsn: process.env.SENTRY_DSN || null,
    });
  }

  // ?type=reviews でFirestoreの承認済みレビューを返す（認証不要）
  if (type === "reviews") {
    try {
      const db = getFirestore(getAdminApp());
      const snap = await db
        .collection("reviews")
        .where("approved", "==", true)
        .orderBy("createdAt", "desc")
        .limit(10)
        .get();
      const reviews = snap.docs.map((d) => {
        const data = d.data();
        return {
          rating: data.rating,
          comment: data.comment,
          petName: data.petName,
        };
      });
      return res.status(200).json({ reviews });
    } catch (e) {
      return res.status(200).json({ reviews: [] });
    }
  }

  // ?type=share で動的OGPページを返す（認証不要）
  // 例: /api/get-user?type=share&art=https://...&name=ポチ
  if (type === "share") {
    const artUrl = req.query.art || "https://custom.deer.gift/img/hero-dog.jpg";
    const petName = req.query.name || "愛犬";
    const title = `${petName}のオリジナルアート｜Deer Brand`;
    const desc = `${petName}の写真からAIが生成したアート。あなたも愛犬・愛猫のオリジナルグッズを作りませんか？`;
    const safeTitle = title.replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const safeDesc = desc.replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const safeArt = artUrl.replace(/"/g, "&quot;").replace(/</g, "&lt;");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.status(200).send(`<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8">
<meta property="og:type" content="website">
<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeDesc}">
<meta property="og:image" content="${safeArt}">
<meta property="og:url" content="https://custom.deer.gift/upload">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:description" content="${safeDesc}">
<meta name="twitter:image" content="${safeArt}">
<meta http-equiv="refresh" content="0;url=https://custom.deer.gift/">
<title>${safeTitle}</title>
</head><body><p>リダイレクト中...</p></body></html>`);
  }

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

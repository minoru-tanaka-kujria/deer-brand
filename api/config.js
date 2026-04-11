/**
 * /api/config
 *
 * GET → { stripePublishableKey }
 *
 * クライアントサイドで必要な公開設定をVercel環境変数から配信する。
 * 秘密鍵は含めない。公開鍵のみ。
 */

export default function handler(req, res) {
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "public, max-age=300");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });

  const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || "";

  return res.status(200).json({
    stripePublishableKey,
  });
}

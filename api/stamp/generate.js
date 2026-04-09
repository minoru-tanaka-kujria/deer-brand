/**
 * /api/stamp/generate
 *
 * POST { photoDataUrl, expression }
 *   → { predictionId }
 *
 * GET  ?id={predictionId}
 *   → { status, outputUrl? }
 *
 * LINEスタンプ用の画像生成API。
 * 共通の Replicate ラッパー + Flux Kontext Pro を使用。
 */

import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp, verifyAuth } from "../_lib/auth.js";
import { consumeRateLimit, getClientIp } from "../_lib/rate-limit.js";
import { createPrediction, pollPrediction } from "../_lib/replicate.js";

const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60 * 1000;

const MODEL = "black-forest-labs/flux-kontext-pro";

// LINEスタンプ用の表情・ポーズプロンプト
const EXPRESSION_PROMPTS = {
  happy:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet is smiling happily with sparkly eyes. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  sad:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet has a sad droopy expression with teary eyes. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  angry:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet has a comically angry puffed-up expression. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  surprised:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet has wide surprised eyes and an open mouth. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  sleepy:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet is sleepy with half-closed eyes and a peaceful expression. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  love:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet has heart eyes showing love, with small hearts floating around. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  wink:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet is winking playfully with one eye closed. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  eating:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet is happily eating with a food bowl. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  greeting:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet is waving a paw in greeting. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  thankyou:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet is bowing politely in a thank you gesture. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  sorry:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet looks apologetic with lowered ears and eyes looking up. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  celebrate:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet is celebrating with confetti and a party hat. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
};

const DEFAULT_PROMPT =
  "Transform this pet photo into a cute cartoon sticker illustration. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://custom.deer.gift");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return res.status(503).json({ error: "サービスを利用できません" });

  let authUser;
  try {
    authUser = await verifyAuth(req);
  } catch (error) {
    console.error("[stamp/generate] auth error:", error);
    return res.status(401).json({ error: "認証が必要です" });
  }

  const db = getFirestore(getAdminApp());
  try {
    await consumeRateLimit(db, `stamp_gen_uid_${authUser.uid}`, RATE_LIMIT, RATE_WINDOW_MS);
    await consumeRateLimit(db, `stamp_gen_ip_${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  } catch (error) {
    console.error("[stamp/generate] rate limit error:", error);
    return res.status(429).json({ error: "リクエストが多すぎます。時間をおいてお試しください" });
  }

  // GET: ポーリング
  if (req.method === "GET") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "不正なリクエストです" });

    try {
      const result = await pollPrediction({ token, id });
      return res.json(result);
    } catch (error) {
      console.error("[stamp/generate] poll error:", error);
      return res.status(502).json({ error: "生成結果を取得できませんでした" });
    }
  }

  // POST: スタンプ画像生成
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch {
        return res.status(400).json({ error: "invalid JSON" });
      }
    }

    const { photoDataUrl, expression } = body;
    if (!photoDataUrl) {
      return res.status(400).json({ error: "不正なリクエストです" });
    }

    const prompt = EXPRESSION_PROMPTS[expression] || DEFAULT_PROMPT;

    try {
      const { id } = await createPrediction({
        token,
        model: MODEL,
        input: {
          input_image: photoDataUrl,
          prompt,
          aspect_ratio: "1:1",
          output_format: "png",
          safety_tolerance: 6,
        },
      });
      return res.json({ predictionId: id });
    } catch (error) {
      console.error("[stamp/generate] Replicate error:", error);
      return res.status(502).json({ error: "画像を生成できませんでした" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

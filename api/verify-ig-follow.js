/**
 * Vercel Serverless Function
 * POST /api/verify-ig-follow
 * Body: { image: string (base64 data URL) }
 * Response: { verified: boolean, confidence: number, message: string, discountToken?: string|null }
 *
 * Claude Vision APIを使ってInstagramフォロースクリーンショットを解析
 */

import { createIgDiscountToken } from "./_lib/discounts.js";
import { verifyAuth } from "./_lib/auth.js";
import { setCorsHeaders, handlePreflight } from "./_lib/cors.js";
import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp } from "./_lib/auth.js";
import { consumeRateLimit, getClientIp } from "./_lib/rate-limit.js";

// OpenRouter Vision 課金と DoS 防止のため、画像サイズの上限を設ける。
// 8MB の元画像 → base64 約 10.7MB → data URL 全体で約 11.2M 文字。
const MAX_IMAGE_LENGTH = 11_500_000;
const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60 * 1000;

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { image } = req.body;
  if (!image || !image.startsWith("data:image/")) {
    return res
      .status(400)
      .json({ verified: false, message: "画像データが不正です" });
  }
  if (image.length > MAX_IMAGE_LENGTH) {
    return res.status(413).json({
      verified: false,
      message: "画像サイズが大きすぎます（8MB以下にしてください）",
    });
  }

  // base64部分を抽出
  const base64Data = image.split(",")[1] ?? "";
  const mediaType = image.match(/data:(image\/[\w+]+);/)?.[1] || "image/jpeg";
  if (!base64Data) {
    return res
      .status(400)
      .json({ verified: false, message: "画像データの形式が不正です" });
  }

  try {
    let authUser = null;
    try {
      authUser = await verifyAuth(req);
    } catch {
      return res
        .status(401)
        .json({ verified: false, message: "認証が必要です" });
    }

    // OpenRouter は 1 リクエストにつき課金が発生する。UID + IP 両方で絞る。
    try {
      const db = getFirestore(getAdminApp());
      await Promise.all([
        consumeRateLimit(
          db,
          `ig_verify_uid_${authUser.uid}`,
          RATE_LIMIT,
          RATE_WINDOW_MS,
        ),
        consumeRateLimit(
          db,
          `ig_verify_ip_${getClientIp(req)}`,
          RATE_LIMIT,
          RATE_WINDOW_MS,
        ),
      ]);
    } catch (rateErr) {
      console.warn("[verify-ig-follow] rate limit:", rateErr.message);
      return res.status(429).json({
        verified: false,
        message: "リクエストが多すぎます。時間をおいてお試しください",
      });
    }

    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      console.error("[verify-ig-follow] missing OPENROUTER_API_KEY");
      return res
        .status(503)
        .json({ verified: false, message: "サービスを利用できません" });
    }

    // OpenRouter Vision APIで解析 (OpenAI互換フォーマット)
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://deer-brand.vercel.app",
          "X-Title": "Deer Brand",
        },
        body: JSON.stringify({
          model: "google/gemini-2.0-flash-001",
          max_tokens: 200,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mediaType};base64,${base64Data}`,
                  },
                },
                {
                  type: "text",
                  text: `このInstagramのスクリーンショットを分析してください。
以下を確認してJSON形式で返答してください:
1. これはInstagramのプロフィール画面ですか？
2. アカウント名に "deer" が含まれますか？（大文字小文字問わず）
3. "フォロー中" または "Following" ボタンが見えますか？

回答フォーマット（JSONのみ、説明なし）:
{"isInstagram":true/false,"hasDeer":true/false,"isFollowing":true/false}`,
                },
              ],
            },
          ],
        }),
      },
    );

    const data = await response.json();
    const textContent = data.choices?.[0]?.message?.content || "{}";

    let parsed = { isInstagram: false, hasDeer: false, isFollowing: false };
    try {
      // コードブロック除去 + 最初のJSONオブジェクトを取り出す（ネスト対応）
      const cleaned = textContent.replace(/```json?|```/gi, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = { ...parsed, ...JSON.parse(jsonMatch[0]) };
    } catch (e) {
      /* parse error — デフォルト値使用 */
    }

    const verified = parsed.isInstagram && parsed.isFollowing && parsed.hasDeer;
    const confidence =
      [parsed.isInstagram, parsed.hasDeer, parsed.isFollowing].filter(Boolean)
        .length / 3;

    let message;
    if (verified) {
      message = "フォロー確認完了";
    } else if (confidence < 0.34) {
      message =
        "画像が不鮮明またはInstagramの画面ではない可能性があります。画面全体が映ったスクリーンショットをお試しください";
    } else if (!parsed.hasDeer) {
      message =
        "deer_dogfoodのプロフィール画面のスクリーンショットをお送りください。現在のスクリーンショットでは対象アカウントが確認できませんでした";
    } else if (!parsed.isFollowing) {
      message =
        "フォロー中の状態が確認できませんでした。deer_dogfoodをフォローした後、プロフィール画面のスクリーンショットをお送りください";
    } else {
      message = "確認できませんでした";
    }

    return res.status(200).json({
      verified,
      confidence,
      message,
      discountToken:
        verified && authUser
          ? createIgDiscountToken({ uid: authUser.uid })
          : null,
    });
  } catch (err) {
    console.error("IG verification error:", err);
    return res
      .status(500)
      .json({ verified: false, message: "確認処理でエラーが発生しました" });
  }
}

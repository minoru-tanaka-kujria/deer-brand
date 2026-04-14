/**
 * /api/remove-bg
 *
 * POST { photoDataUrl }  → { predictionId }  背景除去を開始
 * GET  ?id={predictionId} → { status, outputUrl? }
 *
 * モデル: cjwbw/rembg
 */

import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp, verifyAuth } from "./_lib/auth.js";
import { consumeRateLimit, getClientIp } from "./_lib/rate-limit.js";
import { createPrediction, pollPrediction } from "./_lib/replicate.js";
import { setCorsHeaders, handlePreflight } from "./_lib/cors.js";

const REMBG_VERSION =
  "fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003";
const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60 * 1000;

export default async function handler(req, res) {
  setCorsHeaders(req, res, "GET, POST, OPTIONS");
  if (handlePreflight(req, res)) return;

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token)
    return res.status(503).json({ error: "サービスを利用できません" });

  let authUser;
  try {
    authUser = await verifyAuth(req);
  } catch (error) {
    console.error("[remove-bg] auth error:", error);
    return res.status(401).json({ error: "認証が必要です" });
  }

  const db = getFirestore(getAdminApp());
  try {
    // UID・IP のレートリミットを並列チェック
    await Promise.all([
      consumeRateLimit(
        db,
        `remove_bg_uid_${authUser.uid}`,
        RATE_LIMIT,
        RATE_WINDOW_MS,
      ),
      consumeRateLimit(
        db,
        `remove_bg_ip_${getClientIp(req)}`,
        RATE_LIMIT,
        RATE_WINDOW_MS,
      ),
    ]);
  } catch (error) {
    console.error("[remove-bg] rate limit error:", error);
    return res
      .status(429)
      .json({ error: "リクエストが多すぎます。時間をおいてお試しください" });
  }

  // GET: ポーリング
  if (req.method === "GET") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "不正なリクエストです" });

    try {
      const result = await pollPrediction({ token, id });
      return res.json(result);
    } catch (error) {
      console.error("[remove-bg] poll error:", error);
      return res
        .status(502)
        .json({ error: "画像処理結果を取得できませんでした" });
    }
  }

  // POST: 背景除去開始
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: "不正なリクエストです" });
      }
    }

    const { photoDataUrl } = body;
    if (!photoDataUrl)
      return res.status(400).json({ error: "不正なリクエストです" });

    try {
      const { id } = await createPrediction({
        token,
        version: REMBG_VERSION,
        input: { image: photoDataUrl },
      });
      return res.json({ predictionId: id });
    } catch (error) {
      console.error("[remove-bg] Replicate error:", error);
      return res.status(502).json({ error: "画像処理に失敗しました" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

/**
 * /api/heic-convert
 *
 * POST { photoDataUrl: "data:image/heic;base64,..." }
 *   → { photoDataUrl: "data:image/jpeg;base64,...", width, height }
 *
 * クライアント側（heic2any / heic-to）での HEIC 変換が遅いので、
 * サーバーサイドで libheif (heic-convert) を使って高速変換する。
 *
 * 認証: 不要（HEIC 変換は写真アップロード前の前処理で、
 *       認証前のユーザーでも使えないと写真選びに進めない）。
 *       ただし IP ベースのレートリミットを適用する。
 *
 * ファイルサイズ制限: Vercel Hobby plan の 4.5MB body 上限に準拠。
 *       それを超える場合は client 側で明示エラーを出す。
 */

import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp } from "./_lib/auth.js";
import { consumeRateLimit, getClientIp } from "./_lib/rate-limit.js";
import { setCorsHeaders, handlePreflight } from "./_lib/cors.js";

const RATE_LIMIT = 20; // IPあたり 20 req/min
const RATE_WINDOW_MS = 60 * 1000;

// Vercel Serverless Function 設定（Next.js の api.bodyParser 構文は使えない）
// HEIC は client 側で 4MB 以下に制限するため、Vercel 側はデフォルトで OK。
export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  setCorsHeaders(req, res, "POST, OPTIONS");
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // IP レートリミット
  try {
    const db = getFirestore(getAdminApp());
    await consumeRateLimit(
      db,
      `heic_convert_ip_${getClientIp(req)}`,
      RATE_LIMIT,
      RATE_WINDOW_MS,
    );
  } catch (e) {
    return res
      .status(429)
      .json({ error: "リクエストが多すぎます。時間をおいてお試しください" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "invalid JSON" });
    }
  }
  const { photoDataUrl } = body || {};
  if (!photoDataUrl || typeof photoDataUrl !== "string") {
    return res.status(400).json({ error: "photoDataUrl が必要です" });
  }
  const commaIdx = photoDataUrl.indexOf(",");
  if (commaIdx < 0) {
    return res.status(400).json({ error: "不正な data URL です" });
  }
  const base64 = photoDataUrl.slice(commaIdx + 1);
  let inputBuffer;
  try {
    inputBuffer = Buffer.from(base64, "base64");
  } catch (e) {
    return res.status(400).json({ error: "base64 のデコードに失敗しました" });
  }
  // Vercel Hobby plan の body 上限が 4.5MB のため、base64 前で 3MB程度が上限
  if (inputBuffer.length > 4 * 1024 * 1024) {
    return res.status(413).json({
      error:
        "HEIC ファイルが 4MB を超えています。iPhone 設定で『互換性優先』に変更してから撮影し直してください。",
    });
  }

  // HEIC → JPEG 変換
  try {
    const convert = (await import("heic-convert")).default;
    const outputBuffer = await convert({
      buffer: inputBuffer,
      format: "JPEG",
      quality: 0.92,
    });
    const outputBase64 = Buffer.from(outputBuffer).toString("base64");
    return res.json({
      photoDataUrl: `data:image/jpeg;base64,${outputBase64}`,
    });
  } catch (error) {
    console.error("[heic-convert] 変換失敗:", error.message);
    return res.status(502).json({
      error: `HEIC 変換に失敗しました: ${error.message}`,
    });
  }
}

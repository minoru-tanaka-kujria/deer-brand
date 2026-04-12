/**
 * /api/generate-art
 *
 * POST { photoDataUrl, styleId }
 *   → { predictionId }
 *
 * GET  ?id={predictionId}
 *   → { status, outputUrl? }
 *
 * モデル: Flux.1 Kontext Pro (black-forest-labs/flux-kontext-pro)
 * 環境変数: REPLICATE_API_TOKEN
 */

import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp, verifyAuth } from "./_lib/auth.js";
import { consumeRateLimit, getClientIp } from "./_lib/rate-limit.js";
import { createPrediction, pollPrediction } from "./_lib/replicate.js";

const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60 * 1000;

// Flux.1 Kontext Pro — 2025年最高品質のimg2imgモデル
const MODEL_OWNER = "black-forest-labs";
const MODEL_NAME = "flux-kontext-pro";

// スタイル別プロンプト（Flux Kontextは「指示形式」が効果的）
const STYLE_PROMPTS = {
  "oil-impressionism":
    "Transform this pet photo into an impressionist oil painting in the style of Claude Monet. Use thick impasto brushstrokes, vibrant dappled light, lush colors. Keep the pet's face and features clearly recognizable. Museum quality fine art.",
  "oil-baroque":
    "Transform this pet photo into a baroque oil painting in the style of Rembrandt. Dramatic chiaroscuro lighting, dark moody background, rich warm tones. Keep the pet clearly recognizable. Museum quality.",
  "oil-renaissance":
    "Transform this pet photo into a renaissance oil painting in the style of Leonardo da Vinci. Rich jewel tones, detailed classical background, precise brushwork. Keep the pet clearly recognizable. Museum quality.",
  "oil-expressionism":
    "Transform this pet photo into an expressionist oil painting in the style of Edvard Munch. Bold distorted brushstrokes, emotional intensity, vivid saturated colors. Keep the pet recognizable.",
  "wc-loose":
    "Transform this pet photo into a loose watercolor painting. Wet-on-wet technique, beautiful color bleeding, soft dreamy edges, paint splashes. Keep the pet's likeness clearly visible.",
  "wc-botanical":
    "Transform this pet photo into a detailed botanical watercolor illustration. Precise delicate details, natural earth tones, scientific illustration style, white paper texture. Keep the pet recognizable.",
  "wc-wet":
    "Transform this pet photo into a wet-on-wet watercolor painting. Soft diffused colors, dreamy atmospheric washes, beautiful color gradients. Keep the pet's features visible.",
  "ink-sumie":
    "Transform this pet photo into a Japanese sumi-e ink painting. Black ink brushstrokes, minimalist zen style, white background, calligraphic marks. Keep the pet's essence and pose.",
  "ink-nanga":
    "Transform this pet photo into a Japanese nanga literati painting. Ink and light color wash, classical Chinese brush painting style. Keep the pet recognizable.",
  "pop-warhol":
    "Transform this pet photo into an Andy Warhol pop art style portrait. Vibrant screen print colors, bold flat colors, halftone dots, 1960s pop culture aesthetic. Keep the pet's face clearly recognizable.",
  "pop-comic":
    "Transform this pet photo into American comic book art. Bold black outlines, flat bright colors, Ben-Day dots, dynamic comic style. Keep the pet recognizable.",
  "pop-graffiti":
    "Transform this pet photo into graffiti street art. Spray paint texture, bold neon colors, urban mural style. Keep the pet's likeness clearly visible.",
  "mono-hicon":
    "Transform this pet photo into a high contrast black and white graphic artwork. Dramatic shadows, bold silhouette, graphic noir style. Keep the pet recognizable.",
  "mono-charcoal":
    "Transform this pet photo into a detailed charcoal drawing. Fine pencil shading, cross-hatching, academic fine art sketch. Keep the pet's features and likeness.",
  "mono-noir":
    "Transform this pet photo into a film noir black and white portrait. Cinematic 1940s style, dramatic side lighting, silver gelatin print aesthetic. Keep the pet recognizable.",
  "future-cyber":
    "Transform this pet photo into cyberpunk digital art. Neon electric colors, futuristic glowing lines, dark atmospheric background. Keep the pet's face clearly recognizable.",
  "future-neon":
    "Transform this pet photo into neon glowing art. Luminous neon tube colors, vibrant fluorescent tones, dark studio background. Keep the pet's likeness visible.",
  "future-glitch":
    "Transform this pet photo into glitch art. RGB color split effects, digital corruption, pixel shifting, electronic noise artifacts. Keep the pet recognizable.",
  "line-oneline":
    "Transform this pet photo into an elegant one-line continuous drawing. Single flowing ink line, minimalist linework, white background. Keep the pet's pose and key features.",
  "line-minimal":
    "Transform this pet photo into minimal line art. Clean precise lines, simple elegant illustration, fine ink on white background. Keep the pet recognizable.",
  "collage-mixed":
    "Transform this pet photo into a mixed media collage artwork. Layered textures, newspaper clippings, paint strokes, vintage ephemera. Keep the pet as the main subject.",
  "collage-papercut":
    "Transform this pet photo into layered paper cut art. Geometric paper silhouettes, shadow depth, elegant craft aesthetic. Keep the pet's silhouette and key features.",
  silhouette:
    "Transform this pet photo into a clean bold silhouette artwork. Solid black shape on white background, flat graphic design, minimal artistic print.",

  // ── 水彩画専用背景 ──────────────────────────────────────────
  "bg-wc-flower":
    "Place this pet in a soft dreamy watercolor flower field background. Pastel pink, lavender and yellow wildflowers, gentle bokeh. The background should look like a watercolor painting. Keep the pet as the main subject, natural and beautiful.",
  "bg-wc-sky":
    "Place this pet against a soft watercolor sky background. Gentle blue sky with fluffy white clouds, painted in loose watercolor style with visible brushstrokes and color bleeding. Keep the pet as the main subject.",
  "bg-wc-meadow":
    "Place this pet in a soft watercolor green meadow background. Gentle rolling hills, fresh spring grass, light airy atmosphere painted in watercolor style. Keep the pet as the main subject.",
  "bg-wc-water":
    "Place this pet at a serene riverside or lakeside watercolor background. Calm water with gentle reflections, willow trees, soft watercolor painting style. Keep the pet as the main subject.",
  "bg-wc-paper":
    "Place this pet on a beautiful Japanese washi paper texture background. Cream and warm beige tones, subtle fiber texture, delicate pressed flower motifs, minimalist and elegant. Keep the pet as the main subject.",

  // ── モノクロ鉛筆専用背景 ──────────────────────────────────────
  "bg-mn-library":
    "Place this pet in a vintage library or study room background. Dark wooden bookshelves filled with old books, warm desk lamp light, rendered in black and white charcoal sketch style. Keep the pet as the main subject.",
  "bg-mn-arch":
    "Place this pet against a classical stone architecture background. Ancient columns, arched doorways, monochrome marble texture, grand and timeless. Rendered in black and white. Keep the pet as the main subject.",
  "bg-mn-mist":
    "Place this pet in a misty forest background. Tall trees fading into morning fog, ethereal soft light filtering through branches. Monochrome, soft and atmospheric pencil style. Keep the pet as the main subject.",
  "bg-mn-paper":
    "Place this pet on a vintage aged paper texture background. Sepia toned, worn edges, old manuscript texture, antique and nostalgic. Pencil sketch aesthetic. Keep the pet as the main subject.",
  "bg-mn-city":
    "Place this pet against a nighttime city skyline background. Buildings with lit windows, urban architecture, rendered in dramatic black and white sketch style with high contrast. Keep the pet as the main subject.",

  // ── ライン画専用背景 ──────────────────────────────────────────
  "bg-ln-flat":
    "Place this pet on a flat solid pastel background. Clean single color — warm cream or soft sage green, completely flat with no texture. Modern minimalist design aesthetic. Keep the pet as the main subject with clean line art style.",
  "bg-ln-stars":
    "Place this pet against a dark navy blue night sky background filled with white stars, constellations and tiny sparkles. Clean and graphic, pop art inspired. Keep the pet as the main subject.",
  "bg-ln-botanical":
    "Place this pet with a botanical line illustration background. Elegant line drawings of tropical leaves, ferns and flowers in green and white. Flat illustration style. Keep the pet as the main subject.",
  "bg-ln-geo":
    "Place this pet against a geometric pattern background. Clean triangles, hexagons and polygons in pastel colors — mint, blush pink and cream. Modern graphic design aesthetic. Keep the pet as the main subject.",
  "bg-ln-grad":
    "Place this pet against a smooth pastel gradient background. Flowing from soft pink to lavender to pale blue, clean and dreamy. No texture, perfectly smooth gradient. Keep the pet as the main subject.",

  // ── レガシー汎用背景（後方互換）──────────────────────────────
  "bg-sea":
    "Place this pet on a beautiful ocean beach background with blue sky and gentle waves. Keep the pet as the main subject, clearly recognizable.",
  "bg-mtn":
    "Place this pet on a scenic mountain landscape background with blue sky. Keep the pet as the main subject.",
  "bg-forest":
    "Place this pet in a lush green forest background with trees and dappled light. Keep the pet as the main subject.",
  "bg-sunset":
    "Place this pet against a beautiful sunset sky background with warm orange and pink colors. Keep the pet as the main subject.",
  "bg-sakura":
    "Place this pet in a cherry blossom sakura scene with pink petals. Keep the pet as the main subject.",
  "bg-city":
    "Place this pet against a night city skyline background with lights. Keep the pet as the main subject.",
};

// ── LINEスタンプ用の表情プロンプト（mode: "stamp"）──────────────
const STAMP_PROMPTS = {
  happy:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet is smiling happily with sparkly eyes. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  sad: "Transform this pet photo into a cute cartoon sticker illustration. The pet has a sad droopy expression with teary eyes. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  angry:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet has a comically angry puffed-up expression. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  surprised:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet has wide surprised eyes and an open mouth. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  sleepy:
    "Transform this pet photo into a cute cartoon sticker illustration. The pet is sleepy with half-closed eyes and a peaceful expression. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  love: "Transform this pet photo into a cute cartoon sticker illustration. The pet has heart eyes showing love, with small hearts floating around. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
  wink: "Transform this pet photo into a cute cartoon sticker illustration. The pet is winking playfully with one eye closed. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.",
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

const DEFAULT_STAMP_PROMPT =
  "Transform this pet photo into a cute cartoon sticker illustration. White background, clean outlines, kawaii Japanese sticker style. Keep the pet's breed and features recognizable.";

const DEFAULT_PROMPT =
  "Transform this pet photo into a beautiful artistic illustration. High quality, detailed, keep the pet's face and features clearly recognizable.";

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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    return res.status(503).json({ error: "サービスを利用できません" });
  }

  let authUser;
  try {
    authUser = await verifyAuth(req);
  } catch (error) {
    console.error("[generate-art] auth error:", error);
    return res.status(401).json({ error: "認証が必要です" });
  }

  const db = getFirestore(getAdminApp());
  try {
    await consumeRateLimit(
      db,
      `generate_art_uid_${authUser.uid}`,
      RATE_LIMIT,
      RATE_WINDOW_MS,
    );
    await consumeRateLimit(
      db,
      `generate_art_ip_${getClientIp(req)}`,
      RATE_LIMIT,
      RATE_WINDOW_MS,
    );
  } catch (error) {
    console.error("[generate-art] rate limit error:", error);
    return res
      .status(429)
      .json({ error: "リクエストが多すぎます。時間をおいてお試しください" });
  }

  // ── GET: ポーリング ──────────────────────────────────────────
  if (req.method === "GET") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "不正なリクエストです" });

    try {
      const result = await pollPrediction({ token, id });
      return res.json(result);
    } catch (error) {
      console.error("[generate-art] poll error:", error);
      return res.status(502).json({ error: "生成結果を取得できませんでした" });
    }
  }

  // ── POST: 生成開始 ───────────────────────────────────────────
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: "invalid JSON" });
      }
    }

    const { photoDataUrl, styleId, customPrompt, mode, petCount } = body;

    // ── LINEスタンプモード ──────────────────────────────────
    if (mode === "stamp") {
      if (!photoDataUrl) {
        return res.status(400).json({ error: "不正なリクエストです" });
      }
      const { expression } = body;
      const stampPrompt = STAMP_PROMPTS[expression] || DEFAULT_STAMP_PROMPT;
      try {
        const { id } = await createPrediction({
          token,
          model: `${MODEL_OWNER}/${MODEL_NAME}`,
          input: {
            input_image: photoDataUrl,
            prompt: stampPrompt,
            aspect_ratio: "1:1",
            output_format: "png",
            safety_tolerance: 6,
          },
        });
        return res.json({ predictionId: id });
      } catch (error) {
        console.error("[generate-art/stamp] Replicate error:", error);
        return res.status(502).json({ error: "画像を生成できませんでした" });
      }
    }

    // ── メモリアル動画モード（Seedance 2.0）──────────────────
    if (mode === "memorial-video") {
      if (!photoDataUrl) {
        return res.status(400).json({ error: "写真が必要です" });
      }
      const MEMORIAL_VIDEO_PROMPTS = {
        "wag-tail":
          "The dog turns its head slightly, blinks its eyes gently, and wags its tail happily. Warm natural sunlight, gentle breeze ruffling its fur. The dog looks content and peaceful.",
        "look-around":
          "The dog looks around curiously, turning its head left and right, ears perking up. Natural outdoor setting with warm golden light.",
        run: "The dog starts running joyfully across the field, tongue out, ears flapping. Beautiful golden hour sunlight, soft bokeh background.",
        sleep:
          "The dog is sleeping peacefully, breathing softly, occasionally twitching its paws as if dreaming. Warm cozy atmosphere with soft light.",
        smile:
          "The dog looks directly at the camera with a happy smile, tongue slightly out, eyes sparkling. Warm natural light, shallow depth of field.",
      };
      const videoPrompt =
        body.videoPrompt ||
        MEMORIAL_VIDEO_PROMPTS[body.action] ||
        MEMORIAL_VIDEO_PROMPTS["wag-tail"];
      try {
        const { id } = await createPrediction({
          token,
          model: "bytedance/seedance-1-lite",
          input: {
            image: photoDataUrl,
            prompt: videoPrompt,
            duration: 5,
          },
        });
        // Firestoreに生成記録を保存
        const db = getFirestore(getAdminApp());
        await db.collection("memorial_generations").add({
          uid: authUser.uid,
          predictionId: id,
          action: body.action || "wag-tail",
          createdAt: new Date(),
        });
        return res.json({ predictionId: id });
      } catch (error) {
        console.error("[generate-art/memorial-video] Replicate error:", error);
        return res.status(502).json({ error: "動画を生成できませんでした" });
      }
    }

    // ── テキスト→画像モード（背景サンプル生成用）──────────────
    if (mode === "txt2img") {
      const txt2imgPrompts = {
        "wc-flower":
          "Soft dreamy watercolor painting of a flower field. Pastel pink, lavender, and yellow wildflowers. Watercolor brushstrokes, gentle bokeh. No people, no animals.",
        "wc-sky":
          "Soft watercolor painting of a blue sky with fluffy white clouds. Visible brushstrokes, light and airy. No people, no animals.",
        "wc-meadow":
          "Soft watercolor painting of a green meadow with rolling hills. Fresh spring grass, peaceful countryside. No people, no animals.",
        "wc-water":
          "Soft watercolor painting of a calm river or lakeside. Gentle water reflections, willow trees, serene. No people, no animals.",
        "wc-paper":
          "Beautiful Japanese washi paper texture. Warm cream and beige, subtle fiber texture, delicate pressed flower motifs. Flat lay, minimalist.",
        "mn-library":
          "Vintage library interior. Dark wooden bookshelves with old books, warm desk lamp. Black and white charcoal sketch style. No people.",
        "mn-arch":
          "Classical stone architecture with grand columns and arched doorways. Black and white pencil sketch, detailed. No people.",
        "mn-mist":
          "Misty forest with tall trees. Morning fog, ethereal light. Monochrome pencil sketch. No people, no animals.",
        "mn-paper":
          "Aged vintage parchment paper. Sepia toned, worn edges, old manuscript. Flat texture.",
        "mn-city":
          "Nighttime city skyline with glowing windows and bridges. Black and white charcoal sketch, high contrast. No people.",
        "ln-flat":
          "Flat solid warm cream background. Perfectly smooth, no texture. Minimalist design.",
        "ln-stars":
          "Dark navy blue night sky filled with white stars and constellations. Clean graphic illustration, flat design. No people.",
        "ln-botanical":
          "Botanical illustration of tropical leaves and flowers. Clean line drawings, green and white, flat style. No people.",
        "ln-geo":
          "Geometric pattern with triangles and hexagons. Pastel colors: mint, blush pink, cream. Modern flat graphic design.",
        "ln-grad":
          "Smooth pastel gradient from soft pink to lavender to pale blue. No texture, perfectly smooth. Clean and dreamy.",
      };
      const t2iPrompt = txt2imgPrompts[styleId] || styleId;
      try {
        const { id } = await createPrediction({
          token,
          model: "black-forest-labs/flux-1.1-pro",
          input: {
            prompt: t2iPrompt,
            aspect_ratio: "1:1",
            output_format: "jpg",
            safety_tolerance: 6,
          },
        });
        return res.json({ predictionId: id });
      } catch (error) {
        console.error("[generate-art] txt2img error:", error);
        return res.status(502).json({ error: "画像を生成できませんでした" });
      }
    }

    // ── 通常モード（img2img）──────────────────────────────────
    if (!photoDataUrl) {
      return res.status(400).json({ error: "不正なリクエストです" });
    }

    // 多頭対応: petCountに応じてプロンプトを調整
    const petCountNum = parseInt(petCount) || 1;
    const petCountNote =
      petCountNum >= 2
        ? ` There are ${petCountNum} pets in this photo — keep ALL of them clearly visible and recognizable in the artwork.`
        : "";

    const basePrompt = customPrompt
      ? `Place the pet(s) in a background of: ${customPrompt}. Keep all pets as the main subjects, clearly recognizable.`
      : STYLE_PROMPTS[styleId] || DEFAULT_PROMPT;

    // 向き・構図維持の共通指示を追加
    const orientationNote =
      " IMPORTANT: Maintain the exact same orientation, rotation and composition as the input photo. Do not rotate, flip or mirror the image. Keep the pet in the same position and angle.";

    const prompt = basePrompt + petCountNote + orientationNote;

    // Flux Kontext Pro — PNG出力（DTG印刷で白背景部分が透過扱いになる）
    // 注: 各スタイルプロンプトが背景を指定済み。白背景スタイル→DTGで自然に印刷。
    //     背景付きスタイル（油絵等）→アートパネルとして四角形で印刷される想定。
    try {
      const { id } = await createPrediction({
        token,
        model: `${MODEL_OWNER}/${MODEL_NAME}`,
        input: {
          input_image: photoDataUrl,
          prompt,
          aspect_ratio: "match_input_image",
          output_format: "png",
          safety_tolerance: 6,
        },
      });
      return res.json({ predictionId: id });
    } catch (error) {
      console.error("[generate-art] Replicate error:", error);
      return res.status(502).json({ error: "画像を生成できませんでした" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

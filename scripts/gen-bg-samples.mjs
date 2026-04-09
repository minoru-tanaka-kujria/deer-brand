/**
 * 背景サンプル画像生成スクリプト
 * shiba.jpg を入力に、各背景タイプのサンプルを生成して img/backgrounds/ に保存
 *
 * Usage: node scripts/gen-bg-samples.mjs
 *
 * 必須: deployed API が https://custom.deer.gift で動いていること
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const API_BASE = "https://custom.deer.gift";
const OUT_DIR = path.join(ROOT, "img", "backgrounds");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const BG_IDS = ["sea", "mtn", "forest", "sunset", "sakura", "city"];

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function toDataURL(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).replace(".", "");
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function urlToDataURL(url) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || "image/png";
  return `data:${ct};base64,${buf.toString("base64")}`;
}

async function poll(endpoint, id, maxPolls = 30) {
  for (let i = 0; i < maxPolls; i++) {
    await sleep(3000);
    const r = await fetch(`${API_BASE}${endpoint}?id=${id}`);
    const data = await r.json();
    console.log(`  polling [${i+1}/${maxPolls}] status=${data.status}`);
    if (data.status === "succeeded" && data.outputUrl) return data.outputUrl;
    if (data.status === "failed") throw new Error(`Prediction failed: ${data.error}`);
  }
  throw new Error("Polling timeout");
}

async function removeBg(photoDataUrl) {
  console.log("  → /api/remove-bg POST...");
  const res = await fetch(`${API_BASE}/api/remove-bg`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photoDataUrl }),
  });
  if (!res.ok) throw new Error(`remove-bg POST failed: ${res.status} ${await res.text()}`);
  const { predictionId, error } = await res.json();
  if (error || !predictionId) throw new Error(`no predictionId: ${error}`);
  console.log(`  → predictionId=${predictionId}, polling...`);
  return await poll("/api/remove-bg", predictionId, 20);
}

async function generateBg(photoDataUrl, styleId) {
  console.log(`  → /api/generate-art POST styleId=${styleId}...`);
  const res = await fetch(`${API_BASE}/api/generate-art`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photoDataUrl, styleId: `bg-${styleId}` }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`generate-art POST failed: ${res.status} ${txt}`);
  }
  const { predictionId, error } = await res.json();
  if (error || !predictionId) throw new Error(`no predictionId: ${error}`);
  console.log(`  → predictionId=${predictionId}, polling...`);
  return await poll("/api/generate-art", predictionId, 40);
}

async function downloadImage(url, outPath) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  console.log(`  ✓ saved ${outPath} (${buf.length} bytes)`);
}

async function main() {
  // 1. サンプル入力画像を読み込み
  const shibaSrc = path.join(ROOT, "img", "shiba.jpg");
  console.log("=== 1. 入力画像読み込み:", shibaSrc);
  const photoDataUrl = await toDataURL(shibaSrc);
  console.log("  OK, size:", Math.round(photoDataUrl.length / 1024), "KB");

  // 2. 背景除去（1回だけ）
  console.log("\n=== 2. 背景除去...");
  let noBgUrl;
  try {
    noBgUrl = await removeBg(photoDataUrl);
    console.log("  ✓ noBgUrl:", noBgUrl.substring(0, 80) + "...");
  } catch (e) {
    console.error("  ✗ rembg失敗:", e.message);
    console.log("  → rembgなしで元画像を使用");
    noBgUrl = null;
  }

  // data URL に変換
  let artInputDataUrl;
  if (noBgUrl && noBgUrl.startsWith("http")) {
    console.log("  → HTTPS URL → data URL 変換中...");
    artInputDataUrl = await urlToDataURL(noBgUrl);
    console.log("  ✓ data URL サイズ:", Math.round(artInputDataUrl.length / 1024), "KB");
  } else {
    artInputDataUrl = photoDataUrl;
  }

  // 3. 各背景を生成
  for (const bgId of BG_IDS) {
    const outPath = path.join(OUT_DIR, `bg-${bgId}.jpg`);
    if (fs.existsSync(outPath)) {
      console.log(`\n=== bg-${bgId}: スキップ（ファイル既存）`);
      continue;
    }

    console.log(`\n=== 3. bg-${bgId} 生成中...`);
    try {
      const resultUrl = await generateBg(artInputDataUrl, bgId);
      console.log("  ✓ 生成完了:", resultUrl.substring(0, 80) + "...");
      await downloadImage(resultUrl, outPath);
    } catch (e) {
      console.error(`  ✗ bg-${bgId} 失敗:`, e.message);
    }

    // API負荷軽減のため少し待つ
    await sleep(2000);
  }

  console.log("\n=== 完了! img/backgrounds/ を確認してください");
  console.log("生成ファイル:", fs.readdirSync(OUT_DIR).join(", "));
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});

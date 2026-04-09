/**
 * bg-sea と bg-city のみ再生成（レート制限リセット後）
 * リクエスト間に10秒のウェイトを入れる
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const API_BASE = "https://custom.deer.gift";
const OUT_DIR = path.join(ROOT, "img", "backgrounds");

const TARGETS = ["sea", "city"]; // 失敗したもの

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function toDataURL(filePath) {
  const buf = fs.readFileSync(filePath);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

async function urlToDataURL(url) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || "image/png";
  return `data:${ct};base64,${buf.toString("base64")}`;
}

async function poll(endpoint, id, maxPolls = 40) {
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

async function retryWithBackoff(fn, retries = 5, baseDelay = 15000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      const delay = baseDelay * (i + 1);
      console.log(`  → レート制限リトライ ${i+1}/${retries}, ${delay/1000}秒待機...`);
      await sleep(delay);
    }
  }
}

async function removeBg(photoDataUrl) {
  return retryWithBackoff(async () => {
    console.log("  → /api/remove-bg POST...");
    const res = await fetch(`${API_BASE}/api/remove-bg`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoDataUrl }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`remove-bg POST failed: ${res.status} ${txt}`);
    }
    const { predictionId, error } = await res.json();
    if (error || !predictionId) throw new Error(`no predictionId: ${error}`);
    console.log(`  → predictionId=${predictionId}, polling...`);
    return await poll("/api/remove-bg", predictionId, 20);
  });
}

async function generateBg(photoDataUrl, styleId) {
  return retryWithBackoff(async () => {
    console.log(`  → /api/generate-art POST styleId=bg-${styleId}...`);
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
  });
}

async function downloadImage(url, outPath) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  console.log(`  ✓ saved ${outPath} (${Math.round(buf.length/1024)}KB)`);
}

async function main() {
  const shibaSrc = path.join(ROOT, "img", "shiba.jpg");
  console.log("=== 入力画像読み込み:", shibaSrc);
  const photoDataUrl = await toDataURL(shibaSrc);
  console.log("  OK, size:", Math.round(photoDataUrl.length / 1024), "KB");

  // 背景除去
  console.log("\n=== 背景除去（リトライ付き）...");
  let artInputDataUrl = photoDataUrl;
  try {
    const noBgUrl = await removeBg(photoDataUrl);
    console.log("  ✓ noBgUrl取得");
    if (noBgUrl.startsWith("http")) {
      artInputDataUrl = await urlToDataURL(noBgUrl);
      console.log("  ✓ data URL変換完了:", Math.round(artInputDataUrl.length/1024), "KB");
    } else {
      artInputDataUrl = noBgUrl;
    }
  } catch (e) {
    console.log("  rembg失敗→元画像で継続:", e.message);
  }

  // 生成
  for (const bgId of TARGETS) {
    const outPath = path.join(OUT_DIR, `bg-${bgId}.jpg`);
    console.log(`\n=== bg-${bgId} 生成...`);
    try {
      const resultUrl = await generateBg(artInputDataUrl, bgId);
      console.log("  ✓ 生成完了");
      await downloadImage(resultUrl, outPath);
    } catch (e) {
      console.error(`  ✗ bg-${bgId} 失敗:`, e.message);
    }
    // リクエスト間12秒待機（6req/minリミット対策）
    if (TARGETS.indexOf(bgId) < TARGETS.length - 1) {
      console.log("  → 12秒待機（レート制限対策）...");
      await sleep(12000);
    }
  }

  console.log("\n=== 完了!");
  console.log("img/backgrounds/:", fs.readdirSync(OUT_DIR).join(", "));
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});

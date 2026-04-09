/**
 * スタイル専用背景サンプル生成スクリプト（15枚）
 * 水彩画 × 5 / モノクロ鉛筆 × 5 / ライン画 × 5
 *
 * Usage: node scripts/gen-bg-styled.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const API_BASE = "https://custom.deer.gift";
const OUT_DIR = path.join(ROOT, "img", "backgrounds");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// 各スタイルの入力サンプル（img/styles/ の既存画像を使う）
const STYLE_INPUTS = {
  watercolor: path.join(ROOT, "img", "styles", "wc-loose.png"),
  mono:       path.join(ROOT, "img", "styles", "mono-charcoal.png"),
  line:       path.join(ROOT, "img", "styles", "line-minimal.png"),
};

// 生成対象 15枚
const TARGETS = [
  // 水彩画専用
  { id: "wc-flower",  styleGroup: "watercolor", out: "bg-wc-flower.jpg" },
  { id: "wc-sky",     styleGroup: "watercolor", out: "bg-wc-sky.jpg" },
  { id: "wc-meadow",  styleGroup: "watercolor", out: "bg-wc-meadow.jpg" },
  { id: "wc-water",   styleGroup: "watercolor", out: "bg-wc-water.jpg" },
  { id: "wc-paper",   styleGroup: "watercolor", out: "bg-wc-paper.jpg" },
  // モノクロ鉛筆専用
  { id: "mn-library", styleGroup: "mono",       out: "bg-mn-library.jpg" },
  { id: "mn-arch",    styleGroup: "mono",       out: "bg-mn-arch.jpg" },
  { id: "mn-mist",    styleGroup: "mono",       out: "bg-mn-mist.jpg" },
  { id: "mn-paper",   styleGroup: "mono",       out: "bg-mn-paper.jpg" },
  { id: "mn-city",    styleGroup: "mono",       out: "bg-mn-city.jpg" },
  // ライン画専用
  { id: "ln-flat",    styleGroup: "line",       out: "bg-ln-flat.jpg" },
  { id: "ln-stars",   styleGroup: "line",       out: "bg-ln-stars.jpg" },
  { id: "ln-botanical",styleGroup:"line",       out: "bg-ln-botanical.jpg" },
  { id: "ln-geo",     styleGroup: "line",       out: "bg-ln-geo.jpg" },
  { id: "ln-grad",    styleGroup: "line",       out: "bg-ln-grad.jpg" },
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function poll(endpoint, id, maxPolls = 40) {
  for (let i = 0; i < maxPolls; i++) {
    await sleep(3000);
    const r = await fetch(`${API_BASE}${endpoint}?id=${id}`);
    const data = await r.json();
    process.stdout.write(`\r  ポーリング [${i+1}/${maxPolls}] status=${data.status}    `);
    if (data.status === "succeeded" && data.outputUrl) { console.log(""); return data.outputUrl; }
    if (data.status === "failed") throw new Error(`Prediction failed: ${data.error}`);
  }
  throw new Error("Polling timeout");
}

async function generateBg(photoDataUrl, bgId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      console.log(`  → レート制限リトライ ${attempt}/3, 15秒待機...`);
      await sleep(15000);
    }
    const res = await fetch(`${API_BASE}/api/generate-art`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoDataUrl, styleId: `bg-${bgId}` }),
    });
    if (res.ok) {
      const { predictionId, error } = await res.json();
      if (!error && predictionId) {
        console.log(`  → predictionId=${predictionId}`);
        return await poll("/api/generate-art", predictionId, 40);
      }
      throw new Error(`no predictionId: ${error}`);
    }
    const txt = await res.text();
    console.warn(`  → attempt ${attempt} failed: ${res.status}`, txt.substring(0, 120));
    if (attempt === 3) throw new Error("generation_failed after retries");
  }
}

async function downloadImage(url, outPath) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  console.log(`  ✓ 保存: ${path.basename(outPath)} (${Math.round(buf.length/1024)}KB)`);
}

async function main() {
  // 各スタイルグループの入力画像をdata URLに変換（キャッシュ）
  console.log("=== 入力サンプル画像読み込み...");
  const inputCache = {};
  for (const [group, filePath] of Object.entries(STYLE_INPUTS)) {
    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠ ${group}: ${filePath} が見つかりません → shiba.jpg を使用`);
      inputCache[group] = await toDataURL(path.join(ROOT, "img", "shiba.jpg"));
    } else {
      inputCache[group] = await toDataURL(filePath);
      console.log(`  ✓ ${group}: ${path.basename(filePath)} (${Math.round(inputCache[group].length/1024)}KB)`);
    }
  }

  // 生成
  let success = 0, skipped = 0, failed = 0;
  for (let i = 0; i < TARGETS.length; i++) {
    const t = TARGETS[i];
    const outPath = path.join(OUT_DIR, t.out);

    if (fs.existsSync(outPath)) {
      console.log(`\n[${i+1}/${TARGETS.length}] ${t.out}: スキップ（既存）`);
      skipped++;
      continue;
    }

    console.log(`\n[${i+1}/${TARGETS.length}] bg-${t.id} 生成中 (${t.styleGroup})...`);
    try {
      const inputDataUrl = inputCache[t.styleGroup];
      const resultUrl = await generateBg(inputDataUrl, t.id);
      await downloadImage(resultUrl, outPath);
      success++;
    } catch(e) {
      console.error(`  ✗ 失敗:`, e.message);
      failed++;
    }

    // リクエスト間に12秒待機（レート制限対策）
    if (i < TARGETS.length - 1) {
      process.stdout.write("  → 12秒待機...");
      await sleep(12000);
      console.log("OK");
    }
  }

  console.log(`\n=== 完了! 成功:${success} スキップ:${skipped} 失敗:${failed}`);
  console.log("img/backgrounds/:", fs.readdirSync(OUT_DIR).sort().join(", "));
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });

/**
 * 背景サンプル画像をテキスト→画像で再生成（ペットなし・背景のみ）
 * 既存ファイルは上書き
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const API_BASE = "https://custom.deer.gift";
const OUT_DIR = path.join(ROOT, "img", "backgrounds");

const TARGETS = [
  "wc-flower", "wc-sky", "wc-meadow", "wc-water", "wc-paper",
  "mn-library", "mn-arch", "mn-mist", "mn-paper", "mn-city",
  "ln-flat", "ln-stars", "ln-botanical", "ln-geo", "ln-grad",
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function poll(id, maxPolls = 40) {
  for (let i = 0; i < maxPolls; i++) {
    await sleep(3000);
    const r = await fetch(`${API_BASE}/api/txt2img?id=${id}`);
    const data = await r.json();
    process.stdout.write(`\r  [${i+1}/${maxPolls}] ${data.status}    `);
    if (data.status === "succeeded" && data.outputUrl) { console.log(""); return data.outputUrl; }
    if (data.status === "failed") throw new Error(`Failed: ${data.error}`);
  }
  throw new Error("Timeout");
}

async function generate(bgId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      console.log(`  リトライ ${attempt}/3, 15秒待機...`);
      await sleep(15000);
    }
    const res = await fetch(`${API_BASE}/api/generate-art`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ styleId: bgId, mode: "txt2img" }),
    });
    if (res.ok) {
      const { predictionId, error } = await res.json();
      if (!error && predictionId) {
        console.log(`  → predictionId=${predictionId}`);
        return await poll(predictionId, 40);
      }
      throw new Error(`no predictionId: ${error}`);
    }
    const txt = await res.text();
    console.warn(`  → attempt ${attempt}: ${res.status}`, txt.substring(0, 100));
    if (attempt === 3) throw new Error("failed after retries");
  }
}

async function main() {
  let success = 0, failed = 0;
  for (let i = 0; i < TARGETS.length; i++) {
    const bgId = TARGETS[i];
    const outPath = path.join(OUT_DIR, `bg-${bgId}.jpg`);
    console.log(`\n[${i+1}/${TARGETS.length}] ${bgId}...`);
    try {
      const url = await generate(bgId);
      const buf = Buffer.from(await fetch(url).then(r => r.arrayBuffer()));
      fs.writeFileSync(outPath, buf);
      console.log(`  ✓ 保存: ${Math.round(buf.length/1024)}KB`);
      success++;
    } catch(e) {
      console.error(`  ✗ 失敗:`, e.message);
      failed++;
    }
    if (i < TARGETS.length - 1) {
      process.stdout.write("  12秒待機...");
      await sleep(12000);
      console.log("OK");
    }
  }
  console.log(`\n=== 完了 成功:${success} 失敗:${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });

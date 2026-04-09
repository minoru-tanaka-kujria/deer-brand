/**
 * 生成済みのpredictionIDから直接画像をダウンロード
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "img", "backgrounds");
const API_BASE = "https://custom.deer.gift";

const PREDICTIONS = [
  { id: "ct32zj94fhrmt0cxa7a9vaxmm8", name: "bg-wc-flower.jpg" },
  { id: "hjmyn7k2cnrmw0cxa7a9pebvn0", name: "bg-wc-sky.jpg" },
  { id: "bxf9ra4ze9rmr0cxa7aacwym7c", name: "bg-wc-meadow.jpg" },
  { id: "2c9a0rpw5hrmt0cxa7aby1fthc", name: "bg-wc-water.jpg" },
  { id: "s4jwwe0rs5rmw0cxa7arwabcnm", name: "bg-wc-paper.jpg" },
  { id: "shyk3m2mvnrmw0cxa7as19mb5w", name: "bg-mn-library.jpg" },
  { id: "r0ffs84h2srmw0cxa7arxztkqw", name: "bg-mn-arch.jpg" },
  { id: "n9cnnxycyhrmt0cxa7at8tw3sw", name: "bg-mn-mist.jpg" },
  { id: "rsykcm09enrmr0cxa7bbqdb4sc", name: "bg-mn-paper.jpg" },
  { id: "gkeaaat571rmy0cxa7b9yay6d4", name: "bg-mn-city.jpg" },
  { id: "dqwqx4m169rmy0cxa7bakkmmaw", name: "bg-ln-flat.jpg" },
  { id: "2v75wk5x9drmr0cxa7ba74gh38", name: "bg-ln-stars.jpg" },
  { id: "jyd2pkfs1srmy0cxa7b9m5tr6g", name: "bg-ln-botanical.jpg" },
  { id: "4pdrdssmsnrmy0cxa7bstx82k0", name: "bg-ln-geo.jpg" },
  { id: "fqvzbcvjcxrmw0cxa7bt8zkz7c", name: "bg-ln-grad.jpg" },
];

async function main() {
  let ok = 0, fail = 0;
  for (const { id, name } of PREDICTIONS) {
    const outPath = path.join(OUT_DIR, name);
    process.stdout.write(`${name}: polling... `);
    try {
      // GETポーリング（最大10回）
      let outputUrl = null;
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${API_BASE}/api/generate-art?id=${id}`);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch {
          console.log(`\n  GET returned non-JSON (${res.status}): ${text.substring(0, 80)}`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        if (data.status === "succeeded" && data.outputUrl) {
          outputUrl = data.outputUrl;
          break;
        }
        if (data.status === "failed") { console.log(`FAILED: ${data.error}`); break; }
        process.stdout.write(`${data.status}... `);
        await new Promise(r => setTimeout(r, 3000));
      }

      if (outputUrl) {
        const imgBuf = Buffer.from(await fetch(outputUrl).then(r => r.arrayBuffer()));
        fs.writeFileSync(outPath, imgBuf);
        console.log(`✓ ${Math.round(imgBuf.length/1024)}KB`);
        ok++;
      } else {
        console.log("❌ outputUrl取得失敗");
        fail++;
      }
    } catch(e) {
      console.log(`ERROR: ${e.message}`);
      fail++;
    }
  }
  console.log(`\n完了: 成功=${ok} 失敗=${fail}`);
  console.log("files:", fs.readdirSync(OUT_DIR).filter(f=>f.startsWith("bg-wc")||f.startsWith("bg-mn")||f.startsWith("bg-ln")).sort().join(", "));
}

main();

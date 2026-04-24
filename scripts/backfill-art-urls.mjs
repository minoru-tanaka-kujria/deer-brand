#!/usr/bin/env node
/**
 * 古い注文の artImageUrl が短命な Replicate URL のままになっているものを、
 * Firebase Storage に永続化して安定 URL に張り替えるバックフィルスクリプト。
 *
 * 使い方:
 *   # 1) Vercel 本番 env をローカルに pull (一時的)
 *   cd /Users/openclawmacmini20260302/Deer
 *   vercel env pull .env.deploy.local --environment=production --yes
 *
 *   # 2) DRY-RUN (デフォルト) で対象件数と内訳だけ確認
 *   node scripts/backfill-art-urls.mjs
 *
 *   # 3) 本実行
 *   APPLY=1 node scripts/backfill-art-urls.mjs
 *
 *   # 4) 後始末
 *   rm /Users/openclawmacmini20260302/Deer/.env.deploy.local
 *
 * 環境変数:
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY        - "\n" エスケープ可
 *   FIREBASE_STORAGE_BUCKET     - 省略時は <project>.firebasestorage.app
 *   APPLY=1                     - 実行モード（指定なしは DRY-RUN）
 *   LIMIT=100                   - 1回で処理する最大件数（デフォ全件）
 *
 * 動作:
 *   1. Firestore "orders" を全件スキャン
 *   2. artImageUrl が SHORT_LIVED_HOSTS 配下のものを抽出
 *   3. APPLY=1 のとき:
 *        - uploadRemoteUrlToStorage で Storage にコピー
 *        - 成功: orders.{artImageUrl, artImageUrlOriginal, backfilledAt} を更新
 *        - 失敗 (404 等): orders.{backfillFailed=true, backfillError, backfilledAt} を更新
 *   4. 完了時に成功/失敗/スキップ件数を表示
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const SHORT_LIVED_HOSTS = new Set([
  "replicate.delivery",
  "pbxt.replicate.delivery",
  "tjzk.replicate.delivery",
]);
const APPLY = process.env.APPLY === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;

// ── env 読み込み (.env.deploy.local) ─────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "..", ".env.deploy.local");
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
} else {
  console.error(
    `[backfill] .env.deploy.local が見つかりません: ${envPath}\n` +
      `先に: cd /Users/openclawmacmini20260302/Deer && vercel env pull .env.deploy.local --environment=production --yes`,
  );
  process.exit(1);
}

// ── Firebase Admin 初期化 ────────────────────────────────────────────
function getAdminApp() {
  if (getApps().length) return getApps()[0];
  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET ||
      `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`,
  });
}

// art-upload.js のロジックを CLI 用に簡易再実装 (ESM の動的 import が
// firebase-admin の二重初期化を起こすため、ここに inline で書く)
async function uploadRemoteUrlToStorage(srcUrl, { uid, orderId }) {
  if (typeof srcUrl !== "string" || !srcUrl.startsWith("https://")) {
    throw new Error("INVALID_SRC_URL");
  }
  const resp = await fetch(srcUrl);
  if (!resp.ok) {
    throw new Error(`REMOTE_FETCH_FAILED:${resp.status}`);
  }
  const contentType = resp.headers.get("content-type") || "image/png";
  if (!contentType.startsWith("image/")) {
    throw new Error(`REMOTE_FETCH_NON_IMAGE:${contentType}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (!buffer.length) throw new Error("REMOTE_FETCH_EMPTY");

  const ext = contentType === "image/jpeg" ? "jpg" : "png";
  const id = orderId || String(Date.now());
  const objectName = `art-composites/${uid || "anon"}/${id}-backfill.${ext}`;
  const bucket = getStorage(getAdminApp()).bucket();
  const file = bucket.file(objectName);
  await file.save(buffer, {
    contentType,
    resumable: false,
    metadata: { cacheControl: "public, max-age=31536000" },
  });
  let madePublic = false;
  try {
    await file.makePublic();
    madePublic = true;
  } catch (_) {}
  if (madePublic) {
    return `https://storage.googleapis.com/${bucket.name}/${encodeURI(objectName)}`;
  }
  const [signedUrl] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
  });
  return signedUrl;
}

// ── メイン ───────────────────────────────────────────────────────────
async function main() {
  console.log(`[backfill] mode=${APPLY ? "APPLY" : "DRY-RUN"} limit=${LIMIT}`);
  const db = getFirestore(getAdminApp());

  // orders を全件取得 (注文数は通常 数百〜数千 想定なので1回で取れる)
  const snap = await db.collection("orders").orderBy("createdAt", "desc").get();
  console.log(`[backfill] orders total: ${snap.size}`);

  const targets = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const url = data.artImageUrl;
    if (typeof url !== "string" || !url.startsWith("https://")) continue;
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      continue;
    }
    if (!SHORT_LIVED_HOSTS.has(host)) continue;
    if (data.backfilledAt) continue; // 既に処理済みはスキップ
    targets.push({ id: doc.id, url, host, uid: data.uid, data });
  }
  console.log(
    `[backfill] short-lived URL targets: ${targets.length} (内訳: ${countByHost(targets)})`,
  );

  if (!APPLY) {
    console.log(`[backfill] DRY-RUN のため終了。実行するには APPLY=1 を付与`);
    if (targets.length > 0) {
      console.log(
        `[backfill] 先頭 5 件のサンプル:`,
        targets.slice(0, 5).map((t) => ({
          id: t.id,
          host: t.host,
          uid: t.uid || "(no uid)",
        })),
      );
    }
    return;
  }

  const todo = targets.slice(0, LIMIT);
  let ok = 0;
  let fetchFailed = 0;
  let otherFailed = 0;
  for (let i = 0; i < todo.length; i++) {
    const t = todo[i];
    process.stdout.write(
      `[${i + 1}/${todo.length}] ${t.id} (host=${t.host}) ... `,
    );
    try {
      const newUrl = await uploadRemoteUrlToStorage(t.url, {
        uid: t.uid,
        orderId: t.id,
      });
      await db.collection("orders").doc(t.id).update({
        artImageUrl: newUrl,
        artImageUrlOriginal: t.url,
        backfilledAt: FieldValue.serverTimestamp(),
      });
      console.log(`OK -> ${truncate(newUrl, 60)}`);
      ok++;
    } catch (e) {
      const msg = e?.message || String(e);
      const isFetchFail = msg.startsWith("REMOTE_FETCH_FAILED");
      try {
        await db.collection("orders").doc(t.id).update({
          backfillFailed: true,
          backfillError: msg.slice(0, 200),
          backfilledAt: FieldValue.serverTimestamp(),
        });
      } catch (_) {}
      console.log(`FAIL: ${msg}`);
      if (isFetchFail) fetchFailed++;
      else otherFailed++;
    }
  }

  console.log(
    `[backfill] done. ok=${ok} fetchFailed=${fetchFailed} otherFailed=${otherFailed}`,
  );
}

function countByHost(targets) {
  const m = new Map();
  for (const t of targets) m.set(t.host, (m.get(t.host) || 0) + 1);
  return [...m.entries()].map(([h, n]) => `${h}=${n}`).join(", ") || "(none)";
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

main().catch((e) => {
  console.error("[backfill] fatal:", e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * 本番 Firestore の errorReports コレクションから最新レポートを取得して
 * コンソールに表示する。
 *
 * 使い方:
 *   node --env-file=.env.local scripts/fetch-error-reports.mjs [limit]
 */

import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Vercel で production 環境の値を取り出したい場合は vercel env pull --environment=production
if (!process.env.FIREBASE_PROJECT_ID) {
  // .env.local から簡易ロード（dotenv なしで対応）
  try {
    const env = readFileSync(".env.local", "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(?:"(.*)"|(.*))$/);
      if (m) {
        const [, k, v1, v2] = m;
        if (!process.env[k]) process.env[k] = (v1 ?? v2 ?? "").replace(/\\n/g, "\n");
      }
    }
  } catch {}
}

const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
  console.error("❌ Firebase env vars 不足");
  console.error("  PROJECT_ID:", !!process.env.FIREBASE_PROJECT_ID);
  console.error("  CLIENT_EMAIL:", !!process.env.FIREBASE_CLIENT_EMAIL);
  console.error("  PRIVATE_KEY:", !!privateKey);
  process.exit(1);
}

initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  }),
});

const db = getFirestore();
const limit = Math.max(1, Math.min(500, Number(process.argv[2]) || 30));

console.log(`📡 errorReports 最新 ${limit} 件を取得...\n`);

const snap = await db
  .collection("errorReports")
  .orderBy("reportedAt", "desc")
  .limit(limit)
  .get();

if (snap.empty) {
  console.log("(レポート 0 件)");
  process.exit(0);
}

for (const doc of snap.docs) {
  const d = doc.data();
  const at = d.reportedAt?.toDate?.()?.toISOString() ?? d.reportedAt ?? "?";
  const ua = d.userAgent ? d.userAgent.slice(0, 80) : "?";
  const ref = d.referer ?? "?";
  console.log("─".repeat(100));
  console.log(`🕒 ${at}`);
  console.log(`📍 ${ref}`);
  console.log(`🔧 ${ua}`);
  console.log(`📦 ${d.count ?? 0} 件のエラー`);
  const errors = Array.isArray(d.errors) ? d.errors : [];
  for (const e of errors) {
    const typ = e.type || "?";
    const tag = e.tag ? `[${e.tag}]` : "";
    const msg = (e.message || JSON.stringify(e.details || "")).slice(0, 400);
    console.log(`   • ${typ}${tag}: ${msg}`);
    if (e.stack) {
      const firstLines = String(e.stack).split("\n").slice(0, 3).join("\n     ");
      console.log(`     stack: ${firstLines}`);
    }
    if (e.ctx) {
      const ctxStr = JSON.stringify(e.ctx).slice(0, 200);
      console.log(`     ctx:   ${ctxStr}`);
    }
    if (e.violatedDirective || e.blockedURI) {
      console.log(`     CSP:   ${e.violatedDirective} blocked ${e.blockedURI}`);
    }
  }
  console.log("");
}

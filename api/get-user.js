/**
 * Vercel Serverless Function
 * GET /api/get-user?uid=xxx
 * Authorization: Bearer <Firebase IDトークン>
 * Response: { user: {...}, paymentMethods: [...] }
 *
 * - Firebase Admin IDトークン検証
 * - Firestoreからユーザーデータ取得
 * - Stripe APIでsavedPaymentMethods取得
 */

import crypto from "node:crypto";
import Stripe from "stripe";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getAdminApp } from "./_lib/auth.js";
import { setCorsHeaders, handlePreflight } from "./_lib/cors.js";
import { notifyError } from "./_lib/error-notifier.js";

// モジュールスコープでキャッシュ
const _stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY.trim(), {
      apiVersion: "2024-04-10",
    })
  : null;

export default async function handler(req, res) {
  setCorsHeaders(req, res, "GET, POST, OPTIONS");
  if (handlePreflight(req, res)) return;

  // ── POST /api/get-user?type=delete-account ───────────────────────────
  // 退会フロー: Firebase Auth アカウント削除 + Firestore のユーザーデータを削除。
  // 注文履歴は法的保管義務があるため残すが、個人情報 (shippingAddress / email)
  // は匿名化する。クライアントが confirm="DELETE" を送った時だけ実行。
  if (req.method === "POST" && req.query.type === "delete-account") {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    if (body?.confirm !== "DELETE") {
      return res.status(400).json({ error: "CONFIRM_REQUIRED" });
    }
    const authHeader = req.headers.authorization ?? "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    if (!idToken) {
      return res.status(401).json({ error: "認証が必要です" });
    }
    try {
      const app = getAdminApp();
      const auth = getAuth(app);
      const db = getFirestore(app);
      let decoded;
      try {
        decoded = await auth.verifyIdToken(idToken);
      } catch {
        return res.status(401).json({ error: "認証トークンが無効です" });
      }
      const uid = decoded.uid;

      // 1. ユーザー注文の個人情報を匿名化 (注文自体は法的義務で保持)
      const ordersSnap = await db
        .collection("orders")
        .where("uid", "==", uid)
        .get();
      const batch = db.batch();
      for (const doc of ordersSnap.docs) {
        batch.update(doc.ref, {
          email: "[deleted]",
          shippingAddress: null,
          ordererInfo: null,
          petNames: [],
          anonymizedAt: new Date(),
          deletedByUser: true,
        });
      }

      // 2. users/{uid} ドキュメントを削除 (Admin SDK は rules をバイパス)
      batch.delete(db.collection("users").doc(uid));
      await batch.commit();

      // 3. 関連コレクションの孤児データ削除 (アート履歴等)
      try {
        const artsSnap = await db
          .collection("users")
          .doc(uid)
          .collection("arts")
          .get();
        const artsBatch = db.batch();
        artsSnap.docs.forEach((d) => artsBatch.delete(d.ref));
        await artsBatch.commit();
      } catch (e) {
        console.warn("[delete-account] arts cleanup failed:", e.message);
      }

      // 4. Firebase Auth アカウント削除 (最後に実行)
      await auth.deleteUser(uid);

      return res.status(200).json({
        ok: true,
        anonymizedOrders: ordersSnap.size,
      });
    } catch (err) {
      console.error("[delete-account] error:", err);
      return res.status(500).json({ error: "退会処理に失敗しました" });
    }
  }

  // ── POST /api/get-user?type=error-report ─────────────────────────────
  // ユーザー実機エラーの集約受信。Hobby plan の Function 上限(12)に達しているため
  // 専用 endpoint を作らず get-user に相乗りする。
  if (req.method === "POST" && req.query.type === "error-report") {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    if (errors.length === 0) {
      return res.status(400).json({ error: "errors 配列が必要です" });
    }
    // サイズ制限・サニタイズ（最大50件、各 message は 4KB まで）
    const sanitized = errors.slice(0, 50).map((e) => ({
      t: typeof e?.t === "number" ? e.t : Date.now(),
      type: typeof e?.type === "string" ? e.type.slice(0, 40) : "error",
      message: typeof e?.message === "string" ? e.message.slice(0, 4000) : "",
      source: typeof e?.source === "string" ? e.source.slice(0, 500) : null,
      line: typeof e?.line === "number" ? e.line : null,
      col: typeof e?.col === "number" ? e.col : null,
      stack: typeof e?.stack === "string" ? e.stack.slice(0, 4000) : null,
      violatedDirective:
        typeof e?.violatedDirective === "string"
          ? e.violatedDirective.slice(0, 200)
          : null,
      blockedURI:
        typeof e?.blockedURI === "string" ? e.blockedURI.slice(0, 500) : null,
      ctx: e?.ctx || null,
    }));
    try {
      const db = getFirestore(getAdminApp());
      await db.collection("errorReports").add({
        reportedAt: new Date(),
        ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null,
        userAgent: req.headers["user-agent"]?.slice(0, 500) || null,
        referer: req.headers.referer?.slice(0, 500) || null,
        errors: sanitized,
        count: sanitized.length,
      });
      // 本当のエラー (runtime error / unhandled rejection / CSP違反) だけ
      // Slack に即時通知する。console.log/info の単なるトレースは無視。
      try {
        const critical = sanitized.filter((e) =>
          ["error", "rejection", "csp"].includes(e.type),
        );
        if (critical.length > 0) {
          const { notifySlack } = await import("./slack-notify.js");
          const first = critical[0];
          await notifySlack({
            level: "error",
            title: `実機エラー発生 (${critical.length}件)`,
            text: `${first.type}: ${first.message || first.violatedDirective || "(no message)"}`,
            context: {
              path: req.headers.referer || "unknown",
              userAgent: (req.headers["user-agent"] || "").slice(0, 120),
              stepOrUid:
                first.ctx?.current_step || first.ctx?.user_uid || "anon",
            },
            dedupeKey: `client-error:${(first.message || first.violatedDirective || "").slice(0, 80)}`,
          });
        }
      } catch (notifyErr) {
        console.warn(
          "[error-report] slack notify failed:",
          notifyErr?.message || notifyErr,
        );
      }
      return res.json({ ok: true, stored: sanitized.length });
    } catch (err) {
      console.error("[error-report] Firestore write failed:", err.message);
      // クライアントに詳細は返さない（PII漏洩防止）
      return res.status(500).json({ error: "failed to store" });
    }
  }

  // ── POST /api/get-user?type=test-error-notify ────────────────────────
  // 管理者専用: error-notifier.js の動作確認用。adminKey 認証で notifyError() を発火。
  if (req.method === "POST" && req.query.type === "test-error-notify") {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    const adminKey = String(body?.adminKey || "").trim();
    const expected = String(process.env.ADMIN_SECRET_KEY || "").trim();
    const a = Buffer.from(adminKey);
    const b = Buffer.from(expected);
    const ok =
      expected.length > 0 &&
      a.length === b.length &&
      crypto.timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: "UNAUTHORIZED" });

    const msg =
      String(body?.message || "").trim() ||
      `テスト通知 ${new Date().toISOString()} — error-notifier 動作確認`;
    const fakeErr = new Error(msg);
    fakeErr.stack = `TestError: ${msg}\n    at get-user (test-error-notify)\n    at admin request`;
    const result = await notifyError({
      err: fakeErr,
      route: "POST /api/get-user?type=test-error-notify (manual)",
      context: {
        triggeredBy: "test-error-notify",
        timestamp: new Date().toISOString(),
      },
    });
    return res.status(200).json({ ok: true, result });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { uid, type } = req.query;

  // ── GET /api/get-user?type=fix-dispatch&id=...&sig=... ──────────────
  // エラー通知メール内「Claudeに自動修正させる」ボタンの遷移先。
  // HMAC 検証 → Firestore からエラー詳細取得 → Slack に bot メンション付き投稿
  // → Mac mini 常駐ボットが app_mention 受信 → Claude が自動修正 PR 作成。
  if (type === "fix-dispatch") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const id = String(req.query?.id || "").trim();
    const sig = String(req.query?.sig || "").trim();
    const fixSecret = process.env.FIX_DISPATCH_SECRET;
    const verifySig = () => {
      if (!fixSecret || !sig || !id) return false;
      const expected = crypto
        .createHmac("sha256", fixSecret)
        .update(id)
        .digest("hex")
        .slice(0, 32);
      try {
        const a = Buffer.from(expected);
        const b = Buffer.from(sig);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
      } catch {
        return false;
      }
    };
    const htmlPage = ({ title, body, color = "#1a3a52" }) =>
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
      <meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;color:#222;max-width:560px;margin:48px auto;padding:24px;text-align:center">
      <h1 style="color:${color};margin:0 0 16px;font-size:22px">${title}</h1>
      <div style="font-size:14px;line-height:1.7;color:#444">${body}</div>
      </body></html>`;

    if (!verifySig()) {
      return res.status(403).send(
        htmlPage({
          title: "🚫 認証エラー",
          body: "リンクが改ざんされているか、期限切れです。",
          color: "#c0392b",
        }),
      );
    }
    let report;
    try {
      const db = getFirestore(getAdminApp());
      const snap = await db.collection("apiErrorReports").doc(id).get();
      if (!snap.exists) {
        return res.status(404).send(
          htmlPage({
            title: "エラー記録が見つかりません",
            body: "古い通知メールの可能性があります。",
            color: "#c0392b",
          }),
        );
      }
      report = snap.data();
      if (report.status === "dispatched") {
        return res.status(200).send(
          htmlPage({
            title: "✅ 既に修正依頼済み",
            body: `このエラーは既にClaudeに依頼済みです。<br><br>Slack「deerペットフード鹿」チャンネルで進捗を確認してください。<br><br><small style="color:#999">エラーID: ${id}</small>`,
          }),
        );
      }
    } catch (e) {
      return res.status(500).send(
        htmlPage({
          title: "サーバーエラー",
          body: `Firestoreアクセス失敗: ${e?.message || ""}`,
          color: "#c0392b",
        }),
      );
    }

    const botToken = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_DISPATCH_CHANNEL;
    if (!botToken || !channel) {
      return res.status(500).send(
        htmlPage({
          title: "Slack設定が未完了",
          body: "SLACK_BOT_TOKEN または SLACK_DISPATCH_CHANNEL が未設定です。<br>Vercel env を確認してください。",
          color: "#c0392b",
        }),
      );
    }
    const botUserId = process.env.SLACK_BOT_USER_ID;
    const mention = botUserId ? `<@${botUserId}>` : "@Claude Code Notify";
    const ctxLines = report.context
      ? Object.entries(report.context)
          .map(
            ([k, v]) =>
              `• *${k}*: ${typeof v === "string" ? v : JSON.stringify(v)}`,
          )
          .join("\n")
      : "";
    const stackTrim = String(report.stack || "").slice(0, 1500);
    const slackText = [
      `${mention} 以下のDeer本番エラーを修正してください。`,
      "",
      `*エンドポイント*: \`${report.route || "?"}\``,
      `*メッセージ*: ${report.message}`,
      ctxLines ? `\n*Context*:\n${ctxLines}` : "",
      stackTrim ? `\n*Stack*:\n\`\`\`${stackTrim}\`\`\`` : "",
      "",
      `_エラーID: ${id} / 発生: ${report.createdAt}_`,
      "",
      "原因を特定し、修正PRをmainブランチに対して作成してください。",
      "テストが通ったら自動でpushして構いません。",
    ]
      .filter(Boolean)
      .join("\n");

    let slackResp;
    try {
      const r = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel,
          text: slackText,
          unfurl_links: false,
          unfurl_media: false,
        }),
      });
      slackResp = await r.json();
      if (!slackResp.ok) {
        return res.status(502).send(
          htmlPage({
            title: "Slack投稿失敗",
            body: `理由: <code>${slackResp.error || "unknown"}</code>`,
            color: "#c0392b",
          }),
        );
      }
    } catch (e) {
      return res.status(502).send(
        htmlPage({
          title: "Slack接続失敗",
          body: e?.message || "",
          color: "#c0392b",
        }),
      );
    }
    try {
      const db = getFirestore(getAdminApp());
      await db
        .collection("apiErrorReports")
        .doc(id)
        .update({
          status: "dispatched",
          dispatchedAt: new Date().toISOString(),
          slackTs: slackResp.ts || null,
          slackChannel: slackResp.channel || channel,
        });
    } catch (e) {
      console.warn("[fix-dispatch] status update failed:", e?.message);
    }
    return res.status(200).send(
      htmlPage({
        title: "✅ 修正依頼を送信しました",
        body: `Mac mini上のClaudeが原因調査と修正PR作成を開始します。<br><br>進捗はSlack「deerペットフード鹿」チャンネルで確認できます。<br><br>修正PR完成後は別途メールでお知らせします。<br><br><small style="color:#999">エラーID: ${id}</small>`,
      }),
    );
  }

  // /api/config の代替: ?type=config で公開設定を返す（認証不要）
  if (type === "config") {
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).json({
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
      sentryDsn: process.env.SENTRY_DSN || null,
    });
  }

  // /api/health 代替: 外部監視サービス (UptimeRobot 等) から叩いて疎通確認。
  // env 有無 / 主要サービス接続チェックだけで secret は返さない。
  if (type === "health") {
    res.setHeader("Cache-Control", "no-store");
    const checks = {
      stripe: !!process.env.STRIPE_SECRET_KEY,
      firebase:
        !!process.env.FIREBASE_ADMIN_KEY || !!process.env.FIREBASE_PROJECT_ID,
      replicate: !!process.env.REPLICATE_API_TOKEN,
      printful: !!process.env.PRINTFUL_API_KEY,
      printful_webhook_secret: !!process.env.PRINTFUL_WEBHOOK_SECRET,
      stripe_webhook_secret: !!process.env.STRIPE_WEBHOOK_SECRET,
      resend: !!process.env.RESEND_API_KEY || !!process.env.SENDGRID_API_KEY,
    };
    const missing = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);
    const ok = missing.length === 0;
    return res.status(ok ? 200 : 503).json({
      ok,
      checks,
      missing,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
      deployedAt: process.env.VERCEL_DEPLOY_TIME || null,
    });
  }

  // ?type=reviews でFirestoreの承認済みレビューを返す（認証不要）
  if (type === "reviews") {
    try {
      const db = getFirestore(getAdminApp());
      const snap = await db
        .collection("reviews")
        .where("approved", "==", true)
        .orderBy("createdAt", "desc")
        .limit(10)
        .get();
      const reviews = snap.docs.map((d) => {
        const data = d.data();
        return {
          rating: data.rating,
          comment: data.comment,
          petName: data.petName,
        };
      });
      return res.status(200).json({ reviews });
    } catch (e) {
      return res.status(200).json({ reviews: [] });
    }
  }

  // ?type=share で動的OGPページを返す（認証不要）
  // 例: /api/get-user?type=share&art=https://...&name=ポチ
  if (type === "share") {
    const ALLOWED_SHARE_HOSTS = new Set([
      "custom.deer.gift",
      "deer.gift",
      "firebasestorage.googleapis.com",
      "storage.googleapis.com",
      "replicate.delivery",
      "pbxt.replicate.delivery",
      "tjzk.replicate.delivery",
    ]);
    const rawArt = req.query.art;
    const defaultArt = "https://custom.deer.gift/img/hero-dog.jpg";
    let artUrl = defaultArt;
    if (rawArt && typeof rawArt === "string") {
      try {
        const u = new URL(rawArt);
        if (u.protocol === "https:" && ALLOWED_SHARE_HOSTS.has(u.hostname)) {
          artUrl = rawArt;
        }
      } catch (_) {
        // 不正な URL はデフォルトにフォールバック
      }
    }
    // 長すぎるペット名はフィッシング OGP 用の攻撃面になるため 30 文字に制限
    const rawName = typeof req.query.name === "string" ? req.query.name : "";
    const petName = rawName.replace(/[<>"'&]/g, "").slice(0, 30) || "愛犬";
    const title = `${petName}のオリジナルアート｜Deer Brand`;
    const desc = `${petName}の写真からAIが生成したアート。あなたも愛犬・愛猫のオリジナルグッズを作りませんか？`;
    const safeTitle = title.replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const safeDesc = desc.replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const safeArt = artUrl.replace(/"/g, "&quot;").replace(/</g, "&lt;");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.status(200).send(`<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8">
<meta property="og:type" content="website">
<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeDesc}">
<meta property="og:image" content="${safeArt}">
<meta property="og:url" content="https://custom.deer.gift/upload">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:description" content="${safeDesc}">
<meta name="twitter:image" content="${safeArt}">
<meta http-equiv="refresh" content="0;url=https://custom.deer.gift/">
<title>${safeTitle}</title>
</head><body><p>リダイレクト中...</p></body></html>`);
  }

  // ?type=payment-methods — 認証トークンから uid を取得して保存済みカードを返す
  // （uid を URL に載せずに済むので CORS/キャッシュ事故を避けられる）
  if (type === "payment-methods") {
    const authHeaderPM = req.headers.authorization ?? "";
    const idTokenPM = authHeaderPM.startsWith("Bearer ")
      ? authHeaderPM.slice(7)
      : null;
    if (!idTokenPM) {
      return res.status(401).json({ error: "認証トークンがありません" });
    }
    try {
      const app = getAdminApp();
      const db = getFirestore(app);
      let decodedPM;
      try {
        decodedPM = await getAuth(app).verifyIdToken(idTokenPM);
      } catch (_) {
        return res.status(401).json({ error: "認証トークンが無効です" });
      }
      const userSnap = await db.collection("users").doc(decodedPM.uid).get();
      const stripeCustomerId = userSnap.exists
        ? (userSnap.data().stripeCustomerId ?? null)
        : null;
      let paymentMethods = [];
      if (_stripe && stripeCustomerId) {
        try {
          const pmList = await _stripe.paymentMethods.list({
            customer: stripeCustomerId,
            type: "card",
          });
          // クライアント (upload.html の loadSavedCards) が
          // pm.card?.brand / pm.card?.last4 / pm.card?.exp_month / pm.card?.exp_year
          // を参照する形になっているので、ネストした card オブジェクトで返す
          paymentMethods = pmList.data.map((pm) => ({
            id: pm.id,
            card: {
              brand: pm.card?.brand ?? null,
              last4: pm.card?.last4 ?? null,
              exp_month: pm.card?.exp_month ?? null,
              exp_year: pm.card?.exp_year ?? null,
            },
          }));
        } catch (stripeErr) {
          console.error(
            "[get-user payment-methods] Stripe 取得失敗:",
            stripeErr.message,
          );
        }
      }
      return res.status(200).json({ paymentMethods });
    } catch (err) {
      console.error("[get-user payment-methods] 予期しないエラー:", err);
      return res.status(500).json({ error: "支払い方法の取得に失敗しました" });
    }
  }

  if (!uid) {
    return res.status(400).json({ error: "uid クエリパラメータは必須です" });
  }

  // Authorization ヘッダーからIDトークンを取得
  const authHeader = req.headers.authorization ?? "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!idToken) {
    return res.status(401).json({ error: "認証トークンがありません" });
  }

  try {
    const app = getAdminApp();
    const auth = getAuth(app);
    const db = getFirestore(app);

    // IDトークンを検証
    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(idToken);
    } catch (authErr) {
      console.error("[get-user] IDトークン検証失敗:", authErr.message);
      return res.status(401).json({ error: "認証トークンが無効です" });
    }

    // トークン内のuidと要求uidが一致するか確認
    if (decodedToken.uid !== uid) {
      return res
        .status(403)
        .json({ error: "他のユーザーの情報へのアクセスは禁止されています" });
    }

    // Firestoreからユーザーデータ取得
    const userSnap = await db.collection("users").doc(uid).get();

    if (!userSnap.exists) {
      return res.status(404).json({ error: "ユーザーが見つかりません" });
    }

    const userData = userSnap.data();

    // レスポンス用にユーザーデータを整形
    const user = {
      uid,
      stripeCustomerId: userData.stripeCustomerId ?? null,
      savedAddresses: userData.savedAddresses ?? [],
      orders: userData.orders ?? [],
      availableCoupons: userData.availableCoupons ?? [],
      appliedCoupons: userData.appliedCoupons ?? [],
      displayName: userData.displayName ?? null,
      pictureUrl: userData.pictureUrl ?? null,
      email: userData.email ?? null,
      createdAt: userData.createdAt ?? null,
      updatedAt: userData.updatedAt ?? null,
    };

    // Stripe savedPaymentMethodsを取得
    let paymentMethods = [];
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

    if (stripeSecretKey && user.stripeCustomerId) {
      try {
        const stripe = _stripe; // STRIPE_SECRET_KEY が存在する場合のみ到達するため必ず非null
        const pmList = await stripe.paymentMethods.list({
          customer: user.stripeCustomerId,
          type: "card",
        });
        paymentMethods = pmList.data.map((pm) => ({
          id: pm.id,
          brand: pm.card?.brand ?? null,
          last4: pm.card?.last4 ?? null,
          expMonth: pm.card?.exp_month ?? null,
          expYear: pm.card?.exp_year ?? null,
        }));
      } catch (stripeErr) {
        // Stripe取得失敗はログのみ（ユーザーデータは返す）
        console.error(
          "[get-user] Stripe paymentMethods取得失敗:",
          stripeErr.message,
        );
      }
    }

    return res.status(200).json({ user, paymentMethods });
  } catch (err) {
    console.error("[get-user] 予期しないエラー:", err);
    return res
      .status(500)
      .json({ error: err.message ?? "ユーザー情報の取得に失敗しました" });
  }
}

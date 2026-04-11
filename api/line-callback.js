/**
 * Vercel Serverless Function
 * GET /api/line-callback
 * LINE OAuth コールバック処理
 * - LINEのToken APIでaccess_tokenを取得
 * - LINEのProfile APIでユーザー情報取得
 * - Firebase Admin SDKでカスタムトークンを生成
 * - openerウィンドウにpostMessageして自身を閉じる
 */

import { timingSafeEqual } from "crypto";
import { getAuth } from "firebase-admin/auth";
import { getAdminApp } from "./_lib/auth.js";

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return raw.split(";").reduce((acc, part) => {
    const [name, ...rest] = part.trim().split("=");
    if (!name) return acc;
    acc[name] = decodeURIComponent(rest.join("=") || "");
    return acc;
  }, {});
}

function clearStateCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "lineOAuthState=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
  );
}

function hasRequiredEnv() {
  return getRequiredEnvError() === null;
}

function isExactNonceMatch(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") return false;
  if (expected.length === 0 || actual.length === 0) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(actual, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function getRequiredEnvError() {
  const missing = [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    "LINE_CHANNEL_ID",
    "LINE_CHANNEL_SECRET",
  ].filter((key) => !process.env[key]);
  if (!process.env.BASE_URL && !process.env.VERCEL_URL) {
    missing.push("BASE_URL|VERCEL_URL");
  }
  return missing.length > 0 ? missing : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (!hasRequiredEnv()) {
    const missingEnv = getRequiredEnvError();
    console.error("[line-callback] 必須環境変数不足:", missingEnv);
    return res.status(503).send(errorPage("現在認証を利用できません"));
  }

  const { code, state } = req.query;
  const cookieState = parseCookies(req).lineOAuthState;

  if (!state || state === "" || state === "undefined") {
    return res.status(400).send(errorPage("stateパラメータが不正です"));
  }
  if (!isExactNonceMatch(cookieState, state)) {
    console.error("[line-callback] state mismatch");
    clearStateCookie(res);
    return res.status(403).send(errorPage("認証を完了できませんでした"));
  }

  if (!code) {
    return res.status(400).send(errorPage("認証コードが見つかりません"));
  }

  try {
    // 1. LINE Token API でアクセストークンを取得
    const tokenRes = await fetch("https://api.line.me/oauth2/v2.1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : process.env.BASE_URL}/api/line-callback`,
        client_id: process.env.LINE_CHANNEL_ID,
        client_secret: process.env.LINE_CHANNEL_SECRET,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("[line-callback] Token取得失敗:", err);
      return res
        .status(500)
        .send(errorPage("LINEトークンの取得に失敗しました"));
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      return res
        .status(500)
        .send(errorPage("アクセストークンが取得できませんでした"));
    }

    // 2. LINE Profile API でユーザー情報取得
    const profileRes = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!profileRes.ok) {
      const err = await profileRes.text();
      console.error("[line-callback] Profile取得失敗:", err);
      return res
        .status(500)
        .send(errorPage("LINEプロフィールの取得に失敗しました"));
    }

    const profile = await profileRes.json();
    const { userId, displayName, pictureUrl } = profile;

    if (!userId) {
      return res
        .status(500)
        .send(errorPage("ユーザーIDが取得できませんでした"));
    }

    // 3. Firebase カスタムトークンを生成
    const app = getAdminApp();
    const auth = getAuth(app);
    const firebaseToken = await auth.createCustomToken(`line:${userId}`, {
      lineUserId: userId,
      displayName,
      pictureUrl,
    });

    const user = { userId, displayName, pictureUrl };

    // 4. openerウィンドウにpostMessageして閉じる
    clearStateCookie(res);
    return res.status(200).send(successPage(firebaseToken, user));
  } catch (err) {
    console.error("[line-callback] 予期しないエラー:", err);
    clearStateCookie(res);
    return res.status(500).send(errorPage("認証処理中にエラーが発生しました"));
  }
}

function successPage(token, user) {
  const userJson = JSON.stringify(user)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const tokenEscaped = String(token)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>LINE認証完了</title>
</head>
<body>
  <p>認証中...</p>
  <script>
    (function() {
      var token = ${JSON.stringify(tokenEscaped)};
      var user  = ${userJson};
      try {
        if (window.opener) {
          window.opener.postMessage(
            { type: 'LINE_AUTH', token: token, user: user },
            window.location.origin
          );
        }
      } catch (e) {
        console.error('postMessage失敗:', e);
      } finally {
        window.close();
      }
    })();
  </script>
</body>
</html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>認証エラー</title>
</head>
<body>
  <p>エラー: ${message}</p>
  <script>
    (function() {
      try {
        if (window.opener) {
          window.opener.postMessage(
            { type: 'LINE_AUTH_ERROR', message: ${JSON.stringify(message)} },
            window.location.origin
          );
        }
      } finally {
        setTimeout(function() { window.close(); }, 2000);
      }
    })();
  </script>
</body>
</html>`;
}

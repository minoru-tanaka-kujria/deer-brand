// NOTE: Stripe Publishable Keys (pk_test_*, pk_live_*) are intentionally hardcoded here.
// These are CLIENT-SIDE keys designed to be public. They do NOT grant API access.
// The SECRET key (sk_*) is stored only in Vercel environment variables and never exposed to clients.
// Firebase API Key is also public by design and restricted by authorized domains in Firebase Console.

/**
 * Deer Brand — Firebase設定
 * ★ Firebase ConsoleでWebアプリを登録後、以下の値を貼り付けてください
 * https://console.firebase.google.com → プロジェクト設定 → マイアプリ
 */
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC2ugHcF6W3hihDbgGy_JduRKyhCoVPAs8",
  authDomain: "deer-brand.firebaseapp.com",
  projectId: "deer-brand",
  storageBucket: "deer-brand.firebasestorage.app",
  messagingSenderId: "478066729532",
  appId: "1:478066729532:web:da155fad4411af45b7d939",
  measurementId: "G-CN4P5G4JW1",
};

const STRIPE_PUBLISHABLE_KEY_TEST =
  "pk_test_51QmtxaKulICaEf1dJ7GHWfFl8NduNKpFMKwM91TDT7M37wSZrCbL9UTR3MgCleFmrUyaEDeLseU41XOmM9Ls8olr002wf1LxEZ";

const STRIPE_PUBLISHABLE_KEY_LIVE =
  "pk_live_51QmtxaKulICaEf1dDPY2HJ6eLfBrBD3ymILeYkW7fSxeEY6D9iBtYZ8ankC9bgQlh2dCXQGhaoR5sSm6hnKV3Jrm00rhHaUx18";

const STRIPE_LIVE_HOSTNAMES = new Set([
  "custom.deer.gift",
  "www.custom.deer.gift",
]);

const isLiveHostname = STRIPE_LIVE_HOSTNAMES.has(window.location.hostname);

// 本番ドメインで本番キーが未設定の場合、テストキーにフォールバック（決済テスト可能な状態を維持）
if (isLiveHostname && !STRIPE_PUBLISHABLE_KEY_LIVE) {
  console.warn(
    "Stripe live key not configured — using test key. Set STRIPE_PUBLISHABLE_KEY_LIVE for production payments.",
  );
}

// ⚠ 一時的に TEST mode に統一（サーバー側 STRIPE_SECRET_KEY も同アカウント TEST に合わせてある）
// 本番決済 (LIVE mode) に切り替える際は、以下の FORCE_TEST を false に戻し、かつ
// Vercel env STRIPE_SECRET_KEY を sk_live_51Qmtxa... に更新する必要がある。
// 参照: 2026-04-21 の決済 404 調査で、サーバー側の別アカウント sk_test_51THFru と
// クライアント側の pk_live_51Qmtxa が食い違って PaymentIntent が成立しなかった。
const FORCE_TEST_MODE = true;
export const STRIPE_PUBLISHABLE_KEY =
  isLiveHostname && !FORCE_TEST_MODE
    ? STRIPE_PUBLISHABLE_KEY_LIVE || STRIPE_PUBLISHABLE_KEY_TEST
    : STRIPE_PUBLISHABLE_KEY_TEST;
export const LINE_CHANNEL_ID = "2009690645";
export const INSTAGRAM_ACCOUNT = "deer_dogfood";

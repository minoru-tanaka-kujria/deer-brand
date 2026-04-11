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
  "pk_test_51THFruDOfpcoUSefYQs6EI1sNIhc9LpHdvtSMEpePWZXWyvkclLQpNHJSk6WG2GWV15cwAAYa3x72poifueWNbF000GG0Cshwk";

// ★ Stripe本番公開鍵（承認後にStripeダッシュボードからコピーして貼り付け）
// Vercel Hobbyプランは12関数上限のためAPI経由での配信不可。直接ハードコードする。
// 公開鍵はクライアントサイドで使う前提のキーなのでセキュリティ上問題なし。
const STRIPE_PUBLISHABLE_KEY_LIVE =
  window.__DEER_STRIPE_PUBLISHABLE_KEY_LIVE__ || "";

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

export const STRIPE_PUBLISHABLE_KEY = isLiveHostname
  ? STRIPE_PUBLISHABLE_KEY_LIVE || STRIPE_PUBLISHABLE_KEY_TEST
  : STRIPE_PUBLISHABLE_KEY_TEST;
export const LINE_CHANNEL_ID = "2009690645";
export const INSTAGRAM_ACCOUNT = "deer_dogfood";

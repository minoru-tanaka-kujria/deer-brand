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
const STRIPE_LIVE_HOSTNAMES = new Set([
  "custom.deer.gift",
  "www.custom.deer.gift",
]);

const isLiveHostname = STRIPE_LIVE_HOSTNAMES.has(window.location.hostname);

// 本番ドメインでは /api/config から公開鍵を取得（Vercel環境変数経由）
// テスト環境ではハードコードされたテストキーを使用
let _resolvedStripeKey = isLiveHostname ? "" : STRIPE_PUBLISHABLE_KEY_TEST;

if (isLiveHostname) {
  fetch("/api/config")
    .then((r) => r.json())
    .then((data) => {
      if (data.stripePublishableKey) {
        _resolvedStripeKey = data.stripePublishableKey;
        window._deerStripeKey = _resolvedStripeKey;
      } else {
        // Vercel環境変数未設定 → テストキーにフォールバック（決済テスト可能な状態を維持）
        console.warn(
          "Stripe live key not configured — falling back to test key",
        );
        _resolvedStripeKey = STRIPE_PUBLISHABLE_KEY_TEST;
        window._deerStripeKey = _resolvedStripeKey;
      }
    })
    .catch((e) => {
      console.error("Failed to fetch config:", e);
      // ネットワークエラー時もテストキーにフォールバック
      _resolvedStripeKey = STRIPE_PUBLISHABLE_KEY_TEST;
      window._deerStripeKey = _resolvedStripeKey;
    });
}

export const STRIPE_PUBLISHABLE_KEY = isLiveHostname
  ? "" // 本番は非同期で /api/config から解決 → window._deerStripeKey で配信
  : STRIPE_PUBLISHABLE_KEY_TEST;
export const LINE_CHANNEL_ID = "2009690645";
export const INSTAGRAM_ACCOUNT = "deer_dogfood";

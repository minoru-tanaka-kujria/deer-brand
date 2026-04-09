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
const STRIPE_PUBLISHABLE_KEY_LIVE =
  window.__DEER_STRIPE_PUBLISHABLE_KEY_LIVE__ ||
  window.__DEER_STRIPE_KEY_LIVE__ ||
  "";
const STRIPE_LIVE_HOSTNAMES = new Set([
  "custom.deer.gift",
  "www.custom.deer.gift",
]);

const isLiveHostname = STRIPE_LIVE_HOSTNAMES.has(window.location.hostname);

if (isLiveHostname && !STRIPE_PUBLISHABLE_KEY_LIVE) {
  throw new Error(
    "Missing live Stripe publishable key for this hostname",
  );
}

export const STRIPE_PUBLISHABLE_KEY = isLiveHostname
  ? STRIPE_PUBLISHABLE_KEY_LIVE
  : STRIPE_PUBLISHABLE_KEY_TEST;
export const LINE_CHANNEL_ID = "2009690645";
export const INSTAGRAM_ACCOUNT = "deer_dogfood";

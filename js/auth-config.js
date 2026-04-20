/**
 * Deer Brand — Firebase初期化 共通設定
 * auth-modal.js より先に読み込むこと
 * <script type="module" src="js/auth-config.js"></script>
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  browserLocalPersistence,
  setPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  FIREBASE_CONFIG,
  LINE_CHANNEL_ID,
  STRIPE_PUBLISHABLE_KEY,
} from "./firebase-config.js";

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

// ★ 重要: top-level await を使わない。
// 過去、await setPersistence(...) が特定ブラウザ環境（IndexedDB が制限される
// 状況等）で resolve も reject もせずハングし、モジュール全体の evaluation が
// 止まって window._deerFirebaseAuth が永久にセットされない不具合が発生した。
// setPersistence は failure 時でも Firebase 側の default persistence で動作するため
// 起動クリティカルではない。await せず fire-and-forget にする。
setPersistence(auth, browserLocalPersistence).catch((e) => {
  console.warn("[DeerAuth] setPersistence failed, using default:", e.message);
});

// auth-modal.js / upload.html が参照するグローバル変数をセット
window._deerFirebaseAuth = auth;
window._deerFirebaseDb = db;
window._deerLineClientId = LINE_CHANNEL_ID;
window._deerStripeKey = STRIPE_PUBLISHABLE_KEY;
// 初期化完了フラグ & イベント発火（auth-modal.js がボタン有効化に使う）
window._deerAuthReady = true;
try {
  window.dispatchEvent(new Event("deer-auth-ready"));
} catch (_) {}

// ログイン状態をグローバルに反映
onAuthStateChanged(auth, (user) => {
  window._currentUser = user || null;
  // ナビのログイン状態更新（auth-modal.js がグローバルに公開した関数を使用）
  if (typeof window.updateNavForUser === "function") {
    window.updateNavForUser(user);
  }
});

/**
 * Deer Brand — 認証・ユーザー管理
 * Firebase Auth + Firestore + Stripe連携
 *
 * 本番運用時は以下の環境変数を設定してください:
 *   DEER_FIREBASE_API_KEY, DEER_FIREBASE_PROJECT_ID ...
 */

// ============================================================
//  Firebase 設定 — ここにFirebaseプロジェクトの値を貼り付ける
// ============================================================
const FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY", // Firebase Console → プロジェクト設定
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// LINE Login設定
const LINE_CLIENT_ID = "YOUR_LINE_CHANNEL_ID"; // LINE Developers Console
const LINE_REDIRECT_URI = "https://deer-brand.vercel.app/line-callback";

// ============================================================
//  Firebase SDK 初期化
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  OAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

// ============================================================
//  現在のユーザー状態（グローバル参照用）
// ============================================================
export let currentUser = null;

// ============================================================
//  Firestoreにユーザー情報を保存 / 更新
// ============================================================
async function syncUserToFirestore(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      email: user.email || "",
      displayName: user.displayName || "",
      photoURL: user.photoURL || "",
      createdAt: serverTimestamp(),
      stripeCustomerId: "",
      savedAddresses: [],
      appliedCoupons: [],
    });
  } else {
    await updateDoc(ref, { lastLoginAt: serverTimestamp() });
  }
  return (await getDoc(ref)).data();
}

// ============================================================
//  Google ログイン
// ============================================================
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  return syncUserToFirestore(result.user);
}

// ============================================================
//  Apple ログイン
// ============================================================
export async function signInWithApple() {
  const provider = new OAuthProvider("apple.com");
  provider.addScope("email");
  provider.addScope("name");
  const result = await signInWithPopup(auth, provider);
  return syncUserToFirestore(result.user);
}

// ============================================================
//  LINE ログイン（リダイレクト方式）
// ============================================================
export function signInWithLine() {
  const state = Math.random().toString(36).slice(2);
  sessionStorage.setItem("lineOAuthState", state);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: LINE_CLIENT_ID,
    redirect_uri: LINE_REDIRECT_URI,
    state,
    scope: "profile openid email",
  });
  window.location.href = `https://access.line.me/oauth2/v2.1/authorize?${params}`;
}

// ============================================================
//  メールアドレス ログイン
// ============================================================
export async function signInWithEmail(email, password) {
  const result = await signInWithEmailAndPassword(auth, email, password);
  return syncUserToFirestore(result.user);
}

// ============================================================
//  メールアドレス 新規登録
// ============================================================
export async function signUpWithEmail(email, password, displayName) {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName) {
    await result.user.updateProfile({ displayName });
  }
  return syncUserToFirestore(result.user);
}

// ============================================================
//  ログアウト
// ============================================================
export async function signOutUser() {
  await signOut(auth);
}

// ============================================================
//  ユーザープロフィール取得（Firestore）
// ============================================================
export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

// ============================================================
//  住所保存
// ============================================================
export async function saveAddress(uid, address) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  const data = snap.data();
  const addrs = data.savedAddresses || [];
  // 重複チェック（郵便番号+住所1でユニーク判定）
  const exists = addrs.find(
    (a) => a.zip === address.zip && a.address1 === address.address1,
  );
  if (!exists) {
    addrs.unshift({ ...address, savedAt: new Date().toISOString() });
    await updateDoc(ref, { savedAddresses: addrs.slice(0, 5) }); // 最大5件
  }
}

// ============================================================
//  クーポン検証（サーバーAPI経由）
// ============================================================
export async function validateCoupon(code, subtotal) {
  const res = await fetch("/api/validate-coupon", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, subtotal }),
  });
  if (!res.ok) throw new Error("Coupon validation failed");
  return res.json(); // { valid, discount, type, message }
}

// ============================================================
//  認証状態の変化を監視（全ページで呼ぶ）
// ============================================================
export function initAuth(onLogin, onLogout) {
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (user) {
      onLogin(user);
    } else {
      onLogout();
    }
  });
}

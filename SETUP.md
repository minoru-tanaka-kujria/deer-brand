# Deer Brand — セットアップ手順書

## 目次

1. [Firebase プロジェクト作成](#1-firebase-プロジェクト作成)
2. [Firebase Authentication 有効化](#2-firebase-authentication-有効化)
3. [Firestore データベース作成](#3-firestore-データベース作成)
4. [Webアプリ登録 → firebase-config.js 更新](#4-webアプリ登録--firebase-configjs-更新)
5. [サービスアカウントキー作成 → Vercel環境変数](#5-サービスアカウントキー作成--vercel環境変数)
6. [Stripe 設定](#6-stripe-設定)
7. [Stripe Webhook 設定](#7-stripe-webhook-設定)
8. [LINE Login 設定](#8-line-login-設定)
9. [Vercel 環境変数 一覧](#9-vercel-環境変数-一覧)
10. [デプロイ手順](#10-デプロイ手順)

---

## 1. Firebase プロジェクト作成

1. [Firebase Console](https://console.firebase.google.com/) を開く
2. **「プロジェクトを作成」** をクリック
3. プロジェクト名: `deer-brand`（任意）を入力 → 続行
4. Google アナリティクスは任意で有効化 → プロジェクト作成
5. プロジェクトダッシュボードが開いたら完了

---

## 2. Firebase Authentication 有効化

Firebase Console → **Authentication** → **Sign-in method** タブ

以下のプロバイダを順に有効化する:

### Email/Password

- 「メール/パスワード」→ 有効にする → 保存

### Google

- 「Google」→ 有効にする
- プロジェクトのサポートメールを設定 → 保存

### Apple（iOS向け、後回し可）

- 「Apple」→ 有効にする
- Apple Developer アカウントで Sign in with Apple を設定後、
  サービスID・チームID・キーIDを入力 → 保存

### カスタム認証（LINE Login用）

- LINE の認証はサーバーサイドで LINE API を叩き、
  Firebase Admin SDK の `createCustomToken()` でカスタムトークンを発行する方式
- Firebase 側の追加設定は不要（Admin SDK 使用時に自動対応）

---

## 3. Firestore データベース作成

Firebase Console → **Firestore Database** → **データベースを作成**

1. 「本番環境モードで開始」を選択
2. ロケーション: `asia-northeast1`（東京）を選択 → 有効にする
3. 作成後、**ルール** タブを開く
4. `firestore.rules` の内容をコピー&ペーストして公開

### Firebase CLI でルールをデプロイする場合

```bash
npm install -g firebase-tools
firebase login
firebase use --add   # プロジェクトを選択
firebase deploy --only firestore
```

---

## 4. Webアプリ登録 → firebase-config.js 更新

Firebase Console → **プロジェクト設定（歯車アイコン）** → **マイアプリ** → **「</>」（Web）アイコン**

1. アプリのニックネーム: `deer-brand-web` を入力
2. Firebase Hosting の設定は任意（後で設定可）→ アプリを登録
3. 表示される `firebaseConfig` オブジェクトの値を `js/firebase-config.js` に貼り付ける

```js
// js/firebase-config.js の FIREBASE_CONFIG を以下のように更新
export const FIREBASE_CONFIG = {
  apiKey: "実際のapiKey",
  authDomain: "your-project-id.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project-id.appspot.com",
  messagingSenderId: "実際のmessagingSenderId",
  appId: "実際のappId",
};
```

---

## 5. サービスアカウントキー作成 → Vercel環境変数

Firebase Console → **プロジェクト設定** → **サービスアカウント** タブ

1. 「新しい秘密鍵を生成」をクリック → JSONファイルをダウンロード
2. ダウンロードした JSON を**絶対にGitにコミットしない**（`.gitignore` に追加済み確認）
3. JSON の内容を Base64 エンコードする:

```bash
base64 -i path/to/serviceAccountKey.json | pbcopy
```

4. エンコードした文字列を Vercel 環境変数 `FIREBASE_SERVICE_ACCOUNT_BASE64` に設定（後述）

### API側での使い方（例: `api/stripe-webhook.js`）

```js
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString(),
);

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
```

---

## 6. Stripe 設定

1. [Stripe](https://dashboard.stripe.com/) にアカウント作成・ログイン
2. ダッシュボード左上のトグルで **「テストモード」** になっていることを確認
3. **開発者** → **APIキー** を開く
4. 「公開可能キー」（`pk_test_...`）を `js/firebase-config.js` の `STRIPE_PUBLISHABLE_KEY` に設定
5. 「シークレットキー」（`sk_test_...`）を Vercel 環境変数 `STRIPE_SECRET_KEY` に設定

### 本番移行時

- Stripe ダッシュボードでビジネス情報を入力して本番申請
- 承認後、「ライブモード」のキーに差し替える
- `pk_live_...` → `firebase-config.js` と Vercel 本番環境変数
- `sk_live_...` → Vercel 本番環境変数

---

## 7. Stripe Webhook 設定

Stripe ダッシュボード → **開発者** → **Webhook** → **エンドポイントを追加**

1. エンドポイントURL: `https://your-vercel-domain.vercel.app/api/stripe-webhook`
2. リッスンするイベントを選択:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
3. 追加後、表示される **Webhook署名シークレット**（`whsec_...`）を控える
4. Vercel 環境変数 `STRIPE_WEBHOOK_SECRET` に設定

---

## 8. LINE Login 設定

1. [LINE Developers Console](https://developers.line.biz/) にログイン
2. **プロバイダーを作成**（例: `Deer Brand`）
3. **チャネルを作成** → **LINE Login** を選択
4. チャネル名: `Deer Brand Login`、カテゴリ・サブカテゴリを設定 → 作成
5. **チャネル基本設定** タブ → **チャネルID** を `js/firebase-config.js` の `LINE_CHANNEL_ID` に設定
6. **LINE Login** タブ → **コールバックURL** に以下を追加:
   - `https://your-vercel-domain.vercel.app/api/line-callback`
   - `http://localhost:3000/api/line-callback`（開発用）
7. **チャネルシークレット**（チャネル基本設定タブ）を Vercel 環境変数 `LINE_CHANNEL_SECRET` に設定
8. **チャネルアクセストークン**（LINE Login タブ）を Vercel 環境変数 `LINE_CHANNEL_ACCESS_TOKEN` に設定

---

## 9. Vercel 環境変数 一覧

以下のコマンドを順に実行して環境変数を設定する。
各コマンド実行後に値の入力を求められる。

```bash
# Firebase Admin SDK（サービスアカウントのBase64）
vercel env add FIREBASE_SERVICE_ACCOUNT_BASE64

# Stripe
vercel env add STRIPE_SECRET_KEY
vercel env add STRIPE_WEBHOOK_SECRET

# LINE
vercel env add LINE_CHANNEL_ID
vercel env add LINE_CHANNEL_SECRET
vercel env add LINE_CHANNEL_ACCESS_TOKEN

# その他
vercel env add NEXT_PUBLIC_APP_URL   # デプロイ先URL（例: https://deer-brand.vercel.app）
```

### 環境別に設定する場合（Production / Preview / Development）

```bash
vercel env add STRIPE_SECRET_KEY production
vercel env add STRIPE_SECRET_KEY preview
vercel env add STRIPE_SECRET_KEY development
```

### 設定済み環境変数の確認

```bash
vercel env ls
```

---

## 10. デプロイ手順

### 初回セットアップ

```bash
# Vercel CLI インストール
npm install -g vercel

# プロジェクトルートで実行
cd /path/to/deer-brand
vercel

# 質問に答える:
# Set up and deploy? → Y
# Which scope? → 自分のアカウント
# Link to existing project? → N（初回はN）
# Project name → deer-brand
# Directory → .（カレント）
```

### 通常デプロイ（Preview）

```bash
vercel
```

### 本番デプロイ

```bash
vercel --prod
```

### Firebase セキュリティルール・インデックスのデプロイ

```bash
# 初回のみ: Firebase CLI ログイン & プロジェクト紐付け
firebase login
firebase use --add   # deer-brand プロジェクトを選択

# ルール＆インデックスをデプロイ
firebase deploy --only firestore
```

### デプロイ後の確認チェックリスト

- [ ] `https://your-domain.vercel.app` でトップページが表示される
- [ ] 認証モーダルからログインできる（Google/LINE）
- [ ] `/upload` でアップロードフローが完走する
- [ ] Stripe テストカード（`4242 4242 4242 4242`）で決済が通る
- [ ] Stripe Webhook → Firestore に注文データが書き込まれる
- [ ] `/account` でマイページ・注文履歴が表示される

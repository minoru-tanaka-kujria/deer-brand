# Deer Brand — プロジェクト指示

## デプロイルール（最重要）

**コードを変更して `git push origin main` した後、必ず以下を実行すること：**

```bash
bash scripts/verify-deploy.sh
```

### デプロイ完了の定義

1. Vercelビルドが `Ready` になっている
2. 本番URL（custom.deer.gift）に最新コードが反映されている
3. APIエンドポイントが正常応答している

### デプロイ失敗時

- Vercelデプロイメントページで `Error` を確認
- ビルドログからエラー原因を特定
- 修正して再push
- **「デプロイしました」とユーザーに報告するのは、verify-deploy.sh が成功した後のみ**

## Gitリモート（2026-04-24 現状）

- `origin` → minoru-tanaka-kujria/deer-brand（**本番デプロイ先**、Vercel 連動）
- `backup` → tanaka-team/products（バックアップ、fast-forward 不可な場合あり）
- `tanaka` → tanaka-team/deer-brand-v2i
- **本番反映には `git push origin main` が必要**（旧 CLAUDE.md の `vercel` remote は現在 `origin` にリネーム）

## 技術スタック

- フロントエンド: 単一HTML（upload.html）+ vanilla JS
- API: Vercel Serverless Functions（/api/）
- AI生成: Replicate Flux Kontext Pro（$0.04/回）
- 決済: Stripe
- 認証/DB: Firebase Auth + Firestore
- 印刷: Printful API
- ホスティング: Vercel（Hobby plan）

## テスト

- `/smoke-test` — AI生成の全23スタイルテスト
- `/smoke-test quick` — 代表3スタイルだけ（$0.12）
- `curl "https://custom.deer.gift/api/get-user?type=health"` — env 疎通チェック（`ok:true` 確認）

## Printful 環境変数（2026-04-24 判明・未解決）

現状 Vercel に以下が**未設定 or 無効**のため、発送完了通知と Printful 自動発注が動いていない可能性が高い:

- `PRINTFUL_WEBHOOK_SECRET` → **未設定**。発送完了 Webhook が 503 で全件失敗
- `PRINTFUL_API_KEY` → 設定済みだが **401 expired**（`/store` 直叩きで確認済み）

再設定手順（オーナー側で必要）:

1. [Printful Dashboard](https://www.printful.com/dashboard) → Settings → API で新トークン発行
2. Settings → Webhooks で URL `https://custom.deer.gift/api/printful-webhook` を登録し secret 発行
3. `vercel env rm PRINTFUL_API_KEY production --yes`
4. `vercel env add PRINTFUL_API_KEY production` / `vercel env add PRINTFUL_WEBHOOK_SECRET production`
5. `vercel --prod` で再デプロイ
6. `curl "https://custom.deer.gift/api/get-user?type=health"` で `ok:true` 確認

完了するまでは `admin-api` の `list-pending-orders` / `retry-printful` アクションで手動リカバリが必要。

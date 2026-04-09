# Deer Brand — プロジェクト指示

## デプロイルール（最重要）

**コードを変更して `git push vercel main` した後、必ず以下を実行すること：**

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

## Gitリモート

- `origin` → tanaka-team/products（バックアップ）
- `vercel` → minoru-tanaka-kujria/deer-brand（本番デプロイ）
- **本番反映には `git push vercel main` が必要**
- originだけにpushしてもデプロイされない

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

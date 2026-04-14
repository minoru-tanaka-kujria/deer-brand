#!/bin/bash
# Deer Brand — デプロイ完了確認スクリプト
# コミット後に実行して、本番にコミット内容が反映されたことを確認する
#
# 使い方: bash scripts/verify-deploy.sh

set -e

SITE="https://custom.deer.gift"
COMMIT=$(git rev-parse --short HEAD)
COMMIT_FULL=$(git rev-parse HEAD)
MAX_WAIT=180
INTERVAL=8

echo "============================================================"
echo "Deer Brand — デプロイ完了確認"
echo "  コミット: $COMMIT ($(git log -1 --format='%s' HEAD))"
echo "  サイト:   $SITE"
echo "============================================================"

CHANGED=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null || true)
echo "  変更ファイル: $(echo $CHANGED | tr '\n' ' ')"
echo ""

# ─── ヘルパー: コミットで「追加された行」から検証用キーワードを抽出 ──
extract_added_keywords() {
  local file="$1"
  # "+" で追加された行のみ取り出し、ASCII の長め単語を抽出して上から数件返す
  git show "$COMMIT_FULL" -- "$file" 2>/dev/null \
    | awk '/^\+[^+]/ { sub(/^\+/, ""); print }' \
    | grep -oE '[A-Za-z_][A-Za-z0-9_-]{14,}' \
    | grep -viE '^(function|const|return|document|querySelector|addEventListener|getElementById|innerHTML)$' \
    | awk '!seen[$0]++' \
    | head -3
}

verify_url_contains() {
  local url="$1"
  local keyword="$2"
  curl -s "$url" 2>/dev/null | grep -F -q -- "$keyword"
}

# ─── 検証対象を構築（HTMLファイル → URL/キーワード）──
declare -a TARGETS=()
for file in $CHANGED; do
  case "$file" in
    upload.html)
      KW=$(extract_added_keywords upload.html | head -1)
      [ -n "$KW" ] && TARGETS+=("upload.html|${SITE}/upload|${KW}")
      ;;
    index.html)
      KW=$(extract_added_keywords index.html | head -1)
      [ -n "$KW" ] && TARGETS+=("index.html|${SITE}/|${KW}")
      ;;
    tokushoho.html)
      KW=$(extract_added_keywords tokushoho.html | head -1)
      [ -n "$KW" ] && TARGETS+=("tokushoho.html|${SITE}/tokushoho|${KW}")
      ;;
    privacy.html)
      KW=$(extract_added_keywords privacy.html | head -1)
      [ -n "$KW" ] && TARGETS+=("privacy.html|${SITE}/privacy|${KW}")
      ;;
    terms.html)
      KW=$(extract_added_keywords terms.html | head -1)
      [ -n "$KW" ] && TARGETS+=("terms.html|${SITE}/terms|${KW}")
      ;;
    api/*.js)
      # _lib/ ディレクトリはライブラリファイルでエンドポイントではないためスキップ
      if echo "$file" | grep -q "^api/_lib/"; then
        continue
      fi
      ep=$(echo "$file" | sed 's|^api/||;s|\.js$||')
      TARGETS+=("$file|${SITE}/api/${ep}|API_RESPONDS")
      ;;
  esac
done

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "[INFO] 検証対象のHTML/APIファイルなし。ビルド成否のみ確認。"
  sleep 30
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$SITE/upload" 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "✅ サイト応答OK (HTTP 200)"
    exit 0
  else
    echo "❌ サイト応答異常 (HTTP $STATUS)"
    exit 1
  fi
fi

echo "[検証対象]"
for t in "${TARGETS[@]}"; do
  IFS='|' read -r FILE URL KW <<< "$t"
  echo "  - $FILE → $URL（キーワード: $KW）"
done
echo ""
echo "[待機中] 各ターゲットが本番に反映されるまで待機..."

ELAPSED=0
ALL_OK=false

while [ $ELAPSED -lt $MAX_WAIT ]; do
  ALL_OK=true
  for t in "${TARGETS[@]}"; do
    IFS='|' read -r FILE URL KW <<< "$t"
    if [ "$KW" = "API_RESPONDS" ]; then
      STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null)
      # 405/400/200等のレスポンスがあればAPIは存在する。404のみ未デプロイ扱い。
      if [ "$STATUS" = "404" ] || [ -z "$STATUS" ]; then
        ALL_OK=false
      fi
    else
      if ! verify_url_contains "$URL" "$KW"; then
        ALL_OK=false
      fi
    fi
  done
  if [ "$ALL_OK" = true ]; then
    echo "  ✅ 全ターゲット反映確認 (${ELAPSED}秒)"
    break
  fi
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
  echo "  ${ELAPSED}秒... まだ反映されていないターゲットあり"
done

echo ""
echo "============================================================"
if [ "$ALL_OK" = true ]; then
  echo "✅ デプロイ完了確認"
  echo "  コミット: $COMMIT"
  echo "  確認時刻: $(date '+%H:%M:%S')"
  for t in "${TARGETS[@]}"; do
    IFS='|' read -r FILE URL KW <<< "$t"
    echo "  ✓ $FILE → $URL"
  done
else
  echo "❌ ${MAX_WAIT}秒待っても反映されないターゲットがあります"
  for t in "${TARGETS[@]}"; do
    IFS='|' read -r FILE URL KW <<< "$t"
    if [ "$KW" = "API_RESPONDS" ]; then
      STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null)
      echo "  ? $FILE → HTTP $STATUS"
    else
      if verify_url_contains "$URL" "$KW"; then
        echo "  ✓ $FILE → 反映済み"
      else
        echo "  ✗ $FILE → '$KW' が見つかりません"
      fi
    fi
  done
  echo ""
  echo "  Vercelダッシュボード:"
  echo "  https://vercel.com/minorufish-gmailcoms-projects/deer-brand/deployments"
  exit 1
fi
echo "============================================================"

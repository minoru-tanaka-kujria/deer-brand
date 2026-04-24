#!/usr/bin/env bash
# =============================================================================
# Deer Brand — スモーク検査
#
# 本番の重要 API が動いているかを確認する。
# - /api/get-user?type=health (env 疎通)
# - /api/get-user?type=config (client 公開 config)
# - /api/generate-art (GET: styles 一覧)
# - /api/validate-coupon (POST invalid coupon: 期待 4xx)
# - Firebase Storage 保管庫 (art-composites バケット) の public URL 到達性
#
# 失敗したら SLACK_WEBHOOK_URL に通知 (env に設定されている場合)。
# exit code: 0 = 全部 OK, 1 = 1件以上失敗
# =============================================================================
set -uo pipefail

BASE="${SMOKE_BASE_URL:-https://custom.deer.gift}"
BUCKET="${FIREBASE_STORAGE_BUCKET:-deer-brand-art-composites}"
SLACK_URL="${SLACK_WEBHOOK_URL:-}"
CTX="${GITHUB_RUN_URL:-local}"

echo "============================================================"
echo "Deer Brand smoke check — base: $BASE"
echo "============================================================"

FAILURES=()

check() {
  local name="$1"
  local cmd="$2"
  local expect="$3"
  local got
  got=$(eval "$cmd" 2>&1)
  if echo "$got" | grep -qE "$expect"; then
    printf "  ✓ %s\n" "$name"
  else
    printf "  ✗ %s — expected match: %s\n    got: %s\n" "$name" "$expect" "$(echo "$got" | head -c 200)"
    FAILURES+=("$name|$got")
  fi
}

check "health" "curl -fsS '${BASE}/api/get-user?type=health'" '"ok":true'
check "config" "curl -fsS '${BASE}/api/get-user?type=config'" '"stripePublishableKey"'
check "generate-art requires auth" \
  "curl -s -o /dev/null -w '%{http_code}' '${BASE}/api/generate-art'" \
  '^401$'
check "validate-coupon rejects invalid" \
  "curl -s -o /dev/null -w '%{http_code}' -X POST '${BASE}/api/validate-coupon' -H 'Content-Type: application/json' -d '{\"code\":\"NONEXISTENT_SMOKE\"}'" \
  '^(400|401|404|403)$'
check "storage bucket reachable" \
  "curl -s -o /dev/null -w '%{http_code}' 'https://storage.googleapis.com/storage/v1/b/${BUCKET}'" \
  '^(200|401|403)$'
check "upload.html serves" \
  "curl -s -o /dev/null -w '%{http_code}' '${BASE}/upload'" \
  '^200$'
check "no 500 on create-order malformed" \
  "curl -s -o /dev/null -w '%{http_code}' -X POST '${BASE}/api/create-order' -H 'Content-Type: application/json' -d '{}'" \
  '^(400|401|405)$'

echo "------------------------------------------------------------"

if [[ ${#FAILURES[@]} -eq 0 ]]; then
  echo "✅ 全チェック成功"
  exit 0
fi

echo "❌ 失敗: ${#FAILURES[@]} 件"
printf ' - %s\n' "${FAILURES[@]%%|*}"

if [[ -n "$SLACK_URL" ]]; then
  FAIL_LIST=$(printf '• %s\n' "${FAILURES[@]%%|*}")
  PAYLOAD=$(cat <<EOF
{
  "blocks": [
    {"type":"section","text":{"type":"mrkdwn","text":":rotating_light: *Deer smoke check failed*"}},
    {"type":"section","text":{"type":"mrkdwn","text":"base: \`${BASE}\`\n実行元: ${CTX}"}},
    {"type":"section","text":{"type":"mrkdwn","text":"${FAIL_LIST//\"/\\\"}"}}
  ],
  "text": "Deer smoke check failed: ${#FAILURES[@]} 件"
}
EOF
)
  curl -sS -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$SLACK_URL" >/dev/null || true
fi

exit 1

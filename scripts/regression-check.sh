#!/usr/bin/env bash
# 先祖返り検知スクリプト（CI/pre-commit 両用）
#
# 目的: AI 生成アート画像（state.finalArtUrl）が、失敗時に元のアップロード写真
#       （state.photoDataUrl）へサイレントフォールバックされるパターンを検出する。
#
# 背景:
#   過去、AI 生成失敗時に state.finalArtUrl = state.photoDataUrl に代入され、
#   「AI で生成したのに普通の写真が商品に印刷される」事故が複数箇所で発生した。
#   このスクリプトは grep で該当パターンが PR に再び現れていないかを検査する。
#
# 終了コード: NG パターン検出時は 1、問題なければ 0。

set -euo pipefail

cd "$(dirname "$0")/.."

NG_FOUND=0

echo "🔍 regression-check: scanning for banned fallback patterns..."

# スキャン対象: フロント HTML + サーバ側 API
SCAN_TARGETS=(upload.html stamp/index.html memorial/index.html api)

# ── パターン1: finalArtUrl = ... photoDataUrl ──────────────────────────
# 例: state.finalArtUrl = state.selectedStyleUrl || state.photoDataUrl;
#     state.finalArtUrl = state.photoDataUrl;
# GUARD_OK コメント / === 比較行（ガード自身）/ 行頭 // コメントは除外
if matches=$(grep -rnE 'finalArtUrl\s*=[^=].*photoDataUrl' \
    "${SCAN_TARGETS[@]}" 2>/dev/null \
    | grep -v 'GUARD_OK' \
    | grep -vE '^\s*[^:]+:[0-9]+:\s*//' || true); then
  if [ -n "$matches" ]; then
    echo "❌ 禁止パターン検出: finalArtUrl に photoDataUrl がフォールバック代入されています"
    echo "$matches"
    echo ""
    echo "   AI 生成失敗時は元写真を使わず、エラー表示してリトライを促してください。"
    echo "   (参考: ~/.claude/skills/regression-prevention/SKILL.md)"
    NG_FOUND=1
  fi
fi

# ── パターン2: artImageUrl = state.photoDataUrl ────────────────────────
# 注文APIへ送る / サーバー側で組み立てる artImageUrl に元写真を渡すのも禁止
if matches=$(grep -rnE 'artImageUrl[:=]\s*(state\.)?photoDataUrl' \
    "${SCAN_TARGETS[@]}" 2>/dev/null | grep -v 'GUARD_OK' || true); then
  if [ -n "$matches" ]; then
    echo "❌ 禁止パターン検出: artImageUrl に photoDataUrl が直接代入されています"
    echo "$matches"
    NG_FOUND=1
  fi
fi

# ── パターン3: artImageUrl の fallback パターン（サーバー） ────────────
# api/create-order.js 等で artImageUrl || photoUrl のようにフォールバックされてないか
if matches=$(grep -rnE 'artImageUrl\s*\|\|\s*(body\.|req\.|orderData\.)?(photo|photoUrl|photoDataUrl|userPhoto)' \
    api 2>/dev/null | grep -v 'GUARD_OK' || true); then
  if [ -n "$matches" ]; then
    echo "❌ 禁止パターン検出: サーバ側 artImageUrl に生写真フォールバックがあります"
    echo "$matches"
    NG_FOUND=1
  fi
fi

# ── パターン3: REGRESSION_GUARD を勝手に削除させない ───────────────────
# upload.html に注文前 assertion が残っていることを確認
if ! grep -q "REGRESSION_GUARD" upload.html; then
  echo "❌ upload.html から REGRESSION_GUARD assertion が削除されています"
  echo "   注文前に finalArtUrl === photoDataUrl を検知する致命バグ防壁を"
  echo "   勝手に外さないでください。仕様として削除するなら PR で明示議論を。"
  NG_FOUND=1
fi

if [ "$NG_FOUND" -eq 0 ]; then
  echo "✅ 先祖返りパターンは検出されませんでした"
fi

exit "$NG_FOUND"

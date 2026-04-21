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

# ── JS Syntax チェック（HTML 内のインラインスクリプトも対象）──────────────
# 過去、sed/python regex で showToast 等の括弧数を誤って変更して
# 「画面が真っ白になる」事故が発生したため CI で防ぐ。
echo ""
echo "🔍 JS syntax check..."
SYNTAX_NG=0

# 独立 JS ファイル
for jsfile in $(find js -name "*.js" 2>/dev/null); do
  if ! node --check "$jsfile" 2>/dev/null; then
    echo "❌ JS syntax error: $jsfile"
    node --check "$jsfile" 2>&1 | head -5
    SYNTAX_NG=1
  fi
done

# HTML 内の <script> セクション抽出して syntax check
for html in upload.html index.html account.html admin.html product-detail.html placement-detail.html art-styles.html memorial/index.html stamp/index.html; do
  [ -f "$html" ] || continue
  # type="module" や src=""のscript は除外、インラインのみ
  python3 - "$html" <<'PYEOF' > /tmp/syntax_check_inline.js 2>/dev/null
import sys, re
p = sys.argv[1]
with open(p) as f: txt = f.read()
# src 属性なし & type="text/javascript" or なし のインラインscript のみ抽出
scripts = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', txt, re.DOTALL)
for i, s in enumerate(scripts):
    # JSON-LD は type="application/ld+json" なので除外 (pattern では無理なのでよく判定)
    if s.strip().startswith('{'):
        continue  # LD-JSON っぽい
    print(f"/* --- chunk {i} --- */")
    print(s)
PYEOF
  if [ ! -s /tmp/syntax_check_inline.js ]; then continue; fi
  if ! node --check /tmp/syntax_check_inline.js 2>/dev/null; then
    echo "❌ JS syntax error in $html:"
    node --check /tmp/syntax_check_inline.js 2>&1 | head -5
    SYNTAX_NG=1
  fi
done

if [ "$SYNTAX_NG" -eq 0 ]; then
  echo "✅ JS syntax OK (全スクリプト)"
else
  NG_FOUND=1
fi

exit "$NG_FOUND"

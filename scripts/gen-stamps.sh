#!/bin/bash
# LINE stamp sample generation using Replicate Flux Kontext Pro
# Uses shiba.jpg as input photo

set -e

TOKEN="${REPLICATE_API_TOKEN}"
API="https://api.replicate.com/v1"
MODEL="black-forest-labs/flux-kontext-pro"
OUT_DIR="/Users/openclawmacmini20260302/Deer/img/stamps"
INPUT_IMG="/Users/openclawmacmini20260302/Deer/img/shiba.jpg"

mkdir -p "$OUT_DIR"

# Base64 encode the input image
echo "Encoding input image..."
B64=$(base64 < "$INPUT_IMG" | tr -d '\n')
DATA_URL="data:image/jpeg;base64,${B64}"

# Define 8 stamp expressions
declare -a NAMES=(
  "01-ohayou"
  "02-arigatou"
  "03-gomenne"
  "04-ok"
  "05-otsukare"
  "06-yatta"
  "07-ganbare"
  "08-oyasumi"
)

declare -a PROMPTS=(
  "Transform this dog photo into a cute kawaii LINE sticker illustration. The dog is smiling happily with sparkly eyes, tail wagging, with a bright morning sun in the background. White background, clean bold outlines, chibi proportions with a big head and small body, soft pastel colors. Japanese kawaii sticker style. Add the text 'おはよう！' in cute handwritten Japanese font at the bottom. Keep the dog's breed and fur color recognizable."
  "Transform this dog photo into a cute kawaii LINE sticker illustration. The dog is bowing politely with closed happy eyes, small hearts floating around. White background, clean bold outlines, chibi proportions, soft pastel colors. Japanese kawaii sticker style. Add the text 'ありがとう' in cute handwritten Japanese font at the bottom. Keep the dog's breed and fur color recognizable."
  "Transform this dog photo into a cute kawaii LINE sticker illustration. The dog has a sad apologetic expression with droopy ears, a single tear drop, looking up with puppy eyes. White background, clean bold outlines, chibi proportions, soft pastel colors. Japanese kawaii sticker style. Add the text 'ごめんね…' in cute handwritten Japanese font at the bottom. Keep the dog's breed and fur color recognizable."
  "Transform this dog photo into a cute kawaii LINE sticker illustration. The dog is doing a confident thumbs up pose with one paw raised, winking with a big grin. White background, clean bold outlines, chibi proportions, soft pastel colors. Japanese kawaii sticker style. Add the text 'OK！' in bold fun font at the bottom. Keep the dog's breed and fur color recognizable."
  "Transform this dog photo into a cute kawaii LINE sticker illustration. The dog is relaxing tiredly but happily, maybe lying down with a small sweat drop, looking content after a long day. White background, clean bold outlines, chibi proportions, soft pastel colors. Japanese kawaii sticker style. Add the text 'おつかれさま' in cute handwritten Japanese font at the bottom. Keep the dog's breed and fur color recognizable."
  "Transform this dog photo into a cute kawaii LINE sticker illustration. The dog is jumping with joy, both front paws raised high, mouth open in a big excited smile, confetti or sparkles around. White background, clean bold outlines, chibi proportions, soft pastel colors. Japanese kawaii sticker style. Add the text 'やったー！' in energetic bold Japanese font at the bottom. Keep the dog's breed and fur color recognizable."
  "Transform this dog photo into a cute kawaii LINE sticker illustration. The dog is in a cheering pose with a headband, paw raised in a fist pump, determined sparkling eyes. White background, clean bold outlines, chibi proportions, soft pastel colors. Japanese kawaii sticker style. Add the text 'がんばれ！' in bold energetic Japanese font at the bottom. Keep the dog's breed and fur color recognizable."
  "Transform this dog photo into a cute kawaii LINE sticker illustration. The dog is sleeping peacefully curled up with closed eyes, a small blanket, moon and stars floating above. White background, clean bold outlines, chibi proportions, soft pastel colors. Japanese kawaii sticker style. Add the text 'おやすみ' in gentle handwritten Japanese font at the bottom. Keep the dog's breed and fur color recognizable."
)

# Submit all 8 predictions
echo "Submitting 8 stamp generation requests..."
declare -a PRED_IDS=()

for i in "${!NAMES[@]}"; do
  echo "  Submitting ${NAMES[$i]}..."

  RESP=$(curl -s -X POST "$API/models/$MODEL/predictions" \
    -H "Authorization: Token $TOKEN" \
    -H "Content-Type: application/json" \
    -H "Prefer: respond-async" \
    -d "{
      \"input\": {
        \"input_image\": \"$DATA_URL\",
        \"prompt\": \"${PROMPTS[$i]}\",
        \"aspect_ratio\": \"1:1\",
        \"output_format\": \"png\",
        \"safety_tolerance\": 6
      }
    }")

  ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','ERROR'))" 2>/dev/null || echo "ERROR")

  if [ "$ID" = "ERROR" ] || [ -z "$ID" ]; then
    echo "    ERROR: Failed to submit. Response: $RESP"
    exit 1
  fi

  echo "    ID: $ID"
  PRED_IDS+=("$ID")
done

echo ""
echo "All 8 submitted. Polling for results..."

# Poll all predictions
COMPLETED=0
TOTAL=${#PRED_IDS[@]}
declare -a STATUS=()
for i in "${!PRED_IDS[@]}"; do
  STATUS+=("pending")
done

while [ $COMPLETED -lt $TOTAL ]; do
  sleep 5

  for i in "${!PRED_IDS[@]}"; do
    [ "${STATUS[$i]}" = "done" ] && continue

    POLL=$(curl -s "$API/predictions/${PRED_IDS[$i]}" \
      -H "Authorization: Token $TOKEN")

    ST=$(echo "$POLL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)

    if [ "$ST" = "succeeded" ]; then
      OUTPUT_URL=$(echo "$POLL" | python3 -c "import sys,json; o=json.load(sys.stdin).get('output',''); print(o[0] if isinstance(o,list) else o)" 2>/dev/null)
      echo "  ${NAMES[$i]}: DONE -> downloading..."
      curl -sL -o "$OUT_DIR/${NAMES[$i]}.png" "$OUTPUT_URL"
      STATUS[$i]="done"
      COMPLETED=$((COMPLETED + 1))
    elif [ "$ST" = "failed" ]; then
      echo "  ${NAMES[$i]}: FAILED"
      ERR=$(echo "$POLL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null)
      echo "    Error: $ERR"
      STATUS[$i]="done"
      COMPLETED=$((COMPLETED + 1))
    fi
  done

  echo "  Progress: $COMPLETED / $TOTAL completed"
done

echo ""
echo "=== Generation complete ==="
ls -la "$OUT_DIR"/*.png 2>/dev/null || echo "No PNG files generated"

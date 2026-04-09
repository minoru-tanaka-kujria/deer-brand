/**
 * Replicate API 共通ラッパー
 *
 * generate-art.js / remove-bg.js / stamp/generate.js で共通利用。
 */

const REPLICATE_API = "https://api.replicate.com/v1";

/**
 * Replicate で予測を開始する（非同期）
 *
 * @param {object} opts
 * @param {string} opts.token          - REPLICATE_API_TOKEN
 * @param {string} [opts.model]        - "owner/name" 形式（models エンドポイント使用）
 * @param {string} [opts.version]      - version hash（predictions エンドポイント使用）
 * @param {object} opts.input          - モデルへの入力
 * @returns {Promise<{id: string}>}
 */
export async function createPrediction({ token, model, version, input }) {
  let url;
  let body;

  if (model) {
    url = `${REPLICATE_API}/models/${model}/predictions`;
    body = { input };
  } else if (version) {
    url = `${REPLICATE_API}/predictions`;
    body = { version, input };
  } else {
    throw new Error("model or version is required");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
      Prefer: "respond-async",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[replicate] createPrediction error:", err);
    throw new Error("REPLICATE_ERROR");
  }

  const data = await res.json();
  return { id: data.id };
}

/**
 * Replicate の予測結果をポーリングする
 *
 * @param {object} opts
 * @param {string} opts.token - REPLICATE_API_TOKEN
 * @param {string} opts.id    - prediction ID
 * @returns {Promise<{status: string, outputUrl: string|null, error: string|null}>}
 */
export async function pollPrediction({ token, id }) {
  const res = await fetch(`${REPLICATE_API}/predictions/${id}`, {
    headers: { Authorization: `Token ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[replicate] pollPrediction error:", err);
    throw new Error("REPLICATE_POLL_ERROR");
  }

  const data = await res.json();
  let outputUrl = null;
  if (data.status === "succeeded" && data.output) {
    outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
  }

  return {
    status: data.status,
    outputUrl,
    error: data.error ? "処理に失敗しました" : null,
  };
}

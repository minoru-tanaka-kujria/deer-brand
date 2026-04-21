/**
 * /api/error-report — 最小版 (動作確認用)
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  console.log(
    "[error-report]",
    `count=${errors.length}`,
    `ua=${req.headers["user-agent"]?.slice(0, 40)}`,
    "first:",
    JSON.stringify(errors[0] || {}).slice(0, 300),
  );
  return res.json({ ok: true, received: errors.length });
}

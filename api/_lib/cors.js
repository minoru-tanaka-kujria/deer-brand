/**
 * CORS共通ヘルパー
 */
const ALLOWED_ORIGINS = [
  "https://custom.deer.gift",
  "https://deer-brand.vercel.app",
];

const PREVIEW_PATTERN = /^https:\/\/deer-brand[a-z0-9-]*\.vercel\.app$/;

export function setCorsHeaders(req, res, methods = "POST, OPTIONS") {
  const origin = (req.headers.origin || "").trim();
  const envOrigin = process.env.ALLOWED_ORIGIN;
  const allowed = envOrigin ? [...ALLOWED_ORIGINS, envOrigin] : ALLOWED_ORIGINS;
  const corsOrigin =
    allowed.includes(origin) || PREVIEW_PATTERN.test(origin)
      ? origin
      : allowed[0];
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return corsOrigin;
}

export function handlePreflight(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

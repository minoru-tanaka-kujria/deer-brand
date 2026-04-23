const DEFAULT_WINDOW_MS = 60 * 1000;

/**
 * クライアント IP 取得。
 *
 * Vercel 環境では `x-forwarded-for` は「クライアント, プロキシ1, プロキシ2, ...」の
 * 形式で追記される。攻撃者が独自の `x-forwarded-for` をリクエストに添えると、
 * そのヘッダが先頭に来て偽装できるため、先頭を採用してはいけない。
 *
 * 信頼できる順序:
 *   1. `x-vercel-forwarded-for` (Vercel が自分で書き込む — 信頼可)
 *   2. `x-real-ip` (同上)
 *   3. `x-forwarded-for` の **末尾** (最後に追記された = 直前のプロキシ = Vercel Edge)
 *   4. socket.remoteAddress
 */
export function getClientIp(req) {
  const vercelForwarded = req.headers["x-vercel-forwarded-for"];
  if (typeof vercelForwarded === "string" && vercelForwarded.trim()) {
    return vercelForwarded.split(",")[0].trim();
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    // 末尾 = 最も信頼できる直前のプロキシ
    const parts = forwarded
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) {
      return parts[parts.length - 1];
    }
  }
  return req.socket?.remoteAddress ?? "unknown";
}

export async function consumeRateLimit(
  db,
  key,
  limit,
  windowMs = DEFAULT_WINDOW_MS,
) {
  const ref = db.collection("rateLimits").doc(key);
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, {
        count: 1,
        windowStart: new Date(now),
        updatedAt: new Date(now),
      });
      return;
    }

    const data = snap.data();
    const windowStart =
      typeof data.windowStart?.toDate === "function"
        ? data.windowStart.toDate().getTime()
        : new Date(data.windowStart).getTime();

    if (!Number.isFinite(windowStart) || now - windowStart >= windowMs) {
      tx.set(
        ref,
        {
          count: 1,
          windowStart: new Date(now),
          updatedAt: new Date(now),
        },
        { merge: true },
      );
      return;
    }

    const nextCount = Number(data.count ?? 0) + 1;
    if (nextCount > limit) {
      throw new Error("RATE_LIMITED");
    }

    tx.update(ref, {
      count: nextCount,
      updatedAt: new Date(now),
    });
  });
}

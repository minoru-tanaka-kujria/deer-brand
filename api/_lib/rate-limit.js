const DEFAULT_WINDOW_MS = 60 * 1000;

export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

export async function consumeRateLimit(db, key, limit, windowMs = DEFAULT_WINDOW_MS) {
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

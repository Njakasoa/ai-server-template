import type { Context, MiddlewareHandler } from "hono";

type Bucket = { count: number; resetAt: number };

export type RateLimitOptions = {
  windowMs: number;
  max: number;
  keyFn?: (c: Context) => string;
};

const defaultKey = (c: Context): string => {
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) return `t:${auth.slice(7)}`;
  const xff = c.req.header("x-forwarded-for");
  if (xff) return `ip:${xff.split(",")[0]!.trim()}`;
  return "ip:unknown";
};

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const keyFn = opts.keyFn ?? defaultKey;

  // Periodic GC of expired buckets so the map stays bounded under churn.
  const gc = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k);
    }
  }, Math.max(opts.windowMs, 30_000));
  if (typeof gc.unref === "function") gc.unref();

  return async (c, next) => {
    const key = keyFn(c);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count++;

    const remaining = Math.max(0, opts.max - b.count);
    c.header("X-RateLimit-Limit", String(opts.max));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.floor(b.resetAt / 1000)));

    if (b.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { success: false, error: { code: "rate_limited", message: "too many requests" } },
        429,
      );
    }
    await next();
  };
}

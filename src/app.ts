import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { health } from "./routes/health.js";
import { test } from "./routes/test.js";
import { crm } from "./routes/crm.js";
import { chat } from "./routes/chat.js";
import { env } from "./lib/env.js";
import { rateLimit } from "./lib/rate-limit.js";

export function createApp() {
  const app = new Hono();
  app.use("*", logger());
  app.route("/", health);
  // Reject oversized bodies before they hit zod / claude. Largest legitimate
  // payload today is `transcript` ≤ 50 KB; allow some headroom for metadata.
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 200 * 1024,
      onError: (c) =>
        c.json(
          { success: false, error: { code: "payload_too_large" } },
          413,
        ),
    }),
  );
  if (env.API_TOKEN) {
    app.use("/api/*", bearerAuth({ token: env.API_TOKEN }));
  }
  app.use(
    "/api/*",
    rateLimit({ windowMs: 60_000, max: env.RATE_LIMIT_PER_MIN }),
  );
  app.route("/api/v1", test);
  app.route("/api/v1", chat);
  app.route("/api/v1/crm", crm);
  app.notFound((c) => c.json({ success: false, error: { code: "not_found" } }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json(
        { success: false, error: { code: "http_error", message: err.message } },
        err.status,
      );
    }
    console.error("[unhandled]", err);
    return c.json(
      { success: false, error: { code: "internal", message: err.message } },
      500,
    );
  });
  return app;
}

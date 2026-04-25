import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { bearerAuth } from "hono/bearer-auth";
import { health } from "./routes/health.js";
import { test } from "./routes/test.js";
import { crm } from "./routes/crm.js";
import { env } from "./lib/env.js";

export function createApp() {
  const app = new Hono();
  app.use("*", logger());
  app.route("/", health);
  if (env.API_TOKEN) {
    app.use("/api/*", bearerAuth({ token: env.API_TOKEN }));
  }
  app.route("/api/v1", test);
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

import { Hono } from "hono";
import { logger } from "hono/logger";
import { health } from "./routes/health.js";
import { test } from "./routes/test.js";
import { crm } from "./routes/crm.js";

export function createApp() {
  const app = new Hono();
  app.use("*", logger());
  app.route("/", health);
  app.route("/api/v1", test);
  app.route("/api/v1/crm", crm);
  app.notFound((c) => c.json({ success: false, error: { code: "not_found" } }, 404));
  app.onError((err, c) => {
    console.error("[unhandled]", err);
    return c.json(
      { success: false, error: { code: "internal", message: err.message } },
      500,
    );
  });
  return app;
}

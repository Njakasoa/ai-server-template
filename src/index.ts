import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { env } from "./lib/env.js";

const app = createApp();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "ai-takamoa-server listening",
      port: info.port,
      env: env.NODE_ENV,
    }),
  );
});

const shutdown = (signal: string) => {
  console.log(JSON.stringify({ level: "info", msg: "shutdown", signal }));
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

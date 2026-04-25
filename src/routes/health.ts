import { Hono } from "hono";
import { detectClaudeVersion } from "../lib/claude-cli.js";

const health = new Hono();

const startedAt = Date.now();
let cachedVersion: string | null | undefined = undefined;

async function getVersion(): Promise<string | null> {
  if (cachedVersion === undefined) {
    cachedVersion = await detectClaudeVersion();
  }
  return cachedVersion;
}

health.get("/", async (c) => {
  const version = await getVersion();
  return c.json({
    ok: true,
    name: "ai-takamoa-server",
    version: "0.1.0",
    claudeCli: version,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  });
});

health.get("/health", async (c) => {
  const version = await getVersion();
  return c.json({
    ok: true,
    claudeCli: version,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  });
});

export { health };

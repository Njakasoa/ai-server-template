import { Hono } from "hono";
import { detectProviderVersion } from "../lib/ai-provider.js";
import { env } from "../lib/env.js";

const health = new Hono();

const startedAt = Date.now();
const cache: Partial<Record<"claude" | "codex", string | null>> = {};

async function getVersion(provider: "claude" | "codex"): Promise<string | null> {
  if (!(provider in cache)) {
    cache[provider] = await detectProviderVersion(provider);
  }
  return cache[provider] ?? null;
}

async function snapshot() {
  const [claudeCli, codexCli] = await Promise.all([
    getVersion("claude"),
    getVersion("codex"),
  ]);
  return {
    claudeCli,
    codexCli,
    defaultProvider: env.DEFAULT_PROVIDER,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  };
}

health.get("/", async (c) => {
  const snap = await snapshot();
  return c.json({
    ok: true,
    name: "ai-server-template",
    version: "0.1.0",
    ...snap,
  });
});

health.get("/health", async (c) => {
  const snap = await snapshot();
  return c.json({ ok: true, ...snap });
});

export { health };

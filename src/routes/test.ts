import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ClaudeCliError, runClaudeCli } from "../lib/claude-cli.js";

const TestBody = z.object({
  prompt: z.string().min(1).max(20_000),
  maxTurns: z.number().int().min(1).max(10).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
});

const test = new Hono();

test.post("/test", zValidator("json", TestBody), async (c) => {
  const body = c.req.valid("json");
  try {
    const result = await runClaudeCli(body);
    return c.json({
      success: true,
      data: {
        result: result.result,
        sessionId: result.sessionId,
        numTurns: result.numTurns,
        totalCostUsd: result.totalCostUsd,
        durationMs: result.durationMs,
      },
    });
  } catch (err) {
    if (err instanceof ClaudeCliError) {
      const status =
        err.code === "timeout"
          ? 504
          : err.code === "spawn_failed"
            ? 503
            : err.code === "parse_failed"
              ? 502
              : 500;
      return c.json(
        {
          success: false,
          error: { code: err.code, message: err.message, details: err.details ?? null },
        },
        status,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      { success: false, error: { code: "internal", message } },
      500,
    );
  }
});

export { test };

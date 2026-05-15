import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  AiProviderError,
  aiProviderSchema,
  resolveProvider,
  runProvider,
  statusForProviderError,
} from "../lib/ai-provider.js";

const TestBody = z.object({
  prompt: z.string().min(1).max(20_000),
  provider: aiProviderSchema.optional(),
  maxTurns: z.number().int().min(1).max(10).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
});

const test = new Hono();

test.post("/test", zValidator("json", TestBody), async (c) => {
  const body = c.req.valid("json");
  const provider = resolveProvider(body.provider);
  try {
    const result = await runProvider(provider, {
      prompt: body.prompt,
      maxTurns: body.maxTurns,
      timeoutMs: body.timeoutMs,
    });
    return c.json({
      success: true,
      data: {
        provider,
        result: result.result,
        sessionId: result.sessionId,
        numTurns: result.numTurns,
        totalCostUsd: result.totalCostUsd,
        durationMs: result.durationMs,
      },
    });
  } catch (err) {
    if (err instanceof AiProviderError) {
      return c.json(
        {
          success: false,
          error: {
            code: err.code,
            provider: err.provider,
            message: err.message,
            details: err.details ?? null,
          },
        },
        statusForProviderError(err.code),
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

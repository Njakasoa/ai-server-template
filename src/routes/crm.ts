import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ClaudeCliError, runClaudeCli } from "../lib/claude-cli.js";
import { extractJsonObject } from "../lib/json-extract.js";
import {
  QUALIFY_CALL_SYSTEM_PROMPT,
  buildQualifyCallUserPrompt,
} from "../prompts/qualify-call.js";
import { qualifyCallSchema } from "../types/qualification.js";

const QualifyBody = z.object({
  transcript: z.string().min(1).max(50_000),
  metadata: z.object({
    callId: z.string().max(255).optional(),
    direction: z.enum(["inbound", "outbound"]).optional(),
    durationSeconds: z.number().int().min(0).optional(),
    agentName: z.string().max(255).optional(),
    contactName: z.string().max(255).optional(),
    contactPhone: z.string().max(30).optional(),
    callRecordedByRingover: z.boolean().optional(),
  }).default({}),
  maxTurns: z.number().int().min(1).max(3).optional(),
  timeoutMs: z.number().int().min(5_000).max(300_000).optional(),
});

const crm = new Hono();

crm.post("/qualify-call", zValidator("json", QualifyBody), async (c) => {
  const body = c.req.valid("json");
  const userPrompt = buildQualifyCallUserPrompt(body);
  const fullPrompt = `${QUALIFY_CALL_SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  try {
    const cli = await runClaudeCli({
      prompt: fullPrompt,
      maxTurns: body.maxTurns ?? 1,
      timeoutMs: body.timeoutMs ?? 90_000,
    });

    const jsonStr = extractJsonObject(cli.result);
    if (!jsonStr) {
      return c.json(
        {
          success: false,
          error: {
            code: "no_json_in_output",
            message: "Claude output did not contain a JSON object",
            raw: cli.result.slice(0, 1000),
          },
        },
        502,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json(
        {
          success: false,
          error: { code: "invalid_json", message: msg, raw: jsonStr.slice(0, 1000) },
        },
        502,
      );
    }

    const validation = qualifyCallSchema.safeParse(parsed);
    if (!validation.success) {
      return c.json(
        {
          success: false,
          error: {
            code: "schema_violation",
            message: "Claude output did not match qualifyCallSchema",
            issues: validation.error.issues,
            raw: parsed,
          },
        },
        422,
      );
    }

    return c.json({
      success: true,
      data: {
        qualification: validation.data,
        meta: {
          model: "claude-cli",
          sessionId: cli.sessionId,
          numTurns: cli.numTurns,
          durationMs: cli.durationMs,
          totalCostUsd: cli.totalCostUsd,
        },
      },
    });
  } catch (err) {
    if (err instanceof ClaudeCliError) {
      const status =
        err.code === "timeout" ? 504
        : err.code === "spawn_failed" ? 503
        : err.code === "parse_failed" ? 502
        : 500;
      return c.json(
        { success: false, error: { code: err.code, message: err.message, details: err.details ?? null } },
        status,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: { code: "internal", message } }, 500);
  }
});

export { crm };

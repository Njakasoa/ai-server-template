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
import { extractJsonObject } from "../lib/json-extract.js";
import {
  QUALIFY_CALL_SYSTEM_PROMPT,
  buildQualifyCallUserPrompt,
} from "../prompts/qualify-call.js";
import { qualifyCallSchema } from "../types/qualification.js";

const QualifyScriptStep = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(["instruction", "question", "yesno", "checklist", "select"]),
  label: z.string().min(1).max(1000),
  options: z.array(z.string().min(1).max(500)).max(50).optional(),
  response: z
    .object({
      value: z.unknown(),
      notes: z.string().max(5000).optional(),
    })
    .optional(),
});

const QualifyScript = z.object({
  templateName: z.string().min(1).max(255),
  templateDescription: z.string().max(2000).optional(),
  status: z.enum(["in_progress", "completed"]).optional(),
  steps: z.array(QualifyScriptStep).min(1).max(200),
});

const QualifyBody = z
  .object({
    // Transcript is optional so callers without a Ringover integration (or with
    // Ringover but no Smart Voice transcript) can still get an AI suggestion
    // from just the call script + agent responses. At least one of the two
    // context sources must be present — enforced by the superRefine below.
    transcript: z.string().min(1).max(50_000).optional(),
    metadata: z
      .object({
        callId: z.string().max(255).optional(),
        direction: z.enum(["inbound", "outbound"]).optional(),
        durationSeconds: z.number().int().min(0).optional(),
        agentName: z.string().max(255).optional(),
        contactName: z.string().max(255).optional(),
        contactPhone: z.string().max(30).optional(),
        callRecordedByRingover: z.boolean().optional(),
      })
      .default({}),
    script: QualifyScript.optional(),
    provider: aiProviderSchema.optional(),
    maxTurns: z.number().int().min(1).max(3).optional(),
    timeoutMs: z.number().int().min(5_000).max(300_000).optional(),
  })
  .superRefine((val, ctx) => {
    const hasTranscript = !!val.transcript && val.transcript.trim().length > 0;
    const hasScript = !!val.script && val.script.steps.length > 0;
    if (!hasTranscript && !hasScript) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one of `transcript` or `script` must be provided",
        path: ["transcript"],
      });
    }
  });

const crm = new Hono();

crm.post("/qualify-call", zValidator("json", QualifyBody), async (c) => {
  const body = c.req.valid("json");
  const provider = resolveProvider(body.provider);
  const userPrompt = buildQualifyCallUserPrompt(body);
  const fullPrompt = `${QUALIFY_CALL_SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  try {
    const cli = await runProvider(provider, {
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
          model: `${provider}-cli`,
          provider,
          sessionId: cli.sessionId,
          numTurns: cli.numTurns,
          durationMs: cli.durationMs,
          totalCostUsd: cli.totalCostUsd,
        },
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
    return c.json({ success: false, error: { code: "internal", message } }, 500);
  }
});

export { crm };

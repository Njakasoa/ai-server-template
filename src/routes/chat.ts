import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ClaudeCliError, runClaudeCliStream } from "../lib/claude-cli.js";

// Phase 1 of the chatbot roadmap. This endpoint exposes the streaming chat
// surface that api-server-template's orchestrator (Phase 2) will consume.
//
// Wire shape: SSE. Event names (kept tight on purpose — see
// api-server-template/docs/chatbot-protocol.md for the upstream mapping):
//   - session     { sessionId }              first event, used for --resume
//   - delta       { text }                   incremental assistant text
//   - message     { text }                   completed assistant message
//   - result      { result, totalCostUsd, … } final accounting line from CLI
//   - error       { code, message }          terminal failure
//
// `--tools ""` stays hard-coded inside runClaudeCliStream — this route MUST
// NOT add a knob to flip it. The whole point of running ai-server in a
// hardened container is that no CRM-side caller can re-enable tool use.

const ChatBody = z.object({
  prompt: z.string().min(1).max(50_000),
  sessionId: z.string().max(255).optional(),
  systemPrompt: z.string().max(20_000).optional(),
  maxTurns: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
});

const chat = new Hono();

chat.post("/chat", zValidator("json", ChatBody), async (c) => {
  const body = c.req.valid("json");
  // Hono's streamSSE ties the SSE lifecycle to the response. We forward the
  // request abort signal into the CLI iterator so a client disconnect kills
  // the spawned claude promptly (and frees the concurrency slot).
  const abort = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abort.abort(), { once: true });

  return streamSSE(c, async (stream) => {
    const iterator = runClaudeCliStream({
      prompt: body.prompt,
      sessionId: body.sessionId,
      systemPrompt: body.systemPrompt,
      maxTurns: body.maxTurns,
      timeoutMs: body.timeoutMs,
      signal: abort.signal,
    });

    try {
      for await (const event of iterator) {
        if (stream.aborted) break;
        switch (event.kind) {
          case "session":
            await stream.writeSSE({
              event: "session",
              data: JSON.stringify({ sessionId: event.sessionId }),
            });
            break;
          case "delta":
            await stream.writeSSE({
              event: "delta",
              data: JSON.stringify({ text: event.text }),
            });
            break;
          case "message":
            await stream.writeSSE({
              event: "message",
              data: JSON.stringify({ text: event.text }),
            });
            break;
          case "result":
            await stream.writeSSE({
              event: "result",
              data: JSON.stringify({
                result: event.result,
                sessionId: event.sessionId,
                numTurns: event.numTurns,
                totalCostUsd: event.totalCostUsd,
                durationMs: event.durationMs,
              }),
            });
            break;
        }
      }
    } catch (err) {
      const errCode =
        err instanceof ClaudeCliError ? err.code : "internal";
      const errMessage =
        err instanceof Error ? err.message : String(err);
      try {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ code: errCode, message: errMessage }),
        });
      } catch {
        // stream may already be closed by the client; nothing to do.
      }
    }
  });
});

export { chat };

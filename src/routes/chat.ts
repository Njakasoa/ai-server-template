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
  systemPrompt: z.string().max(60_000).optional(),
  maxTurns: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
});

const chat = new Hono();

// Pre-content events (session, and result lines we may want to drop on
// retry) are held here as no-arg async thunks until the first real
// assistant content arrives. Once we flush, every subsequent event
// streams live.
type Emitter = () => Promise<void>;

function isSilentNonZeroExit(err: unknown): err is ClaudeCliError {
  return (
    err instanceof ClaudeCliError &&
    err.code === "non_zero_exit" &&
    !err.details?.stderr?.trim()
  );
}

chat.post("/chat", zValidator("json", ChatBody), async (c) => {
  const body = c.req.valid("json");
  // Hono's streamSSE ties the SSE lifecycle to the response. We forward the
  // request abort signal into the CLI iterator so a client disconnect kills
  // the spawned claude promptly (and frees the concurrency slot).
  const abort = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abort.abort(), { once: true });

  return streamSSE(c, async (stream) => {
    // Retry policy: when attempt 1 fails silently (non_zero_exit + empty
    // stderr) *before* any assistant content has reached the client, we
    // transparently re-spawn the CLI. The morning-idle failure mode we
    // observe in production fits this exactly — the first call after a
    // long idle window dies before producing a delta, the second call
    // works. The retry drops `sessionId` because the most common silent
    // crash shape is indistinguishable from a stale-session crash that
    // failed to print to stderr; sacrificing one turn of conversation
    // context beats hard-failing the user.
    let attempt = 0;
    let lastErr: unknown = null;

    while (attempt < 2) {
      attempt++;
      const useSession = attempt === 1 ? body.sessionId : undefined;

      const iterator = runClaudeCliStream({
        prompt: body.prompt,
        sessionId: useSession,
        systemPrompt: body.systemPrompt,
        maxTurns: body.maxTurns,
        timeoutMs: body.timeoutMs,
        signal: abort.signal,
      });

      // Buffer everything until the CLI produces real assistant content
      // (delta or message). Until then a silent failure is recoverable
      // without the client ever knowing — no phantom session frame, no
      // duplicate result. Once we flush we are committed: any later
      // failure surfaces as a normal `error` frame.
      const buffered: Emitter[] = [];
      let flushed = false;

      const flush = async () => {
        flushed = true;
        for (const op of buffered.splice(0)) {
          await op();
        }
      };
      const sendNow = async (op: Emitter) => {
        if (!flushed) await flush();
        await op();
      };
      const buffer = async (op: Emitter) => {
        if (flushed) await op();
        else buffered.push(op);
      };

      try {
        for await (const event of iterator) {
          if (stream.aborted) return;
          switch (event.kind) {
            case "session":
              await buffer(() =>
                stream.writeSSE({
                  event: "session",
                  data: JSON.stringify({ sessionId: event.sessionId }),
                }),
              );
              break;
            case "delta":
              await sendNow(() =>
                stream.writeSSE({
                  event: "delta",
                  data: JSON.stringify({ text: event.text }),
                }),
              );
              break;
            case "message":
              await sendNow(() =>
                stream.writeSSE({
                  event: "message",
                  data: JSON.stringify({ text: event.text }),
                }),
              );
              break;
            case "result": {
              if (event.isError) {
                console.error(
                  `[chat] CLI returned is_error result: subtype=${event.subtype ?? "?"} errors=${
                    event.errors ? JSON.stringify(event.errors).slice(0, 500) : "<none>"
                  }`,
                );
              }
              const payload = JSON.stringify({
                result: event.result,
                sessionId: event.sessionId,
                numTurns: event.numTurns,
                totalCostUsd: event.totalCostUsd,
                durationMs: event.durationMs,
                subtype: event.subtype,
                isError: event.isError,
                errors: event.errors,
              });
              // A result-with-isError that arrives before any content
              // looks like the silent failure mode — keep it buffered so
              // a follow-up close-exit-1 can trigger a clean retry. A
              // successful result (or one that arrives after we already
              // streamed content) gets sent normally.
              if (event.isError && !flushed) {
                await buffer(() =>
                  stream.writeSSE({ event: "result", data: payload }),
                );
              } else {
                await sendNow(() =>
                  stream.writeSSE({ event: "result", data: payload }),
                );
              }
              break;
            }
          }
        }
        // Successful completion. Make sure any leftover buffered events
        // (e.g. session-only short streams) reach the client.
        if (!flushed) await flush();
        return;
      } catch (err) {
        lastErr = err;
        const canRetry = attempt === 1 && !flushed && isSilentNonZeroExit(err);
        if (canRetry) {
          console.warn(
            `[chat] silent non_zero_exit on attempt 1; retrying once without sessionId (had_session=${
              body.sessionId ? "yes" : "no"
            })`,
          );
          // Drop buffered frames from the failed attempt — the next
          // attempt will produce its own session + result.
          buffered.length = 0;
          continue;
        }
        // Non-retryable, or content already streamed: flush whatever we
        // had so the consumer sees state (e.g. session id) before the
        // error frame.
        if (!flushed) await flush();
        break;
      }
    }

    const err = lastErr;
    if (!err) return;
    const errCode = err instanceof ClaudeCliError ? err.code : "internal";
    const errMessage = err instanceof Error ? err.message : String(err);
    try {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ code: errCode, message: errMessage }),
      });
    } catch {
      // stream may already be closed by the client; nothing to do.
    }
  });
});

export { chat };

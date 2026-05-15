import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  __resetSpawnForTest,
  __setSpawnForTest,
} from "../src/lib/claude-cli.js";
import { createApp } from "../src/app.js";

// End-to-end check that POST /api/v1/chat is wired through Hono's streamSSE
// helper and that each ClaudeStreamEvent is mapped to the expected SSE
// event name + JSON payload. We mock spawn so the test does not depend on a
// real claude binary.

type FakeProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => void;
};

function makeFakeProc(): FakeProc {
  const ee = new EventEmitter() as FakeProc;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = () => {};
  return ee;
}

type SseFrame = { event: string; data: string };

function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) {
      frames.push({ event, data: dataLines.join("\n") });
    }
  }
  return frames;
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("POST /api/v1/chat", () => {
  after(() => __resetSpawnForTest());

  it("streams session → delta → message → result events as SSE", async () => {
    const fake = makeFakeProc();
    __setSpawnForTest(((..._a: unknown[]) => fake) as never);

    setImmediate(() => {
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({ type: "system", subtype: "init", session_id: "sess_99" }) + "\n",
        ),
      );
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
          }) + "\n",
        ),
      );
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "Hi" }] },
          }) + "\n",
        ),
      );
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: "sess_99",
            duration_ms: 12,
            num_turns: 1,
            total_cost_usd: 0.0001,
            result: "Hi",
          }) + "\n",
        ),
      );
      fake.emit("close", 0);
    });

    const app = createApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      }),
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const body = await readAll(res.body);
    const frames = parseSse(body);
    const events = frames.map((f) => f.event);
    assert.deepStrictEqual(events, ["session", "delta", "message", "result"]);

    assert.deepStrictEqual(JSON.parse(frames[0].data), { sessionId: "sess_99" });
    assert.deepStrictEqual(JSON.parse(frames[1].data), { text: "Hi" });
    assert.deepStrictEqual(JSON.parse(frames[2].data), { text: "Hi" });

    const result = JSON.parse(frames[3].data);
    assert.strictEqual(result.result, "Hi");
    assert.strictEqual(result.sessionId, "sess_99");
    assert.strictEqual(result.numTurns, 1);
    assert.strictEqual(result.totalCostUsd, 0.0001);
    assert.strictEqual(result.durationMs, 12);
  });

  it("forwards is_error / errors / subtype on result frames (non-silent failure)", async () => {
    // Non-silent failure (stderr non-empty) — retry must NOT trigger; the
    // result-with-isError reaches the consumer as a regular result frame
    // followed by the error frame.
    const fake = makeFakeProc();
    __setSpawnForTest(((..._a: unknown[]) => fake) as never);
    setImmediate(() => {
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            duration_ms: 5,
            result: "",
            errors: ["model overloaded"],
          }) + "\n",
        ),
      );
      fake.stderr.emit("data", Buffer.from("Anthropic API error: model overloaded"));
      fake.emit("close", 1);
    });

    const app = createApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    assert.strictEqual(res.status, 200);
    const frames = parseSse(await readAll(res.body));
    const result = frames.find((f) => f.event === "result");
    assert.ok(result, "expected a result frame");
    const payload = JSON.parse(result!.data);
    assert.strictEqual(payload.isError, true);
    assert.strictEqual(payload.subtype, "error_during_execution");
    assert.deepStrictEqual(payload.errors, ["model overloaded"]);
    const last = frames[frames.length - 1];
    assert.strictEqual(last.event, "error");
    assert.strictEqual(JSON.parse(last.data).code, "non_zero_exit");
  });

  it("retries once on silent non_zero_exit and streams the second attempt", async () => {
    // Production failure mode: morning idle → first spawn dies with exit 1
    // and empty stderr → the route silently retries and streams the
    // recovered conversation. The client must see exactly one clean
    // session / delta / message / result sequence, no error frame.
    const stages: Array<(fake: FakeProc) => void> = [
      (fake) => {
        // Attempt 1: closes immediately with exit 1, no output.
        setImmediate(() => fake.emit("close", 1));
      },
      (fake) => {
        // Attempt 2: a fully successful stream.
        setImmediate(() => {
          fake.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                type: "system",
                subtype: "init",
                session_id: "recovered_sess",
              }) + "\n",
            ),
          );
          fake.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: "Hi" },
                },
              }) + "\n",
            ),
          );
          fake.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "Hi" }] },
              }) + "\n",
            ),
          );
          fake.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                type: "result",
                subtype: "success",
                session_id: "recovered_sess",
                duration_ms: 10,
                num_turns: 1,
                total_cost_usd: 0.0001,
                result: "Hi",
              }) + "\n",
            ),
          );
          fake.emit("close", 0);
        });
      },
    ];
    let call = 0;
    const argvCalls: string[][] = [];
    __setSpawnForTest(((_bin: string, args: string[]) => {
      argvCalls.push(args);
      const fake = makeFakeProc();
      stages[call++]?.(fake);
      return fake;
    }) as never);

    const app = createApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi", sessionId: "stale_sess" }),
      }),
    );
    assert.strictEqual(res.status, 200);
    const frames = parseSse(await readAll(res.body));
    const events = frames.map((f) => f.event);
    assert.deepStrictEqual(events, ["session", "delta", "message", "result"]);
    assert.strictEqual(
      JSON.parse(frames[0].data).sessionId,
      "recovered_sess",
      "client should only see the recovered session id, not a phantom one",
    );
    // Spawn invoked twice: once with --resume for attempt 1, once without.
    assert.strictEqual(call, 2);
    assert.ok(argvCalls[0].includes("--resume"), "attempt 1 should pass --resume");
    assert.strictEqual(
      argvCalls[1].indexOf("--resume"),
      -1,
      "attempt 2 must drop --resume so a stale-session crash doesn't repeat",
    );
  });

  it("retries when attempt 1 emits a result with is_error before any content", async () => {
    // CLI may write its error as a result line with is_error:true on
    // stdout (often with empty stderr) before exiting 1. As long as
    // nothing has been streamed to the client yet, the route treats
    // this exactly like the silent failure case.
    let call = 0;
    __setSpawnForTest(((..._a: unknown[]) => {
      const fake = makeFakeProc();
      if (call++ === 0) {
        setImmediate(() => {
          fake.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                duration_ms: 0,
                result: "",
                errors: ["transient hiccup"],
              }) + "\n",
            ),
          );
          fake.emit("close", 1);
        });
      } else {
        setImmediate(() => {
          fake.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "ok" }] },
              }) + "\n",
            ),
          );
          fake.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                type: "result",
                subtype: "success",
                duration_ms: 4,
                result: "ok",
              }) + "\n",
            ),
          );
          fake.emit("close", 0);
        });
      }
      return fake;
    }) as never);

    const app = createApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    const frames = parseSse(await readAll(res.body));
    // No error frame, no phantom is_error result.
    assert.ok(
      !frames.some((f) => f.event === "error"),
      "no error frame should reach the client after a successful retry",
    );
    const resultFrame = frames.find((f) => f.event === "result");
    assert.ok(resultFrame);
    const payload = JSON.parse(resultFrame!.data);
    assert.strictEqual(payload.result, "ok");
    assert.notStrictEqual(payload.isError, true);
  });

  it("retries without sessionId when attempt 1 reports session_not_found", async () => {
    // Covers two real-world cases via the same code path:
    //  1. The CLI purged the session past its retention window (stale id).
    //  2. The caller fed a sessionId minted by the OTHER provider (e.g. a
    //     Claude UUID handed to Codex). Both surface as session_not_found
    //     once the wrapper's regex catches the stderr; the chat route then
    //     drops the id and starts a fresh conversation transparently.
    const stages: Array<(fake: FakeProc) => void> = [
      (fake) => {
        setImmediate(() => {
          // stderr matches claude-cli.ts SESSION_MISSING_PATTERNS (`/--resume/i`).
          fake.stderr.emit("data", Buffer.from("Error: session not found for --resume"));
          fake.emit("close", 1);
        });
      },
      (fake) => {
        setImmediate(() => {
          fake.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                type: "system",
                subtype: "init",
                session_id: "fresh_sess",
              }) + "\n",
            ),
          );
          fake.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "ok" }] },
              }) + "\n",
            ),
          );
          fake.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                type: "result",
                subtype: "success",
                session_id: "fresh_sess",
                duration_ms: 7,
                num_turns: 1,
                result: "ok",
              }) + "\n",
            ),
          );
          fake.emit("close", 0);
        });
      },
    ];
    let call = 0;
    const argvCalls: string[][] = [];
    __setSpawnForTest(((_bin: string, args: string[]) => {
      argvCalls.push(args);
      const fake = makeFakeProc();
      stages[call++]?.(fake);
      return fake;
    }) as never);

    const app = createApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi", sessionId: "from_other_provider" }),
      }),
    );
    assert.strictEqual(res.status, 200);
    const frames = parseSse(await readAll(res.body));
    assert.ok(
      !frames.some((f) => f.event === "error"),
      "session_not_found on attempt 1 must not surface as an error frame",
    );
    const resultFrame = frames.find((f) => f.event === "result");
    assert.ok(resultFrame);
    assert.strictEqual(JSON.parse(resultFrame!.data).result, "ok");
    assert.strictEqual(call, 2);
    assert.ok(argvCalls[0].includes("--resume"), "attempt 1 must pass --resume");
    assert.strictEqual(
      argvCalls[1].indexOf("--resume"),
      -1,
      "attempt 2 must drop --resume",
    );
  });

  it("does not retry when the failure has stderr (caller can see the cause)", async () => {
    let call = 0;
    __setSpawnForTest(((..._a: unknown[]) => {
      call++;
      const fake = makeFakeProc();
      setImmediate(() => {
        fake.stderr.emit("data", Buffer.from("permission denied"));
        fake.emit("close", 1);
      });
      return fake;
    }) as never);

    const app = createApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    const frames = parseSse(await readAll(res.body));
    const last = frames[frames.length - 1];
    assert.strictEqual(last.event, "error");
    assert.strictEqual(call, 1, "spawn must be called exactly once");
  });

  it("does not retry once content has been streamed to the client", async () => {
    let call = 0;
    __setSpawnForTest(((..._a: unknown[]) => {
      call++;
      const fake = makeFakeProc();
      setImmediate(() => {
        fake.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({ type: "system", subtype: "init", session_id: "s" }) + "\n",
          ),
        );
        fake.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "He" },
              },
            }) + "\n",
          ),
        );
        // Silent non_zero_exit AFTER content already streamed.
        fake.emit("close", 1);
      });
      return fake;
    }) as never);

    const app = createApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    const frames = parseSse(await readAll(res.body));
    const kinds = frames.map((f) => f.event);
    assert.deepStrictEqual(kinds, ["session", "delta", "error"]);
    assert.strictEqual(call, 1, "spawn must not be retried once content has been streamed");
  });

  it("surfaces error frame when both attempts fail silently", async () => {
    let call = 0;
    __setSpawnForTest(((..._a: unknown[]) => {
      call++;
      const fake = makeFakeProc();
      setImmediate(() => fake.emit("close", 1));
      return fake;
    }) as never);

    const app = createApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    const frames = parseSse(await readAll(res.body));
    assert.strictEqual(call, 2, "spawn must be retried exactly once");
    // Client should see only the final error frame, no phantom frames
    // from either attempt.
    assert.deepStrictEqual(frames.map((f) => f.event), ["error"]);
    const payload = JSON.parse(frames[0].data);
    assert.strictEqual(payload.code, "non_zero_exit");
  });

  it("emits an error SSE event when the CLI fails", async () => {
    const fake = makeFakeProc();
    __setSpawnForTest(((..._a: unknown[]) => fake) as never);
    setImmediate(() => {
      fake.stderr.emit("data", Buffer.from("boom"));
      fake.emit("close", 2);
    });

    const app = createApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    assert.strictEqual(res.status, 200);
    const frames = parseSse(await readAll(res.body));
    const last = frames[frames.length - 1];
    assert.strictEqual(last.event, "error");
    const payload = JSON.parse(last.data);
    assert.strictEqual(payload.code, "non_zero_exit");
    assert.match(payload.message, /code 2/);
  });

  it("rejects an empty prompt with 400 (zod validation)", async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request("http://x/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "" }),
      }),
    );
    assert.strictEqual(res.status, 400);
  });
});

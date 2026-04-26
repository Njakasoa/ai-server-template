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

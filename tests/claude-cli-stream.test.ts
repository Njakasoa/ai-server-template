import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  __resetSpawnForTest,
  __setSpawnForTest,
  ClaudeCliError,
  runClaudeCliStream,
  type ClaudeStreamEvent,
} from "../src/lib/claude-cli.js";

// Pin the JSONL stream-json contract that ai-server expects from the claude
// CLI. The real CLI's exact event shapes can drift across versions; the
// classifier in claude-cli.ts is intentionally narrow — these tests fail
// loudly if a CLI bump regresses the wire format we consume.

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

async function collect(it: AsyncGenerator<ClaudeStreamEvent>): Promise<ClaudeStreamEvent[]> {
  const out: ClaudeStreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("runClaudeCliStream", () => {
  before(() => {
    // No-op; per-test setup overrides spawn.
  });
  after(() => __resetSpawnForTest());

  it("emits session, delta, message, result in order", async () => {
    const fake = makeFakeProc();
    let argv: string[] = [];
    __setSpawnForTest(((_bin: string, args: string[]) => {
      argv = args;
      return fake;
    }) as never);

    const it = runClaudeCliStream({ prompt: "hi", timeoutMs: 5_000 });

    setImmediate(() => {
      // Lines arrive across multiple stdout chunks, including a chunk that
      // splits a JSON object across the buffer boundary.
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({ type: "system", subtype: "init", session_id: "s_1" }) + "\n",
        ),
      );
      const delta = JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      });
      // Split the delta line across two writes to exercise the line buffer.
      fake.stdout.emit("data", Buffer.from(delta.slice(0, 20)));
      fake.stdout.emit("data", Buffer.from(delta.slice(20) + "\n"));
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "lo" },
            },
          }) + "\n",
        ),
      );
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "Hello" }] },
          }) + "\n",
        ),
      );
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: "s_1",
            num_turns: 1,
            total_cost_usd: 0.0042,
            duration_ms: 750,
            result: "Hello",
          }) + "\n",
        ),
      );
      fake.emit("close", 0);
    });

    const events = await collect(it);
    const kinds = events.map((e) => e.kind);
    assert.deepStrictEqual(kinds, ["session", "delta", "delta", "message", "result"]);
    assert.strictEqual((events[0] as Extract<ClaudeStreamEvent, { kind: "session" }>).sessionId, "s_1");
    assert.strictEqual((events[1] as Extract<ClaudeStreamEvent, { kind: "delta" }>).text, "Hel");
    assert.strictEqual((events[2] as Extract<ClaudeStreamEvent, { kind: "delta" }>).text, "lo");
    assert.strictEqual((events[3] as Extract<ClaudeStreamEvent, { kind: "message" }>).text, "Hello");
    const r = events[4] as Extract<ClaudeStreamEvent, { kind: "result" }>;
    assert.strictEqual(r.result, "Hello");
    assert.strictEqual(r.totalCostUsd, 0.0042);
    assert.strictEqual(r.numTurns, 1);
    assert.strictEqual(r.durationMs, 750);

    // Check that the spawn args carry the hardening flags + verbose stream
    // format. --tools "" must always be present.
    assert.ok(argv.includes("--output-format"), "missing --output-format flag");
    assert.ok(argv.includes("stream-json"), "missing stream-json value");
    assert.ok(argv.includes("--verbose"), "missing --verbose flag");
    const toolsIdx = argv.indexOf("--tools");
    assert.ok(toolsIdx !== -1 && argv[toolsIdx + 1] === "", "must pass --tools \"\"");
  });

  it("includes --resume when sessionId is provided", async () => {
    const fake = makeFakeProc();
    let argv: string[] = [];
    __setSpawnForTest(((_bin: string, args: string[]) => {
      argv = args;
      return fake;
    }) as never);

    const it = runClaudeCliStream({
      prompt: "again",
      sessionId: "sess_abc",
      timeoutMs: 5_000,
    });
    setImmediate(() => {
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: "sess_abc",
            duration_ms: 10,
            result: "",
          }) + "\n",
        ),
      );
      fake.emit("close", 0);
    });
    await collect(it);

    const resumeIdx = argv.indexOf("--resume");
    assert.ok(resumeIdx !== -1, "missing --resume flag");
    assert.strictEqual(argv[resumeIdx + 1], "sess_abc");
  });

  it("includes --append-system-prompt when systemPrompt is provided", async () => {
    const fake = makeFakeProc();
    let argv: string[] = [];
    __setSpawnForTest(((_bin: string, args: string[]) => {
      argv = args;
      return fake;
    }) as never);

    const it = runClaudeCliStream({
      prompt: "x",
      systemPrompt: "You are a CRM helper.",
      timeoutMs: 5_000,
    });
    setImmediate(() => fake.emit("close", 0));
    await collect(it);

    const idx = argv.indexOf("--append-system-prompt");
    assert.ok(idx !== -1);
    assert.strictEqual(argv[idx + 1], "You are a CRM helper.");
  });

  it("skips malformed JSON lines without crashing", async () => {
    const fake = makeFakeProc();
    __setSpawnForTest(((..._a: unknown[]) => fake) as never);

    const it = runClaudeCliStream({ prompt: "x", timeoutMs: 5_000 });
    setImmediate(() => {
      fake.stdout.emit("data", Buffer.from("not-json line\n"));
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({ type: "system", subtype: "init", session_id: "s2" }) + "\n",
        ),
      );
      fake.emit("close", 0);
    });
    const events = await collect(it);
    assert.deepStrictEqual(events.map((e) => e.kind), ["session"]);
  });

  it("skips unknown event types (forward-compat)", async () => {
    const fake = makeFakeProc();
    __setSpawnForTest(((..._a: unknown[]) => fake) as never);

    const it = runClaudeCliStream({ prompt: "x", timeoutMs: 5_000 });
    setImmediate(() => {
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({ type: "tool_call_started", tool: "Bash" }) + "\n",
        ),
      );
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "result",
            subtype: "success",
            duration_ms: 1,
            result: "",
          }) + "\n",
        ),
      );
      fake.emit("close", 0);
    });
    const events = await collect(it);
    assert.deepStrictEqual(events.map((e) => e.kind), ["result"]);
  });

  it("rejects with timeout when CLI hangs", async () => {
    const fake = makeFakeProc();
    let killed = false;
    fake.kill = () => {
      killed = true;
      setImmediate(() => fake.emit("close", null));
    };
    __setSpawnForTest(((..._a: unknown[]) => fake) as never);

    const it = runClaudeCliStream({ prompt: "x", timeoutMs: 30 });
    await assert.rejects(collect(it), (err) => {
      assert.ok(err instanceof ClaudeCliError);
      assert.strictEqual((err as ClaudeCliError).code, "timeout");
      return true;
    });
    assert.strictEqual(killed, true);
  });

  it("rejects with non_zero_exit when CLI exits with a non-zero code", async () => {
    const fake = makeFakeProc();
    __setSpawnForTest(((..._a: unknown[]) => fake) as never);

    const it = runClaudeCliStream({ prompt: "x", timeoutMs: 5_000 });
    setImmediate(() => {
      fake.stderr.emit("data", Buffer.from("boom"));
      fake.emit("close", 2);
    });
    await assert.rejects(collect(it), (err) => {
      assert.ok(err instanceof ClaudeCliError);
      assert.strictEqual((err as ClaudeCliError).code, "non_zero_exit");
      return true;
    });
  });

  it("rejects with spawn_failed on prompt empty", async () => {
    await assert.rejects(
      collect(runClaudeCliStream({ prompt: "   " })),
      (err) => {
        assert.ok(err instanceof ClaudeCliError);
        assert.strictEqual((err as ClaudeCliError).code, "spawn_failed");
        return true;
      },
    );
  });

  it("rejects with spawn_failed on spawn error event", async () => {
    const fake = makeFakeProc();
    __setSpawnForTest(((..._a: unknown[]) => fake) as never);
    const it = runClaudeCliStream({ prompt: "x", timeoutMs: 5_000 });
    setImmediate(() => fake.emit("error", new Error("ENOENT")));
    await assert.rejects(collect(it), (err) => {
      assert.ok(err instanceof ClaudeCliError);
      assert.strictEqual((err as ClaudeCliError).code, "spawn_failed");
      return true;
    });
  });

  it("kills the CLI when the consumer abandons the iterator (release semaphore)", async () => {
    const fake = makeFakeProc();
    let killed = false;
    fake.kill = () => {
      killed = true;
      setImmediate(() => fake.emit("close", null));
    };
    __setSpawnForTest(((..._a: unknown[]) => fake) as never);

    const it = runClaudeCliStream({ prompt: "x", timeoutMs: 5_000 });
    setImmediate(() => {
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({ type: "system", subtype: "init", session_id: "s" }) + "\n",
        ),
      );
    });

    const first = await it.next();
    assert.strictEqual(first.done, false);
    assert.strictEqual((first.value as any).kind, "session");
    // Consumer abandons the generator without finishing — finally{} must
    // fire and SIGTERM the child.
    await it.return(undefined);
    assert.strictEqual(killed, true);
  });

  it("kills the CLI when the abort signal fires", async () => {
    const fake = makeFakeProc();
    let killed = false;
    fake.kill = () => {
      killed = true;
      setImmediate(() => fake.emit("close", null));
    };
    __setSpawnForTest(((..._a: unknown[]) => fake) as never);

    const ac = new AbortController();
    const it = runClaudeCliStream({ prompt: "x", timeoutMs: 5_000, signal: ac.signal });
    // Trigger abort before any data arrives.
    setImmediate(() => ac.abort());

    await assert.rejects(collect(it), (err) => {
      assert.ok(err instanceof ClaudeCliError);
      assert.strictEqual((err as ClaudeCliError).code, "aborted");
      return true;
    });
    assert.strictEqual(killed, true);
  });
});

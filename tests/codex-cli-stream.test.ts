import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  __resetCodexSpawnForTest,
  __setCodexSpawnForTest,
  CodexCliError,
  runCodexCliStream,
  type CodexStreamEvent,
} from "../src/lib/codex-cli.js";

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

function emitLine(fake: FakeProc, obj: unknown): void {
  fake.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
}

async function collect(
  iter: AsyncGenerator<CodexStreamEvent, void, void>,
): Promise<CodexStreamEvent[]> {
  const out: CodexStreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe("runCodexCliStream", () => {
  after(() => __resetCodexSpawnForTest());

  it("yields session → delta → message → result", async () => {
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const iter = runCodexCliStream({ prompt: "hi", timeoutMs: 5_000 });

    setImmediate(() => {
      emitLine(fake, { type: "thread.started", thread_id: "th_x" });
      emitLine(fake, { type: "turn.started" });
      emitLine(fake, {
        type: "item.started",
        item: { id: "m1", type: "agent_message", text: "" },
      });
      emitLine(fake, {
        type: "item.updated",
        item: { id: "m1", type: "agent_message", text: "Hi" },
      });
      emitLine(fake, {
        type: "item.updated",
        item: { id: "m1", type: "agent_message", text: "Hi there" },
      });
      emitLine(fake, {
        type: "item.completed",
        item: { id: "m1", type: "agent_message", text: "Hi there" },
      });
      emitLine(fake, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } });
      fake.emit("close", 0);
    });

    const events = await collect(iter);
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ["session", "delta", "delta", "message", "result"]);

    const session = events[0];
    assert.ok(session.kind === "session");
    assert.equal(session.sessionId, "th_x");

    // First delta emits "Hi" (full), second emits " there" (suffix).
    assert.ok(events[1].kind === "delta");
    assert.equal((events[1] as Extract<CodexStreamEvent, { kind: "delta" }>).text, "Hi");
    assert.ok(events[2].kind === "delta");
    assert.equal(
      (events[2] as Extract<CodexStreamEvent, { kind: "delta" }>).text,
      " there",
    );

    assert.ok(events[3].kind === "message");
    assert.equal((events[3] as Extract<CodexStreamEvent, { kind: "message" }>).text, "Hi there");

    assert.ok(events[4].kind === "result");
    const result = events[4] as Extract<CodexStreamEvent, { kind: "result" }>;
    assert.equal(result.result, "Hi there");
    assert.equal(result.sessionId, "th_x");
    assert.equal(result.numTurns, 1);
    assert.equal(result.isError, false);
  });

  it("synthesizes a delta when codex jumps straight to item.completed", async () => {
    // Codex skips `item.updated` for short answers. The wrapper must still
    // emit one `delta` carrying the full text so delta-only consumers (the
    // CRM chat orchestrator) render the message instead of an empty bubble.
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const iter = runCodexCliStream({ prompt: "hi", timeoutMs: 5_000 });
    setImmediate(() => {
      emitLine(fake, { type: "thread.started", thread_id: "th_z" });
      emitLine(fake, { type: "turn.started" });
      emitLine(fake, {
        type: "item.started",
        item: { id: "m9", type: "agent_message", text: "" },
      });
      // No item.updated — straight to completed.
      emitLine(fake, {
        type: "item.completed",
        item: { id: "m9", type: "agent_message", text: "Voici la réponse." },
      });
      emitLine(fake, { type: "turn.completed", usage: {} });
      fake.emit("close", 0);
    });

    const events = await collect(iter);
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ["session", "delta", "message", "result"]);
    assert.equal(
      (events[1] as Extract<CodexStreamEvent, { kind: "delta" }>).text,
      "Voici la réponse.",
    );
    assert.equal(
      (events[2] as Extract<CodexStreamEvent, { kind: "message" }>).text,
      "Voici la réponse.",
    );
  });

  it("does not duplicate text when deltas already covered the full message", async () => {
    // When item.updated already streamed the whole text, item.completed
    // must NOT emit another delta — only the message.
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const iter = runCodexCliStream({ prompt: "hi", timeoutMs: 5_000 });
    setImmediate(() => {
      emitLine(fake, { type: "thread.started", thread_id: "th_w" });
      emitLine(fake, {
        type: "item.updated",
        item: { id: "m8", type: "agent_message", text: "Salut" },
      });
      emitLine(fake, {
        type: "item.completed",
        item: { id: "m8", type: "agent_message", text: "Salut" },
      });
      emitLine(fake, { type: "turn.completed", usage: {} });
      fake.emit("close", 0);
    });

    const events = await collect(iter);
    assert.deepEqual(events.map((e) => e.kind), ["session", "delta", "message", "result"]);
  });

  it("emits an is_error result on turn.failed", async () => {
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const iter = runCodexCliStream({ prompt: "hi", timeoutMs: 5_000 });
    setImmediate(() => {
      emitLine(fake, { type: "thread.started", thread_id: "th_y" });
      emitLine(fake, {
        type: "turn.failed",
        error: { message: "model overloaded" },
      });
      fake.emit("close", 0);
    });

    const events = await collect(iter);
    const result = events.find((e) => e.kind === "result") as
      | Extract<CodexStreamEvent, { kind: "result" }>
      | undefined;
    assert.ok(result, "result event expected");
    assert.equal(result.isError, true);
    assert.deepEqual(result.errors, ["model overloaded"]);
  });

  it("rejects with session_not_found when codex resume <id> fails because the session is gone", async () => {
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const iter = runCodexCliStream({ prompt: "x", sessionId: "th_gone", timeoutMs: 5_000 });
    setImmediate(() => {
      fake.stderr.emit("data", Buffer.from("Error: session not found"));
      fake.emit("close", 1);
    });

    await assert.rejects(collect(iter), (err) => {
      assert.ok(err instanceof CodexCliError);
      assert.equal((err as CodexCliError).code, "session_not_found");
      return true;
    });
  });

  it("kills the CLI when the abort signal fires", async () => {
    const fake = makeFakeProc();
    let killed = false;
    fake.kill = () => {
      killed = true;
      setImmediate(() => fake.emit("close", null));
    };
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const ctrl = new AbortController();
    const iter = runCodexCliStream({ prompt: "x", timeoutMs: 5_000, signal: ctrl.signal });
    ctrl.abort();

    await assert.rejects(collect(iter), (err) => {
      assert.ok(err instanceof CodexCliError);
      assert.equal((err as CodexCliError).code, "aborted");
      return true;
    });
    assert.equal(killed, true);
  });
});

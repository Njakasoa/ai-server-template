import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  __resetCodexSpawnForTest,
  __setCodexSpawnForTest,
  CodexCliError,
  runCodexCli,
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

describe("runCodexCli", () => {
  after(() => __resetCodexSpawnForTest());

  it("aggregates JSONL events into the final agent_message", async () => {
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const promise = runCodexCli({ prompt: "hi", timeoutMs: 5_000 });

    setImmediate(() => {
      emitLine(fake, { type: "thread.started", thread_id: "th_1" });
      emitLine(fake, { type: "turn.started" });
      emitLine(fake, {
        type: "item.started",
        item: { id: "m_1", type: "agent_message", text: "" },
      });
      emitLine(fake, {
        type: "item.updated",
        item: { id: "m_1", type: "agent_message", text: "Hel" },
      });
      emitLine(fake, {
        type: "item.completed",
        item: { id: "m_1", type: "agent_message", text: "Hello" },
      });
      emitLine(fake, { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } });
      fake.emit("close", 0);
    });

    const r = await promise;
    assert.equal(r.result, "Hello");
    assert.equal(r.sessionId, "th_1");
    assert.equal(r.numTurns, 1);
    assert.equal(r.totalCostUsd, undefined);
    assert.ok(r.durationMs >= 0);
  });

  it("synthesizes a result when codex exits 0 without turn.completed", async () => {
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const promise = runCodexCli({ prompt: "hi", timeoutMs: 5_000 });

    setImmediate(() => {
      emitLine(fake, { type: "thread.started", thread_id: "th_42" });
      emitLine(fake, {
        type: "item.completed",
        item: { id: "m_2", type: "agent_message", text: "ok" },
      });
      fake.emit("close", 0);
    });

    const r = await promise;
    assert.equal(r.result, "ok");
    assert.equal(r.sessionId, "th_42");
  });

  it("rejects with non_zero_exit when codex returns code != 0", async () => {
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const promise = runCodexCli({ prompt: "x", timeoutMs: 5_000 });
    setImmediate(() => {
      fake.stderr.emit("data", Buffer.from("boom"));
      fake.emit("close", 2);
    });

    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof CodexCliError);
      assert.equal((err as CodexCliError).code, "non_zero_exit");
      return true;
    });
  });

  it("rejects with session_not_found when --resume <id> stderr signals a missing session", async () => {
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const promise = runCodexCli({
      prompt: "x",
      sessionId: "th_gone",
      timeoutMs: 5_000,
    });
    setImmediate(() => {
      fake.stderr.emit("data", Buffer.from("Error: session not found"));
      fake.emit("close", 1);
    });

    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof CodexCliError);
      assert.equal((err as CodexCliError).code, "session_not_found");
      return true;
    });
  });

  it("classifies codex-cli 0.130.0 'no rollout found for thread id' as session_not_found", async () => {
    // Real stderr observed when feeding codex a UUID it does not own
    // (e.g. a Claude sessionId passed to `provider: "codex"`). Locking
    // this in so a future regex tightening can't silently break the
    // cross-provider fallback path.
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const promise = runCodexCli({
      prompt: "x",
      sessionId: "bd0fa4af-073b-46c3-ac27-923e72cd5fe7",
      timeoutMs: 5_000,
    });
    setImmediate(() => {
      fake.stderr.emit(
        "data",
        Buffer.from(
          "Error: thread/resume: thread/resume failed: no rollout found for thread id bd0fa4af-073b-46c3-ac27-923e72cd5fe7 (code -32600)",
        ),
      );
      fake.emit("close", 1);
    });

    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof CodexCliError);
      assert.equal((err as CodexCliError).code, "session_not_found");
      return true;
    });
  });

  it("keeps non_zero_exit when no sessionId was provided (fresh-conversation crash)", async () => {
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const promise = runCodexCli({ prompt: "x", timeoutMs: 5_000 });
    setImmediate(() => {
      fake.stderr.emit("data", Buffer.from("Error: session not found"));
      fake.emit("close", 1);
    });

    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof CodexCliError);
      assert.equal((err as CodexCliError).code, "non_zero_exit");
      return true;
    });
  });

  it("rejects with non_zero_exit when turn.failed surfaces an error", async () => {
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    const promise = runCodexCli({ prompt: "x", timeoutMs: 5_000 });
    setImmediate(() => {
      emitLine(fake, { type: "thread.started", thread_id: "th_err" });
      emitLine(fake, {
        type: "turn.failed",
        error: { message: "model overloaded" },
      });
      fake.emit("close", 0);
    });

    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof CodexCliError);
      assert.equal((err as CodexCliError).code, "non_zero_exit");
      return true;
    });
  });

  it("rejects with timeout when CLI hangs", async () => {
    const fake = makeFakeProc();
    let killed = false;
    fake.kill = () => {
      killed = true;
      setImmediate(() => fake.emit("close", null));
    };
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);

    await assert.rejects(
      runCodexCli({ prompt: "x", timeoutMs: 50 }),
      (err) => {
        assert.ok(err instanceof CodexCliError);
        assert.equal((err as CodexCliError).code, "timeout");
        return true;
      },
    );
    assert.equal(killed, true);
  });

  it("rejects with spawn_failed on prompt empty", async () => {
    await assert.rejects(runCodexCli({ prompt: "   " }), (err) => {
      assert.ok(err instanceof CodexCliError);
      assert.equal((err as CodexCliError).code, "spawn_failed");
      return true;
    });
  });

  it("rejects with spawn_failed on spawn error event", async () => {
    const fake = makeFakeProc();
    __setCodexSpawnForTest(((..._a: unknown[]) => fake) as never);
    const promise = runCodexCli({ prompt: "x", timeoutMs: 5_000 });
    setImmediate(() => fake.emit("error", new Error("ENOENT")));
    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof CodexCliError);
      assert.equal((err as CodexCliError).code, "spawn_failed");
      return true;
    });
  });
});

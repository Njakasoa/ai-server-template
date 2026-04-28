import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  __resetSpawnForTest,
  __setSpawnForTest,
  ClaudeCliError,
  runClaudeCli,
} from "../src/lib/claude-cli.js";

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

describe("runClaudeCli", () => {
  after(() => __resetSpawnForTest());

  it("parses a valid JSON stdout", async () => {
    const fake = makeFakeProc();
    __setSpawnForTest(((..._args: unknown[]) => fake) as never);

    const promise = runClaudeCli({ prompt: "hi", timeoutMs: 5_000 });

    setImmediate(() => {
      fake.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            result: "hello",
            session_id: "abc",
            num_turns: 1,
            total_cost_usd: 0.001,
          }),
        ),
      );
      fake.emit("close", 0);
    });

    const r = await promise;
    assert.equal(r.result, "hello");
    assert.equal(r.sessionId, "abc");
    assert.equal(r.numTurns, 1);
    assert.equal(r.totalCostUsd, 0.001);
    assert.ok(r.durationMs >= 0);
  });

  it("rejects with non_zero_exit when claude returns code != 0", async () => {
    const fake = makeFakeProc();
    __setSpawnForTest(((..._args: unknown[]) => fake) as never);

    const promise = runClaudeCli({ prompt: "x", timeoutMs: 5_000 });
    setImmediate(() => {
      fake.stderr.emit("data", Buffer.from("boom"));
      fake.emit("close", 2);
    });

    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof ClaudeCliError);
      assert.equal((err as ClaudeCliError).code, "non_zero_exit");
      return true;
    });
  });


  it("rejects with parse_failed when stdout is not JSON", async () => {
    const fake = makeFakeProc();
    __setSpawnForTest(((..._args: unknown[]) => fake) as never);

    const promise = runClaudeCli({ prompt: "x", timeoutMs: 5_000 });
    setImmediate(() => {
      fake.stdout.emit("data", Buffer.from("not json"));
      fake.emit("close", 0);
    });

    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof ClaudeCliError);
      assert.equal((err as ClaudeCliError).code, "parse_failed");
      return true;
    });
  });

  it("rejects with timeout when CLI hangs", async () => {
    const fake = makeFakeProc();
    let killed = false;
    fake.kill = () => {
      killed = true;
      // simulate process exit after kill
      setImmediate(() => fake.emit("close", null));
    };
    __setSpawnForTest(((..._args: unknown[]) => fake) as never);

    await assert.rejects(
      runClaudeCli({ prompt: "x", timeoutMs: 50 }),
      (err) => {
        assert.ok(err instanceof ClaudeCliError);
        assert.equal((err as ClaudeCliError).code, "timeout");
        return true;
      },
    );
    assert.equal(killed, true);
  });

  it("rejects with spawn_failed on prompt empty", async () => {
    await assert.rejects(runClaudeCli({ prompt: "   " }), (err) => {
      assert.ok(err instanceof ClaudeCliError);
      assert.equal((err as ClaudeCliError).code, "spawn_failed");
      return true;
    });
  });

  it("rejects with spawn_failed on spawn error event", async () => {
    const fake = makeFakeProc();
    __setSpawnForTest(((..._args: unknown[]) => fake) as never);
    const promise = runClaudeCli({ prompt: "x", timeoutMs: 5_000 });
    setImmediate(() => fake.emit("error", new Error("ENOENT")));
    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof ClaudeCliError);
      assert.equal((err as ClaudeCliError).code, "spawn_failed");
      return true;
    });
  });
});

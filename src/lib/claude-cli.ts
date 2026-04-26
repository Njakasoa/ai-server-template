import { spawn, type SpawnOptions } from "node:child_process";
import { env } from "./env.js";
import { Semaphore, SemaphoreFullError } from "./semaphore.js";

export type ClaudeCliErrorCode =
  | "spawn_failed"
  | "timeout"
  | "non_zero_exit"
  | "parse_failed"
  | "overloaded"
  | "aborted";

export class ClaudeCliError extends Error {
  constructor(
    public readonly code: ClaudeCliErrorCode,
    message: string,
    public readonly details?: { stderr?: string; stdout?: string; exitCode?: number | null },
  ) {
    super(`[${code}] ${message}`);
    this.name = "ClaudeCliError";
  }
}

export type ClaudeCliResult = {
  result: string;
  sessionId?: string;
  numTurns?: number;
  totalCostUsd?: number;
  durationMs: number;
  raw: unknown;
};

export type ClaudeCliOptions = {
  prompt: string;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
};

type SpawnFn = typeof spawn;

let spawnImpl: SpawnFn = spawn;

export function __setSpawnForTest(fn: SpawnFn): void {
  spawnImpl = fn;
}

export function __resetSpawnForTest(): void {
  spawnImpl = spawn;
}

export async function runClaudeCli(opts: ClaudeCliOptions): Promise<ClaudeCliResult> {
  const prompt = opts.prompt.trim();
  if (!prompt) {
    throw new ClaudeCliError("spawn_failed", "prompt is empty");
  }

  const maxTurns = opts.maxTurns ?? env.CLAUDE_DEFAULT_MAX_TURNS;
  const timeoutMs = opts.timeoutMs ?? env.CLAUDE_TIMEOUT_MS;
  // Hardening: this server only does text-in/JSON-out. Disable ALL claude
  // tools (Bash, Read, Write, WebFetch, ...) so a crafted prompt cannot make
  // claude shell out and reach the mounted OAuth credentials. `--tools ""`
  // turns the entire tool set off; claude still produces a normal response.
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--max-turns",
    String(maxTurns),
    "--tools",
    "",
  ];

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  };

  let release: () => void;
  try {
    release = await claudeSemaphore.acquire();
  } catch (err) {
    if (err instanceof SemaphoreFullError) {
      throw new ClaudeCliError(
        "overloaded",
        "too many concurrent claude invocations; retry later",
      );
    }
    throw err;
  }

  const start = Date.now();

  return new Promise<ClaudeCliResult>((resolve, reject) => {
    const proc = spawnImpl(env.CLAUDE_BIN, args, spawnOpts);

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      release();
      fn();
    };

    const timeout = setTimeout(() => {
      killedByTimeout = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      finish(() => reject(new ClaudeCliError("spawn_failed", err.message)));
    });

    proc.on("close", (code: number | null) => {
      clearTimeout(timeout);

      if (killedByTimeout) {
        return finish(() =>
          reject(new ClaudeCliError("timeout", `claude CLI exceeded ${timeoutMs}ms`, { stderr, stdout })),
        );
      }

      if (code !== 0) {
        return finish(() =>
          reject(
            new ClaudeCliError(
              "non_zero_exit",
              `claude CLI exited with code ${code}`,
              { stderr, stdout, exitCode: code },
            ),
          ),
        );
      }

      try {
        const parsed = JSON.parse(stdout) as {
          result?: string;
          session_id?: string;
          num_turns?: number;
          total_cost_usd?: number;
        };
        finish(() =>
          resolve({
            result: parsed.result ?? "",
            sessionId: parsed.session_id,
            numTurns: parsed.num_turns,
            totalCostUsd: parsed.total_cost_usd,
            durationMs: Date.now() - start,
            raw: parsed,
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        finish(() =>
          reject(
            new ClaudeCliError("parse_failed", `failed to parse JSON: ${msg}`, {
              stdout: stdout.slice(0, 500),
              stderr,
            }),
          ),
        );
      }
    });
  });
}

const claudeSemaphore = new Semaphore(
  env.MAX_CONCURRENT_CLAUDE,
  env.MAX_QUEUED_CLAUDE,
);

// ─── Streaming chat (Phase 1 of the chatbot roadmap) ─────────
// Same hardening as runClaudeCli (`--tools ""`), plus:
//   - `--output-format stream-json --verbose` to get JSONL events on stdout.
//   - `--resume <sessionId>` for multi-turn continuity. The host bind mount
//     for /home/claude/.claude (see docker-compose.yml) keeps session state
//     across container restarts, so --resume actually finds something.
//   - `--append-system-prompt` for callers that want to inject context.
// The yielded events are intentionally normalized into a small typed union
// so the api-server orchestrator (Phase 2) does not have to track CLI-version
// drift in event shapes — unknown line types are silently skipped.

export type ClaudeStreamEvent =
  | { kind: "session"; sessionId: string; raw: unknown }
  | { kind: "delta"; text: string; raw: unknown }
  | { kind: "message"; text: string; raw: unknown }
  | {
      kind: "result";
      result: string;
      sessionId?: string;
      numTurns?: number;
      totalCostUsd?: number;
      durationMs: number;
      raw: unknown;
    };

export type ClaudeChatOptions = {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  maxTurns?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
};

// Hard cap on event queue depth. The CLI can outpace the SSE consumer
// briefly (network slow, browser tab backgrounded). 1000 events ≈ a few MB
// in the worst case (mostly small deltas) — enough headroom without risking
// OOM if the consumer wedges.
const MAX_QUEUED_EVENTS = 1000;

function classifyStreamLine(parsed: any): ClaudeStreamEvent | null {
  if (!parsed || typeof parsed !== "object") return null;
  const type = parsed.type;
  if (type === "system" && parsed.subtype === "init" && typeof parsed.session_id === "string") {
    return { kind: "session", sessionId: parsed.session_id, raw: parsed };
  }
  if (type === "stream_event") {
    const delta = parsed.event?.delta;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return { kind: "delta", text: delta.text, raw: parsed };
    }
    return null;
  }
  if (type === "assistant" && parsed.message && Array.isArray(parsed.message.content)) {
    const text = parsed.message.content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    if (text.length > 0) {
      return { kind: "message", text, raw: parsed };
    }
    return null;
  }
  if (type === "result") {
    return {
      kind: "result",
      result: typeof parsed.result === "string" ? parsed.result : "",
      sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
      numTurns: typeof parsed.num_turns === "number" ? parsed.num_turns : undefined,
      totalCostUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
      durationMs: typeof parsed.duration_ms === "number" ? parsed.duration_ms : 0,
      raw: parsed,
    };
  }
  return null;
}

export async function* runClaudeCliStream(
  opts: ClaudeChatOptions,
): AsyncGenerator<ClaudeStreamEvent, void, void> {
  const prompt = opts.prompt.trim();
  if (!prompt) {
    throw new ClaudeCliError("spawn_failed", "prompt is empty");
  }

  const maxTurns = opts.maxTurns ?? env.CLAUDE_DEFAULT_MAX_TURNS;
  const timeoutMs = opts.timeoutMs ?? env.CLAUDE_TIMEOUT_MS;
  const args: string[] = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--max-turns",
    String(maxTurns),
    "--tools",
    "",
  ];
  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  let release: () => void;
  try {
    release = await claudeSemaphore.acquire();
  } catch (err) {
    if (err instanceof SemaphoreFullError) {
      throw new ClaudeCliError(
        "overloaded",
        "too many concurrent claude invocations; retry later",
      );
    }
    throw err;
  }

  const proc = spawnImpl(env.CLAUDE_BIN, args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const queue: ClaudeStreamEvent[] = [];
  let stderrBuf = "";
  let lineBuf = "";
  let endError: Error | null = null;
  let ended = false;
  let pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let killedByTimeout = false;
  let killedByAbort = false;
  let semaphoreReleased = false;

  const releaseOnce = () => {
    if (semaphoreReleased) return;
    semaphoreReleased = true;
    release();
  };

  const wakeup = () => {
    if (pending) {
      const p = pending;
      pending = null;
      p.resolve();
    }
  };

  const fail = (err: Error) => {
    endError = err;
    ended = true;
    if (pending) {
      const p = pending;
      pending = null;
      p.reject(err);
    }
  };

  const timeout = setTimeout(() => {
    killedByTimeout = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // best-effort
    }
  }, timeoutMs);

  const onAbort = () => {
    if (ended) return;
    killedByAbort = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // best-effort
    }
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  proc.stdout?.on("data", (chunk: Buffer | string) => {
    lineBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    // Process every complete line. Partial trailing line stays in lineBuf.
    while ((nl = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        const event = classifyStreamLine(parsed);
        if (event) {
          if (queue.length < MAX_QUEUED_EVENTS) {
            queue.push(event);
            wakeup();
          }
          // If queue is full, drop the event silently — backpressure is
          // signalled by SSE close, not by stalling the CLI.
        }
      } catch {
        // Malformed JSON line — skip. Real CLI may emit human-readable
        // status lines mixed in; we only care about parseable events.
      }
    }
  });

  proc.stderr?.on("data", (chunk: Buffer | string) => {
    stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });

  proc.on("error", (err: Error) => {
    clearTimeout(timeout);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    releaseOnce();
    fail(new ClaudeCliError("spawn_failed", err.message));
  });

  proc.on("close", (code: number | null) => {
    clearTimeout(timeout);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    releaseOnce();

    if (killedByTimeout) {
      fail(
        new ClaudeCliError("timeout", `claude CLI exceeded ${timeoutMs}ms`, {
          stderr: stderrBuf,
        }),
      );
      return;
    }
    if (killedByAbort) {
      fail(new ClaudeCliError("aborted", "client closed the stream"));
      return;
    }
    if (code !== 0) {
      fail(
        new ClaudeCliError(
          "non_zero_exit",
          `claude CLI exited with code ${code}`,
          { stderr: stderrBuf, exitCode: code },
        ),
      );
      return;
    }
    ended = true;
    wakeup();
  });

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (ended) {
        if (endError) throw endError;
        return;
      }
      // Wait for the next data/close/error event.
      await new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
      });
    }
  } finally {
    clearTimeout(timeout);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    if (!ended) {
      // Generator was abandoned by the consumer (e.g. SSE client closed).
      // Kill the CLI so we release the semaphore promptly.
      try {
        proc.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }
    releaseOnce();
  }
}

export async function detectClaudeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const proc = spawnImpl(env.CLAUDE_BIN, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      proc.stdout?.on("data", (c: Buffer | string) => {
        out += typeof c === "string" ? c : c.toString("utf8");
      });
      proc.on("error", () => resolve(null));
      proc.on("close", (code: number | null) => {
        if (code === 0) resolve(out.trim() || null);
        else resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

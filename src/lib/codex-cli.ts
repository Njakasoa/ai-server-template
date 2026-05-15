import { spawn, type SpawnOptions } from "node:child_process";
import { env } from "./env.js";
import { Semaphore, SemaphoreFullError } from "./semaphore.js";

// Codex equivalents of the Claude CLI wrapper. Kept structurally aligned with
// claude-cli.ts so the route dispatcher can treat them as drop-in alternatives.
// Notable asymmetries (see comments inline):
//   - Codex has no `--tools ""` knob. We harden with `--sandbox read-only` and
//     `-c approval_policy="never"`; deeper isolation is the caller's job (e.g.
//     the Docker runtime). A crafted prompt can still ask the model to *try*
//     a tool, but the sandbox prevents writes and the approval policy makes
//     the CLI refuse instead of blocking on stdin.
//   - Codex has no native `--append-system-prompt`. systemPrompt is injected
//     as a leading `[SYSTEM]` block in the prompt itself.
//   - Codex has no `--max-turns`. The option is accepted in the wrapper API
//     for symmetry but silently ignored.
//   - Cost-in-USD is not exposed by `codex exec --json`; result.totalCostUsd
//     stays undefined.

export type CodexCliErrorCode =
  | "spawn_failed"
  | "timeout"
  | "non_zero_exit"
  | "session_not_found"
  | "parse_failed"
  | "overloaded"
  | "aborted";

export class CodexCliError extends Error {
  constructor(
    public readonly code: CodexCliErrorCode,
    message: string,
    public readonly details?: { stderr?: string; stdout?: string; exitCode?: number | null },
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodexCliError";
  }
}

// Heuristic match against the CLI's stderr when `codex exec resume <id>`
// fails because the session/thread is unknown. Patterns observed in
// codex-cli 0.130.0:
//   "Error: thread/resume: thread/resume failed: no rollout found for thread id <UUID>"
// plus the more generic phrasings other versions might emit. Keeping the
// list permissive so we don't silently regress when the CLI rewords the
// error in a future release.
const SESSION_MISSING_PATTERNS: readonly RegExp[] = [
  /no\s+rollout\s+found/i,
  /thread\/resume\s+failed/i,
  /no\s+such\s+(session|thread)/i,
  /(session|thread)\s+not\s+found/i,
  /unknown\s+(session|thread)/i,
  /could\s+not\s+find\s+(session|thread)/i,
];

export function detectCodexSessionNotFound(
  opts: { sessionId?: string },
  stderr: string,
): boolean {
  if (!opts.sessionId) return false;
  if (!stderr) return false;
  return SESSION_MISSING_PATTERNS.some((re) => re.test(stderr));
}

export type CodexCliResult = {
  result: string;
  sessionId?: string;
  numTurns?: number;
  totalCostUsd?: number;
  durationMs: number;
  raw: unknown;
};

export type CodexCliOptions = {
  prompt: string;
  systemPrompt?: string;
  sessionId?: string;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
};

type SpawnFn = typeof spawn;

let spawnImpl: SpawnFn = spawn;

export function __setCodexSpawnForTest(fn: SpawnFn): void {
  spawnImpl = fn;
}

export function __resetCodexSpawnForTest(): void {
  spawnImpl = spawn;
}

function logCliFailure(
  source: string,
  exitCode: number | null,
  stderr: string,
  stdoutTail: string,
): void {
  const stderrSnip = stderr.trim().slice(-2000);
  const stdoutSnip = stdoutTail.trim().slice(-500);
  console.error(
    `[codex-cli] ${source} exit=${exitCode}\n` +
      `  stderr: ${stderrSnip || "<empty>"}\n` +
      (stdoutSnip ? `  stdout-tail: ${stdoutSnip}\n` : ""),
  );
}

function composePrompt(prompt: string, systemPrompt?: string): string {
  const user = prompt.trim();
  if (!systemPrompt) return user;
  return `[SYSTEM]\n${systemPrompt.trim()}\n\n[USER]\n${user}`;
}

function buildArgs(opts: {
  composedPrompt: string;
  sessionId?: string;
}): string[] {
  // Sandbox is configured via `-c sandbox_mode=...` instead of the `--sandbox`
  // flag because `codex exec resume` does NOT accept `--sandbox` (verified
  // against codex-cli 0.130.0), whereas `-c <key=value>` works on both the
  // base `exec` subcommand and on `exec resume`. Same story for approval
  // policy — keeping every knob as a `-c` override gives us identical
  // argument shapes for the fresh-conversation and resume code paths.
  const flags = [
    "--json",
    "--skip-git-repo-check",
    "-c",
    `sandbox_mode="${env.CODEX_SANDBOX}"`,
    "-c",
    'approval_policy="never"',
  ];
  if (env.CODEX_MODEL) {
    flags.push("--model", env.CODEX_MODEL);
  }
  if (opts.sessionId) {
    // `codex exec resume [flags] -- <SESSION_ID> <prompt>` — `--` keeps a
    // prompt that begins with `-` from being parsed as a flag.
    return ["exec", "resume", ...flags, "--", opts.sessionId, opts.composedPrompt];
  }
  return ["exec", ...flags, "--", opts.composedPrompt];
}

// Codex `exec --json` emits a JSONL stream. The shape we care about (verified
// against codex-cli 0.130.0 — the *nested* item discriminator is `type`, same
// key name as the top-level event discriminator; that overload is intentional
// in the CLI's protocol):
//   { "type": "thread.started", "thread_id": "..." }
//   { "type": "item.started",   "item": { "id": "...", "type": "agent_message", "text": "" } }
//   { "type": "item.updated",   "item": { "id": "...", "type": "agent_message", "text": "<so far>" } }
//   { "type": "item.completed", "item": { "id": "...", "type": "agent_message", "text": "<final>" } }
//   { "type": "turn.completed", "usage": { ... } }
//   { "type": "turn.failed",    "error": { "message": "..." } }
//   { "type": "error",          "message": "..." }
// Anything else (reasoning items, exec_command, web_search, todo_list, …)
// is intentionally ignored — we only surface assistant text to the client.

export type CodexStreamEvent =
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
      subtype?: string;
      isError?: boolean;
      errors?: string[];
      raw: unknown;
    };

export type CodexChatOptions = {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  maxTurns?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
};

const MAX_QUEUED_EVENTS = 1000;
const STDOUT_TAIL_LIMIT = 8192;

class StreamClassifier {
  private threadId: string | undefined;
  private currentAgentMessageId: string | undefined;
  private lastAgentText = "";
  private numTurns = 0;
  // Buffers the latest completed agent_message text so a synthetic `result`
  // event can be emitted when codex exits without a `turn.completed` line.
  private lastCompletedMessage = "";

  classify(parsed: any, startedAt: number): CodexStreamEvent[] {
    if (!parsed || typeof parsed !== "object") return [];
    const type = parsed.type;

    if (type === "thread.started" && typeof parsed.thread_id === "string") {
      this.threadId = parsed.thread_id;
      return [{ kind: "session", sessionId: parsed.thread_id, raw: parsed }];
    }

    if (type === "turn.started") {
      this.numTurns += 1;
      return [];
    }

    if (type === "item.started" || type === "item.updated") {
      const item = parsed.item;
      if (item?.type !== "agent_message" || typeof item.text !== "string") return [];
      if (this.currentAgentMessageId !== item.id) {
        this.currentAgentMessageId = item.id;
        this.lastAgentText = "";
      }
      if (item.text.length > this.lastAgentText.length && item.text.startsWith(this.lastAgentText)) {
        const delta = item.text.slice(this.lastAgentText.length);
        this.lastAgentText = item.text;
        return [{ kind: "delta", text: delta, raw: parsed }];
      }
      if (item.text !== this.lastAgentText) {
        // Non-monotonic update (rare, model edits prior text). Reset and
        // emit the full text as a delta so the client stays consistent.
        this.lastAgentText = item.text;
        return [{ kind: "delta", text: item.text, raw: parsed }];
      }
      return [];
    }

    if (type === "item.completed") {
      const item = parsed.item;
      if (item?.type !== "agent_message" || typeof item.text !== "string") return [];
      this.lastAgentText = item.text;
      this.lastCompletedMessage = item.text;
      this.currentAgentMessageId = undefined;
      return [{ kind: "message", text: item.text, raw: parsed }];
    }

    if (type === "turn.completed") {
      return [
        {
          kind: "result",
          result: this.lastCompletedMessage,
          sessionId: this.threadId,
          numTurns: this.numTurns || undefined,
          totalCostUsd: undefined,
          durationMs: Date.now() - startedAt,
          subtype: "success",
          isError: false,
          raw: parsed,
        },
      ];
    }

    if (type === "turn.failed") {
      const message =
        typeof parsed.error?.message === "string" ? parsed.error.message : "turn failed";
      return [
        {
          kind: "result",
          result: this.lastCompletedMessage,
          sessionId: this.threadId,
          numTurns: this.numTurns || undefined,
          totalCostUsd: undefined,
          durationMs: Date.now() - startedAt,
          subtype: "error_during_execution",
          isError: true,
          errors: [message],
          raw: parsed,
        },
      ];
    }

    if (type === "error" && typeof parsed.message === "string") {
      return [
        {
          kind: "result",
          result: this.lastCompletedMessage,
          sessionId: this.threadId,
          numTurns: this.numTurns || undefined,
          totalCostUsd: undefined,
          durationMs: Date.now() - startedAt,
          subtype: "error_during_execution",
          isError: true,
          errors: [parsed.message],
          raw: parsed,
        },
      ];
    }

    return [];
  }

  finalResult(startedAt: number, raw: unknown): CodexStreamEvent {
    return {
      kind: "result",
      result: this.lastCompletedMessage,
      sessionId: this.threadId,
      numTurns: this.numTurns || undefined,
      totalCostUsd: undefined,
      durationMs: Date.now() - startedAt,
      subtype: "success",
      isError: false,
      raw,
    };
  }
}

const codexSemaphore = new Semaphore(env.MAX_CONCURRENT_CODEX, env.MAX_QUEUED_CODEX);

export async function runCodexCli(opts: CodexCliOptions): Promise<CodexCliResult> {
  const prompt = opts.prompt.trim();
  if (!prompt) {
    throw new CodexCliError("spawn_failed", "prompt is empty");
  }

  const timeoutMs = opts.timeoutMs ?? env.CODEX_TIMEOUT_MS;
  const composedPrompt = composePrompt(prompt, opts.systemPrompt);
  const args = buildArgs({ composedPrompt, sessionId: opts.sessionId });

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  };

  let release: () => void;
  try {
    release = await codexSemaphore.acquire();
  } catch (err) {
    if (err instanceof SemaphoreFullError) {
      throw new CodexCliError(
        "overloaded",
        "too many concurrent codex invocations; retry later",
      );
    }
    throw err;
  }

  const start = Date.now();

  return new Promise<CodexCliResult>((resolve, reject) => {
    const proc = spawnImpl(env.CODEX_BIN, args, spawnOpts);

    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    let killedByTimeout = false;
    let settled = false;
    const classifier = new StreamClassifier();
    let lastResult: Extract<CodexStreamEvent, { kind: "result" }> | null = null;

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
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdout += text;
      lineBuf += text;
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          for (const ev of classifier.classify(parsed, start)) {
            if (ev.kind === "result") lastResult = ev;
          }
        } catch {
          // skip malformed line
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      finish(() => reject(new CodexCliError("spawn_failed", err.message)));
    });

    proc.on("close", (code: number | null) => {
      clearTimeout(timeout);

      if (killedByTimeout) {
        return finish(() =>
          reject(
            new CodexCliError("timeout", `codex CLI exceeded ${timeoutMs}ms`, {
              stderr,
              stdout,
            }),
          ),
        );
      }

      if (code !== 0) {
        const sessionMissing = detectCodexSessionNotFound(opts, stderr);
        if (!sessionMissing) {
          logCliFailure("runCodexCli", code, stderr, stdout);
        }
        return finish(() =>
          reject(
            new CodexCliError(
              sessionMissing ? "session_not_found" : "non_zero_exit",
              sessionMissing
                ? `codex session "${opts.sessionId}" no longer exists; client should retry without sessionId`
                : `codex CLI exited with code ${code}`,
              { stderr, stdout, exitCode: code },
            ),
          ),
        );
      }

      // Synthesize a result if the stream did not emit a `turn.completed`.
      const finalEvent =
        lastResult ?? (classifier.finalResult(start, null) as Extract<
          CodexStreamEvent,
          { kind: "result" }
        >);

      if (finalEvent.isError) {
        return finish(() =>
          reject(
            new CodexCliError(
              "non_zero_exit",
              `codex CLI reported error: ${(finalEvent.errors ?? []).join("; ") || "unknown"}`,
              { stderr, stdout: stdout.slice(-500), exitCode: code },
            ),
          ),
        );
      }

      finish(() =>
        resolve({
          result: finalEvent.result,
          sessionId: finalEvent.sessionId,
          numTurns: finalEvent.numTurns,
          totalCostUsd: finalEvent.totalCostUsd,
          durationMs: finalEvent.durationMs,
          raw: finalEvent.raw,
        }),
      );
    });
  });
}

export async function* runCodexCliStream(
  opts: CodexChatOptions,
): AsyncGenerator<CodexStreamEvent, void, void> {
  const prompt = opts.prompt.trim();
  if (!prompt) {
    throw new CodexCliError("spawn_failed", "prompt is empty");
  }

  const timeoutMs = opts.timeoutMs ?? env.CODEX_TIMEOUT_MS;
  const composedPrompt = composePrompt(prompt, opts.systemPrompt);
  const args = buildArgs({ composedPrompt, sessionId: opts.sessionId });

  let release: () => void;
  try {
    release = await codexSemaphore.acquire();
  } catch (err) {
    if (err instanceof SemaphoreFullError) {
      throw new CodexCliError(
        "overloaded",
        "too many concurrent codex invocations; retry later",
      );
    }
    throw err;
  }

  const proc = spawnImpl(env.CODEX_BIN, args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const start = Date.now();
  const classifier = new StreamClassifier();
  const queue: CodexStreamEvent[] = [];
  let stderrBuf = "";
  let lineBuf = "";
  let stdoutTailBuf = "";
  let endError: Error | null = null;
  let ended = false;
  let pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let sawTurnCompleted = false;
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
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    lineBuf += text;
    stdoutTailBuf = (stdoutTailBuf + text).slice(-STDOUT_TAIL_LIMIT);
    let nl: number;
    while ((nl = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        for (const event of classifier.classify(parsed, start)) {
          if (event.kind === "result") sawTurnCompleted = true;
          if (queue.length < MAX_QUEUED_EVENTS) {
            queue.push(event);
            wakeup();
          }
        }
      } catch {
        // skip
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
    fail(new CodexCliError("spawn_failed", err.message));
  });

  proc.on("close", (code: number | null) => {
    clearTimeout(timeout);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    releaseOnce();

    if (killedByTimeout) {
      fail(
        new CodexCliError("timeout", `codex CLI exceeded ${timeoutMs}ms`, {
          stderr: stderrBuf,
        }),
      );
      return;
    }
    if (killedByAbort) {
      fail(new CodexCliError("aborted", "client closed the stream"));
      return;
    }
    if (code !== 0) {
      const sessionMissing = detectCodexSessionNotFound(opts, stderrBuf);
      if (!sessionMissing) {
        logCliFailure("runCodexCliStream", code, stderrBuf, stdoutTailBuf);
      }
      fail(
        new CodexCliError(
          sessionMissing ? "session_not_found" : "non_zero_exit",
          sessionMissing
            ? `codex session "${opts.sessionId}" no longer exists; client should retry without sessionId`
            : `codex CLI exited with code ${code}`,
          { stderr: stderrBuf, exitCode: code },
        ),
      );
      return;
    }
    if (!sawTurnCompleted) {
      // Codex exited 0 without a turn.completed line (rare but possible if
      // the stream is cut short by a benign condition). Surface a synthetic
      // result so the consumer can finalize.
      queue.push(classifier.finalResult(start, null));
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
      await new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
      });
    }
  } finally {
    clearTimeout(timeout);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    if (!ended) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }
    releaseOnce();
  }
}

export async function detectCodexVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const proc = spawnImpl(env.CODEX_BIN, ["--version"], {
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

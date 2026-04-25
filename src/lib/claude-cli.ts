import { spawn, type SpawnOptions } from "node:child_process";
import { env } from "./env.js";

export type ClaudeCliErrorCode =
  | "spawn_failed"
  | "timeout"
  | "non_zero_exit"
  | "parse_failed";

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
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--max-turns",
    String(maxTurns),
  ];

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  };

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

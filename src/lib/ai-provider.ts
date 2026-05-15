import { z } from "zod";
import { env } from "./env.js";
import {
  ClaudeCliError,
  detectClaudeVersion,
  runClaudeCli,
  runClaudeCliStream,
  type ClaudeChatOptions,
  type ClaudeCliOptions,
  type ClaudeCliResult,
  type ClaudeStreamEvent,
} from "./claude-cli.js";
import {
  CodexCliError,
  detectCodexVersion,
  runCodexCli,
  runCodexCliStream,
  type CodexChatOptions,
  type CodexCliOptions,
  type CodexCliResult,
  type CodexStreamEvent,
} from "./codex-cli.js";

// Unified provider surface. Routes accept an optional `provider` field; this
// module dispatches to the right CLI wrapper and normalizes the error type
// so route handlers don't have to special-case Claude vs Codex.

export const aiProviderSchema = z.enum(["claude", "codex"]);
export type AiProvider = z.infer<typeof aiProviderSchema>;

export function resolveProvider(value?: AiProvider): AiProvider {
  return value ?? env.DEFAULT_PROVIDER;
}

// Both CLI wrappers already share an event shape (session/delta/message/result)
// and a result shape (result/sessionId/numTurns/totalCostUsd/durationMs), so the
// "normalized" types are simply the union of the two — callers can ignore the
// origin once the dispatcher returns.
export type AiCliResult = (ClaudeCliResult | CodexCliResult) & { provider: AiProvider };
export type AiStreamEvent = ClaudeStreamEvent | CodexStreamEvent;
export type AiCliOptions = ClaudeCliOptions & CodexCliOptions;
export type AiChatOptions = ClaudeChatOptions & CodexChatOptions;

export class AiProviderError extends Error {
  constructor(
    public readonly provider: AiProvider,
    public readonly code: string,
    message: string,
    public readonly details?: { stderr?: string; stdout?: string; exitCode?: number | null },
  ) {
    super(`[${provider}:${code}] ${message}`);
    this.name = "AiProviderError";
  }

  static from(provider: AiProvider, err: unknown): AiProviderError {
    if (err instanceof ClaudeCliError || err instanceof CodexCliError) {
      return new AiProviderError(provider, err.code, err.message, err.details);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new AiProviderError(provider, "internal", message);
  }
}

export async function runProvider(
  provider: AiProvider,
  opts: AiCliOptions,
): Promise<AiCliResult> {
  try {
    if (provider === "codex") {
      const r = await runCodexCli(opts);
      return { ...r, provider: "codex" };
    }
    const r = await runClaudeCli(opts);
    return { ...r, provider: "claude" };
  } catch (err) {
    throw AiProviderError.from(provider, err);
  }
}

export async function* runProviderStream(
  provider: AiProvider,
  opts: AiChatOptions,
): AsyncGenerator<AiStreamEvent, void, void> {
  const iterator =
    provider === "codex" ? runCodexCliStream(opts) : runClaudeCliStream(opts);
  try {
    for await (const event of iterator) {
      yield event;
    }
  } catch (err) {
    throw AiProviderError.from(provider, err);
  }
}

export async function detectProviderVersion(
  provider: AiProvider,
): Promise<string | null> {
  return provider === "codex" ? detectCodexVersion() : detectClaudeVersion();
}

export type ProviderErrorStatus = 410 | 500 | 502 | 503 | 504;

// Status-code mapping shared by all routes — keeps wire-level behavior
// identical regardless of which CLI raised the error.
export function statusForProviderError(code: string): ProviderErrorStatus {
  switch (code) {
    case "timeout":
      return 504;
    case "spawn_failed":
    case "overloaded":
    case "aborted":
      return 503;
    case "parse_failed":
      return 502;
    case "session_not_found":
      return 410;
    default:
      return 500;
  }
}

import { z } from "zod";
import { loadFileConfig } from "./config-file.js";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3100),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CLAUDE_BIN: z.string().min(1).default("claude"),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  CLAUDE_DEFAULT_MAX_TURNS: z.coerce.number().int().positive().default(1),
  CODEX_BIN: z.string().min(1).default("codex"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Codex has no native `--max-turns` flag. We keep the env var for symmetry
  // with the Claude wrapper, but it is not forwarded to the CLI — kept as a
  // future hook in case OpenAI adds a per-task turn cap.
  CODEX_DEFAULT_MAX_TURNS: z.coerce.number().int().positive().default(1),
  CODEX_MODEL: z.string().min(1).optional(),
  CODEX_SANDBOX: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("read-only"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  API_TOKEN: z.string().min(16).optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(60),
  MAX_CONCURRENT_CLAUDE: z.coerce.number().int().min(1).default(3),
  MAX_QUEUED_CLAUDE: z.coerce.number().int().min(0).default(10),
  MAX_CONCURRENT_CODEX: z.coerce.number().int().min(1).default(3),
  MAX_QUEUED_CODEX: z.coerce.number().int().min(0).default(10),
  // Default backend when a request omits `provider`. Routes still accept an
  // explicit `provider` field to override per-call.
  DEFAULT_PROVIDER: z.enum(["claude", "codex"]).default("claude"),
});

export type Env = z.infer<typeof EnvSchema>;

// Precedence: env vars > config.json > zod default. We splice config.json
// values into the input only when the matching env var is absent, so a real
// `process.env.DEFAULT_PROVIDER` always wins (12-factor: env overrides
// versioned config without rebuilding the image).
const fileConfig = loadFileConfig();

const mergedInput: NodeJS.ProcessEnv = {
  ...process.env,
  DEFAULT_PROVIDER:
    process.env.DEFAULT_PROVIDER ?? fileConfig.defaultProvider,
};

export const env: Env = EnvSchema.parse(mergedInput);

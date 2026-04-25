import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3100),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CLAUDE_BIN: z.string().min(1).default("claude"),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  CLAUDE_DEFAULT_MAX_TURNS: z.coerce.number().int().positive().default(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);

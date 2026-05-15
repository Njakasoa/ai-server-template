import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

// JSON config loaded from `./config.json` at boot. Currently exposes a single
// knob — `defaultProvider` — but the schema is intentionally open (passthrough)
// so future keys can be added without forcing every operator to re-touch their
// file. Env vars take precedence over anything declared here; see env.ts.

const ConfigSchema = z
  .object({
    defaultProvider: z.enum(["claude", "codex"]).optional(),
  })
  .passthrough();

export type FileConfig = z.infer<typeof ConfigSchema>;

const DEFAULT_PATH = resolve(process.cwd(), "config.json");

export function loadFileConfig(path: string = DEFAULT_PATH): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // Missing file is the normal case — operators may rely on env vars only.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[config] failed to read ${path}: ${msg}`);
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[config] ${path} is not valid JSON: ${msg}`);
    return {};
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(
      `[config] ${path} did not match schema: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    return {};
  }
  return result.data;
}

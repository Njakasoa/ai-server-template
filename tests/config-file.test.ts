import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFileConfig } from "../src/lib/config-file.js";

describe("loadFileConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-cfg-"));
  const path = join(dir, "config.json");

  after(() => rmSync(dir, { recursive: true, force: true }));

  // Silence console.warn during this suite so failure-path tests don't
  // pollute the test runner output.
  const originalWarn = console.warn;
  beforeEach(() => {
    console.warn = () => {};
  });
  after(() => {
    console.warn = originalWarn;
  });

  it("returns {} when the file does not exist", () => {
    const cfg = loadFileConfig(join(dir, "missing.json"));
    assert.deepEqual(cfg, {});
  });

  it("parses a valid file with defaultProvider: claude", () => {
    writeFileSync(path, JSON.stringify({ defaultProvider: "claude" }));
    assert.equal(loadFileConfig(path).defaultProvider, "claude");
  });

  it("parses a valid file with defaultProvider: codex", () => {
    writeFileSync(path, JSON.stringify({ defaultProvider: "codex" }));
    assert.equal(loadFileConfig(path).defaultProvider, "codex");
  });

  it("tolerates unknown keys (passthrough)", () => {
    writeFileSync(
      path,
      JSON.stringify({ defaultProvider: "claude", futureKnob: 42 }),
    );
    assert.equal(loadFileConfig(path).defaultProvider, "claude");
  });

  it("returns {} on invalid JSON", () => {
    writeFileSync(path, "{ not json");
    assert.deepEqual(loadFileConfig(path), {});
  });

  it("returns {} when defaultProvider is not a recognized value", () => {
    writeFileSync(path, JSON.stringify({ defaultProvider: "bogus" }));
    assert.deepEqual(loadFileConfig(path), {});
  });
});

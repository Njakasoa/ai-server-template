import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildQualifyCallUserPrompt } from "../src/prompts/qualify-call.js";

describe("buildQualifyCallUserPrompt", () => {
  const baseInput = {
    transcript: "Allô oui bonjour, c'est bien Madame Untel ?",
    metadata: {
      callId: "rg_123",
      direction: "outbound" as const,
      durationSeconds: 42,
      agentName: "Alice",
      contactName: "Bob",
      contactPhone: "+33600000000",
    },
  };

  it("renders without a script when none is provided", () => {
    const out = buildQualifyCallUserPrompt(baseInput);
    assert.ok(out.includes("# Métadonnées de l'appel"));
    assert.ok(out.includes("# Transcription brute"));
    assert.ok(out.includes("Allô oui bonjour"));
    assert.ok(!out.includes("# Script suivi pendant l'appel"));
  });

  it("renders the script section with steps and agent responses when provided", () => {
    const out = buildQualifyCallUserPrompt({
      ...baseInput,
      script: {
        templateName: "Opus V3 — Suivi formation",
        templateDescription: "Trame J+30 post-formation",
        status: "completed",
        steps: [
          {
            id: "intro",
            type: "instruction",
            label: "Se présenter et confirmer l'identité",
          },
          {
            id: "still_employed",
            type: "yesno",
            label: "Êtes-vous toujours en poste ?",
            response: { value: true },
          },
          {
            id: "satisfaction",
            type: "select",
            label: "Satisfaction globale",
            options: ["1", "2", "3", "4", "5"],
            response: { value: "4", notes: "Très contente du formateur" },
          },
          {
            id: "renew",
            type: "yesno",
            label: "Envisage-t-il une autre formation ?",
            // no response — agent didn't fill it
          },
        ],
      },
    });

    assert.ok(out.includes("# Script suivi pendant l'appel"));
    assert.ok(out.includes("Opus V3 — Suivi formation"));
    assert.ok(out.includes("status: completed"));
    assert.ok(out.includes("Êtes-vous toujours en poste"));
    assert.ok(out.includes("réponse agent: oui")); // boolean true → "oui"
    assert.ok(out.includes("options: 1 | 2 | 3 | 4 | 5"));
    assert.ok(out.includes("réponse agent: 4"));
    assert.ok(out.includes("notes agent: Très contente du formateur"));
    assert.ok(out.includes("réponse agent: (non renseignée)"));
    // Script section appears BEFORE the transcript so the model sees the
    // expected qualification structure first.
    assert.ok(out.indexOf("# Script suivi pendant l'appel") < out.indexOf("# Transcription brute"));
  });

  it("renders a no-transcript prompt when only a script is provided", () => {
    const out = buildQualifyCallUserPrompt({
      metadata: { direction: "outbound" as const, agentName: "Alice" },
      script: {
        templateName: "Manual outbound — no Ringover",
        steps: [
          {
            id: "still_employed",
            type: "yesno",
            label: "Êtes-vous toujours en poste ?",
            response: { value: false, notes: "rupture conventionnelle en mars" },
          },
        ],
      },
    });
    assert.ok(out.includes("pas de transcription disponible"));
    assert.ok(out.includes("# Script suivi pendant l'appel"));
    assert.ok(out.includes("Manual outbound — no Ringover"));
    assert.ok(out.includes("aucune transcription disponible"));
    assert.ok(!out.includes("Voici la transcription brute Ringover d'un appel"));
  });

  it("truncates an oversized script section with a visible marker", () => {
    const bigLabel = "A".repeat(900);
    const steps = Array.from({ length: 50 }, (_, i) => ({
      id: `step_${i}`,
      type: "question" as const,
      label: `${i} ${bigLabel}`,
      response: { value: "B".repeat(900) },
    }));

    const out = buildQualifyCallUserPrompt({
      ...baseInput,
      script: { templateName: "Big Template", steps },
    });

    assert.ok(out.includes("[…tronqué : section script > 30000 caractères]"));
  });
});

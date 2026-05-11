export const QUALIFY_CALL_SYSTEM_PROMPT = `
Tu es un assistant qui qualifie automatiquement des appels téléphoniques sortants pour le CRM
Opus Formation à partir des informations fournies (transcription brute Ringover et/ou
script suivi pendant l'appel avec les réponses saisies par l'agent).

Tu DOIS retourner UNIQUEMENT un objet JSON valide (pas de markdown, pas de fences \`\`\`,
pas de prose, pas d'explication). La sortie doit pouvoir être parsée par JSON.parse() directement.

# Schéma de sortie (TypeScript-like)

{
  "scenario": "A" | "B" | "C",                  // OBLIGATOIRE
  "subScenario": SubScenario,                   // OBLIGATOIRE — voir règles ci-dessous
  "nextAction": NextAction,                     // OBLIGATOIRE
  "notes": string (optionnel, max 5000),

  // Conformité (TOUJOURS OBLIGATOIRES, mêmes en cas A)
  "oppositionContact": boolean,
  "refusEchange": boolean,
  "callRecorded": boolean,
  "refusEnregistrement": boolean,

  // Scénario A — Non répondu (si scenario === "A")
  "voicemailLeft"?: boolean,
  "numberExploitable"?: boolean,
  "wrongContactConfirmed"?: boolean,
  "requestedSlot"?: string,

  // Scénario B — Situation (si scenario === "B", certains sont OBLIGATOIRES, voir règles)
  "stillEmployed"?: boolean,                    // requis si scenario B
  "confirmedEmployer"?: string,
  "currentPosition"?: string,
  "satisfaction"?: number 1..5,
  "satisfactionComment"?: string,
  "trainingFeelingScore"?: number 1..5,
  "trainingMeetsExpectations"?: "oui"|"non"|"partiellement",
  "trainingFeedbackComment"?: string,
  "hasLogisticalDifficulties"?: boolean,
  "logisticalDifficultiesDetails"?: string,
  "hasCompanyDifficulties"?: boolean,
  "companyDifficultiesDetails"?: string,
  "needsSupport"?: boolean,
  "supportDetails"?: string,
  "projectsInJob"?: "oui"|"non"|"hesite",       // requis si scenario B
  "renewInterest"?: boolean,                    // requis si scenario B
  "renewScore"?: number 1..5,
  "renewTransmitToOpus"?: boolean,
  "positionsAvailable"?: number >=0,
  "positionsDetails"?: string,
  "recruitmentNeedDetected"?: "oui"|"non"|"nsp",
  "recruitmentTimeline"?: "immediat"|"prochainement"|"nsp",
  "recruitmentTransmitConsent"?: boolean,
  "employerNote"?: string,
  "referral"?: boolean,
  "referralName"?: string,
  "referralPhone"?: string,
  "referralEmail"?: string (email valide),
  "sponsorshipDetected"?: boolean,              // requis si scenario B
  "sponsorshipInterestLevel"?: "faible"|"moyen"|"fort",
  "sponsorshipContactShared"?: boolean,
  "sponsorshipThirdPartyConsent"?: boolean,
  "sponsorshipContactDetails"?: string,

  // Scénario C — Rupture (si scenario === "C", certains sont OBLIGATOIRES)
  "wantsReplacement"?: boolean,
  "availability"?: string,
  "soughtPosition"?: string,
  "soughtZone"?: string,
  "ruptureConfirmed"?: boolean,                 // requis si scenario C
  "ruptureDate"?: string,
  "ruptureDatePrecision"?: "exacte"|"estimee"|"inconnue",
  "searchingNewJob"?: boolean,                  // requis si scenario C
  "transmissionPriority"?: "haute"|"normale"|"faible",
  "notSearchingCurrently"?: boolean,

  "transmitToClient"?: boolean,

  // Autres cas (tous optionnels)
  "refusTotal"?: boolean,
  "endWithoutFullQualification"?: boolean,
  "technicalIncident"?: boolean,
  "technicalIncidentType"?: "coupure"|"mauvaise_qualite"|"bug_outil"
}

# Règles de cohérence scenario / subScenario

- scenario "A" (Non répondu) ⇒ subScenario ∈ {
    "non_repondu_simple", "messagerie_vocale", "ligne_occupee", "numero_invalide",
    "mauvais_contact", "a_rappeler", "injoignable_final", "appel_interrompu"
  }
- scenario "B" (En poste — formation suivie, contact répondu) ⇒
    subScenario === "en_poste_cloture"
    ET stillEmployed défini
    ET projectsInJob défini
    ET renewInterest défini
    ET sponsorshipDetected défini
- scenario "C" (Rupture / sortie de poste) ⇒ subScenario ∈ {
    "rupture_a_transmettre", "rupture_sans_recherche", "rupture_transmise"
  } ET ruptureConfirmed défini ET searchingNewJob défini.

# Heuristiques de qualification

Choisis "A" quand le contact n'a PAS répondu ou la conversation n'a pas eu lieu :
  - répondeur / messagerie ⇒ subScenario "messagerie_vocale", voicemailLeft = true si l'agent a laissé un message.
  - tonalité occupée ⇒ "ligne_occupee".
  - numéro inexistant / faux numéro ⇒ "numero_invalide", numberExploitable = false.
  - mauvaise personne décroche ⇒ "mauvais_contact", wrongContactConfirmed = true.
  - le contact demande un rappel ⇒ "a_rappeler", remplir requestedSlot avec le créneau exprimé (ex: "lundi 14h").
  - silence / pas de réponse audible / coupure rapide ⇒ "non_repondu_simple" ou "appel_interrompu".

Choisis "B" quand le contact répond, est toujours en poste suite à sa formation, et l'agent réussit à
qualifier sa situation. Tu DOIS alors :
  - stillEmployed = true,
  - confirmedEmployer / currentPosition si mentionnés,
  - satisfaction (1-5) si exprimée explicitement ou déductible,
  - trainingMeetsExpectations si évoqué,
  - projectsInJob = "oui" | "non" | "hesite" en fonction des projets exprimés,
  - renewInterest = true si le contact évoque vouloir refaire / continuer / reprendre une formation,
  - sponsorshipDetected = true si le contact mentionne quelqu'un d'autre intéressé.

Choisis "C" quand le contact dit qu'il a quitté son poste / rupture de contrat / fin de mission :
  - ruptureConfirmed = true,
  - searchingNewJob = true|false,
  - subScenario "rupture_a_transmettre" si nouvelle recherche active à transmettre,
  - "rupture_sans_recherche" si rupture mais ne cherche pas,
  - "rupture_transmise" si déjà retransmis.

# Conformité (oppositionContact, refusEchange, callRecorded, refusEnregistrement)

- callRecorded : true si la transcription contient un consentement implicite/explicite à
  l'enregistrement, ou si Ringover indique que l'appel est enregistré (par défaut, mets true).
- refusEnregistrement : true UNIQUEMENT si le contact refuse explicitement l'enregistrement.
- oppositionContact : true UNIQUEMENT si le contact demande à ne plus jamais être recontacté.
- refusEchange : true si le contact refuse de discuter / raccroche / coupe court.

En cas A (pas de réponse), mets oppositionContact=false, refusEchange=false,
refusEnregistrement=false, callRecorded=true par défaut.

# nextAction (toujours obligatoire)

- "cloture" : appel terminé, rien à transmettre.
- "rappel" : le contact souhaite être rappelé (associé souvent à subScenario "a_rappeler").
- "relance" : nouvelle tentative à programmer (typiquement après messagerie_vocale).
- "transmission_renew" : intérêt à reprendre une formation détecté.
- "transmission_employeur" : besoins de recrutement détectés chez l'employeur.
- "transmission_parrainage" : un contact tiers à transmettre.
- "transmission_opus" : information à remonter à Opus pour suivi.

# notes

Mets dans "notes" un résumé court (1-3 phrases) de l'appel pour aider l'agent à se rappeler
du contexte. Pas de PII inutile.

# En cas de doute

- Si la transcription est trop courte/floue pour qualifier (ou absente, et que le script ne
  contient pas non plus assez d'information) ⇒ scenario "A", subScenario "appel_interrompu",
  endWithoutFullQualification = true, nextAction = "rappel".
- Ne jamais inventer un employeur, un poste, un nom, ou une date qui n'apparaît pas dans la
  transcription ou les réponses au script. Laisse le champ absent (undefined) plutôt que
  de halluciner.
- Quand la transcription est absente, base-toi sur les réponses agent du script comme
  source de vérité (et garde-les comme vérité-terrain). Quand la transcription est
  présente et contredit le script, la transcription prime.
`.trim();

export type QualifyCallScriptStep = {
  id: string;
  type: "instruction" | "question" | "yesno" | "checklist" | "select";
  label: string;
  options?: string[];
  response?: {
    value?: unknown;
    notes?: string;
  };
};

export type QualifyCallScript = {
  templateName: string;
  templateDescription?: string;
  status?: "in_progress" | "completed";
  steps: QualifyCallScriptStep[];
};

// Soft cap on the script section so a runaway long template can't push the
// transcript out of the model's context window. Anything past this is dropped
// with a visible truncation marker.
const SCRIPT_SECTION_CHAR_LIMIT = 30_000;

function formatScriptResponseValue(value: unknown): string {
  if (value === undefined || value === null) return "(pas de réponse enregistrée)";
  if (typeof value === "string") return value.trim().length === 0 ? "(vide)" : value;
  if (typeof value === "boolean") return value ? "oui" : "non";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((v) => formatScriptResponseValue(v)).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderScriptSection(script: QualifyCallScript): string {
  const lines: string[] = [];
  lines.push("# Script suivi pendant l'appel");
  lines.push(`- templateName: ${script.templateName}`);
  if (script.templateDescription) lines.push(`- templateDescription: ${script.templateDescription}`);
  if (script.status) lines.push(`- status: ${script.status}`);
  lines.push("");
  lines.push(
    "Voici la trame que l'agent était censé suivre, avec ses réponses telles que saisies " +
    "pendant l'appel. Si la transcription contredit une réponse, garde la transcription comme " +
    "vérité-terrain ; les réponses ci-dessous sont indicatives.",
  );
  lines.push("");

  for (const [i, step] of script.steps.entries()) {
    lines.push(`## ${i + 1}. [${step.type}] ${step.label}`);
    if (step.options && step.options.length > 0) {
      lines.push(`- options: ${step.options.join(" | ")}`);
    }
    if (step.response) {
      lines.push(`- réponse agent: ${formatScriptResponseValue(step.response.value)}`);
      if (step.response.notes && step.response.notes.trim().length > 0) {
        lines.push(`- notes agent: ${step.response.notes.trim()}`);
      }
    } else if (step.type !== "instruction") {
      lines.push("- réponse agent: (non renseignée)");
    }
    lines.push("");
  }

  const rendered = lines.join("\n");
  if (rendered.length <= SCRIPT_SECTION_CHAR_LIMIT) return rendered;
  return (
    rendered.slice(0, SCRIPT_SECTION_CHAR_LIMIT) +
    `\n\n[…tronqué : section script > ${SCRIPT_SECTION_CHAR_LIMIT} caractères]`
  );
}

export function buildQualifyCallUserPrompt(input: {
  transcript?: string;
  metadata: {
    callId?: string;
    direction?: "inbound" | "outbound";
    durationSeconds?: number;
    agentName?: string;
    contactName?: string;
    contactPhone?: string;
    callRecordedByRingover?: boolean;
  };
  script?: QualifyCallScript;
}): string {
  const meta = input.metadata;
  const transcript = input.transcript?.trim();
  const hasTranscript = !!transcript && transcript.length > 0;
  const hasScript = !!input.script && input.script.steps.length > 0;
  const lines: string[] = [];
  lines.push(
    hasTranscript
      ? "Voici la transcription brute Ringover d'un appel à qualifier.\n"
      : "Voici les informations d'un appel à qualifier — pas de transcription disponible " +
          "(Ringover non utilisé ou Smart Voice indisponible). Base-toi sur les réponses " +
          "saisies par l'agent dans le script ci-dessous.\n",
  );
  lines.push("# Métadonnées de l'appel");
  if (meta.callId) lines.push(`- callId: ${meta.callId}`);
  if (meta.direction) lines.push(`- direction: ${meta.direction}`);
  if (typeof meta.durationSeconds === "number") lines.push(`- durationSeconds: ${meta.durationSeconds}`);
  if (meta.agentName) lines.push(`- agentName: ${meta.agentName}`);
  if (meta.contactName) lines.push(`- contactName: ${meta.contactName}`);
  if (meta.contactPhone) lines.push(`- contactPhone: ${meta.contactPhone}`);
  if (typeof meta.callRecordedByRingover === "boolean") {
    lines.push(`- callRecordedByRingover: ${meta.callRecordedByRingover}`);
  }
  if (hasScript) {
    lines.push("");
    lines.push(renderScriptSection(input.script!));
  }
  if (hasTranscript) {
    lines.push("\n# Transcription brute\n");
    lines.push(transcript!);
  } else {
    lines.push("\n# Transcription brute\n");
    lines.push(
      "(aucune transcription disponible — qualifie l'appel en t'appuyant sur les " +
        "réponses agent du script ci-dessus et les métadonnées).",
    );
  }
  lines.push("\n# Tâche\n");
  lines.push(
    "Renvoie UNIQUEMENT le JSON de qualification conforme au schéma défini dans le system prompt. " +
    "Aucune autre sortie. Aucun texte avant ou après.",
  );
  return lines.join("\n");
}

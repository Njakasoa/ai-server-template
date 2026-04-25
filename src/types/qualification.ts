import { z } from "zod";

// Mirror of api-server-template src/types/schemas.ts (CRM call qualification)
// Kept in sync manually — if api-server changes its schema, update this file.

export const crmQualScenarioEnum = z.enum(["A", "B", "C"]);

export const crmSubScenarioEnum = z.enum([
  "non_repondu_simple", "messagerie_vocale", "ligne_occupee",
  "numero_invalide", "mauvais_contact", "a_rappeler", "injoignable_final",
  "appel_interrompu",
  "en_poste_cloture",
  "rupture_a_transmettre", "rupture_sans_recherche", "rupture_transmise",
  "refus_echange", "opposition_contact", "refus_poursuite",
]);

export const crmQualNextActionEnum = z.enum([
  "cloture", "rappel", "relance", "transmission_renew", "transmission_employeur",
  "transmission_parrainage", "transmission_opus",
]);

export const crmProjectsInJobEnum = z.enum(["oui", "non", "hesite"]);
export const crmTrainingExpectationsEnum = z.enum(["oui", "non", "partiellement"]);
export const crmRecruitmentNeedEnum = z.enum(["oui", "non", "nsp"]);
export const crmRecruitmentTimelineEnum = z.enum(["immediat", "prochainement", "nsp"]);
export const crmSponsorshipInterestEnum = z.enum(["faible", "moyen", "fort"]);
export const crmRuptureDatePrecisionEnum = z.enum(["exacte", "estimee", "inconnue"]);
export const crmTransmissionPriorityEnum = z.enum(["haute", "normale", "faible"]);
export const crmTechnicalIncidentTypeEnum = z.enum(["coupure", "mauvaise_qualite", "bug_outil"]);

export const qualifyCallSchema = z.object({
  scenario: crmQualScenarioEnum,
  subScenario: crmSubScenarioEnum,
  nextAction: crmQualNextActionEnum,
  notes: z.string().max(5000).optional(),

  // Conformité (always required)
  oppositionContact: z.boolean(),
  refusEchange: z.boolean(),
  callRecorded: z.boolean(),
  refusEnregistrement: z.boolean(),

  // Scenario A — Non répondu
  voicemailLeft: z.boolean().optional(),
  numberExploitable: z.boolean().optional(),
  wrongContactConfirmed: z.boolean().optional(),
  requestedSlot: z.string().max(255).optional(),

  // Scenario B — Situation
  stillEmployed: z.boolean().optional(),
  confirmedEmployer: z.string().max(255).optional(),
  currentPosition: z.string().max(255).optional(),

  // Scenario B — Satisfaction
  satisfaction: z.number().int().min(1).max(5).optional(),
  satisfactionComment: z.string().max(2000).optional(),
  trainingFeelingScore: z.number().int().min(1).max(5).optional(),
  trainingMeetsExpectations: crmTrainingExpectationsEnum.optional(),
  trainingFeedbackComment: z.string().max(2000).optional(),
  hasLogisticalDifficulties: z.boolean().optional(),
  logisticalDifficultiesDetails: z.string().max(2000).optional(),
  hasCompanyDifficulties: z.boolean().optional(),
  companyDifficultiesDetails: z.string().max(2000).optional(),
  needsSupport: z.boolean().optional(),
  supportDetails: z.string().max(2000).optional(),

  // Scenario B — Projection & Renew
  projectsInJob: crmProjectsInJobEnum.optional(),
  renewInterest: z.boolean().optional(),
  renewScore: z.number().int().min(1).max(5).optional(),
  renewTransmitToOpus: z.boolean().optional(),

  // Scenario B — Employeur
  positionsAvailable: z.number().int().min(0).optional(),
  positionsDetails: z.string().max(2000).optional(),
  recruitmentNeedDetected: crmRecruitmentNeedEnum.optional(),
  recruitmentTimeline: crmRecruitmentTimelineEnum.optional(),
  recruitmentTransmitConsent: z.boolean().optional(),
  employerNote: z.string().max(2000).optional(),

  // Scenario B — Parrainage
  referral: z.boolean().optional(),
  referralName: z.string().max(255).optional(),
  referralPhone: z.string().max(30).optional(),
  referralEmail: z.string().email().max(255).optional(),
  sponsorshipDetected: z.boolean().optional(),
  sponsorshipInterestLevel: crmSponsorshipInterestEnum.optional(),
  sponsorshipContactShared: z.boolean().optional(),
  sponsorshipThirdPartyConsent: z.boolean().optional(),
  sponsorshipContactDetails: z.string().max(1000).optional(),

  // Scenario C — Rupture
  wantsReplacement: z.boolean().optional(),
  availability: z.string().max(255).optional(),
  soughtPosition: z.string().max(255).optional(),
  soughtZone: z.string().max(255).optional(),
  ruptureConfirmed: z.boolean().optional(),
  ruptureDate: z.string().max(50).optional(),
  ruptureDatePrecision: crmRuptureDatePrecisionEnum.optional(),
  searchingNewJob: z.boolean().optional(),
  transmissionPriority: crmTransmissionPriorityEnum.optional(),
  notSearchingCurrently: z.boolean().optional(),

  // Common
  transmitToClient: z.boolean().optional(),

  // Autres cas
  refusTotal: z.boolean().optional(),
  endWithoutFullQualification: z.boolean().optional(),
  technicalIncident: z.boolean().optional(),
  technicalIncidentType: crmTechnicalIncidentTypeEnum.optional(),
}).refine((d) => {
  if (d.scenario === "A") {
    const validA = ["non_repondu_simple", "messagerie_vocale", "ligne_occupee",
      "numero_invalide", "mauvais_contact", "a_rappeler", "injoignable_final", "appel_interrompu"];
    return validA.includes(d.subScenario);
  }
  if (d.scenario === "B") {
    return d.subScenario === "en_poste_cloture"
      && d.stillEmployed !== undefined
      && d.projectsInJob !== undefined
      && d.renewInterest !== undefined
      && d.sponsorshipDetected !== undefined;
  }
  if (d.scenario === "C") {
    const validC = ["rupture_a_transmettre", "rupture_sans_recherche", "rupture_transmise"];
    return validC.includes(d.subScenario)
      && d.ruptureConfirmed !== undefined
      && d.searchingNewJob !== undefined;
  }
  return true;
}, { message: "Sub-scenario and required fields must match the selected scenario" });

export type QualifyCallPayload = z.infer<typeof qualifyCallSchema>;

// qa-engine/src/contexts/cross-run-learning/domain/curriculum.ts
// The per-app prior over SCENARIO ARCHETYPES: which kinds of test scenario have objective evidence
// of producing value in THIS app. Pure — no I/O, never throws, deterministic (same curriculum +
// same exemplars => same order => same prompt). Migrated from src/qa/learning/curriculum.ts, whose
// three-stage loop (recordArchetypeHit -> selectActiveArchetypes -> renderArchetypesForPrompt) was
// dead end-to-end. Two behavioural changes over that module, both deliberate:
//
//  1. Evidence is a LADDER, not a single boolean. `caughtRealBug`/`promotionCount` keep their exact
//     original meaning (the adjudicator's deterministic app_defect verdict) so every existing read
//     surface stays valid; `evaluated`/`credited` add the frequent, still-objective change-coverage
//     tier so the curriculum actually accumulates signal instead of staying empty forever.
//  2. Ranking replaces select+render. The old selectActiveArchetypes returned ONLY proven
//     archetypes ordered by a monotonically-increasing count — a ratchet that could never demote and
//     that starved every unproven archetype of the chance to earn evidence. archetypeScore is a
//     Laplace-smoothed RATE, so evidence is relative and small samples are damped.
//
// The module-scope `activeCache` Map of the original is intentionally NOT carried over: it had zero
// callers and a mutable module-global in a domain module makes test order significant.

import type { RunVerdict } from "@kernel/run-verdict.ts";
import { ALL_ARCHETYPES, type ScenarioArchetype } from "@kernel/scenario-archetype.ts";
import { BUILT_IN_EXEMPLARS, type SkillExemplar } from "@kernel/scenario-catalog.ts";

export interface ArchetypeEntry {
  archetype: ScenarioArchetype;
  // STRICTLY the adjudicator's app_defect verdict — never coverage. The intelligence view, the TUI
  // and chat.ts all render this as "proven by a real bug"; widening it would make those surfaces lie.
  caughtRealBug: boolean;
  firstCaughtAt: string | null;
  promotionCount: number;
  lastPromoted: string | null;
  // Runs in which this archetype was OFFERED to the generator (rendered in the prompt, not merely
  // matched) AND the run produced a determinable objective signal. An inconclusive run increments
  // neither counter — see classifyEvidence.
  evaluated: number;
  credited: number;
}

export interface Curriculum {
  app: string;
  updatedAt: string;
  archetypes: ArchetypeEntry[];
}

export type CurriculumEvidence = "bug" | "covered" | "uncovered" | "inconclusive";

export interface EvidenceInput {
  verdict: RunVerdict;
  // The kernel's wide `RunOutcome.adjudication.class` (string, not the domain's narrow union).
  adjudicationClass?: string;
  // DecideCoverageService's already-computed status, consumed — never re-derived from a ratio.
  coverageStatus?: "pass" | "fail" | "unknown";
}

export function initCurriculum(app: string): Curriculum {
  return {
    app,
    updatedAt: new Date().toISOString(),
    archetypes: ALL_ARCHETYPES.map(blankEntry),
  };
}

function blankEntry(archetype: ScenarioArchetype): ArchetypeEntry {
  return { archetype, caughtRealBug: false, firstCaughtAt: null, promotionCount: 0, lastPromoted: null, evaluated: 0, credited: 0 };
}

// Load-time normalization instead of a SQL migration: the curriculum is persisted as a JSON blob,
// so widening ArchetypeEntry needs no schema change — only a total, never-throwing reader. Any
// unusable input degrades to a fresh curriculum, and any archetype missing from the stored set is
// backfilled, so a vocabulary addition never strands a stored row.
export function normalizeCurriculum(raw: unknown, app: string): Curriculum {
  const stored = new Map<string, Partial<ArchetypeEntry>>();
  if (raw && typeof raw === "object" && Array.isArray((raw as Curriculum).archetypes)) {
    for (const e of (raw as Curriculum).archetypes) {
      if (e && typeof e.archetype === "string") stored.set(e.archetype, e);
    }
  }
  return {
    app,
    updatedAt: typeof (raw as Curriculum)?.updatedAt === "string" ? (raw as Curriculum).updatedAt : new Date().toISOString(),
    archetypes: ALL_ARCHETYPES.map((archetype) => {
      const prior = stored.get(archetype);
      if (!prior) return blankEntry(archetype);
      return {
        archetype,
        caughtRealBug: prior.caughtRealBug === true,
        firstCaughtAt: typeof prior.firstCaughtAt === "string" ? prior.firstCaughtAt : null,
        promotionCount: nonNegative(prior.promotionCount),
        lastPromoted: typeof prior.lastPromoted === "string" ? prior.lastPromoted : null,
        evaluated: nonNegative(prior.evaluated),
        credited: nonNegative(prior.credited),
      };
    }),
  };
}

function nonNegative(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// The ONE place the evidence ladder is decided. Every input is a value the run has already
// computed; nothing here is an LLM judgement.
export function classifyEvidence(input: EvidenceInput): CurriculumEvidence {
  // app_defect is the adjudicator's deterministic "a test caught a real application bug" verdict
  // (adjudicate.service.ts Rules 2.5/2.6/3). It outranks coverage: catching a real defect is the
  // strongest possible evidence an archetype was worth generating.
  if (input.adjudicationClass === "app_defect") return "bug";
  // Below the bug tier only a GREEN run carries a readable signal. A failing run adjudicated
  // anything other than app_defect indicts the generated test, not the archetype it came from;
  // flaky/invalid/infra-error/skipped never executed a meaningful suite against the change.
  if (input.verdict !== "pass") return "inconclusive";
  if (input.coverageStatus === "pass") return "covered";
  if (input.coverageStatus === "fail") return "uncovered";
  // "unknown" (no usable coverage, cross-repo runs) NEVER becomes evidence — the same keystone
  // invariant DecideCoverageService enforces for publish decisions.
  return "inconclusive";
}

// Applies ONE run's evidence to every archetype that run offered. Returns the SAME object when
// there is nothing to record, so a caller can skip the store write on identity.
export function foldCurriculum(
  curriculum: Curriculum,
  offered: readonly string[],
  evidence: CurriculumEvidence,
  now: string,
): Curriculum {
  if (evidence === "inconclusive" || offered.length === 0) return curriculum;

  const offeredSet = new Set(offered);
  let changed = false;
  const archetypes = curriculum.archetypes.map((entry) => {
    if (!offeredSet.has(entry.archetype)) return entry;
    changed = true;
    const next: ArchetypeEntry = { ...entry, evaluated: entry.evaluated + 1 };
    if (evidence === "uncovered") return next;
    next.credited += 1;
    if (evidence === "bug") {
      next.promotionCount += 1;
      next.lastPromoted = now;
      if (!next.caughtRealBug) {
        next.caughtRealBug = true;
        next.firstCaughtAt = now;
      }
    }
    return next;
  });

  return changed ? { ...curriculum, archetypes, updatedAt: now } : curriculum;
}

// Laplace-smoothed credit rate. evaluated=0 yields exactly 0.5, so a never-tried archetype
// outranks a demonstrated-useless one (3 evaluated / 0 credited -> 0.2) and is outranked by a
// well-evidenced one (3/3 -> 0.8) with no special case and no random tiebreak.
export function archetypeScore(entry: ArchetypeEntry): number {
  return (entry.credited + 1) / (entry.evaluated + 2);
}

// Total, stable ordering over the exemplars a run matched: proven first, then smoothed score, then
// absolute credit, then catalog index. Reorders only — never filters, so a zero-evidence archetype
// keeps its chance to earn evidence. Capping is the CALLER's budget decision, not a curriculum veto.
export function rankExemplars(curriculum: Curriculum, exemplars: readonly SkillExemplar[]): SkillExemplar[] {
  const byArchetype = new Map(curriculum.archetypes.map((e) => [e.archetype as string, e]));
  const catalogIndex = new Map(BUILT_IN_EXEMPLARS.map((e, i) => [e.id, i]));
  return [...exemplars].sort((a, b) => {
    const ea = byArchetype.get(a.archetype);
    const eb = byArchetype.get(b.archetype);
    const provenA = ea?.caughtRealBug === true ? 0 : 1;
    const provenB = eb?.caughtRealBug === true ? 0 : 1;
    if (provenA !== provenB) return provenA - provenB;
    const scoreA = ea ? archetypeScore(ea) : 0.5;
    const scoreB = eb ? archetypeScore(eb) : 0.5;
    if (scoreA !== scoreB) return scoreB - scoreA;
    const creditA = ea?.credited ?? 0;
    const creditB = eb?.credited ?? 0;
    if (creditA !== creditB) return creditB - creditA;
    return (catalogIndex.get(a.id) ?? 0) - (catalogIndex.get(b.id) ?? 0);
  });
}

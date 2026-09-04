// src/qa/learning/curriculum.ts
// Shell re-export. The curriculum's logic migrated to qa-engine (cross-run-learning/domain/
// curriculum.ts) because it is engine logic that now participates in the run's retrieve/fold path,
// and qa-engine may not import src/. This file stays only so the shell's four existing consumers —
// src/server/history.ts, src/server/intelligence-view.ts, src/server/chat.ts, src/cli.ts — keep
// their import paths. Same thin-re-export shape src/orchestrator/schemas.ts uses for
// ManifestEntrySchema; shell -> qa-engine is the open direction.
export type { Curriculum, ArchetypeEntry, CurriculumEvidence } from "@contexts/cross-run-learning/domain/curriculum";
export { initCurriculum, normalizeCurriculum, classifyEvidence, foldCurriculum, archetypeScore, rankExemplars } from "@contexts/cross-run-learning/domain/curriculum";
export { ALL_ARCHETYPES, type ScenarioArchetype } from "@kernel/scenario-archetype";

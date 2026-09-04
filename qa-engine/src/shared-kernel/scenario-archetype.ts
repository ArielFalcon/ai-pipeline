// qa-engine/src/shared-kernel/scenario-archetype.ts
// THE canonical scenario-archetype vocabulary — a KIND OF TEST SCENARIO ("test the invalid-input
// case"), NOT a shape of code change (that is StructuralPattern, ./structural-pattern.ts). Before
// this module the SAME union was declared twice: in src/qa/learning/curriculum.ts (shell) and in
// generation's skill-exemplar.ts, whose own header explained it "structurally mirrors" the shell
// copy because it may not import src/. Two hand-maintained twins of one shape is exactly what
// manifest-entry.ts exists to prevent; lifting the union into the kernel collapses them into one
// definition every context may import.

export type ScenarioArchetype =
  | "happy-path"
  | "empty-state"
  | "boundary-value"
  | "invalid-input"
  | "re-query-after-mutation"
  | "concurrent-update"
  | "permission-denied"
  | "network-error"
  | "loading-state"
  | "stale-data";

export const ALL_ARCHETYPES: readonly ScenarioArchetype[] = [
  "happy-path", "empty-state", "boundary-value", "invalid-input",
  "re-query-after-mutation", "concurrent-update", "permission-denied",
  "network-error", "loading-state", "stale-data",
] as const;

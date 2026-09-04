import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ALL_ARCHETYPES, type ScenarioArchetype } from "@kernel/scenario-archetype.ts";
import { BUILT_IN_EXEMPLARS } from "@kernel/scenario-catalog.ts";

describe("scenario archetype vocabulary", () => {
  it("declares exactly the ten known archetypes", () => {
    assert.deepEqual([...ALL_ARCHETYPES], [
      "happy-path", "empty-state", "boundary-value", "invalid-input",
      "re-query-after-mutation", "concurrent-update", "permission-denied",
      "network-error", "loading-state", "stale-data",
    ]);
  });

  it("is the single source of truth: every catalog exemplar's archetype is in the union", () => {
    const known = new Set<ScenarioArchetype>(ALL_ARCHETYPES);
    for (const e of BUILT_IN_EXEMPLARS) {
      assert.equal(known.has(e.archetype), true, `unknown archetype: ${e.archetype}`);
    }
  });
});

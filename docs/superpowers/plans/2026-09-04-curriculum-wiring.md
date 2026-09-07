# Curriculum Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dead `Curriculum` module into a live, deterministic per-app prior that reorders the skill-exemplar templates the generator already receives, so prompt bytes go to the scenario archetypes that have objective evidence of finding bugs in *this* app.

**Architecture:** The curriculum becomes a fourth off-path flywheel collaborator alongside `LearningPort` / `ReflectorPort` / `ProcessAuditPort` — same `[SWAP]`-optional, fault-isolated, never-gates-publish contract. Its **write** side folds one deterministic evidence label per run (derived only from `RunOutcome.adjudication.class` and the change-coverage status, never from an LLM). Its **read** side ranks the *already-matched* skill exemplars and caps them at 3, so the section can no longer be silently dropped by the byte budget. The scenario vocabulary and exemplar catalog move to the shared kernel, collapsing the currently-duplicated `ScenarioArchetype` type into one definition.

**Tech Stack:** TypeScript (no build step, `tsx`), `node:test` + `node:assert/strict`, zod contract schemas, `better-sqlite3` via `src/server/history.ts`, dependency-cruiser for the architecture gate.

## Global Constraints

- `npm test`, `npm run typecheck` and `npm run arch:check` must be green at the end of **every** task.
- `qa-engine/src` must never import `src/` (`no-src-import-in-qa-engine`). Shell → qa-engine is the open direction.
- Nothing app-specific may enter `src/` or `qa-engine/`. App-specificity lives only in `config/`.
- The curriculum is **off-path**: a curriculum fault (load, save, rank, fold) is logged and swallowed, never propagated, never gates a verdict or a publish decision.
- Never fabricate a value. Absent evidence records nothing; it never records a zero standing in for "unknown".
- Everything in English; comments describe the final state, not the process.
- qa-engine tests live under `qa-engine/test/**` mirroring `qa-engine/src/**`; `src/` tests are colocated `*.test.ts`.
- Exemplar cap is **3**. Rendered `skill-exemplars` section must stay under its existing `maxBytes: 1536`.
- Laplace prior constant: `score = (credited + 1) / (evaluated + 2)`.

---

## Diagnosis: what is actually broken

Read this before Task 1. Every design decision below follows from it.

`src/qa/learning/curriculum.ts` is a complete, tested, three-stage loop — **record hit → select active → render into prompt** — in which *all three stages are dead*:

| Function | Production callers |
|---|---|
| `recordArchetypeHit` | 0 |
| `selectActiveArchetypes` / `selectActiveArchetypesCached` | 0 |
| `renderArchetypesForPrompt` | 0 |
| `saveCurriculum` (`src/server/history.ts:883`) | 0 |

Only the **read** surfaces are wired: `loadCurriculum` → `toIntelligenceView` → `CurriculumViewSchema` → `GET /api/apps/:name/intelligence` → the Go TUI's intelligence screen, `npm run qa -- --learning`, and `chat.ts`. Because nothing ever writes, `loadCurriculum` returns `null` forever and every one of those surfaces renders "no curriculum". The SQLite `curriculum` table exists and is empty by construction.

The reason it was never wired is a **missing type bridge**: `recordArchetypeHit` needs a `ScenarioArchetype` (a *kind of test scenario*: `invalid-input`, `empty-state`, …), and nothing in the run flow produces one. What the run flow *does* produce is `detectArchetype(diff, changedFiles)` — a `StructuralPattern` **kind** (`form`, `api-call`, `auth-flow`, …), a *shape of code change*. These are different vocabularies and the codebase already treats them as such.

The bridge exists and is already live, just unexploited: `qa-engine/src/contexts/generation/infrastructure/prompt-builders/skill-exemplar.ts`'s `SkillExemplar` carries **both** — a `pattern: StructuralPattern` and an `archetype: ScenarioArchetype`. `prompts.ts:927-940` already runs `detectStructuralPatterns(diff, changedFiles) → matchExemplars(p) → dedupe → renderExemplarsForPrompt(...)` on every generation prompt. So the run **already** derives, deterministically and without an LLM, the set of scenario archetypes it is asking the generator to write. It just throws that set away.

Two further facts shape the design:

1. **`skill-exemplar.ts` declares its own copy of `ScenarioArchetype`**, with a header comment explaining that it "structurally mirrors" `src/qa/learning/curriculum.ts`'s type but may not import it because `curriculum.ts` lives in `src/`. Wiring the curriculum without fixing this would leave two unions that can silently drift.
2. **The exemplar section is droppable.** `prompts.ts:979` renders it at `{ priority: 3, maxBytes: 1536 }` with the default `overflow: "drop"` — an over-budget match set is omitted **entirely**. So "which archetypes did we offer the generator" is not knowable from the match set alone.

---

## Design decisions and their justification

### D1 — Evidence: what counts as "this archetype earned its place"

**Decision.** Exactly one evidence label per run, derived from values the run has already computed:

| Label | Deterministic condition | Effect on every offered archetype |
|---|---|---|
| `bug` | `outcome.adjudication.class === "app_defect"` | `caughtRealBug = true`, `promotionCount++`, `evaluated++`, `credited++` |
| `covered` | `verdict === "pass"` **and** coverage status `=== "pass"` | `evaluated++`, `credited++` |
| `uncovered` | `verdict === "pass"` **and** coverage status `=== "fail"` | `evaluated++` |
| `inconclusive` | everything else | **nothing recorded at all** |

**Why `app_defect`.** It is the system's only existing "a test caught a real application bug" judgement, and it is *deterministic*: `adjudicate.service.ts` reaches it through three pure rules — an attributed 5xx (Rule 2.5), a classified browser runtime error (Rule 2.6), or `isLikelyRealBug` = selectors-unique + all failures are value mismatches (Rule 3). No LLM. It is also already threaded onto `RunOutcome.adjudication` and already used to gate the learning fold, so reusing it adds no new plumbing and no new proxy metric — which is exactly what CLAUDE.md's value/trust section demands ("new quality logic should lean on the coverage signal, not add another LLM proxy").

**Why coverage as the second tier.** `app_defect` is rare. If it were the only credit path, the curriculum would stay empty in shadow-mode demos and would change nothing about generation — we would have shipped a feature that "runs correctly" without adding value, the precise failure mode this plan must avoid. Change-coverage is the keystone objective signal, is measured on **every** diff-mode run in `signal` mode, and answers a question that is genuinely about test quality: *did the tests these archetypes produced actually exercise the changed lines?* We consume `DecideCoverageService`'s already-computed `status`, never a re-derived ratio comparison — one source of truth, per the `blocks()` precedent.

**Why `inconclusive` records nothing.** An `invalid` run (static gate failed, nothing ever executed), a cross-repo run (`coverageRatio` is structurally `unknown`), a `flaky` run, or a `fail` adjudicated `generated_test_defect` all say something about the *generator* or the *environment*, not about the archetype. Recording a miss there would punish `invalid-input` for a `tsc` error. Incrementing `evaluated` without a determinable outcome would also dilute the rate with runs that could never have produced evidence. So: no signal → no row change. This is the same "never fabricated, absent means never ran" discipline the kernel's telemetry fields already use.

**Rejected alternative — credit on `verdict === "pass"` alone.** A green suite proves nothing; the whole point of the change-coverage keystone is that green-but-vacuous is the system's central failure mode. Crediting green would make the curriculum a Goodhart amplifier.

**Rejected alternative — per-spec attribution.** Crediting only the archetype of the *specific* failing spec would be sharper, but the only per-spec archetype signal available is the agent-authored free text in `QaCase.objective` / `ManifestEntry.flow`, which would require keyword-matching an LLM's prose — non-deterministic in the way that matters and a new proxy metric. Run-level attribution over a set of ≤3 offered archetypes is coarse but honest.

### D2 — Ranking: `(credited + 1) / (evaluated + 2)`

**Decision.** Order matched exemplars by, in order: `caughtRealBug` descending; then Laplace-smoothed score descending; then `credited` descending; then catalog index ascending.

**Why Laplace.** A never-evaluated archetype scores exactly `1/2 = 0.5`; a 0-for-3 archetype scores `1/5 = 0.2`; a 3-for-3 scores `4/5 = 0.8`. So an untried archetype naturally outranks a demonstrated-useless one and is outranked by a proven one — exploration without a special case, without a magic neutral constant, and without any randomness. Small samples are damped automatically. The catalog-index tiebreak makes the whole ordering a total, reproducible function of the stored counters: the same curriculum always produces the same prompt.

**Why a rate and not a count.** A pure `promotionCount` ordering is a ratchet — it only ever increases, so an archetype that got lucky once outranks everything forever. A rate lets evidence decay in relative terms and is the same governance shape `LearningRule.successRate` already uses.

**Why rank and never filter.** A zero-evidence archetype might simply be new. Removing it would deny it the chance to earn evidence and would freeze the curriculum at whatever the first few runs happened to show. The only removal is the cap (D3), which is a budget decision, not a curriculum veto.

### D3 — Cap at 3, decided by the caller, never by the byte budget

**Decision.** `CurriculumPort.select()` returns **at most 3** exemplars, in rank order. `prompts.ts` renders exactly what it is given, in the given order.

**Why.** This is what makes the write side honest. `usageCount` on learning rules is already incremented on "exactly the budget-fitted set — no phantom 'used' rules that were truncated out of the prompt" (`learning-port.adapter.ts:90-97`). The curriculum needs the same guarantee for `evaluated`: the set we fold must be the set the generator actually saw. Today the exemplar section is dropped whole when it exceeds `maxBytes: 1536`, so a caller-side count cap plus an **exhaustive** byte test over all `C(6,3) = 20` three-exemplar subsets converts "probably fits" into a compile-and-test-enforced fact.

If that exhaustive test ever fails, the fix is to **lower the cap to 2**, not to raise `maxBytes`. Raising the budget steals window from the other priority-3 sections (`static-signal`, `service-links`, `diff-archetypes`), which is a cost paid by every run to benefit one.

**Secondary benefit, and the reason this is the value-adding integration rather than a cosmetic one:** today `matchExemplars` returns catalog order, identically for every app, forever, unbounded. After this change the same 1536 bytes carry the three templates with the best evidence *for this app*, and the section stops being silently droppable.

### D4 — Marker, not a new prompt section

**Decision.** Proven archetypes are marked inline in the heading `prompts.ts` already renders: `### Form invalid input (invalid-input) — PROVEN (2 bugs)`. `renderArchetypesForPrompt` (the dead "## Scenario archetypes proven to matter for this app" block) is **deleted**, not wired.

**Why.** A separate section would restate archetype names the exemplar headings already carry, add a fifth priority-3 section competing for the same window, and separate the evidence from the template it justifies. Seventeen inline characters attach the reason directly to the thing the generator is being asked to prioritise. The marker only renders when `caughtRealBug` is true, so it is never fabricated.

### D5 — The vocabulary and the catalog move to the shared kernel

**Decision.** `ScenarioArchetype` + `ALL_ARCHETYPES` → `qa-engine/src/shared-kernel/scenario-archetype.ts`. `StructuralPattern` + `SkillExemplar` + the catalog + `matchExemplars` + `renderExemplarsForPrompt` → `qa-engine/src/shared-kernel/scenario-catalog.ts`. `detectStructuralPatterns` → `qa-engine/src/shared-kernel/structural-pattern.ts`. `src/qa/learning/curriculum.ts` becomes a thin re-export of the qa-engine domain module.

**Why the kernel.** These are pure, dependency-free, static vocabulary now consumed by three contexts: `generation` renders them, `cross-run-learning` scores them, `qa-run-orchestration` threads them. `manifest-entry.ts` set the exact precedent — "this schema lives in the KERNEL (no src/ import) … reused by BOTH consumption sites — never a third shape" — and it exists to solve this same problem (two independently-maintained twins of one shape that had already drifted). Putting the vocabulary in the kernel collapses the documented `ScenarioArchetype` duplicate into one definition and avoids a `cross-run-learning/infrastructure` → `generation/infrastructure` import.

**Why the shell file becomes a re-export.** `src/server/history.ts`, `src/server/intelligence-view.ts`, `src/server/chat.ts` and `src/cli.ts` all import `Curriculum` from `src/qa/learning/curriculum`. A re-export keeps all four compiling unchanged while the logic lives where the boundary rule requires new engine logic to live. This is the same shape `src/orchestrator/schemas.ts` uses for `ManifestEntrySchema`, and it resolves the tier-1-2 triage's `curriculum.ts` "DEFER — D8 entanglement" for this module specifically without converging the whole two-store duality.

### D6 — Port shape: selection happens behind the port

**Decision.** One `CurriculumPort` on `RunQaUseCaseDeps` with two methods; the adapter, not the use-case, owns diff → patterns → exemplars → rank → cap.

```ts
select(diff: string | undefined, changedFiles: readonly string[]): Promise<readonly SelectedExemplar[]>
fold(input: CurriculumFoldInput): Promise<void>
```

**Why.** The use-case's application layer must not import another context's matching logic, and threading raw `StructuralPattern[]` up and a ranking back down would put the ordering decision in two places. Behind the port, the use-case holds exactly one thing — the list it sent — which is precisely what it must fold. Both methods are fault-isolated *inside the adapter*, matching `ReflectorPortAdapter`'s and `ProcessAuditPortAdapter`'s documented contract, so the use-case needs no `try/catch` of its own.

**Why `[SWAP]`-optional with no stub default.** The adapter needs `loadCurriculum` / `saveCurriculum` from `src/server/history.ts`, which the composition root may not import. So — exactly like `reflectorPort`, `confinement`, `mirrorGc` and `processAudit` — the port is threaded straight through `CompositionConfig` and only `src/server/rewritten-engine-factory.ts` constructs the real adapter. Absent ⇒ provably zero behaviour change.

---

## File structure

**New — qa-engine (kernel):**
- `qa-engine/src/shared-kernel/scenario-archetype.ts` — the one `ScenarioArchetype` union + `ALL_ARCHETYPES`.
- `qa-engine/src/shared-kernel/scenario-catalog.ts` — moved from `generation/.../skill-exemplar.ts`: `StructuralPattern`, `SkillExemplar`, catalog, `matchExemplars`, `renderExemplarsForPrompt`.
- `qa-engine/src/shared-kernel/structural-pattern.ts` — moved from `generation/.../structural-pattern.ts`: `detectStructuralPatterns`.

**New — qa-engine (engine):**
- `qa-engine/src/contexts/cross-run-learning/domain/curriculum.ts` — pure: types, `initCurriculum`, `normalizeCurriculum`, `classifyEvidence`, `foldCurriculum`, `archetypeScore`, `rankExemplars`.
- `qa-engine/src/contexts/cross-run-learning/infrastructure/curriculum-port.adapter.ts` — the real `CurriculumPort`; owns fault isolation and the store round-trip.

**Modified — qa-engine:**
- `qa-engine/src/contexts/generation/infrastructure/prompt-builders/skill-exemplar.ts` — deleted; imports repointed to the kernel.
- `qa-engine/src/contexts/generation/infrastructure/prompt-builders/structural-pattern.ts` — deleted; imports repointed to the kernel.
- `qa-engine/src/contexts/generation/infrastructure/prompt-builders/prompts.ts` — prefer supplied ranked exemplars; render the PROVEN marker.
- `qa-engine/src/contexts/generation/application/ports/generation-ports.ts` — `OpencodeRunInput.skillExemplars?`.
- `qa-engine/src/contexts/qa-run-orchestration/application/ports/index.ts` — `SelectedExemplar`, `CurriculumFoldInput`, `CurriculumPort`, `GenerationEnrichment.skillExemplars?`.
- `qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts` — `select()` before generation, `coverageStatus` capture, `fold()` after `learning.fold`.
- `qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.ts` — 1:1 enrichment mapping.
- `qa-engine/src/contexts/qa-run-orchestration/composition/composition-root.ts` — `curriculumPort?` pass-through.
- `qa-engine/src/shared-kernel/contract/commands.ts` — `CurriculumViewSchema` gains `evaluated` / `credited`.

**Modified — shell:**
- `src/qa/learning/curriculum.ts` — thin re-export.
- `src/qa/learning/curriculum.test.ts` — deleted (ported to qa-engine).
- `src/server/rewritten-engine-factory.ts` — construct and inject the adapter.
- `src/server/intelligence-view.ts` — project the two new counters.
- `src/cli.ts` — show them in `--learning`.
- `client/internal/ui/intelligence.go` — render them.
- Regenerated: `contract/openapi.json`, `packages/sdk/src/types.gen.ts`, `client/internal/contract/types.gen.go`.

---

## Task 1: Kernel vocabulary + catalog relocation

Pure move. No behaviour change — the exhaustive proof is that `npm test` stays green with zero test edits beyond import paths.

**Files:**
- Create: `qa-engine/src/shared-kernel/scenario-archetype.ts`
- Create: `qa-engine/src/shared-kernel/scenario-catalog.ts`
- Create: `qa-engine/src/shared-kernel/structural-pattern.ts`
- Delete: `qa-engine/src/contexts/generation/infrastructure/prompt-builders/skill-exemplar.ts`
- Delete: `qa-engine/src/contexts/generation/infrastructure/prompt-builders/structural-pattern.ts`
- Modify: `qa-engine/src/contexts/generation/infrastructure/prompt-builders/prompts.ts` (imports only)
- Test: `qa-engine/test/shared-kernel/scenario-archetype.test.ts` (new)

**Interfaces:**
- Produces: `ScenarioArchetype` (union of 10 literals), `ALL_ARCHETYPES: readonly ScenarioArchetype[]`, `StructuralPattern`, `SkillExemplar { id, name, description, pattern, template, archetype }`, `BUILT_IN_EXEMPLARS: readonly SkillExemplar[]` (newly **exported** — Task 3's cap test needs it), `matchExemplars(pattern): SkillExemplar[]`, `renderExemplarsForPrompt(exemplars, opts?): string`, `detectStructuralPatterns(diff, changedFiles): StructuralPattern[]`.

- [ ] **Step 1: Write the failing test**

Create `qa-engine/test/shared-kernel/scenario-archetype.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import ./test-setup.mjs --import tsx --test qa-engine/test/shared-kernel/scenario-archetype.test.ts`
Expected: FAIL — `Cannot find module '@kernel/scenario-archetype.ts'`.

- [ ] **Step 3: Create the kernel vocabulary module**

Create `qa-engine/src/shared-kernel/scenario-archetype.ts`:

```ts
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
```

- [ ] **Step 4: Move the catalog into the kernel**

Create `qa-engine/src/shared-kernel/scenario-catalog.ts` with the **verbatim** contents of `qa-engine/src/contexts/generation/infrastructure/prompt-builders/skill-exemplar.ts`, with exactly four edits:

1. Replace the file header with:

```ts
// qa-engine/src/shared-kernel/scenario-catalog.ts
// The static authoring-template catalog: StructuralPattern (shape of code change) -> SkillExemplar
// (a template to write) -> ScenarioArchetype (the kind of scenario it produces). Relocated here from
// generation/infrastructure/prompt-builders/skill-exemplar.ts because it now has THREE consumers
// across contexts — generation renders it, cross-run-learning scores it, qa-run-orchestration
// threads it — and it is pure, dependency-free vocabulary. Same kernel rationale as
// manifest-entry.ts. This is NOT a learned store: selection is pattern-shape based; the LEARNED
// ordering over these entries lives in cross-run-learning/domain/curriculum.ts.
import type { ScenarioArchetype } from "./scenario-archetype.ts";
export type { ScenarioArchetype };
```

2. Delete the locally-declared `export type ScenarioArchetype = …` union (now imported).
3. Change `const BUILT_IN_EXEMPLARS: SkillExemplar[]` to `export const BUILT_IN_EXEMPLARS: readonly SkillExemplar[]` — Task 3's exhaustive cap test enumerates it.
4. Leave `StructuralPattern`, `SkillExemplar`, `matchExemplars` and `renderExemplarsForPrompt` byte-identical.

- [ ] **Step 5: Move the detector into the kernel**

Create `qa-engine/src/shared-kernel/structural-pattern.ts` with the verbatim contents of `qa-engine/src/contexts/generation/infrastructure/prompt-builders/structural-pattern.ts`, changing only the header and the import:

```ts
// qa-engine/src/shared-kernel/structural-pattern.ts
// Deterministic diff -> StructuralPattern detection (pure regex/extension heuristics, no LLM).
// Relocated to the kernel alongside scenario-catalog.ts: cross-run-learning's CurriculumPortAdapter
// needs the SAME derivation the generation prompt uses, and both must see one implementation —
// two copies of this detector would silently diverge the "offered archetypes" the curriculum folds
// from the ones the generator was actually shown.
import type { StructuralPattern } from "./scenario-catalog.ts";
```

- [ ] **Step 6: Delete the two old modules and repoint imports**

```bash
rm qa-engine/src/contexts/generation/infrastructure/prompt-builders/skill-exemplar.ts
rm qa-engine/src/contexts/generation/infrastructure/prompt-builders/structural-pattern.ts
rg -l "prompt-builders/(skill-exemplar|structural-pattern)|from \"\./skill-exemplar\"|from \"\./structural-pattern\"" qa-engine src
```

In every file the `rg` lists (at minimum `prompts.ts`, plus the two old colocated test files under `qa-engine/test/contexts/generation/`), replace the imports with `@kernel/scenario-catalog.ts` / `@kernel/structural-pattern.ts`. Move those two test files to `qa-engine/test/shared-kernel/scenario-catalog.test.ts` and `qa-engine/test/shared-kernel/structural-pattern.test.ts`, changing nothing but the import paths — they are the proof this move is behaviour-neutral.

- [ ] **Step 7: Run the gates**

```bash
node --import ./test-setup.mjs --import tsx --test qa-engine/test/shared-kernel/scenario-archetype.test.ts
npm test && npm run typecheck && npm run arch:check
```
Expected: all PASS, with zero assertion changes in the moved tests.

- [ ] **Step 8: Commit**

```bash
git add -A qa-engine/src/shared-kernel qa-engine/src/contexts/generation qa-engine/test
git commit -m "refactor(kernel): lift scenario archetype vocabulary and exemplar catalog into the shared kernel"
```

---

## Task 2: Curriculum domain

Pure functions, no I/O. This task holds every policy decision from D1 and D2.

**Files:**
- Create: `qa-engine/src/contexts/cross-run-learning/domain/curriculum.ts`
- Test: `qa-engine/test/contexts/cross-run-learning/domain/curriculum.test.ts`
- Delete: `src/qa/learning/curriculum.test.ts`
- Modify: `src/qa/learning/curriculum.ts` (becomes a re-export)

**Interfaces:**
- Consumes: `ScenarioArchetype`, `ALL_ARCHETYPES` (Task 1); `SkillExemplar` (Task 1); `RunVerdict` from `@kernel/run-verdict.ts`.
- Produces: `ArchetypeEntry`, `Curriculum`, `CurriculumEvidence = "bug" | "covered" | "uncovered" | "inconclusive"`, `initCurriculum(app): Curriculum`, `normalizeCurriculum(raw: unknown, app: string): Curriculum`, `classifyEvidence(input): CurriculumEvidence`, `foldCurriculum(c, archetypes, evidence, now): Curriculum`, `archetypeScore(entry): number`, `rankExemplars(c, exemplars): SkillExemplar[]`.

- [ ] **Step 1: Write the failing tests**

Create `qa-engine/test/contexts/cross-run-learning/domain/curriculum.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initCurriculum, normalizeCurriculum, classifyEvidence, foldCurriculum,
  archetypeScore, rankExemplars,
} from "@contexts/cross-run-learning/domain/curriculum.ts";
import { ALL_ARCHETYPES } from "@kernel/scenario-archetype.ts";
import { BUILT_IN_EXEMPLARS } from "@kernel/scenario-catalog.ts";

const NOW = "2026-09-04T10:00:00.000Z";

describe("initCurriculum", () => {
  it("creates all ten archetypes with zeroed, unproven counters", () => {
    const c = initCurriculum("app");
    assert.equal(c.archetypes.length, ALL_ARCHETYPES.length);
    assert.equal(c.archetypes.every((a) => !a.caughtRealBug), true);
    assert.equal(c.archetypes.every((a) => a.evaluated === 0 && a.credited === 0), true);
  });
});

describe("normalizeCurriculum", () => {
  it("defaults evaluated/credited to 0 for a pre-existing row that lacks them", () => {
    const legacy = {
      app: "app", updatedAt: NOW,
      archetypes: [{ archetype: "invalid-input", caughtRealBug: true, firstCaughtAt: NOW, promotionCount: 2, lastPromoted: NOW }],
    };
    const c = normalizeCurriculum(legacy, "app");
    const e = c.archetypes.find((a) => a.archetype === "invalid-input")!;
    assert.equal(e.caughtRealBug, true);
    assert.equal(e.promotionCount, 2);
    assert.equal(e.evaluated, 0);
    assert.equal(e.credited, 0);
  });

  it("returns a fresh curriculum for unusable input rather than throwing", () => {
    assert.equal(normalizeCurriculum(null, "app").archetypes.length, ALL_ARCHETYPES.length);
    assert.equal(normalizeCurriculum({ nope: 1 }, "app").archetypes.length, ALL_ARCHETYPES.length);
  });

  it("backfills an archetype missing from a stored curriculum", () => {
    const partial = { app: "app", updatedAt: NOW, archetypes: [] };
    assert.equal(normalizeCurriculum(partial, "app").archetypes.length, ALL_ARCHETYPES.length);
  });
});

describe("classifyEvidence", () => {
  it("app_defect is 'bug' regardless of verdict or coverage", () => {
    assert.equal(classifyEvidence({ verdict: "fail", adjudicationClass: "app_defect" }), "bug");
  });

  it("green + coverage pass is 'covered'", () => {
    assert.equal(classifyEvidence({ verdict: "pass", coverageStatus: "pass" }), "covered");
  });

  it("green + coverage fail is 'uncovered'", () => {
    assert.equal(classifyEvidence({ verdict: "pass", coverageStatus: "fail" }), "uncovered");
  });

  it("green + coverage unknown is inconclusive — unknown never becomes evidence", () => {
    assert.equal(classifyEvidence({ verdict: "pass", coverageStatus: "unknown" }), "inconclusive");
    assert.equal(classifyEvidence({ verdict: "pass" }), "inconclusive");
  });

  it("a generated_test_defect failure is inconclusive — that is the generator's fault, not the archetype's", () => {
    assert.equal(classifyEvidence({ verdict: "fail", adjudicationClass: "generated_test_defect" }), "inconclusive");
  });

  it("flaky, invalid and infra-error are inconclusive", () => {
    for (const verdict of ["flaky", "invalid", "infra-error", "skipped"] as const) {
      assert.equal(classifyEvidence({ verdict, coverageStatus: "pass" }), "inconclusive");
    }
  });
});

describe("foldCurriculum", () => {
  it("'bug' proves the archetype and credits it", () => {
    const c = foldCurriculum(initCurriculum("app"), ["invalid-input"], "bug", NOW);
    const e = c.archetypes.find((a) => a.archetype === "invalid-input")!;
    assert.deepEqual(
      { caughtRealBug: e.caughtRealBug, promotionCount: e.promotionCount, evaluated: e.evaluated, credited: e.credited, firstCaughtAt: e.firstCaughtAt },
      { caughtRealBug: true, promotionCount: 1, evaluated: 1, credited: 1, firstCaughtAt: NOW },
    );
  });

  it("does not move firstCaughtAt on a repeat bug", () => {
    const c1 = foldCurriculum(initCurriculum("app"), ["invalid-input"], "bug", NOW);
    const c2 = foldCurriculum(c1, ["invalid-input"], "bug", "2026-09-05T10:00:00.000Z");
    const e = c2.archetypes.find((a) => a.archetype === "invalid-input")!;
    assert.equal(e.firstCaughtAt, NOW);
    assert.equal(e.promotionCount, 2);
  });

  it("'covered' credits without claiming a real bug", () => {
    const c = foldCurriculum(initCurriculum("app"), ["happy-path"], "covered", NOW);
    const e = c.archetypes.find((a) => a.archetype === "happy-path")!;
    assert.deepEqual({ caughtRealBug: e.caughtRealBug, evaluated: e.evaluated, credited: e.credited }, { caughtRealBug: false, evaluated: 1, credited: 1 });
  });

  it("'uncovered' counts the attempt but grants no credit", () => {
    const c = foldCurriculum(initCurriculum("app"), ["happy-path"], "uncovered", NOW);
    const e = c.archetypes.find((a) => a.archetype === "happy-path")!;
    assert.deepEqual({ evaluated: e.evaluated, credited: e.credited }, { evaluated: 1, credited: 0 });
  });

  it("'inconclusive' is a pure no-op — the same object identity comes back", () => {
    const before = initCurriculum("app");
    assert.equal(foldCurriculum(before, ["happy-path"], "inconclusive", NOW), before);
  });

  it("an empty offered set is a pure no-op", () => {
    const before = initCurriculum("app");
    assert.equal(foldCurriculum(before, [], "covered", NOW), before);
  });

  it("folds every offered archetype, and ignores an unknown one", () => {
    const c = foldCurriculum(initCurriculum("app"), ["happy-path", "empty-state", "not-an-archetype"], "covered", NOW);
    assert.equal(c.archetypes.find((a) => a.archetype === "happy-path")!.credited, 1);
    assert.equal(c.archetypes.find((a) => a.archetype === "empty-state")!.credited, 1);
    assert.equal(c.archetypes.length, ALL_ARCHETYPES.length);
  });
});

describe("archetypeScore", () => {
  it("is the neutral 0.5 prior when never evaluated", () => {
    assert.equal(archetypeScore(initCurriculum("app").archetypes[0]!), 0.5);
  });

  it("ranks a never-tried archetype above a demonstrated-useless one", () => {
    let c = initCurriculum("app");
    for (let i = 0; i < 3; i++) c = foldCurriculum(c, ["happy-path"], "uncovered", NOW);
    const tried = c.archetypes.find((a) => a.archetype === "happy-path")!;
    const untried = c.archetypes.find((a) => a.archetype === "empty-state")!;
    assert.equal(archetypeScore(tried), 1 / 5);
    assert.equal(archetypeScore(untried), 0.5);
    assert.ok(archetypeScore(untried) > archetypeScore(tried));
  });
});

describe("rankExemplars", () => {
  const byArchetype = (a: string) => BUILT_IN_EXEMPLARS.find((e) => e.archetype === a)!;

  it("puts a proven archetype first", () => {
    const c = foldCurriculum(initCurriculum("app"), ["empty-state"], "bug", NOW);
    const ranked = rankExemplars(c, [byArchetype("happy-path"), byArchetype("empty-state")]);
    assert.equal(ranked[0]!.archetype, "empty-state");
  });

  it("orders unproven archetypes by smoothed score, best first", () => {
    let c = initCurriculum("app");
    c = foldCurriculum(c, ["happy-path"], "covered", NOW);
    c = foldCurriculum(c, ["invalid-input"], "uncovered", NOW);
    const ranked = rankExemplars(c, [byArchetype("invalid-input"), byArchetype("happy-path")]);
    assert.deepEqual(ranked.map((e) => e.archetype), ["happy-path", "invalid-input"]);
  });

  it("is stable and total: equal evidence falls back to catalog order", () => {
    const c = initCurriculum("app");
    const input = [byArchetype("boundary-value"), byArchetype("invalid-input"), byArchetype("happy-path")];
    const a = rankExemplars(c, input).map((e) => e.id);
    const b = rankExemplars(c, [...input].reverse()).map((e) => e.id);
    assert.deepEqual(a, b);
  });

  it("never drops an exemplar — ranking reorders, it does not filter", () => {
    const c = initCurriculum("app");
    assert.equal(rankExemplars(c, [...BUILT_IN_EXEMPLARS]).length, BUILT_IN_EXEMPLARS.length);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import ./test-setup.mjs --import tsx --test qa-engine/test/contexts/cross-run-learning/domain/curriculum.test.ts`
Expected: FAIL — `Cannot find module '@contexts/cross-run-learning/domain/curriculum.ts'`.

- [ ] **Step 3: Write the domain module**

Create `qa-engine/src/contexts/cross-run-learning/domain/curriculum.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `node --import ./test-setup.mjs --import tsx --test qa-engine/test/contexts/cross-run-learning/domain/curriculum.test.ts`
Expected: PASS.

- [ ] **Step 5: Turn the shell module into a re-export**

Replace the entire contents of `src/qa/learning/curriculum.ts` with:

```ts
// src/qa/learning/curriculum.ts
// Shell re-export. The curriculum's logic migrated to qa-engine (cross-run-learning/domain/
// curriculum.ts) because it is engine logic that now participates in the run's retrieve/fold path,
// and qa-engine may not import src/. This file stays only so the shell's four existing consumers —
// src/server/history.ts, src/server/intelligence-view.ts, src/server/chat.ts, src/cli.ts — keep
// their import paths. Same thin-re-export shape src/orchestrator/schemas.ts uses for
// ManifestEntrySchema; shell -> qa-engine is the open direction.
export type { Curriculum, ArchetypeEntry, CurriculumEvidence } from "@contexts/cross-run-learning/domain/curriculum.ts";
export { initCurriculum, normalizeCurriculum, classifyEvidence, foldCurriculum, archetypeScore, rankExemplars } from "@contexts/cross-run-learning/domain/curriculum.ts";
export { ALL_ARCHETYPES, type ScenarioArchetype } from "@kernel/scenario-archetype.ts";
```

Then delete the superseded shell test — its every assertion is ported into the qa-engine suite above:

```bash
rm src/qa/learning/curriculum.test.ts
```

- [ ] **Step 6: Run the gates**

```bash
npm test && npm run typecheck && npm run arch:check
```
Expected: all PASS. If `typecheck` reports that `src/qa/learning/taxonomy`'s `ErrorClass` import is now unused in the re-export, that is expected — the new module never referenced it.

- [ ] **Step 7: Commit**

```bash
git add -A qa-engine/src/contexts/cross-run-learning qa-engine/test/contexts/cross-run-learning src/qa/learning/curriculum.ts src/qa/learning/curriculum.test.ts
git commit -m "feat(curriculum): migrate curriculum to a qa-engine domain module with an evidence ladder"
```

---

## Task 3: The port, the adapter, and the byte guarantee

**Files:**
- Modify: `qa-engine/src/contexts/qa-run-orchestration/application/ports/index.ts`
- Create: `qa-engine/src/contexts/cross-run-learning/infrastructure/curriculum-port.adapter.ts`
- Test: `qa-engine/test/contexts/cross-run-learning/infrastructure/curriculum-port.adapter.test.ts`
- Test: `qa-engine/test/shared-kernel/scenario-catalog.test.ts` (extend with the exhaustive cap proof)

**Interfaces:**
- Consumes: `rankExemplars`, `foldCurriculum`, `classifyEvidence`, `normalizeCurriculum`, `initCurriculum` (Task 2); `detectStructuralPatterns`, `matchExemplars`, `renderExemplarsForPrompt`, `BUILT_IN_EXEMPLARS` (Task 1).
- Produces: `SelectedExemplar { id: string; archetype: string; proven: boolean; promotionCount: number; name: string; template: string }`, `CurriculumFoldInput { offered: readonly string[]; verdict: RunVerdict; adjudicationClass?: string; coverageStatus?: "pass" | "fail" | "unknown" }`, `CurriculumPort`, `MAX_SELECTED_EXEMPLARS = 3`, `class CurriculumPortAdapter`.

- [ ] **Step 1: Write the exhaustive byte-budget test**

Append to `qa-engine/test/shared-kernel/scenario-catalog.test.ts`:

```ts
import { BUILT_IN_EXEMPLARS, renderExemplarsForPrompt } from "@kernel/scenario-catalog.ts";

// The skill-exemplars prompt section is rendered at { maxBytes: 1536, overflow: "drop" } — an
// over-budget match set is omitted ENTIRELY. The curriculum folds "what the generator was shown",
// so a silently dropped section would corrupt every `evaluated` counter. Capping at 3 in the
// selector is only honest if EVERY 3-exemplar subset provably fits: this enumerates all C(6,3)=20.
// If this ever fails, LOWER MAX_SELECTED_EXEMPLARS to 2 — do not raise maxBytes, which would steal
// window from the other priority-3 sections (static-signal, service-links, diff-archetypes).
const SECTION_MAX_BYTES = 1536;

describe("skill-exemplar section fits the prompt budget at the selection cap", () => {
  it("every 3-exemplar subset renders under 1536 bytes, worst case (all marked PROVEN)", () => {
    const list = [...BUILT_IN_EXEMPLARS];
    let combos = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        for (let k = j + 1; k < list.length; k++) {
          combos++;
          const text = renderExemplarsForPrompt(
            [list[i]!, list[j]!, list[k]!],
            { proven: { [list[i]!.archetype]: 99, [list[j]!.archetype]: 99, [list[k]!.archetype]: 99 } },
          );
          assert.ok(
            Buffer.byteLength(text, "utf8") < SECTION_MAX_BYTES,
            `subset ${list[i]!.id}/${list[j]!.id}/${list[k]!.id} rendered ${Buffer.byteLength(text, "utf8")} bytes`,
          );
        }
      }
    }
    assert.equal(combos, 20);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import ./test-setup.mjs --import tsx --test qa-engine/test/shared-kernel/scenario-catalog.test.ts`
Expected: FAIL — `renderExemplarsForPrompt` takes one argument; the `opts` overload does not exist yet.

- [ ] **Step 3: Add the PROVEN marker to the renderer**

In `qa-engine/src/shared-kernel/scenario-catalog.ts`, replace `renderExemplarsForPrompt`:

```ts
// opts.proven maps a ScenarioArchetype to its promotionCount (the number of times the adjudicator
// classified a run offering it as app_defect). A marked heading attaches the evidence directly to
// the template it justifies — 17 characters, versus a whole extra prompt section restating archetype
// names these headings already carry. Absent/zero -> no marker, never a fabricated claim.
// The parameter is NARROWED to the four fields this function actually reads. A full SkillExemplar
// satisfies it structurally, so every existing call site is unchanged — but a curriculum-ranked
// SelectedExemplar (which has no `description` or `pattern`) can now be passed directly, instead of
// forcing its caller to fabricate those two fields just to satisfy the type.
export type RenderableExemplar = Pick<SkillExemplar, "id" | "name" | "template" | "archetype">;

export function renderExemplarsForPrompt(
  exemplars: readonly RenderableExemplar[],
  opts?: { proven?: Readonly<Record<string, number>> },
): string {
  if (exemplars.length === 0) return "";

  const lines = [
    "## Skill exemplars for the detected structural patterns",
    "Apply these test templates to the current change. Each is a proven pattern for this kind of code.",
    "",
  ];

  for (const e of exemplars) {
    const bugs = opts?.proven?.[e.archetype] ?? 0;
    const marker = bugs > 0 ? ` — PROVEN (${bugs} ${bugs === 1 ? "bug" : "bugs"})` : "";
    lines.push(`### ${e.name} (${e.archetype})${marker}`);
    lines.push(e.template);
    lines.push("");
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run the byte test**

Run: `node --import ./test-setup.mjs --import tsx --test qa-engine/test/shared-kernel/scenario-catalog.test.ts`
Expected: PASS, 20 combinations checked. If any subset exceeds 1536, set `MAX_SELECTED_EXEMPLARS = 2` in Step 6 and change this test to enumerate `C(6,2) = 15` pairs.

- [ ] **Step 5: Write the failing adapter test**

Create `qa-engine/test/contexts/cross-run-learning/infrastructure/curriculum-port.adapter.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CurriculumPortAdapter } from "@contexts/cross-run-learning/infrastructure/curriculum-port.adapter.ts";
import { initCurriculum, foldCurriculum, type Curriculum } from "@contexts/cross-run-learning/domain/curriculum.ts";
import { MAX_SELECTED_EXEMPLARS } from "@contexts/qa-run-orchestration/application/ports/index.ts";

// A diff that trips several detectStructuralPatterns branches at once (form + api-call + data-list)
// so more exemplars match than the cap allows.
const RICH_DIFF = `
+<form (ngSubmit)="save()"><input required minlength="3" /></form>
+const res = await fetch(url, { method: 'POST', body: payload });
+if (!res.ok) { this.error = 'failed'; }
+<table><tr *ngFor="let row of rows"></tr></table>
+<div *ngIf="rows.length === 0">No results</div>
`;
const FILES = ["src/app/owner/owner.component.html", "src/app/owner/owner.service.ts"];

function store(initial: Curriculum | null) {
  let saved: Curriculum | null = initial;
  return {
    load: () => saved,
    save: (c: Curriculum) => { saved = c; },
    get current() { return saved; },
  };
}

describe("CurriculumPortAdapter.select", () => {
  it("returns at most MAX_SELECTED_EXEMPLARS, ranked", async () => {
    const s = store(null);
    const adapter = new CurriculumPortAdapter("app", s.load, s.save);
    const selected = await adapter.select(RICH_DIFF, FILES);
    assert.ok(selected.length > 0, "the rich diff must match at least one exemplar");
    assert.ok(selected.length <= MAX_SELECTED_EXEMPLARS);
  });

  it("puts a proven archetype first", async () => {
    const proven = foldCurriculum(initCurriculum("app"), ["empty-state"], "bug", "2026-09-04T10:00:00.000Z");
    const s = store(proven);
    const selected = await new CurriculumPortAdapter("app", s.load, s.save).select(RICH_DIFF, FILES);
    assert.equal(selected[0]!.archetype, "empty-state");
    assert.equal(selected[0]!.proven, true);
    assert.equal(selected[0]!.promotionCount, 1);
  });

  it("returns an empty list when there is no diff — nothing offered, nothing to fold", async () => {
    const s = store(null);
    assert.deepEqual(await new CurriculumPortAdapter("app", s.load, s.save).select(undefined, []), []);
  });

  it("returns an empty list, never throws, when the store fails", async () => {
    const adapter = new CurriculumPortAdapter("app", () => { throw new Error("db down"); }, () => {}, () => {});
    assert.deepEqual(await adapter.select(RICH_DIFF, FILES), []);
  });
});

describe("CurriculumPortAdapter.fold", () => {
  it("persists credit for every offered archetype on a covered run", async () => {
    const s = store(null);
    const adapter = new CurriculumPortAdapter("app", s.load, s.save);
    await adapter.fold({ offered: ["happy-path", "empty-state"], verdict: "pass", coverageStatus: "pass" });
    const saved = s.current!;
    assert.equal(saved.archetypes.find((a) => a.archetype === "happy-path")!.credited, 1);
    assert.equal(saved.archetypes.find((a) => a.archetype === "empty-state")!.credited, 1);
  });

  it("does not write at all for an inconclusive run", async () => {
    const s = store(null);
    await new CurriculumPortAdapter("app", s.load, s.save).fold({ offered: ["happy-path"], verdict: "flaky" });
    assert.equal(s.current, null);
  });

  it("swallows a store failure — never gates the run", async () => {
    let logged: unknown;
    const adapter = new CurriculumPortAdapter("app", () => null, () => { throw new Error("disk full"); }, (e) => { logged = e; });
    await adapter.fold({ offered: ["happy-path"], verdict: "pass", coverageStatus: "pass" });
    assert.ok(logged instanceof Error);
  });
});
```

- [ ] **Step 6: Declare the port**

Append to `qa-engine/src/contexts/qa-run-orchestration/application/ports/index.ts`:

```ts
// ── CurriculumPort ────────────────────────────────────────────────────────────
// The per-app scenario-archetype prior. [SWAP]-optional on RunQaUseCaseDeps, off-path, fault-
// isolated INSIDE the adapter — same contract as ReflectorPort/ProcessAuditPort/ConfinementPort:
// absent means the run behaves exactly as it does today, and a curriculum fault never gates a
// verdict or a publish decision.
//
// Selection lives BEHIND the port on purpose. The derivation (diff -> detectStructuralPatterns ->
// matchExemplars -> curriculum rank -> cap) is one decision; splitting it between the use-case and
// the prompt builder would let "what we offered" drift from "what we folded". The use-case holds
// exactly the list it sent, which is exactly what it must fold.

// The prompt-budget cap. This is a COUNT cap, not a byte cap, and it is enforced by the CALLER so
// the rendered section can never be silently dropped by prompts.ts's own { maxBytes: 1536,
// overflow: "drop" } — a dropped section would make every `evaluated` counter a lie. Proven safe
// exhaustively over all C(6,3) three-exemplar subsets (qa-engine/test/shared-kernel/
// scenario-catalog.test.ts). If that proof ever breaks, lower THIS constant; do not raise maxBytes.
export const MAX_SELECTED_EXEMPLARS = 3;

export interface SelectedExemplar {
  id: string;
  name: string;
  template: string;
  // Wide `string`, not ScenarioArchetype: this barrel is consumed by the generation bridge, and the
  // narrow union adds nothing a caller can act on here.
  archetype: string;
  // caughtRealBug for THIS app — drives the prompt's inline PROVEN marker.
  proven: boolean;
  promotionCount: number;
}

export interface CurriculumFoldInput {
  // The archetypes actually RENDERED into this run's generation prompt (SelectedExemplar.archetype
  // of what select() returned) — never the wider matched set.
  offered: readonly string[];
  verdict: RunVerdict;
  // RunOutcome.adjudication?.class (wide string, kernel convention).
  adjudicationClass?: string;
  // DecideCoverageService's status for this run, as returned by ObjectiveSignalPort.measure().
  // Absent -> treated as unmeasured, which classifyEvidence reads as inconclusive.
  coverageStatus?: "pass" | "fail" | "unknown";
}

export interface CurriculumPort {
  // diff absent (every non-diff mode) -> [] : no structural patterns, so nothing was offered and
  // nothing can be folded. The gate is data-driven, not a mode branch.
  select(diff: string | undefined, changedFiles: readonly string[]): Promise<readonly SelectedExemplar[]>;
  fold(input: CurriculumFoldInput): Promise<void>;
}
```

Then add the enrichment slot inside the existing `GenerationEnrichment` interface, next to `staticSignal`:

```ts
  // Curriculum-ranked, cap-limited authoring templates (CurriculumPort.select). Mapped 1:1 at the
  // GenerationPortAdapter onto OpencodeRunInput.skillExemplars, which prompts.ts renders INSTEAD of
  // its own local diff-derived derivation. Absent -> prompts.ts falls back to that local derivation,
  // byte-identical to today.
  skillExemplars?: readonly SelectedExemplar[];
```

- [ ] **Step 7: Write the adapter**

Create `qa-engine/src/contexts/cross-run-learning/infrastructure/curriculum-port.adapter.ts`:

```ts
// qa-engine/src/contexts/cross-run-learning/infrastructure/curriculum-port.adapter.ts
// The real CurriculumPort. Owns the store round-trip and the fault isolation the port promises: a
// load, rank or save failure is logged and swallowed — select() degrades to [] (the generator falls
// back to its own diff-derived exemplars, today's behaviour) and fold() degrades to a no-op. Same
// documented posture as ReflectorPortAdapter and ProcessAuditPortAdapter, so the use-case needs no
// try/catch of its own at either call site.
//
// The store is INJECTED as two plain functions rather than imported: the real implementation is
// src/server/history.ts's loadCurriculum/saveCurriculum, and qa-engine may never import src/. The
// production wiring happens in src/server/rewritten-engine-factory.ts, the one module permitted to
// see both trees — identical to how ProcessAuditPortAdapter sources its own reads and sinks.

import type { CurriculumPort, CurriculumFoldInput, SelectedExemplar } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { MAX_SELECTED_EXEMPLARS } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { detectStructuralPatterns } from "@kernel/structural-pattern.ts";
import { matchExemplars, type SkillExemplar } from "@kernel/scenario-catalog.ts";
import {
  initCurriculum, normalizeCurriculum, classifyEvidence, foldCurriculum, rankExemplars,
  type Curriculum,
} from "../domain/curriculum.ts";

export type CurriculumLoad = (app: string) => Curriculum | null;
export type CurriculumSave = (curriculum: Curriculum) => void;

export class CurriculumPortAdapter implements CurriculumPort {
  constructor(
    private readonly app: string,
    private readonly loadFn: CurriculumLoad,
    private readonly saveFn: CurriculumSave,
    private readonly onError: (err: unknown) => void = (err) =>
      console.warn("[CurriculumPortAdapter] off-path failure, swallowed:", err),
  ) {}

  async select(diff: string | undefined, changedFiles: readonly string[]): Promise<readonly SelectedExemplar[]> {
    if (!diff) return [];
    try {
      const curriculum = this.read();
      const patterns = detectStructuralPatterns(diff, [...changedFiles]);
      const matched = dedupeById(patterns.flatMap((p) => matchExemplars(p)));
      if (matched.length === 0) return [];
      const byArchetype = new Map(curriculum.archetypes.map((e) => [e.archetype as string, e]));
      return rankExemplars(curriculum, matched)
        .slice(0, MAX_SELECTED_EXEMPLARS)
        .map((e) => ({
          id: e.id,
          name: e.name,
          template: e.template,
          archetype: e.archetype,
          proven: byArchetype.get(e.archetype)?.caughtRealBug === true,
          promotionCount: byArchetype.get(e.archetype)?.promotionCount ?? 0,
        }));
    } catch (err) {
      this.onError(err);
      return [];
    }
  }

  async fold(input: CurriculumFoldInput): Promise<void> {
    if (input.offered.length === 0) return;
    try {
      const evidence = classifyEvidence({
        verdict: input.verdict,
        ...(input.adjudicationClass !== undefined ? { adjudicationClass: input.adjudicationClass } : {}),
        ...(input.coverageStatus !== undefined ? { coverageStatus: input.coverageStatus } : {}),
      });
      if (evidence === "inconclusive") return;
      const before = this.read();
      const after = foldCurriculum(before, input.offered, evidence, new Date().toISOString());
      // Identity means the fold recorded nothing — skip the write rather than churn updatedAt.
      if (after === before) return;
      this.saveFn(after);
    } catch (err) {
      this.onError(err);
    }
  }

  private read(): Curriculum {
    const raw = this.loadFn(this.app);
    return raw ? normalizeCurriculum(raw, this.app) : initCurriculum(this.app);
  }
}

function dedupeById(exemplars: readonly SkillExemplar[]): SkillExemplar[] {
  const seen = new Set<string>();
  return exemplars.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}
```

- [ ] **Step 8: Run the tests**

```bash
node --import ./test-setup.mjs --import tsx --test qa-engine/test/contexts/cross-run-learning/infrastructure/curriculum-port.adapter.test.ts
npm test && npm run typecheck && npm run arch:check
```
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add -A qa-engine/src qa-engine/test
git commit -m "feat(curriculum): add CurriculumPort with a caller-enforced exemplar cap"
```

---

## Task 4: Wire select → prompt

After this task the curriculum changes the generation prompt. It still writes nothing (Task 5), so with an empty curriculum every ranking is the neutral prior and the only visible change is the cap and the ordering being explicit rather than incidental.

**Files:**
- Modify: `qa-engine/src/contexts/generation/application/ports/generation-ports.ts`
- Modify: `qa-engine/src/contexts/generation/infrastructure/prompt-builders/prompts.ts:927-940`
- Modify: `qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.ts`
- Modify: `qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts`
- Modify: `qa-engine/src/contexts/qa-run-orchestration/composition/composition-root.ts`
- Test: `qa-engine/test/contexts/generation/infrastructure/prompt-builders/prompts.test.ts` (extend)
- Test: `qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts` (extend)

**Interfaces:**
- Consumes: `SelectedExemplar`, `CurriculumPort` (Task 3).
- Produces: `OpencodeRunInput.skillExemplars?: readonly SelectedExemplar[]`; `RunQaUseCaseDeps.curriculum?: CurriculumPort`; `CompositionConfig.curriculumPort?: CurriculumPort`.

- [ ] **Step 1: Write the failing prompt test**

Append to `qa-engine/test/contexts/generation/infrastructure/prompt-builders/prompts.test.ts`:

```ts
describe("skill-exemplars section honours a supplied curriculum ranking", () => {
  const base = { repo: "o/r", sha: "abc", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", needsReview: false, target: "e2e" as const, mode: "diff" as const, appName: "app" };

  it("renders the supplied exemplars in the supplied order, with the PROVEN marker", () => {
    const prompt = buildPromptAssembled({
      ...base,
      diff: "+<form (ngSubmit)=\"x()\"></form>",
      skillExemplars: [
        { id: "ex-data-list-empty", name: "Data list empty state", template: "TEMPLATE-A", archetype: "empty-state", proven: true, promotionCount: 2 },
        { id: "ex-form-happy-path", name: "Form happy path", template: "TEMPLATE-B", archetype: "happy-path", proven: false, promotionCount: 0 },
      ],
    });
    assert.match(prompt, /### Data list empty state \(empty-state\) — PROVEN \(2 bugs\)/);
    assert.match(prompt, /### Form happy path \(happy-path\)\n/);
    assert.ok(prompt.indexOf("TEMPLATE-A") < prompt.indexOf("TEMPLATE-B"), "supplied order must be preserved");
  });

  it("falls back to the local diff derivation when none are supplied", () => {
    const prompt = buildPromptAssembled({ ...base, diff: "+<form (ngSubmit)=\"x()\"></form>" });
    assert.match(prompt, /## Skill exemplars for the detected structural patterns/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import ./test-setup.mjs --import tsx --test qa-engine/test/contexts/generation/infrastructure/prompt-builders/prompts.test.ts`
Expected: FAIL — `skillExemplars` is not a property of the input type; no PROVEN marker is rendered.

- [ ] **Step 3: Add the field to the generation input**

In `qa-engine/src/contexts/generation/application/ports/generation-ports.ts`, add to `OpencodeRunInput` immediately after `structuralPatterns`:

```ts
  // Curriculum-ranked, cap-limited exemplars (qa-run-orchestration's CurriculumPort.select). When
  // present these REPLACE this file's local diff-derivation in prompts.ts: they are the same
  // catalog entries, reordered by this app's evidence and capped so the section can never be
  // dropped by its own byte budget. Absent -> the local derivation runs, byte-identical to today.
  skillExemplars?: readonly {
    id: string; name: string; template: string; archetype: string; proven: boolean; promotionCount: number;
  }[];
```

- [ ] **Step 4: Consume it in prompts.ts**

Replace the `skillExemplarsContent` IIFE at `prompts.ts:927-940`:

```ts
  const skillExemplarsContent = (() => {
    if (!isGenerationMode) return "";
    // A curriculum-ranked set is AUTHORITATIVE: it is already deduped, already ordered by this app's
    // evidence, and already capped to fit this section's byte budget (MAX_SELECTED_EXEMPLARS, proven
    // exhaustively in qa-engine/test/shared-kernel/scenario-catalog.test.ts). Rendering exactly what
    // was handed down is what lets the curriculum fold "what the generator was shown" honestly.
    if (input.skillExemplars?.length) {
      const proven: Record<string, number> = {};
      for (const e of input.skillExemplars) if (e.proven && e.promotionCount > 0) proven[e.archetype] = e.promotionCount;
      return renderExemplarsForPrompt(input.skillExemplars, { proven });
    }
    // Fallback: the local derivation, unchanged. Reached when no CurriculumPort is wired (the
    // [SWAP]-optional default) or outside diff mode, where there is no diff to rank against.
    const patterns = input.structuralPatterns?.length
      ? input.structuralPatterns
      : detectStructuralPatterns(input.diff, input.intent?.changedFiles ?? []);
    const matched = patterns.flatMap((p) => matchExemplars(p));
    const seenNames = new Set<string>();
    const deduped = matched.filter((e) => {
      if (seenNames.has(e.name)) return false;
      seenNames.add(e.name);
      return true;
    });
    return renderExemplarsForPrompt(deduped);
  })();
```

No import change is needed: `renderExemplarsForPrompt` now takes `RenderableExemplar`, which `OpencodeRunInput.skillExemplars`' element type satisfies structurally.

- [ ] **Step 5: Map it at the generation bridge**

In `qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.ts`, add next to the `staticSignal` spread:

```ts
      // Curriculum-ranked exemplars — 1:1 spread onto the SAME OpencodeRunInput.skillExemplars field
      // prompts.ts renders, mirroring staticSignal's own conditional-spread precedent exactly.
      // Absent/empty -> omitted, never [] (prompts.ts then runs its local derivation, unchanged).
      ...(enrichment?.skillExemplars?.length ? { skillExemplars: enrichment.skillExemplars.map((e) => ({ ...e })) } : {}),
```

- [ ] **Step 6: Call select() in the use-case**

In `qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts`:

(a) Add to `RunQaUseCaseDeps`, next to `processAudit`:

```ts
  // [SWAP]-optional, same contract as reflector/processAudit: absent -> the run is byte-identical
  // to today (no ranked exemplars in the prompt, no curriculum fold). Fault-isolated inside the
  // adapter, so neither call site below needs a try/catch.
  curriculum?: CurriculumPort;
```

(b) Immediately after the `retrievedRuleIds` derivation (`~line 663`), add:

```ts
    // Curriculum selection runs alongside learning retrieval and BEFORE the first generate() call,
    // for the same reason: both are prompt enrichments that must be settled before any prompt is
    // built. `offeredArchetypes` is hoisted to run scope because the fold at the very end must credit
    // EXACTLY the archetypes this prompt carried — never the wider matched set, and never a set
    // re-derived later from a diff that a regen may have moved past.
    const selectedExemplars = this.deps.curriculum
      ? await this.deps.curriculum.select(classificationDiff, classificationIntent?.changedFiles ?? [])
      : [];
    const offeredArchetypes = selectedExemplars.map((e) => e.archetype);
```

Note the ordering constraint: this must sit **after** the `classify()` block that assigns `classificationDiff` / `classificationIntent` (`~line 541`) and **before** `baseEnrichment` (`~line 787`). The existing `retrievedRuleIds` line already satisfies both.

(c) Add to the `baseEnrichment` object literal (`~line 794`, next to `staticSignal`):

```ts
      ...(selectedExemplars.length ? { skillExemplars: selectedExemplars } : {}),
```

(d) Add the composition pass-through in `composition-root.ts` — a `curriculumPort?: CurriculumPort` field on `CompositionConfig` with the same "no stub default; only src/server/rewritten-engine-factory.ts constructs the real one" comment `processAudit` carries, plus the conditional spread `...(cfg.curriculumPort ? { curriculum: cfg.curriculumPort } : {})`.

- [ ] **Step 7: Write the use-case test**

Append to `qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts` (reusing that file's existing deps-builder helper):

```ts
it("threads curriculum-selected exemplars into the generation enrichment", async () => {
  const seen: unknown[] = [];
  const deps = makeDeps({
    generation: { generate: async (_s, _d, _sig, _diff, enrichment) => { seen.push(enrichment?.skillExemplars); return { specs: ["a.spec.ts"], approved: true }; } },
    curriculum: {
      select: async () => [{ id: "ex-form-happy-path", name: "Form happy path", template: "T", archetype: "happy-path", proven: true, promotionCount: 1 }],
      fold: async () => {},
    },
  });
  await new RunQaUseCase(deps).run({ app: "app", sha: Sha.of("a".repeat(40)), mode: "diff", target: "e2e", runId: "r1" });
  assert.equal((seen[0] as { archetype: string }[])[0]!.archetype, "happy-path");
});

it("omits the enrichment field entirely when no CurriculumPort is wired", async () => {
  const seen: unknown[] = [];
  const deps = makeDeps({ generation: { generate: async (_s, _d, _sig, _diff, e) => { seen.push(e); return { specs: ["a.spec.ts"], approved: true }; } } });
  await new RunQaUseCase(deps).run({ app: "app", sha: Sha.of("a".repeat(40)), mode: "diff", target: "e2e", runId: "r1" });
  assert.equal(Object.hasOwn(seen[0] as object, "skillExemplars"), false);
});
```

- [ ] **Step 8: Run the gates**

```bash
npm test && npm run typecheck && npm run arch:check
```
Expected: all PASS. `qa-engine/test/contract/seam-parity.contract.test.ts` may carry `skillExemplars` in its ALLOWLIST of known-dropped fields — remove that entry if present, since the field is now genuinely wired.

- [ ] **Step 9: Commit**

```bash
git add -A qa-engine
git commit -m "feat(curriculum): rank and cap the generator's skill exemplars per app"
```

---

## Task 5: Wire the fold and the production adapter

This is the task that makes the curriculum non-empty.

**Files:**
- Modify: `qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts`
- Modify: `src/server/rewritten-engine-factory.ts`
- Test: `qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts` (extend)
- Test: `src/server/rewritten-engine-factory.test.ts` (extend)

**Interfaces:**
- Consumes: `CurriculumPort`, `CurriculumFoldInput` (Task 3); `offeredArchetypes` (Task 4).
- Produces: a run-scoped `coverageStatus` local on `RunQaUseCase`; a wired `curriculumPort` on the real `CompositionConfig`.

- [ ] **Step 1: Write the failing test**

Append to `qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts`:

```ts
it("folds the offered archetypes with the run's coverage status", async () => {
  const folds: CurriculumFoldInput[] = [];
  const deps = makeDeps({
    execution: { execute: async () => ({ verdict: "pass" as const, cases: [{ name: "t", status: "pass" as const }], logs: "" }) },
    objectiveSignal: { measure: async () => ({ status: "pass" as const, ratio: 0.9 }), blocks: () => false },
    curriculum: {
      select: async () => [{ id: "ex-form-happy-path", name: "n", template: "t", archetype: "happy-path", proven: false, promotionCount: 0 }],
      fold: async (i) => { folds.push(i); },
    },
  });
  await new RunQaUseCase(deps).run({ app: "app", sha: Sha.of("a".repeat(40)), mode: "diff", target: "e2e", runId: "r1" });
  assert.equal(folds.length, 1);
  assert.deepEqual(folds[0]!.offered, ["happy-path"]);
  assert.equal(folds[0]!.verdict, "pass");
  assert.equal(folds[0]!.coverageStatus, "pass");
});

it("never folds when nothing was offered", async () => {
  const folds: CurriculumFoldInput[] = [];
  const deps = makeDeps({ curriculum: { select: async () => [], fold: async (i) => { folds.push(i); } } });
  await new RunQaUseCase(deps).run({ app: "app", sha: Sha.of("a".repeat(40)), mode: "diff", target: "e2e", runId: "r1" });
  assert.equal(folds.length, 0);
});

it("folds independently of shouldDistillLearning — an app_defect run suppresses the learning fold but MUST credit the curriculum", async () => {
  const folds: CurriculumFoldInput[] = [];
  const learningFolds: unknown[] = [];
  const deps = makeDeps({
    execution: { execute: async () => ({ verdict: "fail" as const, cases: [{ name: "t", status: "fail" as const, detail: "expected 3 received 4", httpStatus: 500 }], logs: "" }) },
    learning: { retrieve: async () => [], fold: async (o) => { learningFolds.push(o); } },
    curriculum: {
      select: async () => [{ id: "ex-api-error-handling", name: "n", template: "t", archetype: "network-error", proven: false, promotionCount: 0 }],
      fold: async (i) => { folds.push(i); },
    },
  });
  await new RunQaUseCase(deps).run({ app: "app", sha: Sha.of("a".repeat(40)), mode: "diff", target: "e2e", runId: "r1" });
  assert.equal(learningFolds.length, 0, "app_defect must suppress the learning fold");
  assert.equal(folds.length, 1, "app_defect must still credit the curriculum");
  assert.equal(folds[0]!.adjudicationClass, "app_defect");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import ./test-setup.mjs --import tsx --test qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts`
Expected: FAIL — `folds.length` is 0; nothing calls `curriculum.fold`.

- [ ] **Step 3: Capture the coverage status at run scope**

In `run-qa.use-case.ts`, next to the existing `let coverageRatio: number | null = null;` (`~line 1507`), add:

```ts
    // DecideCoverageService's own status for this run, hoisted to run scope for the curriculum fold
    // at the end of the method. RunOutcome persists only the RATIO, and re-deriving pass/fail from
    // ratio-vs-minRatio at the fold site would create a second source of truth for a decision
    // decide-coverage.service.ts already owns. `undefined` means measure() never ran (non-diff mode,
    // coverage policy off) — distinct from a measured "unknown", and read as inconclusive either way.
    let coverageStatus: "pass" | "fail" | "unknown" | undefined;
```

Immediately after the first `measure()` call assigns its result (`~line 1567`), add `coverageStatus = signal.status;`. Inside the enforce-mode regeneration branch, after the **second** measurement (`signal2`, `~line 1624`), add `coverageStatus = signal2.status;` — the regen's own measurement is already the only input to `blocksPublish`, so the curriculum must read the same final measurement rather than the superseded first one.

- [ ] **Step 4: Fold after the learning fold**

In `run-qa.use-case.ts`, immediately after the `if (shouldDistillLearning(...)) { await this.deps.learning.fold(mainlineOutcome); }` block (`~line 2099`), add:

```ts
      // Phase: curriculum fold — off-path, fault-isolated inside the adapter (no try/catch here,
      // same trust the reflector/processAudit call sites extend to their adapters).
      //
      // DELIBERATELY NOT gated on shouldDistillLearning. That gate exists to stop the LEARNING
      // ledger from authoring a rule that weakens a test which correctly caught a real bug
      // (app_defect suppresses the fold). The curriculum's question is the opposite one — WHICH
      // SCENARIO SHAPE found that bug — so app_defect is its single strongest positive signal.
      // Gating the two together would make the curriculum blind to exactly the runs it exists for.
      //
      // Only the MAINLINE exit folds. The static-gate `invalid` and health-preflight `infra-error`
      // terminals never executed a suite, so they carry no readable evidence about an archetype;
      // recording a miss there would punish `invalid-input` for a tsc error.
      if (offeredArchetypes.length > 0) {
        await this.deps.curriculum?.fold({
          offered: offeredArchetypes,
          verdict: decision.verdict,
          ...(mainlineOutcome.adjudication?.class !== undefined ? { adjudicationClass: mainlineOutcome.adjudication.class } : {}),
          ...(coverageStatus !== undefined ? { coverageStatus } : {}),
        });
      }
```

- [ ] **Step 5: Run the use-case tests**

Run: `node --import ./test-setup.mjs --import tsx --test qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the production adapter**

In `src/server/rewritten-engine-factory.ts`, add `loadCurriculum, saveCurriculum` to the existing `./history` import, then construct and pass the adapter alongside `processAudit`:

```ts
  // CurriculumPort — the per-app scenario-archetype prior. Constructed HERE, not in the composition
  // root, for the same reason as reflectorPort/processAudit: its store is history.ts's
  // loadCurriculum/saveCurriculum, a src-only collaborator qa-engine may never import. Wired
  // UNCONDITIONALLY (no config flag): the port is measure-and-rank only — it never gates a verdict,
  // a publish decision or a coverage decision, so there is no risk surface a flag would protect.
  const curriculumPort = new CurriculumPortAdapter(app.name, loadCurriculum, saveCurriculum);
```

and add `curriculumPort,` to the `CompositionConfig` object literal.

- [ ] **Step 7: Write the factory test**

Append to `src/server/rewritten-engine-factory.test.ts`:

```ts
it("wires a CurriculumPort backed by the history store", () => {
  const cfg = captureCompositionConfig(makeAppConfig({ name: "curriculum-app" }));
  assert.ok(cfg.curriculumPort, "curriculumPort must be wired unconditionally");
});
```

- [ ] **Step 8: Run the gates**

```bash
npm test && npm run typecheck && npm run arch:check
```
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add -A qa-engine src/server
git commit -m "feat(curriculum): fold deterministic run evidence and wire the production store"
```

---

## Task 6: Surface the counters

Without this the two new counters exist but no operator can see them, and the demo's intelligence screen still shows only the proven/unproven split.

**Files:**
- Modify: `qa-engine/src/shared-kernel/contract/commands.ts:501-510`
- Modify: `src/server/intelligence-view.ts:43-50`
- Modify: `src/cli.ts:254-280`
- Modify: `client/internal/ui/intelligence.go`
- Regenerate: `contract/openapi.json`, `packages/sdk/src/types.gen.ts`, `client/internal/contract/types.gen.go`
- Test: `src/server/intelligence-view.test.ts` (extend)

**Interfaces:**
- Consumes: `ArchetypeEntry.evaluated` / `.credited` (Task 2).
- Produces: `CurriculumView.archetypes[].evaluated` / `.credited` (integers, non-negative).

- [ ] **Step 1: Write the failing projection test**

Append to `src/server/intelligence-view.test.ts`:

```ts
it("projects the curriculum's evidence counters", () => {
  const curriculum = foldCurriculum(initCurriculum("app"), ["invalid-input"], "covered", "2026-09-04T10:00:00.000Z");
  const view = toIntelligenceView("app", [], null, curriculum);
  const entry = view.curriculum!.archetypes.find((a) => a.archetype === "invalid-input")!;
  assert.deepEqual({ evaluated: entry.evaluated, credited: entry.credited }, { evaluated: 1, credited: 1 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import ./test-setup.mjs --import tsx --test src/server/intelligence-view.test.ts`
Expected: FAIL — `evaluated` does not exist on the projected entry.

- [ ] **Step 3: Widen the contract schema**

In `qa-engine/src/shared-kernel/contract/commands.ts`, replace `CurriculumViewSchema`:

```ts
export const CurriculumViewSchema = z.object({
  updatedAt: z.string(),
  archetypes: z.array(
    z.object({
      archetype: z.string(),
      // Proven STRICTLY by the adjudicator's app_defect verdict — never by coverage.
      caughtRealBug: z.boolean(),
      promotionCount: z.number().int().nonnegative(),
      // The evidence ladder's second tier: runs in which this archetype was offered to the generator
      // AND the run produced a determinable objective signal, and how many of those earned credit.
      // The operator reads credited/evaluated as the archetype's hit rate for this app.
      evaluated: z.number().int().nonnegative(),
      credited: z.number().int().nonnegative(),
    }),
  ),
});
```

- [ ] **Step 4: Project them**

In `src/server/intelligence-view.ts`, extend the curriculum mapping:

```ts
      archetypes: curriculum.archetypes.map((a) => ({
        archetype: a.archetype,
        caughtRealBug: a.caughtRealBug,
        promotionCount: a.promotionCount,
        evaluated: a.evaluated,
        credited: a.credited,
      })),
```

- [ ] **Step 5: Regenerate the downstream contract artifacts**

```bash
npm run contract:gen && npm run sdk:gen && npm run sdk:typecheck
```
Then regenerate the Go types with the repo's usual `oapi-codegen` invocation for `client/internal/contract/types.gen.go` and confirm `CurriculumView` gained `Credited`/`Evaluated`:

```bash
rg -A 12 "type CurriculumView struct" client/internal/contract/types.gen.go
```

- [ ] **Step 6: Render them in the CLI and the TUI**

In `src/cli.ts`'s `showLearning`, change the proven/unproven listing so each line carries its rate:

```ts
    const proven = curriculum.archetypes.filter((a) => a.caughtRealBug);
    console.log(`  ${proven.length}/${curriculum.archetypes.length} archetypes proven by real bugs:`);
    for (const a of curriculum.archetypes) {
      const rate = a.evaluated > 0 ? `${a.credited}/${a.evaluated}` : "no evidence yet";
      const mark = a.caughtRealBug ? `PROVEN (${a.promotionCount} bugs)` : "unproven";
      console.log(`    ${a.archetype.padEnd(26)} ${mark.padEnd(20)} ${rate}`);
    }
```

In `client/internal/ui/intelligence.go`'s curriculum section, render each archetype as
`<archetype>  PROVEN (n bugs) | unproven   credited/evaluated`, following that file's existing column and lipgloss style conventions.

- [ ] **Step 7: Run the gates**

```bash
npm test && npm run typecheck && npm run arch:check
cd client && go build ./... && cd ..
```
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add -A qa-engine/src/shared-kernel/contract src/server/intelligence-view.ts src/cli.ts client contract packages/sdk
git commit -m "feat(curriculum): surface evidence counters in the contract, CLI and TUI"
```

---

## Verification: end-to-end on a real run

After Task 6, prove the loop closes rather than assuming it. `qayaba` runs in code mode against its own source, so it needs no DEV environment.

- [ ] **Step 1: Clear any prior state and run once**

```bash
npm run qa -- --app qayaba --sha $(git rev-parse HEAD) --mode diff
```

- [ ] **Step 2: Read the curriculum back**

```bash
npm run qa -- --app qayaba --learning
```

Expected: the Curriculum block lists all ten archetypes; the ones whose exemplars the diff matched show a non-zero `credited/evaluated`; the rest show "no evidence yet". Every archetype at `0/0` after a run whose diff matched at least one structural pattern means `select()` returned empty — check that the run was diff mode and that `classificationDiff` was non-empty.

- [ ] **Step 3: Confirm the prompt actually changed**

```bash
sqlite3 <history-db-path> "SELECT prompt_text FROM agent_turns ORDER BY id DESC LIMIT 1;" | rg -A 3 "Skill exemplars"
```

Expected: at most three `###` headings under the section. After a run that produced an `app_defect`, at least one heading carries `— PROVEN (n bugs)`.

---

## Self-review

**Spec coverage.** Deterministic criteria → D1 (three pure conditions from already-computed values, no LLM) and D2 (a total ordering function with a catalog-index tiebreak). Organized, structured process → the port's two methods bracket the run: `select()` before generation, `fold()` after persistence, with `offeredArchetypes` as the single value linking them. Improves the main testing output → D3 (the exemplar section stops being silently droppable and its bytes go to the best-evidenced templates) and D4 (the inline PROVEN marker). Optimal integration → D5 collapses the duplicated `ScenarioArchetype`, and D6 reuses the established `[SWAP]`-optional collaborator shape rather than inventing a new one.

**Placeholder scan.** No TBD/TODO. Every code step carries the actual code. The two steps that intentionally reference existing conventions rather than reproducing them — the Go TUI rendering (Task 6 Step 6) and the composition-root pass-through (Task 4 Step 6d) — each name the exact existing element to copy (`intelligence.go`'s current curriculum section; `processAudit`'s field, comment and conditional spread).

**Type consistency.** `SelectedExemplar` is declared once (Task 3) and used identically in Tasks 4 and 5. `CurriculumFoldInput.offered` is `readonly string[]` at every site. `coverageStatus` is `"pass" | "fail" | "unknown"` on the port and `| undefined` only as a use-case local. `MAX_SELECTED_EXEMPLARS` is exported from the orchestration barrel and imported by both the adapter and its test. `foldCurriculum(curriculum, offered, evidence, now)` has the same four-argument signature in its definition, its tests and the adapter. `renderExemplarsForPrompt(exemplars, opts?)` is widened once in Task 3 Step 3 and called with the second argument in Task 3 Step 1 and Task 4 Step 4.

**Known risk.** The exhaustive byte test (Task 3 Step 1) is the plan's one empirical assumption. Its failure mode is pre-decided: lower the cap to 2 and re-enumerate `C(6,2) = 15` pairs. No other task depends on the cap being exactly 3.

# Add-Project Wizard — Multi-Repo Onboarding End-to-End

**Date:** 2026-07-08
**Status:** Design — pending user review
**Topic:** Unify app creation + boundary onboarding into a single guided TUI wizard that configures a brand-new multi-repo project from scratch.

## Problem

Today "onboarding" is two disjoint flows in the FLEET panel, neither of which does what a user
needs to add a new multi-repo project:

1. **Create app** (`Enter` on the bottom row → `appAdminModel`, `client/internal/ui/apps.go`): a
   single-repo form. It registers one repo in `config/apps/<app>.yaml`, never populates
   `services[]`, and triggers no agent. Multi-repo is dead capability from the TUI even though the
   server contract (`CreateAppInput.Services`) supports it.
2. **Propose boundaries** (`b` on an already-configured app → `boundaryProposeModel`,
   `client/internal/ui/onboard_boundaries.go`): the agentic, live-feedback flow — but it requires
   the app to already exist with `services[]` declared, and only enriches `boundaries[]`.

The two never connect. A user creating a new microservices app can only pick one repo, never sees
the agentic build, and the boundary run finds nothing because no backend was declared.

## Goal / success criteria

One guided wizard, launched from FLEET, that takes a user from nothing to a fully-configured,
testable project:

- Select **one or many** repos (from their GitHub repos **or** typed by slug).
- Assign each repo a **role** (frontend / service).
- Provide the deployment facts the agent cannot derive: **DEV URL**, QA options, and optional
  **environment Basic Auth**.
- Navigate **back and forth** across the input steps without losing state.
- On confirm, write the app config, then **automatically** run the existing agentic boundary build
  with **live visual feedback**, and show a **result** with data relevant to the user.
- The app is onboarded and testable **even if** the boundary step finds no profile.

## Scope

**In:** the multi-repo **e2e** case (frontend + N microservices, the "ñame" shape). Single-repo is
a degenerate case (one repo, no services). Reuses the existing boundary-propose engine and live
view unchanged.

**Out (v1):** code-mode apps (no DEV URL / no boundaries); multiple frontends (config shape is one
primary + N services); transport/lib tags (see Decisions); per-service `versionUrl`/`openapi` hints
(the agent already locates OpenAPI via Serena/glob).

### Directive reconciliation (important)

The `qa-engine-first` policy (all new changes → `qa-engine/`, `src/` read-only) governs the
**QA-run pipeline** migration (`src/qa/`, `src/orchestrator/` → contexts). It does **not** govern
the control-plane server or TUI. Git evidence: the onboarding product shipped **after** the
directive with `4a927cf` ("re-home adapter under `src/`") and `6bbc109` (TUI wizard in `client/`).
So this feature correctly lives in `src/server/` + `client/`, and **reuses**
`qa-engine/src/contexts/service-topology/` (the `OnboardingService` round loop + scorer) unchanged.

## The wizard flow

Four user-input steps (freely navigable) → one automatic build phase (locked).

**Step 1/4 — Name**

**Step 2/4 — Repositories + roles** (the new screen):

```
 ADD PROJECT ───────────────────────────────────────── step 2/4 · repositories

  filter: name-▌

  space = toggle · r = cycle role · / = type a repo manually

   [x] joomeco/name-webapp            role: frontend   ◀ primary
   [x] joomeco/ms-name-restaurants    role: service
   [x] joomeco/ms-name-users          role: service
   [x] joomeco/ms-name-notifications  role: service
   [ ] joomeco/other-repo             role: —

   + type a repo manually…

  enter: continue     esc: back
```

- Multi-select from the user's GitHub repos (reuses `ListRepos`), **or** a typed slug.
- Each selected repo gets a role: **frontend** (exactly one → becomes the config `repo` / primary)
  or **service** (→ a `services[]` entry). Validation: exactly one frontend, ≥1 repo total.

**Step 3/4 — DEV + options:**

- DEV URL (`dev.baseUrl`), optional `dev.versionUrl`, `target` (e2e), `shadow`, `needsReview`,
  `testDataPrefix`.
- **Authentication** field (environment gate, **not** app login):
  - default **`disabled`** → nothing written, no `httpCredentials`.
  - **`basic auth`** → reveals `user` + `password` → persisted to `.env` as
    **`DEV_ENV_USER` / `DEV_ENV_PASS`** via the existing env-store (`applyEnvVars`,
    `src/server/env-store.ts`). These feed Playwright `httpCredentials`, already wired in
    `config/e2e/playwright.config.ts`, scoped to the app origin. (Distinct from
    `DEV_TEST_USER/PASS`, which is the in-app Keycloak login.) In production these go through
    Doppler; the `.env` write is the local path. The password is already scrubbed by
    `src/orchestrator/sanitizer.ts`.

**Step 4/4 — Review** → write `config/apps/<app>.yaml` (primary `repo` + `services[]` + `dev` +
`qa`) and persist any env secrets. **The app is now onboarded and testable.** Navigation back into
steps 1–3 is allowed up to this write; after it, input is locked.

**Build phase (automatic)** → chain into the existing `boundaryProposeModel` live view
(`resolvingMirrors → proposing round N/3 → scoring → indexing`). Keep the **human CONFIRM** gate
before splicing `boundaries[]` into the config (human-in-the-loop / read-only-agent ethos). On
completion, show the **result screen** below.

## Result screen (human-meaningful)

The raw `resolvedScore` is a Goodhart proxy and means nothing to a user — it is **not** shown as a
headline. The result must reflect the **final state**, **how the repos got connected**, **what was
registered**, and **any failure**. Four blocks:

```
 ADD PROJECT ─────────────────────────────────────────── done · name-webapp

  ✓ Project configured — name-webapp is ready to test.

  How the repos connect (HTTP):
    name-webapp  →  ms-name-restaurants    14 calls resolved
                 →  ms-name-users           6 calls resolved
                 →  ms-name-notifications   3 calls resolved

  Registered:
    · config/apps/name-webapp.yaml  ← boundaries[] written (3 service links)
    · codebase-memory index: name-webapp, ms-name-restaurants, ms-name-users,
      ms-name-notifications
    · .env: DEV_ENV_USER / DEV_ENV_PASS

  Needs attention:
    · ms-name-orders — repo not reachable, skipped during mirroring
    · 4 frontend calls unresolved (no matching backend operation)

  enter: finish
```

- **Final state** — a plain status line: `✓ configured & connected`, `⚠ configured, no connections
  detected` (noProfile), or `✗ configuration failed`. Never a bare number.
- **How the repos connect** — the resolved boundaries in human terms: per front→service edge, the
  transport (HTTP / events) and how many frontend call-sites resolved to that service's operations.
  This is the `resolvedScore`'s numerator (`links`) made legible, not the score itself.
- **Registered** — exactly what persisted and where: the `boundaries[]` block written to
  `config/apps/<app>.yaml`, the repos indexed into codebase-memory, and the env vars written. So
  the user knows the durable outcome.
- **Needs attention** — every failure or gap, surfaced (not swallowed): a repo that failed to
  clone/index, unresolved/external frontend calls (a hint that a service is undeclared), or, for
  `noProfile`, the plain reason ("no frontend call-site resolved to any declared service"). The app
  stays configured and testable regardless.

**Design implication:** the propose job's result must carry this data up to the TUI — the resolved
front→service links (edges + per-edge counts + transport), the unresolved/external count, the
registration summary (config path, indexed repos, env keys set), and per-repo mirror/index
failures. The link detail already exists inside the winning candidate's resolve result in
`qa-engine` (`service-topology`); the change is to **return it up** through the job result/status in
`src/server/onboarding/` (no `qa-engine` logic change), since today only the numeric score survives.

## Components & where they live

| Unit | Location | Change |
|---|---|---|
| Wizard model (steps, state, back-nav, multi-select, role cycle, auth toggle) | `client/internal/ui/` (extend `appAdminModel` or a new `addProjectModel`) | new |
| Chain create → propose in the TUI | `client/internal/ui/` (compose with existing `boundaryProposeModel`) | new wiring |
| App config write incl. `services[]` | `src/server/app-admin.ts` + `src/server/onboard.ts` | reuse (already supports `services[]`) |
| Env secrets write (`DEV_ENV_USER/PASS`) | `src/server/env-store.ts` (`applyEnvVars`) | reuse |
| Create + propose + status endpoints | `src/server/api.ts` / `src/index.ts` | reuse (`POST /api/apps`, `.../boundaries/{propose,status,confirm}`) |
| Propose result: surface links/registration/failures for the result screen | `src/server/onboarding/` (job result/status shape) | new (return existing `qa-engine` resolve data up) |
| Boundary round loop + scorer | `qa-engine/src/contexts/service-topology/` | **reuse unchanged** |

## Data flow

TUI wizard (collect + validate) → `POST /api/apps` with `{repo, services[], dev, qa}` →
env-store writes `DEV_ENV_USER/PASS` if basic-auth chosen → TUI auto-calls
`POST /api/apps/:name/boundaries/propose` → polls `.../status` (live view) → on winner, human
confirm → `POST .../boundaries/confirm` splices `boundaries[]` → done screen with result summary.

## Error handling

- **Create fails:** stay on Review with the server error; nothing partially written.
- **Base config written, then propose/index fails or `noProfile`:** the app remains configured and
  testable; the build phase reports the outcome without rolling back the config. `noProfile` is a
  clean terminal state, not an error.
- **Back-navigation:** allowed only before the Step-4 config write; locked during/after the build.
- **Secrets:** `DEV_ENV_PASS` never rendered back or logged (sanitizer already covers it).

## Testing

- **Go TUI (`teatest`, per `go-testing` skill):** step navigation preserves state on back/forward;
  multi-select toggle; role cycle enforces exactly-one-frontend; typed-slug add; auth toggle
  reveals/hides user+pass; lock after generation. Golden-file the new screens.
- **Server:** `createApp` writes a correct multi-repo YAML (`repo` + `services[]`); env-store writes
  `DEV_ENV_USER/PASS`; the create→propose chain calls the right endpoints in order.
- **Reuse:** existing propose/scorer tests in `qa-engine` unchanged.

## Decisions (resolved 2026-07-08)

- **Exactly one frontend per app in v1** — confirmed. Multiple frontends deferred.
- **`openapi` discovery is the agent's job** — no per-service `openapi` hint in the wizard; the
  agent locates specs via Serena/glob.
- **Result screen is human-meaningful, not score-driven** — see "Result screen" above: final state,
  how the repos connect, what was registered, and any failure. Raw `resolvedScore` is not surfaced.

## Risks

- Returning the resolution detail (links/edges, failures) up through the job result touches the
  onboarding job status shape in `src/server/onboarding/`; keep `qa-engine` untouched (return
  existing data, don't recompute).
- `noProfile` must still produce a useful "Registered / Needs attention" screen (config + indexing
  happened even when no boundaries were found).

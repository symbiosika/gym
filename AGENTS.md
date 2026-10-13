# Agent Knowledge Index

Retrieval before recall: read the referenced files, do not guess.

## 1. What this is

GYM: the web app of a robotics gym. Operators record teleoperation data and
evaluate trained policies in cells; the app guides them through a block (scene
brief, AI plan, recording, dataset upload, analysis, episode selection, export)
and keeps day protocols, skills, audit logs and key figures for analysts. Two
axes: the day protocol (one per cell and day, holds blocks) is the controlling
record; the skill (task, recording blocks, selection, exports, policies) is the
product. A block is one stretch of work in a day for one skill, a recording
block or an evaluation block. Built on the symbiosika-framework (git submodule
at `backend/framework`).

Read first:

- `docs/PRODUCT.md`: the purpose of the app in one page
- `docs/GLOSSARY.md`: the binding vocabulary (cell, day protocol, block, skill,
  dataset, episode, …). Do not introduce synonyms.
- `design.md`: design system, UX flow of the operator wizard, figure definitions

All documentation, comments and code are English. UI texts live in the locales
(German first, English second).

## 2. Verify before you finish

| What you changed | Run this (from that directory) |
|---|---|
| `backend/**` | `bun run test:local ./src/path/file.test.ts` (one file) or `bun run test:local ./src` (all) |
| `backend/**` (types) | `bun run typecheck` |
| `backend/src/db/schema.ts` | `bun run app:generate` and commit the migration |
| `frontend/**` | `bun run test` and `bun run type-check` |
| `frontend/**` (bundle) | `bun run build-only` |
| `frontend/**` (style) | `bun run format` (Prettier, see `.prettierrc.json`) |
| `critics/**` | `pytest -q` and `ruff check . && ruff format --check .` |

`test:local` starts an embedded PGlite on port 5499, migrates framework and app
and runs the tests. No Docker, no `.env`, no running database needed.

Definition of done: a test for every new route or piece of business logic, the
tests are green, types check, and anything still red is said so explicitly.

## 3. Git

`develop` is the only base branch. Work on it or on a `claude/<topic>` branch
based on fresh `origin/develop`; push with `git push -u origin <branch>`. Never
change `backend/framework/**` from this repo; it is a submodule of a separate
repository. Only create a PR when asked.

## 4. Layout

- `backend/` Bun + Hono API. Framework alias `@framework/*` → `backend/framework/src/*`.
  - `src/db/schema.ts` gym tables (prefix `gym_`) and the JSON documents on them; `drizzle-sql/` migrations
  - `src/lib/gym/` skills (and policies), day protocols, blocks (the wizard), datasets, exports, kpis, audit, cells, collections, errors; `evaluations.ts` the rollouts of an evaluation block, their human review, the effective verdict, the Wilson interval and the aggregation of the figures; `evaluation-reports.ts` the reports over blocks; `spec-drafts.ts` the spec wizard: a sample dataset, the critics in auto mode over X episodes, the spec drafted step by step, a test run, then stored
  - `src/lib/critics/` client for the critics service (`critics/`), job sync, summary; tests use `fake-server.test-util.ts` with fixtures of a real run. The summary is stored on the dataset and carries `SUMMARY_VERSION`; bump it when its shape changes, and stale summaries are rebuilt from the stored report on read (`upgradeStaleSummaries`)
  - `src/lib/ai/` model selection (Gemini or framework provider), plan and follow-up proposals with fallbacks
  - `src/lib/storage/` the one gate to stored bytes: `putFile`, `readFile`, `removeFile`. A wrapper, not a storage: the framework always does the storing, this picks which of its backends from `GYM_STORAGE_DRIVER` (`db` the default, `s3` for an object store, `local` for development) and keeps the reference `"<driver>:<name>"` a row carries, so changing the driver keeps what was written before readable. GYM implements no backend of its own; one it needs is added to the framework
  - `src/routes/tenant/[tenantId]/gym/` the authenticated API, one file per area, `index.test.ts` is the end-to-end flow
  - `src/routes/public/mobile.ts` phone views and print view, identified by token or share id
  - `src/mcp/` read-only MCP tools for analysts
- `frontend/` Vue 3 SPA, Tailwind v4 + PrimeVue "Volt", light and dark mode.
  Served at `/static/app/`. Same base as the other Symbiosika frontends.
  - `src/assets/base.css` the only place colours live: the `--p-*` palette that
    drives Volt and Tailwind, and the `gym-*` utilities (`gym-panel`,
    `gym-wrap`, `gym-table`, `gym-stepbox`, `gym-note`, `gym-empty`)
  - `src/volt/` the standard controls (Button, InputText, Select, Dialog, …):
    unstyled PrimeVue owned in this repo, auto-imported. Add one with
    `npx volt-vue add <Name>`; never restyle PrimeVue from the outside
  - `src/components/` own components, also auto-imported (`Pill`, `KpiTile`,
    `FormField`, `PageTitle`, `SectionHeader`, `TabBar`, `Modal`, …);
    `RolloutReview` the human review of a block's rollouts, `EvaluationReportBody` the report; `specwizard/` the steps of the spec wizard (`SpecWizardView`), whose sample evidence and verdict preview live in `utils/specSample.ts`
  - `src/views/` also `EvaluationReportView` (the report, editable) and `EvaluationReportSharedView` (public, printable)
  - icons are components: `import IconUpload from '~icons/carbon/upload'`
    (unplugin-icons). Never an icon font, never a PrimeVue icon class
  - `src/api/gym.ts` one function per endpoint, `src/types/gym.ts` the API types
  - `src/views/` one view per route (block wizard, day protocol, skill, start, continue, analysis, settings); the wizard steps are `src/components/wizard/Step*.vue`
  - `src/locales/de.json`, `en.json` all UI text
- `critics/` the data critics: the Python analysis engine, its CLI and the REST
  service the backend talks to. Own README, own tests, own CI job.
  - `lerobot_critics/critics/hard|soft` the critics themselves, `spec/` the spec model
  - `runner.py`, `scoring.py`, `selection.py` the run, the verdicts, the episode lists
  - `api/` the FastAPI service and its job store, `cli.py` the command line
- `docs/` product description and glossary
- Images and stacks: `Dockerfile` (app), `Dockerfile.critics-service` (critics),
  `docker-compose.critics.yml` (dev critics),
  `docker-compose.critics-service.yml` (critics alone, one variable),
  `docker-compose.prod.yml` (Postgres + critics + app)

## 5. Rules

- API and business logic are separate: routes validate and map errors, `lib/` does the work.
- Every byte the app stores goes through `lib/storage`, which does nothing but pick a framework backend and hand the bytes to it. Never straight to the disc, never straight to a backend, and never a backend of its own: a storage GYM needs is added to the symbiosika-framework, not here. A wrapper for permissions or the audit log sits on top of `lib/storage`, not beside it. A chunked dataset upload is never assembled: its chunks stay in the storage as the parts of the dataset (`datasets.storage_parts`) and the critics are handed one link per part and join them.
- Every query is tenant-scoped (`eq(table.tenantId, tenantId)`).
- Every relevant action is written to the audit log (`recordAudit`) with the skill, day protocol and block it concerns.
- The wizard is stateful: any input the operator makes is saved on the block at once.
- One day protocol per cell and day (unique index); a day has any number of blocks, of any kind, for any skill. Downtime belongs to the day, everything else the wizard stores belongs to the block.
- Evaluation blocks are judged by the critics with the skill's spec, but as rollouts: GYM sends the job the purpose of the block (`recording` or `evaluation`, `purposeOf` in `lib/gym/datasets.ts`) and the critics apply the purpose's defaults, framing and wording over the spec (`critics/README.md`, "Recording or evaluation"). Their datasets never enter a selection, an export or the recording figures. Their accept rate is the policy's success rate.
- A person may overrule the critics on a rollout (human verdict, failure code) and on a recorded episode in the selection (human verdict). Every success rate and accept count is counted on the effective verdict, `coalesce(human_verdict, verdict)`; use `effectiveVerdictSql` from `lib/gym/evaluations.ts`, never `verdict` alone, when counting rollouts or episodes. The critics' verdicts themselves are never rewritten.
- An evaluation report stores only what a database cannot know (name, blocks, written sections); its figures are computed from the blocks when it is read.
- AI features degrade to deterministic fallbacks; nothing in the wizard may block on the model.
- The critics do not own the datasets. GYM stores every dataset through `lib/storage` and hands the critics a temporary URL (`shareFile` of the framework) instead of the bytes; the critics fetch what they need for one job or one merge and keep nothing. `CRITICS_DATA_DIR` is for the CLI and the web UI, not for GYM.
- GYM never judges data itself. The data critics (`critics/`, a service of this repository) are the single source of truth for analysis; their wording (accept, review, reject, flags, spec) is used as it is. When a person downgrades a finding or switches a critic off for a dataset (`PUT datasets/:id/findings`), GYM hands the overrides to the critics (`PUT /jobs/{id}/overrides`), which replay the verdicts; GYM only mirrors the result again (`refreshDataset`), keeping episode ids, the human review and the operator's selection.
- Every member of an organisation is an operator and may read everything. Owners and admins maintain cells and people.
- No em dashes or en dashes in UI text, docs or commit messages. Use `·`, commas or separate sentences.

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
repository. Only create a PR when asked. Once the PR of a branch is merged,
follow-up work goes in a new PR: restart the branch from fresh `origin/develop`
(same name), push, and open a new PR; never reuse or stack on the merged one.

One version for the whole repository: backend, frontend and critics carry the
same semantic version, set with `scripts/version.sh set X.Y.Z` (never by hand
in one part; `scripts/version.sh` checks them, and so does CI). A PR that
changes the app raises it once, minor for a feature, patch for a fix or
documentation only, and adds its entry to `CHANGELOG.md`; its merge into
`develop` is tagged `vX.Y.Z`.

## 4. Layout

- `backend/` Bun + Hono API. Framework alias `@framework/*` → `backend/framework/src/*`.
  - `src/db/schema.ts` gym tables (prefix `gym_`) and the JSON documents on them; `drizzle-sql/` migrations
  - `src/lib/gym/` skills (and policies), day protocols, blocks (the wizard), datasets, exports, kpis, audit, cells, collections, errors; `robots.ts` the robots with their platform reference and capability sections; which cell a robot is in is set on the cell (`cells.robot_id`, `cells.ts`), never on the robot; `evaluations.ts` the rollouts of an evaluation block, their human review, the effective verdict, the Wilson interval and the aggregation of the figures; `evaluation-reports.ts` the reports over blocks; `strategy.ts` the strategy of a skill (description, pictures and PDFs, the run sheet) and `run-sheet.ts` the CSV reader and the run sheet as plan steps; `tour.ts` the tour skill of an organisation and the material the guided tour shows of it (the newest recording block with judged data, its largest dataset, export, policy, evaluation, report); `selection-metrics.ts` the position figures over a selection, arithmetic over what the critics measured per episode; `shortcuts.ts` the shortcut figures over a selection (background, start pose, counterfactual scenes, layout, the evaluation's start poses), asked of the critics (`POST /analyses/shortcuts`) with the mirrored `diversity` metrics; `prompts.ts` the prompt an episode counts with (`episodes.prompt_override` over the recorded `task`), the critics' prompt check (`POST /analyses/prompts`) against the skill's other datasets, and the skill's paraphrases (`skills.prompt_variants`) spread evenly in a merged export; `spec-drafts.ts` the spec wizard: a sample dataset, the critics in auto mode over picked episodes ("0-9", "1-3,6,8", `episode-selection.ts`), the spec drafted step by step, test runs over all or single episodes (each episode keeps the fingerprint of the spec it was tested with), then stored
  - `src/lib/critics/` client for the critics service (`critics/`), job sync, summary; `specs.ts` the specs, kept in GYM as well (`gym_critics_specs`) and put back when the critics lost them (`ensureSpec`, before any run with a named spec); `report-copy.ts` the copy of a run's report.html in the storage and the report and Markdown drawn from the mirrored report.json once the critics no longer have the job (never read the report from the critics' job alone); tests use `fake-server.test-util.ts` with fixtures of a real run. The summary is stored on the dataset and carries `SUMMARY_VERSION`; bump it when its shape changes, and stale summaries are rebuilt from the stored report on read (`upgradeStaleSummaries`)
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
    `RolloutReview` the human review of a block's rollouts, `EvaluationReportBody` the report; `specwizard/` the steps of the spec wizard (`SpecWizardView`), `specwizard/workbench/` its live view (episodes, the open episode with its questions to the model, `QuestionsPanel` where they are written as "must hold" or "only counts", the rest under "Details", `ScoreFormula` the calculation of a verdict with its numbers); a question reworded since the model answered counts as not tested (`answered` in `utils/specSample.ts`, the words asked are stamped on each answer by `withQuestions`), whose evidence, verdict preview and flag switches live in `utils/specSample.ts`
  - `src/tour/chapters.ts` the guided tour as data (chapters, steps, the `data-tour` element each points at, the material it needs), run by `components/TourHost.vue` with driver.js over the tour skill, read-only; a step's element is marked `data-tour="…"` exactly once (a test checks); the texts are `tour.*` in the locales
  - `src/views/` also `EvaluationReportView` (the report, editable) and `EvaluationReportSharedView` (public, printable); `SkillsView` the list of all skills behind the Skills tab of the navigation
  - `src/components/skill/` the tabs of a skill that are components of their own: `StrategyTab` with `RunSheetPanel`, `SelectionOverview` (the Pre-Train tab: one row per dataset, the export of the whole skill's selection at the top and at the end, `SelectionExportBar`) with `SelectionMetrics` and `SelectionShortcuts`; `wizard/PromptTool` the prompt check and the paraphrases, opened from the upload step; `wizard/RunSheetImport` the button that takes a run sheet over as a block's plan, `VariationFields` the labelled values of a run sheet row under a variation
  - icons are components: `import IconUpload from '~icons/carbon/upload'`
    (unplugin-icons). Never an icon font, never a PrimeVue icon class
  - `src/api/gym.ts` one function per endpoint, `src/types/gym.ts` the API types
  - `src/views/` one view per route (block wizard, day protocol, skill, start, continue, analysis, robots, settings); the wizard steps are `src/components/wizard/Step*.vue`
  - `src/locales/de.json`, `en.json` all UI text
- `critics/` the data critics: the Python analysis engine, its CLI and the REST
  service the backend talks to. Own README, own tests, own CI job.
  - `lerobot_critics/critics/hard|soft` the critics themselves, `spec/` the spec model
  - `runner.py`, `scoring.py`, `selection.py` the run, the verdicts, the episode lists; `shortcuts.py` the shortcut figures over a selection and the prompt check; `benchmark.py` a run against a person's labels (`lerobot-critics eval`)
  - `api/` the FastAPI service and its job store, `cli.py` the command line
- `docs/` product description and glossary; `CHANGELOG.md` per version, `scripts/version.sh` the one version
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
- The critics keep nothing for good, not their specs nor their job directories: a redeploy may start them empty. What GYM needs again (a spec a skill names, the report a link opens) is kept in GYM, the spec in `gym_critics_specs`, the report as report.json on the dataset and report.html in the storage.
- The critics do not own the datasets. GYM stores every dataset through `lib/storage` and hands the critics a temporary URL (`shareFile` of the framework) instead of the bytes; the critics fetch what they need for one job or one merge and keep nothing. `CRITICS_DATA_DIR` is for the CLI and the web UI, not for GYM.
- GYM never judges data itself. The data critics (`critics/`, a service of this repository) are the single source of truth for analysis; their wording (accept, review, reject, flags, spec) is used as it is. When a person downgrades a finding or switches a critic off for a dataset (`PUT datasets/:id/findings`), GYM hands the overrides to the critics (`PUT /jobs/{id}/overrides`), which replay the verdicts; GYM only mirrors the result again (`refreshDataset`), keeping episode ids, the human review and the operator's selection.
- Every member of an organisation is an operator and may read everything. Owners and admins maintain cells and people.
- The strategy of a skill is optional and binds nothing. A run sheet is a guide: a block may take it over as its plan (`planFromRunSheet`), no row is tied to a recorded episode, and its columns carry no meaning to GYM beyond `episode`, `prompt` and the group column the person picks. Never give another column a hard-coded meaning.
- A dataset taken out of the selection (`datasets.included` false) contributes no episode to an export or to the figures over the selection; use `selectedOf` from `lib/gym/exports.ts` when reading what a selection holds. Its episode ticks are never touched by that.
- The position figures over a selection (`lib/gym/selection-metrics.ts`) are arithmetic over the critics' per-episode measurements: mean, standard deviation, count. No threshold, flag or colour is derived from them in GYM. The shortcut figures and the prompt check are the critics' (`/analyses/*`); GYM marks only what their flags name.
- A corrected prompt never rewrites an upload: it is `episodes.prompt_override`, and a merged export hands it to the critics' merge (`sources[].prompts`) together with the skill's paraphrases. Count with the prompt via `effectivePrompt` (`lib/gym/prompts.ts`), never `task` alone.
- A recording is measured before it is analysed: the upload starts the hard critics alone (`measuring`, `measured`, `MEASURE_RUN` in `lib/gym/datasets.ts`), the step to the review starts the full run with the corrected prompts (`analyseBlock`, `options.prompts`). Only episodes of a full run count (`datasets.analysis_pass = 'full'`): filter on it wherever episodes are counted, selected or exported. Rollouts are analysed at once.
- No em dashes or en dashes in UI text, docs or commit messages. Use `·`, commas or separate sentences.

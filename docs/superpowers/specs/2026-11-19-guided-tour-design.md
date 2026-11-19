# Guided tour through one skill · design

Date: 2026-11-19 · Branch: `claude/guided-tour` from fresh `origin/develop` · Version: 0.13.0 (minor)

## Intent

A new person should see one complete iteration of GYM on real data before
they work with it: how a skill is described for the critics, how a block is
recorded and judged, how the selection becomes a training set, how a policy is
linked and evaluated, and how it all shows up in the analysis. The tour walks
through an existing skill of the organisation that has all of that, chosen by
an admin, and only looks: it never changes anything.

## Goals

1. An admin picks one skill per organisation as the tour skill (Settings).
2. Anyone starts the tour explicitly, from the help entry in the header, and
   picks a chapter. There is no automatic onboarding and no "seen" state.
3. Six chapters, each startable on its own, one of them dedicated to critic
   specs. Short explanations: one or two sentences per step.
4. The tour finds its material in the tour skill by itself (a recording block
   with judged data, an export, a policy, an evaluation, a report) and skips
   what the skill does not have, saying so in one line.
5. Read-only: the tour navigates and highlights. It clicks nothing that saves,
   moves a block or starts a run.

## Non-goals

- Demo data or a sandbox skill. The tour shows what the organisation has.
- A hands-on tour where the person uploads or clicks through for real.
- Automatic onboarding, "show once per user", progress tracking.
- Explaining the critics' findings in depth (what each flag means). The tour
  points at where that is explained (the report, the "Why" column).
- The phone views (capture, recording run). The tour names them, it does not
  open them.

## Anti-goals

- The tour must never write. No request other than GET leaves the browser
  while it runs, except reading the tour material.
- A tour step must never leave a screen in a state the person did not choose:
  a dialog the tour opened is closed by the tour, a wizard step it looked at is
  only looked at (the existing read-only "viewing" mode).
- No tour text in components. All text lives in the locales (German first,
  English second), no em or en dashes.

## Constraints (from AGENTS.md)

Routes validate, `lib/` works. Every query tenant-scoped. Every relevant
action audited (choosing the tour skill is). A test for every new route and
piece of logic. Schema change with `bun run app:generate` and a committed
migration. Icons as components (unplugin-icons). Never touch
`backend/framework/**`.

## Approaches

**Where the tour skill is kept**

- A: a flag on the skill, `skills.tour_skill boolean`, with a partial unique
  index per tenant (`where tour_skill`). Deleting or archiving the skill takes
  the choice with it, no dangling reference.
- B: a settings row per tenant (`gym_settings.tour_skill_id`). Extensible, but
  a new table for one value, and a deleted skill needs `on delete set null`.
- Picked: A. One value, owned by the skill, nothing to clean up.

**Tour engine**

- A: driver.js (MIT, ~5 kB gzip, no dependencies): highlight, popover, a
  progress counter, `disableActiveInteraction` keeps the highlighted element
  from being clicked. Steps across pages are driven by our own runner.
- B: Shepherd.js: heavier, its own styling to override.
- C: our own overlay. Full control, most work, most bugs.
- Picked: A, styled through `base.css` tokens (popover background, text,
  primary for the buttons) so it follows light and dark mode.

**How a step finds its element**

- A: `data-tour="<name>"` attributes on the elements a step points at, and a
  test that every name the tour uses exists in the source. Stable across
  restyling.
- B: CSS selectors on existing classes. Breaks on the first restyle.
- Picked: A.

## Design

### 1. The tour skill (backend)

- `skills.tour_skill boolean not null default false`, partial unique index
  `gym_skills_tour_uq on (tenant_id) where tour_skill`.
- `PUT /tenant/:tenantId/gym/tour { skillId: uuid | null }`, owners and admins
  (`isTenantAdmin`). Clears the flag on every skill of the tenant, sets it on
  the one named (404 for a skill of another tenant). Audited as
  `tour.skill.set` with the skill.
- `GET /tenant/:tenantId/gym/tour`, every member: the tour material
  (`lib/gym/tour.ts`, `tourMaterial(tenantId)`):

  ```ts
  interface TourMaterial {
    skill: { id: string; name: string; criticSpecName: string | null } | null
    /** the newest closed recording block with a dataset the critics finished */
    recordingBlockId: string | null
    /** a dataset of that block whose run is done, the one with the most episodes */
    datasetId: string | null
    /** the newest export of the skill */
    exportId: string | null
    /** the newest policy, preferring one trained from an export */
    policyId: string | null
    /** the newest evaluation block with a finished dataset, preferring one with reviewed rollouts */
    evaluationBlockId: string | null
    /** the newest evaluation report of the skill */
    reportId: string | null
    /** is the skill's spec stored (in GYM's copy or the critics), so the spec manager can open it */
    specStored: boolean
  }
  ```

  `skill: null` when no tour skill is set. Every other field is null when the
  skill has nothing of that kind. Plain reads, no write, no call to the
  critics except the spec check through `ensureSpec`'s read path (no put back
  from the tour: `specExists`).

### 2. Settings (frontend)

A field in Settings, section "Organisation" (03): "Tour skill", a Select of
the active skills plus "none", owners and admins only (read-only text for
others). Saved on change. Hint: "The guided tour shows this skill. Pick one
with recorded, exported and evaluated data."

### 3. Starting the tour

- A help icon button in the header (`~icons/carbon/help`), next to the
  settings entry, opens the tour dialog.
- The dialog lists the six chapters with one line each and a "Start" per
  chapter, plus "Whole tour" (all chapters in a row).
- Without a tour skill the dialog says so: admins get a link to Settings,
  everyone else "Ask an admin to choose a tour skill."
- A chapter whose material is missing completely is shown greyed with the
  reason ("This skill has no evaluation yet").
- The tour reads `GET tour` once when it starts.

### 4. The runner (frontend)

- `src/tour/` : `chapters.ts` (the step lists as data), `runner.ts` (drives
  driver.js across routes), `useTour.ts` (a Pinia store: active chapter, step
  index, material).
- A step is `{ id, element, page, needs?, ui? }`:
  - `route`: a route location built from the material (`Skill` with a tab,
    `Block` with `?step=`, `EvaluationReport`, `Analysis`, `Settings`).
  - `element`: the `data-tour` name; the runner waits up to 5 s for it after
    navigating, else skips the step (logged in the console, not shown).
  - `needs`: material fields the step requires; missing means skipped.
  - `ui`: UI state the step shows on top of its page, through the store (the
    spec manager, on its form or its YAML). Never a request that writes.
- Text keys `tour.<chapter>.<step>.title` and `.text`.
- Keyboard: arrow keys and Escape (driver.js). Leaving the tour closes what it
  opened and stays on the current page.
- The skill page and the wizard read the tab and step from the route already
  (`?step=` exists); the skill page gets `?tab=` the same way, so the tour
  navigates instead of clicking tabs.
- Analysis gets `?skillId=` (it has the skill filter since 0.12.0).

### 5. Read-only, enforced

- driver.js `disableActiveInteraction: true` on every step.
- The wizard is opened with `?step=` only for steps other than the block's
  own; for the block's own step the runner sets a `tour` flag in the store
  that puts the wizard into the same read-only fieldset as "viewing".
- The spec manager opened by the tour gets `readonly` (new prop): fields and
  buttons off, no "Save", no "Remove".
- A test asserts that no chapter step names anything but a page, an element,
  its needs and UI state (the store only holds UI state).

### 6. Chapters and steps

Short texts, drafts in English; German written alongside in `de.json`.
`[needs]` names the material a step requires.

**Chapter 1 · The skill** (`skill`)

| # | Screen · element | Text |
|---|---|---|
| 1 | Skill · `skill-header` | This is the skill: the task the robot is trained on. Everything below belongs to it. |
| 2 | Skill · `skill-kpis` | The key figures across all blocks: recorded episodes, accepted ones, policies. |
| 3 | Skill · `skill-tabs` | The tabs follow the work: plan the recording, run blocks, pick the training data, train, evaluate. |
| 4 | Skill · `skill-spec` | The critic spec says what the critics check for this skill. Chapter 2 opens it. |

**Chapter 2 · Critic specs** (`specs`)

| # | Screen · element | Text |
|---|---|---|
| 1 | Skill · `skill-spec` [criticSpecName] | Each skill names one spec. Without one, the critics derive a spec from the dataset itself. |
| 2 | Spec manager · `spec-list` [specStored] | All specs of the organisation, with the skills that use them. |
| 3 | Spec manager · `spec-task` | The task in one sentence and its objects. The language model judges every episode against it. |
| 4 | Spec manager · `spec-indicators` | What counts as success, as statements the model checks. A gate must hold, or the episode is rejected. |
| 5 | Spec manager · `spec-hard` | The technical checks on signals and videos, each with a weight and thresholds. |
| 6 | Spec manager · `spec-scoring` | Where accept, review and reject begin, and findings that are only warnings. |
| 7 | Spec manager · `spec-yaml` | The same spec as YAML, for copying or editing by hand. |
| 8 | Spec wizard · `specwizard-new` | A new spec is best made in the wizard, from a sample dataset. |
| 9 | Spec wizard · `specwizard-steps` | The critics analyse the sample, then come the task, the robot and the cameras. In the workbench you compare video, critics and your own judgement until they agree. |
| 10 | Spec wizard · `specwizard-open` | A draft you started waits here. Tested and stored, it is assigned to the skill right away. |

Steps 8 to 10 show the wizard's start page and explain the steps from there:
the tour does not start a draft. The start page gets a short, static guide
to the six steps of the wizard (`specwizard-steps`), useful without the tour
as well.

**Chapter 3 · Recording a block** (`recording`)

| # | Screen · element | Text |
|---|---|---|
| 1 | Skill, Strategy · `strategy-runsheet` | Optional: the strategy and a run sheet, one row per episode. A block can take it over as its plan. |
| 2 | Skill, Blocks · `skill-blocks` [recordingBlockId] | Every recording happens in a block: one stretch of work in a cell on a day. |
| 3 | Block · `wizard-steps` [recordingBlockId] | The wizard leads through a block step by step and saves every input at once. |
| 4 | Block, brief · `brief-scene` | The brief: the target and the scene, from the phone if you like. |
| 5 | Block, plan · `plan-steps` | The plan: steps and variations, proposed by the AI or taken from the run sheet. |
| 6 | Block, recording · `recording-progress` | While recording, the operator ticks off episodes per step; the clock counts teleoperation time. |
| 7 | Block, upload · `upload-drop` | The recorded LeRobot dataset is uploaded here; GYM keeps it and hands it to the critics. |
| 8 | Block, analysis · `review-summary` [datasetId] | The critics' answer in one line: how many episodes are good, how many are missing. |
| 9 | Block, analysis · `review-dataset` [datasetId] | Per dataset: verdicts, flags and the findings to act on next time. |
| 10 | Block, analysis · `review-report` [datasetId] | The full visual report of the run, printable. |
| 11 | Block, selection · `selection-table` [datasetId] | Which episodes of this block go into training. Rejected ones start unticked; your verdict overrules the critics'. |
| 12 | Block, selection · `selection-export` | The block's own export, as a manifest or one merged dataset. |

**Chapter 4 · Pre-Train** (`pretrain`)

| # | Screen · element | Text |
|---|---|---|
| 1 | Skill, Pre-Train · `pretrain-table` | The training data of the whole skill: one row per recorded dataset, with what is selected of it. |
| 2 | Skill, Pre-Train · `pretrain-included` | Untick a dataset to leave it out of the export and the figures as a whole. |
| 3 | Skill, Pre-Train · `pretrain-review` | Open reviews link straight to the block where they are resolved. |
| 4 | Skill, Pre-Train · `pretrain-positions` | Where was picked, and how much it varies: the spread of the training data. |
| 5 | Skill, Pre-Train · `pretrain-export` | Export the selection under a name: as a manifest, or as one LeRobot dataset ready for training. |
| 6 | Skill, Blocks · `skill-exports` [exportId] | Every export is kept with the skill and can be downloaded again. |

**Chapter 5 · Policy and evaluation** (`evaluation`)

| # | Screen · element | Text |
|---|---|---|
| 1 | Skill, Policies · `policies-table` [policyId] | A trained policy is registered here, with the export it was trained from and where it lives. |
| 2 | Skill, Evaluations · `evaluations-course` [evaluationBlockId] | Each evaluation block tests a policy; the success rate over time shows the progress. |
| 3 | Block, analysis · `rollout-tiles` [evaluationBlockId] | The rollouts of an evaluation: the success rate with its uncertainty, and what still waits for a person. |
| 4 | Block, analysis · `rollout-table` [evaluationBlockId] | A person confirms or overrules each rollout and names the failure mode. That word counts. |
| 5 | Evaluation report · `report-sections` [reportId] | Several evaluations read together, with your written conclusions, shareable as a link. |

**Chapter 6 · Analysis** (`analysis`)

| # | Screen · element | Text |
|---|---|---|
| 1 | Analysis · `analysis-filters` | Filter by period, skill, cell and collection; the tour has chosen the tour skill. |
| 2 | Analysis · `analysis-totals` | Recording and evaluation at a glance: episodes, accept rate, time. |
| 3 | Analysis · `analysis-perday` | Day by day and cell by cell, to see where data quality moves. |
| 4 | Analysis · `analysis-flags` | The findings of the critics that came up most often. |

"Whole tour" runs chapters 1 to 6 in order. Around 41 steps; a chapter is 4
to 12.

### 7. Elements

Every `data-tour` name in the tables above is added to exactly one element.
Most are existing panels or headers (`SectionHeader`, `gym-panel`); a few
need a wrapper. Names are kebab-case, prefixed by the screen.

## Testing

- Backend: `tour.test.ts`: setting and clearing the tour skill (admin only,
  other tenant 404, audited), `tourMaterial` on a skill with everything, on
  one without evaluation and policy (those fields null), with no tour skill.
  The material picks the newest closed recording block with a done dataset,
  ignores open ones and evaluation datasets for the recording fields.
- Frontend (Vitest):
  - every `element` in `chapters.ts` occurs as `data-tour="…"` in `src/`
    exactly once (reads the sources);
  - every text key exists in `de.json` and `en.json`;
  - a step whose `needs` are missing is skipped, a chapter with all steps
    missing reports itself unavailable;
  - no step names anything but a page, an element, its needs and UI state.
- By hand: each chapter on a full tour skill and on one with gaps, phone width
  and desktop, light and dark mode.

## Effort

About 3 to 4 days: engine and runner 1, material and setting 0.5 to 1,
elements and tests 0.5 to 1, texts in two languages 1, checking by hand 0.5.

## Decisions taken while building

1. The tour is started from the help button in the header only.
2. An archived skill may be the tour skill (it keeps its data); the Select in
   Settings lists active and archived skills.
3. The spec wizard is explained from its start page (chapter 2, 8 to 10); the
   tour shows no draft.
4. Opening the brief or the recording step of a closed block no longer asks
   for a phone access token. A closed block refuses one, which left a red
   banner on the screen while the tour (or anyone) only looked at it.

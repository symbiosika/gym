# GYM: Design

This document is the binding reference for the look and the flow of the app.
The frontend implements it with Tailwind v4 and PrimeVue "Volt" (unstyled
PrimeVue, owned in `frontend/src/volt/`), the same base as the other Symbiosika
frontends. `frontend/src/assets/base.css` is the only place the palette lives:
it maps the tokens below onto the `--p-*` variables that drive both Volt and
Tailwind. New views use those tokens and the components listed in section 5,
not their own colours or fonts. Wording: `docs/GLOSSARY.md`.

## 1. Attitude

- A tool for the operator at the cell: few clicks, big numbers, clear states,
  one thing at a time. The operator is the default role; analysis views are
  secondary.
- A step guide, not a form: every block is a numbered sequence of steps, the
  current one is highlighted, finished ones are marked, the state is saved on
  the server so a browser restart resumes the block. The day protocol is the
  frame around the blocks of a cell's day; the skill is what the blocks are for.
- The phone does the quick things (photo, voice, "next"); the operator's screen
  shows the state live and stays the place for corrections.
- No decoration without function. Colour carries meaning (ok / warn / bad),
  everything else is grey. German first, English via the switch. No dashes in
  UI text; separate with `·`, commas or new sentences.

## 2. The operator's flow

| Step | View | What happens |
|---|---|---|
| Home | `HomeView` | The open blocks of today first, newest on top and the first one wide: cell, kind, skill, step, progress against the target, whether the clock runs, "Carry on". Then the tiles Start a block (filled while nothing is open), Continue a skill, Analysis; today's day protocols as cards, each with its blocks (kind, skill, step). |
| Start | `StartBlockView` | Pick a cell (chips; the last one of this browser, or the only one, is preselected), the kind (recording or evaluation, two chips with a line each), the skill (cards with task and figures, a search above them from seven skills on, or a new one with task, collection and spec) and, for an evaluation, the policy under test. A bar pinned to the bottom says the choice in one line, what is still missing, and starts the block. Creates today's day protocol of the cell when missing and the block; opens the wizard. |
| Continue | `ContinueView` | Skills newest first (by last day) with days, episodes and the last evaluation's success rate; "Record" and "Evaluate" open Start with the skill preset. |
| 01 Scene | `wizard/StepBrief` | Under the lead what the block is: kind and policy were said when it was started, so they are a pill, a line and a "Change" link to a dialog, not asked again. Section 01 the target episodes (rollouts for an evaluation): a number field and three typical numbers as chips. Section 02 the scene: the photo (an empty photo is a dashed box that uploads on click), under it a compact QR card for the phone (photo first, then voice or text, done) with the live indicator; the description on the right, its placeholder the skill's task. Photo and text editable here; "Import from another skill" (modal, newest first). "Create plan" hands over to the AI; "Start without a plan" runs the block on the target alone (see below). What keeps the primary action grey is said next to it. A block that already carries a plan offers "To the plan" and "Propose again" (asks first, it replaces the plan) instead. |
| No plan | `wizard/StepBrief` | A block may run without a plan: the operator says what is done today (the description is required for it) and starts. The plan is then the target number of episodes on that one task, in one step, without scene setups and randomizations (`plainPlan`, source "plain"). The recording view counts against it like any other plan, and the plan step still allows building a real one. |
| 02 Plan | `wizard/StepPlan`, `PlanEditor` | Summary, scene setup, randomizations, steps with variations and episode counts; a step can be duplicated (pictures included). Total against the target. Per variation an optional reference image: generate from the scene photo, upload one, use the scene photo, remove it; the panel under the steps, "Generate the missing images", runs over all of them with a progress bar. The plan saves itself a second after the last edit (a step or variation without a name waits) and before leaving the step; the bar says saving, unsaved or saved. "Propose again" asks first, then replaces the plan. "Start recording" (or "Start the evaluation"). For an evaluation the AI proposes the settings to test: the recorded variations first, then unseen ones. |
| 03 Recording | `wizard/StepRecording`, `RunList` | Left the "now" card framed in the accent: current step, variation with its count, progress bar, reference image, the big "Next" (the space bar counts too, unless a field or button has the focus), undo and the position in the step as a number field, so a count that was forgotten for a while is typed instead of clicked one by one; under it the running time of the block and a compact QR card for the run view at the cell. Right the steps as checklist with thumbnails, the count per variation and per step −1, the count as a number field and +1; a click on an unfinished step makes it the current one and "Next" counts on it from then on. Below, folded to one line with their sum, the downtimes of the day: reason and minutes, a table of what was entered (they belong to the day protocol). "Finish recording" leads to the upload. In an evaluation the same view counts rollouts and says not to intervene. |
| 04 Upload | `wizard/StepUpload` | Drop zone first, for one or more zipped LeRobot datasets; uploaded one after the other with progress; every zip goes to the data critics as a dataset of its own. The datasets already uploaded are listed with remove. The spec is the skill's: one line under them ("auto from the dataset" is the default) opens `SpecPicker` with the spec management next to it. With nothing waiting and datasets there the primary action is "To the analysis". |
| 05 Analysis | `wizard/StepReview`, `CriticsSummaryView` | First the answer in one sentence on a toned strip ("46 of 100 episodes are good, 54 to go", target reached, critics still running, many rejected, rollouts that wait for a person), and the filled button follows it: more episodes while the target is not reached, else the selection (an evaluation: close). Then accepted episodes against the target, verdict counts, the block's time and recorded time; a red banner above everything when the run's vision-language model did not answer; per dataset the critics' run (polled while it runs): counts, accept rate, flags, the session profile's indicators that need attention with advice, run-level findings, link to the visual report; per dataset "For next time" lists the advice of the indicators that need attention, while the session profile, the indicators and the dataset findings are folded under "All details of the critics"; with several datasets the newest is open and the others fold to their counts; the AI's follow-up advice as a panel of its own with the button that asks for it. "Record more episodes" loops to 03, "Select episodes" to 06. An evaluation reads the accept rate as the policy's success rate, offers "More rollouts" and closes the block from here: it has no selection. In an evaluation the human review (`RolloutReview`) comes first, above the datasets: the tiles (success rate with the Wilson interval, policy-attributable rate, reviewed by hand, pending), then the findings of the run to weigh (`FindingsOverrides`, open, because a gate such as TRACKERR decides every rollout before anyone looks at one), then "pick by finding" chips that tick every rollout carrying a flag, an action strip that works on the ticked rollouts (or on all: success, no success, as the critics, set the failure mode, set the variation), and the table: a checkbox, the position, the variation, the model's word (with its reasoning on demand), the critics' verdict, the person's three-way decision, the failure mode and a note. The dataset is named only as a group line when the block has more than one. Saved on every change, the block's figures follow. |
| 06 Selection | `wizard/StepSelection`, `EpisodeTable` | Every episode of every recording dataset of the skill, over all days and cells, with verdict, score and reason; rejected ones unchecked; evaluation rollouts are not part of it. "Only accepted", "Accepted + review", all, none. Every tick is saved a moment after the last one. The datasets of the block come first; one column says the verdict: the critics' word in its colour, or the person's ✓ or ✗ over it; the reason is one line with the full text as tooltip, a critic that could not finish is a small pill. An export panel under the table with two downloads: the merged dataset (the filled button, one trainable LeRobot dataset built by the critics) and the manifest alone. The step's primary action is "Close the block". |
| Closed | `wizard/StepClosed` | The block's figures, reopen, and the ways out: print view, skill, day protocol, home. An evaluation keeps its rollout review (`RolloutReview`) on this page, editable without reopening the block: a review may happen a day later, and the figures above follow. |
| Day | `DayView` | One day protocol: cell, date, operator, the times of the day (teleop, evaluation, recorded, downtime), notes; the blocks of the day as a table (kind, skill, step, time, datasets, episodes) with open and delete; the downtimes; "Add a block", "Close the day" (closes the open blocks), delete; the audit log of the day. |
| Skill | `SkillView` | One skill: task, spec, collection, figures; tabs: blocks (by day and cell, with their exports), evaluations (oldest first, success rate per evaluation as the course over time; a checkbox per block and a name field make a report out of the ticked blocks; the skill's reports are listed under it with open and print), policies (name, the export it was trained from, date, notes), episodes (the selection, read-only), audit log. Archive, reactivate, delete; "Record" and "Evaluate" start a block. |
| Report | `EvaluationReportView`, `EvaluationReportBody` | One evaluation report: name, skill, "as of". Actions: edit the text (name, the blocks in the report as a ticked list of the skill's evaluations, the written sections A and F as text areas, saved on blur), share link (copied), print (opens the shared view), to the skill, delete. The body is lettered like the hand-made reports: the read-out tiles (overall success with interval, best block, top failure, policy-attributable rate), a warning strip for pending rollouts and for runs without the model, A scene and task, B success by block (table with rate bar and the Wilson interval as a bracket under it), C block × variation matrix (succeeded / rollouts per cell as verdict-toned pills), D success by variation (bars), E failure modes by block, F conclusion (three panels: working, needs review, next steps), G every rollout, H data lineage. |
| Shared report | `EvaluationReportSharedView` | Public route `/eval-report/:shareId`: the same body read-only with a print button. What a customer sees. |
| Phone | `MobileCaptureView`, `MobileRunView` | Public routes `/m/capture/:token`, `/m/run/:token`. Big buttons, one step at a time; the run view shows the reference image of the current variation and counts rollouts in an evaluation. |
| Print | `PrintView` | Public route `/print/:shareId`. Header of the day (cell, operator, times), then per block: kind, skill, policy, scene, plan, datasets with analysis; the totals of the day (recordings and evaluations apart), the downtimes, notes. Printable. |
| Analysis | `AnalysisView`, `SkillView`, `DayView` | Period, cell and collection filters; totals (recordings, and the evaluations as their own tile), per day, per cell, findings; skills and day protocols. |
| Settings | `SettingsView` | Cells, collections, organisation members and invitations, the critics service, the critics specs (table with the skills that use them, "Manage specs" opens `SpecManager`: the list on the left, the spec on the right as a form in five numbered sections (task and objects, success indicators, technical checks as a table with weight, gate and parameters, scoring, robot) with the YAML one tab away; a new spec starts from a preset of the task shape, `spec/SpecPresetPicker`), AI status. |

## 3. Tokens

Defined once in `frontend/src/assets/base.css`. The GYM blue is the `primary`
scale (`#1D5EA8` is `primary-600`, the brand value), the paper, panel and line
tones of the protocol sheets are the `surface` scale, and the figure colours
are their own tokens. Because they are PrimeVue's `--p-*` variables, Volt and
Tailwind read the same palette.

| Role | Token | Light | Dark |
|---|---|---|---|
| Page background | `surface-100` / `surface-950` | `#EEF1F4` | `#0C1014` |
| Cards, panels | `surface-0` / `surface-900` | `#FFFFFF` | `#151B21` |
| Sunk areas (tab bar, empty state) | `surface-200` / `surface-800` | `#E7ECF0` | `#252F38` |
| Lines | `surface-300` / `surface-800` | `#D8DFE5` | `#252F38` |
| Text | `--p-text-color` | `#111820` | `#E7EDF3` |
| Secondary text | `surface-600` / `surface-400` | `#4C5966` | `#A0AEBA` |
| Accent | `primary` | `#1D5EA8` | `#5C98D8` |
| Accept / ok | `ok`, `ok-soft` | `#1A7A4B` on `#E3F2EA` | `#46B37B` on `#12271D` |
| Review / warn | `warn`, `warn-soft` | `#A2600B` on `#FBF0DC` | `#D79A3C` on `#2A2013` |
| Reject / bad | `bad`, `bad-soft` | `#A6251F` on `#FAE6E4` | `#E0776E` on `#2B1614` |

Fonts: `font-display` Archivo, `font-sans` Public Sans, `font-mono` IBM Plex
Mono. Panel radius `rounded-panel` (10 px), panel shadow `shadow-panel`.
The accent is only for primary actions, links, active chips, focus and the
current step.

## 4. Typography

| Role | Font | Utilities |
|---|---|---|
| Brand, step titles, tile titles, figures | Archivo | `font-display` with `text-xl`/`text-2xl` (titles), `text-3xl`/`text-4xl font-semibold` (figures) |
| Body, inputs, buttons | Public Sans | the default; body is 14.5 px |
| Labels, ids, table heads, status, step numbers | IBM Plex Mono | `font-mono text-xs`; labels through `.gym-field` (uppercase, tracked) |

Figures always `tabular-nums`.

## 5. Building blocks

Recurring shapes are components (auto-imported, no import statement needed);
the few that are pure layout are `gym-*` utilities in `base.css`. Everything
else is written with Tailwind utilities in the component.

- **Page** `.gym-wrap` (centred 1120 px column), `<PageTitle title sub>` with
  actions in its default slot, `<SectionHeader n title hint info>` per section.
- **Header** `AppShell`: sticky, brand + organisation, the three areas as tabs,
  language switch, theme switch, avatar menu (profile, organisation, theme,
  logout).
- **Tiles** on Home: `.gym-panel` cards, the primary one filled with `bg-primary`.
- **Step guide** `WizardSteps` (numbered chips, current one filled, unreachable
  ones dashed; an evaluation has no selection chip). The line under the page
  title carries skill, policy, target, recorded. Inside the wizard the page
  title is the cell alone ("Cell 13", the word in front of the number) and
  carries no links away: the step guide leads, and the ways out (day protocol,
  skill, print) appear when the block is closed. Operator and date are the day
  protocol's, and the date is only said when the block is not today's.
- **Step box** `.gym-stepbox` with `h2`, a lead paragraph, content and
  `.gym-stepnav` (secondary actions left, primary action right; from `sm` on it
  sticks to the bottom of the window while the step is longer than the screen,
  and a hint why the primary action is grey sits next to it). One step box per
  step, nothing else on the page. Done steps in `WizardSteps` carry a check.
  A click on another step in `WizardSteps` only shows it, read-only (a disabled
  fieldset), under a strip that says so: "Back to <current step>" and the
  explicit move ("Continue here", "Continue the recording", "Reopen the block
  here"). Looking never starts the clock and never reopens a closed block.
- **Confirmations** closing a block and removing a dataset ask first
  (`useDialog().confirm`), with the action as the button's word.
- **Errors** the banner says the API's messages in the UI language
  (`utils/errors.ts`, `errors.*` in the locales); one it does not know is shown
  as it came.
- **Two columns** `grid gap-5 md:grid-cols-2` (phone / QR left, content right),
  one column on a phone.
- **QR code** `QrCode` (canvas on white in both themes, URL as caption), always
  with a hint what the link does.
- **Live indicator** a small `animate-pulse` dot, `bg-ok` once received.
- **Plan step** `RunList` (current step framed in `border-primary`, finished
  ones in `bg-ok-soft`); the editor rows live in `PlanEditor`.
- **Fields** `<FormField label hint required info>` around a Volt control
  (`InputText`, `Textarea`, `Select`, `MultiSelect`, `Checkbox`,
  `NumberInput`), laid out in a `grid`. A `Select` option that means "none",
  "all" or "auto" carries the value `NONE` from `utils/select`, never an empty
  string: PrimeVue reads an empty value as "nothing selected" and hides the
  label, so the field would look empty although the option is chosen.
- **Critics specs** `SpecPicker` (the spec of a skill, with "auto from the
  dataset" as the first option) and `SpecManager`, the dialog that says what a
  spec does and lists, reads, writes, uploads and removes them; it names the
  skills that work with a spec before it is deleted.
- **Buttons** Volt `Button` (primary) and `SecondaryButton`, with `size="small"`
  in dense rows and `size="large"` on the phone. A destructive action is a
  `SecondaryButton` with `class="text-bad!"`.
- **Chips** for the cell picker: rounded buttons, selected one in
  `border-primary bg-primary/10`.
- **Figures** `<KpiTile label value sub hero small bar tone>`.
- **Tables** `.gym-panel` wrapper with `overflow-x-auto` around a
  `.gym-table` (`.num` right aligned, tabular figures); a deselected episode
  row is `opacity-50`.
- **Pills** `<Pill tone="ok|warn|bad|accent|neutral">` for verdicts, skill
  status, block kind (recording accent, evaluation warn), plan source, flags.
- **Notes** `.gym-note` (accent edge; `border-s-warn` or `border-s-bad` for a
  warning), `.gym-empty` for "nothing here yet", `AppBanner` for the one
  message strip, `Modal` / `ConfirmModal` for dialogs, `InfoButton` +
  `InfoPopover` for the explanations from the locales.
- **Findings** a row of `Pill`s with count and flag (a downgraded flag in
  `warn`, plus one accent pill counting the overrides); one bordered row per
  session-profile indicator with status, value, meaning and advice. `FindingsOverrides`
  leads with the critics of the run: one row per critic with a checkbox
  (ticked = counts), weight, whether it rejects on its own, what it raised
  and how often it scored low; unticking switches the critic off for this
  dataset. Under it, folded, the single findings: one row per flag with
  count, effect per spec, what muting gives back and a `Select` with three
  weightings (as in the spec, review only, hint only). A change goes to the
  critics, which replay the verdicts; the block's figures follow.
- **Three-way decision** (`RolloutReview`) a segmented control of three small
  buttons in a sunk `bg-surface-100` strip: the neutral option filled dark,
  success filled `bg-ok`, no success filled `bg-bad`. Never a checkbox: "as
  the critics" is a choice of its own, not the absence of one.
- **Rate with interval** (`EvaluationReportBody`) the `h-1.5` rate bar with
  a thin bracket (`border-x border-b`) under it from the interval's low to
  its high. The bar says the rate, the bracket how little 20 rollouts know.

## 6. Dark mode

Both themes are first class. The preference lives on `.dark` on `<html>`,
is set before first paint from `localStorage` and follows the OS while
"system" is chosen (`src/stores/ui.ts`). Never define a colour outside
`base.css`: use the `--p-*` derived Tailwind colours (`surface-*`,
`primary`, …) and the verdict colours (`text-ok`, `bg-warn-soft`,
`border-s-bad`, …), which are re-pointed for dark mode in one place. The QR
code stays black on white in both themes, because a phone camera needs the
contrast.
- **Note** `.note[.warn]`, `.note.followup` for the AI's advice.
- **Drop zone** `.drop[.hot]`.
- **Modal** `Modal.vue` (`.modal-backdrop`, `.modal[.sm|.lg|.xl]`, header, body, footer);
  used for "Import from another skill" and confirmations (`ConfirmModal`, `useDialog`).
- **Phone** one narrow column of numbered panels, the next step dimmed until
  the one before it is done; the run view keeps its actions in `.gym-actions`.
- **Print** narrow, `print:hidden` on the toolbar, white ground.

## 7. States and feedback

- Errors go to the bottom banner (`AppBanner`, `useUi().showBanner`), never only to the console.
- Live data (phone, run view) is polled every 3 to 5 seconds while the step is open and the tab visible.
- Inputs of the brief are saved on blur; the plan and the selection save themselves a moment after the last change and say saving, unsaved or saved.
- Wizard steps are reachable in the guide when their prerequisites exist (plan, datasets); closing goes through its own action. An evaluation may reach the recording step without a plan.

## 8. Figures (definitions)

| Figure | Definition |
|---|---|
| Episodes | Episodes of the uploaded recording datasets (rows of `gym_episodes`, one per episode of a critics run). Rollouts of evaluation blocks are counted apart |
| Accepted / review / rejected | The critics' verdicts; "unknown" only while no run finished |
| Accept rate | accepted / episodes; null while nothing was analysed, never 0 |
| Selected | Episodes with `selected = true` (the operator's export decision) |
| Teleop time | the sum of the windows of the recording blocks of a day. A window opens with "start recording" and closes with "finish recording", an upload, or the close of the block or day; a block opened five times has five windows and the breaks between them do not count. An open window counts up to now |
| Evaluation time | the same sum over the evaluation blocks; never mixed with teleop time |
| Success rate | accepted rollouts / judged rollouts of an evaluation block (or of a period); null while nothing was judged. Counted on the effective verdict: the human verdict where a person reviewed the rollout, else the critics' accept, which means the policy did the task |
| Policy-attributable rate | succeeded / (rollouts minus F-08 rollouts); shown next to the success rate in reviews and reports, never instead of it |
| Wilson interval | the 95 % Wilson score interval of a success rate, in percent; given with every rate a report prints, as a bracket under the bar and as text |
| Pending | rollouts whose critics' verdict is "review" and that no person has decided; they count as not succeeded and are called out above the figures |
| Recorded time | the sum of the episode durations of the recording datasets: the elapsed time that comes from the data itself and not from the tool |
| Downtime | the sum of what the operators wrote down by hand on the day protocol, each a reason and a number of minutes. Nothing in the tool can observe a standstill |
| Episodes / h | episodes / (teleop minutes / 60) |
| Typical duration | median of the episode durations of a critics run |
| Accepted time | sum of the durations of the accepted episodes of a run |
| Target | target episodes (or rollouts) of the block; "to go" = target minus accepted episodes, never below 0 |
| Progress (recording) | episodes counted with "next" / episodes in the plan |

Verdicts, scores, flags and the session profile come from the data critics
and are shown as they are (see `critics/README.md` for the scoring model);
GYM adds no thresholds of its own.

A run whose vision-language model did not answer is not a quiet run. The hard
critics carry such a job to "done", so nothing would show it: the analysis step
and the analysis page therefore lead with a red banner naming the run, how many
episodes it hit and what the model returned. Every figure below it was decided
without the model.

Colour thresholds for rates: at least 80 % ok, at least 50 % warn, else bad.
Verdict pills: accept green, review yellow, reject red.

## 9. Layout

- Content width 1120 px, centred (`.gym-wrap`), 20 px side padding, 48 px bottom padding.
- Grids are Tailwind breakpoints: `sm:` two columns, `lg:` three to six, one column below.
- Tables never widen the page: they scroll inside `overflow-x-auto`.
- `prefers-reduced-motion`: no transitions.
- The phone views are `max-w-lg`, one column, 16 px padding, buttons full width.

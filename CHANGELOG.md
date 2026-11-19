# Changelog

GYM has one version for backend, frontend and critics
(`scripts/version.sh`). Every pull request into `develop` that changes the app
raises it, and its merge is tagged `v<version>`:

- minor (0.8.0 → 0.9.0) for a feature,
- patch (0.8.0 → 0.8.1) for a fix or a change to the documentation only,
- major once GYM is 1.0 and something breaks the API or cannot be migrated back.

The versions before 0.9.0 were given afterwards, one per merged pull request.

## 0.13.0

A guided tour through one skill.

- A help button in the header opens the guided tour: six chapters, each
  startable on its own or all as "Whole tour" (the skill, recording a block,
  critic specs, Pre-Train, policy and evaluation, analysis), with a short
  title and one or two sentences per step, in German and English.
- The tour walks over the tour skill of the organisation, which an owner or
  admin picks in Settings (`skills.tour_skill`, one per organisation,
  `GET/PUT tour`). It finds its material there by itself (the newest
  recording block with judged data, its largest dataset, the newest export,
  the policy, the newest evaluation with reviewed rollouts, the newest report)
  and skips what the skill does not have.
- Every chapter opens with what the activity is for. What a step points at
  gets a thin green frame and is shown from its top, also inside the spec
  manager. The popover can be dragged by its title and stays where it was
  put; a double click puts it back. The recording chapter comes before the
  critic specs and links on to them, and the person's own verdict in the
  selection has a step of its own.
- The tour only looks: it opens pages and highlights elements, the
  highlighted element cannot be clicked, the block wizard and the spec
  manager it opens are read-only, and nothing is written.
- The skill page keeps its tab in the address (`?tab=`), the analysis takes
  its skill from it (`?skillId=`), and the spec wizard's start page shows the
  six steps of the wizard.
- Looking at the brief or the recording step of a closed block no longer asks
  for a phone access token, which a closed block refuses with a red banner.

## 0.12.0

Specs and reports survive a redeploy of the critics; the selection step is the block's.

- The critics keep nothing for good, and a redeploy could leave them with an
  empty spec store and no job directories: specs were gone and the report
  links of blocks led nowhere. GYM now keeps a copy of every spec it writes
  (`gym_critics_specs`) and puts a spec back when the critics lost it, before
  it is listed, read or run with, so an upload no longer falls back to the
  automatic spec unnoticed. A spec written in the critics' own UI is taken
  over the next time GYM lists it.
- The visual report of a run is copied into GYM's storage when the run is
  mirrored (`datasets.report_html_ref`), and the cron copies the reports of
  older runs while the critics still have them. When the critics no longer
  have a job, any other view of its report and its Markdown is drawn by the
  critics from the report.json GYM mirrored, through the new stateless
  `POST /render/report.html` and `POST /render/markdown`. Reports whose job
  was lost before this version come back that way, without their contact
  sheets.
- The selection step of a block shows the datasets and episodes of that block
  only; "all", "none" and the verdict filters only touch them, and its export
  takes that block's selected episodes only (`blockId` on both export routes).
  The selection of the whole skill is exported on the skill's Pre-Train tab.
- The Episodes tab of a skill is now called Pre-Train, and the tabs read
  Blocks, Strategy, Pre-Train, Policies, Evaluations, Audit log. A tick in
  the head of its table takes every dataset into the selection or every one
  out, and the export bar is there twice, above the table and at the end of
  the page.
- The Pre-Train tab of a skill links every dataset to the selection step of its
  block ("Selection", and the "to review" pill), to set ticks and resolve open
  reviews there. The wizard opens the step to look at; "continue here" moves
  the block there.
- The spec manager no longer asks to discard changes when the first spec is
  opened with nothing open yet, and it opens the spec chosen in the picker it
  was opened from.
- The Analysis view filters by skill as well, between the period and the
  cell: the key figures, the day protocols and the skills list follow it, and
  the skills offered follow the collection.
- An export, manifest or merged dataset, takes a name: it names the zip and
  the folder of the merged dataset, and starts as the skill and the day.
- The Strategy tab offers a CSV template of the run sheet, laid out the way it
  becomes plan steps (episode, layout, prompt and further columns as labelled
  values), with the skill's task as the prompt and semicolons in German. A
  sheet that is in can be downloaded to edit it outside GYM.

## 0.11.0

Skills in the navigation, a strategy per skill, datasets instead of episodes.

- A Skills tab between Home and Analysis: every skill of the organisation in
  one list, with a search and a status filter.
- A skill has a Strategy tab: a written description, pictures and PDFs, and a
  run sheet, a CSV with one row per episode to record. A recording block can
  take the run sheet over as its plan ("Import from run sheet", all rows or a
  range like 1-50): a step per group of rows, an episode per row, the other
  columns shown to the operator as labelled values. The sheet is a guide:
  taking it over is optional, a block without it works as before, and no row
  is tied to a recorded episode.
- The Episodes tab of a skill lists datasets instead of single episodes: what
  is selected of each, accept / review / reject of the selected, whether
  reviews are open, and the critics' grasp spread. A dataset is taken in or
  out of the selection as a whole with a tick; a row opens to its episodes,
  read-only.
- Positions over the selection: pick positions, and each wrist at the start
  and at the end, as mean and standard deviation per axis, per arm and as the
  delta between the sides. The data critics measure them per episode
  (`diversity`: `wrists`, `grasps_by_arm`, `grasp_arm`, for every arm whatever
  the spec calls active); GYM only adds them up. Datasets analysed before this
  version carry no positions per arm and show only their grasp positions until
  they are uploaded again. The positions are also drawn: a scatter plot on a
  plane of the robot's coordinates with the mean and one standard deviation
  per arm, and the spread per axis as bars (one standard deviation).
- "Export merged dataset" on the Episodes tab, over the selected episodes of
  the ticked datasets, and "All episodes" per dataset: the dataset unfiltered,
  whatever the verdicts and ticks.
- A VLM failure in the analysis can be acknowledged: it leaves the red banner
  and stays listed with who and when until that is taken back.
- A policy can carry a link to where it lives (http or https).
- The critics name both arms (`ACTIVE_ARMS_BOTH`) when the spec leaves the arms
  unset, none stands out and both work, the way they name the left or the
  right one. A statement of the report: scores and the VLM prompt are as
  before.

## 0.10.1

- The VLM judge works again with google-genai 3.0, which switched its default
  API version to v1: the critics ask for v1beta, the only version that offers
  agentic video processing ("Agentic video processing is not enabled for api
  version v1"). google-genai is held below 4.0, so a new major version no
  longer slips into an image build.

## 0.10.0

The VLM judge stops deciding alone.

- A camera claim of the VLM (frozen camera, jump cut, blur, exposure) counts
  only when a hard critic measured the same thing on the same camera within a
  second of the time the model names. The duplication critic records its
  stalls with their times (`video_stalls_moving.<camera>`) for that. A claim
  nothing confirms is kept as minor and marked unverified, so it no longer
  raises `VLM_MAJOR_ANOMALY`. A claim about the idle arm's camera never counts.
- The model is told how the composite video was sampled (at 5 fps from 30 fps
  the frame index advances by 6), which it had read as skipped frames.
- The wrist camera of an idle arm (`robot.active_arms`) is left out of the
  composite video, the sampled frames and the prompt.
- New `scoring.soft_can_reject`: off for recordings, on for evaluations. When
  off, an episode only the VLM would reject goes to review with the cause
  `soft` instead of being rejected.
- `lerobot-critics eval <run> --labels <file>` measures a run against a
  person's labels (a filtered dataset's `subset_provenance.json` or an
  include/exclude list): reject precision and recall, verdicts against labels,
  what every flag is worth, which of the person's reasons the run catches.

## 0.9.0

Robots.

- A Robots tab between Analysis and Settings: every robot with its photo,
  technical and personal name, the cell it is in, its status (in service,
  maintenance, retired) and the components that need a look.
- The robot opens in a modal: profile, platform reference (manufacturer,
  model, serial number, product version) and six capability sections
  (sensors, actuators, locomotion, compute, communication, system) as condensed
  lists. A component opens for editing on a click, is saved on the fly and
  confirmed on its row; it can be duplicated ("… copy 1").
- Component statuses ok, degraded, faulty, disconnected (light blue: there but
  not connected, e.g. on no ROS topic) and unknown.
- The history of a robot says what changed per section ("New actuator",
  "Updated sensors", "Deleted …"); a save that changes nothing leaves no entry.
- The robot field of a cell in the settings is a choice of robots, "Undefined
  robot" or "No robot yet". Every robot written as free text before became a
  robot of its own (migration 0012).
- Owners and admins maintain robots, every member reads them. MCP tools
  `list_robots` and `get_robot_audit`.
- One version for backend, frontend and critics (`scripts/version.sh`, checked
  in CI), shown small next to the GYM brand in the navbar and on
  `GET /app-info`. This changelog.

## 0.8.0 · 2026-11-04

Per-dataset spec overrides (#10).

- The critics lay the facts of a run over the spec of a dataset (which arms
  were active, the instruction, the objects); GYM keeps them on the dataset,
  and the Upload step asks for the arm.
- The critics score only the active arms, check them against the data, sample
  the grasping arm, skip zero-pose rows and guard against range inflation;
  tremor in mm and a pick-only switch.
- Soft critics: the prompt knows the robot, anomalies are typed and
  corroborated, a billing error ends the stage, hard rejects may be skipped.
- A deleted spec falls back to the auto spec; the spec form shows the
  essentials first.

## 0.7.1 · 2026-10-21

- README: screenshots and a highlights section (#9).

## 0.7.0 · 2026-10-14

- Spec wizard workbench: questions to the model, written as "must hold" or
  "only counts"; a question reworded since the model answered counts as not
  tested; the rest under Details (#8).

## 0.6.0 · 2026-10-14

- Spec wizard: episodes picked like a print range ("0-9", "1-3,6,8"), tests
  of single episodes, the calculation of a verdict with its numbers (#7).

## 0.5.0 · 2026-10-14

- Spec wizard: how a verdict comes about, and the way to accept (#6).

## 0.4.0 · 2026-10-13

- Spec wizard: one live workbench for the whole sample, every flag of the
  sample with what it means and a switch for it, what holds the sample back
  and how to let it through (#5).

## 0.3.0 · 2026-10-13

- Spec wizard: work out a critics spec from a sample dataset (#4).

## 0.2.0 · 2026-10-13

- Large dataset uploads: the chunks stay in the storage as the parts of the
  dataset, the critics join them (#3).

## 0.1.0 · 2026-10-13

- First public release of GYM: the operator's block wizard, day protocols,
  skills, data critics, selections and exports, evaluation blocks and
  reports, key figures, audit log, MCP server (#1).

# Changelog

GYM has one version for backend, frontend and critics
(`scripts/version.sh`). Every pull request into `develop` that changes the app
raises it, and its merge is tagged `v<version>`:

- minor (0.8.0 → 0.9.0) for a feature,
- patch (0.8.0 → 0.8.1) for a fix or a change to the documentation only,
- major once GYM is 1.0 and something breaks the API or cannot be migrated back.

The versions before 0.9.0 were given afterwards, one per merged pull request.

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

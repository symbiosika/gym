# The data critics

**Decide which recorded robot episodes are good enough for training.**

This is the analysis engine of GYM. It lives in this repository under
`critics/` and runs as the `critics` service of the compose stack; the app
talks to it over the internal network (`CRITICS_URL`, see
`backend/src/lib/critics/`). It is also a standalone CLI and Python library,
which is how it is developed and validated.

`lerobot-critics` sits between teleoperation and training (and can grade policy rollouts
the same way). It takes one or more [LeRobot](https://github.com/huggingface/lerobot)
datasets plus a normalized *spec* that says **what to check**, runs two families of
critics over every episode, and emits scores, verdicts and an include/exclude list:

| family | what | how |
|---|---|---|
| **hard critics** | technical indicators we prescribe with default thresholds: smoothness, duration, tracking error & teleop latency (leader vs follower), duplicate frames / lag, image quality, sensor limits & dead zones, grasp cycles & grasp profile, data integrity, input-device tremor, normalisation hygiene, spatial diversity | deterministic, CPU only, from parquet + video |
| **soft critics** | task-specific success indicators: correct object, centred grasp, object in target zone, visibility, no disturbance … (free text per task) | a vision-language model watches a multi-camera composite video of the episode — Gemini 3.x Flash in **agentic video mode**, or any OpenAI-compatible image model via sampled frames |

Every critic has a **weight**; gates and flags make exclusion defensible ("rejected because
the command stream froze for 9 s", not "score 0.61"). Runs as a CLI, as a Python library,
or as a **REST service in Docker** (x86_64 and arm64 / Jetson).

```
docker compose -f docker-compose.critics.yml up -d --build    # from the repository root
pip install -e ".[all]"                                       # or work on it directly
lerobot-critics init-spec /data/my_dataset -o spec.yaml     # starter spec from the dataset
lerobot-critics run /data/my_dataset --spec spec.yaml --out critic_out   # several datasets: list them all
lerobot-critics episodes critic_out --why            # which episodes to filter, and why each one
```

`critic_out/` then contains `report.md`, `report.json`, `episodes.csv`, `selection.json`
(`include` / `review` / `exclude` episode lists plus the reason per filtered episode — see
[Which episodes to filter, and why](#which-episodes-to-filter-and-why)), `report_ai.md` (a self-contained Markdown
version of everything, written for pasting into an AI assistant — see
[Handing results to an AI assistant](#handing-results-to-an-ai-assistant)), `report.html`
(a short visual report with charts, printable to PDF — see
[Visual report](#visual-report-charts-print-to-pdf)), contact sheets for every non-accepted
episode, the composite videos the VLM saw, and a VLM verdict cache.

---

## The spec

A YAML/JSON document, validated by pydantic (`lerobot_critics.spec.models.CriticSpec`).
Everything except `task.instruction` has defaults. A complete spec for another robot:
[`examples/specs/xlerobot.yaml`](examples/specs/xlerobot.yaml).

```yaml
name: cup_tray
purpose: recording               # recording: demonstrations judged as training data (the default);
                                 # evaluation: rollouts of a trained policy judged on the outcome.
                                 # Sets every default a spec leaves out and the judge's framing (see below)
task:
  instruction: "pick cup from table, place on tray"      # the dataset's task string
  per_episode: auto              # auto: when the dataset records several distinct tasks, judge each
                                 # episode against its own (a scripted eval that varies the prompt
                                 # per episode); one task -> `instruction` is used. always | never
  scene: "Round white table, black tray, humanoid uses its left hand ..."
  objects:
    - { name: cup,  role: target_object, description: "brown ceramic cup" }
    - { name: tray, role: target_zone,   description: "black rectangular tray" }
  expected_cycles: 5             # repetitions per episode (null = unknown)
  notes: "A person resets the cup between repetitions - that is the protocol."
robot:
  type: humanoid_v1
  active_arms: [left]            # arms that do the task; others are only checked for faults
  gripper: { feature: observation.state.humanoid_v1.addons.left_hand, dims: [2,3,4,5], closed_is_high: true }
hard_critics:                    # id, weight, thresholds; omitted = defaults
  - { id: integrity,      weight: 1.0, gate_flags: [VIDEO_MISSING, NAN_VALUES, LENGTH_MISMATCH] }
  - { id: duration,       weight: 1.0, params: { min_s: 40, max_s: 150 }, gate_flags: [TOO_SHORT, TOO_LONG] }
  - { id: smoothness,     weight: 1.0 }
  - { id: tracking_error, weight: 1.5, gate_flags: [TRACKERR] }
  - { id: duplication,    weight: 1.5, gate_flags: [LAGGY, CAMSTALL] }
  - { id: image_quality,  weight: 1.0 }
  - { id: sensor_limits,  weight: 0.5, params: { limits: { observation.state.humanoid_v1.left_wrist: { z: [0.6, 1.4] } } } }
  - { id: grasp_cycles,   weight: 1.0, gate_flags: [NOGRASP] }
soft_critics:
  vlm: { provider: gemini, model: gemini-3.7-flash, mode: agentic }
  indicators:                    # what the VLM judges, per task
    - { id: correct_object,   weight: 1.0, description: "The robot grasps the cup, not the tray." }
    - { id: grasp_centered,   weight: 1.0, description: "Cup grasped around its body, centred, no slipping.",
        rubric: "1.0 clean grasp; 0.5 one re-adjust; 0.0 slips or falls" }
    - { id: object_in_target, weight: 2.0, gate: true, gate_below: 0.3,
        description: "Cup stands upright on the tray after every release." }
    - { id: visibility,       weight: 0.5, description: "Cup and tray visible in the front camera while manipulating." }
    - { id: no_disturbance,   weight: 1.0, description: "No collision, drop, or person in the workspace while the robot moves." }
scoring:
  hard_weight: 1.0
  soft_weight: 1.0
  accept_threshold: 0.75         # total >= accept -> accept; >= review -> review; else reject
  review_threshold: 0.55
  review_flags: [VLM_TASK_FAILED, VLM_MAJOR_ANOMALY, HUMAN_IN_WORKSPACE, UNFINISHED_GRASP]
  ignore_flags: [INACTIVE_ARM_TRACKERR]   # findings that do not apply to this rig (see below)
```

### Scoring model

* Every critic returns a **score in [0, 1]** (1 = good), a list of **flags**, metrics and
  evidence. Hard-critic scores come from linear ramps between a *good* and a *bad*
  threshold (`params`), so each default is a physical quantity you can argue about
  (e.g. `pos_bad_mm: 40`).
* `hard_score` and `soft_score` are weighted means of their group; `total` is the weighted
  mean of the two groups (`scoring.hard_weight` / `soft_weight`).
* **Gates** are the exclusion mechanism: `gate: true, gate_below: x` rejects when a critic's
  score drops below `x`; `gate_flags: [...]` rejects when the critic raises one of the named
  flags. `review_flags` cap an otherwise accepted episode at *review*.
* **Dataset-relative outlier flags** (`*_OUTLIER`, robust median/MAD z-scores) are
  informational: they point at episodes that differ from the rest of the recording session
  without affecting the score.
* **Switching a criterion off.** `scoring.ignore_flags: [FLAG, ...]` mutes findings that do
  not apply to your setup: a muted flag is dropped before gates, review caps and every
  report, as if it had never been raised. It removes a finding's effect on the *verdict*, not
  the score its critic gave — for that, lower the critic's `weight` (or `enabled: false`), or
  narrow what it looks at:

  ```yaml
  robot:
    active_arms: [left]                # the right arm is not doing the task: it is only checked
                                       # for faults, with 3x relaxed tracking thresholds, and
                                       # raises INACTIVE_ARM_TRACKERR instead of TRACKERR
  hard_critics:
    - id: tracking_error
      params: { exclude_patterns: [right] }   # ignore the unused arm entirely (no score, no flag)
  scoring:
    ignore_flags: [INACTIVE_ARM_TRACKERR, IDLE_ARM_DRIFT]   # or just mute the findings
  ```

  Every report says which flags actually *decided* a verdict and how many episodes muting one
  would give back, so you can see what an off switch buys before you flip it (see
  [Which episodes to filter](#which-episodes-to-filter-and-why)).

### Recording or evaluation: the purpose

The same critics judge teleoperated demonstrations and rollouts of a trained policy, but not
with the same consequences. `purpose: recording` (the default) reads every episode as
training data: every technical check weighs on the score, a frozen command or a follower that
does not follow rejects the episode, and the review flags cap what a person should watch
before training on it. `purpose: evaluation` reads every episode as a policy rollout and asks
one question, did the policy do the task:

* the hard critics still run and still raise their flags (a stalled camera is a fact of the
  rollout), but none of them weighs on the score or gates the verdict; only a broken file
  does (`integrity`). `tremor` and `diversity`, which describe a human operator, are off;
* the default success indicators are the placement (weight 3, gate at 0.5, with a rubric),
  the object and the disturbances *before* the first correct placement; a collision after
  the task was done does not undo the success;
* `review_flags` shrink to `VLM_TASK_FAILED` and `HUMAN_IN_WORKSPACE`, `relative_flags` is
  off, the VLM judge is told it is watching a policy and to judge the outcome rather than the
  style, and the reports speak of success and failure instead of include and exclude;
* every field a spec sets explicitly wins over these defaults.

The purpose is a fact of the run rather than of the task, so a job may set it:
`POST /jobs {"spec": "cup_tray", "purpose": "evaluation"}` judges the dataset as rollouts
with the task's spec, the stored spec untouched (`lerobot-critics init-spec --purpose
evaluation` writes a starter spec for rollouts).

**The pre-roll.** An evaluation stack records from the start, but the policy takes over a few
seconds in: until then the action topic carries zeros while the state is the resting robot.
Read naively those frames are dropouts, a tracking error of a metre, a frozen command stream
and a spike where the real command begins. A leading span of zero commands of at least
`robot.preroll_min_s` (default 1 s) is therefore treated as the start-up delay: the signal
critics measure from its end, `normalization` reports it (`preroll_s` per episode, the median
and the episodes at run level) and the VLM is told the still start is normal. A shorter span
stays a dropout (`ZERO_FRAMES`). `preroll_min_s: null` switches the detection off.

## Hard critics (defaults are prescribed by us, all overridable per spec)

| id | measures | flags |
|---|---|---|
| `integrity` | parquet vs meta length, contiguous `frame_index`, timestamp gaps, NaN/inf, video frame count per camera | `LENGTH_MISMATCH` `VIDEO_MISSING` `VIDEO_FRAME_MISMATCH` `NAN_VALUES` `TIMESTAMP_GAPS` |
| `duration` | seconds inside `[min_s, max_s]` (optionally per expected cycle) | `TOO_SHORT` `TOO_LONG` |
| `smoothness` | windowed log-dimensionless-jerk, high-frequency energy of the speed profile (tremor), **physically implausible command spikes** (> 25 m/s² or > 1 m/s in one frame), hesitation | `JERKY` `ACTION_SPIKES` `HESITATION` |
| `tracking_error` | \|action − state\| per arm: position (mm, **lag-compensated**), orientation (°, rot6d/quat/euler), hand; follower lag (frames); longest not-following span; inactive-arm faults | `TRACKERR` `INACTIVE_ARM_TRACKERR` |
| `duplication` | near-duplicate camera frames **while the robot moves** (a static scene legitimately re-encodes to identical frames), longest all-cameras freeze, frozen action / state rows (lag, hiccups) | `CAMSTALL` `LAGGY` `STATE_FROZEN` |
| `image_quality` | mean brightness band, blown-out / black pixel fraction, Laplacian sharpness, frame size vs `info.json` | `OVEREXPOSED` `UNDEREXPOSED` `BLUR` `SIZE_MISMATCH` |
| `sensor_limits` | configured `limits` per feature dim, `dead_zones`, generic saturation runs (a value pinned at its extreme; informational unless `flag_saturation: true`) | `LIMIT_VIOLATION` `DEAD_ZONE` `SATURATED` |
| `grasp_cycles` | close→open cycles of the hand/gripper (hysteresis; re-grasps within 1 s merged into one attempt; closures without a ≥ 5 cm carry counted as *idle closures*, not attempts) vs `task.expected_cycles`; produces grasp/release keyframes; **grasp profile** per cycle: closing duration, wrist motion while closing, settle time before closing, gaps between cycles, active share of the episode | `NOGRASP` `CYCLE_COUNT` `MULTIGRASP` `REGRASP` `UNFINISHED_GRASP` |
| `tremor` | **where the shaking comes from**: share of command vs robot-state velocity power above 5 Hz (Welch PSD) and the dominant tremor frequency (8–12 Hz = human hand tremor through the input device), hold-phase jitter (how much the command still moves while the hand should be still: detrended position std, RMS speed), commanded vs measured rotation speed, finger command speed | `TREMOR` `HOLD_JITTER` |
| `normalization` | **training-statistics hygiene**: all-zero dropout frames in pose/joint features (one such frame drags the dataset min/max range to 0 and costs the policy most of its action resolution), the start-up delay before the first real command (the pre-roll, reported as `preroll_s` and not counted), constant action dimensions, drift of arms that should idle (`robot.active_arms`), actions that are copies of the state; run level: inflation of the `meta/stats.json` min/max range per dimension | `ZERO_FRAMES` `IDLE_ARM_DRIFT` `ACTION_IS_STATE` · run level `STATS_RANGE_INFLATED` `DEAD_ACTION_DIMS` |
| `diversity` | **spatial diversity** of the demonstrations: wrist position at every grasp / release keyframe and at the start; run level: std, robust std and range across the run. Informational (weight 0): a run whose grasps all lie within a few cm teaches a fixed trajectory, not a visually guided grasp | run level `LOW_DIVERSITY` |

`tracking_error` additionally reports the **teleop latency** as a sub-frame estimate in
milliseconds (`lag_ms`, cross-correlation of command and state velocities with parabolic
peak interpolation), the correlation at the peak, and the share of the raw position error that
is pure delay (`lag_err_share`). It measures the delay between the recorded command topic and
the recorded state topic; everything before the command topic (VR tracking, network) is not in
the data.

### Every metric is explained

Every number a critic emits has an English *what / how* description
(`lerobot_critics/metrics_doc.py`), so an operator can read a result without opening the code:

* `report.md` and `report_ai.md` end with a **metric glossary** (one table per critic, plus the
  flags that occurred); the episode Markdown carries the glossary for its own metrics;
* `episodes_columns.csv` next to `episodes.csv` describes every column (critic, unit, which
  direction is good, what, how);
* `report.json` has `metric_docs` for every metric key present in the run, `flag_docs` with
  the meaning of every flag the run raised (episode and run level, the model's included), and
  `dataset_summaries` / `dataset_flags` with the run-level findings;
* the web UI shows the description next to each metric (hover for the formula) and the
  run-level findings on the result card;
* `lerobot-critics metrics [critic]` and `GET /metrics?critic=…` list the documentation.

### Recording session profile

Every report starts with the **session profile** (`lerobot_critics/session_profile.py`): the
physical numbers that describe how the dataset was recorded, aggregated over the run and judged
against the spec's thresholds - teleop latency command→robot in ms (with the per-episode series,
the share of the tracking gap that is pure delay and the residual tracking error), tremor in the
command vs. the robot state with the dominant frequency and its source, command motion in hold
phases, grasp behaviour (cycles, closing duration, wrist motion while closing, settle time,
active share), spread of the grasp positions across the run, dropout rows and normalisation
range inflation, idle-arm drift, frozen streams, camera stalls and a per-camera table. Each
indicator carries a status (good / warn / bad / info), what it means and what to do. It is
rendered in `report.md`, `report_ai.md`, the web UI and, with charts (latency per episode,
tremor command vs. robot, top view of all grasp positions), in the visual `report.html`, and it
is stored in `report.json` under `session_profile`.

**Run-level findings** (`HardCritic.summarize`) are properties of the whole recording session
rather than of one episode - `LOW_DIVERSITY`, `STATS_RANGE_INFLATED`, `DEAD_ACTION_DIMS` - and
never change a verdict; they tell you what to change in the *next* recording session.

`lerobot-critics critics` prints every critic with its default parameters. Feature roles
(action/state pairs, cartesian vs joint vs hand, active arm, gripper signal, primary
camera) are auto-detected from `meta/info.json` + `meta/representation.json` and can be
overridden under `robot:`.

## Soft critics — the VLM judge

The runner builds **one composite video per episode**: primary camera on top, the other
cameras in a row below, time and frame index burned in, 5 fps h264 (~2–3 MB per 80 s
episode). The prompt is generated from the spec (task, scene, objects, expected cycles,
notes, indicator descriptions + rubrics) and the model must answer a JSON schema:

```json
{ "attempts": [{"grasp_time_s": 9.4, "release_time_s": 15.0, "placed_correctly": true}],
  "indicators": {"object_in_target": {"score": 0.8, "confidence": 0.9, "evidence": "4 of 5 ... at 62s the cup ..."}},
  "anomalies": [{"type": "drop", "time_s": 21.5, "severity": "major", "description": "..."}],
  "task_success": false, "confidence": 0.9, "summary": "..." }
```

Each indicator becomes a soft `CriticResult` (weight, optional gate). `vlm.summary`
(weight 0) carries attempts, anomalies, `task_success`, token usage and latency and
raises `VLM_TASK_FAILED`, `VLM_MAJOR_ANOMALY`, `HUMAN_IN_WORKSPACE`.

Providers (`soft_critics.vlm`):

| provider / mode | input | notes |
|---|---|---|
| `gemini` / `agentic` (default) | composite video, `media_processing=AGENTIC` | Gemini 3.6+ Flash navigates the video itself (zooms into the moments it needs). On a 39-episode, three-camera dataset: 9k–94k tokens (median 34k) and 7–37 s per 80 s episode, ≈ 1.3 M tokens for 39 episodes. |
| `gemini` / `static` | composite video sampled at 1 fps | cheaper and fully deterministic sampling; ~5k tokens / episode |
| `gemini` or `openai_compatible` / `frames` | N sampled frames (plus grasp/release keyframes) as JPEG tiles | works with OpenRouter (`google/gemini-3.7-flash`, `qwen/qwen3-vl-*`), vLLM / Ollama on a Jetson (`base_url`) |

Verdicts are cached in `<out>/vlm_cache/` keyed by episode, model, mode, prompt and media
hash, so re-running after a spec change that does not touch the prompt is free.
Keys come from `GEMINI_API_KEY` / `OPENROUTER_API_KEY` (or `api_key_env`).

## Web UI and REST service

```
docker compose -f docker-compose.critics.yml up -d --build   # from the repository root
lerobot-critics serve --port 8080                            # or run it from the venv
```

This is the interface GYM uses: the app uploads the zipped dataset, starts a job and
mirrors the result. The image (`Dockerfile.critics-service` in the repository root) is
`python:3.11-slim` + ffmpeg, builds for **linux/amd64 and linux/arm64** (Jetson) and has
no GPU dependency. To run it on its own, without a GYM around it, there is
`docker-compose.critics-service.yml`: one service, one variable.

Open <http://localhost:8080/> for the web UI. GYM has its own screens for the daily work,
so this one is for the analyst who wants to check a dataset outside a session or edit a
spec. It is built around three things a person wants
from a run:

1. **Check a dataset** (left): pick a dataset found under the data directory or upload a
   zipped LeRobot dataset, choose *what to check* — **Auto** generates a spec from the dataset
   (task text, robot, active arm, repetitions per episode) and **saves it as
   `<dataset>-auto`** so it can be refined after the run — or a stored spec (YAML editor
   behind *Edit*), optionally restrict the episodes or switch the VLM judge off, press
   *Check dataset*. Runs are listed with status, progress and verdict counts.
2. **The result** (right): verdict counts with one sentence saying what to do with the
   dataset, the **recording session profile** (only the indicators that need attention, with
   *what it means* and *what to do*; the fine ones on demand), the dataset-level findings, and
   the episode table (verdict, score, duration, flags with their meaning on hover; filters for
   review / reject / flagged; every critic score on demand). A row opens the episode in a
   side panel: why it was scored that way, the checks that pulled it down with evidence and
   metrics (each metric with its description), the VLM judge's attempts and anomalies, the
   contact sheet and the composite video. `#job=<id>&ep=<n>` in the URL is a shareable link
   to exactly that view.
3. **Export**: *Copy training selection* puts the accepted episode indices on the clipboard,
   *Report (PDF)* opens the printable report, and the *Export* menu holds the Markdown for an
   AI assistant (three detail levels) and the raw files (selection, CSV, JSON, Markdown).

Plain HTML/JS served by the API itself, no build step and no external assets, so it also
works on an offline Jetson.

| endpoint | purpose |
|---|---|
| `GET /health`, `GET /critics`, `GET /metrics?critic=…` | liveness, built-in critics + defaults, what/how documentation of every metric |
| `POST /specs`, `GET /specs`, `GET/PUT/DELETE /specs/{name}`, `POST /specs/auto` | spec store (YAML files in `CRITICS_SPECS_DIR`) |
| `POST /jobs` `{"dataset": "my_ds", "spec": "cup_tray", "options": {"episodes": [0,1]}}` | asynchronous run; `dataset` is a path under `CRITICS_DATA_DIR`, an absolute path, a zip URL, or a HF dataset id. `"datasets": [...]` starts one job per dataset with the same spec |
| `POST /jobs` with `"options": {"max_episodes": 10, "sheets_for_all": true}` and `"store_auto_spec": false` | a sample: at most `max_episodes` episodes, spread evenly from the first to the last (`dataset_episodes` in the report says how many the dataset holds), a contact sheet of every one of them, and with `"spec": null` the generated spec stays with the job instead of being stored as `<dataset>-auto`. How GYM's spec wizard drafts a spec from a sample dataset |
| `GET /jobs/{id}/episodes/{ep}/videos`, `GET /jobs/{id}/episodes/{ep}/video?camera=` | the camera videos of an episode of the job's dataset (its window inside a packed v3 file), streamed with range requests; while the job holds its working copy. `options.include_episodes` analyses episodes picked by number on top of a `max_episodes` sample |
| `GET /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/spec` | status + progress (`hard` / `soft` done/total); the spec the job ran with as YAML. A `"spec": null` job generates one and also stores it as `<dataset>-auto`; generating it needs the data, so it happens in the job, and `/jobs/{id}/spec` answers once the job has prepared |
| `GET /jobs/{id}/report`, `/report.md`, `/selection`, `/episodes/{ep}`, `/files/{path}` | results and artifacts (csv, contact sheets, composites) |
| `PUT /jobs/{id}/overrides` `{"review_flags": [...], "ignore_flags": [...], "disabled_critics": [...]}` | downgrade findings of a finished run and replay its verdicts: `review_flags` only cap an episode at review (a warning), `ignore_flags` are muted, `disabled_critics` (ids such as `tracking_error`, or `vlm` for the model) count with nothing: no weight, no gate, no flags. The critic results stay as raised, the report carries the overrides in `overrides`, and empty lists restore the run as scored |
| `GET /jobs/{id}/report.html?top=5` | the visual report: overview with charts + detail analysis of the `top` most conspicuous episodes (`text/html`, printable) |
| `GET /jobs/{id}/markdown?detail=full\|flagged\|summary&episodes=0,3-5`, `GET /jobs/{id}/episodes/{ep}/markdown` | the run (or one episode) as self-contained, AI-readable Markdown (`text/markdown`) |
| `POST /evaluate` (`?format=markdown` for the AI-readable Markdown instead of JSON) | synchronous run for ≤ 10 explicit episodes |
| `GET /datasets`, `POST /upload` (multipart zip) | datasets under `CRITICS_DATA_DIR`; upload extracts to `CRITICS_DATA_DIR/<name>`. For the CLI, the web UI and local work: an app that owns its datasets hands over a URL instead (see below) |
| `POST /merge` `{"name": "session_a", "sources": [{"dataset": "run_1"\|url, "episodes": [0,2], "name": "run_1"}, …]}` | the selected episodes of several datasets as **one** LeRobot v2.1 dataset, zipped: renumbered without gaps, one task table, statistics combined where the sources have them. Sources with a different fps or different features are refused with 400. A source may be a temporary URL; give its `name`, because a link carries a token and not a name |
| `GET /ui` | the web UI |

### The service does not own the data

The critics analyse datasets; they do not keep them. An app that owns its
datasets stores them itself and hands over a **temporary URL** instead of the
bytes: a presigned link of an object store, or a signed link of the app. Both
`POST /jobs` and `POST /merge` take such a URL wherever they take a dataset.

A dataset of several gigabytes may also come **in parts**: `"dataset_parts":
[url, url, …]` instead of `"dataset"`, in `POST /jobs` and in a merge source.
The parts are the zip cut into pieces (GYM keeps a dataset in the chunks it was
uploaded in); they are fetched in order into one file, which is then the zip.
The status of the job names such a dataset by its first part and the number of
parts, never by its links.

What follows from that:

- the zip is fetched into the working directory of that one job or that one
  request, unpacked, and the archive is deleted straight away. The working copy
  goes when the job is deleted or the merge has answered.
- nothing is written into `CRITICS_DATA_DIR` on an app's behalf. That directory
  is for the CLI, the web UI, `POST /upload` and anything put there by hand.
- a link carries a token, so it is never written into a status file and never
  logged. A merge source therefore carries a `name`, and that is what the
  manifest and any error message show.
- `"spec": null` (generate a spec from the dataset) needs the data, so it is
  done in the job. `POST /jobs` answers at once whatever the source is, which is
  what makes a multi-gigabyte dataset behind a URL workable at all: no request
  waits for a download, and no proxy times one out.

### Where the spec lives under Docker Compose

`docker-compose.critics.yml` mounts three host directories under `.critics-data/`:
`data` -> `/data` (datasets), `jobs` -> `/jobs` (results) and
**`specs` -> `/specs` (the specs)**. So a spec is the file
`.critics-data/specs/<name>.yaml` in the repository root; inside the container it is
`/specs/<name>.yaml` and the API/UI knows it by its bare `<name>`. In production
(`docker-compose.prod.yml`) the same three paths are named volumes. The store starts out
empty (nothing is baked in), so create the first one:

```bash
# a starter spec straight from the dataset -> .critics-data/specs/my_task.yaml
docker compose -f docker-compose.critics.yml run --rm critics init-spec /data/my_dataset -o /specs/my_task.yaml

# or seed the store with the examples that ship in the image
docker compose -f docker-compose.critics.yml run --rm --entrypoint sh critics -c 'cp /app/examples/specs/*.yaml /specs/'
```

Then edit `.critics-data/specs/my_task.yaml` on the host like any file — for instance to switch a
finding off for this dataset, in the top-level `scoring:` block:

```yaml
scoring:
  accept_threshold: 0.75
  review_threshold: 0.55
  ignore_flags: [INACTIVE_ARM_TRACKERR, IDLE_ARM_DRIFT]
```

No restart needed: the spec store is read from disk per request. Then run it — through the UI
(<http://localhost:8080/ui>, the spec dropdown lists `my_task`, and its YAML editor writes the
same file), through the API (`POST /jobs {"dataset": "my_dataset", "spec": "my_task"}`, or with
the whole spec inline as an object instead of a name), or on the CLI against the same image:

```bash
docker compose -f docker-compose.critics.yml run --rm critics run /data/my_dataset --spec /specs/my_task.yaml --out /jobs/manual
docker compose -f docker-compose.critics.yml run --rm critics episodes /jobs/manual --why --switchable
```

Note that an unknown key in the YAML is silently dropped rather than rejected, so
`ignore_flags` one level too high (or under `hard_critics`) has no effect at all. The report's
*How to read this report* block lists the findings a run actually muted — that is the quickest
confirmation that the spec change arrived.

Behind a TLS-intercepting corporate proxy build with
`docker build --network host --secret id=ca_bundle,src=/path/ca.crt --build-arg HTTPS_PROXY=http://proxy:port -f Dockerfile.critics-service .`
(the CA lands in the system store and is used by apt, pip/uv and the service at runtime).

Environment: the image needs **nothing** to start. `CRITICS_DATA_DIR` (`/data`),
`CRITICS_JOBS_DIR` (`/jobs`) and `CRITICS_SPECS_DIR` (`/specs`) are set in the image and
the volumes are declared, host and port come from the default command. Worth setting:
`GEMINI_API_KEY` (or `OPENROUTER_API_KEY`) so the soft critics can judge task success, and
`CRITICS_API_KEY` to protect the service (when set, every endpoint except `/health`
requires `Authorization: Bearer <key>` or `X-API-Key`). The image is `python:3.11-slim`
+ ffmpeg and has no GPU dependency; on a Jetson build it with
`docker build --platform linux/arm64 -f Dockerfile.critics-service .`
and point `soft_critics.vlm` at a local vLLM/Ollama endpoint (`provider: openai_compatible`,
`mode: frames`) if the device is offline.

## Which episodes to filter, and why

Every report answers the three questions of a finished run explicitly: *which episode numbers
do I train on*, *why was this one filtered*, and *which criterion can I switch off*.

```bash
lerobot-critics episodes critic_out/                          # the three lists
lerobot-critics episodes critic_out/ --why --switchable       # + per-episode reason + off switches
lerobot-critics episodes critic_out/ -v accept -f ranges      # 0-12,14,16-21
lerobot-critics episodes critic_out/ -v accept -f list        # one number per line, for a shell loop
lerobot-critics episodes critic_out/ -f json                  # the whole selection as JSON
```

```
accept (32, use for training): 0-12,14-21,23-25,29,31-34,36-38
review (6, a person should look at it): 13,22,26-28,35
reject (1, exclude from training): 30

why filtered
  ep 30 reject: gate failed: duplication (flag CAMSTALL, LAGGY)
      decided by: CAMSTALL LAGGY
      - all cameras frozen simultaneously for 7.47s
  ep 13 review: score 0.89 would accept, but flag HUMAN_IN_WORKSPACE caps it at review
      decided by: HUMAN_IN_WORKSPACE
      - operator reached into the workspace at t=93.6s

findings that decide verdicts (mute via scoring.ignore_flags)
  HUMAN_IN_WORKSPACE caps the episode at review; decides 2 episode(s); if muted: 13,35 → accept
  CAMSTALL rejects the episode (gate); decides 1 episode(s); if muted: 30 → review
```

`decided by` is the part that matters when you disagree with a verdict: it names exactly what
you would have to switch off to get the episode back, and `if muted` is a **replay of the whole
run** with that flag muted, so it is what you would really get — not an estimate. A finding that
appears under *other findings* was recorded but did not filter anything.

`selection.json` carries the same thing machine-readably: `include` / `review` / `exclude`,
`ranges` (the compact form), `include_with_review`, `reasons` per filtered episode
(`cause` = gate / flag / score, `blocking` = the flags that decided it) and `switchable`
(per finding: which episodes it decides and which come back when muted). For LeRobot:

```bash
python -m lerobot.scripts.train ... --dataset.episodes "$(jq -c .include critic_out/selection.json)"
```

`report.json` keeps every metric per critic per episode so a training pipeline (or a
human) can apply a different policy later without re-running anything.

## Visual report (charts, print to PDF)

`report.html` is the same run as a **short visual document for people who have to decide
something** — deliberately not a per-episode dump:

* **overview**: KPI tiles (episodes checked, usable for training, accepted recording time,
  median score, rejected by a gate, distinct findings), the verdict split as a donut and one
  sentence saying what to do with the dataset;
* **charts**: total score per episode *in recording order* (so a bad stretch of the session is
  visible) with the accept / review thresholds drawn in, the score distribution, the mean score
  of every critic worst-first (which check is the run's weak spot) and the most frequent flags;
* **dataset-level findings** (`LOW_DIVERSITY`, `STATS_RANGE_INFLATED`, …) with what was measured
  and what to do about it;
* **which episodes to filter**: the accept / review / reject lists in full — as episode numbers,
  as the compact `0-12,14` form a `--episodes` filter takes, and as a copy-paste block;
* **top findings of the run**: the flags ordered by severity (gates first, then review flags),
  each with the episodes it hit, its meaning and a remedy;
* **why these N episodes were filtered**: one row per *every* non-accepted episode — the decisive
  cause (a failed gate, a review flag, or the score alone), the evidence behind it, what you
  would have to switch off to get it back, and the findings that did not filter anything;
* **criteria you can switch off**: per finding that decides a verdict, how many episodes muting it
  would give back (a replay of the run), plus the spec snippet that does it;
* **detail analysis of the top *N* episodes** (default 5, most conspicuous first: failed gates,
  then rejects and reviews, then the lowest scores) — verdict, failing gate, the critics that
  pulled the episode down with their evidence and metrics, the VLM judge's summary and
  anomalies, and the episode's contact sheet;
* a *how to read this* block, the glossary of the flags that occur, and links to the run's
  other artifacts.

One self-contained file: inline CSS, hand-built inline SVG charts (no JS libraries, no CDN, so
it works offline on a Jetson) and the contact sheets embedded as data URIs — mail it as is. It
carries a print stylesheet (A4, page breaks between the sections), so **Print → Save as PDF**
in any browser gives a handful of pages.

```bash
lerobot-critics html critic_out/                    # writes critic_out/report.html
lerobot-critics html critic_out/ --top 10 --open    # 10 episodes in detail, open in the browser
lerobot-critics html critic_out/ -o ~/quality_review.html
```

Every run writes `report.html` itself; the API renders it on request
(`GET /jobs/{id}/report.html?top=5`, artifact links pointing back at the job) and the web UI has
a **Visual report** button on every finished job. In Python:
`lerobot_critics.visual_report.render_html_report(report, out_dir=Path("critic_out"), top_n=5)`.

## Handing results to an AI assistant

`report.md` is written for a person; `report_ai.md` is the same run as **self-contained
Markdown for an LLM or agent**: a preamble that explains scores, verdicts, gates and flags, the
task and objects from the spec, every check that ran with weight, gate rule and parameters,
the scoring thresholds, a glossary of every flag raised, dataset statistics, the score table
(worst first) and, per episode, a critic table with scores/flags/evidence, the numeric metrics,
and the VLM judge's summary, attempts and anomalies. Paste it into a chat and ask "why was
episode 30 rejected?" or "which episodes should I drop, and what does the rig need fixing?".

```bash
lerobot-critics markdown critic_out/ --copy                  # whole run -> clipboard (pbcopy / wl-copy / xclip / clip)
lerobot-critics markdown critic_out/ --detail flagged | pbcopy   # details only for review/reject episodes
lerobot-critics markdown critic_out/ --detail summary -o summary.md
lerobot-critics markdown critic_out/ --episode 30            # one episode, short and self-contained
lerobot-critics markdown critic_out/ -e 13,22,26-28          # restrict the score table and details
```

`--detail full` (default, also what `report_ai.md` contains) includes every episode;
`flagged` keeps the per-episode sections only for review/reject; `summary` stops after the
score table. The same text comes from `GET /jobs/{id}/markdown` and `GET
/jobs/{id}/episodes/{ep}/markdown`, and the web UI has a **Copy as Markdown for AI** button on
every finished job and on each episode's detail view. In Python:
`lerobot_critics.ai_report.render_ai_markdown(report, detail="full")` /
`render_episode_markdown(report, 30)`; `load_report("critic_out")` reads a finished run back.

## Python API

```python
from lerobot_critics.runner import run, RunOptions
from lerobot_critics.spec.models import load_spec

report = run("/data/my_dataset", load_spec("spec.yaml"), RunOptions(out_dir="critic_out", workers=4))
print(report.counts, report.include)
for ep in report.episodes:
    print(ep.episode, ep.score.verdict, ep.score.total, ep.score.flags)
```

Adding a hard critic: subclass `lerobot_critics.critics.base.HardCritic`, set `id`,
`default_params`, implement `evaluate(ep) -> CriticResult` (use `ramp()` for scores),
decorate with `@register` from `critics.registry`, and reference the id in the spec.

Merging what survived the selection into one trainable dataset:

```python
from lerobot_critics.merge import MergeSource, merge_datasets

result = merge_datasets(
    [
        MergeSource(root="/data/run_1", episodes=[0, 2, 5], name="run_1"),
        MergeSource(root="/data/run_2", episodes=[1, 4], name="run_2"),
    ],
    "/data/session_a",
)
print(result.frames, [e.index for e in result.episodes], result.warnings)
```

The output is always the v2.1 layout (one parquet and one video per episode), whatever
the sources were; a packed v3 video is cut to the episode's window. `episode_index`,
`frame_index`, `index` and `task_index` are rewritten, so the merged dataset reads like
one recording. Sources with a different fps or a different feature set raise
`MergeError` instead of being merged into something unusable.

## Layout

```
lerobot_critics/
  dataset/      loader (LeRobot v2.x + v3.0), video decode (PyAV), one-pass scan, feature auto-detection
  spec/         pydantic spec models, defaults, auto-spec
  critics/hard  the eleven hard critics (+ _util for kinematics, spectra, cross-correlation)
  metrics_doc.py  what/how documentation of every metric (glossary, columns CSV, API, UI)
  critics/soft  prompt/schema builder, Gemini + OpenAI-compatible providers, VLM judge + cache
  scoring.py    weighted aggregation, gates, verdicts, robust z, muted flags
  selection.py  the episode lists, why each episode was filtered, what muting a finding gives back
  runner.py     process pool (hard) + thread pool (VLM), dataset stats, report writing
  report.py     report.json / report.md / episodes.csv / selection.json / contact sheets
  merge.py      selected episodes of several datasets as one v2.1 dataset (renumbered, one task table)
  ai_report.py  report_ai.md: self-contained AI-readable Markdown (whole run or one episode)
  visual_report.py  report.html: printable visual report (SVG charts + top-N detail analysis)
  video_composite.py  multi-camera composite writer (ffmpeg)
  api/          FastAPI app + job store
  cli.py        run / episodes / markdown / html / init-spec / critics / metrics / serve
tests/          synthetic LeRobot dataset fixture; loader, critics (incl. tremor / normalization / diversity,
                metric-doc coverage), scoring, runner, API, VLM plumbing
examples/specs  xlerobot.yaml
```

## Development

Everything below runs in `critics/`:

```
uv venv && . .venv/bin/activate
uv pip install -e ".[all]"
pytest -q                      # ~1 min, uses a synthetic dataset built with ffmpeg
ruff check .
```

CI runs the same two commands (`.github/workflows/ci.yml`, job `critics`).
Changing the critics changes what GYM shows, so keep the vocabulary
(accept / review / reject, flags, spec) stable or follow it through in
`backend/src/lib/critics/` and the locales.

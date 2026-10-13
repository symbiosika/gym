# GYM glossary

The vocabulary is binding in code, API, UI texts and documentation. Do not
introduce synonyms. Code and API are English; the UI is German first with an
English translation.

The model has two axes. **Controlling** is the cell's time: the day protocol
and its blocks. **Product** is what is trained: the skill with its policies.
A block joins the two: it is one stretch of work in a day protocol, for one
skill.

| Term | Meaning | Code / API |
|---|---|---|
| Gym | The facility with its training cells. | |
| Cell | A physical training cell in the gym with one robot. Day protocols belong to a cell. | `cell`, `gym_cells` |
| Day protocol | One per cell and day: the controlling record. Carries the operator, the downtimes written down by hand, notes, the share id of the print view, and the blocks of the day. Created with the first block of the day, closed by hand (its open blocks close with it). | `dayProtocol`, `gym_day_protocols`, API `days` |
| Block | One stretch of work in a day protocol for one skill: a recording block or an evaluation block. The unit of the operator wizard. Carries the scene brief, the plan, progress, the windows of its time, the mobile access token, its datasets and the wizard step. A day has as many blocks as the operator started, of any kind, for any skill. | `block`, `gym_blocks`, `BlockKind` |
| Recording block | A block in which the robot is teleoperated. Its datasets train the skill. | `kind: "recording"` |
| Evaluation block | A block in which a trained policy of the skill runs. Its rollouts are recorded, uploaded and judged by the critics with the skill's spec, but as rollouts (the job's purpose is `evaluation`: the outcome of the task decides, the technical checks only report); the accept rate of the rollouts is the policy's success rate. Its datasets never reach the export. Has no selection step; may run without a plan. | `kind: "evaluation"`, `policyId` |
| Kind | Recording or evaluation. Chosen when the block starts, changeable in the first step while the block has neither a plan nor a dataset. | `kind` |
| Step | The position of a block in the operator wizard: brief, plan, recording, upload, review, selection, closed. Persisted, so a restart resumes the block. An evaluation skips selection. | `step`, `BlockStep` |
| Collection | A customer project or use case. Groups skills. | `collection`, `gym_collections` |
| Skill | What is trained: the task, the critics spec, the recording blocks over all days and cells, the episode selection, the exports and the policies. Active or archived. Has no cell and no dates of its own. | `skill`, `gym_skills` |
| Policy | A trained version of a skill, optionally with the export it was trained from and when. Evaluation blocks point at the policy they test. | `policy`, `gym_policies` |
| Evaluation | An evaluation block as the skill sees it: date, cell, policy, judged rollouts, accepted rollouts, success rate. The list of a skill's evaluations is the course of its performance over time. | `EvaluationSummary`, `successRatePercent` |
| Rollout | One run of the policy in an evaluation block, recorded as one episode. Accept means the rollout succeeded. Belongs to a variation of the evaluation plan: the one the reviewer names, else the one the plan has at its position. | `RolloutRow`, `variationLabel` |
| Human review | A person's word on a rollout after the critics: the human verdict (accept or reject; null leaves the critics' word), a failure code, a note, the variation. Only rollouts of evaluation blocks are reviewed; a recording's episodes are picked in the selection. | `humanVerdict`, `reviewNote`, `reviewedBy`, API `blocks/:id/rollouts/review` |
| Effective verdict | What a rollout counts as: the human verdict where there is one, else the critics' verdict. Every success rate in GYM (block, skill, key figures, report) is counted on it. | `coalesce(human_verdict, verdict)`, `effectiveVerdict` |
| Failure code | Why a rollout failed, from a fixed catalogue: F-01 grasp failure, F-02 localization / pose error, F-03 place failure, F-04 wrong object, F-05 timeout, F-06 collision, F-07 unexpected motion after the task, F-08 hardware / infrastructure. Set in the human review; counted as the failure modes of a report. | `FailureCode`, `FAILURE_CODES` |
| Invalid rollout | A rollout with failure code F-08: not the policy's fault. Shown, counted in the rollouts, left out of the policy-attributable rate. | `INVALID_FAILURE_CODE`, `invalid` |
| Policy-attributable rate | Succeeded rollouts over the rollouts that are not invalid. Next to the plain success rate, never instead of it. | `attributableRatePercent` |
| Wilson interval | The 95 % range of true success rates consistent with the count observed. Given with every success rate of a report, because 20 rollouts per checkpoint do not separate a 15 point spread. | `ci`, `wilson()` |
| Evaluation report | Evaluation blocks of a skill read together: one policy on a day, or the checkpoints of a training run against each other. Success per block and per variation with intervals, the block × variation matrix, failure modes per block, every rollout, the data lineage, and the written sections (prompt, success criteria, design, reset, caveats, what is working, what needs review, next steps). The figures are computed from the blocks whenever the report is read. Has a share id for the read-only view. | `evaluationReport`, `gym_evaluation_reports`, route `/eval-report/:shareId` |
| Teleoperation (teleop) | A person operates the robot; the executions are recorded. | `teleopStartedAt`, `teleopEndedAt` |
| Window | One open/close of the recording step of a block. A block has as many as the operator opened it; the block's time is their sum, not the span from the first start to the last close. In a recording block it is teleoperation time, in an evaluation block evaluation time. | `teleopIntervals`, `TeleopInterval` |
| Downtime | A standstill of the cell, written down by the operator with a reason and a number of minutes. Belongs to the day protocol, whatever ran in the cell. The tool cannot observe one. | `downtime`, `DowntimeEvent` |
| Recorded time | The sum of the episode durations of the recording datasets: the elapsed time that comes from the data and not from the tool. | `recordedSeconds` |
| Operator | The person at the cell who runs the cell that day. The default role of the app. Stored on the day protocol. | `operatorUserId`, `operatorName` |
| Analyst | A person or AI agent who looks at recorded data: history, volumes, quality, duration, the success of evaluations. Uses the analysis views or the MCP server. | |
| Organisation | A tenant of the framework: users, cells, skills. Everything is scoped to it. | `tenantId` |
| Scene brief | Photo and text that describe what is done in the block, plus the target number of episodes (or rollouts). Usually captured with the phone. | `sceneImageFileId`, `sceneText`, `targetEpisodes` |
| Plan | The plan of a block: scene setups (steps) with variations and episode counts. Proposed by the AI, edited by the operator. In a recording block a recording plan with domain randomizations; in an evaluation block an evaluation plan that says which settings to test the policy on. Optional for an evaluation: without one the rollouts are counted on a one-step plan made from the target. | `plan`, `RecordingPlan` |
| Plan step | One scene setup of the plan with its variations. | `PlanStep` |
| Variation | One domain randomization inside a plan step (object position, orientation, distractors, …) with a number of episodes. In an evaluation plan one setting to test. | `PlanVariation` |
| Reference image | The optional picture of a variation: the scene photo edited so it shows the variation built up. Generated by the image model, uploaded or the scene photo itself; can be replaced or removed. Nothing depends on it. | `PlanVariationImage`, bucket `gym-variation` |
| Domain randomization | Deliberate variation of the scene so the trained policy generalises. | `randomizations` |
| Recording | One teleoperation run of a block that produces one dataset. The operator walks through the plan and presses "next" after every episode. | `progress`, `RecordingProgress` |
| Recording run view | The mobile view at the cell that shows the plan and counts episodes (or rollouts). | route `/m/run/:token` |
| Episode | One execution of a single task, one record. Belongs to a dataset. In an evaluation block one rollout. | `episode`, `gym_episodes` |
| Dataset | One uploaded LeRobot dataset of a block (zip with data, videos, meta). Belongs to a block, a day protocol and a skill; has exactly one critics run. | `dataset`, `gym_datasets` |
| Data critics | The Python analysis engine in `critics/`, run as a service of the compose stack: hard critics (kinematics, video) and soft critics (VLM) that judge every episode. The single source of truth for analysis. | `critics/`, `lib/critics/` |
| Spec | The critics' description of what to check for a task: task, objects, hard critics with thresholds, soft indicators, scoring. Stored in the critics' spec store, maintained in GYM's spec management (read, write, upload, remove) and picked per skill; without one the critics derive a spec from the dataset. | `criticSpecName` |
| Critics run (job) | One execution of the critics over one dataset. GYM mirrors its report.json and selection.json. | `criticsJobId`, `report`, `selection` |
| Summary | GYM's compact view of a run: counts, accept rate, flags, run-level findings, session profile. | `analysis`, `CriticsSummary` |
| Verdict | accept, review or reject for one episode (the critics' wording; "unknown" only while no run finished). Only "reject" deselects an episode for the export; "review" means a person should look. In an evaluation accept means the rollout succeeded, and a rollout on "review" without a human verdict is pending: it does not count as a success until a person decides. | `verdict`, `EpisodeVerdict`, `pendingReview` |
| Flag | A finding of a critic on an episode, e.g. `LAGGY`, `NOGRASP`, `TRACKERR`. Gate and review flags decide verdicts; others are informational. | `flags` |
| Finding override | A person's weighting of a finding (flag) of one run after the fact: "review only" (the finding caps an episode at review, a warning, instead of rejecting it) or "hint only" (muted, as if never raised). GYM hands it to the critics, which replay the verdicts of the run; the critics' results stay as raised, so the override can be taken back. The human review of the rollouts and the operator's selection survive the replay. | `overrides`, `rawFlagCounts`, API `datasets/:id/findings`, critics `PUT /jobs/{id}/overrides` |
| Disabled critic | A critic switched off for one run after the fact, because it does not apply to the setup (tracking_error on a rig whose readback is off, the model as a whole): it counts with nothing, neither score nor gate nor findings, when the critics replay the verdicts. Its results stay on the record. Muting a flag alone would leave the critic's score in the total, so this is the answer to "this criterion does not apply here". | `disabledCritics`, `critics` on the summary, critics `disabled_critics` |
| Reason | Why the critics did not accept an episode: the cause (gate, flag, score), one line, the blocking flags. From selection.json. | `reason`, `EpisodeReason` |
| Session profile | The critics' indicators of how the dataset was recorded (latency, tremor, grasp behaviour, diversity, hygiene), each with status and advice. The critics' own term; GYM has no "session" of its own. | `profile`, `profileHeadline` |
| Follow-up | The AI's advice after an analysis: what to record again and how many episodes. | `followUp`, `FollowUpSuggestion` |
| Selection | The operator's decision per episode of the skill's recording datasets whether it goes into the export. Bad episodes start deselected. | `selected` |
| Export | A saved selection of a skill, downloadable as a zip with the manifest and the critics' selection files. Recording datasets only. | `export`, `gym_exports` |
| Merged dataset | The same selection as one LeRobot dataset instead of a manifest: the selected episodes of every recording dataset of the skill, renumbered without gaps, with one task table. Built by the data critics, which hold the uploads, and handed straight to training. | `POST /merge`, `critics/lerobot_critics/merge.py` |
| Manifest | The file in the export zip that maps source datasets (critics dataset, job, spec) to the selected episode indexes and their compact ranges. | `manifest.json` |
| Audit log | Every relevant action with user and timestamp, pointing at the skill, the day protocol and the block it concerns. Read per skill and per day protocol. Append-only. | `gym_audit_log` |
| Access token | The token in the QR code links of the mobile views. Belongs to a block, expires, dies when the block closes. | `accessToken` |
| Share id | The public id of the printable day protocol. The link is shareable, e.g. with a customer. | `shareId`, route `/print/:shareId` |
| Print view | The simplified, printable view of a day protocol with all its blocks. | `PrintView` |
| Key figures (KPIs) | Volumes, quality and speed of the recordings for a period, per cell and per day, and the evaluations apart: blocks, judged rollouts, success rate. | `lib/gym/kpis.ts` |
| MCP server | The analyst's door for AI agents: read-only tools over skills, day protocols, blocks, datasets, episodes, rollouts, evaluation reports and key figures. | `src/mcp` |

/**
 * Server instructions the MCP host keeps in context while the gym is
 * connected. The MCP server is the analyst's door into the gym: it reads
 * skills, day protocols, blocks, datasets, analyses, episodes and key
 * figures. Wording follows docs/GLOSSARY.md.
 */
export const SERVER_INSTRUCTIONS = `
GYM: the daily work of a robotics gym, where robots are trained by teleoperation in cells and trained
policies are evaluated there. All tools act with the signed-in user's permissions in their organisation
and are read-only.

Two axes, wording to use exactly:
- Controlling (the cell's time):
  - Cell: a physical training cell.
  - Day protocol: one per cell and day; the controlling record. Carries the operator, the downtimes
    written down by hand, notes, and its blocks.
  - Block: one stretch of work in a day protocol for one skill, either a recording block (teleoperation,
    the datasets train the skill) or an evaluation block (a policy runs, its rollouts are recorded and
    judged). Carries the scene brief (photo, text, target), the plan, progress, the windows of its time,
    its datasets and the wizard step (brief, plan, recording, upload, review, selection, closed).
- Product (what is trained):
  - Collection: a customer project or use case; groups skills.
  - Skill: what is trained. Task, critics spec, recording blocks over all days and cells, the episode
    selection, the exports, the policies.
  - Policy: a trained version of a skill. Evaluation blocks point at the policy they test.
  - Dataset: one uploaded LeRobot export of a block; has exactly one analysis by the data critics.
  - Episode: one execution of a task inside a dataset; verdict accept, review or reject; in a recording
    block the operator's selection decides what goes into the export; in an evaluation block an episode
    is one rollout of the policy and accept means the rollout succeeded.
  - Human review: a person may overrule the critics on a rollout (humanVerdict accept or reject), name a
    failure code (F-01 grasp failure, F-02 localization / pose error, F-03 place failure, F-04 wrong
    object, F-05 timeout, F-06 collision, F-07 unexpected motion after the task, F-08 hardware or
    infrastructure, not charged to the policy) and say which plan variation the rollout ran in. The
    effective verdict of a rollout is the human's where there is one, else the critics'; every success
    rate is counted on it.
  - Evaluation report: evaluation blocks of a skill read together (one policy on a day, or several
    checkpoints of a training run): success per block and per variation with Wilson 95 % intervals,
    the policy-attributable rate (without F-08), failure modes, every rollout, and the written sections
    (prompt, success criteria, design, reset, caveats, conclusions, next steps).
  - Export: a saved episode selection of a skill (recording datasets only), downloadable as a manifest or
    as one merged dataset.
  - Audit log: every relevant action with user and timestamp, per skill and per day protocol.

The times are measured in different places and must not be mixed: teleop minutes is the sum of the
windows of the recording blocks (what the tool saw); evaluation minutes the same for evaluation blocks;
recorded seconds is the sum of the episode durations of the recording uploads (what the data holds);
downtime minutes is what the operator wrote down about the cell standing still.

Workflow: whoami once (organisation), then list_cells and list_skills to see what exists.
get_skill gives the blocks, exports, policies and evaluations of a skill (which days it was trained on,
when it was evaluated, how the success rate moved); get_day_protocol the blocks and times of a cell's
day; get_block the details of one block; get_dataset the analysis and episodes of one dataset;
get_kpis the figures for a period, a cell, a collection or a skill. Use the figures of get_kpis instead
of adding up rows yourself. get_block_rollouts lists the rollouts of an evaluation block with both
verdicts; list_evaluation_reports and get_evaluation_report give a skill's reports with their figures.
Rollouts with pendingReview (the critics said review, no person decided) are undecided: say so.

A dataset whose vision-language model did not answer (softCriticsFailed on its analysis) was judged
by the hard critics alone: its verdicts say nothing about whether the task succeeded. Say so when
you report on such a run instead of reading its accept rate as a quality statement.

Never invent counts or times. When a figure is missing, say so.
`.trim();

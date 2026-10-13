# GYM: what the app is for

GYM organises the daily work in a robotics gym. A gym has **cells** in which
robots are trained by **teleoperation**: a person operates the robot and every
execution of a task is recorded as an **episode**. The recordings become
datasets that train robot policies, and the trained policies are evaluated in
the same cells.

The app keeps two records that used to be tangled and are now kept apart:

- **The cell's day** (controlling). Every cell and day has one **day
  protocol**: who was there, how long the cell stood still, notes, a printable
  and shareable view. The work itself is done in **blocks** of that day: a
  recording block or an evaluation block, each for one skill. A day may hold
  four recordings for one skill, or a recording for one skill in the morning
  and an evaluation of another in the afternoon.
- **The skill** (product). A skill is what is trained: its task, its critics
  spec, its recording blocks over all days and cells, the episodes the
  operator selects for training, the exports, and its **policies** (trained
  versions). An **evaluation block** tests a policy: the rollouts are recorded
  and judged by the critics like any dataset, and their accept rate is the
  policy's success rate. A person then reviews the rollouts and has the last
  word: success or not, and why it failed (a failure code). Evaluation data
  never reaches a training export. An **evaluation report** reads several
  evaluation blocks together, for example the checkpoints of one training run,
  and gives success per block and per variation with intervals, the failure
  modes and every rollout, next to the text the team writes; it is shareable.

The app takes the operator through a block and keeps the record for the people
who need to look at the results:

- **Operator** (default role, the app is optimised for it): the person at the
  cell. The app is a step guide: start a block (cell, recording or
  evaluation, skill), describe the scene with the phone, get a plan from the
  AI (domain randomizations to record, or settings to test the policy on),
  walk through it, upload the dataset, see the analysis, record more where
  needed, select the episodes worth keeping and download the merged dataset.
  Everything is saved as it happens; a browser restart resumes the block.
- **Analyst / management** (a person or an AI agent via MCP): sees skills with
  their blocks, evaluations and policies (which days a skill was trained on,
  when it was evaluated, how the success rate moved), day protocols with their
  times, datasets and their analyses, episodes and key figures such as
  volumes, good rate, teleoperation time and episodes per hour.

Every day at a cell produces one **day protocol** with a printable, shareable
view, and every action is written to an **audit log** that can be read per
skill and per day protocol.

Analysis is not done by GYM itself: every uploaded dataset goes to the
**data critics** (`critics/`, a service of this repository), which
judges every episode (accept, review, reject), names the flags that decided it
and describes how the session was recorded. GYM mirrors that result, shows it
to the operator and hands back a manifest with the selected episode indexes
per dataset for training.

See [GLOSSARY.md](GLOSSARY.md) for the binding vocabulary and the root
[README.md](../README.md) for setup.

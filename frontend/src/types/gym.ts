/**
 * Types of the gym API as the frontend sees them. They mirror the views the
 * backend returns (backend/src/lib/gym/*.ts, backend/src/lib/critics/*.ts);
 * wording follows docs/GLOSSARY.md. Verdicts are the lerobot-critics' own:
 * accept, review, reject.
 */

export type SkillStatus = 'active' | 'archived'
export type BlockKind = 'recording' | 'evaluation'
export type BlockStep = 'brief' | 'plan' | 'recording' | 'upload' | 'review' | 'selection' | 'closed'
export type EpisodeVerdict = 'accept' | 'review' | 'reject' | 'unknown'
/** The human's verdict on a rollout, over the critics'; null leaves the critics' word. */
export type HumanVerdict = 'accept' | 'reject'
/** The failure catalogue of the human review; F-08 is not charged to the policy. */
export type FailureCode = 'F-01' | 'F-02' | 'F-03' | 'F-04' | 'F-05' | 'F-06' | 'F-07' | 'F-08'
export const FAILURE_CODES: FailureCode[] = ['F-01', 'F-02', 'F-03', 'F-04', 'F-05', 'F-06', 'F-07', 'F-08']
export const INVALID_FAILURE_CODE: FailureCode = 'F-08'
/**
 * Where a dataset stands with the critics. A recording is measured first
 * (`measuring`, `measured`: the hard critics alone, for the prompt check) and
 * analysed when the operator starts it; rollouts are analysed at once.
 */
export type AnalysisStatus = 'measuring' | 'measured' | 'queued' | 'running' | 'done' | 'failed'
export type Lang = 'de' | 'en'

/**
 * A cell and its robot. `robotId` set: that robot is in the cell. `noRobot`:
 * said on purpose that it has none yet. Neither: undefined, nobody said.
 */
export interface Cell {
  id: string
  name: string
  location: string
  robotId: string | null
  noRobot: boolean
  active: boolean
  sortOrder: number
}

export type RobotStatus = 'in_service' | 'maintenance' | 'retired'
export const ROBOT_STATUSES: RobotStatus[] = ['in_service', 'maintenance', 'retired']
/** `disconnected`: there and intact, but not connected (e.g. publishes on no ROS topic) */
export type ComponentStatus = 'ok' | 'degraded' | 'faulty' | 'disconnected' | 'unknown'
export const COMPONENT_STATUSES: ComponentStatus[] = ['ok', 'degraded', 'faulty', 'disconnected', 'unknown']
/** What one save changed in a capability section, by component name (`details.sections` of `robot.updated`). */
export interface SectionChange {
  added: string[]
  updated: string[]
  removed: string[]
}
/** The capability sections every robot has, always the same and in this order. */
export type CapabilitySection = 'sensors' | 'actuators' | 'locomotion' | 'compute' | 'communication' | 'system'
export const CAPABILITY_SECTIONS: CapabilitySection[] = [
  'sensors',
  'actuators',
  'locomotion',
  'compute',
  'communication',
  'system',
]

export interface RobotPlatform {
  manufacturer: string
  model: string
  serialNumber: string
  productVersion: string
}

/** One component in a capability section: a sensor, an actuator, a Wi-Fi card, … */
export interface RobotComponent {
  /** made by the client for a new component, so a row keeps its identity before and after saving */
  id?: string
  name: string
  type: string
  quantity: number
  status: ComponentStatus
  note: string
}

export interface Robot {
  id: string
  technicalName: string
  personalName: string
  status: RobotStatus
  notes: string
  hasImage: boolean
  platform: RobotPlatform
  capabilities: Record<CapabilitySection, RobotComponent[]>
  /** the cell the robot is in; set on the cell, in the settings */
  cell: { id: string; name: string; location: string; active: boolean } | null
  /** components counted by status, over all sections */
  health: Record<ComponentStatus, number>
  createdAt: string
  updatedAt: string
}

export type RobotInput = Partial<
  Pick<Robot, 'technicalName' | 'personalName' | 'status' | 'notes'> & {
    platform: Partial<RobotPlatform>
    capabilities: Partial<Record<CapabilitySection, RobotComponent[]>>
  }
>

export interface Collection {
  id: string
  name: string
  customer: string
  description: string
  status: 'active' | 'archived'
  skillCount: number
}

/** The optional reference image of a variation (backend bucket `gym-variation`). */
export interface PlanVariationImage {
  /** storage reference of the backend (`"<driver>:<name>"`) */
  ref: string
  source: 'ai' | 'upload' | 'scene'
  prompt: string
  createdAt: string
}

export interface PlanVariation {
  label: string
  episodes: number
  /** English edit instruction the image is generated with */
  imagePrompt?: string
  image?: PlanVariationImage | null
  /** what a run sheet says about this episode beyond its label; GYM gives the values no meaning */
  fields?: PlanVariationField[]
}

/** One labelled value of a run sheet row: the column's name and the cell. */
export interface PlanVariationField {
  name: string
  value: string
}

/** A picture or a PDF of a skill's strategy. */
export interface StrategyFile {
  id: string
  ref: string
  name: string
  mime: string
  size: number
  createdAt: string
}

/**
 * The run sheet of a skill: a CSV a person keeps, one row per episode to
 * record. A guide for the operator; a block may take it over as its plan.
 */
export interface RunSheet {
  fileName: string
  /** header names in file order */
  columns: string[]
  /** one object per row, every value a string as in the file */
  rows: Record<string, string>[]
  /** the column whose value groups rows into plan steps, null = one step */
  groupBy: string | null
  importedAt: string
}

/** How a skill is to be recorded, as its people wrote it down. Optional in every part. */
export interface SkillStrategy {
  text: string
  files: StrategyFile[]
  runSheet: RunSheet | null
  updatedAt: string
}

export interface PlanStep {
  id: string
  title: string
  instructions: string
  variations: PlanVariation[]
  episodes: number
}

export interface RecordingPlan {
  summary: string
  sceneSetup: string[]
  randomizations: string[]
  steps: PlanStep[]
  source: 'ai' | 'fallback' | 'plain' | 'manual'
  createdAt: string
}

export interface RecordingProgress {
  completed: Record<string, number>
  currentStepId: string | null
  updatedAt: string
}

/** One indicator of the critics' recording-session profile. */
export interface ProfileIndicator {
  id: string
  group: string
  label: string
  unit: string
  value: number | null
  low?: number | null
  high?: number | null
  status: 'good' | 'warn' | 'bad' | 'info'
  what?: string
  so_what?: string
  action?: string
  display?: string
  display_extra?: string
}

export interface Switchable {
  flag: string
  effect: string
  episodes: number[]
  decides: number[]
  would_accept: number[]
  critics: string[]
}

/** One critic of a run: its configuration in the spec and what it raised. */
export interface CriticInfo {
  id: string
  kind: 'hard' | 'soft'
  weight: number
  gate: boolean
  gateFlags: string[]
  flags: { flag: string; count: number }[]
  lowEpisodes: number
  gatedEpisodes: number
}

/** GYM's compact summary of a lerobot-critics run (backend/src/lib/critics/summary.ts). */
export interface CriticsSummary {
  /** the shape of the summary; the backend rebuilds older ones from the stored report on read */
  version: number
  jobId: string
  datasetName: string
  specName: string
  robotType: string
  fps: number
  cameras: string[]
  episodes: number
  counts: { accept: number; review: number; reject: number }
  acceptRatePercent: number | null
  include: number[]
  review: number[]
  exclude: number[]
  ranges: Record<string, string>
  /** flag → episodes it was raised on; a muted flag is not in it */
  flagCounts: { flag: string; count: number }[]
  /** every flag the critics raised, before any override: what a person can downgrade */
  rawFlagCounts: { flag: string; count: number }[]
  /** what a person changed for this run: findings downgraded (review = a warning, ignore = informational), critics switched off */
  overrides: { ignoreFlags: string[]; reviewFlags: string[]; disabledCritics: string[] }
  /** the critics that judged the run, with their configuration and what they raised; the model as one group "vlm" */
  critics: CriticInfo[]
  datasetFlags: { flag: string; text: string }[]
  switchable: Switchable[]
  profileHeadline: string
  profile: ProfileIndicator[]
  medianDurationSeconds: number | null
  totalDurationSeconds: number
  acceptedDurationSeconds: number
  timingSeconds: number | null
  /** the soft critics answered on at least one episode */
  softCriticsRan: boolean
  /** the run asked for the vision-language model (from the spec) */
  softCriticsRequested: boolean
  /** the model was asked and did not answer: every verdict was decided without it */
  softCriticsFailed: boolean
  softCriticsFailedEpisodes: number
  softCriticsError: string | null
  createdAt: string
}

export interface FollowUpSuggestion {
  summary: string
  items: { title: string; episodes: number; reason: string }[]
  source: 'ai' | 'fallback'
  createdAt: string
}

export type Progress = Record<string, { done: number; total: number }>

export interface DatasetSummary {
  /** run facts the critics laid over the spec for this dataset's run, null when none were given */
  specOverrides: SpecOverrides | null
  id: string
  name: string
  episodeCount: number
  analysisStatus: AnalysisStatus
  analysisError: string | null
  progress: Progress | null
  criticsJobId: string | null
  analysis: CriticsSummary | null
  createdAt: string
}

export interface EpisodeTotals {
  episodes: number
  accepted: number
  review: number
  rejected: number
  selected: number
  /** sum of the episode durations of the datasets */
  recordedSeconds: number | null
}

/** One open/close of the recording step. */
export interface TeleopInterval {
  startedAt: string
  endedAt: string | null
}

/** A downtime of the cell, written down by the operator. */
export interface DowntimeEvent {
  id: string
  reason: string
  minutes: number
  at: string
  createdBy: string | null
  createdByName: string
  createdAt: string
}

/** The times of a block: what the tool saw and what the data holds. */
export interface BlockTimes {
  /** sum of the windows of the block: teleoperation in a recording, policy time in an evaluation */
  teleopMinutes: number
  /** a window is open right now */
  teleopRunning: boolean
  /** how often the recording step was opened */
  teleopSessions: number
  /** sum of the episode durations of the uploads */
  recordedSeconds: number | null
}

/** The times of a day, summed over its blocks and kept apart by what they measure. */
export interface DayTimes {
  teleopMinutes: number
  evaluationMinutes: number
  teleopRunning: boolean
  recordedSeconds: number | null
  downtimeMinutes: number
}

/** One stretch of work in a day protocol for one skill; the unit of the wizard. */
export interface BlockView {
  id: string
  tenantId: string
  dayProtocolId: string
  skillId: string
  kind: BlockKind
  policyId: string | null
  step: BlockStep
  targetEpisodes: number | null
  sceneImageRef: string | null
  sceneText: string
  sceneCapturedAt: string | null
  plan: RecordingPlan | null
  progress: RecordingProgress | null
  followUp: FollowUpSuggestion | null
  teleopStartedAt: string | null
  teleopEndedAt: string | null
  teleopIntervals: TeleopInterval[]
  createdBy: string | null
  closedAt: string | null
  createdAt: string
  updatedAt: string
  /** the day the block belongs to */
  date: string
  cell: { id: string; name: string; location: string }
  operatorName: string
  shareId: string
  skill: {
    id: string
    name: string
    status: SkillStatus
    taskDescription: string
    collectionId: string | null
    criticSpecName: string | null
  }
  policy: { id: string; name: string } | null
  hasSceneImage: boolean
  datasets: DatasetSummary[]
  totals: EpisodeTotals
  times: BlockTimes
}

/** The controlling record of a cell and day, with its blocks. */
export interface DayView {
  id: string
  tenantId: string
  cellId: string
  date: string
  operatorUserId: string | null
  operatorName: string
  downtime: DowntimeEvent[]
  notes: string
  shareId: string
  closedAt: string | null
  createdAt: string
  updatedAt: string
  cell: { id: string; name: string; location: string }
  blocks: BlockView[]
  /** episodes of the recording blocks */
  totals: EpisodeTotals
  /** rollouts of the evaluation blocks */
  evaluation: { blocks: number; episodes: number; accepted: number }
  times: DayTimes
  /** a block of the day is not closed */
  open: boolean
}

export interface PolicyRecord {
  id: string
  skillId: string
  name: string
  exportId: string | null
  notes: string
  /** where the policy lives outside GYM, http or https */
  externalUrl: string | null
  trainedAt: string | null
  createdAt: string
  updatedAt: string
}

/** One evaluation of a skill: an evaluation block with what came out of it. */
export interface EvaluationSummary {
  blockId: string
  dayProtocolId: string
  date: string
  cellName: string
  policyId: string | null
  policyName: string | null
  step: BlockStep
  targetEpisodes: number | null
  datasets: number
  /** rollouts the critics judged */
  episodes: number
  accepted: number
  review: number
  rejected: number
  successRatePercent: number | null
  minutes: number
}

export interface SkillListItem {
  id: string
  collectionId: string | null
  name: string
  taskDescription: string
  criticSpecName: string | null
  status: SkillStatus
  createdAt: string
  updatedAt: string
  collectionName: string | null
  recordingBlocks: number
  evaluationBlocks: number
  days: number
  firstDate: string | null
  lastDate: string | null
  datasets: number
  episodes: number
  acceptedEpisodes: number
  reviewEpisodes: number
  rejectedEpisodes: number
  selectedEpisodes: number
  policies: number
  lastEvaluation: { date: string; successRatePercent: number | null; policyName: string | null } | null
}

export interface ExportRecord {
  id: string
  skillId: string
  name: string
  selection: {
    datasets: {
      datasetId: string
      name: string
      criticsDatasetName: string
      criticsJobId: string | null
      episodeIndexes: number[]
      /** episode index → the prompt written instead of the recorded one */
      prompts?: Record<string, string>
    }[]
    episodes: number
  }
  createdAt: string
}

/** Paraphrases of one prompt, spread evenly over its episodes in a merged export. */
export interface PromptVariant {
  variants: string[]
  /** the prompt itself stays one of the variants; off: the variants substitute it */
  keepOriginal: boolean
}
/** prompt → its paraphrases */
export type PromptVariants = Record<string, PromptVariant>

export interface SkillView extends SkillListItem {
  promptVariants: PromptVariants
  blocks_: BlockView[]
  exports: ExportRecord[]
  policies_: PolicyRecord[]
  evaluations: EvaluationSummary[]
}

/** Why the critics did not accept an episode (from their selection.json). */
export interface EpisodeReason {
  cause: string
  why: string
  blocking: string[]
  gates: string[]
  details: string[]
}

export interface Episode {
  id: string
  datasetId: string
  index: number
  task: string
  frames: number | null
  durationSeconds: number | null
  verdict: EpisodeVerdict
  totalScore: number | null
  hardScore: number | null
  softScore: number | null
  flags: string[]
  reason: EpisodeReason | null
  criticScores: Record<string, number | null>
  error: string | null
  selected: boolean
  /** the human verdict over the critics': the review of a rollout, or the operator's word in the selection */
  humanVerdict: HumanVerdict | null
  failureCode: FailureCode | null
  reviewNote: string
  variationLabel: string | null
  reviewedBy: string | null
  reviewedByName: string
  reviewedAt: string | null
}

/** Run facts of one dataset the critics lay over the skill's spec for its run (the stored spec is untouched). */
export interface SpecOverrides {
  robot?: { active_arms?: ('left' | 'right')[] }
  task?: { instruction?: string; objects?: { name: string; description?: string; role?: string }[] }
}

/** The active arm as chosen in the Upload step; `auto` leaves it to the spec and the critics. */
export type ArmChoice = 'auto' | 'left' | 'right' | 'both'

export interface DatasetView extends DatasetSummary {
  skillId: string
  dayProtocolId: string
  blockId: string
  sourceFileName: string
  bytes: number
  criticsDatasetName: string
  criticSpecName: string | null
  selection: unknown | null
  hasReport: boolean
  episodes: Episode[]
}

/**
 * A dataset upload in progress. The zip goes up in chunks so that no single
 * request is long enough for a reverse proxy to cut it off; `received` says
 * which chunks the server already has, which is what resuming is built on.
 */
export interface DatasetUploadView {
  uploadId: string
  fileName: string
  bytes: number
  chunkSize: number
  chunkCount: number
  received: number[]
}

export interface SelectionDatasetInfo {
  id: string
  name: string
  dayProtocolId: string
  blockId: string
  episodeCount: number
  createdAt: string
  analysisStatus: AnalysisStatus
  analysis: CriticsSummary | null
  criticsDatasetName: string
  criticsJobId: string | null
  /** the day and the cell the dataset was recorded on: the selection spans every recording block of the skill */
  date: string
  cellName: string
  /** part of the skill's selection; taken out, none of its episodes are exported or counted, their ticks stay */
  included: boolean
}

/** A mean and a spread per axis (x, y, z) in centimetres over `n` positions. */
export interface AxisStat {
  n: number
  meanCm: [number, number, number]
  stdCm: [number, number, number]
}

/**
 * The position figures over the selected episodes of the datasets in the
 * selection: arithmetic over what the critics measured per episode.
 */
export interface SelectionMetrics {
  datasets: number
  episodes: number
  /** episodes among them whose report has no positions per arm (analysed before those were measured) */
  withoutPositions: number
  pick: { all: AxisStat | null; byArm: Record<string, AxisStat> }
  wristStart: Record<string, AxisStat>
  wristEnd: Record<string, AxisStat>
  /** left minus right, over the episodes where both have a position */
  deltaStart: AxisStat | null
  deltaEnd: AxisStat | null
}

/** One recording dataset of a skill as the Pre-Train tab lists it. */
export interface SelectionOverviewRow {
  dataset: {
    id: string
    name: string
    date: string
    cellName: string
    blockId: string
    dayProtocolId: string
    analysisStatus: AnalysisStatus
    included: boolean
    /** GYM holds the uploaded bytes: the dataset can be merged and exported unfiltered */
    stored: boolean
  }
  episodes: number
  /** ticked episodes, whether the dataset is part of the selection or not */
  selected: number
  accepted: number
  review: number
  rejected: number
  /** episodes of the dataset that still wait for a person */
  reviewPending: number
  /** the critics' own spread of the grasp positions (robust, horizontal) and of the start pose; null without */
  graspSpreadCm: number | null
  startPoseStdCm: number[] | null
}

export interface SelectionOverview {
  skillId: string
  datasets: SelectionOverviewRow[]
  /** over the datasets that are part of the selection */
  totals: Omit<EpisodeTotals, 'recordedSeconds'>
  metrics: SelectionMetrics
  /** the positions the figures are taken over, one entry per selected episode that has any, in metres */
  points: SelectionPoint[]
}

/** The positions the critics measured in one selected episode, with where the episode is from. */
export interface SelectionPoint {
  datasetId: string
  /** the episode's index in its dataset */
  episode: number
  /** the arm that grasped; null without one named */
  graspArm: string | null
  grasps: [number, number, number][]
  wrists: Record<string, { start: [number, number, number] | null; end: [number, number, number] | null }>
}

/** One decision of the operator in the selection: only the named fields change. */
export interface SelectionChange {
  episodeId: string
  selected?: boolean
  /** accept or reject over the critics' verdict; null gives the word back to the critics */
  humanVerdict?: HumanVerdict | null
}

export interface SelectionView {
  skillId: string
  datasets: { dataset: SelectionDatasetInfo; episodes: Episode[] }[]
  totals: EpisodeTotals
}

export interface AuditEntry {
  id: string
  skillId: string | null
  dayProtocolId: string | null
  blockId: string | null
  robotId?: string | null
  userId: string | null
  userName: string
  action: string
  details: Record<string, unknown>
  createdAt: string
}

export interface EvaluationTotals {
  blocks: number
  episodes: number
  accepted: number
  successRatePercent: number | null
  minutes: number
}

export interface KpiTotals {
  skills: number
  days: number
  blocks: number
  datasets: number
  episodes: number
  accepted: number
  review: number
  rejected: number
  selected: number
  acceptRatePercent: number | null
  teleopMinutes: number
  episodesPerHour: number | null
  recordedSeconds: number | null
  downtimeMinutes: number
  evaluation: EvaluationTotals
}

/** One run whose vision-language model did not answer. */
export interface VlmFailure {
  datasetId: string
  datasetName: string
  skillId: string
  skillName: string
  dayProtocolId: string
  blockId: string
  kind: BlockKind
  date: string
  cellName: string
  episodes: number
  failedEpisodes: number
  error: string | null
  /** when a person acknowledged the failure, and who; null while it is open */
  acknowledgedAt: string | null
  acknowledgedBy: string | null
}

export interface KpiResult {
  totals: KpiTotals
  perCell: (KpiTotals & { cellId: string; cellName: string })[]
  perDay: {
    date: string
    episodes: number
    accepted: number
    teleopMinutes: number
    evaluationMinutes: number
    days: number
    blocks: number
  }[]
  flags: { flag: string; count: number }[]
  /** runs the vision-language model failed on: judged by the hard critics alone */
  vlmFailures: VlmFailure[]
}

export interface AccessTokenInfo {
  token: string
  expiresAt: string
  paths: { capture: string; run: string }
}

export interface MobileState {
  blockId: string
  kind: BlockKind
  date: string
  cellName: string
  skillName: string
  operatorName: string
  step: BlockStep
  sceneText: string
  hasSceneImage: boolean
  sceneCapturedAt: string | null
  targetEpisodes: number | null
  plan: RecordingPlan | null
  progress: RecordingProgress | null
}

export interface PrintBlock {
  id: string
  kind: BlockKind
  skill: { name: string; taskDescription: string }
  policyName: string | null
  step: BlockStep
  targetEpisodes: number | null
  sceneText: string
  hasSceneImage: boolean
  plan: { summary: string; steps: { title: string; episodes: number }[] } | null
  teleopStartedAt: string | null
  teleopEndedAt: string | null
  minutes: number
  datasets: {
    name: string
    status: AnalysisStatus
    episodes: number
    accepted: number
    review: number
    rejected: number
    medianSeconds: number | null
    specName: string | null
  }[]
  totals: EpisodeTotals
}

export interface PrintView {
  shareId: string
  date: string
  cell: { name: string; location: string }
  operatorName: string
  blocks: PrintBlock[]
  times: DayTimes
  downtime: DowntimeEvent[]
  totals: EpisodeTotals
  evaluation: { blocks: number; episodes: number; accepted: number }
  notes: string
  closedAt: string | null
}

export interface AiInfo {
  provider: 'gemini' | 'framework' | 'none'
  enabled: boolean
  /** images of the plan variations need Gemini; they are optional everywhere */
  imageEnabled: boolean
  imageModel: string | null
}

export interface CriticsSpecInfo {
  name: string
  task?: string | null
  robot?: string | null
  /** names of the skills that are analysed with this spec (spec management only) */
  usedBy?: string[]
}

/** One spec with its text, as the spec editor reads and writes it. */
export interface CriticsSpecDetail {
  name: string
  task: string | null
  robot: string | null
  /** the stored spec as YAML: what the YAML view shows */
  yaml: string
  /** the same spec as an object: what the form reads */
  spec: Record<string, unknown>
  usedBy: string[]
}

/** One technical check of the critics with the parameters it runs with unless a spec says otherwise. */
export interface CriticsHardCriticInfo {
  id: string
  description: string
  default_params: Record<string, unknown>
}

export interface CriticsStatus {
  reachable: boolean
  url: string | null
  health: {
    status: string
    version: string
    gemini_key: boolean
    openrouter_key: boolean
  } | null
  specs: CriticsSpecInfo[]
  error?: string
}

// ---------------------------------------------------------------------------
// Evaluations: rollouts, human review, reports (backend/src/lib/gym/evaluations.ts)
// ---------------------------------------------------------------------------

/** A success rate with the uncertainty of its count. */
export interface RateFigure {
  rollouts: number
  succeeded: number
  ratePercent: number | null
  /** Wilson 95 % interval in percent */
  ci: { low: number; high: number } | null
}

export interface RolloutTotals extends RateFigure {
  /** the critics said "review" and no person decided yet */
  pendingReview: number
  /** rollouts with a human verdict */
  reviewed: number
  /** F-08 rollouts: shown, not charged to the policy */
  invalid: number
  attributableRatePercent: number | null
  /** failure code → failed rollouts carrying it */
  failures: Record<string, number>
}

/** One setting of the evaluation plan a rollout can belong to. */
export interface VariationOption {
  label: string
  stepId: string
  stepTitle: string
  episodes: number
}

/** What the vision-language model said about one rollout (backend `RolloutVlm`). */
export interface RolloutVlm {
  taskSuccess: boolean | null
  confidence: number | null
  summary: string
  indicators: { id: string; label: string; score: number | null; confidence: number | null; evidence: string; flags: string[] }[]
  anomalies: { type: string; timeSeconds: number | null; severity: string; description: string }[]
  flags: string[]
  model: string | null
  error: string | null
}

/** One rollout as the review and the report see it. */
export interface RolloutRow {
  episodeId: string
  blockId: string
  datasetId: string
  datasetName: string
  index: number
  /** 1-based position in the block */
  position: number
  variation: string | null
  variationSet: boolean
  criticsVerdict: EpisodeVerdict
  humanVerdict: HumanVerdict | null
  /** the effective verdict */
  verdict: EpisodeVerdict
  succeeded: boolean
  pendingReview: boolean
  failureCode: FailureCode | null
  invalid: boolean
  note: string
  durationSeconds: number | null
  flags: string[]
  criticsReason: string | null
  /** the model's word on this rollout; null when no soft critic ran */
  vlm: RolloutVlm | null
  /** the failure code the critics' findings point at, for the reviewer to take over; null for a success or without a lead */
  suggestedFailureCode: FailureCode | null
  reviewedByName: string
  reviewedAt: string | null
}

export interface RolloutsView {
  blockId: string
  variations: VariationOption[]
  failureCodes: { code: FailureCode; name: string }[]
  totals: RolloutTotals
  byVariation: ReportVariation[]
  rollouts: RolloutRow[]
}

export interface RolloutBlockInfo {
  blockId: string
  date: string
  cellName: string
  policyId: string | null
  policyName: string | null
  step: BlockStep
  targetEpisodes: number | null
  plan: RecordingPlan | null
  vlmFailedDatasets: number
}

/** One block (a checkpoint, a policy on a day) inside a report. */
export interface ReportBlock extends RolloutTotals, RolloutBlockInfo {
  label: string
  byVariation: Record<string, RateFigure>
}

export interface ReportVariation extends RateFigure {
  label: string
}

export interface ReportFailureMode {
  code: FailureCode
  name: string
  count: number
  perBlock: Record<string, number>
}

export interface EvaluationFigures {
  overall: RolloutTotals
  blocks: ReportBlock[]
  variations: ReportVariation[]
  failureModes: ReportFailureMode[]
  best: { blockId: string; label: string; ratePercent: number } | null
  topFailure: { code: FailureCode; name: string; count: number } | null
  rollouts: RolloutRow[]
}

/** The written parts of an evaluation report. */
export interface EvaluationReportSections {
  prompt: string
  successCriteria: string
  design: string
  reset: string
  caveats: string
  working: string
  needsReview: string
  nextSteps: string
}
export const REPORT_SECTION_KEYS: (keyof EvaluationReportSections)[] = [
  'prompt',
  'successCriteria',
  'design',
  'reset',
  'caveats',
  'working',
  'needsReview',
  'nextSteps',
]

export interface EvaluationReportRecord {
  id: string
  skillId: string
  name: string
  blockIds: string[]
  sections: EvaluationReportSections
  shareId: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface EvaluationReportView extends EvaluationReportRecord {
  skill: { id: string; name: string; taskDescription: string; collectionName: string | null }
  figures: EvaluationFigures
}

/** The public, read-only report. */
export interface PublicEvaluationReport {
  shareId: string
  name: string
  skill: { name: string; taskDescription: string; collectionName: string | null }
  sections: EvaluationReportSections
  figures: EvaluationFigures
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// The spec wizard (backend/src/lib/gym/spec-drafts.ts)
// ---------------------------------------------------------------------------

export type SpecDraftStep = 'sample' | 'analysis' | 'task' | 'robot' | 'workbench' | 'save'
export const SPEC_DRAFT_STEPS: SpecDraftStep[] = ['sample', 'analysis', 'task', 'robot', 'workbench', 'save']
export type SpecDraftRun = 'analysis' | 'test'
export type SpecDraftRunStatus = 'none' | 'queued' | 'running' | 'done' | 'failed'

/** One critics run over picked episodes of the sample: an added episode or a test. */
export interface SpecDraftExtraRun {
  jobId: string
  episodes: number[]
  status: SpecDraftRunStatus
  error?: string | null
  /** for a test run: the fingerprint of the spec it ran with */
  specHash?: string
  startedAt?: string
}

/** The state of the spec wizard: the sample, the two critics runs and the spec drafted so far. */
export interface SpecDraftView {
  id: string
  skillId: string | null
  skillName: string | null
  name: string
  purpose: BlockKind
  step: SpecDraftStep
  /** the episodes the analysis runs over, written like a print range: "0-9" or "1-3,6,8" */
  episodeSelection: string
  fileName: string
  bytes: number
  storageParts: string[]
  analysisJobId: string | null
  analysisStatus: SpecDraftRunStatus
  analysisError: string | null
  analysisProgress: Progress
  analysisCounts: Record<string, number> | null
  /** episodes the person picked by number, analysed on top of the sample */
  extraEpisodes: number[]
  /** the runs over those episodes until the next analysis takes them in */
  extraRuns: SpecDraftExtraRun[]
  /** the person's own word per episode index: what the spec should decide */
  judgments: Record<string, 'accept' | 'reject'>
  /** the spec as drafted so far, in the shape the critics take; null until the analysis seeded it */
  spec: Record<string, unknown> | null
  /** every test run, the latest last; a run may cover the analysed episodes or a single one */
  testRuns: SpecDraftExtraRun[]
  /** per episode, the fingerprint of the spec its latest test ran with (utils/episodes.ts specFingerprint) */
  testSpecs: Record<string, string>
  /** the open test run's status, else the latest's */
  testStatus: SpecDraftRunStatus
  testError: string | null
  testProgress: Progress
  testCounts: Record<string, number> | null
  createdAt: string
  updatedAt: string
}

/** One critic's result on one episode, as report.json carries it. */
export interface SampleCriticResult {
  id: string
  kind: 'hard' | 'soft'
  weight: number
  score: number | null
  gate: boolean
  gate_below: number
  gate_failed: boolean
  flags: string[]
  metrics: Record<string, unknown>
  evidence: string[]
  error: string | null
  /** for a success criterion: the words the model was asked (set by GYM from the spec of its run) */
  question?: string
}

export interface SampleEpisode {
  episode: number
  task: string
  length: number
  duration_s: number
  hard: SampleCriticResult[]
  soft: SampleCriticResult[]
  score: {
    hard_score: number | null
    soft_score: number | null
    total: number | null
    verdict: 'accept' | 'review' | 'reject'
    gates_failed: string[]
    flags: string[]
    reasons: string[]
  }
  keyframes: { grasp?: number[]; release?: number[] }
  error: string | null
}

/** The critics' report of a run over the sample (lerobot_critics.runner.DatasetReport), the part the wizard reads. */
/** One camera video of an episode of the sample; the window is set when the file holds several episodes. */
export interface SampleVideo {
  camera: string
  available: boolean
  from_s: number | null
  to_s: number | null
}

export interface SampleReport {
  dataset_name: string
  spec: Record<string, unknown>
  robot_type: string
  fps: number
  cameras: string[]
  n_episodes: number
  dataset_episodes?: number
  counts: Record<string, number>
  flag_counts: Record<string, number>
  dataset_flags: Record<string, string>
  metric_docs: Record<string, { what?: string; how?: string; unit?: string } | undefined>
  /** what every flag of the run means, in the critics' words (absent from older services) */
  flag_docs?: Record<string, string>
  episodes: SampleEpisode[]
}

/** What the guided tour shows of the tour skill (GET tour); every field but `skill` may be null. */
export interface TourMaterial {
  skill: { id: string; name: string; criticSpecName: string | null; status: string } | null
  /** the newest recording block with a dataset the critics finished, a closed one first */
  recordingBlockId: string | null
  /** the finished dataset of that block with the most episodes */
  datasetId: string | null
  exportId: string | null
  /** the newest policy, one trained from an export first */
  policyId: string | null
  /** the newest evaluation block with a finished dataset, one with reviewed rollouts first */
  evaluationBlockId: string | null
  reportId: string | null
  /** the skill names a spec that is stored, so the spec manager can open it */
  specStored: boolean
}

// ---------------------------------------------------------------------------
// Shortcuts and prompts (the data critics' /analyses, lib/gym/shortcuts.ts and prompts.ts)
// ---------------------------------------------------------------------------

/** A held-out-scene test of the critics: can the class be told from a signal for scenes never seen. */
export interface CueTest {
  accuracy: number
  /** share of the most frequent class */
  chance: number
  lift: number
  n: number
  classes: number
  scenes: number
  method: 'knn' | 'logistic'
  /** this test raised the finding it belongs to */
  cue?: boolean
}

/** what a finding over a selection rests on: the tests behind it, about the recordings or the evaluation's rollouts */
export interface ShortcutFinding {
  scope: 'recordings' | 'evaluation'
  /** "start_cue.arm", "background.prompt", "layout.position_cue", "evaluation", "counterfactual" */
  tests: string[]
}

export interface ShortcutAnalysis {
  n: number
  prompts: Record<string, number>
  arms: Record<string, number>
  scenes: { n: number; threshold: number; method: string; episodes_per_scene: Record<string, number> }
  background: { prompt: CueTest | null; arm: CueTest | null }
  start_cue: { arm: CueTest | null; prompt: CueTest | null }
  end_cue: { prompt: CueTest | null }
  counterfactual: {
    scenes: number
    scenes_multi_prompt: number
    episodes_with_partner: number
    prompts_per_scene: Record<string, number>
    answered_by_arm: number | null
  } | null
  layout: {
    cell_cm: number
    cells: number
    cells_multi_prompt: number
    episodes_in_shared_cells: number
    per_prompt: Record<string, { n: number; cells: number; std_cm: number[] }>
    position_cue: CueTest | null
  } | null
  evaluation: {
    n: number
    in_range: number
    distance_ratio_median: number
    predicted_arm: Record<string, number> | null
    arm_confidence: number | null
  } | null
  /** the critics' findings in their words */
  flags: Record<string, string>
  /** per flag: the tests it rests on and its scope */
  findings?: Record<string, ShortcutFinding>
}

export interface SelectionShortcuts {
  skillId: string
  datasetId: string | null
  datasets: number
  episodes: number
  /** selected episodes analysed before the critics wrote the features: left out */
  withoutFeatures: number
  evaluationEpisodes: number
  /** the evaluation datasets those rollouts come from */
  evaluationDatasets: { id: string; name: string; date: string; policyName: string | null; episodes: number }[]
  analysis: ShortcutAnalysis | null
}

export type PromptCheckStatus = 'ok' | 'propose' | 'review' | 'no_signature' | 'not_analysed'

export interface PromptCheckEpisode {
  episodeId: string
  index: number
  /** recorded */
  task: string
  promptOverride: string | null
  /** what it counts with now */
  prompt: string
  status: PromptCheckStatus
  proposed: string | null
  confidence: number | null
  votes: Record<string, number>
  group: number | null
  reason: 'few_examples' | 'look_alike' | 'uncertain' | null
}

export interface PromptCheckView {
  datasetId: string
  datasetName: string
  skillId: string
  mode: 'reference' | 'groups' | null
  candidates: string[]
  referencePrompts: Record<string, number>
  confusable: { prompts: string[]; rate: number }[]
  episodes: PromptCheckEpisode[]
  counts: Partial<Record<PromptCheckStatus, number>>
  variants: PromptVariants
  /** selected episodes per prompt over the skill's selection */
  selectionCounts: Record<string, number>
  analysisStatus: AnalysisStatus
  /** the prompts were corrected since the dataset's analysis: analysing it again judges with them */
  promptsChangedSinceAnalysis: boolean
  /** the skill's other recording datasets the check can compare against; `used` = compared against now */
  referenceDatasets: { id: string; name: string; episodes: number; reference: number; used: boolean }[]
}

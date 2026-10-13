/**
 * Evaluations: the rollouts of an evaluation block, their human review and
 * the figures an evaluation report is made of.
 *
 * The critics judge every rollout first (accept means the policy did the
 * task). A person then looks at the list and may overrule: "this rollout
 * succeeded", "this one did not", and says why it failed with a failure code
 * from a fixed catalogue. The **effective verdict** of a rollout is the human's
 * word where there is one, else the critics'. Every success rate in GYM is
 * counted on it (blocks, skills, key figures, reports).
 *
 * A rollout also belongs to a variation of the evaluation plan (the setting
 * it was run in). By default the rollouts follow the plan in order (the
 * operator walks the plan and presses "next"); the reviewer may say otherwise
 * per rollout. The report reads success per variation from it.
 *
 * The aggregation over blocks (`aggregate`) is pure and shared by the review
 * of one block and the report over many.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import {
  blocks,
  datasets,
  episodes,
  FAILURE_CODES,
  HUMAN_VERDICTS,
  INVALID_FAILURE_CODE,
  type BlockSelect,
  type EpisodeSelect,
  type EpisodeVerdict,
  type FailureCode,
  type HumanVerdict,
  type RecordingPlan,
} from "../../db/schema";
import type { CriticResult, EpisodeReport } from "../critics/client";
import { recordAudit, type Actor } from "./audit";
import { getBlockRow } from "./blocks";
import { ConflictError, InvalidInputError } from "./errors";
import { utcIso } from "./time";

/** `coalesce(human_verdict, verdict)`: what a rollout counts as. */
export const effectiveVerdictSql = sql`coalesce(${episodes.humanVerdict}, ${episodes.verdict})`;

export const effectiveVerdict = (e: Pick<EpisodeSelect, "verdict" | "humanVerdict">): EpisodeVerdict => e.humanVerdict ?? e.verdict;

/**
 * The failure catalogue with its English names. The UI translates the codes
 * itself; the names here are for the API, the MCP tools and the report data.
 */
export const FAILURE_CODE_NAMES: Record<FailureCode, string> = {
  "F-01": "Grasp failure",
  "F-02": "Localization / pose error",
  "F-03": "Place failure",
  "F-04": "Wrong object",
  "F-05": "Timeout, no progress",
  "F-06": "Collision",
  "F-07": "Unexpected motion after the task was complete",
  "F-08": "Hardware / infrastructure (not charged to the policy)",
};

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/** A success rate with the uncertainty that comes with its count. */
export interface RateFigure {
  rollouts: number;
  succeeded: number;
  /** succeeded / rollouts; null while there is nothing to count */
  ratePercent: number | null;
  /** the Wilson 95 % interval of the rate, in percent; null without rollouts */
  ci: { low: number; high: number } | null;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Wilson score interval at 95 %: the range of true success rates consistent
 * with `succeeded` of `rollouts`. It stays valid at the small counts a real
 * robot campaign produces (20 rollouts per checkpoint), where the normal
 * approximation does not. In percent, one decimal.
 */
export function wilson(succeeded: number, rollouts: number): { low: number; high: number } | null {
  if (rollouts <= 0) return null;
  const z = 1.959964;
  const p = succeeded / rollouts;
  const z2 = z * z;
  const denominator = 1 + z2 / rollouts;
  const centre = (p + z2 / (2 * rollouts)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / rollouts + z2 / (4 * rollouts * rollouts))) / denominator;
  return { low: round1(Math.max(0, centre - half) * 100), high: round1(Math.min(1, centre + half) * 100) };
}

export const rateOf = (succeeded: number, rollouts: number): RateFigure => ({
  rollouts,
  succeeded,
  ratePercent: rollouts ? round1((succeeded / rollouts) * 100) : null,
  ci: wilson(succeeded, rollouts),
});

// ---------------------------------------------------------------------------
// Variations of the evaluation plan
// ---------------------------------------------------------------------------

/** One setting of the evaluation plan a rollout can belong to. */
export interface VariationOption {
  /** the label the rollouts are grouped by; the step title is prefixed when labels repeat across steps */
  label: string;
  stepId: string;
  stepTitle: string;
  /** rollouts the plan asks for in this variation */
  episodes: number;
}

/** The variations of a plan in plan order, labels made unique across steps. */
export function variationOptions(plan: RecordingPlan | null | undefined): VariationOption[] {
  if (!plan) return [];
  const all = plan.steps.flatMap((s) => s.variations.map((x) => ({ label: x.label.trim(), stepId: s.id, stepTitle: s.title, episodes: Math.max(0, x.episodes) })));
  const counts = new Map<string, number>();
  for (const x of all) counts.set(x.label, (counts.get(x.label) ?? 0) + 1);
  const out: VariationOption[] = [];
  for (const x of all) {
    const label = (counts.get(x.label) ?? 0) > 1 && plan.steps.length > 1 ? `${x.stepTitle} · ${x.label}` : x.label;
    if (!label || out.some((o) => o.label === label)) continue;
    out.push({ ...x, label });
  }
  return out;
}

/**
 * Which variation the rollout at `position` (0-based, in plan order over the
 * block) ran in, when the plan was followed as written: the variations are
 * walked in order, each for its number of rollouts. Null beyond the plan.
 */
export function variationAt(options: VariationOption[], position: number): string | null {
  let seen = 0;
  for (const o of options) {
    seen += o.episodes;
    if (position < seen) return o.label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rollouts
// ---------------------------------------------------------------------------

/** One anomaly the vision-language model reported, with the time it saw it. */
export interface VlmAnomaly {
  type: string;
  timeSeconds: number | null;
  severity: string;
  description: string;
}

/**
 * What the vision-language model said about one rollout, from the soft
 * critics of the report: the task decision with its confidence and summary,
 * the success indicators of the spec with score and evidence, the anomalies.
 * `error` when the model was asked and did not answer; null when the run did
 * not ask for it at all.
 */
export interface RolloutVlm {
  /** true, false, or null when the model did not decide */
  taskSuccess: boolean | null;
  confidence: number | null;
  summary: string;
  indicators: { id: string; label: string; score: number | null; confidence: number | null; evidence: string; flags: string[] }[];
  anomalies: VlmAnomaly[];
  flags: string[];
  model: string | null;
  error: string | null;
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** The model's word on one episode of a report, or null when no soft critic ran on it. */
export function vlmOf(episode: EpisodeReport | undefined): RolloutVlm | null {
  const soft: CriticResult[] = episode?.soft ?? [];
  if (!soft.length) return null;
  const summary = soft.find((c) => c.id === "vlm.summary");
  const metrics = (summary?.metrics ?? {}) as Record<string, unknown>;
  const rawAnomalies = Array.isArray(metrics.anomalies) ? (metrics.anomalies as Record<string, unknown>[]) : [];
  const indicators = soft
    .filter((c) => c.id !== "vlm.summary")
    .map((c) => {
      const id = c.id.replace(/^vlm\./, "");
      return {
        id,
        label: id.replace(/_/g, " "),
        score: c.score,
        confidence: num((c.metrics as Record<string, unknown> | undefined)?.confidence),
        evidence: c.evidence?.[0] ?? "",
        flags: c.flags ?? [],
      };
    });
  const taskSuccess = typeof metrics.task_success === "boolean" ? metrics.task_success : null;
  return {
    taskSuccess,
    confidence: num(metrics.confidence),
    summary: summary?.evidence?.[0] ?? "",
    indicators,
    anomalies: rawAnomalies
      .filter((a) => a && typeof a === "object")
      .map((a) => ({ type: String(a.type ?? ""), timeSeconds: num(a.time_s), severity: String(a.severity ?? ""), description: String(a.description ?? "") })),
    flags: soft.flatMap((c) => c.flags ?? []),
    model: typeof metrics.model === "string" ? metrics.model : null,
    error: soft.find((c) => c.error)?.error ?? null,
  };
}

/** One rollout as the review and the report see it. */
export interface RolloutRow {
  episodeId: string;
  blockId: string;
  datasetId: string;
  datasetName: string;
  /** episode_index inside the dataset */
  index: number;
  /** 1-based position of the rollout in the block, over its datasets in upload order */
  position: number;
  /** the variation the rollout ran in: the reviewer's word, else the plan order; null when the plan does not say */
  variation: string | null;
  /** the reviewer set the variation by hand */
  variationSet: boolean;
  criticsVerdict: EpisodeVerdict;
  humanVerdict: HumanVerdict | null;
  /** the effective verdict */
  verdict: EpisodeVerdict;
  succeeded: boolean;
  /** the critics said "review" and no person has decided yet */
  pendingReview: boolean;
  failureCode: FailureCode | null;
  /** F-08: not the policy's fault, shown but not charged */
  invalid: boolean;
  note: string;
  durationSeconds: number | null;
  flags: string[];
  /** why the critics did not accept it */
  criticsReason: string | null;
  /** what the vision-language model said about this rollout; null when no soft critic ran */
  vlm: RolloutVlm | null;
  /** the failure code the critics' findings point at, for the reviewer to take over; null for a success or without a lead */
  suggestedFailureCode: FailureCode | null;
  reviewedByName: string;
  reviewedAt: string | null;
}

// ---------------------------------------------------------------------------
// A failure code from the findings
// ---------------------------------------------------------------------------

/** What an anomaly's type or description says, in the order the rules are tried. */
const FAILURE_PATTERNS: [FailureCode, RegExp][] = [
  ["F-08", /camera|video|hardware|infrastructure|sensor|network|e-?stop|emergency|human|person|intervention|intervene/],
  ["F-04", /wrong[ _-]?(object|cup|item|target)|distractor|incorrect (object|cup|item)/],
  ["F-05", /freeze|froze|frozen|stall|stuck|no[ _]progress|timeout|timed out|idle|never (moved|moves|reached|reaches)|did not move|stops? all motion|inactive/],
  ["F-06", /collision|collide|knock|bump|crash|hits?|hitting|struck|strikes?/],
  ["F-01", /grasp|grip|slip|drop|fumble|fell out|falls out|lost (the|its) (hold|object)/],
  ["F-03", /topple|tip|place|placing|placement|outside|border|unstable|not (in|inside|on) the (target|zone)|lying on its side/],
  ["F-02", /localiz|localis|pose|misalign|miss(es|ed)? the|overshoot|undershoot|offset|beside|next to/],
  ["F-07", /after (the )?(task|placement|placing|completion|success)|post[ -]task|second (cup|pick|attempt|object)/],
];

const codeOfText = (text: string): FailureCode | null => FAILURE_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? null;

/** The code an anomaly points at: its type first (the model's own label), then its description. */
const codeOfAnomaly = (a: VlmAnomaly): FailureCode | null => codeOfText(a.type.toLowerCase().replace(/_/g, " ")) ?? codeOfText(a.description.toLowerCase());

/** The code a critics' flag points at, when the model gave nothing to go on. */
const FLAG_CODES: [FailureCode, string[]][] = [
  ["F-08", ["HUMAN_IN_WORKSPACE", "CAMSTALL", "LAGGY", "STATE_FROZEN", "VIDEO_MISSING", "VIDEO_FRAME_MISMATCH", "TRACKERR", "LENGTH_MISMATCH", "EMPTY", "NAN_VALUES"]],
  ["F-04", ["VLM_CORRECT_OBJECT"]],
  ["F-01", ["NOGRASP", "VLM_GRASP_CENTERED", "UNFINISHED_GRASP"]],
  ["F-03", ["VLM_OBJECT_IN_TARGET"]],
  ["F-05", ["HESITATION", "TOO_SHORT", "TOO_LONG"]],
];

/**
 * The failure code the critics' findings point at, for the reviewer to take
 * over instead of classifying from scratch. The first thing that went wrong
 * decides: the model's anomalies in time order, scene resets and other
 * informational notes skipped, each read by its type before its description.
 * Infrastructure and a person in the loop (F-08) win whenever they occurred,
 * because such a rollout is not charged to the policy. Without an anomaly the
 * flags decide. Null for a rollout that succeeded, or when nothing points at a
 * cause; a suggestion is never written onto the rollout by itself.
 */
export function suggestFailureCode(row: Pick<RolloutRow, "succeeded" | "flags" | "vlm">): FailureCode | null {
  if (row.succeeded) return null;
  const anomalies = (row.vlm?.anomalies ?? []).filter((a) => a.severity !== "info" && a.type !== "scene_reset");
  const codes = [...anomalies].sort((a, b) => (a.timeSeconds ?? Infinity) - (b.timeSeconds ?? Infinity)).map(codeOfAnomaly);
  if (codes.includes("F-08")) return "F-08";
  const first = codes.find((c) => c != null);
  if (first) return first;
  const flags = new Set([...row.flags, ...(row.vlm?.flags ?? [])]);
  return FLAG_CODES.find(([, names]) => names.some((f) => flags.has(f)))?.[0] ?? null;
}

/** The block as the aggregation needs it. */
export interface RolloutBlockInfo {
  blockId: string;
  date: string;
  cellName: string;
  policyId: string | null;
  policyName: string | null;
  step: BlockSelect["step"];
  targetEpisodes: number | null;
  plan: RecordingPlan | null;
  /** datasets whose vision-language model did not answer */
  vlmFailedDatasets: number;
}

/** The episodes of the blocks' datasets as rollout rows, in plan order per block. */
export async function loadRollouts(blockRows: RolloutBlockInfo[]): Promise<RolloutRow[]> {
  if (!blockRows.length) return [];
  const blockIds = blockRows.map((b) => b.blockId);
  // the report is read for the model's per-episode word (soft critics); it is
  // mirrored as it is and never copied onto the episode rows
  const dsRows = await getDb()
    .select({ id: datasets.id, blockId: datasets.blockId, name: datasets.name, createdAt: datasets.createdAt, report: datasets.report })
    .from(datasets)
    .where(inArray(datasets.blockId, blockIds))
    .orderBy(asc(datasets.createdAt), asc(datasets.id));
  if (!dsRows.length) return [];
  const epRows = await getDb()
    .select()
    .from(episodes)
    .where(inArray(episodes.datasetId, dsRows.map((d) => d.id)))
    .orderBy(asc(episodes.index));
  const out: RolloutRow[] = [];
  for (const block of blockRows) {
    const options = variationOptions(block.plan);
    let position = 0;
    for (const ds of dsRows.filter((d) => d.blockId === block.blockId)) {
      const reported = new Map((ds.report?.episodes ?? []).map((r) => [r.episode, r]));
      for (const e of epRows.filter((x) => x.datasetId === ds.id)) {
        const verdict = effectiveVerdict(e);
        const succeeded = verdict === "accept";
        const vlm = vlmOf(reported.get(e.index));
        out.push({
          episodeId: e.id,
          blockId: block.blockId,
          datasetId: ds.id,
          datasetName: ds.name,
          index: e.index,
          position: position + 1,
          variation: e.variationLabel ?? variationAt(options, position),
          variationSet: e.variationLabel != null,
          criticsVerdict: e.verdict,
          humanVerdict: e.humanVerdict ?? null,
          verdict,
          succeeded,
          pendingReview: e.humanVerdict == null && e.verdict === "review",
          failureCode: e.failureCode ?? null,
          invalid: !succeeded && e.failureCode === INVALID_FAILURE_CODE,
          note: e.reviewNote ?? "",
          durationSeconds: e.durationSeconds,
          flags: e.flags ?? [],
          criticsReason: e.reason?.why ?? null,
          vlm,
          suggestedFailureCode: suggestFailureCode({ succeeded, flags: e.flags ?? [], vlm }),
          reviewedByName: e.reviewedByName ?? "",
          reviewedAt: utcIso(e.reviewedAt),
        });
        position += 1;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Success and failure figures of a set of rollouts. */
export interface RolloutTotals extends RateFigure {
  /** rollouts with the critics' "review" and no human decision */
  pendingReview: number;
  /** rollouts with a human verdict */
  reviewed: number;
  /** F-08 rollouts, shown but not charged to the policy */
  invalid: number;
  /** succeeded / (rollouts minus invalid); null while there is nothing to count */
  attributableRatePercent: number | null;
  /** failure code → failed rollouts carrying it */
  failures: Record<string, number>;
}

/** One block (a checkpoint, a policy on a day) inside the report. */
export interface ReportBlock extends RolloutTotals, RolloutBlockInfo {
  /** what the block is called in the report: the policy, then the date when policies repeat */
  label: string;
  /** success per variation inside this block, in plan order, unplanned ones last */
  byVariation: Record<string, RateFigure>;
}

export interface ReportVariation extends RateFigure {
  label: string;
}

export interface ReportFailureMode {
  code: FailureCode;
  name: string;
  count: number;
  /** blockId → failed rollouts with this code */
  perBlock: Record<string, number>;
}

/** Everything a report says in figures, computed from the rollouts. */
export interface EvaluationFigures {
  overall: RolloutTotals;
  blocks: ReportBlock[];
  /** the variations over all blocks, plan order first, then anything the reviewers named */
  variations: ReportVariation[];
  failureModes: ReportFailureMode[];
  /** the block with the highest success rate among those with a judged rollout */
  best: { blockId: string; label: string; ratePercent: number } | null;
  /** the most frequent failure code */
  topFailure: { code: FailureCode; name: string; count: number } | null;
  rollouts: RolloutRow[];
}

function totalsOf(rows: RolloutRow[]): RolloutTotals {
  const succeeded = rows.filter((r) => r.succeeded).length;
  const invalid = rows.filter((r) => r.invalid).length;
  const failures: Record<string, number> = {};
  for (const r of rows) if (!r.succeeded && r.failureCode) failures[r.failureCode] = (failures[r.failureCode] ?? 0) + 1;
  const charged = rows.length - invalid;
  return {
    ...rateOf(succeeded, rows.length),
    pendingReview: rows.filter((r) => r.pendingReview).length,
    reviewed: rows.filter((r) => r.humanVerdict != null).length,
    invalid,
    attributableRatePercent: charged ? round1((succeeded / charged) * 100) : null,
    failures,
  };
}

/** The labels a block's report uses: policy names, with the date when a policy appears twice. */
function blockLabels(blockRows: RolloutBlockInfo[]): Map<string, string> {
  const byPolicy = new Map<string, number>();
  for (const b of blockRows) {
    const key = b.policyName ?? "";
    byPolicy.set(key, (byPolicy.get(key) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const b of blockRows) {
    const policy = b.policyName ?? "";
    const repeated = (byPolicy.get(policy) ?? 0) > 1;
    out.set(b.blockId, policy ? (repeated ? `${policy} · ${b.date}` : policy) : `${b.date} · ${b.cellName}`);
  }
  return out;
}

/** The figures of the given blocks over their rollouts. Pure. */
export function aggregate(blockRows: RolloutBlockInfo[], rollouts: RolloutRow[]): EvaluationFigures {
  const labels = blockLabels(blockRows);
  // variations in plan order over all blocks, then the ones reviewers named
  const variationOrder: string[] = [];
  for (const b of blockRows) for (const o of variationOptions(b.plan)) if (!variationOrder.includes(o.label)) variationOrder.push(o.label);
  for (const r of rollouts) if (r.variation && !variationOrder.includes(r.variation)) variationOrder.push(r.variation);

  const blocks_ = blockRows.map((b) => {
    const rows = rollouts.filter((r) => r.blockId === b.blockId);
    const byVariation: Record<string, RateFigure> = {};
    for (const label of variationOrder) {
      const inVariation = rows.filter((r) => r.variation === label);
      if (inVariation.length) byVariation[label] = rateOf(inVariation.filter((r) => r.succeeded).length, inVariation.length);
    }
    return { ...b, ...totalsOf(rows), label: labels.get(b.blockId) ?? b.date, byVariation };
  });

  const variations = variationOrder
    .map((label) => {
      const rows = rollouts.filter((r) => r.variation === label);
      return { label, ...rateOf(rows.filter((r) => r.succeeded).length, rows.length) };
    })
    .filter((x) => x.rollouts > 0);

  const failureModes = FAILURE_CODES.map((code) => {
    const rows = rollouts.filter((r) => !r.succeeded && r.failureCode === code);
    const perBlock: Record<string, number> = {};
    for (const r of rows) perBlock[r.blockId] = (perBlock[r.blockId] ?? 0) + 1;
    return { code, name: FAILURE_CODE_NAMES[code], count: rows.length, perBlock };
  })
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count);

  const judged = blocks_.filter((b) => b.rollouts > 0);
  const best = judged.length
    ? judged.reduce((a, b) => ((b.ratePercent ?? -1) > (a.ratePercent ?? -1) ? b : a))
    : null;
  const top = failureModes[0];
  return {
    overall: totalsOf(rollouts),
    blocks: blocks_,
    variations,
    failureModes,
    best: best ? { blockId: best.blockId, label: best.label, ratePercent: best.ratePercent ?? 0 } : null,
    topFailure: top ? { code: top.code, name: top.name, count: top.count } : null,
    rollouts,
  };
}

// ---------------------------------------------------------------------------
// The blocks' info for the aggregation
// ---------------------------------------------------------------------------

export async function rolloutBlockInfos(blockRows: BlockSelect[]): Promise<RolloutBlockInfo[]> {
  if (!blockRows.length) return [];
  const ids = blockRows.map((b) => b.id);
  const ctx = await getDb()
    .select({
      blockId: blocks.id,
      date: sql<string>`(select date from gym_day_protocols where id = ${blocks.dayProtocolId})`,
      cellName: sql<string>`(select c.name from gym_day_protocols d join gym_cells c on c.id = d.cell_id where d.id = ${blocks.dayProtocolId})`,
      policyName: sql<string | null>`(select name from gym_policies where id = ${blocks.policyId})`,
    })
    .from(blocks)
    .where(inArray(blocks.id, ids));
  const vlm = await getDb()
    .select({ blockId: datasets.blockId, failed: sql<number>`count(*) filter (where (${datasets.analysis} ->> 'softCriticsFailed')::boolean)` })
    .from(datasets)
    .where(inArray(datasets.blockId, ids))
    .groupBy(datasets.blockId);
  const byId = new Map(ctx.map((c) => [c.blockId, c]));
  const vlmById = new Map(vlm.map((x) => [x.blockId, Number(x.failed)]));
  return blockRows.map((b) => {
    const c = byId.get(b.id);
    return {
      blockId: b.id,
      date: c?.date ?? "",
      cellName: c?.cellName ?? "",
      policyId: b.policyId,
      policyName: c?.policyName ?? null,
      step: b.step,
      targetEpisodes: b.targetEpisodes,
      plan: b.plan ?? null,
      vlmFailedDatasets: vlmById.get(b.id) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// The review of one block
// ---------------------------------------------------------------------------

/** The rollouts of one evaluation block with everything the reviewer needs. */
export interface RolloutsView {
  blockId: string;
  /** the settings of the evaluation plan a rollout can be put into */
  variations: VariationOption[];
  failureCodes: { code: FailureCode; name: string }[];
  totals: RolloutTotals;
  byVariation: ReportVariation[];
  rollouts: RolloutRow[];
}

const assertEvaluation = (block: BlockSelect) => {
  if (block.kind !== "evaluation") throw new ConflictError("Only the rollouts of an evaluation block are reviewed; a recording's episodes are picked in the selection");
};

export async function getRollouts(tenantId: string, blockId: string): Promise<RolloutsView> {
  const block = await getBlockRow(tenantId, blockId);
  assertEvaluation(block);
  const infos = await rolloutBlockInfos([block]);
  const figures = aggregate(infos, await loadRollouts(infos));
  return {
    blockId,
    variations: variationOptions(block.plan),
    failureCodes: FAILURE_CODES.map((code) => ({ code, name: FAILURE_CODE_NAMES[code] })),
    totals: figures.overall,
    byVariation: figures.variations,
    rollouts: figures.rollouts,
  };
}

export const reviewChangesSchema = v.object({
  changes: v.pipe(
    v.array(
      v.object({
        episodeId: v.pipe(v.string(), v.uuid()),
        /** accept or reject; null gives the word back to the critics */
        humanVerdict: v.optional(v.nullable(v.picklist(HUMAN_VERDICTS))),
        failureCode: v.optional(v.nullable(v.picklist(FAILURE_CODES))),
        note: v.optional(v.pipe(v.string(), v.maxLength(2000))),
        /** the plan variation the rollout ran in; null follows the plan order again */
        variationLabel: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(200)))),
      }),
    ),
    v.minLength(1),
    v.maxLength(5000),
  ),
});

/**
 * Save the reviewer's decisions on the rollouts of an evaluation block. Only
 * the fields a change names are written; a verdict or failure code stamps the
 * reviewer and the time.
 */
export async function reviewRollouts(tenantId: string, actor: Actor, blockId: string, input: unknown): Promise<RolloutsView> {
  const { changes } = v.parse(reviewChangesSchema, input);
  const block = await getBlockRow(tenantId, blockId);
  assertEvaluation(block);
  const dsIds = (await getDb().select({ id: datasets.id }).from(datasets).where(eq(datasets.blockId, blockId))).map((d) => d.id);
  const own = dsIds.length
    ? new Set(
        (
          await getDb()
            .select({ id: episodes.id })
            .from(episodes)
            .where(and(eq(episodes.tenantId, tenantId), inArray(episodes.datasetId, dsIds)))
        ).map((e) => e.id),
      )
    : new Set<string>();
  const unknown = changes.find((c) => !own.has(c.episodeId));
  if (unknown) throw new InvalidInputError(`Rollout ${unknown.episodeId} does not belong to this block`);

  const now = new Date().toISOString();
  let verdicts = 0;
  for (const c of changes) {
    const patch: Partial<EpisodeSelect> = {};
    if (c.humanVerdict !== undefined) patch.humanVerdict = c.humanVerdict;
    if (c.failureCode !== undefined) patch.failureCode = c.failureCode;
    if (c.note !== undefined) patch.reviewNote = c.note.trim();
    if (c.variationLabel !== undefined) patch.variationLabel = c.variationLabel || null;
    if (c.humanVerdict !== undefined || c.failureCode !== undefined) {
      patch.reviewedBy = actor.userId;
      patch.reviewedByName = actor.userName;
      patch.reviewedAt = now;
      verdicts += 1;
    }
    if (!Object.keys(patch).length) continue;
    await getDb().update(episodes).set(patch).where(eq(episodes.id, c.episodeId));
  }
  await recordAudit(tenantId, { skillId: block.skillId, dayProtocolId: block.dayProtocolId, blockId }, actor, "evaluation.reviewed", {
    rollouts: changes.length,
    verdicts,
    accepted: changes.filter((c) => c.humanVerdict === "accept").length,
    rejected: changes.filter((c) => c.humanVerdict === "reject").length,
  });
  return getRollouts(tenantId, blockId);
}

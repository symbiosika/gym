/**
 * What GYM keeps of a critics run.
 *
 * The full `report.json` and `selection.json` of the lerobot-critics service
 * are stored on the dataset as they are (they are the truth and the analyst
 * may want every metric). For the operator's screens and the key figures a
 * compact summary is derived here, and every episode becomes one row.
 */
import type { CriticsSelection, DatasetReport, ProfileIndicator, SelectionReason } from "./client";

/** Verdict of the critics for one episode; "unknown" only while no run finished. */
export const EPISODE_VERDICTS = ["accept", "review", "reject", "unknown"] as const;
export type EpisodeVerdict = (typeof EPISODE_VERDICTS)[number];

/** Why an episode was not accepted, from selection.json (`reasons[episode]`). */
export interface EpisodeReason {
  /** gate | flag | score | error; empty for accepted episodes */
  cause: string;
  /** one line, e.g. "gate failed: duplication (flag CAMSTALL, LAGGY)" */
  why: string;
  /** the flags that decided the verdict; muting them would give the episode back */
  blocking: string[];
  gates: string[];
  details: string[];
}

export interface EpisodeRow {
  index: number;
  task: string;
  frames: number;
  durationSeconds: number;
  verdict: EpisodeVerdict;
  totalScore: number | null;
  hardScore: number | null;
  softScore: number | null;
  flags: string[];
  reason: EpisodeReason | null;
  /** critic id → score, for the analyst */
  criticScores: Record<string, number | null>;
  error: string | null;
}

/** One critic of a run: its configuration in the spec and what it raised. */
export interface CriticInfo {
  /** the critic id (tracking_error, duplication, …) or "vlm" for the model as a whole */
  id: string;
  kind: "hard" | "soft";
  weight: number;
  /** the critic can reject an episode on its own (score gate or gate flags) */
  gate: boolean;
  gateFlags: string[];
  /** the flags this critic raised in the run, with the number of episodes */
  flags: { flag: string; count: number }[];
  /** episodes the critic scored below 0.5 */
  lowEpisodes: number;
  /** episodes the critic gated */
  gatedEpisodes: number;
}

/**
 * The shape of the summary. It is stored on the dataset when a run is
 * mirrored, so a dataset analysed before a change of the shape carries an
 * old one; `upgradeStaleSummaries` (lib/critics/sync.ts) rebuilds it from the
 * stored report the next time the dataset is read. Bump on every change.
 */
export const SUMMARY_VERSION = 2;

/** The compact analysis shown to the operator and used for the key figures. */
export interface CriticsSummary {
  /** SUMMARY_VERSION at the time the summary was built */
  version: number;
  jobId: string;
  datasetName: string;
  specName: string;
  robotType: string;
  fps: number;
  cameras: string[];
  episodes: number;
  counts: { accept: number; review: number; reject: number };
  acceptRatePercent: number | null;
  include: number[];
  review: number[];
  exclude: number[];
  ranges: Record<string, string>;
  /** flag → number of episodes it was raised on, most frequent first; a muted flag is not in it */
  flagCounts: { flag: string; count: number }[];
  /**
   * Every flag the critics raised, from their results and before any
   * override: what a person can downgrade. A muted flag is only here.
   */
  rawFlagCounts: { flag: string; count: number }[];
  /** what a person changed for this run: findings downgraded (review = a warning, ignore = informational), critics switched off */
  overrides: { ignoreFlags: string[]; reviewFlags: string[]; disabledCritics: string[] };
  /**
   * The critics that judged this run, as the spec configured them and with
   * what they raised: the rows a person switches a critic off from. The
   * soft critics appear as one group "vlm".
   */
  critics: CriticInfo[];
  /** run-level findings with their explanation (LOW_DIVERSITY, STATS_RANGE_INFLATED, …) */
  datasetFlags: { flag: string; text: string }[];
  /** what muting a finding would give back */
  switchable: CriticsSelection["switchable"];
  /** the recording-session profile: indicators with status and advice */
  profileHeadline: string;
  profile: ProfileIndicator[];
  medianDurationSeconds: number | null;
  totalDurationSeconds: number;
  acceptedDurationSeconds: number;
  timingSeconds: number | null;
  /** the soft critics answered on at least one episode */
  softCriticsRan: boolean;
  /**
   * The run asked for the vision-language model. Taken from the spec, so a
   * run that wanted the model and got nothing back can be told apart from one
   * that never wanted it (hard critics only).
   */
  softCriticsRequested: boolean;
  /**
   * The vision-language model was asked and did not answer. The job is "done"
   * for the critics service, because the hard critics carried it, but every
   * verdict of the run was decided without the model: no task success, no
   * anomalies, no human in the workspace. This must be visible, not silent.
   */
  softCriticsFailed: boolean;
  /** episodes the model failed on */
  softCriticsFailedEpisodes: number;
  /** the first error the model returned, e.g. "RuntimeError: GEMINI_API_KEY not set" */
  softCriticsError: string | null;
  createdAt: string;
}

/**
 * Did this run want the vision-language model? The spec is mirrored into the
 * report as it is, so the answer is in `spec.soft_critics`: enabled, with a
 * provider other than "none". A spec that says nothing counts as "not asked",
 * which is what the critics service does as well.
 */
function softCriticsWanted(spec: Record<string, unknown>): boolean {
  const soft = spec?.soft_critics as { enabled?: unknown; vlm?: { provider?: unknown } } | undefined;
  if (!soft || soft.enabled === false) return false;
  const provider = soft.vlm?.provider;
  return provider == null || provider === "" ? true : provider !== "none";
}

/** The soft-critic errors of a run: how many episodes and what the model said. */
function softCriticErrors(report: DatasetReport): { episodes: number; error: string | null } {
  let episodes = 0;
  let error: string | null = null;
  for (const e of report.episodes) {
    const failed = e.soft.find((s) => s.error);
    if (!failed) continue;
    episodes += 1;
    error ??= failed.error;
  }
  return { episodes, error };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Slim indicator: the series and the thresholds are dropped, the operator needs status and advice. */
function slimIndicator(i: ProfileIndicator): ProfileIndicator {
  const { series: _series, ...rest } = i as ProfileIndicator & { series?: unknown };
  return rest;
}

/** Every flag of every critic result, counted per episode: the findings as raised, overrides aside. */
function rawFlagCounts(report: DatasetReport): { flag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of report.episodes) {
    for (const flag of new Set([...e.hard, ...e.soft].flatMap((c) => c.flags ?? []))) counts.set(flag, (counts.get(flag) ?? 0) + 1);
  }
  return [...counts.entries()].map(([flag, count]) => ({ flag, count })).sort((a, b) => b.count - a.count || a.flag.localeCompare(b.flag));
}

/** The critics of the run: the spec's configuration joined with what each one raised. */
function criticInfos(report: DatasetReport): CriticInfo[] {
  const hardCfg = (report.spec?.hard_critics as { id: string; weight?: number; gate?: boolean; gate_flags?: string[]; enabled?: boolean }[] | undefined) ?? [];
  const soft = report.spec?.soft_critics as { enabled?: boolean; weight?: number } | undefined;
  const acc = new Map<string, CriticInfo>();
  const start = (id: string, kind: "hard" | "soft", weight: number, gate: boolean, gateFlags: string[]) => {
    if (!acc.has(id)) acc.set(id, { id, kind, weight, gate, gateFlags, flags: [], lowEpisodes: 0, gatedEpisodes: 0 });
    return acc.get(id)!;
  };
  for (const c of hardCfg) if (c.enabled !== false) start(c.id, "hard", c.weight ?? 1, !!c.gate || !!c.gate_flags?.length, c.gate_flags ?? []);
  const flagCounts = new Map<string, Map<string, number>>();
  for (const e of report.episodes) {
    for (const r of e.hard) {
      const info = start(r.id, "hard", r.weight, r.gate, acc.get(r.id)?.gateFlags ?? []);
      if (r.score != null && r.score < 0.5) info.lowEpisodes += 1;
      if (r.gate_failed) info.gatedEpisodes += 1;
      const m = flagCounts.get(r.id) ?? new Map<string, number>();
      for (const f of new Set(r.flags ?? [])) m.set(f, (m.get(f) ?? 0) + 1);
      flagCounts.set(r.id, m);
    }
    if (e.soft.length) {
      const info = start("vlm", "soft", soft?.weight ?? 1, e.soft.some((r) => r.gate), []);
      if (e.soft.some((r) => r.gate_failed)) info.gatedEpisodes += 1;
      if (e.soft.some((r) => r.weight > 0 && r.score != null && r.score < 0.5)) info.lowEpisodes += 1;
      const m = flagCounts.get("vlm") ?? new Map<string, number>();
      for (const f of new Set(e.soft.flatMap((r) => r.flags ?? []))) m.set(f, (m.get(f) ?? 0) + 1);
      flagCounts.set("vlm", m);
    }
  }
  return [...acc.values()].map((info) => ({
    ...info,
    flags: [...(flagCounts.get(info.id)?.entries() ?? [])].map(([flag, count]) => ({ flag, count })).sort((a, b) => b.count - a.count),
  }));
}

export function summarize(jobId: string, report: DatasetReport, selection: CriticsSelection): CriticsSummary {
  const counts = {
    accept: report.counts.accept ?? report.include.length,
    review: report.counts.review ?? report.review.length,
    reject: report.counts.reject ?? report.exclude.length,
  };
  const durations = report.episodes.map((e) => e.duration_s).filter((d) => Number.isFinite(d));
  const accepted = new Set(report.include);
  const ran = report.episodes.some((e) => e.soft.some((s) => s.score != null));
  const softErrors = softCriticErrors(report);
  const requested = softCriticsWanted(report.spec) || softErrors.episodes > 0 || ran;
  return {
    version: SUMMARY_VERSION,
    jobId,
    datasetName: report.dataset_name,
    specName: report.spec_name,
    robotType: report.robot_type,
    fps: report.fps,
    cameras: report.cameras,
    episodes: report.n_episodes,
    counts,
    acceptRatePercent: report.n_episodes ? round1((counts.accept / report.n_episodes) * 100) : null,
    include: report.include,
    review: report.review,
    exclude: report.exclude,
    ranges: selection.ranges ?? {},
    flagCounts: Object.entries(report.flag_counts)
      .map(([flag, count]) => ({ flag, count }))
      .sort((a, b) => b.count - a.count),
    rawFlagCounts: rawFlagCounts(report),
    overrides: {
      ignoreFlags: [...(report.overrides?.ignore_flags ?? [])],
      reviewFlags: [...(report.overrides?.review_flags ?? [])],
      disabledCritics: [...(report.overrides?.disabled_critics ?? [])],
    },
    critics: criticInfos(report),
    datasetFlags: Object.entries(report.dataset_flags).map(([flag, text]) => ({ flag, text })),
    switchable: selection.switchable ?? [],
    profileHeadline: report.session_profile?.headline ?? "",
    profile: (report.session_profile?.indicators ?? []).map(slimIndicator),
    medianDurationSeconds: median(durations) == null ? null : round1(median(durations)!),
    totalDurationSeconds: round1(durations.reduce((a, b) => a + b, 0)),
    acceptedDurationSeconds: round1(report.episodes.filter((e) => accepted.has(e.episode)).reduce((a, e) => a + e.duration_s, 0)),
    timingSeconds: report.timing_s?.total_s == null ? null : round1(report.timing_s.total_s),
    softCriticsRan: ran,
    softCriticsRequested: requested,
    // the model was wanted and never answered: either it errored, or it was
    // requested and produced nothing at all on any episode
    softCriticsFailed: requested && !ran && (softErrors.episodes > 0 || report.n_episodes > 0),
    softCriticsFailedEpisodes: softErrors.episodes,
    softCriticsError: softErrors.error,
    createdAt: report.created_at,
  };
}

const toReason = (r: SelectionReason | undefined): EpisodeReason | null =>
  r ? { cause: r.cause, why: r.why, blocking: r.blocking, gates: r.gates, details: r.reasons } : null;

export function episodeRows(report: DatasetReport, selection: CriticsSelection): EpisodeRow[] {
  return report.episodes
    .map((e) => ({
      index: e.episode,
      task: e.task,
      frames: e.length,
      durationSeconds: round1(e.duration_s),
      verdict: e.score.verdict,
      totalScore: e.score.total,
      hardScore: e.score.hard_score,
      softScore: e.score.soft_score,
      flags: e.score.flags,
      reason: toReason(selection.reasons?.[String(e.episode)]),
      criticScores: Object.fromEntries([...e.hard, ...e.soft].filter((c) => c.weight > 0 || c.kind === "soft").map((c) => [c.id, c.score])),
      // the episode's own error first, else the one the vision-language model
      // returned: without this a failed model leaves no trace on the episode
      error: e.error ?? e.soft.find((s) => s.error)?.error ?? null,
    }))
    .sort((a, b) => a.index - b.index);
}

/** Whether an episode goes into the export by default: only rejected episodes start deselected. */
export const defaultSelected = (verdict: EpisodeVerdict): boolean => verdict !== "reject";

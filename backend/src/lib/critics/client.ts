/**
 * HTTP client for the data critics, the Python service in `critics/` of this
 * repository. It runs next to the app in the same compose stack and is
 * reached over the internal network, so it is a part of GYM, not an
 * integration that may be missing.
 *
 * The critics are the single source of truth for dataset analysis: they take
 * a zipped LeRobot dataset, run the hard critics (kinematics, video) and the
 * soft critics (a vision-language model) over every episode and return
 * scores, verdicts (accept / review / reject), flags and the
 * recording-session profile. GYM never analyses data itself; it uploads,
 * starts a job, mirrors the result and shows it to the operator.
 *
 * Configuration:
 *   CRITICS_URL      base URL, defaults to the compose service name in the
 *                    container and to the port of docker-compose.critics.yml
 *                    when the API runs on the host with `bun run dev`
 *   CRITICS_API_KEY  optional; sent as X-API-Key when the service is protected
 */
import log from "@framework/lib/log";

/** Where the critics run when nothing is configured: the dev compose service on the host. */
const DEFAULT_CRITICS_URL = "http://localhost:8080";

export class CriticsError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "CriticsError";
  }
}

/** GET /health */
export interface CriticsHealth {
  status: string;
  auth: boolean;
  version: string;
  gemini_key: boolean;
  openrouter_key: boolean;
}

/** POST /upload and GET /datasets rows */
export interface CriticsDatasetSummary {
  name: string;
  path: string;
  robot_type?: string | null;
  episodes?: number | null;
  fps?: number | null;
  cameras?: string[];
  task?: string | null;
  version?: string | null;
  error?: string;
}

export type CriticsJobStatus = "queued" | "preparing" | "running" | "done" | "failed";

/** GET /jobs/{id} */
export interface CriticsJob {
  job_id: string;
  status: CriticsJobStatus;
  dataset: string;
  spec_name?: string;
  created_at?: string;
  updated_at?: string;
  progress?: Record<string, { done: number; total: number }>;
  counts?: Record<string, number>;
  include?: number[];
  review?: number[];
  exclude?: number[];
  n_episodes?: number;
  timing_s?: Record<string, number>;
  error?: string;
}

/** GET /critics rows: one hard critic with the parameters it runs with unless a spec says otherwise. */
export interface CriticsHardCriticInfo {
  id: string;
  description: string;
  default_params: Record<string, unknown>;
}

/** GET /specs rows */
export interface CriticsSpecInfo {
  name: string;
  task?: string | null;
  robot?: string | null;
  error?: string;
}

/**
 * What the episodes of a run are: demonstrations judged as training data, or
 * rollouts of a trained policy judged on the outcome of the task. The critics
 * take it per job (`purpose` of POST /jobs) and apply it over the skill's spec,
 * so one spec serves both kinds of block.
 */
export type CriticsPurpose = "recording" | "evaluation";

export interface CriticsRunOptions {
  episodes?: number[] | null;
  /** look at no more than this many episodes, spread evenly over the dataset (a sample) */
  max_episodes?: number | null;
  run_hard?: boolean;
  run_soft?: boolean;
  contact_sheets?: boolean;
  workers?: number;
}

/** One critic's result inside an episode of report.json (lerobot_critics.critics.base.CriticResult). */
export interface CriticResult {
  id: string;
  kind: "hard" | "soft";
  weight: number;
  score: number | null;
  gate: boolean;
  gate_below: number;
  gate_failed: boolean;
  flags: string[];
  metrics: Record<string, unknown>;
  evidence: string[];
  error: string | null;
}

/** lerobot_critics.scoring.EpisodeScore */
export interface EpisodeScore {
  episode: number;
  hard_score: number | null;
  soft_score: number | null;
  total: number | null;
  verdict: "accept" | "review" | "reject";
  gates_failed: string[];
  flags: string[];
  reasons: string[];
}

/** lerobot_critics.runner.EpisodeReport */
export interface EpisodeReport {
  episode: number;
  task: string;
  length: number;
  duration_s: number;
  hard: CriticResult[];
  soft: CriticResult[];
  score: EpisodeScore;
  keyframes: Record<string, unknown>;
  error: string | null;
}

/** One indicator of the recording-session profile (lerobot_critics.session_profile). */
export interface ProfileIndicator {
  id: string;
  group: string;
  label: string;
  unit: string;
  value: number | null;
  low?: number | null;
  high?: number | null;
  status: "good" | "warn" | "bad" | "info";
  what?: string;
  so_what?: string;
  action?: string;
  display?: string;
  display_extra?: string;
  [key: string]: unknown;
}

export interface SessionProfile {
  groups: { id: string; title: string; intro: string }[];
  indicators: ProfileIndicator[];
  cameras?: unknown[];
  grasp_points?: unknown;
  status_counts?: Record<string, number>;
  headline?: string;
  error?: string;
}

/** lerobot_critics.runner.DatasetReport (report.json) */
export interface DatasetReport {
  dataset: string;
  dataset_name: string;
  spec_name: string;
  spec: Record<string, unknown>;
  created_at: string;
  robot_type: string;
  fps: number;
  cameras: string[];
  /** the episodes this run looked at */
  n_episodes: number;
  /** the episodes the dataset holds; more than n_episodes for a sample (absent from older services) */
  dataset_episodes?: number;
  counts: Record<string, number>;
  include: number[];
  review: number[];
  exclude: number[];
  flag_counts: Record<string, number>;
  dataset_stats: Record<string, unknown>;
  dataset_summaries: Record<string, Record<string, unknown>>;
  dataset_flags: Record<string, string>;
  metric_docs: Record<string, unknown>;
  session_profile: SessionProfile;
  timing_s: Record<string, number>;
  /** findings a person downgraded after the run (PUT /jobs/{id}/overrides); absent on an untouched run */
  overrides?: { ignore_flags?: string[]; review_flags?: string[]; disabled_critics?: string[] };
  episodes: EpisodeReport[];
}

/** PUT /jobs/{id}/overrides: the findings to downgrade for one run. Replaces the previous overrides. */
export interface CriticsOverrides {
  /** informational: as if never raised */
  ignore_flags: string[];
  /** a warning: caps the episode at review instead of rejecting it */
  review_flags: string[];
  /** critics that do not apply to this dataset (ids such as tracking_error, or vlm): no weight, no gate, no flags */
  disabled_critics: string[];
}

/** selection.json (lerobot_critics.report.build_selection) */
export interface SelectionReason {
  verdict: "accept" | "review" | "reject";
  total: number | null;
  cause: "" | "gate" | "flag" | "score" | "error";
  why: string;
  blocking: string[];
  gates: string[];
  flags: string[];
  reasons: string[];
}

export interface CriticsSelection {
  dataset: string;
  spec: string;
  include: number[];
  review: number[];
  exclude: number[];
  ranges: Record<string, string>;
  include_with_review: number[];
  reasons: Record<string, SelectionReason>;
  switchable: { flag: string; effect: string; episodes: number[]; decides: number[]; would_accept: number[]; critics: string[] }[];
}

/** What to merge: per source dataset the episodes of it that were selected. */
export interface MergeRequest {
  /** per source a link to the zip (`dataset`) or one link per part of it (`dataset_parts`) */
  sources: (({ dataset: string } | { dataset_parts: string[] }) & { episodes: number[]; name?: string })[];
  name: string;
  with_videos?: boolean;
}

export const criticsBaseUrl = (): string => process.env.CRITICS_URL?.trim().replace(/\/+$/, "") || DEFAULT_CRITICS_URL;

const headers = (extra: Record<string, string> = {}): Record<string, string> => {
  const key = process.env.CRITICS_API_KEY?.trim();
  return key ? { "X-API-Key": key, ...extra } : extra;
};

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${criticsBaseUrl()}${path}`, { ...init, headers: headers(init.headers as Record<string, string>) });
  } catch (error) {
    throw new CriticsError(`Data critics service unreachable: ${error instanceof Error ? error.message : String(error)}`, 503);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      if (parsed.detail) detail = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
    } catch {
      /* plain text */
    }
    throw new CriticsError(`Data critics ${res.status}: ${detail || res.statusText}`, res.status);
  }
  return res;
}

const json = async <T>(path: string, init: RequestInit = {}): Promise<T> => (await request(path, init)).json() as Promise<T>;

export const criticsClient = {
  health: () => json<CriticsHealth>("/health"),
  specs: () => json<CriticsSpecInfo[]>("/specs"),
  /** The hard critics the service knows, with their default parameters. */
  hardCritics: () => json<CriticsHardCriticInfo[]>("/critics"),

  /** One stored spec, as the service holds it (its YAML read back as an object). */
  spec: (name: string) => json<Record<string, unknown>>(`/specs/${encodeURIComponent(name)}`),

  /** Store a spec under `name`; an existing spec of that name is replaced. The service validates the spec. */
  putSpec: (name: string, spec: Record<string, unknown>) =>
    json<{ name: string }>(`/specs/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
    }),

  /** Remove a stored spec. Skills that name it fall back to the automatic spec on their next upload. */
  async deleteSpec(name: string): Promise<void> {
    await request(`/specs/${encodeURIComponent(name)}`, { method: "DELETE" });
  },
  datasets: () => json<CriticsDatasetSummary[]>("/datasets"),

  /** Upload a zipped LeRobot dataset; the service extracts it under its data directory as `name`. */
  async upload(zip: Blob, fileName: string, name: string): Promise<CriticsDatasetSummary> {
    const form = new FormData();
    form.append("file", zip, fileName);
    return json<CriticsDatasetSummary>(`/upload?name=${encodeURIComponent(name)}`, { method: "POST", body: form });
  },

  /** Start an analysis; `spec` is a stored spec name, an inline spec or null for an auto-generated one. */
  async createJob(
    /** a link to the zip, or one link per part of it in order (lib/gym/datasets.ts, `datasetLinks`) */
    source: { dataset: string } | { dataset_parts: string[] },
    spec: string | Record<string, unknown> | null,
    options: CriticsRunOptions = {},
    purpose: CriticsPurpose = "recording",
    /** with spec null: false keeps the generated spec with the job instead of storing it as "<dataset>-auto" */
    storeAutoSpec = true,
  ): Promise<{ job_id: string; status: string }> {
    return json(`/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...source, spec, purpose, options, ...(storeAutoSpec ? {} : { store_auto_spec: false }) }),
    });
  },

  job: (jobId: string) => json<CriticsJob>(`/jobs/${encodeURIComponent(jobId)}`),

  /**
   * Downgrade findings of a finished run and let the critics replay its
   * verdicts. The critic results stay what the run found; the report carries
   * the overrides, and two empty lists restore the run as it was scored.
   */
  setOverrides: (jobId: string, overrides: CriticsOverrides) =>
    json<{ job_id: string; overrides: CriticsOverrides; counts: Record<string, number> }>(`/jobs/${encodeURIComponent(jobId)}/overrides`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(overrides),
    }),
  report: (jobId: string) => json<DatasetReport>(`/jobs/${encodeURIComponent(jobId)}/report`),
  selection: (jobId: string) => json<CriticsSelection>(`/jobs/${encodeURIComponent(jobId)}/selection`),

  /** The run as AI-readable Markdown (summary | flagged | full). */
  async markdown(jobId: string, detail: "summary" | "flagged" | "full" = "summary"): Promise<string> {
    return (await request(`/jobs/${encodeURIComponent(jobId)}/markdown?detail=${detail}`)).text();
  },

  /** The visual report as one self-contained HTML page. */
  async reportHtml(jobId: string, top = 5): Promise<string> {
    return (await request(`/jobs/${encodeURIComponent(jobId)}/report.html?top=${top}`)).text();
  },

  /**
   * The selected episodes of several datasets as **one** LeRobot dataset.
   * The critics service holds the uploaded data, so it does the merging: the
   * episodes are renumbered without gaps, the task tables are joined and the
   * result is a v2.1 dataset that goes straight into training.
   */
  merge: (body: MergeRequest) =>
    request(`/merge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),

  /** Any artifact of a job (contact sheets, composites, csv), streamed through. */
  file: (jobId: string, path: string) => request(`/jobs/${encodeURIComponent(jobId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`),

  async deleteJob(jobId: string): Promise<void> {
    await request(`/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch((error) => {
      log.error(`gym: could not delete critics job ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  },
};

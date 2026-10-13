/**
 * A stand-in for the lerobot-critics service in tests. Speaks the subset of
 * the REST API GYM uses and answers with the fixtures of a real run
 * (fixtures/report.json, fixtures/selection.json: four synthetic episodes,
 * two accepted, two rejected). A job is "running" on its first status read
 * and "done" afterwards, so the sync path from queued to done is exercised.
 *
 * Like the real service it does not take the bytes of a dataset: a job and a
 * merge name their source by a temporary URL, and this stand-in fetches it the
 * way the service does. What it fetched is recorded in `fetched`, so a test can
 * see that the link GYM handed over really leads to the stored dataset.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const FIXTURES = path.join(import.meta.dir, "fixtures");
export const fixtureReport = () => JSON.parse(readFileSync(path.join(FIXTURES, "report.json"), "utf8"));
export const fixtureSelection = () => JSON.parse(readFileSync(path.join(FIXTURES, "selection.json"), "utf8"));

export interface MergeCall {
  name: string;
  /** a link to the zip, or (`dataset_parts`) one link per part of it in order */
  sources: { dataset?: string; dataset_parts?: string[]; episodes: number[]; name?: string }[];
}

/** What the stand-in pulled from a link GYM handed it. */
export interface FetchedSource {
  url: string;
  status: number;
  bytes: number;
  /** the first four bytes, so a test can see it really is a zip */
  head: number[];
}

export interface FakeCritics {
  url: string;
  uploads: { name: string; bytes: number; fileName: string }[];
  /** every temporary link this stand-in followed, oldest first */
  fetched: FetchedSource[];
  /** `dataset` is the link to the zip, or the first of `parts` for a dataset stored in parts */
  jobs: { id: string; dataset: string; parts: string[] | null; spec: unknown; purpose: unknown; options: unknown; reads: number; overrides: { ignore_flags: string[]; review_flags: string[]; disabled_critics: string[] } }[];
  merges: MergeCall[];
  deleted: string[];
  /** specs stored through PUT /specs/{name}, next to the built-in one */
  specs: { name: string; spec: Record<string, unknown> }[];
  /** the next /merge call answers with this status and message instead of a zip */
  failMergeWith: { status: number; detail: string } | null;
  stop: () => void;
}

export function startFakeCritics(): FakeCritics {
  const state: FakeCritics = { url: "", uploads: [], fetched: [], jobs: [], merges: [], deleted: [], specs: [], failMergeWith: null, stop: () => undefined };

  /**
   * Follow a source the way the service does. A source that is not a link is
   * a local name and is left alone, as it is for the CLI.
   */
  const follow = async (source: string): Promise<void> => {
    if (!/^https?:\/\//.test(source)) return;
    try {
      const res = await fetch(source);
      const body = res.ok ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array();
      state.fetched.push({ url: source, status: res.status, bytes: body.byteLength, head: [...body.slice(0, 4)] });
    } catch {
      state.fetched.push({ url: source, status: 0, bytes: 0, head: [] });
    }
  };
  const report = fixtureReport();
  const selection = fixtureSelection();
  /**
   * The fixtures replayed with a job's overrides, the way the real service does
   * it (lerobot_critics.selection.apply_overrides): an episode whose blocking
   * flags are all downgraded is no longer rejected; it is accepted when they
   * are all muted, review when one of them is a warning. A disabled critic
   * counts as every flag it raised being muted.
   */
  const replayed = (job: FakeCritics["jobs"][number]) => {
    const disabled = new Set(job.overrides.disabled_critics);
    const ignore = new Set(job.overrides.ignore_flags);
    const review = new Set(job.overrides.review_flags);
    const rep = structuredClone(report) as typeof report;
    for (const e of rep.episodes as { hard: { id: string; flags: string[] }[] }[]) {
      for (const c of e.hard) if (disabled.has(c.id)) for (const f of c.flags) ignore.add(f);
    }
    const sel = structuredClone(selection) as typeof selection;
    const reasons = sel.reasons as Record<string, { verdict: string; cause: string; why: string; blocking: string[]; flags: string[] }>;
    for (const e of rep.episodes as { episode: number; score: { verdict: string; flags: string[]; gates_failed: string[] } }[]) {
      const r = reasons[String(e.episode)];
      e.score.flags = e.score.flags.filter((f: string) => !ignore.has(f));
      if (!r || !r.blocking.length || !r.blocking.every((f) => ignore.has(f) || review.has(f))) continue;
      const capped = r.blocking.filter((f) => review.has(f));
      e.score.verdict = capped.length ? "review" : "accept";
      e.score.gates_failed = [];
      if (capped.length) Object.assign(r, { verdict: "review", cause: "flag", why: `flag ${capped.join(", ")} caps it at review`, blocking: capped, gates: [] });
      else delete reasons[String(e.episode)];
    }
    const by = (v: string) => rep.episodes.filter((e: { score: { verdict: string } }) => e.score.verdict === v).map((e: { episode: number }) => e.episode);
    rep.include = sel.include = by("accept");
    rep.review = sel.review = by("review");
    rep.exclude = sel.exclude = by("reject");
    rep.counts = { accept: rep.include.length, review: rep.review.length, reject: rep.exclude.length };
    const counts: Record<string, number> = {};
    for (const e of rep.episodes as { score: { flags: string[] } }[]) for (const f of e.score.flags) counts[f] = (counts[f] ?? 0) + 1;
    rep.flag_counts = counts;
    rep.overrides = job.overrides;
    return { report: rep, selection: sel };
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const json = (data: unknown, status = 200) => Response.json(data, { status });
      if (p === "/health") return json({ status: "ok", auth: false, version: "test", gemini_key: false, openrouter_key: false });
      if (p === "/critics") {
        return json([
          { id: "duration", description: "Episode length in seconds against [min_s, max_s].", default_params: { min_s: 5.0, max_s: 300.0, margin_frac: 0.5, per_cycle: false } },
          { id: "smoothness", description: "How fluid the demonstrated motion is.", default_params: { window_s: 3.0, ldj_good: -15.5, ldj_bad: -18.5 } },
        ]);
      }
      if (p === "/specs") {
        const stored = state.specs.map((s2) => ({ name: s2.name, task: (s2.spec.task as { instruction?: string } | undefined)?.instruction ?? null, robot: (s2.spec.robot as { type?: string } | undefined)?.type ?? null }));
        return json([{ name: "cup_tray", task: "pick cup from table, place on tray", robot: "humanoid_v1" }, ...stored]);
      }
      const spec = /^\/specs\/([^/]+)$/.exec(p);
      if (spec && req.method === "GET") {
        const name = decodeURIComponent(spec[1]!);
        const stored = state.specs.find((s2) => s2.name === name);
        if (stored) return json(stored.spec);
        if (name === "cup_tray") return json({ name, task: { instruction: "pick cup from table, place on tray" }, robot: { type: "humanoid_v1" } });
        return json({ detail: "spec not found" }, 404);
      }
      if (spec && req.method === "DELETE") {
        const name = decodeURIComponent(spec[1]!);
        if (!state.specs.some((s2) => s2.name === name) && name !== "cup_tray") return json({ detail: "spec not found" }, 404);
        state.specs = state.specs.filter((s2) => s2.name !== name);
        return new Response(null, { status: 204 });
      }
      if (spec && req.method === "PUT") {
        const body = (await req.json()) as Record<string, unknown>;
        // the real service validates against CriticSpec: a task with an instruction is the minimum
        const task = body.task as { instruction?: unknown } | undefined;
        if (typeof task?.instruction !== "string") return json({ detail: [{ loc: ["body", "task", "instruction"], msg: "Field required" }] }, 422);
        const name = decodeURIComponent(spec[1]!);
        state.specs = [...state.specs.filter((s2) => s2.name !== name), { name, spec: { ...body, name } }];
        return json({ name });
      }
      if (p === "/upload" && req.method === "POST") {
        const form = await req.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return json({ detail: "file required" }, 422);
        const name = url.searchParams.get("name") ?? "dataset";
        state.uploads.push({ name, bytes: file.size, fileName: file.name });
        return json({ name, path: `/data/${name}`, robot_type: "test_bot", episodes: 4, fps: 10, cameras: ["observation.images.front"], task: "put the red block in the box", version: "v2.1" }, 201);
      }
      if (p === "/merge" && req.method === "POST") {
        const body = (await req.json()) as MergeCall;
        state.merges.push(body);
        for (const source of body.sources) for (const link of source.dataset_parts ?? [source.dataset!]) await follow(link);
        if (state.failMergeWith) return json({ detail: state.failMergeWith.detail }, state.failMergeWith.status);
        const episodes = body.sources.reduce((a, s2) => a + s2.episodes.length, 0);
        // the real service streams a zipped LeRobot dataset; the bytes do not matter here
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${body.name}.zip"`,
            "x-merged-episodes": String(episodes),
          },
        });
      }
      if (p === "/jobs" && req.method === "POST") {
        const body = (await req.json()) as { dataset?: string; dataset_parts?: string[]; spec: unknown; purpose?: unknown; options: unknown };
        const id = `job_${state.jobs.length + 1}`;
        const parts = body.dataset_parts ?? null;
        const dataset = body.dataset ?? parts?.[0] ?? "";
        state.jobs.push({ id, dataset, parts, spec: body.spec, purpose: body.purpose ?? null, options: body.options, reads: 0, overrides: { ignore_flags: [], review_flags: [], disabled_critics: [] } });
        // the real service fetches the dataset in the job, not in the request;
        // it is done here before answering only because a test wants to see it
        // (a dataset in parts is fetched part by part, in order, and joined)
        for (const link of parts ?? [dataset]) await follow(link);
        return json({ job_id: id, dataset, status: "queued" }, 202);
      }
      const m = /^\/jobs\/([^/]+)(\/.*)?$/.exec(p);
      if (m) {
        const job = state.jobs.find((j) => j.id === m[1]);
        if (!job) return json({ detail: "job not found" }, 404);
        const rest = m[2] ?? "";
        if (req.method === "DELETE") {
          state.deleted.push(job.id);
          return new Response(null, { status: 204 });
        }
        if (rest === "/overrides" && req.method === "PUT") {
          const body = (await req.json()) as { ignore_flags?: string[]; review_flags?: string[]; disabled_critics?: string[] };
          job.overrides = { ignore_flags: body.ignore_flags ?? [], review_flags: body.review_flags ?? [], disabled_critics: body.disabled_critics ?? [] };
          const rep = replayed(job).report;
          return json({ job_id: job.id, overrides: job.overrides, counts: rep.counts, include: rep.include, review: rep.review, exclude: rep.exclude });
        }
        const current = replayed(job);
        if (rest === "") {
          job.reads += 1;
          if (job.reads === 1) return json({ job_id: job.id, status: "running", dataset: job.dataset, progress: { hard: { done: 2, total: 4 } } });
          return json({ job_id: job.id, status: "done", dataset: job.dataset, progress: { hard: { done: 4, total: 4 } }, counts: current.report.counts, n_episodes: report.n_episodes });
        }
        if (rest === "/report") return json({ ...current.report, dataset_name: job.dataset, spec_name: typeof job.spec === "string" ? job.spec : report.spec_name });
        if (rest === "/selection") return json(current.selection);
        if (rest === "/markdown") return new Response(`# lerobot-critics run ${job.id}\n\n2 accept · 0 review · 2 reject`, { headers: { "content-type": "text/markdown" } });
        if (rest === "/report.html") {
          // the real service links the run's artifacts against its own path (lerobot_critics.visual_report._artifacts)
          const links = ["report.md", "selection.json"].map((f) => `<a href="/jobs/${job.id}/files/${f}">${f}</a>`).join(" · ");
          const video = `<a href="/jobs/${job.id}/files/composites/episode_000002.mp4">episode 2</a>`;
          return new Response(`<html><body>report ${job.id}<div class="footer">Full data next to this report: ${links}. ${video}</div></body></html>`, { headers: { "content-type": "text/html" } });
        }
        if (rest === "/files/report.md") return new Response(`# lerobot-critics run ${job.id}`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
        if (rest === "/files/selection.json") return json(selection);
        if (rest.startsWith("/files/")) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
      }
      return json({ detail: `unhandled ${req.method} ${p}` }, 404);
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state;
}

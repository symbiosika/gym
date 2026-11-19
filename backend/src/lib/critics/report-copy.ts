/**
 * The report of a critics run, readable after the critics forgot the run.
 *
 * The critics keep nothing for good: a job directory goes with a redeploy of
 * the service or with a deleted job, and with it report.html and the
 * Markdown the report links of a block lead to. GYM mirrors report.json onto
 * the dataset anyway (lib/critics/sync.ts), so it holds two things here:
 *
 *  - a copy of report.html as the critics drew it, contact sheets included,
 *    stored through lib/storage when a run is mirrored (`keepReportCopy`) and
 *    for older datasets by the cron (`keepMissingReportCopies`);
 *  - for anything else (another `top`, the Markdown, a dataset with no copy),
 *    the live job first and, when the critics no longer have it, the same
 *    report drawn by the critics from the mirrored report.json, which needs
 *    no job directory (`POST /render/...`).
 *
 * GYM draws nothing itself: every page here is the critics' own.
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "@framework/lib/db/db-connection";
import log from "@framework/lib/log";
import { datasets, type DatasetSelect } from "../../db/schema";
import { REPORT_BUCKET } from "../gym/buckets";
import { NotFoundError } from "../gym/errors";
import { putFile, readFile, removeFile } from "../storage";
import { criticsClient, CriticsError } from "./client";

/** the `top` the report link opens with, and the one the copy is drawn with */
export const DEFAULT_REPORT_TOP = 5;

type ReportRow = Pick<DatasetSelect, "id" | "tenantId" | "name" | "criticsJobId" | "report" | "reportHtmlRef">;

const gone = (error: unknown) => error instanceof CriticsError && error.status === 404;

/**
 * The report as the critics hold it for the job, or drawn from the mirrored
 * report.json when they no longer have the job. Null when neither works.
 */
async function drawReportHtml(row: ReportRow, top: number): Promise<string | null> {
  if (row.criticsJobId) {
    try {
      return await criticsClient.reportHtml(row.criticsJobId, top);
    } catch (error) {
      if (!gone(error) || !row.report) throw error;
    }
  }
  return row.report ? await criticsClient.renderReportHtml(row.report, top) : null;
}

/**
 * Store a copy of the report of a finished run and point the dataset at it;
 * a previous copy is replaced (the verdicts were replayed). Never fails the
 * caller: without a copy the report is still drawn on demand.
 */
export async function keepReportCopy(row: ReportRow): Promise<string | null> {
  try {
    const html = await drawReportHtml(row, DEFAULT_REPORT_TOP);
    if (html == null) return null;
    const saved = await putFile(row.tenantId, REPORT_BUCKET, new File([html], `${row.id}-report.html`, { type: "text/html" }));
    await getDb()
      .update(datasets)
      .set({ reportHtmlRef: saved.ref })
      .where(and(eq(datasets.id, row.id), eq(datasets.tenantId, row.tenantId)));
    if (row.reportHtmlRef) await removeFile(row.tenantId, REPORT_BUCKET, row.reportHtmlRef).catch(() => undefined);
    return saved.ref;
  } catch (error) {
    log.error(`gym: the report of dataset ${row.id} could not be copied: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The visual report of a dataset. The default view comes from GYM's copy; any
 * other is asked of the critics, from the job or, when that is gone, from the
 * mirrored report.json. The copy is also the last resort when the critics
 * cannot be reached at all.
 */
export async function reportHtmlOf(row: ReportRow, top = DEFAULT_REPORT_TOP): Promise<string> {
  const copy = async () => (row.reportHtmlRef ? await (await readFile(row.tenantId, REPORT_BUCKET, row.reportHtmlRef)).text() : null);
  if (top === DEFAULT_REPORT_TOP) {
    const kept = await copy().catch(() => null);
    if (kept != null) return kept;
  }
  try {
    const html = await drawReportHtml(row, top);
    if (html != null) return html;
  } catch (error) {
    const kept = await copy().catch(() => null);
    if (kept != null) return kept;
    throw error;
  }
  throw new NotFoundError("The dataset has no report yet");
}

/** The run as AI-readable Markdown: from the job, else drawn by the critics from the mirrored report.json. */
export async function reportMarkdownOf(row: Pick<ReportRow, "criticsJobId" | "report">, detail: "summary" | "flagged" | "full" = "summary"): Promise<string> {
  if (row.criticsJobId) {
    try {
      return await criticsClient.markdown(row.criticsJobId, detail);
    } catch (error) {
      if (!gone(error) || !row.report) throw error;
    }
  }
  if (!row.report) throw new NotFoundError("The dataset has no report yet");
  return criticsClient.renderMarkdown(row.report, detail);
}

/**
 * Cron entry: a copy for finished datasets that have none yet, a few at a
 * time, so the reports of runs from before the copy are kept while the
 * critics still hold them (and drawn from report.json once they do not).
 * Returns how many were copied.
 */
export async function keepMissingReportCopies(limit = 10): Promise<number> {
  const rows = await getDb()
    .select({
      id: datasets.id,
      tenantId: datasets.tenantId,
      name: datasets.name,
      criticsJobId: datasets.criticsJobId,
      report: datasets.report,
      reportHtmlRef: datasets.reportHtmlRef,
    })
    .from(datasets)
    .where(and(eq(datasets.analysisStatus, "done"), isNull(datasets.reportHtmlRef), isNotNull(datasets.report)))
    // in no fixed order: one that keeps failing must not hold up the rest
    .orderBy(sql`random()`)
    .limit(limit);
  let copied = 0;
  for (const row of rows) if (await keepReportCopy(row)) copied++;
  return copied;
}

/**
 * The gym API, one function per endpoint. Authenticated calls go through the
 * fetcher (session cookie); the mobile and print calls are public and carry
 * the block's token or the day's share id in the path.
 */
import { fetcher, FetcherError } from '@/utils/fetcher'
import type {
  AccessTokenInfo,
  AiInfo,
  AuditEntry,
  BlockKind,
  BlockView,
  Cell,
  Collection,
  CriticsHardCriticInfo,
  CriticsSpecDetail,
  CriticsSpecInfo,
  CriticsStatus,
  DatasetUploadView,
  DatasetView,
  DayView,
  EvaluationReportRecord,
  EvaluationReportSections,
  EvaluationReportView,
  ExportRecord,
  KpiResult,
  Lang,
  MobileState,
  PolicyRecord,
  PrintView,
  PublicEvaluationReport,
  RolloutsView,
  SelectionChange,
  SelectionView,
  SkillListItem,
  SkillView,
  SampleReport,
  SampleVideo,
  SpecDraftRun,
  SpecDraftStep,
  SpecDraftView,
} from '@/types/gym'

const base = (tenantId: string) => `/api/v1/tenant/${tenantId}/gym`
const PUBLIC = '/api/v1/public/gym'

const query = (params: Record<string, string | number | boolean | undefined | null>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** A zip download that also carries the export id (and the episode count) in headers. */
async function zipDownload(url: string, name: string | undefined, fallback: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(name ? { name } : {}),
  })
  if (!res.ok) throw new FetcherError(res.status, await res.text())
  const disposition = res.headers.get('Content-Disposition') ?? ''
  return {
    blob: await res.blob(),
    fileName: /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? fallback,
    exportId: res.headers.get('X-Export-Id') ?? '',
    episodes: Number(res.headers.get('X-Export-Episodes') ?? 0),
  }
}

/**
 * The upload of one file across attempts. The api fills in `uploadId`; handing
 * the same object back resumes that upload instead of starting a new one.
 */
export interface UploadHandle {
  uploadId?: string
}

/** One chunk as the raw request body: multipart would only add a copy and a parse. */
async function putChunk(url: string, chunk: Blob): Promise<void> {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk })
  if (res.status === 401) {
    window.location.href = `/login.html?redirectUrl=${encodeURIComponent(window.location.href)}`
    throw new FetcherError(401, 'Unauthorized')
  }
  if (!res.ok) throw new FetcherError(res.status, await res.text())
}

/**
 * Five attempts for one chunk, waiting 1, 2, 4 and 8 seconds in between, so a
 * dataset of several gigabytes survives the short drop of a cell's uplink. A
 * dropped connection or a 5xx from something on the way is worth repeating; a
 * 4xx is about the request itself (the upload is gone, the chunk does not fit)
 * and repeating it would only cost time.
 */
async function withRetries<T>(call: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call()
    } catch (e) {
      const status = e instanceof FetcherError ? e.status : 0
      const worthRepeating = status === 0 || status === 408 || status === 429 || status >= 500
      if (attempt >= attempts || !worthRepeating) throw e
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
    }
  }
}

/**
 * Chunks in flight at once. One at a time leaves the line idle while the
 * server stores a chunk and answers; three keep it busy without one upload
 * crowding out everything else the browser does.
 */
const CHUNKS_IN_FLIGHT = 3

/**
 * The chunked upload behind `uploadDataset` and `uploadSpecSample`: announce
 * the file at `uploads`, send the missing chunks, ask for completion and
 * return what the server answers to it.
 */
async function uploadInChunks<T>(
  uploads: string,
  file: File,
  extra: Record<string, string>,
  onProgress: (percent: number) => void,
  handle: UploadHandle,
): Promise<T> {
  const session = handle.uploadId
    ? await fetcher.get<DatasetUploadView>(`${uploads}/${handle.uploadId}`)
    : await fetcher.post<DatasetUploadView>(uploads, { fileName: file.name, bytes: file.size, ...extra })
  handle.uploadId = session.uploadId

  const done = new Set(session.received)
  let sent = done.size * session.chunkSize
  onProgress(Math.min(99, Math.round((sent / file.size) * 100)))
  const pending = Array.from({ length: session.chunkCount }, (_, i) => i).filter((i) => !done.has(i))
  // a few workers take the next missing chunk each; the first that fails for
  // good stops the others, and what arrived is kept for the next attempt
  let failed = false
  const worker = async () => {
    for (let i = pending.shift(); i !== undefined && !failed; i = pending.shift()) {
      const from = i * session.chunkSize
      const chunk = file.slice(from, Math.min(from + session.chunkSize, file.size))
      try {
        await withRetries(() => putChunk(`${uploads}/${session.uploadId}/chunks/${i}`, chunk))
      } catch (e) {
        failed = true
        throw e
      }
      sent += chunk.size
      // 100 % is reserved for the handover below, which the bytes do not cover
      onProgress(Math.min(99, Math.round((sent / file.size) * 100)))
    }
  }
  await Promise.all(Array.from({ length: CHUNKS_IN_FLIGHT }, worker))
  // everything is up; handing the parts over to the critics is what is
  // left, and that is what the caller shows as the handover
  onProgress(100)
  const result = await fetcher.post<T>(`${uploads}/${session.uploadId}/complete`, {})
  handle.uploadId = undefined
  return result
}

export const gymApi = {
  ai: (t: string) => fetcher.get<AiInfo>(`${base(t)}/ai`),

  // cells and collections
  cells: (t: string) => fetcher.get<Cell[]>(`${base(t)}/cells`),
  createCell: (t: string, body: Partial<Cell>) => fetcher.post<Cell>(`${base(t)}/cells`, body),
  updateCell: (t: string, id: string, body: Partial<Cell>) => fetcher.put<Cell>(`${base(t)}/cells/${id}`, body),
  deleteCell: (t: string, id: string) => fetcher.delete<void>(`${base(t)}/cells/${id}`),
  collections: (t: string) => fetcher.get<Collection[]>(`${base(t)}/collections`),
  createCollection: (t: string, body: Partial<Collection>) => fetcher.post<Collection>(`${base(t)}/collections`, body),
  updateCollection: (t: string, id: string, body: Partial<Collection>) =>
    fetcher.put<Collection>(`${base(t)}/collections/${id}`, body),
  deleteCollection: (t: string, id: string) => fetcher.delete<void>(`${base(t)}/collections/${id}`),

  // skills
  skills: (t: string, params: { status?: string; collectionId?: string; limit?: number } = {}) =>
    fetcher.get<SkillListItem[]>(`${base(t)}/skills${query(params)}`),
  skill: (t: string, id: string) => fetcher.get<SkillView>(`${base(t)}/skills/${id}`),
  createSkill: (
    t: string,
    body: { name: string; collectionId?: string | null; taskDescription?: string; criticSpecName?: string | null },
  ) => fetcher.post<SkillListItem>(`${base(t)}/skills`, body),
  updateSkill: (
    t: string,
    id: string,
    body: {
      name?: string
      taskDescription?: string
      collectionId?: string | null
      criticSpecName?: string | null
      status?: 'active' | 'archived'
    },
  ) => fetcher.put<SkillListItem>(`${base(t)}/skills/${id}`, body),
  deleteSkill: (t: string, id: string) => fetcher.delete<void>(`${base(t)}/skills/${id}`),
  skillAudit: (t: string, id: string) => fetcher.get<AuditEntry[]>(`${base(t)}/skills/${id}/audit`),
  selection: (t: string, skillId: string) => fetcher.get<SelectionView>(`${base(t)}/skills/${skillId}/selection`),
  /** The operator's decisions: in the export or not, and their verdict over the critics' (null gives it back). */
  updateSelection: (t: string, skillId: string, changes: SelectionChange[]) =>
    fetcher.put<SelectionView>(`${base(t)}/skills/${skillId}/selection`, { changes }),
  exports: (t: string, skillId: string) => fetcher.get<ExportRecord[]>(`${base(t)}/skills/${skillId}/exports`),
  /** Saves the selection and returns the manifest zip; the export id comes back in a header. */
  createExport: (t: string, skillId: string, name?: string) =>
    zipDownload(`${base(t)}/skills/${skillId}/exports`, name, 'export.zip'),
  /**
   * Saves the selection and returns the whole thing as one merged LeRobot
   * dataset: the selected episodes of every recording upload of the skill in
   * one folder, renumbered, ready to hand to training. Built by the data
   * critics, so it can take a while and is far larger than the manifest.
   */
  createDatasetExport: (t: string, skillId: string, name?: string) =>
    zipDownload(`${base(t)}/skills/${skillId}/exports/dataset`, name, 'dataset.zip'),
  exportDownloadUrl: (t: string, exportId: string) => `${base(t)}/exports/${exportId}/download`,

  // policies
  policies: (t: string, skillId: string) => fetcher.get<PolicyRecord[]>(`${base(t)}/skills/${skillId}/policies`),
  createPolicy: (
    t: string,
    skillId: string,
    body: { name: string; exportId?: string | null; notes?: string; trainedAt?: string | null },
  ) => fetcher.post<PolicyRecord>(`${base(t)}/skills/${skillId}/policies`, body),
  updatePolicy: (
    t: string,
    id: string,
    body: { name?: string; exportId?: string | null; notes?: string; trainedAt?: string | null },
  ) => fetcher.put<PolicyRecord>(`${base(t)}/policies/${id}`, body),
  deletePolicy: (t: string, id: string) => fetcher.delete<void>(`${base(t)}/policies/${id}`),

  // day protocols
  days: (t: string, params: { from?: string; to?: string; cellId?: string; skillId?: string; limit?: number } = {}) =>
    fetcher.get<DayView[]>(`${base(t)}/days${query(params)}`),
  day: (t: string, id: string) => fetcher.get<DayView>(`${base(t)}/days/${id}`),
  updateDay: (t: string, id: string, body: { notes?: string; operatorName?: string }) =>
    fetcher.put<DayView>(`${base(t)}/days/${id}`, body),
  closeDay: (t: string, id: string) => fetcher.post<DayView>(`${base(t)}/days/${id}/close`, {}),
  /** Delete a day with its blocks and datasets. */
  deleteDay: (t: string, id: string) => fetcher.delete<void>(`${base(t)}/days/${id}`),
  dayAudit: (t: string, id: string) => fetcher.get<AuditEntry[]>(`${base(t)}/days/${id}/audit`),
  /** Write down a downtime of the cell: nothing in the tool can observe one. */
  addDowntime: (t: string, dayId: string, body: { reason: string; minutes: number; at?: string }) =>
    fetcher.post<DayView>(`${base(t)}/days/${dayId}/downtime`, body),
  removeDowntime: (t: string, dayId: string, eventId: string) =>
    fetcher.delete<DayView>(`${base(t)}/days/${dayId}/downtime/${eventId}`),

  // blocks: the wizard
  blocks: (t: string, params: { skillId?: string; dayProtocolId?: string; kind?: BlockKind; limit?: number } = {}) =>
    fetcher.get<BlockView[]>(`${base(t)}/blocks${query(params)}`),
  /** Start a block; the day protocol of the cell and date is created when missing. */
  startBlock: (t: string, body: { cellId: string; skillId: string; kind: BlockKind; policyId?: string | null; date?: string }) =>
    fetcher.post<{ day: DayView; block: BlockView }>(`${base(t)}/blocks`, body),
  block: (t: string, id: string) => fetcher.get<BlockView>(`${base(t)}/blocks/${id}`),
  deleteBlock: (t: string, id: string) => fetcher.delete<void>(`${base(t)}/blocks/${id}`),
  updateBrief: (
    t: string,
    id: string,
    body: { sceneText?: string; targetEpisodes?: number | null; kind?: BlockKind; policyId?: string | null },
  ) => fetcher.put<BlockView>(`${base(t)}/blocks/${id}/brief`, body),
  importFromSkill: (t: string, id: string, skillId: string) =>
    fetcher.post<BlockView>(`${base(t)}/blocks/${id}/import`, { skillId }),
  setStep: (t: string, id: string, step: string) => fetcher.put<BlockView>(`${base(t)}/blocks/${id}/step`, { step }),
  closeBlock: (t: string, id: string) => fetcher.post<BlockView>(`${base(t)}/blocks/${id}/close`, {}),
  accessToken: (t: string, id: string) => fetcher.get<AccessTokenInfo>(`${base(t)}/blocks/${id}/access-token`),
  sceneImageUrl: (t: string, id: string, version: string) =>
    `${base(t)}/blocks/${id}/scene-image?v=${encodeURIComponent(version)}`,
  uploadSceneImage: (t: string, id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return fetcher.postFormData<BlockView>(`${base(t)}/blocks/${id}/scene-image`, form)
  },
  removeSceneImage: (t: string, id: string) => fetcher.delete<BlockView>(`${base(t)}/blocks/${id}/scene-image`),
  /** The optional reference image of one variation of the plan, addressed by its step and index. */
  variationImage: (t: string, id: string, stepId: string, index: number) =>
    `${base(t)}/blocks/${id}/plan/steps/${encodeURIComponent(stepId)}/variations/${index}/image`,
  variationImageUrl: (t: string, id: string, stepId: string, index: number, version: string) =>
    `${gymApi.variationImage(t, id, stepId, index)}?v=${encodeURIComponent(version)}`,
  generateVariationImage: (t: string, id: string, stepId: string, index: number) =>
    fetcher.post<BlockView>(`${gymApi.variationImage(t, id, stepId, index)}/generate`, {}),
  variationImageFromScene: (t: string, id: string, stepId: string, index: number) =>
    fetcher.post<BlockView>(`${gymApi.variationImage(t, id, stepId, index)}/from-scene`, {}),
  uploadVariationImage: (t: string, id: string, stepId: string, index: number, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return fetcher.postFormData<BlockView>(gymApi.variationImage(t, id, stepId, index), form)
  },
  removeVariationImage: (t: string, id: string, stepId: string, index: number) =>
    fetcher.delete<BlockView>(gymApi.variationImage(t, id, stepId, index)),
  generatePlan: (t: string, id: string, lang: Lang) =>
    fetcher.post<BlockView>(`${base(t)}/blocks/${id}/plan/generate?lang=${lang}`, {}),
  updatePlan: (t: string, id: string, plan: unknown) => fetcher.put<BlockView>(`${base(t)}/blocks/${id}/plan`, plan),
  /** `withoutPlan` starts the block on a plain plan: the target number of episodes on the task, nothing else. */
  startRecording: (t: string, id: string, withoutPlan = false) =>
    fetcher.post<BlockView>(`${base(t)}/blocks/${id}/recording/start${withoutPlan ? '?withoutPlan=true' : ''}`, {}),
  progress: (t: string, id: string, stepId: string, delta: number) =>
    fetcher.put<BlockView>(`${base(t)}/blocks/${id}/recording/progress`, { stepId, delta }),
  /** The step to work on next, picked by hand; the counts stay as they are. */
  currentStep: (t: string, id: string, stepId: string) =>
    fetcher.put<BlockView>(`${base(t)}/blocks/${id}/recording/current-step`, { stepId }),
  finishRecording: (t: string, id: string) => fetcher.post<BlockView>(`${base(t)}/blocks/${id}/recording/finish`, {}),
  /**
   * Upload a zipped LeRobot dataset in chunks and start the critics run.
   *
   * One request per chunk instead of one request for the whole archive: a
   * dataset takes minutes over the uplink of a cell, and a reverse proxy in
   * front of the app cuts a request off long before that (Traefik reads a
   * request body for 60 seconds by default, then answers 502). The app cannot
   * ask for more time, so it never asks for any: every chunk is a short
   * request, a chunk that fails is repeated on its own, and an upload that was
   * interrupted picks up the chunks that are missing.
   *
   * `handle` carries the upload across attempts: pass the same object again and
   * what already arrived is not sent twice.
   *
   * The browser reads the file from the disc chunk by chunk (`File.slice`), so
   * a dataset of several gigabytes is never held in memory here either.
   */
  uploadDataset: (
    t: string,
    id: string,
    file: File,
    name: string | undefined,
    onProgress: (percent: number) => void,
    handle: UploadHandle = {},
  ): Promise<DatasetView> =>
    uploadInChunks<DatasetView>(`${base(t)}/blocks/${id}/datasets/uploads`, file, name ? { name } : {}, onProgress, handle),

  /** Give up an upload and let the server drop the chunks it is holding. */
  abortDatasetUpload: (t: string, id: string, uploadId: string) =>
    fetcher.delete<void>(`${base(t)}/blocks/${id}/datasets/uploads/${uploadId}`),
  followUp: (t: string, id: string, lang: Lang) => fetcher.post<BlockView>(`${base(t)}/blocks/${id}/follow-up?lang=${lang}`, {}),

  // evaluations: the human review of the rollouts and the reports over blocks
  rollouts: (t: string, blockId: string) => fetcher.get<RolloutsView>(`${base(t)}/blocks/${blockId}/rollouts`),
  /** Save what a person says about rollouts: verdict, failure code, note, variation. Only the named fields change. */
  reviewRollouts: (
    t: string,
    blockId: string,
    changes: {
      episodeId: string
      humanVerdict?: 'accept' | 'reject' | null
      failureCode?: string | null
      note?: string
      variationLabel?: string | null
    }[],
  ) => fetcher.put<RolloutsView>(`${base(t)}/blocks/${blockId}/rollouts/review`, { changes }),
  evaluationReports: (t: string, skillId: string) =>
    fetcher.get<EvaluationReportRecord[]>(`${base(t)}/skills/${skillId}/evaluation-reports`),
  createEvaluationReport: (
    t: string,
    skillId: string,
    body: { name: string; blockIds: string[]; sections?: Partial<EvaluationReportSections> },
  ) => fetcher.post<EvaluationReportView>(`${base(t)}/skills/${skillId}/evaluation-reports`, body),
  evaluationReport: (t: string, id: string) => fetcher.get<EvaluationReportView>(`${base(t)}/evaluation-reports/${id}`),
  updateEvaluationReport: (
    t: string,
    id: string,
    body: { name?: string; blockIds?: string[]; sections?: Partial<EvaluationReportSections> },
  ) => fetcher.put<EvaluationReportView>(`${base(t)}/evaluation-reports/${id}`, body),
  deleteEvaluationReport: (t: string, id: string) => fetcher.delete<void>(`${base(t)}/evaluation-reports/${id}`),

  // critics and datasets
  critics: (t: string) => fetcher.get<CriticsStatus>(`${base(t)}/critics`),
  /** Hand a critics spec (YAML or JSON) to the critics service; it is listed under the returned name. */
  uploadSpec: (t: string, file: File, name?: string) => {
    const form = new FormData()
    form.append('file', file, file.name)
    if (name) form.append('name', name)
    return fetcher.postFormData<CriticsSpecInfo>(`${base(t)}/critics/specs`, form)
  },
  /** The specs of the critics service with the skills that work with them. */
  specs: (t: string) => fetcher.get<CriticsSpecInfo[]>(`${base(t)}/critics/specs`),
  spec: (t: string, name: string) => fetcher.get<CriticsSpecDetail>(`${base(t)}/critics/specs/${encodeURIComponent(name)}`),
  /** Write a spec as YAML or JSON text; a spec of that name is replaced. */
  saveSpec: (t: string, name: string, text: string) =>
    fetcher.put<CriticsSpecInfo>(`${base(t)}/critics/specs/${encodeURIComponent(name)}`, { text }),
  deleteSpec: (t: string, name: string) => fetcher.delete<void>(`${base(t)}/critics/specs/${encodeURIComponent(name)}`),
  /** A starting point for a new spec written as YAML. */
  specTemplate: (t: string) => fetcher.get<{ yaml: string }>(`${base(t)}/critics/spec-template`),
  /** The technical checks with their default parameters, one row per check in the spec form. */
  hardCritics: (t: string) => fetcher.get<CriticsHardCriticInfo[]>(`${base(t)}/critics/hard-critics`),

  // the spec wizard: a spec worked out from a sample dataset
  specDrafts: (t: string) => fetcher.get<SpecDraftView[]>(`${base(t)}/spec-drafts`),
  createSpecDraft: (t: string, body: { name?: string; skillId?: string | null; purpose?: BlockKind; sampleSize?: number }) =>
    fetcher.post<SpecDraftView>(`${base(t)}/spec-drafts`, body),
  specDraft: (t: string, id: string) => fetcher.get<SpecDraftView>(`${base(t)}/spec-drafts/${id}`),
  /** Save what was entered in the wizard; only the named fields change. */
  updateSpecDraft: (
    t: string,
    id: string,
    body: {
      name?: string
      skillId?: string | null
      purpose?: BlockKind
      sampleSize?: number
      step?: SpecDraftStep
      spec?: Record<string, unknown> | null
      judgments?: Record<string, 'accept' | 'reject'>
    },
  ) => fetcher.put<SpecDraftView>(`${base(t)}/spec-drafts/${id}`, body),
  /** Analyse one more episode of the sample, one the person knows by number. */
  addSpecEpisode: (t: string, id: string, episode: number) =>
    fetcher.post<SpecDraftView>(`${base(t)}/spec-drafts/${id}/episodes`, { episode }),
  specEpisodeVideos: (t: string, id: string, episode: number) =>
    fetcher.get<SampleVideo[]>(`${base(t)}/spec-drafts/${id}/episodes/${episode}/videos`),
  /** The address a <video> plays; a window inside a packed file is added as a media fragment. */
  specEpisodeVideoUrl: (t: string, id: string, episode: number, video: SampleVideo) =>
    `${base(t)}/spec-drafts/${id}/episodes/${episode}/video?camera=${encodeURIComponent(video.camera)}` +
    (video.from_s != null ? `#t=${video.from_s},${video.to_s ?? ''}` : ''),
  deleteSpecDraft: (t: string, id: string) => fetcher.delete<void>(`${base(t)}/spec-drafts/${id}`),
  /** Upload the sample dataset of a draft in chunks; the analysis in auto mode starts when it is complete. */
  uploadSpecSample: (t: string, id: string, file: File, onProgress: (percent: number) => void, handle: UploadHandle = {}) =>
    uploadInChunks<SpecDraftView>(`${base(t)}/spec-drafts/${id}/uploads`, file, {}, onProgress, handle),
  analyzeSpecDraft: (t: string, id: string) => fetcher.post<SpecDraftView>(`${base(t)}/spec-drafts/${id}/analyze`, {}),
  testSpecDraft: (t: string, id: string, spec?: Record<string, unknown>) =>
    fetcher.post<SpecDraftView>(`${base(t)}/spec-drafts/${id}/test`, spec ? { spec } : {}),
  finishSpecDraft: (t: string, id: string, body: { name: string; assignToSkill?: boolean; overwrite?: boolean }) =>
    fetcher.post<{ name: string; skillId: string | null; assigned: boolean }>(`${base(t)}/spec-drafts/${id}/finish`, body),
  specDraftReport: (t: string, id: string, run: SpecDraftRun) =>
    fetcher.get<SampleReport>(`${base(t)}/spec-drafts/${id}/report?run=${run}`),
  /** The contact sheet of one episode of the sample: one row per camera, frames over time. */
  specDraftSheetUrl: (t: string, id: string, episode: number, run: SpecDraftRun = 'analysis') =>
    `${base(t)}/spec-drafts/${id}/files/sheets/episode_${String(episode).padStart(6, '0')}.jpg?run=${run}`,
  datasetReportUrl: (t: string, id: string) => `${base(t)}/datasets/${id}/report.html`,
  datasetFileUrl: (t: string, id: string, path: string) => `${base(t)}/datasets/${id}/files/${path}`,
  dataset: (t: string, id: string) => fetcher.get<DatasetView>(`${base(t)}/datasets/${id}`),
  /**
   * Downgrade findings of a run: `reviewFlags` only cap an episode at review
   * (a warning), `ignoreFlags` are muted, `disabledCritics` do not count at
   * all for this dataset. The critics replay the verdicts and
   * GYM mirrors the result again; the human review of the rollouts survives.
   * Two empty lists restore the run as scored.
   */
  setDatasetFindings: (
    t: string,
    id: string,
    body: { reviewFlags: string[]; ignoreFlags: string[]; disabledCritics: string[] },
  ) => fetcher.put<DatasetView>(`${base(t)}/datasets/${id}/findings`, body),
  deleteDataset: (t: string, id: string) => fetcher.delete<void>(`${base(t)}/datasets/${id}`),

  // key figures
  kpis: (t: string, params: { from?: string; to?: string; cellId?: string; collectionId?: string; skillId?: string } = {}) =>
    fetcher.get<KpiResult>(`${base(t)}/kpis${query(params)}`),
}

/** Public endpoints of the phone and the printable view. */
export const publicApi = {
  mobile: (token: string) => fetcher.get<MobileState>(`${PUBLIC}/m/${token}`),
  mobileImageUrl: (token: string, version: string) => `${PUBLIC}/m/${token}/scene-image?v=${encodeURIComponent(version)}`,
  mobileVariationImageUrl: (token: string, stepId: string, index: number) =>
    `${PUBLIC}/m/${token}/plan-image/${encodeURIComponent(stepId)}/${index}`,
  uploadSceneImage: (token: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return fetcher.postFormData<MobileState>(`${PUBLIC}/m/${token}/scene-image`, form)
  },
  sceneText: (token: string, text: string) => fetcher.put<MobileState>(`${PUBLIC}/m/${token}/scene-text`, { text }),
  sceneDone: (token: string) => fetcher.post<MobileState>(`${PUBLIC}/m/${token}/scene-done`, {}),
  progress: (token: string, stepId: string, delta: number) =>
    fetcher.put<MobileState>(`${PUBLIC}/m/${token}/progress`, { stepId, delta }),
  currentStep: (token: string, stepId: string) => fetcher.put<MobileState>(`${PUBLIC}/m/${token}/current-step`, { stepId }),
  print: (shareId: string) => fetcher.get<PrintView>(`${PUBLIC}/print/${shareId}`),
  evaluationReport: (shareId: string) => fetcher.get<PublicEvaluationReport>(`${PUBLIC}/eval-report/${shareId}`),
  printImageUrl: (shareId: string, blockId: string) => `${PUBLIC}/print/${shareId}/blocks/${blockId}/scene-image`,
}

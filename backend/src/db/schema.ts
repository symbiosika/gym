/**
 * Database schema of the GYM app (tables prefixed with `gym_`).
 *
 * The model follows the glossary in docs/GLOSSARY.md and has two axes:
 *
 * Controlling (the cell's time):
 *   Cell          a physical training cell in the gym
 *   Day protocol  one per cell and day: operator, downtime, notes, the
 *                 printable record. Holds the blocks of that day.
 *   Block         one stretch of work in a day protocol for one skill, either a
 *                 recording block (teleoperation) or an evaluation block (a
 *                 policy runs, its rollouts are recorded). The unit of the
 *                 operator wizard: brief, plan, recording, upload, review.
 *
 * Product (what is trained):
 *   Collection    a customer project or use case; groups skills
 *   Skill         what is trained: task, critics spec, its recording blocks
 *                 over all days and cells, the episode selection, the exports
 *   Policy        a trained version of a skill; evaluation blocks point at one
 *   Dataset       one uploaded LeRobot dataset of a block; analysed by the
 *                 lerobot-critics service, exactly one run per dataset
 *   Episode       one execution of a task inside a dataset; carries the critics'
 *                 verdict (accept, review, reject), the operator's selection
 *                 and, for a rollout, the human review (verdict, failure code)
 *   Export        a saved episode selection of a skill (recording datasets only)
 *   Evaluation report  evaluation blocks of a skill read together: success by
 *                 block, by variation, failure modes, with the written sections
 *   Audit log     who did what and when, per skill, day protocol and block
 *
 * Only structured, queryable data is relational. Documents that are written
 * once and read as a whole (the recording plan, the critics' report and
 * selection) live as JSONB on their parent row.
 */
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTableCreator,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-valibot";
import { tenants } from "@framework/lib/db/schema/users";
import type { CriticsSelection, DatasetReport } from "../lib/critics/client";
import type { CriticsSummary, EpisodeReason, EpisodeVerdict } from "../lib/critics/summary";
import { PREFIX } from "./index";

export type { EpisodeVerdict };
export { EPISODE_VERDICTS } from "../lib/critics/summary";

export const pgBaseTable = pgTableCreator((name: string) => `${PREFIX}${name}`);

// ---------------------------------------------------------------------------
// Enumerations (stored as text; the union types are the source of truth)
// ---------------------------------------------------------------------------

export const SKILL_STATUSES = ["active", "archived"] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/**
 * What a block of a day is for:
 *
 *   recording    teleoperation; the datasets train the skill
 *   evaluation   a trained policy runs; the recorded rollouts are judged by the
 *                critics like any dataset, and their accept rate is the
 *                policy's success rate. Never part of a training export.
 */
export const BLOCK_KINDS = ["recording", "evaluation"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const COLLECTION_STATUSES = ["active", "archived"] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

/**
 * Steps of the operator wizard for one block. The wizard is stateful: the
 * current step is persisted so a browser restart resumes where the operator
 * left off.
 *
 *   brief       describe the scene (photo, text, target episodes)
 *   plan        review the recording plan proposed by the AI (optional for an evaluation)
 *   recording   teleoperation or the policy is running, the operator walks through the plan
 *   upload      upload the LeRobot dataset exported by the recording tool
 *   review      look at the analysis, decide to record more or to select
 *   selection   pick the episodes of the skill for the export (recording blocks only)
 *   closed      the block is finished
 */
export const BLOCK_STEPS = ["brief", "plan", "recording", "upload", "review", "selection", "closed"] as const;
export type BlockStep = (typeof BLOCK_STEPS)[number];

/**
 * Where a dataset stands with the critics service: uploaded and queued,
 * running, done (report and selection mirrored), or failed.
 */
export const DATASET_ANALYSIS_STATUSES = ["queued", "running", "done", "failed"] as const;
export type DatasetAnalysisStatus = (typeof DATASET_ANALYSIS_STATUSES)[number];

/**
 * The human's verdict on an episode: on a rollout of an evaluation block in
 * the review, on a recorded episode in the selection. The critics judge
 * first; a person may then say "this one is good" or "this one is not", and
 * that word counts. Only accept and reject: a person does not ask for
 * review. Null means the critics' verdict stands.
 */
export const HUMAN_VERDICTS = ["accept", "reject"] as const;
export type HumanVerdict = (typeof HUMAN_VERDICTS)[number];

/**
 * Why a rollout failed, as the reviewer classifies it. A fixed catalogue, so
 * the failure modes of an evaluation can be counted and compared across
 * blocks and policies. F-08 marks a rollout invalidated by hardware or
 * infrastructure: it is shown but not charged to the policy.
 */
export const FAILURE_CODES = ["F-01", "F-02", "F-03", "F-04", "F-05", "F-06", "F-07", "F-08"] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
/** The rollouts with this code are not the policy's fault and leave the policy-attributable rate. */
export const INVALID_FAILURE_CODE: FailureCode = "F-08";

// ---------------------------------------------------------------------------
// JSON documents
// ---------------------------------------------------------------------------

/**
 * The reference image of a variation: what the scene should look like when the
 * operator has built the variation. Optional; generated from the scene photo
 * by the image model, uploaded by the operator or taken over from the scene
 * photo as it is.
 */
export interface PlanVariationImage {
  /** storage reference of lib/storage, bucket `gym-variation` */
  ref: string;
  source: "ai" | "upload" | "scene";
  /** the edit instruction the image was generated with, empty for the other sources */
  prompt: string;
  createdAt: string;
}

/** One variation of the scene the operator should set up (a domain randomization). */
export interface PlanVariation {
  label: string;
  /** episodes to record with this variation */
  episodes: number;
  /** English edit instruction for the reference image, proposed with the plan */
  imagePrompt?: string;
  /** the reference image, when one was generated or uploaded */
  image?: PlanVariationImage | null;
}

/** One step of the recording plan: a scene setup with its variations. */
export interface PlanStep {
  id: string;
  title: string;
  /** what to build up and what to do, written for the operator at the cell */
  instructions: string;
  variations: PlanVariation[];
  /** episodes in this step, the sum over the variations */
  episodes: number;
}

/** The plan of a block: proposed by the AI, edited by the operator. For an evaluation it says which settings to test. */
export interface RecordingPlan {
  /** one-sentence summary of what is recorded today */
  summary: string;
  /** general scene setup advice */
  sceneSetup: string[];
  /** domain randomizations the AI recommends across the day */
  randomizations: string[];
  steps: PlanStep[];
  /**
   * "ai" when the plan came from the model, "fallback" without a configured
   * provider, "plain" when the operator started without a plan (one step, the
   * target number of episodes on the task), "manual" when edited
   */
  source: "ai" | "fallback" | "plain" | "manual";
  createdAt: string;
}

/** Progress of the operator through the plan while recording. */
export interface RecordingProgress {
  /** completed episodes per plan step, keyed by step id */
  completed: Record<string, number>;
  /** the step the operator is currently on */
  currentStepId: string | null;
  updatedAt: string;
}

/**
 * One window of a block: the operator opened the recording step and closed it
 * again (finished recording, or uploaded the dataset). A block has as many
 * windows as the operator opened it; `endedAt` is null while one runs. The
 * time of the block is the sum of the windows, not the span from the first
 * start to the last close. In a recording block it is teleoperation time, in
 * an evaluation block the time the policy ran.
 */
export interface TeleopInterval {
  startedAt: string;
  endedAt: string | null;
}

/**
 * A downtime the operator writes down by hand in the recording step: a reason
 * and how long it took. This is the only way the protocol learns about the
 * time the cell stood still, because nothing in the tool can observe it.
 */
export interface DowntimeEvent {
  id: string;
  reason: string;
  minutes: number;
  /** when the downtime started, as the operator sees it */
  at: string;
  createdBy: string | null;
  createdByName: string;
  createdAt: string;
}

/** AI suggestion after an analysis: what to record again and why. */
export interface FollowUpSuggestion {
  summary: string;
  items: { title: string; episodes: number; reason: string }[];
  source: "ai" | "fallback";
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export const cells = pgBaseTable(
  "cells",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    location: text("location").notNull().default(""),
    /** the robot in the cell, informational */
    robot: text("robot").notNull().default(""),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_cells_tenant_idx").on(table.tenantId),
    uniqueIndex("gym_cells_name_uq").on(table.tenantId, table.name),
  ],
);

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export const collections = pgBaseTable(
  "collections",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    customer: text("customer").notNull().default(""),
    description: text("description").notNull().default(""),
    status: text("status").$type<CollectionStatus>().notNull().default("active"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_collections_tenant_idx").on(table.tenantId),
    uniqueIndex("gym_collections_name_uq").on(table.tenantId, table.name),
  ],
);

// ---------------------------------------------------------------------------
// Skills and policies
// ---------------------------------------------------------------------------

export const skills = pgBaseTable(
  "skills",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    collectionId: uuid("collection_id").references(() => collections.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** the task the skill trains, in the words of the operator */
    taskDescription: text("task_description").notNull().default(""),
    /** name of the stored critics spec to analyse datasets with; null = auto spec */
    criticSpecName: text("critic_spec_name"),
    status: text("status").$type<SkillStatus>().notNull().default("active"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_skills_tenant_idx").on(table.tenantId),
    index("gym_skills_collection_idx").on(table.collectionId),
    index("gym_skills_status_idx").on(table.tenantId, table.status),
  ],
);

/** A trained version of a skill. Evaluation blocks point at the policy they test. */
export const policies = pgBaseTable(
  "policies",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    /** the export the policy was trained from, when known */
    exportId: uuid("export_id"),
    notes: text("notes").notNull().default(""),
    /** when the training finished, as the operator says */
    trainedAt: timestamp("trained_at", { mode: "string" }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [index("gym_policies_tenant_idx").on(table.tenantId), index("gym_policies_skill_idx").on(table.skillId)],
);

// ---------------------------------------------------------------------------
// Day protocols
// ---------------------------------------------------------------------------

/**
 * The controlling record of one cell and day: who was there, how long the
 * cell stood still, notes, the printable view. Everything that is done in the
 * cell that day is a block of this protocol.
 */
export const dayProtocols = pgBaseTable(
  "day_protocols",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    cellId: uuid("cell_id").references(() => cells.id, { onDelete: "restrict" }).notNull(),
    /** YYYY-MM-DD in the gym's time zone */
    date: text("date").notNull(),
    operatorUserId: uuid("operator_user_id"),
    operatorName: text("operator_name").notNull().default(""),
    /** downtimes the operator wrote down by hand */
    downtime: jsonb("downtime").$type<DowntimeEvent[]>().notNull().default([]),
    notes: text("notes").notNull().default(""),
    /** public id of the printable view; the link is shareable */
    shareId: text("share_id").notNull(),
    closedAt: timestamp("closed_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_day_protocols_tenant_idx").on(table.tenantId),
    index("gym_day_protocols_date_idx").on(table.tenantId, table.date),
    // one day protocol per cell and day
    uniqueIndex("gym_day_protocols_cell_date_uq").on(table.tenantId, table.cellId, table.date),
    uniqueIndex("gym_day_protocols_share_uq").on(table.shareId),
  ],
);

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * One stretch of work in a day protocol for one skill: a recording block or an
 * evaluation block. The operator wizard runs on a block; a day has as many
 * blocks as the operator started, of any kind and for any skill.
 */
export const blocks = pgBaseTable(
  "blocks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    dayProtocolId: uuid("day_protocol_id").references(() => dayProtocols.id, { onDelete: "cascade" }).notNull(),
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "cascade" }).notNull(),
    kind: text("kind").$type<BlockKind>().notNull().default("recording"),
    /** the policy an evaluation block tests; null for recording blocks or an unnamed policy */
    policyId: uuid("policy_id").references(() => policies.id, { onDelete: "set null" }),
    step: text("step").$type<BlockStep>().notNull().default("brief"),
    /** episodes to record, or rollouts to run */
    targetEpisodes: integer("target_episodes"),
    /** the scene photo, a storage reference of lib/storage (`"<driver>:<name>"`) */
    sceneImageRef: text("scene_image_ref"),
    sceneText: text("scene_text").notNull().default(""),
    /** set by the mobile view when the operator pressed "done" */
    sceneCapturedAt: timestamp("scene_captured_at", { mode: "string" }),
    plan: jsonb("plan").$type<RecordingPlan>(),
    progress: jsonb("progress").$type<RecordingProgress>(),
    followUp: jsonb("follow_up").$type<FollowUpSuggestion>(),
    /** first start and last close of the recording step */
    teleopStartedAt: timestamp("teleop_started_at", { mode: "string" }),
    teleopEndedAt: timestamp("teleop_ended_at", { mode: "string" }),
    /** every open/close of the recording step; their sum is the block's time */
    teleopIntervals: jsonb("teleop_intervals").$type<TeleopInterval[]>().notNull().default([]),
    /**
     * Token for the unauthenticated mobile views (scene capture, recording
     * run). Rotated on demand, expires after a few hours.
     */
    accessToken: text("access_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { mode: "string" }),
    createdBy: uuid("created_by"),
    closedAt: timestamp("closed_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_blocks_tenant_idx").on(table.tenantId),
    index("gym_blocks_day_idx").on(table.dayProtocolId),
    index("gym_blocks_skill_idx").on(table.skillId, table.kind),
    uniqueIndex("gym_blocks_token_uq").on(table.accessToken),
  ],
);

// ---------------------------------------------------------------------------
// Datasets and episodes
// ---------------------------------------------------------------------------

export const datasets = pgBaseTable(
  "datasets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "cascade" }).notNull(),
    dayProtocolId: uuid("day_protocol_id").references(() => dayProtocols.id, { onDelete: "cascade" }).notNull(),
    blockId: uuid("block_id").references(() => blocks.id, { onDelete: "cascade" }).notNull(),
    /** display name, from the upload */
    name: text("name").notNull(),
    /** the uploaded zip */
    sourceFileName: text("source_file_name").notNull().default(""),
    /** bigint: a dataset of several gigabytes is ordinary */
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    episodeCount: integer("episode_count").notNull().default(0),
    /**
     * Where the zip lies, a storage reference of lib/storage. GYM owns the
     * recorded data: the critics are handed a temporary link to it for one job
     * or one merge and keep nothing. Null for a dataset from before that, whose
     * zip only ever lived in the critics service.
     */
    storageRef: text("storage_ref"),
    /**
     * The zip in parts, in order, instead of `storageRef`: a dataset that came
     * through a chunked upload keeps the chunks it arrived in (bucket
     * `gym-upload-chunks`), and is never put together again on this side. The
     * critics are handed a link to each part and join them
     * (lib/gym/dataset-uploads.ts). Null for a dataset stored as one file.
     */
    storageParts: jsonb("storage_parts").$type<string[]>(),
    /** the name the dataset goes by at the critics, and the run that analysed it */
    criticsDatasetName: text("critics_dataset_name").notNull(),
    criticsJobId: text("critics_job_id"),
    criticSpecName: text("critic_spec_name"),
    analysisStatus: text("analysis_status").$type<DatasetAnalysisStatus>().notNull().default("queued"),
    /** progress of the critics job while running: stage → done/total */
    progress: jsonb("progress").$type<Record<string, { done: number; total: number }>>(),
    /** the compact summary for the operator and the key figures */
    analysis: jsonb("analysis").$type<CriticsSummary>(),
    /** the critics' report.json and selection.json, mirrored as they are */
    report: jsonb("report").$type<DatasetReport>(),
    selection: jsonb("selection").$type<CriticsSelection>(),
    analysisError: text("analysis_error"),
    uploadedBy: uuid("uploaded_by"),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_datasets_tenant_idx").on(table.tenantId),
    index("gym_datasets_skill_idx").on(table.skillId),
    index("gym_datasets_day_idx").on(table.dayProtocolId),
    index("gym_datasets_block_idx").on(table.blockId),
    index("gym_datasets_status_idx").on(table.analysisStatus),
  ],
);

/**
 * One dataset upload in progress: the operator's browser sends the zip in
 * chunks, so no single request has to carry the whole archive. A request that
 * runs for minutes is killed by any reverse proxy on the way (Traefik's
 * `respondingTimeouts.readTimeout` is 60s by default) and takes the whole
 * upload with it. In chunks, every request is short, a failed chunk is
 * repeated on its own and an interrupted upload resumes where it stopped.
 *
 * Which chunks arrived is not stored here but in `datasetUploadChunks`, one
 * row per chunk, so two chunks that are sent at the same time cannot overwrite
 * each other's bookkeeping. The row carries what the client announced, and
 * `updatedAt` marks the last sign of life of the upload.
 *
 * The row lives only until the upload is complete: `complete` reads the chunks
 * back, hands the zip to the critics, creates the dataset and drops the row.
 * What is left behind by a browser that never came back is removed by the
 * `gym-cleanup-dataset-uploads` cron job.
 */
export const datasetUploads = pgBaseTable(
  "dataset_uploads",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    blockId: uuid("block_id").references(() => blocks.id, { onDelete: "cascade" }).notNull(),
    /** the file the operator picked, and the dataset name they gave it */
    fileName: text("file_name").notNull(),
    displayName: text("display_name").notNull().default(""),
    /** the size the client announced; the chunks must add up to it exactly */
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    chunkSize: integer("chunk_size").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_dataset_uploads_tenant_idx").on(table.tenantId),
    index("gym_dataset_uploads_block_idx").on(table.blockId),
    index("gym_dataset_uploads_updated_idx").on(table.updatedAt),
  ],
);

/**
 * One chunk of a dataset upload that is still running. The bytes themselves
 * are in the configured storage (lib/storage), never on the disc of a
 * container, so a chunk that arrives at one replica can be completed by
 * another; this table is the record of which chunk arrived and where it lies.
 * A row per chunk, and not a list on the upload row, because chunks are sent
 * in parallel and two of them must not lose each other.
 */
export const datasetUploadChunks = pgBaseTable(
  "dataset_upload_chunks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    uploadId: uuid("upload_id").references(() => datasetUploads.id, { onDelete: "cascade" }).notNull(),
    /** the position of the chunk in the archive, 0-based */
    index: integer("index").notNull(),
    /** where the bytes are: `"<driver>:<name>"`, see lib/storage */
    storageRef: text("storage_ref").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_dataset_upload_chunks_tenant_idx").on(table.tenantId),
    uniqueIndex("gym_dataset_upload_chunks_upload_index_idx").on(table.uploadId, table.index),
  ],
);

export const episodes = pgBaseTable(
  "episodes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "cascade" }).notNull(),
    datasetId: uuid("dataset_id").references(() => datasets.id, { onDelete: "cascade" }).notNull(),
    /** episode_index inside the dataset */
    index: integer("index").notNull(),
    task: text("task").notNull().default(""),
    frames: integer("frames"),
    durationSeconds: real("duration_seconds"),
    /** the critics' verdict */
    verdict: text("verdict").$type<EpisodeVerdict>().notNull().default("unknown"),
    totalScore: real("total_score"),
    hardScore: real("hard_score"),
    softScore: real("soft_score"),
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    /** why the episode was not accepted, from selection.json */
    reason: jsonb("reason").$type<EpisodeReason | null>(),
    /** critic id → score */
    criticScores: jsonb("critic_scores").$type<Record<string, number | null>>().notNull().default({}),
    error: text("error"),
    /** the operator's decision for the export; rejected episodes start deselected */
    selected: boolean("selected").notNull().default(true),
    /**
     * The human review of a rollout (evaluation blocks): the reviewer's
     * verdict over the critics', the failure code, a note, and which
     * variation of the evaluation plan the rollout ran in. The effective
     * verdict of a rollout is `coalesce(human_verdict, verdict)`.
     */
    humanVerdict: text("human_verdict").$type<HumanVerdict>(),
    failureCode: text("failure_code").$type<FailureCode>(),
    reviewNote: text("review_note").notNull().default(""),
    /** the label of the plan variation the rollout was run in; null = as the plan order says */
    variationLabel: text("variation_label"),
    reviewedBy: uuid("reviewed_by"),
    reviewedByName: text("reviewed_by_name").notNull().default(""),
    reviewedAt: timestamp("reviewed_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_episodes_tenant_idx").on(table.tenantId),
    index("gym_episodes_skill_idx").on(table.skillId),
    index("gym_episodes_dataset_idx").on(table.datasetId),
    uniqueIndex("gym_episodes_identity_uq").on(table.datasetId, table.index),
  ],
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export interface ExportSelection {
  datasets: { datasetId: string; name: string; criticsDatasetName: string; criticsJobId: string | null; episodeIndexes: number[] }[];
  episodes: number;
}

export const exports = pgBaseTable(
  "exports",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    selection: jsonb("selection").$type<ExportSelection>().notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_exports_tenant_idx").on(table.tenantId),
    index("gym_exports_skill_idx").on(table.skillId),
  ],
);

// ---------------------------------------------------------------------------
// Evaluation reports
// ---------------------------------------------------------------------------

/**
 * The written parts of an evaluation report: what was tested and how, and
 * what the team concluded. Everything else in the report is computed from the
 * blocks it covers when it is read.
 */
export interface EvaluationReportSections {
  /** the language prompt the policy was run with */
  prompt: string;
  /** when a rollout counts as a success */
  successCriteria: string;
  /** the design of the campaign: variants, layouts, checkpoints */
  design: string;
  /** how the scene is reset and when a rollout is stopped */
  reset: string;
  /** what to keep in mind when reading the figures */
  caveats: string;
  /** conclusion: what is working */
  working: string;
  /** conclusion: what needs review */
  needsReview: string;
  /** conclusion: the recommended next steps */
  nextSteps: string;
}

export const EMPTY_REPORT_SECTIONS: EvaluationReportSections = {
  prompt: "",
  successCriteria: "",
  design: "",
  reset: "",
  caveats: "",
  working: "",
  needsReview: "",
  nextSteps: "",
};

/**
 * An evaluation report of a skill: one or more evaluation blocks read
 * together (one policy on one day, or several checkpoints of a training run
 * against each other), with the written sections above. The figures are
 * computed from the blocks' rollouts, their critics' verdicts and the human
 * review every time the report is read, so a review changes the report at
 * once. Has a share id for the read-only, printable view.
 */
export const evaluationReports = pgBaseTable(
  "evaluation_reports",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    /** the evaluation blocks of the skill the report reads together, in report order */
    blockIds: jsonb("block_ids").$type<string[]>().notNull().default([]),
    sections: jsonb("sections").$type<EvaluationReportSections>().notNull().default(EMPTY_REPORT_SECTIONS),
    /** public id of the read-only view; the link is shareable */
    shareId: text("share_id").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_evaluation_reports_tenant_idx").on(table.tenantId),
    index("gym_evaluation_reports_skill_idx").on(table.skillId),
    uniqueIndex("gym_evaluation_reports_share_uq").on(table.shareId),
  ],
);

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const auditLog = pgBaseTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    /** the skill the action concerns, when it concerns one (cascades with it) */
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "cascade" }),
    /** the day protocol the action concerns; stays when the block goes */
    dayProtocolId: uuid("day_protocol_id").references(() => dayProtocols.id, { onDelete: "cascade" }),
    blockId: uuid("block_id").references(() => blocks.id, { onDelete: "set null" }),
    userId: uuid("user_id"),
    userName: text("user_name").notNull().default(""),
    /** dotted action name, e.g. "skill.created", "block.started", "dataset.uploaded" */
    action: text("action").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_audit_log_tenant_idx").on(table.tenantId),
    index("gym_audit_log_skill_idx").on(table.skillId, table.createdAt),
    index("gym_audit_log_day_idx").on(table.dayProtocolId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const cellsRelations = relations(cells, ({ many }) => ({
  days: many(dayProtocols),
}));

export const collectionsRelations = relations(collections, ({ many }) => ({
  skills: many(skills),
}));

export const skillsRelations = relations(skills, ({ one, many }) => ({
  collection: one(collections, { fields: [skills.collectionId], references: [collections.id] }),
  blocks: many(blocks),
  policies: many(policies),
  datasets: many(datasets),
  episodes: many(episodes),
  exports: many(exports),
  evaluationReports: many(evaluationReports),
  audit: many(auditLog),
}));

export const policiesRelations = relations(policies, ({ one, many }) => ({
  skill: one(skills, { fields: [policies.skillId], references: [skills.id] }),
  evaluations: many(blocks),
}));

export const dayProtocolsRelations = relations(dayProtocols, ({ one, many }) => ({
  cell: one(cells, { fields: [dayProtocols.cellId], references: [cells.id] }),
  blocks: many(blocks),
  datasets: many(datasets),
}));

export const blocksRelations = relations(blocks, ({ one, many }) => ({
  day: one(dayProtocols, { fields: [blocks.dayProtocolId], references: [dayProtocols.id] }),
  skill: one(skills, { fields: [blocks.skillId], references: [skills.id] }),
  policy: one(policies, { fields: [blocks.policyId], references: [policies.id] }),
  datasets: many(datasets),
}));

export const datasetsRelations = relations(datasets, ({ one, many }) => ({
  skill: one(skills, { fields: [datasets.skillId], references: [skills.id] }),
  day: one(dayProtocols, { fields: [datasets.dayProtocolId], references: [dayProtocols.id] }),
  block: one(blocks, { fields: [datasets.blockId], references: [blocks.id] }),
  episodes: many(episodes),
}));

export const datasetUploadsRelations = relations(datasetUploads, ({ one }) => ({
  block: one(blocks, { fields: [datasetUploads.blockId], references: [blocks.id] }),
}));

export const datasetUploadChunksRelations = relations(datasetUploadChunks, ({ one }) => ({
  upload: one(datasetUploads, { fields: [datasetUploadChunks.uploadId], references: [datasetUploads.id] }),
}));

export const episodesRelations = relations(episodes, ({ one }) => ({
  dataset: one(datasets, { fields: [episodes.datasetId], references: [datasets.id] }),
}));

export const evaluationReportsRelations = relations(evaluationReports, ({ one }) => ({
  skill: one(skills, { fields: [evaluationReports.skillId], references: [skills.id] }),
}));

// ---------------------------------------------------------------------------
// Types and valibot schemas
// ---------------------------------------------------------------------------

export type CellSelect = typeof cells.$inferSelect;
export type CellInsert = typeof cells.$inferInsert;
export type CollectionSelect = typeof collections.$inferSelect;
export type SkillSelect = typeof skills.$inferSelect;
export type PolicySelect = typeof policies.$inferSelect;
export type DayProtocolSelect = typeof dayProtocols.$inferSelect;
export type BlockSelect = typeof blocks.$inferSelect;
export type DatasetSelect = typeof datasets.$inferSelect;
export type EpisodeSelect = typeof episodes.$inferSelect;
export type DatasetUploadSelect = typeof datasetUploads.$inferSelect;
export type DatasetUploadChunkSelect = typeof datasetUploadChunks.$inferSelect;
export type ExportSelect = typeof exports.$inferSelect;
export type EvaluationReportSelect = typeof evaluationReports.$inferSelect;
export type AuditLogSelect = typeof auditLog.$inferSelect;

export const cellsSelectSchema = createSelectSchema(cells);
export const cellsInsertSchema = createInsertSchema(cells);
export const cellsUpdateSchema = createUpdateSchema(cells);
export const collectionsInsertSchema = createInsertSchema(collections);
export const collectionsUpdateSchema = createUpdateSchema(collections);
export const skillsInsertSchema = createInsertSchema(skills);
export const skillsUpdateSchema = createUpdateSchema(skills);
export const dayProtocolsSelectSchema = createSelectSchema(dayProtocols);

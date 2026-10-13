# GYM · Backend

Bun + Hono API on the symbiosika-framework (`framework/`, git submodule).
See the root `README.md` for setup, `../docs/GLOSSARY.md` for wording.

```bash
bun install
bun run init          # .env with secrets (idempotent)
bun run db:local      # terminal 1: PGlite on localhost:5432 (or: bun run docker:up)
bun run migrate       # framework + app migrations
bun run dev           # terminal 2: API on http://localhost:3000
bun run testuser      # magic-link login for testing@env.local, prints a JWT
bun run seed:demo     # cells, a collection, a skill and a demo block
bun run test:local    # all tests against an embedded PGlite (no setup)
bun run typecheck
```

## Layout

```
src/db/schema.ts            gym_ tables and the JSON documents on them
src/lib/gym/                skills (and policies), day protocols, blocks, datasets, exports, kpis, audit, cells, collections
src/lib/critics/            client for the critics service (../critics), job sync, the compact summary
src/lib/ai/                 model selection (Gemini or framework provider), plan and follow-up proposals
src/lib/storage/            the one gate to stored bytes: database or object store, by GYM_STORAGE_DRIVER
src/routes/tenant/[tenantId]/gym/   authenticated API
src/routes/public/mobile.ts phone views and print view (token / share id)
src/mcp/                    read-only MCP tools for analysts
drizzle-sql/                migrations (bun run app:generate after schema changes)
```

The foundation migration moves tables of the previous data model into the
`gym_legacy` schema before it creates the new ones, so a database that ran the
old app upgrades without manual steps. Drop that schema once the old data is
no longer needed. Migration `0002` replaced sessions with skills and blocks:
every session became a skill and every day protocol got one recording block
carrying what the wizard used to store on the day.

Routes validate and map errors; `lib/` does the work and never knows HTTP.
Every query is tenant-scoped. Every relevant action goes into the audit log
with the skill, day protocol and block it concerns.

## Storage (`src/lib/storage/`)

Every byte the app stores goes through this one module: the scene photos and
the reference images of a plan (`lib/gym/blocks.ts`) and the chunks of a
resumable dataset upload (`lib/gym/dataset-uploads.ts`). Nothing else in the
app writes a file, so an installation has one switch instead of one per
feature.

It is a wrapper, not a storage. The bytes are always written, read and deleted
by the framework (`saveFile`, `getFile`, `deleteFile` of
`@framework/lib/storage`); this module picks the backend from the
configuration and keeps the reference a row has to carry. GYM implements no
storage backend of its own: a backend it needs belongs in the framework, where
every Symbiosika app gets it. A configuration that cannot work, an unknown
driver or an object store without a bucket, is refused at start-up
(`assertStorageConfigured()` in `src/index.ts`) and not on the first upload.

`GYM_STORAGE_DRIVER` picks where new files go:

| driver | where | when |
|---|---|---|
| `db` (default) | the framework's `base_files` table | nothing to set up, the bytes are in the backup of the database |
| `local` | `static/upload` in the container | development only: a second replica does not see the files |
| `s3` | an S3-compatible object store | large data out of the database, reached by every replica. `S3_BUCKET` and, unless the runtime provides them, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`; `S3_ENDPOINT` for anything that is not AWS, plus `S3_REGION`, `S3_PREFIX`, `S3_VIRTUAL_HOSTED_STYLE`. The framework reads them and owns the backend |

A stored file is addressed by a reference, `"<driver>:<name>"`, and that is
what the rows carry (`gym_blocks.scene_image_ref`, the `ref` of a plan
variation, `gym_dataset_upload_chunks.storage_ref`). The driver travels with
the file, so changing the variable keeps everything written before readable and
only sends new files elsewhere.

The datasets themselves go through it too, into the bucket `gym-datasets`. GYM
owns the recorded data: the critics are handed a temporary link to a dataset
for one job or one merge (`shareFile`, `GYM_DATASET_SHARE_TTL_SECONDS`, one
hour by default) and keep nothing. So an export still works months later, and
the analysis service can be wiped or replaced without losing a recording.

## API (under `/api/v1/tenant/:tenantId/gym`, session cookie or Bearer JWT)

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `cells` | cells (POST: admins) |
| PUT / DELETE | `cells/:id` | edit, delete (admins; a cell with day protocols is deactivated instead) |
| GET / POST | `collections` | collections (customer projects) with their skill count |
| PUT / DELETE | `collections/:id` | edit, delete (DELETE: admins) |
| GET | `skills?status&collectionId&limit` | skills with figures (blocks by kind, days, recording episodes, policies, last evaluation), newest activity first |
| POST | `skills` | `{ name, collectionId?, taskDescription?, criticSpecName? }` |
| GET / PUT / DELETE | `skills/:id` | one skill with blocks, exports, policies and evaluations; PUT also `{ status: "archived" }`; DELETE takes blocks, datasets, exports, policies (day protocols stay) |
| GET | `skills/:id/audit` | audit log of the skill |
| GET / PUT | `skills/:id/selection` | every episode of the skill's recording datasets; PUT `{ changes: [{ episodeId, selected }] }` |
| GET / POST | `skills/:id/exports` | exports; POST `{ name? }` saves the selection and returns the manifest zip (`X-Export-Id` header) |
| POST | `skills/:id/exports/dataset` | saves the selection and streams it as **one merged LeRobot dataset** (the critics merge it; `X-Export-Episodes` header) |
| GET | `exports/:id/download` | an earlier export as zip |
| GET / POST | `skills/:id/policies` | the trained versions of a skill; POST `{ name, exportId?, notes?, trainedAt? }` |
| PUT / DELETE | `policies/:id` | edit, delete (evaluations keep their data and lose the reference) |
| GET | `days?from&to&cellId&skillId&limit` | day protocols with their blocks |
| GET / PUT / DELETE | `days/:id` | one day protocol (cell, blocks, times, downtime); PUT `{ notes?, operatorName? }`; DELETE with blocks and datasets |
| POST | `days/:id/close` | close the day and its open blocks |
| GET | `days/:id/audit` | audit log of the day and its blocks |
| POST | `days/:id/downtime` | `{ reason, minutes, at? }` a standstill of the cell, by hand |
| DELETE | `days/:id/downtime/:eventId` | remove one |
| GET | `blocks?skillId&dayProtocolId&kind&limit` | blocks |
| POST | `blocks` | `{ cellId, skillId, kind?, policyId?, date? }` start a block; creates the day protocol when missing, pre-fills from the skill's last block of that kind |
| GET / DELETE | `blocks/:id` | one block; DELETE with its datasets, the day stays |
| PUT | `blocks/:id/brief` | `{ sceneText?, targetEpisodes?, kind?, policyId? }` (kind only while the block has no plan and no dataset) |
| POST | `blocks/:id/import` | `{ skillId }` copy inputs from another skill |
| PUT | `blocks/:id/step` | `{ step }` move the wizard (no selection for an evaluation) |
| POST | `blocks/:id/close` | close the block, revoke the mobile token |
| GET | `blocks/:id/access-token` | token and paths of the mobile views |
| GET / POST / DELETE | `blocks/:id/scene-image` | the scene photo (POST: multipart `file`) |
| POST | `blocks/:id/plan/generate?lang=de\|en` | AI plan proposal (an evaluation plan for an evaluation block) |
| PUT | `blocks/:id/plan` | the edited plan |
| GET / POST / DELETE | `blocks/:id/plan/steps/:stepId/variations/:index/image` | the reference image of a variation (`/generate`, `/from-scene` next to it) |
| POST | `blocks/:id/recording/start` | opens a window (an open one is kept); an evaluation without a plan gets a one-step plan |
| PUT | `blocks/:id/recording/progress` | `{ stepId, delta }` |
| PUT | `blocks/:id/recording/current-step` | `{ stepId }` |
| POST | `blocks/:id/recording/finish` | closes the window, to the upload |
| POST | `blocks/:id/datasets` | multipart `file` (zipped LeRobot dataset, + `name`): upload to the critics and start the run |
| POST | `blocks/:id/follow-up?lang` | AI advice on what to record again |
| GET / DELETE | `datasets/:id` | one dataset with the critics summary, selection and episodes (the run is synced first) |
| GET | `datasets/:id/report` | the mirrored report.json |
| GET | `datasets/:id/report.html?top` | the critics' visual report (proxied) |
| GET | `datasets/:id/markdown?detail` | the run as AI-readable Markdown (proxied) |
| GET | `datasets/:id/files/*` | contact sheets, composites, csv (proxied) |
| GET | `critics` | reachable, health and stored specs of the critics service |
| POST | `critics/specs` | multipart `file` (YAML or JSON spec, + `name`) into the critics service |
| GET | `kpis?from&to&cellId&collectionId&skillId` | key figures (recording episodes, accept rate, teleop time, recorded time, downtime; the evaluations apart with their success rate; the runs whose VLM failed) |
| GET | `ai` | configured AI provider |
| GET / POST / PUT / DELETE | `invitation-codes[/:id]` | invitation codes (admins) |

Public (no login) under `/api/v1/public/gym`:

| Method | Path | Purpose |
|---|---|---|
| GET | `m/:token` | state of the block for the phone views |
| POST / GET | `m/:token/scene-image` | upload / read the scene photo |
| PUT | `m/:token/scene-text` | `{ text }` |
| POST | `m/:token/scene-done` | the phone is done |
| PUT | `m/:token/progress` | `{ stepId, delta }` from the run view |
| PUT | `m/:token/current-step` | `{ stepId }` |
| GET | `m/:token/plan-image/:stepId/:index` | reference image of a plan variation |
| GET | `print/:shareId` | printable day protocol with its blocks |
| GET | `print/:shareId/blocks/:blockId/scene-image` | the scene photo of one of its blocks |

Errors: 400 invalid input, 401 no session, 403 not a member or not an admin,
404 not found, 409 rule violation (no plan yet, block closed, kind fixed, no selection for an evaluation),
410 mobile link expired, 502 the critics service answered with an error,
503 the critics service is unreachable.

## Data critics (`src/lib/critics/`)

The data critics (`critics/` in this repository, run as the `critics` service
of the compose stack) are the single source of truth for analysis. They do not
hold the data: GYM stores every dataset itself (see Storage) and hands them a
temporary link, for a job and again for a merge.
`client.ts` speaks their REST API
(`/jobs`, `/jobs/{id}/report`, `/selection`, `/markdown`,
`/report.html`, `/files`, `/specs`, `/merge`, `/health`), `sync.ts` mirrors a job into
GYM (on read and once a minute by cron), `summary.ts` derives the compact
`CriticsSummary` and one episode row per episode (verdict accept / review /
reject, scores, flags, the reason from selection.json). The full report.json
and selection.json stay on the dataset row. Tests run against a stand-in
server (`fake-server.test-util.ts`) that answers with fixtures of a real run.

## Export zip

`manifest.json` (skill, export, per source dataset the critics dataset name,
job id, spec, selected episode indexes and their compact ranges),
`<dataset>/selection.json` (the critics' selection) and
`<dataset>/summary.json` (GYM's summary).

/**
 * Critics specs as GYM maintains them.
 *
 * A spec says what the critics check for a task (lerobot_critics.spec.models
 * .CriticSpec): the task text and its objects, the success indicators the
 * vision-language model judges, and the technical checks with their weights
 * and thresholds. The critics run with a spec from their own store; GYM names
 * one per skill and gives the operator a place to read, write and remove them:
 * a spec is read back as YAML, edited as text and handed to the service, which
 * validates it. `null` as a spec name means the automatic spec the critics
 * derive from the dataset itself.
 *
 * The critics keep nothing for good, their spec store included: a redeploy
 * may start them with an empty one. So every spec GYM writes is also kept in
 * GYM (`gym_critics_specs`), and a spec the service has lost is put back
 * before it is listed, read or run with (`ensureSpec`). A spec written in the
 * service's own UI is taken over into GYM the next time it is listed or read.
 */
import { and, eq } from "drizzle-orm";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getDb } from "@framework/lib/db/db-connection";
import log from "@framework/lib/log";
import { criticsSpecs } from "../../db/schema";
import { InvalidInputError, NotFoundError } from "../gym/errors";
import { CriticsError, criticsClient, type CriticsHardCriticInfo, type CriticsSpecInfo } from "./client";

/** what the critics service accepts as a file name of a stored spec */
const SPEC_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const MAX_BYTES = 1_000_000;

/** A spec with its text, as the editor shows it. */
export interface CriticsSpecDetail {
  name: string;
  task: string | null;
  robot: string | null;
  /** the stored spec as YAML, the form it is edited in */
  yaml: string;
  spec: Record<string, unknown>;
}

/** A file name or a free text as a spec name: spaces and odd characters become underscores. */
export const specNameOf = (text: string): string =>
  text
    .trim()
    .replace(/\.(ya?ml|json)$/i, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 200);

/** Read a spec from YAML or JSON text and check the little GYM insists on: it is an object with a task instruction. */
function parseSpec(text: string): Record<string, unknown> {
  if (!text.trim()) throw new InvalidInputError("The spec is empty");
  if (text.length > MAX_BYTES) throw new InvalidInputError("The spec is too large");
  let parsed: unknown;
  try {
    // YAML is a superset of JSON, so one parser reads both
    parsed = parseYaml(text);
  } catch (error) {
    throw new InvalidInputError(`The spec could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidInputError("The spec must contain one spec object");
  const spec = parsed as Record<string, unknown>;
  const task = spec.task as Record<string, unknown> | undefined;
  if (!task || typeof task !== "object" || typeof task.instruction !== "string" || !task.instruction.trim()) {
    throw new InvalidInputError("The spec needs a task with an instruction (task.instruction)");
  }
  return spec;
}

const taskOf = (spec: Record<string, unknown>): string | null => {
  const task = spec.task as Record<string, unknown> | undefined;
  return typeof task?.instruction === "string" ? task.instruction.trim() : null;
};
const robotOf = (spec: Record<string, unknown>): string | null => {
  const robot = spec.robot as Record<string, unknown> | undefined;
  return typeof robot?.type === "string" ? robot.type : null;
};

/** GYM's copy of a spec, or null when it has none. */
async function keptSpec(tenantId: string, name: string): Promise<Record<string, unknown> | null> {
  const [row] = await getDb()
    .select({ spec: criticsSpecs.spec })
    .from(criticsSpecs)
    .where(and(eq(criticsSpecs.tenantId, tenantId), eq(criticsSpecs.name, name)));
  return row?.spec ?? null;
}

/** Keep a spec in GYM under `name`, replacing what was kept before. */
async function keep(tenantId: string, name: string, spec: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  await getDb()
    .insert(criticsSpecs)
    .values({ tenantId, name, spec: { ...spec, name }, updatedAt: now })
    .onConflictDoUpdate({ target: [criticsSpecs.tenantId, criticsSpecs.name], set: { spec: { ...spec, name }, updatedAt: now } });
}

/** The spec as the critics hold it, or null when they do not. */
async function criticsSpec(name: string): Promise<Record<string, unknown> | null> {
  try {
    return await criticsClient.spec(name);
  } catch (error) {
    if (error instanceof CriticsError && error.status === 404) return null;
    throw error;
  }
}

/** Store a spec under `name` in the critics service, which validates it, and keep it in GYM; a spec of that name is replaced. */
async function store(tenantId: string, name: string, spec: Record<string, unknown>): Promise<CriticsSpecInfo> {
  if (!SPEC_NAME.test(name)) throw new InvalidInputError("The spec name may only contain letters, digits, '_', '.' and '-'");
  const stored = await criticsClient.putSpec(name, { ...spec, name });
  // what the service read back, defaults filled in: the same spec it runs with
  await keep(tenantId, stored.name, (await criticsSpec(stored.name)) ?? spec);
  return { name: stored.name, task: taskOf(spec), robot: robotOf(spec) };
}

/**
 * Make sure the critics hold the spec `name` before it is run with. A spec the
 * service lost is put back from GYM's copy; one only the service knows is
 * taken over into GYM. False when neither has it: the caller falls back to the
 * automatic spec, as deleting a spec promises.
 */
export async function ensureSpec(tenantId: string, name: string): Promise<boolean> {
  const clean = specNameOf(name);
  const there = await criticsSpec(clean);
  const kept = await keptSpec(tenantId, clean);
  if (there) {
    if (!kept) await keep(tenantId, clean, there);
    return true;
  }
  if (!kept) return false;
  await criticsClient.putSpec(clean, { ...kept, name: clean });
  log.info(`gym: critics spec "${clean}" was missing in the critics service and was put back from GYM`);
  return true;
}

/**
 * The specs of the tenant: every spec GYM keeps and every spec the service
 * holds. The two are brought in line on the way: kept specs the service lost
 * are put back, the service's own are taken over. When the service cannot be
 * reached, GYM's copies are listed as they are.
 */
export async function listSpecs(tenantId: string): Promise<CriticsSpecInfo[]> {
  const kept = await getDb().select().from(criticsSpecs).where(eq(criticsSpecs.tenantId, tenantId));
  let listed: CriticsSpecInfo[];
  try {
    listed = await criticsClient.specs();
  } catch (error) {
    if (!kept.length) throw error;
    log.error(`gym: critics specs could not be listed, showing GYM's copies: ${error instanceof Error ? error.message : String(error)}`);
    return kept.map((k) => ({ name: k.name, task: taskOf(k.spec), robot: robotOf(k.spec) })).sort((a, b) => a.name.localeCompare(b.name));
  }
  const there = new Set(listed.map((s) => s.name));
  const known = new Set(kept.map((k) => k.name));
  const out = [...listed];
  for (const k of kept) {
    if (there.has(k.name)) continue;
    try {
      await criticsClient.putSpec(k.name, { ...k.spec, name: k.name });
      log.info(`gym: critics spec "${k.name}" was missing in the critics service and was put back from GYM`);
    } catch (error) {
      log.error(`gym: critics spec "${k.name}" could not be put back: ${error instanceof Error ? error.message : String(error)}`);
    }
    out.push({ name: k.name, task: taskOf(k.spec), robot: robotOf(k.spec) });
  }
  for (const s of listed) {
    if (known.has(s.name) || s.error) continue;
    const spec = await criticsSpec(s.name).catch(() => null);
    if (spec) await keep(tenantId, s.name, spec);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read a spec file and store it under `nameOverride`, else under the spec's
 * own `name`, else under the file's name. Returns the row as `GET /specs`
 * lists it.
 */
export async function uploadSpec(tenantId: string, file: File, nameOverride?: string): Promise<CriticsSpecInfo> {
  if (!file.size) throw new InvalidInputError("The spec file is empty");
  if (file.size > MAX_BYTES) throw new InvalidInputError("The spec file is too large");
  if (!/\.(ya?ml|json)$/i.test(file.name)) throw new InvalidInputError("Upload the spec as a YAML or JSON file");

  const spec = parseSpec(await file.text());
  const own = typeof spec.name === "string" && spec.name.trim() && spec.name.trim() !== "default" ? spec.name : "";
  return store(tenantId, specNameOf(nameOverride?.trim() || own || file.name), spec);
}

/** A spec written in the editor: YAML or JSON text under a name of the operator's choosing. */
export async function saveSpecText(tenantId: string, name: string, text: string): Promise<CriticsSpecInfo> {
  const clean = specNameOf(name);
  if (!clean) throw new InvalidInputError("The spec needs a name");
  return store(tenantId, clean, parseSpec(text));
}

/** A spec built as an object (the spec wizard): checked like a text and stored under `name`. */
export async function saveSpecObject(tenantId: string, name: string, spec: Record<string, unknown>): Promise<CriticsSpecInfo> {
  const clean = specNameOf(name);
  if (!clean) throw new InvalidInputError("The spec needs a name");
  return store(tenantId, clean, parseSpec(JSON.stringify(spec)));
}

/** Is a spec of this name stored, in the critics service or in GYM's copies? */
export async function specExists(tenantId: string, name: string): Promise<boolean> {
  const clean = specNameOf(name);
  if (await keptSpec(tenantId, clean)) return true;
  return (await criticsClient.specs()).some((s) => s.name === clean);
}

/** One spec with its YAML, for the editor. A spec the service lost is put back from GYM's copy first. */
export async function getSpec(tenantId: string, name: string): Promise<CriticsSpecDetail> {
  const clean = specNameOf(name);
  if (!(await ensureSpec(tenantId, clean))) throw new NotFoundError("The spec does not exist");
  const spec = (await criticsSpec(clean)) ?? (await keptSpec(tenantId, clean));
  if (!spec) throw new NotFoundError("The spec does not exist");
  return { name: clean, task: taskOf(spec), robot: robotOf(spec), yaml: stringifyYaml(spec), spec };
}

/** Remove a spec from the critics service and from GYM's copies. */
export async function deleteSpec(tenantId: string, name: string): Promise<void> {
  const clean = specNameOf(name);
  // gone from the service already (a redeploy): GYM's copy still has to go
  const there = await criticsClient.deleteSpec(clean).then(
    () => true,
    (error) => {
      if (error instanceof CriticsError && error.status === 404) return false;
      throw error;
    },
  );
  const kept = await getDb()
    .delete(criticsSpecs)
    .where(and(eq(criticsSpecs.tenantId, tenantId), eq(criticsSpecs.name, clean)))
    .returning({ id: criticsSpecs.id });
  if (!there && !kept.length) throw new NotFoundError("The spec does not exist");
}

/**
 * The technical checks the critics know, with their default parameters. The
 * form editor renders one row per critic from this list. When the service is
 * not reachable the built-in ids are returned without parameters, so the
 * editor still shows every check.
 */
export const KNOWN_HARD_CRITICS = [
  "integrity",
  "duration",
  "smoothness",
  "tracking_error",
  "duplication",
  "image_quality",
  "sensor_limits",
  "grasp_cycles",
  "tremor",
  "normalization",
  "diversity",
] as const;

export async function hardCritics(): Promise<CriticsHardCriticInfo[]> {
  try {
    const listed = await criticsClient.hardCritics();
    const ids = new Set(listed.map((c) => c.id));
    // a critic GYM knows but an older service does not list stays visible, without parameters
    return [...listed, ...KNOWN_HARD_CRITICS.filter((id) => !ids.has(id)).map((id) => ({ id, description: "", default_params: {} }))];
  } catch {
    return KNOWN_HARD_CRITICS.map((id) => ({ id, description: "", default_params: {} }));
  }
}

/**
 * The starting point for a new spec written as text: the few fields that
 * matter, with the comments that say what they do. Everything else has
 * defaults in the critics, so a minimal spec is the task instruction alone.
 * The form editor starts from its presets instead (frontend/src/utils/spec.ts).
 */
export const specTemplate = (name = "new-spec"): string =>
  [
    `name: ${name}`,
    "task:",
    "  # what the robot is supposed to do, in one sentence: the VLM judges every episode against it",
    '  instruction: "put the red cup on the tray"',
    "  # free text about the setup, for the VLM",
    '  scene: ""',
    "  objects:",
    '    - name: "red cup"',
    "      role: target_object",
    '    - name: "tray"',
    "      role: target_zone",
    "robot:",
    "  # left empty the critics take the robot type from the dataset",
    "  type: null",
    "# what counts as success, judged by the vision-language model (0 to 1, weighted)",
    "soft_critics:",
    "  indicators:",
    "    - id: task_completed",
    '      description: "The cup stands on the tray at the end of the episode."',
    "      weight: 2.0",
    "      gate: true",
    "    - id: clean_execution",
    '      description: "No collisions, no dropped object, no second attempt."',
    "      weight: 1.0",
    "# technical checks on the recorded signals and videos; omit the block to run them all with their defaults",
    "hard_critics:",
    "  - id: smoothness",
    "    weight: 1.0",
    "  - id: image_quality",
    "    weight: 1.0",
    "",
  ].join("\n");

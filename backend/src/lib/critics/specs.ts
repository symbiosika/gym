/**
 * Critics specs as GYM maintains them.
 *
 * A spec says what the critics check for a task (lerobot_critics.spec.models
 * .CriticSpec): the task text and its objects, the success indicators the
 * vision-language model judges, and the technical checks with their weights
 * and thresholds. Specs live in the critics service; GYM names one per skill
 * and gives the operator a place to read, write and remove them: a spec is
 * read back as YAML, edited as text and handed to the service, which
 * validates it. `null` as a spec name means the automatic spec the critics
 * derive from the dataset itself.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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

/** Store a spec under `name` in the critics service; a spec of that name is replaced. */
async function store(name: string, spec: Record<string, unknown>): Promise<CriticsSpecInfo> {
  if (!SPEC_NAME.test(name)) throw new InvalidInputError("The spec name may only contain letters, digits, '_', '.' and '-'");
  const stored = await criticsClient.putSpec(name, { ...spec, name });
  return { name: stored.name, task: taskOf(spec), robot: robotOf(spec) };
}

/**
 * Read a spec file and store it under `nameOverride`, else under the spec's
 * own `name`, else under the file's name. Returns the row as `GET /specs`
 * lists it.
 */
export async function uploadSpec(file: File, nameOverride?: string): Promise<CriticsSpecInfo> {
  if (!file.size) throw new InvalidInputError("The spec file is empty");
  if (file.size > MAX_BYTES) throw new InvalidInputError("The spec file is too large");
  if (!/\.(ya?ml|json)$/i.test(file.name)) throw new InvalidInputError("Upload the spec as a YAML or JSON file");

  const spec = parseSpec(await file.text());
  const own = typeof spec.name === "string" && spec.name.trim() && spec.name.trim() !== "default" ? spec.name : "";
  return store(specNameOf(nameOverride?.trim() || own || file.name), spec);
}

/** A spec written in the editor: YAML or JSON text under a name of the operator's choosing. */
export async function saveSpecText(name: string, text: string): Promise<CriticsSpecInfo> {
  const clean = specNameOf(name);
  if (!clean) throw new InvalidInputError("The spec needs a name");
  return store(clean, parseSpec(text));
}

/** One spec with its YAML, for the editor. */
export async function getSpec(name: string): Promise<CriticsSpecDetail> {
  const spec = await criticsClient.spec(specNameOf(name)).catch((error) => {
    if (error instanceof CriticsError && error.status === 404) throw new NotFoundError("The spec does not exist");
    throw error;
  });
  return { name: specNameOf(name), task: taskOf(spec), robot: robotOf(spec), yaml: stringifyYaml(spec), spec };
}

export async function deleteSpec(name: string): Promise<void> {
  await criticsClient.deleteSpec(specNameOf(name));
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

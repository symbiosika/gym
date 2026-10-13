/**
 * AI proposals for the operator.
 *
 *   proposeRecordingPlan   from the scene brief (photo, text, target) to a
 *                          plan of scene setups with domain randomizations
 *   proposeFollowUp        from the analysis of the day to advice on what to
 *                          record again
 *
 * Both fall back to a deterministic proposal when no model is configured or
 * the model fails, so the wizard always moves on. The operator edits the
 * result anyway.
 */
import { generateObject, NoObjectGeneratedError, type ImagePart, type TextPart } from "ai";
import { valibotSchema } from "@ai-sdk/valibot";
import * as v from "valibot";
import log from "@framework/lib/log";
import { salvageStructuredText } from "@framework/lib/ai";
import type { FollowUpSuggestion, PlanStep, RecordingPlan } from "../../db/schema";
import type { CriticsSummary } from "../critics/summary";
import { getGymModel } from "./model";

export type Language = "de" | "en";

export interface PlanInput {
  cellName: string;
  /** a recording plan (teleoperation) or an evaluation plan (which settings to test a policy on) */
  kind?: "recording" | "evaluation";
  /** for an evaluation: the name of the policy under test, when known */
  policyName?: string | null;
  /** for an evaluation: the variations the skill was recorded with, so the plan can cover them */
  recordedVariations?: string[];
  taskDescription: string;
  sceneText: string;
  targetEpisodes: number;
  image?: { data: Uint8Array; mediaType: string } | null;
  language: Language;
}

const planSchema = v.object({
  summary: v.string(),
  sceneSetup: v.array(v.string()),
  randomizations: v.array(v.string()),
  steps: v.array(
    v.object({
      title: v.string(),
      instructions: v.string(),
      variations: v.array(
        v.object({
          label: v.string(),
          episodes: v.number(),
          /** English edit instruction for the reference image of this variation */
          imagePrompt: v.optional(v.string(), ""),
        }),
      ),
    }),
  ),
});

/** The plan as the model writes it, before normalisation. */
type RawPlan = v.InferInput<typeof planSchema>;

const followUpSchema = v.object({
  summary: v.string(),
  items: v.array(v.object({ title: v.string(), episodes: v.number(), reason: v.string() })),
});

const languageName = (l: Language) => (l === "de" ? "German" : "English");

let seq = 0;
export const newStepId = () => `step-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Normalise a raw plan: step ids, episode sums, drop empty steps. */
export function normalisePlan(raw: RawPlan, source: RecordingPlan["source"]): RecordingPlan {
  const steps: PlanStep[] = raw.steps
    .map((s) => {
      const variations = s.variations
        .map((x) => ({ label: x.label.trim(), episodes: Math.max(0, Math.round(x.episodes)), imagePrompt: (x.imagePrompt ?? "").trim() }))
        .filter((x) => x.label && x.episodes > 0);
      return {
        id: newStepId(),
        title: s.title.trim(),
        instructions: s.instructions.trim(),
        variations,
        episodes: variations.reduce((a, x) => a + x.episodes, 0),
      };
    })
    .filter((s) => s.title && s.episodes > 0);
  return {
    summary: raw.summary.trim(),
    sceneSetup: raw.sceneSetup.map((x) => x.trim()).filter(Boolean),
    randomizations: raw.randomizations.map((x) => x.trim()).filter(Boolean),
    steps,
    source,
    createdAt: new Date().toISOString(),
  };
}

/** Sum of episodes over the steps of a plan. */
export const planEpisodes = (plan: RecordingPlan): number => plan.steps.reduce((a, s) => a + s.episodes, 0);

/** Split a target into a few variations of comparable size. */
function split(target: number, parts: number): number[] {
  const base = Math.floor(target / parts);
  const rest = target - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rest ? 1 : 0)).filter((n) => n > 0);
}

/** Edit instructions of the fallback variations, in the order of their labels. */
const FALLBACK_IMAGE_PROMPTS = [
  "Move the object of the task about 15 cm to a different position on the table.",
  "Rotate the object of the task by about 90 degrees on the spot.",
  "Show the robot arm in a different start pose, further away from the object.",
  "Add two everyday distractor objects next to the object of the task.",
];

/**
 * A sensible plan without a model. For a recording: one setup, four classic
 * randomizations. For an evaluation: the settings the skill was recorded with
 * (or the same four), each with a share of the rollouts.
 */
export function fallbackPlan(input: PlanInput): RecordingPlan {
  const de = input.language === "de";
  if (input.kind === "evaluation") return fallbackEvaluationPlan(input);
  const labels = de
    ? ["Objektposition verschieben", "Objekt gedreht", "Startpose des Roboters variieren", "Störobjekte in der Szene"]
    : ["Shift object position", "Rotate the object", "Vary the robot start pose", "Distractor objects in the scene"];
  const counts = split(Math.max(1, input.targetEpisodes), labels.length);
  const task = input.taskDescription || input.sceneText || (de ? "die Aufgabe" : "the task");
  return normalisePlan(
    {
      summary: de
        ? `${input.targetEpisodes} Episoden für "${task}" in ${input.cellName}, gleichmäßig über vier Variationen verteilt.`
        : `${input.targetEpisodes} episodes for "${task}" in ${input.cellName}, spread evenly over four variations.`,
      sceneSetup: de
        ? ["Szene wie im Foto aufbauen und Kameras prüfen", "Ausgangslage vor jeder Episode wiederherstellen"]
        : ["Set up the scene as in the photo and check the cameras", "Restore the start state before every episode"],
      randomizations: labels,
      steps: [
        {
          title: de ? "Grundaufbau" : "Base setup",
          instructions: de
            ? "Aufbau wie im Foto. Pro Variation die angegebene Anzahl Episoden aufnehmen, dazwischen kurz prüfen, dass die Aufnahme lief."
            : "Set up as in the photo. Record the given number of episodes per variation and check between them that the recording ran.",
          variations: labels.map((label, i) => ({
            label,
            episodes: counts[i] ?? 0,
            imagePrompt: FALLBACK_IMAGE_PROMPTS[i] ?? "",
          })),
        },
      ],
    },
    "fallback",
  );
}

function fallbackEvaluationPlan(input: PlanInput): RecordingPlan {
  const de = input.language === "de";
  const recorded = (input.recordedVariations ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 8);
  const labels = recorded.length
    ? recorded
    : de
      ? ["Objektposition wie aufgenommen", "Objekt gedreht", "Neue Objektposition", "Störobjekte in der Szene"]
      : ["Object position as recorded", "Rotated object", "Unseen object position", "Distractor objects in the scene"];
  const counts = split(Math.max(1, input.targetEpisodes), labels.length);
  const task = input.taskDescription || input.sceneText || (de ? "die Aufgabe" : "the task");
  const policy = input.policyName ? ` (${input.policyName})` : "";
  return normalisePlan(
    {
      summary: de
        ? `${input.targetEpisodes} Durchläufe der Policy${policy} für "${task}" in ${input.cellName}, über die aufgenommenen Settings verteilt.`
        : `${input.targetEpisodes} rollouts of the policy${policy} for "${task}" in ${input.cellName}, spread over the recorded settings.`,
      sceneSetup: de
        ? ["Szene wie im Foto aufbauen und Kameras prüfen", "Ausgangslage vor jedem Durchlauf wiederherstellen", "Nicht eingreifen, solange der Durchlauf läuft"]
        : ["Set up the scene as in the photo and check the cameras", "Restore the start state before every rollout", "Do not intervene while a rollout runs"],
      randomizations: labels,
      steps: [
        {
          title: de ? "Evaluierung" : "Evaluation",
          instructions: de
            ? "Aufbau wie im Foto. Pro Setting die angegebene Anzahl Durchläufe starten und jeden als Episode aufzeichnen."
            : "Set up as in the photo. Start the given number of rollouts per setting and record every one as an episode.",
          variations: labels.map((label, i) => ({ label, episodes: counts[i] ?? 0, imagePrompt: "" })),
        },
      ],
    },
    "fallback",
  );
}

/**
 * The plan of a block the operator starts without one: one step, one
 * variation, the target number of episodes, the task as it stands. It carries
 * no scene setups and no randomizations, so the recording view counts plain
 * episodes against the target and nothing else is claimed.
 */
export function plainPlan(input: PlanInput): RecordingPlan {
  const de = input.language === "de";
  const evaluation = input.kind === "evaluation";
  // today's scene text is what the operator just wrote, so it goes first; the
  // skill's task is the fallback and, when both are there, the instruction
  const scene = input.sceneText.trim();
  const task = input.taskDescription.trim();
  const label = scene || task || (de ? "die Aufgabe" : "the task");
  const episodes = Math.max(1, input.targetEpisodes);
  const short = label.length > 300 ? `${label.slice(0, 297)}...` : label;
  return normalisePlan(
    {
      summary: de
        ? `${episodes} ${evaluation ? "Durchläufe" : "Episoden"} für "${short}" in ${input.cellName}, ohne Fahrplan.`
        : `${episodes} ${evaluation ? "rollouts" : "episodes"} for "${short}" in ${input.cellName}, without a plan.`,
      sceneSetup: [],
      randomizations: [],
      steps: [
        {
          title: evaluation ? (de ? "Durchläufe" : "Rollouts") : de ? "Aufnahme" : "Recording",
          instructions: scene && task && scene !== task ? task : "",
          variations: [{ label: short, episodes, imagePrompt: "" }],
        },
      ],
    },
    "plain",
  );
}

const EVALUATION_SYSTEM = `You are the planning assistant of a robotics gym. A trained robot policy is about to be evaluated in a
cell: the operator sets up the scene, starts the policy, and every rollout is recorded as an episode and later judged. From
a photo, a short description of the scene and the settings the skill was recorded with you propose an evaluation plan: which
scene settings to test the policy on and how many rollouts per setting. Guidance:
- The variations across all steps must add up to the target number of rollouts.
- Cover the settings the skill was recorded with first, then add a few unseen ones (new positions, distractors, lighting)
  so the result says how far the policy generalises. Mark unseen settings as such in their label.
- Prefer 1 to 3 steps, each with 2 to 6 variations. Keep instructions short and concrete for a person at the cell, and
  say that the operator must not intervene while a rollout runs.
- Do not invent equipment that is not mentioned or visible.
- "imagePrompt" of a variation: one English sentence that tells an image-editing model how to change the scene photo so
  that it shows this setting built up. Describe only what changes. Leave it empty when the setting cannot be seen in a photo.`;

const PLAN_SYSTEM = `You are the planning assistant of a robotics gym. Operators teleoperate a robot in a cell to record
imitation-learning demonstrations (episodes). From a photo and a short description of the scene you propose a
recording plan for the next hours: which scene setups to build, which domain randomizations to apply and how many
episodes to record per variation. Guidance:
- The variations across all steps must add up to the target number of episodes.
- Prefer 2 to 5 steps, each with 2 to 5 variations. Keep instructions short and concrete for a person at the cell.
- Randomize what matters for generalisation: object positions and orientations, start poses, distractors, lighting,
  backgrounds, object instances. Only propose what is plausible for the scene you see or read about.
- Do not invent equipment that is not mentioned or visible.
- "imagePrompt" of a variation: one English sentence that tells an image-editing model how to change the scene photo so
  that it shows this variation built up (e.g. "Move the cup 15 cm to the left and rotate it so the handle faces the
  robot."). Describe only what changes; camera, robot and table stay as they are. Leave it empty when the variation
  cannot be seen in a photo.`;

export async function proposeRecordingPlan(input: PlanInput): Promise<RecordingPlan> {
  const model = getGymModel();
  if (!model) return fallbackPlan(input);

  const evaluation = input.kind === "evaluation";
  const text = [
    `Cell: ${input.cellName}`,
    input.taskDescription ? `Task of the skill: ${input.taskDescription}` : "",
    input.sceneText ? `Operator's description of today's scene: ${input.sceneText}` : "",
    evaluation && input.policyName ? `Policy under test: ${input.policyName}` : "",
    evaluation && input.recordedVariations?.length ? `Settings the skill was recorded with: ${input.recordedVariations.join("; ")}` : "",
    evaluation ? `Target: ${input.targetEpisodes} rollouts today.` : `Target: ${input.targetEpisodes} episodes today.`,
    `Write all texts in ${languageName(input.language)}.`,
  ]
    .filter(Boolean)
    .join("\n");
  const content: (TextPart | ImagePart)[] = [{ type: "text", text }];
  if (input.image) content.push({ type: "image", image: input.image.data, mediaType: input.image.mediaType });

  try {
    const { object } = await generateObject({
      model,
      schema: valibotSchema(planSchema),
      system: evaluation ? EVALUATION_SYSTEM : PLAN_SYSTEM,
      messages: [{ role: "user", content }],
    });
    return rebalance(normalisePlan(object, "ai"), input.targetEpisodes);
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      const salvaged = salvageStructuredText(planSchema, error.text);
      if (salvaged) return rebalance(normalisePlan(salvaged, "ai"), input.targetEpisodes);
    }
    log.error(`gym: plan proposal failed, using fallback: ${error instanceof Error ? error.message : String(error)}`);
    return fallbackPlan(input);
  }
}

/** Scale the variation counts so the plan hits the target; the model is often off by a few. */
function rebalance(plan: RecordingPlan, target: number): RecordingPlan {
  const total = planEpisodes(plan);
  if (!total || total === target || target <= 0) return plan;
  const factor = target / total;
  const steps = plan.steps.map((s) => {
    const variations = s.variations.map((x) => ({ ...x, episodes: Math.max(1, Math.round(x.episodes * factor)) }));
    return { ...s, variations, episodes: variations.reduce((a, x) => a + x.episodes, 0) };
  });
  // put the rounding remainder on the largest variation
  let diff = target - steps.reduce((a, s) => a + s.episodes, 0);
  if (diff !== 0 && steps.length) {
    const all = steps.flatMap((s) => s.variations);
    const largest = all.reduce((a, b) => (b.episodes > a.episodes ? b : a));
    largest.episodes = Math.max(1, largest.episodes + diff);
    for (const s of steps) s.episodes = s.variations.reduce((a, x) => a + x.episodes, 0);
  }
  return { ...plan, steps };
}

export interface FollowUpInput {
  language: Language;
  targetEpisodes: number | null;
  plan: RecordingPlan | null;
  /** the critics' summaries of the day's datasets */
  analyses: CriticsSummary[];
  /** the critics' AI-readable Markdown reports (summary level), when the service delivered them */
  reports?: string[];
}

export function fallbackFollowUp(input: FollowUpInput): FollowUpSuggestion {
  const de = input.language === "de";
  const episodes = input.analyses.reduce((a, x) => a + x.episodes, 0);
  const good = input.analyses.reduce((a, x) => a + x.counts.accept, 0);
  const bad = input.analyses.reduce((a, x) => a + x.counts.reject, 0);
  const missing = input.targetEpisodes != null ? Math.max(0, input.targetEpisodes - good) : bad;
  const items: FollowUpSuggestion["items"] = [];
  if (missing > 0) {
    items.push({
      title: de ? "Fehlende gute Episoden nachholen" : "Make up the missing good episodes",
      episodes: missing,
      reason: de
        ? `${good} von ${episodes} Episoden wurden akzeptiert${input.targetEpisodes != null ? `, Ziel sind ${input.targetEpisodes}` : ""}.`
        : `${good} of ${episodes} episodes were accepted${input.targetEpisodes != null ? `, the target is ${input.targetEpisodes}` : ""}.`,
    });
  }
  return {
    summary: items.length
      ? de
        ? `${bad} Episoden wurden von den Critics abgelehnt. Es fehlen noch ${missing} akzeptierte Episoden.`
        : `${bad} episodes were rejected by the critics. ${missing} accepted episodes are still missing.`
      : de
        ? "Das Tagesziel ist erreicht, keine weitere Aufnahme nötig."
        : "The daily target is reached, no further recording needed.",
    items,
    source: "fallback",
    createdAt: new Date().toISOString(),
  };
}

const FOLLOW_UP_SYSTEM = `You advise the operator of a robotics gym after a recording day was analysed by the lerobot-critics
service. From the recording plan, the target and the critics' results (accept / review / reject per episode, the flags
that decided the verdicts, the recording-session profile with its indicators and advice, run-level findings such as
LOW_DIVERSITY) you say what to record again: which scene setups or variations, how many episodes and why, and what to
change at the rig before recording. Be concrete and brief. Propose nothing when the target is met and the quality is fine.`;

export async function proposeFollowUp(input: FollowUpInput): Promise<FollowUpSuggestion> {
  const model = getGymModel();
  if (!model) return fallbackFollowUp(input);
  const prompt = [
    `Target episodes: ${input.targetEpisodes ?? "not set"}`,
    input.plan ? `Plan: ${JSON.stringify({ summary: input.plan.summary, steps: input.plan.steps.map((s) => ({ title: s.title, variations: s.variations })) })}` : "",
    `Critics summaries: ${JSON.stringify(
      input.analyses.map((a) => ({
        dataset: a.datasetName,
        episodes: a.episodes,
        counts: a.counts,
        flagCounts: a.flagCounts,
        datasetFlags: a.datasetFlags,
        profileHeadline: a.profileHeadline,
        attention: a.profile.filter((i) => i.status === "bad" || i.status === "warn").map((i) => ({ label: i.label, status: i.status, display: i.display, unit: i.unit, action: i.action })),
        switchable: a.switchable,
      })),
    )}`,
    ...(input.reports ?? []).map((r, i) => `Critics report ${i + 1} (Markdown):\n${r.slice(0, 12000)}`),
    `Write all texts in ${languageName(input.language)}.`,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const { object } = await generateObject({ model, schema: valibotSchema(followUpSchema), system: FOLLOW_UP_SYSTEM, prompt });
    return { ...object, source: "ai", createdAt: new Date().toISOString() };
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      const salvaged = salvageStructuredText(followUpSchema, error.text);
      if (salvaged) return { ...salvaged, source: "ai", createdAt: new Date().toISOString() };
    }
    log.error(`gym: follow-up proposal failed, using fallback: ${error instanceof Error ? error.message : String(error)}`);
    return fallbackFollowUp(input);
  }
}

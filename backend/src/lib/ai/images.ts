/**
 * Reference images for the variations of a recording plan.
 *
 * The operator gets one picture per variation: the scene photo of the day,
 * edited so that it shows the variation already built up. Gemini's image
 * model ("Nano Banana") does the editing; it is reached over the native
 * REST endpoint because the image output does not travel through the
 * OpenAI-compatible chat endpoint the plan proposals use.
 *
 *   GEMINI_API_KEY=...                     enables the feature
 *   GEMINI_IMAGE_MODEL=gemini-2.5-flash-image (default)
 *
 * Without a key the feature is simply off: images are optional, nothing in
 * the wizard depends on them (see lib/gym/day-protocols.ts).
 */
import log from "@framework/lib/log";
import type { PlanStep, PlanVariation } from "../../db/schema";

const GEMINI_API_BASE_URL = process.env.GEMINI_API_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";

/** Timeout of one image request; the operator waits in front of it. */
const REQUEST_TIMEOUT_MS = 120_000;

export const getGymImageModel = (): string => process.env.GEMINI_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;

/** Image generation needs a Gemini key; the framework provider has no image model. */
export const isImageGenerationEnabled = (): boolean => !!process.env.GEMINI_API_KEY;

export interface GeneratedImage {
  data: Uint8Array;
  mediaType: string;
}

export class ImageGenerationError extends Error {}

/**
 * The instruction the image model gets: what to change, and what has to stay
 * as it is. Uses the plan's own `imagePrompt` when the planner proposed one,
 * otherwise the operator's texts of the step and the variation.
 */
export function variationImagePrompt(step: Pick<PlanStep, "title" | "instructions">, variation: Pick<PlanVariation, "label" | "imagePrompt">): string {
  const what = (variation.imagePrompt ?? "").trim() || [step.title, step.instructions, variation.label].map((s) => s.trim()).filter(Boolean).join(". ");
  return [
    "Edit this photo of a robot training cell so that it shows the scene after this change has been built up:",
    what,
    "Keep the camera angle, the framing, the robot, the table and the lighting identical to the input photo; change only what the instruction asks for.",
    "Photorealistic, same resolution and style as the input. Output only the edited image.",
  ].join("\n");
}

const errorMessage = (body: unknown): string => {
  const message = (body as { error?: { message?: string } } | null)?.error?.message;
  return typeof message === "string" && message ? message : "the image model returned no image";
};

/**
 * Edit the scene photo with the given instruction. Throws
 * `ImageGenerationError` when no key is configured, the model refuses or the
 * answer carries no image.
 */
export async function editSceneImage(scene: { data: Uint8Array; mediaType: string }, prompt: string): Promise<GeneratedImage> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ImageGenerationError("No image model configured (GEMINI_API_KEY)");
  const model = getGymImageModel();
  const url = `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }, { inlineData: { mimeType: scene.mediaType || "image/jpeg", data: Buffer.from(scene.data).toString("base64") } }],
      },
    ],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`gym: image generation request failed: ${message}`);
    throw new ImageGenerationError(`The image model could not be reached: ${message}`);
  }

  const json = (await response.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  } | null;
  if (!response.ok) {
    log.error(`gym: image generation failed with HTTP ${response.status}`);
    throw new ImageGenerationError(errorMessage(json));
  }

  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((p) => p.inlineData?.data);
  if (!image?.inlineData?.data) {
    const reason = json?.candidates?.[0]?.finishReason ?? json?.promptFeedback?.blockReason ?? "";
    const text = parts.map((p) => p.text ?? "").join(" ").trim().slice(0, 200);
    throw new ImageGenerationError([`The image model returned no image`, reason, text].filter(Boolean).join(": "));
  }
  return { data: new Uint8Array(Buffer.from(image.inlineData.data, "base64")), mediaType: image.inlineData.mimeType || "image/png" };
}

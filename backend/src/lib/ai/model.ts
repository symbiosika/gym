/**
 * The language model the gym uses for plan proposals and follow-up advice.
 *
 * Gemini is the preferred model because it reads the scene photo well. It is
 * reached through Google's OpenAI-compatible endpoint with the provider that
 * ships with the framework, so no extra dependency is needed:
 *
 *   GEMINI_API_KEY=...            enables Gemini
 *   GEMINI_MODEL=gemini-2.5-flash (default)
 *
 * Without a Gemini key the framework's central provider is used
 * (`AI_PROVIDER` + key, e.g. Mistral). Without any provider the AI features
 * degrade to deterministic fallbacks (see ./plan.ts); the wizard never blocks.
 */
import type { LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getStandardModel, isAiEnabled } from "@framework/lib/ai";

const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export type GymAiProvider = "gemini" | "framework" | "none";

export function getGymAiProvider(): GymAiProvider {
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (isAiEnabled()) return "framework";
  return "none";
}

export const isGymAiEnabled = (): boolean => getGymAiProvider() !== "none";

/** The model to use, or `null` when no provider is configured. */
export function getGymModel(): LanguageModel | null {
  switch (getGymAiProvider()) {
    case "gemini":
      return createOpenAICompatible({
        name: "gemini",
        baseURL: GEMINI_BASE_URL,
        apiKey: process.env.GEMINI_API_KEY ?? "",
        supportsStructuredOutputs: true,
      }).chatModel(process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL);
    case "framework":
      return getStandardModel();
    default:
      return null;
  }
}

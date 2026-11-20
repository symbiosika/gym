/**
 * Spreading a skill's paraphrases over the episodes of a prompt.
 *   bun run test:local ./src/lib/gym/prompts.test.ts
 */
import { describe, expect, test } from "bun:test";
import { assignVariants, effectivePrompt, exportPromptsOf } from "./prompts";

const rows = (prompt: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ key: String(from + i), prompt }));

describe("paraphrases", () => {
  test("the episodes of a prompt take the variants in turn, the prompt itself first when it is kept", () => {
    const out = assignVariants([...rows("a", 6), ...rows("b", 2, 6)], { a: { variants: ["a1", "a2"], keepOriginal: true } });
    expect([...out.values()]).toEqual(["a", "a1", "a2", "a", "a1", "a2", "b", "b"]);
  });

  test("without the original, the variants substitute the prompt", () => {
    const out = assignVariants(rows("a", 4), { a: { variants: ["x", "y"], keepOriginal: false } });
    expect([...out.values()]).toEqual(["x", "y", "x", "y"]);
  });

  test("an export lists only what differs from the recorded prompt, per dataset", () => {
    const sets = [
      { dataset: { id: "d1" }, episodes: [{ index: 0, task: "a", promptOverride: null }, { index: 1, task: "a", promptOverride: null }] },
      { dataset: { id: "d2" }, episodes: [{ index: 4, task: "dummy", promptOverride: "a" }] },
    ];
    const out = exportPromptsOf(sets, { a: { variants: ["a1"], keepOriginal: true } });
    expect(out.get("d1")).toEqual({ "1": "a1" });
    expect(out.get("d2")).toEqual({ "4": "a" });
    expect(exportPromptsOf(sets, {}, false).get("d1")).toBeUndefined();
    expect(effectivePrompt({ task: "dummy", promptOverride: null })).toBe("dummy");
  });
});

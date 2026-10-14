import { describe, expect, test } from "bun:test";
import { formatEpisodeSelection, parseEpisodeSelection } from "./episode-selection";

describe("episode picks like print ranges", () => {
  test("reads ranges and single episodes, in any order, each once", () => {
    expect(parseEpisodeSelection("1-3,6,8")).toEqual([1, 2, 3, 6, 8]);
    expect(parseEpisodeSelection(" 8, 6 ,1-3, 2 ")).toEqual([1, 2, 3, 6, 8]);
    expect(parseEpisodeSelection("0")).toEqual([0]);
    expect(parseEpisodeSelection("")).toEqual([]);
  });

  test("refuses what is not a pick", () => {
    expect(() => parseEpisodeSelection("a")).toThrow();
    expect(() => parseEpisodeSelection("5-2")).toThrow();
    expect(() => parseEpisodeSelection("0-9999")).toThrow();
  });

  test("writes the shortest pick back", () => {
    expect(formatEpisodeSelection([8, 1, 2, 3, 6, 2])).toBe("1-3,6,8");
    expect(formatEpisodeSelection([])).toBe("");
  });
});

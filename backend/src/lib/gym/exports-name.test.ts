import { describe, expect, test } from "bun:test";
import { exportFileStem } from "./exports";

describe("exportFileStem", () => {
  test("the person's name, made safe for a file and a dataset folder", () => {
    expect(exportFileStem("Pick from shelf v4 / right arm", "Pick", "2026-11-19T08:00:00Z")).toBe("Pick_from_shelf_v4_right_arm");
  });
  test("without a name: the skill and the day", () => {
    expect(exportFileStem(undefined, "Cup to tray", "2026-11-19T08:00:00Z")).toBe("Cup_to_tray-2026-11-19");
    expect(exportFileStem("   ", "Cup to tray", "2026-11-19T08:00:00Z")).toBe("Cup_to_tray-2026-11-19");
  });
});

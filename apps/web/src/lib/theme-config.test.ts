import { describe, expect, it } from "vitest";

import {
  CANVAS_THEMES,
  THEME_IDS,
  THEME_OPTIONS,
  contrastText,
  themeOption,
} from "./theme-config";

describe("theme configuration", () => {
  it("ships light, dark, and rust themes", () => {
    expect(THEME_IDS).toEqual(["light", "dark", "rust"]);
    expect(THEME_OPTIONS).toHaveLength(3);
    expect(themeOption("rust").accent).toBe("#B7410E");
  });

  it("defines a complete canvas palette for every theme", () => {
    for (const id of THEME_IDS) {
      const palette = CANVAS_THEMES[id];
      expect(palette.background).toMatch(/^#[0-9a-f]{6}$/i);
      expect(palette.text).toMatch(/^#[0-9a-f]{6}$/i);
      expect(palette.defaultShapeFill).toMatch(/^#[0-9a-f]{6}$/i);
      expect(palette.selection).not.toBe(palette.background);
    }
    expect(CANVAS_THEMES.rust.defaultShapeFill).toBe("#B7410E");
  });

  it("chooses readable ink for notes and labels", () => {
    expect(contrastText("#f4c95d")).toBe("#0f172a");
    expect(contrastText("#140b07")).toBe("#fffaf5");
  });
});

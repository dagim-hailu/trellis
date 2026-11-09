export const THEME_IDS = ["light", "dark", "rust"] as const;
export type ThemeName = (typeof THEME_IDS)[number];

export const THEME_STORAGE_KEY = "trellis.theme.v1";

export interface ThemeOption {
  id: ThemeName;
  label: string;
  description: string;
  swatch: string;
  surface: string;
  accent: string;
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  {
    id: "light",
    label: "Light",
    description: "Clean daylight surfaces with a deep sky accent.",
    swatch: "#f3f6fb",
    surface: "#ffffff",
    accent: "#0369a1",
  },
  {
    id: "dark",
    label: "Dark",
    description: "The midnight studio with a cool cyan accent.",
    swatch: "#0b1222",
    surface: "#111a2c",
    accent: "#38bdf8",
  },
  {
    id: "rust",
    label: "Rust",
    description: "Warm oxidized earth tones built around #B7410E.",
    swatch: "#1a0d08",
    surface: "#2a1710",
    accent: "#B7410E",
  },
] as const;

export interface CanvasTheme {
  background: string;
  grid: string;
  emptyHint: string;
  text: string;
  textBlockFill: string;
  selection: string;
  selectionFill: string;
  handleFill: string;
  handleStroke: string;
  marqueeFill: string;
  marqueeStroke: string;
  noteShadow: string;
  defaultShapeFill: string;
  defaultShapeStroke: string;
  defaultNoteFill: string;
  defaultNoteStroke: string;
  cursorLabelText: string;
  /** Radial wash painted over the flat background. */
  gridGlow: string;
  /** Alignment guide lines while dragging. */
  snapGuide: string;
  /** Fill behind an image node before it decodes. */
  imagePlaceholder: string;
}

export const CANVAS_THEMES: Readonly<Record<ThemeName, CanvasTheme>> = {
  light: {
    background: "#eef3fa",
    grid: "rgba(30, 41, 59, 0.075)",
    emptyHint: "rgba(51, 65, 85, 0.58)",
    text: "#0f172a",
    textBlockFill: "rgba(255, 255, 255, 0.7)",
    selection: "#0369a1",
    selectionFill: "rgba(3, 105, 161, 0.08)",
    handleFill: "#ffffff",
    handleStroke: "#0369a1",
    marqueeFill: "rgba(3, 105, 161, 0.1)",
    marqueeStroke: "#0369a1",
    noteShadow: "rgba(15, 23, 42, 0.14)",
    defaultShapeFill: "#0ea5e9",
    defaultShapeStroke: "#bae6fd",
    defaultNoteFill: "#f6d365",
    defaultNoteStroke: "#d9b34c",
    cursorLabelText: "#07111f",
    gridGlow: "rgba(14, 165, 233, 0.10)",
    snapGuide: "#0369a1",
    imagePlaceholder: "rgba(148, 163, 184, 0.28)",
  },
  dark: {
    background: "#080d1a",
    grid: "rgba(148, 163, 184, 0.09)",
    emptyHint: "rgba(226, 232, 240, 0.46)",
    text: "#f8fafc",
    textBlockFill: "rgba(15, 23, 42, 0.58)",
    selection: "#38bdf8",
    selectionFill: "rgba(56, 189, 248, 0.08)",
    handleFill: "#0b1424",
    handleStroke: "#7dd3fc",
    marqueeFill: "rgba(56, 189, 248, 0.12)",
    marqueeStroke: "#38bdf8",
    noteShadow: "rgba(0, 0, 0, 0.24)",
    defaultShapeFill: "#6366f1",
    defaultShapeStroke: "#c7d2fe",
    defaultNoteFill: "#f4c95d",
    defaultNoteStroke: "#d4a73c",
    cursorLabelText: "#07111f",
    gridGlow: "rgba(99, 102, 241, 0.16)",
    snapGuide: "#38bdf8",
    imagePlaceholder: "rgba(51, 65, 85, 0.55)",
  },
  rust: {
    background: "#140b07",
    grid: "rgba(238, 194, 166, 0.1)",
    emptyHint: "rgba(247, 235, 225, 0.5)",
    text: "#f7ebe1",
    textBlockFill: "rgba(36, 21, 14, 0.6)",
    selection: "#e0703c",
    selectionFill: "rgba(183, 65, 14, 0.15)",
    handleFill: "#2a1710",
    handleStroke: "#f2c4a8",
    marqueeFill: "rgba(183, 65, 14, 0.18)",
    marqueeStroke: "#e79a72",
    noteShadow: "rgba(0, 0, 0, 0.32)",
    defaultShapeFill: "#B7410E",
    defaultShapeStroke: "#f0c3a7",
    defaultNoteFill: "#e9b873",
    defaultNoteStroke: "#c08a49",
    cursorLabelText: "#140b07",
    gridGlow: "rgba(183, 65, 14, 0.20)",
    snapGuide: "#e0703c",
    imagePlaceholder: "rgba(68, 36, 22, 0.55)",
  },
};

export const FILL_SWATCHES: ReadonlyArray<{ name: string; value: string }> = [
  { name: "Indigo", value: "#6366f1" },
  { name: "Sky", value: "#0ea5e9" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Leaf", value: "#22c55e" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Rose", value: "#ef4444" },
  { name: "Blossom", value: "#ec4899" },
  { name: "Sticky", value: "#f4c95d" },
  { name: "Paper", value: "#f8fafc" },
  { name: "Slate", value: "#94a3b8" },
  { name: "Rust", value: "#B7410E" },
];

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

export function themeOption(theme: ThemeName): ThemeOption {
  return THEME_OPTIONS.find((option) => option.id === theme) ?? THEME_OPTIONS[1]!;
}

export function readStoredTheme(): ThemeName | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeName(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function applyThemeToDocument(theme: ThemeName): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = CANVAS_THEMES[theme].background;
}

export function contrastText(background: string): string {
  const normalized = background.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return "#0f172a";
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.58 ? "#0f172a" : "#fffaf5";
}

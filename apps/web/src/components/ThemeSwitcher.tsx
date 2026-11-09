"use client";

import { useTheme } from "@/components/ThemeProvider";
import { THEME_OPTIONS } from "@/lib/theme-config";

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className={`theme-switcher ${compact ? "compact" : ""}`}
      role="group"
      aria-label="Color theme"
    >
      {THEME_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`theme-option ${theme === option.id ? "active" : ""}`}
          aria-label={`${option.label} theme`}
          aria-pressed={theme === option.id}
          title={`${option.label}: ${option.description}`}
          onClick={() => setTheme(option.id)}
        >
          <span
            className="theme-swatch"
            style={{
              background: `linear-gradient(135deg, ${option.swatch} 0 50%, ${option.accent} 50% 100%)`,
            }}
            aria-hidden="true"
          />
          <span className="theme-option-label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

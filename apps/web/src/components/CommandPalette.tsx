"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { CanvasNode } from "@trellis/shared";

import { rankByFuzzy } from "@/lib/fuzzy";
import type { ThemeName } from "@/lib/theme-config";

export interface PaletteCommand {
  id: string;
  label: string;
  group: "Insert" | "Navigate" | "View" | "Canvas";
  hint?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  nodes: readonly CanvasNode[];
  onJumpToNode: (nodeId: string) => void;
  onSetTheme: (theme: ThemeName) => void;
  onToggleGrid: () => void;
  onExport: () => void;
}

const THEME_COMMANDS: Array<{ theme: ThemeName; label: string }> = [
  { theme: "dark", label: "Switch theme: Dark" },
  { theme: "light", label: "Switch theme: Light" },
  { theme: "rust", label: "Switch theme: Rust" },
];

/**
 * Spotlight-style command palette (Cmd/Ctrl+K).
 *
 * Searches three things in one ranked list: static commands, every node's text
 * on the current canvas, and theme switches. Node results jump the viewport to
 * the matching node, which is the fastest way to find something on a large
 * board.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
  nodes,
  onJumpToNode,
  onSetTheme,
  onToggleGrid,
  onExport,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const allCommands = useMemo<PaletteCommand[]>(() => {
    const themeCommands: PaletteCommand[] = THEME_COMMANDS.map((entry) => ({
      id: `theme-${entry.theme}`,
      label: entry.label,
      group: "View",
      run: () => onSetTheme(entry.theme),
    }));
    const viewCommands: PaletteCommand[] = [
      {
        id: "toggle-grid",
        label: "Toggle grid",
        group: "View",
        hint: "G",
        run: onToggleGrid,
      },
      {
        id: "export-png",
        label: "Export viewport as PNG",
        group: "Canvas",
        run: onExport,
      },
    ];
    return [...commands, ...viewCommands, ...themeCommands];
  }, [commands, onExport, onSetTheme, onToggleGrid]);

  const results = useMemo(() => {
    if (query.trim().length === 0) {
      return allCommands.slice(0, 12).map((item) => ({ kind: "command" as const, item }));
    }

    const commandHits = rankByFuzzy(query, allCommands, (item) => item.label, 8).map((hit) => ({
      kind: "command" as const,
      item: hit.item,
    }));

    const nodeHits = rankByFuzzy(
      query,
      nodes.filter((node) => node.text.trim().length > 0),
      (node) => node.text,
      10,
    ).map((hit) => ({ kind: "node" as const, item: hit.item }));

    return [...commandHits, ...nodeHits];
  }, [allCommands, nodes, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  const activate = (index: number): void => {
    const entry = results[index];
    if (!entry) return;
    if (entry.kind === "command") {
      entry.item.run();
    } else {
      onJumpToNode(entry.item.id);
    }
    onClose();
  };

  return (
    <div
      className="palette-scrim"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div className="palette glass-panel glass-glow" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="Search commands and canvas text…"
          aria-label="Search commands"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((current) => Math.min(results.length - 1, current + 1));
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(0, current - 1));
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              activate(activeIndex);
            }
          }}
        />
        <div className="palette-results">
          {results.length === 0 ? (
            <div className="palette-empty">No matches for “{query}”</div>
          ) : (
            results.map((entry, index) => {
              const label =
                entry.kind === "command" ? entry.item.label : entry.item.text.slice(0, 70);
              const hint =
                entry.kind === "command"
                  ? entry.item.hint
                  : `${entry.item.type} · jump to node`;
              return (
                <button
                  key={entry.kind === "command" ? entry.item.id : entry.item.id}
                  type="button"
                  className={`palette-item ${index === activeIndex ? "active" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => activate(index)}
                >
                  <span>{label}</span>
                  {hint ? <span className="palette-item-hint">{hint}</span> : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

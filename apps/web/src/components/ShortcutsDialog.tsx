"use client";

import { useEffect, useRef } from "react";

interface ShortcutsDialogProps {
  onClose: () => void;
}

const SECTIONS: ReadonlyArray<{
  title: string;
  shortcuts: ReadonlyArray<{ keys: string; action: string }>;
}> = [
  {
    title: "Create & edit",
    shortcuts: [
      { keys: "V", action: "Select tool" },
      { keys: "H", action: "Hand / pan tool" },
      { keys: "R", action: "Rectangle" },
      { keys: "O", action: "Ellipse" },
      { keys: "T", action: "Text block" },
      { keys: "N", action: "Sticky note" },
      { keys: "Enter", action: "Edit selected text or note" },
      { keys: "Delete", action: "Delete selection" },
    ],
  },
  {
    title: "Selection",
    shortcuts: [
      { keys: "Shift + click", action: "Add or remove from selection" },
      { keys: "Drag empty canvas", action: "Marquee select" },
      { keys: "⌘/Ctrl + A", action: "Select all visible objects" },
      { keys: "Arrows", action: "Nudge 1 px" },
      { keys: "Shift + Arrows", action: "Nudge 10 px" },
      { keys: "Shift + drag corner", action: "Resize while keeping proportion" },
    ],
  },
  {
    title: "Move & arrange",
    shortcuts: [
      { keys: "Space + drag", action: "Pan the canvas" },
      { keys: "Scroll", action: "Zoom at pointer" },
      { keys: "⌘/Ctrl + + / −", action: "Zoom in / out" },
      { keys: "⌘/Ctrl + 0", action: "Reset to 100%" },
      { keys: "Shift + 1", action: "Fit all objects" },
      { keys: "⌘/Ctrl + C / V", action: "Copy / paste selection" },
      { keys: "⌘/Ctrl + D", action: "Duplicate selection" },
    ],
  },
  {
    title: "History & help",
    shortcuts: [
      { keys: "⌘/Ctrl + Z", action: "Undo" },
      { keys: "⌘/Ctrl + Shift + Z", action: "Redo" },
      { keys: "?", action: "Open this shortcut sheet" },
      { keys: "Esc", action: "Cancel / clear selection" },
    ],
  },
];

export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" || (event.key === "?" && !event.metaKey && !event.ctrlKey)) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="shortcuts-scrim"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
      >
        <header className="shortcuts-header">
          <div>
            <p className="eyebrow">Canvas</p>
            <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="shortcuts-grid">
          {SECTIONS.map((section) => (
            <div key={section.title} className="shortcut-section">
              <h3>{section.title}</h3>
              <dl>
                {section.shortcuts.map((shortcut) => (
                  <div key={`${section.title}-${shortcut.keys}`} className="shortcut-row">
                    <dt>
                      <kbd>{shortcut.keys}</kbd>
                    </dt>
                    <dd>{shortcut.action}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

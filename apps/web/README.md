# @trellis/web

Next.js App Router client. It deliberately does not try to be a full design tool; it is the minimal shell needed to exercise and extend the realtime canvas contract.

## Responsibilities

- Email/password sign-in and workspace/document navigation
- Canvas 2D renderer (shapes, sticky notes, text blocks, layers, remote cursors)
- Light, Dark (first-run default), and Rust (`#B7410E`) themes, persisted per browser and applied to both UI and Canvas palettes
- Yjs document model and local undo/redo
- `y-indexeddb` offline persistence and `y-websocket` sync
- Zustand transient state: tool, camera, active layer, cursor; cursor updates are consumed by the renderer without React subscriptions
- Multi-select/marquee, group drag, resize handles, copy/paste/duplicate, keyboard nudging
- Layer add/rename/reorder/delete/reassign and a fill/text/stroke inspector
- Zoom-to-fit/reset, PNG export, share-link copy, and an in-app shortcut sheet
- Presence through Yjs awareness
- Viewer read-only UI

## Run

```bash
# optional; local defaults match the standard dev ports
cp .env.example .env.local

pnpm --filter @trellis/web dev
```

The root `pnpm dev` builds shared packages and starts all apps. Open `http://localhost:3100` so the browser origin matches `WEB_ORIGIN`.

Build:

```bash
pnpm --filter @trellis/web build
pnpm --filter @trellis/web start
```

Tests / type check:

```bash
pnpm --filter @trellis/web test
pnpm --filter @trellis/web typecheck
```

## Usage

1. Sign in with the seeded demo account or create an account.
2. Create a workspace if the account does not have one.
3. Create a canvas or open an existing one.
4. Use `V` select, `H` pan, `R` rectangle, `O` ellipse, `T` text, `N` sticky note; scroll to zoom; double-click text/notes to edit; `?` opens the full shortcut sheet.
5. Shift-click or drag a marquee to select multiple objects; drag selected objects as a group; use the orange selection handles to resize a single object (Shift preserves proportion).
6. Add, rename, reorder, hide, or delete layers from the Layers panel; new objects use the active layer.
7. Use the inspector to change fill, text size, stroke, layer, and z-order, or to duplicate/delete the selection.
8. Switch between Light, Dark, and Rust from the theme control in the header; the choice survives reloads. Use Export for a PNG of the current view and Share to copy the canvas URL.

Edits are local-first. Disconnecting persists them in IndexedDB and reconnects automatically.

## Canvas internals

- `src/canvas/model.ts` — Yjs layout, node/layer transactions, copy insertion, validators
- `src/canvas/geometry.ts` — marquee/resize/handle/viewport math (Vitest-covered)
- `src/canvas/renderer.ts` — themed Canvas 2D, DPR handling, grid, notes, selection, cursors, PNG export
- `src/canvas/controller.ts` — pointer/keyboard interactions, multi-select, drag coalescing, copy/paste, layers, zoom
- `src/canvas/store.ts` — Zustand vanilla store for transient UI
- `src/lib/theme-config.ts` — three theme palettes and canvas defaults
- `src/components/` — shell, layer panel, selection inspector, zoom, theme, shortcut sheet
- `src/components/CanvasEngine.tsx` — provider/IDB/room setup and UI chrome

See [the canvas contract](../../docs/canvas-contract.md).

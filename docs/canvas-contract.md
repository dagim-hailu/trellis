# Canvas Yjs contract

This contract is shared by `apps/web` and the types in `packages/shared/src/canvas.ts`. The realtime server does not interpret it: every client update is opaque Yjs bytes.

## Root types

The room is the Yjs document. Each `DocumentDto.id` is the room name and WebSocket path segment.

```ts
const nodes = doc.getMap<Y.Map<unknown>>("nodes");
const layers = doc.getMap<Y.Map<unknown>>("layers");
const components = doc.getMap<Y.Map<unknown>>("components");
```

Using deterministic top-level map names avoids concurrent root-type initialization races. These maps are plain Yjs types inside the same CRDT; there is no second document and no server merge logic. The `components` map is additive, so older documents without it remain valid.

## Nodes

`nodes` is keyed by node UUID. Each value is a `Y.Map` with:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Matches the map key. |
| `type` | `"rect" \| "ellipse" \| "text" \| "note" \| "path" \| "image" \| "connector" \| "frame"` | Renderer branch. |
| `layerId` | string | Must reference a layer id. |
| `x`, `y` | number | World-space top-left. |
| `width`, `height` | number | Clamped to 8..10,000. |
| `zIndex` | number | Order inside its layer. |
| `fill` | `#rrggbb` | Shape fill. |
| `stroke` | `#rrggbb` | Shape stroke. |
| `strokeWidth` | number | 0..24. |
| `text` | string | Text block content, max 20,000 chars. |
| `fontSize` | number | 8..160. |
| `createdBy` | string | User id. |
| `updatedAt` | number | Client millisecond timestamp. |
| `parentFrameId` | string (optional) | Owning frame for frame children. |
| `componentId` | string (optional) | Document-local component membership. |
| `componentSourceNodeId` | string (optional) | Source identity used to link component instances. |
| `layoutDirection` | `"horizontal" \| "vertical"` (optional) | Last explicit auto-layout direction stored on a frame. |
| `layoutGap`, `layoutPadding` | number (optional) | Spacing values from the last frame auto-layout operation. |
| `layoutAlignment` | `"start" \| "center" \| "end"` (optional) | Cross-axis alignment from the last auto-layout operation. |

Image nodes may store a protected `assetId` and aspect ratio; freehand paths store world-space points; connectors store endpoints and optional node/port references. Frames are ordinary nodes with optional clipping and aspect settings. Optional fields are read defensively and absent values preserve the legacy document behavior.

Creating, moving, or deleting a node is a normal Yjs mutation, typically inside a transaction with the local origin:

```ts
doc.transact(() => {
  const yNode = new Y.Map();
  yNode.set("id", id);
  // ...all fields...
  nodes.set(id, yNode);
}, LOCAL_ORIGIN);
```

`Y.UndoManager` in the client tracks only `LOCAL_ORIGIN`, so remote edits are never undone by this user's undo command.

## Layers

`layers` is keyed by deterministic layer UUIDs. Each value is a `Y.Map` with:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Matches map key. |
| `name` | string | Max 80 chars. |
| `visible` | boolean | Hidden layers are not drawn/hit-tested. |
| `zIndex` | number | Layer draw order; lower draws first. |

`layer-default` is created on first load with deterministic fields. Concurrent initialization converges because it writes the same key with the same values.

The renderer's complete order is: visible layers sorted by `(zIndex, name)`, then nodes in each layer sorted by `zIndex`; highlight/cursor overlays are painted afterwards. A hidden layer's nodes remain in the CRDT.

Layer operations are ordinary local-origin transactions too: adding, renaming, reordering (normalized `zIndex`), hiding, deleting with node fallback, and moving a node between layers. The active layer is transient UI state and intentionally not persisted in Yjs.

## Components and frame auto-layout

`components` maps a document-local component id to a Y.Map containing `id`, `name`, and an array of source `nodeIds`. Source nodes and copied instances carry the same `componentId`; each has a `componentSourceNodeId` that identifies the corresponding source object. Source identity is preserved when a component is inserted or duplicated, while each copied node has a new node id and its own position/layer/z-order.

The current component MVP propagates edits to shared appearance and content fields (including fill, stroke, text, and typography) to matching source/instance objects. Geometry placement, layer assignment, z-order, and frame ownership remain instance-local. Components are scoped to one document and do not yet support variants, detach/restore workflows, or cross-document publishing.

Frame auto-layout is an explicit client operation, not a render-time layout engine. It sorts direct frame children deterministically by their current y, x, z-order, and id; excludes connector nodes; and writes resulting x/y coordinates plus the selected layout settings in one local-origin Yjs transaction. This keeps rendering, hit-testing, export, and collaboration based on the same persisted geometry. Child content or size changes do not currently trigger automatic reflow.

## Themes

Light, Dark, and Rust (`#B7410E`) change the UI shell and the Canvas palette (background, grid, text, selection chrome, handles, and defaults for newly created objects). Dark is the first-run default. The choice is stored under `trellis.theme.v1` in `localStorage` and is browser-local; it never enters the Yjs document or presence. Existing node fills are preserved across theme changes.

## Presence / awareness

`y-protocols/awareness` state is never written to PostgreSQL. Shape:

```ts
interface PresenceState {
  user: { id: string; name: string; color: `#rrggbb` };
  cursor: { x: number; y: number } | null; // world coordinates
  selection: string[];                     // node ids
}
```

The provider sets `user` once, updates `cursor` on pointer movement (coalesced to animation frames), and publishes the selected node-id array. The Canvas renderer reads awareness directly and schedules a repaint; cursor movement is also kept in a per-document Zustand vanilla store. No React component subscribes to cursor state, so cursor traffic causes zero React renders. Selection changes do update the lightweight inspector because they are deliberate editing actions.

## Object selection and transformation

Selection is local UI state mirrored into awareness. Shift-click toggles ids; a marquee adds every visible node whose bounds intersect the marquee; group drag writes all selected positions in one local-origin Yjs transaction. Resize is only exposed for a single selection and writes `x/y/width/height` through the normal CRDT node map. The text-edit modal is a single transient DOM control, not a DOM node per shape.

Remote cursor positions are converted through the local camera and drawn on the same Canvas. Text blocks are painted with Canvas 2D, not DOM nodes. The only per-document DOM editor is a single modal `<textarea>` used one at a time for editing a text block.

## Local persistence and sync

- `y-indexeddb` uses the namespace `trellis:<documentId>`.
- The WebSocket provider connects only after IndexedDB's `whenSynced` resolves (or a 2.5s fallback if storage is blocked), so local offline edits merge before network sync.
- The server sends sync step 1 immediately after join and answers the client's sync step 1 with sync step 2. A client's reply to server step 1 is validated and persisted before it is acknowledged through the fan-out path.
- On reconnect, y-websocket performs a full state-vector exchange. The server hydrates the document from PostgreSQL when a room is cold, so a node restart does not lose committed edits.
- Binary frames use the standard y-websocket message format; no custom canvas-specific framing exists.

## Client editing rules

- `viewer` role: the client disables shape/text manipulation, layer mutation, and undo controls, while share/export remain available; the server independently rejects writes.
- Shapes, sticky notes, text, and layers are Yjs data only; no API call is made per edit.
- Shapes are not rendered as DOM nodes.
- Dirty snapshots are server-owned and irrelevant to client rendering.
- The server has no knowledge of node fields; extending the canvas contract does not require a backend change unless new data must be validated by an API endpoint.

## Changing the contract safely

1. Add optional fields and tolerate missing values in the renderer.
2. Never reuse a field name with a different type; Yjs will keep conflicting values and the renderer must remain defensive.
3. On a breaking rewrite, introduce new top-level map/name keys rather than mutating the meaning of old data, and migrate clients through a version gate.
4. Add a server-side change only when the field needs validation, querying, or access control. Canvas content is deliberately not queried by the backend.

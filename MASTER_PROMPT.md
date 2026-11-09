# Trellis Product Evolution: Master Agent Prompt

## Your role and mission

You are a senior product engineer with strong design-tool, frontend, collaboration, and UX expertise. Evolve Trellis into an original local-first creative workspace that joins the approachable, template-led creation of Canva with the precision and collaborative design workflows associated with Figma.

The product promise is: **one collaborative canvas, two ways in**. A new user can start with a useful template and clear guidance; an experienced designer can work precisely with layers, reusable building blocks, layout controls, and collaboration. Keep Trellis's strongest differentiator—local-first editing and offline recovery—at the center.

Do not copy either product's branded assets, visual identity, proprietary copy, or distinctive screen designs. Learn from general product patterns and create an unmistakably original Trellis experience.

## Approval gate and working rules

1. The user asked to review the plan and this master prompt before implementation. Do not edit application code, schemas, migrations, tests, or the README until the user explicitly approves the master prompt and implementation scope.
2. The selected delivery scope is the **first product-quality milestone** below. Treat the longer-term parity ideas as a roadmap, not a requirement to build every feature in one pass.
3. Before implementation, inspect the current project again. The initial `git status` probe failed because the supplied folder did not appear to contain a `.git` repository. Do not assume Git history or use destructive cleanup. Preserve all existing files and user changes.
4. Do not read, print, or copy `.env` or other secrets. Use `.env.example` only when configuration documentation is needed.
5. Follow existing pnpm/Turborepo, TypeScript, React, Yjs, Fastify, Postgres, Redis, and CSS patterns. Avoid new dependencies unless a concrete requirement cannot be met with the existing stack.
6. Make precise, tested changes. Report errors explicitly; do not make a failed request look successful or silently swallow important failures.
7. Keep existing documents and offline clients compatible. Evolve the shared Yjs contract additively, tolerate absent optional fields, and avoid migrations when the change belongs in Yjs document state.
8. After implementation, update the README and any directly affected contract/runbook docs. Run the smallest relevant tests during development, then the repo's build, type-check, and test commands if feasible.

## Product and codebase baseline

### Architecture observed in this checkout

- Monorepo managed by pnpm and Turborepo; root scripts include `pnpm test`, `pnpm typecheck`, and `pnpm build`.
- `apps/web` is a Next.js App Router application using React, Zustand, Yjs, `y-indexeddb`, and `y-websocket`.
- The editor is implemented in `apps/web/src/components/CanvasEngine.tsx`, with interaction logic in `apps/web/src/canvas/controller.ts`, document/model operations in `apps/web/src/canvas/model.ts`, rendering in `apps/web/src/canvas/renderer.ts`, geometry and snapping helpers alongside them, and shared UI state in `apps/web/src/canvas/store.ts`.
- Rendering is a **layered canvas stack** (grid, scene, overlay), not literally one canvas element. Keep that separation unless a tested design requires a change.
- `packages/shared/src/canvas.ts` defines the persisted node/layer contract. Yjs uses top-level `nodes` and `layers` maps. The browser persists local state in IndexedDB and synchronizes standard Yjs protocol updates through the realtime service.
- `apps/realtime` manages WebSocket rooms, awareness/presence, Redis Pub/Sub, and PostgreSQL persistence. `packages/db` owns PostgreSQL repositories and migrations. `apps/api` is the Fastify control plane. `packages/auth` provides password/JWT primitives.
- PostgreSQL stores incremental updates and snapshots; Redis distributes realtime room events. Role checks distinguish owner, editor, and viewer.
- Themes are CSS-variable based (Light, Dark, Rust) in `apps/web/src/app/globals.css` and `apps/web/src/lib/theme-config.ts`.

### Features that already exist

Do not duplicate these. Verify behavior and wire/polish them where needed:

- Authentication, workspaces, documents, workspace invitations, and owner/editor/viewer access.
- Yjs convergence, local IndexedDB persistence, realtime presence/cursors, online collaborator following, and ephemeral cursor chat.
- Canvas tools for select/pan, rectangles, ellipses, text, sticky notes, freehand paths, frames, connectors, and comments.
- Multi-select, marquee, group drag, resizing, copy/paste/duplicate, undo/redo, layers, z-order, snapping, zoom, keyboard shortcuts, and command palette.
- Fill/text/stroke selection controls, three themes, PNG export, and share-link copying.
- A simple AI co-designer with mind-map, arrange, and summarize actions; its provider may use a configured endpoint or a built-in heuristic provider.
- Pinned comments are already represented in `CanvasComments.tsx`, persisted through API/database comment routes, and can be replied to and resolved. They are **not a live Yjs feature**: the editor fetches comments through REST and currently loads them on entry rather than providing a complete realtime review/notification workflow.
- The shared canvas type and renderer already support image, path, connector, and frame nodes; node fields include rotation, opacity, locking, frame parenting, and clipping.

### Existing backend capabilities that are not integrated into the product UI

- A template catalog and transactional template-to-document route exist in `apps/api/src/lib/templates.ts` and `apps/api/src/routes/template-routes.ts`. The web API client already has `listTemplates` and `createDocumentFromTemplate` wrappers in `apps/web/src/lib/api.ts`, but the dashboard does not call them or offer a template gallery.
- Asset metadata, upload-intent/byte-upload/confirm/list/content routes, workspace-role checks, a local disk storage adapter, image-node rendering, and an asynchronous image cache already exist. However, the web UI has no complete upload/asset-browser insertion workflow and no corresponding typed asset API helpers.
- **Important image-auth pitfall:** protected asset content requires an authenticated API request, while the current canvas image cache uses `new Image()` with a URL and cannot attach the bearer token. Before exposing images, solve authenticated loading/export safely (for example, fetch authorized bytes and use a managed object URL, or use another reviewed design). Preserve canvas export behavior and revoke object URLs. Do not just insert a URL that fails authorization.
- There is no reusable component/instance library, component variants, shared design-token library, auto-layout engine, page/artboard navigation, or prototype interaction/playback system.

### Documentation mismatch and production backlog

The root `README.md` is an infrastructure-heavy early description. Its closing product description says there is no image upload or comments, while current source already contains asset APIs/image rendering and comment UI/API. It also under-describes templates, AI, paths, frames, connectors, and other editor behavior. Reconcile documentation with source; do not trust the README's feature list without verification.

The existing operations docs call out two important production gaps:

1. Refresh-token rotation/revocation and live-socket expiry enforcement.
2. Durable outbox/sequence-gap detection around Redis Pub/Sub.

Record and prioritize these accurately, but do not let them silently expand the first UI/product milestone. Reassess their risk before shipping production-facing auth or collaboration changes.

## Research synthesis: Figma and Canva

Research was conducted against official product/help pages on 2026-11-09. Product availability and plan-specific details can change; use the cited material for patterns, not as a promise of feature equivalence.

### Figma: precision and systemization

- Figma Design centers work on a direct-manipulation canvas, with precise object/layer organization, contextual controls, keyboard-driven editing, and collaboration.
- Auto Layout makes frames and components respond to content changes and supports responsive/adaptable layouts.
- Components have a main definition and linked instances; libraries can share components, styles, and variables across files and let teams review/apply published updates.
- Prototyping is connected to the design canvas: frames can be connected into flows, previewed inline, or presented/shared for testing.
- Figma's broader workflow also connects design work to developer inspection/handoff.
- FigJam demonstrates a lighter collaborative whiteboard experience. Trellis already has several comparable canvas/whiteboard primitives, so focus on a coherent workflow rather than adding duplicate widgets.

Official sources:

- [Figma Design](https://www.figma.com/design/)
- [FigJam](https://www.figma.com/figjam/)
- [Figma Auto Layout guide](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout-in-Figma)
- [Figma components guide](https://help.figma.com/hc/en-us/articles/360038662654-Guide-to-components-in-Figma)
- [Figma libraries guide](https://help.figma.com/hc/en-us/articles/360041051154-Guide-to-libraries-in-Figma)
- [Figma prototype preview/presentation](https://help.figma.com/hc/en-us/articles/360040318013-Play-your-prototypes)
- [Figma keyboard use](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard)
- [Figma Dev Mode](https://www.figma.com/dev-mode/)

### Canva: approachable creation and publishing

- Canva's Visual Suite connects multiple content formats (including Docs, Whiteboards, Sheets, Presentations, social content, video, and websites) and emphasizes creation-to-publishing workflows.
- The front door is approachable: users can begin from a task, template, or editable block rather than needing to understand a blank canvas and design vocabulary first.
- Drag-and-drop editing, searchable assets/templates, brand management, and ready-made layouts reduce setup cost.
- Team collaboration includes visible collaborators, comments/task coordination, and offline creation/synchronization.
- Canva's product pages describe AI-assisted creation as part of the workflow and highlight media editing, conversion, and reuse.

Official sources:

- [Canva Visual Suite](https://www.canva.com/visual-suite/)
- [Canva features](https://www.canva.com/features/)

### Product conclusions

- Borrow the *principles*: a clear first-run path, template discovery, direct manipulation, contextual precision, reusable systems, and visible collaboration state.
- Do not imitate the competitors' branded layouts. Trellis should keep a distinctive visual language and make its local-first/offline story legible.
- The key UX bridge is **progressive disclosure**: let a beginner complete a useful task with a template and a few obvious actions; expose precise properties and advanced controls when they select an object or choose a more detailed mode.
- Preserve the canvas as the core rather than trying to recreate every document format or paid stock-media ecosystem in this milestone.

## Gaps and delivery priorities

### First product-quality milestone (approved planning scope; implementation still requires explicit go-ahead)

1. **Template-led onboarding**
   - Integrate the existing catalog into the authenticated dashboard.
   - Let users start blank or browse/search a small set of useful starter canvases.
   - Show each template's purpose and a visual/structured preview; allow an optional title before instantiation.
   - Keep workspace selection, auth expiry, loading, API errors, and mobile layouts correct.
   - Ensure empty states lead to a useful action, not an unexplained blank canvas.

2. **End-to-end image assets**
   - Add typed web API methods for the existing upload-intent, authenticated byte PUT, confirm, list, and content workflows.
   - Provide a usable upload/drop-insertion path and an asset shelf/library in the editor; insert an image node with stable asset identity and sensible aspect-preserving placement.
   - Respect server MIME/size constraints and editor/viewer permissions. Validate client-side for usability, while treating the API as authority.
   - Implement authenticated image decoding/cache lifecycle as called out above; handle errors visibly and ensure export can still draw the image.
   - Consider clear loading/failure states, upload progress, retry, and accessible text/labels. Do not leave orphaned uploaded bytes without a known cleanup policy.

3. **Focused in-document component and auto-layout foundation**
   - Add a small, genuinely useful MVP: create a component from selected nodes, insert/reuse an instance, and keep instances connected to their source within the same document. Cross-document publishing, a team library, complex variant/property systems, and full design tokens are future work unless implementation evidence shows a smaller safe step.
   - Add simple horizontal/vertical auto-layout for frame children with a clear, minimal set of spacing/padding/alignment controls.
   - Choose a deterministic layout model that stays consistent for rendering, hit-testing, selection, comments, snapping, export, and multi-client edits. Avoid writing derived state during paint. Test concurrent/old-document compatibility.
   - Keep data contract changes additive/optional and preserve documents lacking the new fields.

4. **Approachable editor UX**
   - Establish clear hierarchy across dashboard, editor header, canvas tools, asset/component area, and contextual properties.
   - Reduce tool-bar cognitive load through grouping, labels/tooltips, visible shortcuts, and sensible defaults; keep precision controls discoverable without forcing them on novices.
   - Improve empty/first-use states, template previews, contextual hints, loading/error feedback, and understandable local/offline/synced status.
   - Keep side panels usable on smaller screens (collapsible/overlay rather than inaccessible or clipped). Respect keyboard navigation, focus visibility, semantic labels, contrast, and reduced-motion preferences.
   - Preserve Light/Dark/Rust themes and ensure all new surfaces work in all three.

5. **Original differentiator: Canvas Compass**
   - Add a small, local-first guide that connects a user's intent (for example, a brainstorm, flow, or visual draft) to the next helpful action. For the first milestone, keep it concrete and bounded: contextual next-step hints in the dashboard/editor, suggested templates/tools, and a lightweight preflight checklist that can identify practical issues such as missing images, unreadable low-contrast text, objects outside a selected frame, or unresolved review comments.
   - Any checks should be explainable, non-blocking, and actionable; do not upload document content to an AI service. Leave broader automated design critique for later.

6. **README refresh**
   - Explain the product in user-facing terms, list current and newly delivered capabilities accurately, and document architecture, setup, storage/offline behavior, tests, and known limitations.
   - Correct the stale "no comments/no image" statements, distinguish existing infrastructure from finished UI workflows, and clearly retain the token and Pub/Sub reliability backlog.
   - Keep technical runbook details that remain accurate; update only related docs when contracts or operations behavior changes.

### Explicitly deferred follow-up roadmap

Do not silently expand the first milestone to all of the following. Record as follow-up opportunities and only implement after a separate scope decision:

- Cross-document/team component libraries, variants, variable modes, typography/effect styles, and brand kits.
- Multiple pages/artboards, responsive breakpoints/constraints beyond the initial frame auto-layout, prototype flows/interactions/device playback, and developer handoff/inspect views.
- SVG/PDF/PPTX import/export, multi-format publishing, video/Docs/Sheets/web-site creation, stock asset integrations, and large third-party plugin ecosystems.
- Live comments, mentions, notifications, reviewer assignments, and review/version-history workflows.
- Refresh-token rotation/revocation/live-session enforcement and durable Redis outbox/gap detection, after confirming production requirements.

## Architecture guidance

- Reuse `apps/web/src/lib/api.ts`, the existing template endpoints, asset endpoints, storage adapter, shared DTOs, image-node model, and renderer rather than creating duplicate routes or storage layers.
- Keep browser UI concerns in `apps/web/src/components` and `apps/web/src/app`; keep canvas operations/rendering in the existing `apps/web/src/canvas` modules.
- If adding Yjs fields or maps, update `packages/shared/src/canvas.ts` and the read/write/clone/serialize paths in `apps/web/src/canvas/model.ts`; test round-trips and compatibility with missing optional values.
- Use `CanvasController` and existing `LOCAL_ORIGIN`/undo patterns for user-authored mutations. Do not mutate shared document state during a render.
- Keep API authorization, storage MIME/size constraints, and workspace scoping authoritative on the server. Reuse Postgres migrations/repositories only for durable server-owned metadata; use Yjs for collaboratively authored canvas state.
- Add focused Vitest coverage for pure layout/component logic and web API helpers; add Fastify injection coverage for any changed endpoint behavior. Preserve existing canvas geometry/Yjs round-trip, API, auth, and realtime tests.
- Document any change to the Yjs contract in `docs/canvas-contract.md`; document operational changes in `docs/operations.md`.

## Definition of done

- The approved milestone is implemented end-to-end, not represented by inert buttons or mock data.
- Existing login, workspace/document creation, sharing, viewer read-only behavior, offline editing, reconnect, undo/redo, comments, and themes continue to work.
- Template creation and image insertion work through the actual API/storage path and show useful errors when unavailable.
- Component/auto-layout operations converge across clients and remain undoable where appropriate.
- The user-facing flow is understandable with keyboard and mouse, and the editor remains usable at narrow viewport widths.
- Tests cover the important new behavior; run and report the relevant test/typecheck/build results.
- README and related docs accurately describe what is shipped versus deferred.
- Summarize changed files, behavior, verification, limitations, and follow-up work. Do not claim parity with Figma or Canva.

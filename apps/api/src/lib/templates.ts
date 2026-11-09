import * as Y from "yjs";

import {
  CANVAS_LAYERS,
  CANVAS_NODES,
  DEFAULT_LAYER_ID,
  DEFAULT_LAYER_NAME,
  createCanvasNode,
  type CanvasNode,
  type NodeType,
  type TemplateDto,
  type TemplateId,
} from "@trellis/shared";

/**
 * Starter canvas templates.
 *
 * A template is a pure function from a seed id to a list of nodes. Nothing is
 * stored in the database: the catalogue is code, so adding a template is a
 * deploy, not a migration. Instantiation builds a real Y.Doc, applies the
 * nodes, and encodes the result as a snapshot, which is exactly what a room
 * would have produced had a user drawn the template by hand.
 */

export interface TemplateSeed {
  id: TemplateId;
  name: string;
  description: string;
  build: () => CanvasNode[];
}

interface NodeSpec {
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fill?: string;
  stroke?: string;
  fontSize?: number;
  parentFrameId?: string;
}

const SYSTEM_AUTHOR = "00000000-0000-4000-8000-000000000000";

function makeNodes(specs: NodeSpec[]): CanvasNode[] {
  return specs.map((spec, index) =>
    createCanvasNode({
      id: `tpl-${index.toString().padStart(3, "0")}`,
      type: spec.type,
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: spec.height,
      createdBy: SYSTEM_AUTHOR,
      layerId: DEFAULT_LAYER_ID,
      zIndex: index + 1,
      ...(spec.text !== undefined ? { text: spec.text } : {}),
      ...(spec.fill !== undefined ? { fill: spec.fill } : {}),
      ...(spec.stroke !== undefined ? { stroke: spec.stroke } : {}),
      ...(spec.fontSize !== undefined ? { fontSize: spec.fontSize } : {}),
      ...(spec.parentFrameId !== undefined ? { parentFrameId: spec.parentFrameId } : {}),
    }),
  );
}

/** A root note plus four branches, laid out radially. */
function buildMindMap(): CanvasNode[] {
  const centre = { x: 460, y: 320 };
  const branches = [
    { label: "Goals", dx: 0, dy: -230 },
    { label: "Audience", dx: 320, dy: 0 },
    { label: "Constraints", dx: 0, dy: 230 },
    { label: "Ideas", dx: -320, dy: 0 },
  ];
  const specs: NodeSpec[] = [
    {
      type: "ellipse",
      x: centre.x - 110,
      y: centre.y - 55,
      width: 220,
      height: 110,
      text: "Central topic",
      fill: "#6366f1",
      fontSize: 20,
    },
  ];
  for (const branch of branches) {
    specs.push({
      type: "note",
      x: centre.x + branch.dx - 90,
      y: centre.y + branch.dy - 45,
      width: 180,
      height: 90,
      text: branch.label,
      fill: "#f4c95d",
      fontSize: 18,
    });
  }
  return makeNodes(specs);
}

/** Three columns of cards under a header frame. */
function buildKanban(): CanvasNode[] {
  const columns = ["Backlog", "In progress", "Done"];
  const specs: NodeSpec[] = [
    {
      type: "frame",
      x: 80,
      y: 80,
      width: 960,
      height: 620,
      text: "Sprint board",
      fill: "#0f172a",
      stroke: "#334155",
    },
  ];
  columns.forEach((column, columnIndex) => {
    const columnX = 120 + columnIndex * 310;
    specs.push({
      type: "text",
      x: columnX,
      y: 130,
      width: 260,
      height: 40,
      text: column,
      fontSize: 22,
    });
    for (let cardIndex = 0; cardIndex < 3; cardIndex += 1) {
      specs.push({
        type: "note",
        x: columnX,
        y: 190 + cardIndex * 130,
        width: 260,
        height: 110,
        text: `${column} card ${cardIndex + 1}`,
        fill: "#f4c95d",
        fontSize: 16,
      });
    }
  });
  return makeNodes(specs);
}

/** A 4x3 grid of empty sticky notes for rapid ideation. */
function buildBrainstormGrid(): CanvasNode[] {
  const specs: NodeSpec[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      specs.push({
        type: "note",
        x: 100 + column * 230,
        y: 100 + row * 200,
        width: 200,
        height: 170,
        text: "",
        fill: "#f4c95d",
        fontSize: 16,
      });
    }
  }
  return makeNodes(specs);
}

/** Four retro columns: went well, to improve, actions, blockers. */
function buildRetroBoard(): CanvasNode[] {
  const columns = ["Went well", "To improve", "Actions", "Blockers"];
  const specs: NodeSpec[] = [
    {
      type: "frame",
      x: 60,
      y: 60,
      width: 1120,
      height: 640,
      text: "Retrospective",
      fill: "#0f172a",
      stroke: "#334155",
    },
  ];
  columns.forEach((column, index) => {
    const columnX = 100 + index * 270;
    specs.push({
      type: "text",
      x: columnX,
      y: 110,
      width: 240,
      height: 40,
      text: column,
      fontSize: 20,
    });
    for (let slot = 0; slot < 2; slot += 1) {
      specs.push({
        type: "note",
        x: columnX,
        y: 170 + slot * 220,
        width: 240,
        height: 190,
        text: "",
        fill: "#f4c95d",
        fontSize: 16,
      });
    }
  });
  return makeNodes(specs);
}

/** Start, decision, process, end, wired together with connectors. */
function buildFlowchart(): CanvasNode[] {
  const specs: NodeSpec[] = [
    {
      type: "ellipse",
      x: 120,
      y: 300,
      width: 180,
      height: 90,
      text: "Start",
      fill: "#22c55e",
      fontSize: 18,
    },
    {
      type: "rect",
      x: 380,
      y: 290,
      width: 200,
      height: 110,
      text: "Process step",
      fill: "#6366f1",
      fontSize: 18,
    },
    {
      type: "rect",
      x: 660,
      y: 290,
      width: 200,
      height: 110,
      text: "Decision?",
      fill: "#eab308",
      fontSize: 18,
    },
    {
      type: "ellipse",
      x: 940,
      y: 300,
      width: 180,
      height: 90,
      text: "End",
      fill: "#ef4444",
      fontSize: 18,
    },
  ];
  return makeNodes(specs);
}

export const TEMPLATE_SEEDS: readonly TemplateSeed[] = [
  {
    id: "mind-map",
    name: "Mind map",
    description: "A central topic with four radial branches.",
    build: buildMindMap,
  },
  {
    id: "kanban",
    name: "Kanban board",
    description: "Backlog, in progress and done columns with cards.",
    build: buildKanban,
  },
  {
    id: "brainstorm-grid",
    name: "Brainstorm grid",
    description: "A 4 by 3 grid of sticky notes for rapid ideation.",
    build: buildBrainstormGrid,
  },
  {
    id: "retro-board",
    name: "Retro board",
    description: "Went well, to improve, actions and blockers.",
    build: buildRetroBoard,
  },
  {
    id: "flowchart",
    name: "Flowchart",
    description: "Start, process, decision and end blocks.",
    build: buildFlowchart,
  },
];

export function listTemplates(): TemplateDto[] {
  return TEMPLATE_SEEDS.map((seed) => ({
    id: seed.id,
    name: seed.name,
    description: seed.description,
    nodeCount: seed.build().length,
  }));
}

export function findTemplate(templateId: string): TemplateSeed | null {
  return TEMPLATE_SEEDS.find((seed) => seed.id === templateId) ?? null;
}

export interface EncodedTemplate {
  state: Uint8Array;
  stateVector: Uint8Array;
  nodeCount: number;
}

/**
 * Build the Yjs state a fresh document should start from.
 *
 * The default layer is written first so the client's `ensureDefaultLayer` is a
 * no-op and the template nodes are immediately visible. Nodes are written as
 * Y.Maps keyed by id, matching the live document shape exactly.
 */
export function encodeTemplateState(seed: TemplateSeed): EncodedTemplate {
  const doc = new Y.Doc();
  const layers = doc.getMap<Y.Map<unknown>>(CANVAS_LAYERS);
  const nodes = doc.getMap<Y.Map<unknown>>(CANVAS_NODES);
  const templateNodes = seed.build();

  doc.transact(() => {
    const layer = new Y.Map<unknown>();
    layer.set("id", DEFAULT_LAYER_ID);
    layer.set("name", DEFAULT_LAYER_NAME);
    layer.set("visible", true);
    layer.set("zIndex", 0);
    layers.set(DEFAULT_LAYER_ID, layer);

    for (const node of templateNodes) {
      const yNode = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(node)) {
        yNode.set(key, value);
      }
      nodes.set(node.id, yNode);
    }
  });

  return {
    state: Y.encodeStateAsUpdate(doc),
    stateVector: Y.encodeStateVector(doc),
    nodeCount: templateNodes.length,
  };
}

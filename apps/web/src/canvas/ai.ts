import type { CanvasNode } from "@trellis/shared";

/**
 * Canvas AI co-designer.
 *
 * Two providers implement one interface:
 *
 *   HeuristicProvider  deterministic, offline, no key required. It produces a
 *                      real, usable result for every action, which means the
 *                      feature works on a fresh clone with no configuration.
 *   HttpProvider       calls an env-configured endpoint when one is present and
 *                      falls back to the heuristic provider on any failure.
 *
 * Every provider returns plain node descriptions. The caller writes them through
 * the normal Yjs transaction path, so an AI action is undoable exactly like a
 * manual edit. An AI action you cannot undo is a bug, not a feature.
 */

export type AiAction = "mind-map" | "arrange" | "summarize";

export interface MindMapNodeSpec {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "root" | "branch" | "leaf";
}

export interface ArrangePlan {
  nodeId: string;
  x: number;
  y: number;
  column: string;
}

export interface SummaryResult {
  summary: string;
  bullets: string[];
}

export interface CanvasAiProvider {
  readonly name: string;
  generateMindMap(topic: string): Promise<MindMapNodeSpec[]>;
  arrangeSelection(nodes: readonly CanvasNode[]): Promise<ArrangePlan[]>;
  summarizeNotes(nodes: readonly CanvasNode[]): Promise<SummaryResult>;
}

/** Split a topic into a root phrase and up to four branch labels. */
function branchLabels(topic: string): string[] {
  const cleaned = topic.trim().replace(/[.?!]+$/, "");
  const words = cleaned.split(/[\s,]+/).filter((word) => word.length > 2);
  if (words.length >= 5) {
    // Use the first four meaningful words as facets of the topic.
    return words.slice(0, 4).map((word) => capitalize(word));
  }
  // Otherwise use a fixed analytical frame, which is what a person would
  // actually want from "mind map about X" when X is a single concept.
  return ["Goals", "Audience", "Constraints", "Next steps"];
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/**
 * Offline provider. Deterministic: the same input always produces the same
 * layout, which makes it testable and makes the result predictable for users.
 */
export class HeuristicProvider implements CanvasAiProvider {
  readonly name = "offline";

  async generateMindMap(topic: string): Promise<MindMapNodeSpec[]> {
    const rootText = topic.trim().length > 0 ? topic.trim().slice(0, 60) : "Central topic";
    const centre = { x: 480, y: 340 };
    const specs: MindMapNodeSpec[] = [
      {
        text: rootText,
        x: centre.x - 110,
        y: centre.y - 55,
        width: 220,
        height: 110,
        kind: "root",
      },
    ];

    const labels = branchLabels(rootText);
    const radius = 250;
    labels.forEach((label, index) => {
      const angle = (index / labels.length) * Math.PI * 2 - Math.PI / 2;
      const branchX = centre.x + Math.cos(angle) * radius;
      const branchY = centre.y + Math.sin(angle) * radius;
      specs.push({
        text: label,
        x: branchX - 90,
        y: branchY - 45,
        width: 180,
        height: 90,
        kind: "branch",
      });

      // One leaf per branch, pushed further out along the same angle.
      const leafX = centre.x + Math.cos(angle) * (radius + 190);
      const leafY = centre.y + Math.sin(angle) * (radius + 190);
      specs.push({
        text: `${label}: detail`,
        x: leafX - 70,
        y: leafY - 32,
        width: 140,
        height: 64,
        kind: "leaf",
      });
    });

    return specs;
  }

  /**
   * Arrange notes into columns by clustering on their leading keyword.
   *
   * This is intentionally simple and explainable: the first significant word of
   * each note becomes its column. A user can see why a note landed where it did,
   * which matters more than a cleverer opaque clustering.
   */
  async arrangeSelection(nodes: readonly CanvasNode[]): Promise<ArrangePlan[]> {
    const notes = nodes.filter((node) => node.type === "note" || node.type === "text");
    if (notes.length === 0) return [];

    const columns = new Map<string, CanvasNode[]>();
    for (const note of notes) {
      const key = columnKeyFor(note.text);
      const list = columns.get(key) ?? [];
      list.push(note);
      columns.set(key, list);
    }

    const columnNames = [...columns.keys()].sort((left, right) => left.localeCompare(right));
    const plans: ArrangePlan[] = [];
    const columnWidth = 260;
    const rowHeight = 190;

    columnNames.forEach((columnName, columnIndex) => {
      const entries = columns.get(columnName) ?? [];
      entries.forEach((node, rowIndex) => {
        plans.push({
          nodeId: node.id,
          x: 120 + columnIndex * columnWidth,
          y: 140 + rowIndex * rowHeight,
          column: columnName,
        });
      });
    });

    return plans;
  }

  /**
   * Extractive summary: rank sentences by word frequency and keep the top ones.
   *
   * Extractive rather than generative on purpose. It cannot invent a claim that
   * is not in the notes, which is the correct failure mode for a summary you
   * might act on.
   */
  async summarizeNotes(nodes: readonly CanvasNode[]): Promise<SummaryResult> {
    const sentences: string[] = [];
    for (const node of nodes) {
      const text = node.text.trim();
      if (text.length === 0) continue;
      for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
        const trimmed = sentence.trim();
        if (trimmed.length > 0) sentences.push(trimmed);
      }
    }

    if (sentences.length === 0) {
      return { summary: "No note text to summarize.", bullets: [] };
    }

    const frequency = new Map<string, number>();
    for (const sentence of sentences) {
      for (const word of tokenize(sentence)) {
        frequency.set(word, (frequency.get(word) ?? 0) + 1);
      }
    }

    const scored = sentences.map((sentence, index) => {
      const words = tokenize(sentence);
      const score =
        words.reduce((total, word) => total + (frequency.get(word) ?? 0), 0) /
        Math.max(1, words.length);
      return { sentence, index, score };
    });

    scored.sort((left, right) => right.score - left.score);
    const top = scored.slice(0, Math.min(5, scored.length));
    // Restore reading order so the summary reads naturally.
    top.sort((left, right) => left.index - right.index);
    const bullets = top.map((entry) => entry.sentence);

    return {
      summary: `${sentences.length} statements across ${nodes.length} notes. Key points:`,
      bullets,
    };
  }
}

function columnKeyFor(text: string): string {
  const words = tokenize(text);
  const first = words[0];
  if (!first) return "Uncategorised";
  return capitalize(first);
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "has",
  "was",
  "were",
  "are",
  "but",
  "not",
  "you",
  "our",
  "their",
  "its",
  "into",
  "about",
  "need",
  "should",
  "would",
  "could",
  "will",
  "can",
  "just",
  "also",
  "than",
  "then",
  "them",
  "they",
  "there",
  "here",
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

/**
 * HTTP provider for a real model endpoint.
 *
 * Activated only when NEXT_PUBLIC_AI_ENDPOINT is set. Any failure (network,
 * non-2xx, malformed body) falls back to the heuristic provider rather than
 * surfacing an error: the user asked for a mind map, not for a network
 * debugging session.
 */
export class HttpProvider implements CanvasAiProvider {
  readonly name = "http";
  private readonly fallback = new HeuristicProvider();

  constructor(private readonly endpoint: string) {}

  private async post<T>(body: unknown): Promise<T | null> {
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  async generateMindMap(topic: string): Promise<MindMapNodeSpec[]> {
    const result = await this.post<{ nodes?: MindMapNodeSpec[] }>({
      action: "mind-map",
      topic,
    });
    if (!result?.nodes || result.nodes.length === 0) {
      return this.fallback.generateMindMap(topic);
    }
    return result.nodes;
  }

  async arrangeSelection(nodes: readonly CanvasNode[]): Promise<ArrangePlan[]> {
    const result = await this.post<{ plans?: ArrangePlan[] }>({
      action: "arrange",
      nodes: nodes.map((node) => ({ id: node.id, text: node.text, type: node.type })),
    });
    if (!result?.plans || result.plans.length === 0) {
      return this.fallback.arrangeSelection(nodes);
    }
    return result.plans;
  }

  async summarizeNotes(nodes: readonly CanvasNode[]): Promise<SummaryResult> {
    const result = await this.post<SummaryResult>({
      action: "summarize",
      notes: nodes.map((node) => node.text).filter((text) => text.trim().length > 0),
    });
    if (!result?.summary) {
      return this.fallback.summarizeNotes(nodes);
    }
    return result;
  }
}

/** Pick a provider from the environment, defaulting to the offline one. */
export function createAiProvider(endpoint: string | undefined): CanvasAiProvider {
  if (endpoint && endpoint.trim().length > 0) return new HttpProvider(endpoint.trim());
  return new HeuristicProvider();
}

/**
 * Asynchronous image cache for canvas image nodes.
 *
 * Image nodes paint synchronously inside the render loop, so a decoded
 * HTMLImageElement must already be available. This cache loads on demand,
 * reports whether a node is still loading (so the renderer can draw a shimmer
 * skeleton), and notifies the renderer once a decode completes so the frame is
 * repainted exactly once per image rather than polling.
 */
export interface ImageCacheEntry {
  status: "loading" | "ready" | "error";
  image: HTMLImageElement | null;
}

export class CanvasImageCache {
  private readonly entries = new Map<string, ImageCacheEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly objectUrls = new Map<string, string>();
  private readonly pending = new Set<Promise<void>>();

  /** Subscribe to decode completion. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Current state for a key, starting a load on first request. */
  get(key: string, url: string, accessToken?: string): ImageCacheEntry {
    const existing = this.entries.get(key);
    if (existing) return existing;

    const entry: ImageCacheEntry = { status: "loading", image: null };
    this.entries.set(key, entry);

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      if (this.entries.get(key) !== entry) return;
      entry.status = "ready";
      entry.image = image;
      this.notify();
    };
    const loading = this.loadImage(key, url, accessToken, image, entry).finally(() => {
      this.pending.delete(loading);
    });
    this.pending.add(loading);

    return entry;
  }

  private async loadImage(
    key: string,
    url: string,
    accessToken: string | undefined,
    image: HTMLImageElement,
    entry: ImageCacheEntry,
  ): Promise<void> {
    try {
      let source = url;
      if (accessToken) {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${accessToken}` },
          cache: "force-cache",
        });
        if (!response.ok) {
          throw new Error(`Image request failed with status ${response.status}`);
        }
        source = URL.createObjectURL(await response.blob());
        if (this.entries.get(key) !== entry) {
          URL.revokeObjectURL(source);
          return;
        }
        this.objectUrls.set(key, source);
      }

      await new Promise<void>((resolve, reject) => {
        image.onload = () => {
          if (this.entries.get(key) !== entry) return resolve();
          entry.status = "ready";
          entry.image = image;
          this.notify();
          resolve();
        };
        image.onerror = () => reject(new Error("Image decoding failed"));
        image.src = source;
      });
    } catch {
      if (this.entries.get(key) === entry) {
        entry.status = "error";
        entry.image = null;
        this.revokeObjectUrl(key);
        this.notify();
      }
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /** Drop an entry so a changed URL is re-fetched. */
  invalidate(key: string): void {
    this.entries.delete(key);
    this.revokeObjectUrl(key);
  }

  clear(): void {
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.entries.clear();
    this.listeners.clear();
  }

  private revokeObjectUrl(key: string): void {
    const url = this.objectUrls.get(key);
    if (!url) return;
    URL.revokeObjectURL(url);
    this.objectUrls.delete(key);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

import { Redis } from "ioredis";
import type { Logger } from "pino";

import type { PubSub, PubSubSubscription } from "./types.js";

export interface RedisPubSubOptions {
  url: string;
  logger: Logger;
}

/**
 * Redis Pub/Sub adapter with separate publisher and subscriber connections,
 * reference-counted channel subscriptions, and bounded publish retries.
 *
 * Redis Pub/Sub is intentionally transient: if Redis drops a message or a
 * node is disconnected, clients recover state through Yjs sync on reconnect.
 */
export class RedisPubSub implements PubSub {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly logger: Logger;
  private readonly handlers = new Map<string, Set<(channel: string, payload: string) => void>>();
  private readonly subscribePromises = new Map<string, Promise<unknown>>();
  private connectionPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: RedisPubSubOptions) {
    this.logger = options.logger.child({ component: "redis-pubsub" });
    const commonOptions = {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      retryStrategy(times: number): number {
        return Math.min(5_000, times * 200);
      },
    } as const;

    this.publisher = new Redis(options.url, commonOptions);
    this.subscriber = new Redis(options.url, commonOptions);

    this.publisher.on("error", (error) => {
      this.logger.warn({ err: error }, "Redis publisher connection error");
    });
    this.subscriber.on("error", (error) => {
      this.logger.warn({ err: error }, "Redis subscriber connection error");
    });
    this.subscriber.on("message", (channel, payload) => {
      const channelHandlers = this.handlers.get(channel);
      if (!channelHandlers) return;
      for (const handler of channelHandlers) {
        try {
          handler(channel, payload);
        } catch (error) {
          this.logger.error({ err: error, channel }, "Redis subscriber handler threw");
        }
      }
    });
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("RedisPubSub is closed");
    if (!this.connectionPromise) {
      this.connectionPromise = Promise.all([this.publisher.connect(), this.subscriber.connect()])
        .then(() => undefined)
        .catch((error: unknown) => {
          this.connectionPromise = null;
          throw error;
        });
    }
    await this.connectionPromise;
  }

  async ping(): Promise<void> {
    await this.connect();
    const pong = await this.publisher.ping();
    if (pong !== "PONG") throw new Error("Redis ping failed");
  }

  async publish(channel: string, payload: string): Promise<void> {
    if (this.closed) throw new Error("RedisPubSub is closed");
    await this.connect();

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.publisher.publish(channel, payload);
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn({ err: error, channel, attempt }, "Redis publish failed");
        if (attempt < 3) await delay(50 * 2 ** (attempt - 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Redis publish failed");
  }

  async subscribe(
    channel: string,
    handler: (channel: string, payload: string) => void,
  ): Promise<PubSubSubscription> {
    if (this.closed) throw new Error("RedisPubSub is closed");
    await this.connect();

    let channelHandlers = this.handlers.get(channel);
    if (!channelHandlers) {
      channelHandlers = new Set();
      this.handlers.set(channel, channelHandlers);
    }
    const wasEmpty = channelHandlers.size === 0;
    channelHandlers.add(handler);

    if (wasEmpty) {
      const subscription = this.subscriber.subscribe(channel);
      this.subscribePromises.set(channel, subscription);
      try {
        await subscription;
      } catch (error) {
        channelHandlers.delete(handler);
        if (channelHandlers.size === 0) this.handlers.delete(channel);
        throw error;
      } finally {
        if (this.subscribePromises.get(channel) === subscription) {
          this.subscribePromises.delete(channel);
        }
      }
    } else {
      await this.subscribePromises.get(channel);
    }

    let active = true;
    return {
      unsubscribe: async (): Promise<void> => {
        if (!active) return;
        active = false;
        const currentHandlers = this.handlers.get(channel);
        if (!currentHandlers) return;
        currentHandlers.delete(handler);
        if (currentHandlers.size === 0) {
          this.handlers.delete(channel);
          if (!this.closed) {
            try {
              await this.subscriber.unsubscribe(channel);
            } catch (error) {
              this.logger.warn({ err: error, channel }, "Redis unsubscribe failed");
            }
          }
        }
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

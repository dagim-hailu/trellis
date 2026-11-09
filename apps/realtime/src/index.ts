import { TokenService } from "@trellis/auth";
import {
  DocumentStore,
  closePool,
  createDatabasePool,
  pingDatabase,
} from "@trellis/db";

import { loadRealtimeConfig } from "./config.js";
import { createRealtimeLogger } from "./logger.js";
import { RedisPubSub } from "./pubsub.js";
import { createRealtimeServer, type RealtimeServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadRealtimeConfig();
  const logger = createRealtimeLogger({ level: config.logLevel, nodeId: config.nodeId });

  const pool = createDatabasePool({ connectionString: config.databaseUrl });
  pool.on("error", (error) => {
    logger.error({ err: error }, "idle PostgreSQL client failed");
  });

  const pubsub = new RedisPubSub({ url: config.redisUrl, logger });
  let server: RealtimeServer | null = null;
  let resourcesClosed = false;

  const closeResources = async (): Promise<void> => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    if (server) await server.close().catch((error: unknown) => {
      logger.error({ err: error }, "failed to close realtime server");
    });
    await pubsub.close().catch((error: unknown) => {
      logger.warn({ err: error }, "failed to close Redis Pub/Sub");
    });
    await closePool(pool).catch((error: unknown) => {
      logger.warn({ err: error }, "failed to close PostgreSQL pool");
    });
  };

  try {
    const store = new DocumentStore(pool);
    const tokens = new TokenService({
      secret: config.jwtSecret,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      ttlSeconds: 3600,
    });

    const readiness = async (): Promise<void> => {
      await Promise.all([pingDatabase(pool), pubsub.ping()]);
    };

    await readiness();

    server = createRealtimeServer({
      nodeId: config.nodeId,
      channelPrefix: config.channelPrefix,
      maxUpdateBytes: config.maxUpdateBytes,
      snapshotEveryUpdates: config.snapshotEveryUpdates,
      snapshotIntervalMs: config.snapshotIntervalMs,
      snapshotRetention: config.snapshotRetention,
      store,
      pubsub,
      logger,
      tokens,
      webOrigin: config.webOrigin,
      authTimeoutMs: config.authTimeoutMs,
      readiness,
    });

    const address = await server.listen(config.port, config.host);
    logger.info(
      {
        host: address.address,
        port: address.port,
        nodeId: config.nodeId,
        webOrigin: config.webOrigin,
        channelPrefix: config.channelPrefix,
      },
      "Trellis realtime listening",
    );

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, "shutting down realtime server");
      const forceExit = setTimeout(() => {
        logger.fatal("graceful shutdown timed out");
        process.exit(1);
      }, 15_000);
      forceExit.unref();
      try {
        await closeResources();
      } catch (error) {
        logger.error({ err: error }, "error during shutdown");
        process.exitCode = 1;
      } finally {
        clearTimeout(forceExit);
      }
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (error) {
    logger.fatal({ err: error }, "failed to start realtime server");
    await closeResources();
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

import { TokenService } from "@trellis/auth";
import {
  AssetRepository,
  AuthRepository,
  CommentRepository,
  WorkspaceRepository,
  closePool,
  createDatabasePool,
} from "@trellis/db";
import type { FastifyInstance } from "fastify";

import { buildApi } from "./app.js";
import { loadApiConfig } from "./config.js";
import { LocalDiskStorage } from "./lib/storage.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const pool = createDatabasePool({ connectionString: config.databaseUrl });
  let app: FastifyInstance | null = null;

  try {
    const tokens = new TokenService({
      secret: config.jwtSecret,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      ttlSeconds: config.accessTokenTtlSeconds,
    });

    app = await buildApi({
      deps: {
        pool,
        authRepository: new AuthRepository(pool),
        workspaceRepository: new WorkspaceRepository(pool),
        assetRepository: new AssetRepository(pool),
        commentRepository: new CommentRepository(pool),
        storage: new LocalDiskStorage({
          rootDir: config.storageDir,
          publicBaseUrl: `${config.publicBaseUrl}/v1/assets`,
        }),
        tokens,
        webOrigin: config.webOrigin,
      },
      logger: {
        level: config.logLevel,
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "res.headers.set-cookie",
            "password",
            "*.password",
            "token",
            "*.token",
          ],
          censor: "[redacted]",
        },
      },
    });

    const runningApp = app;
    pool.on("error", (error) => {
      runningApp.log.error({ err: error }, "idle PostgreSQL client failed");
    });

    await runningApp.listen({ host: config.host, port: config.port });
    runningApp.log.info(
      {
        env: config.nodeEnv,
        port: config.port,
        webOrigin: config.webOrigin,
      },
      "Trellis API listening",
    );

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      runningApp.log.info({ signal }, "shutting down API");
      const forceExit = setTimeout(() => {
        runningApp.log.fatal("graceful shutdown timed out");
        process.exit(1);
      }, 10_000);
      forceExit.unref();
      try {
        await runningApp.close();
        await closePool(pool);
      } catch (error) {
        runningApp.log.error({ err: error }, "error during shutdown");
        process.exitCode = 1;
      } finally {
        clearTimeout(forceExit);
      }
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (error) {
    if (app) {
      app.log.fatal({ err: error }, "failed to start API");
      await app.close().catch(() => undefined);
    } else {
      console.error("Failed to start API:", error);
    }
    await closePool(pool).catch(() => undefined);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

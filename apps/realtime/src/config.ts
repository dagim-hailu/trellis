import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({
  path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")],
  quiet: true,
});

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  REALTIME_HOST: z.string().min(1).default("127.0.0.1"),
  REALTIME_PORT: z.coerce.number().int().min(1).max(65_535).default(4401),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default("trellis-api"),
  JWT_AUDIENCE: z.string().min(1).default("trellis-clients"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3100"),
  REDIS_CHANNEL_PREFIX: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9:_-]+$/)
    .default("trellis"),
  MAX_UPDATE_BYTES: z.coerce.number().int().min(1024).max(8_388_608).default(1_048_576),
  SNAPSHOT_EVERY_UPDATES: z.coerce.number().int().min(1).max(100_000).default(200),
  SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),
  SNAPSHOT_RETENTION: z.coerce.number().int().min(1).max(100).default(5),
  AUTH_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  NODE_ID: z.string().min(1).max(128).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export interface RealtimeConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  webOrigin: string;
  channelPrefix: string;
  maxUpdateBytes: number;
  snapshotEveryUpdates: number;
  snapshotIntervalMs: number;
  snapshotRetention: number;
  authTimeoutMs: number;
  nodeId: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}

export function loadRealtimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RealtimeConfig {
  const parsed = envSchema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid realtime environment: ${details}`);
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    host: parsed.data.REALTIME_HOST,
    port: parsed.data.REALTIME_PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    redisUrl: parsed.data.REDIS_URL,
    jwtSecret: parsed.data.JWT_SECRET,
    jwtIssuer: parsed.data.JWT_ISSUER,
    jwtAudience: parsed.data.JWT_AUDIENCE,
    webOrigin: parsed.data.WEB_ORIGIN,
    channelPrefix: parsed.data.REDIS_CHANNEL_PREFIX,
    maxUpdateBytes: parsed.data.MAX_UPDATE_BYTES,
    snapshotEveryUpdates: parsed.data.SNAPSHOT_EVERY_UPDATES,
    snapshotIntervalMs: parsed.data.SNAPSHOT_INTERVAL_MS,
    snapshotRetention: parsed.data.SNAPSHOT_RETENTION,
    authTimeoutMs: parsed.data.AUTH_TIMEOUT_MS,
    nodeId: parsed.data.NODE_ID ?? `${hostname()}:${process.pid}:${randomUUID()}`,
    logLevel: parsed.data.LOG_LEVEL,
  };
}

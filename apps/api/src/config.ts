import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({
  path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")],
  quiet: true,
});

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4400),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default("trellis-api"),
  JWT_AUDIENCE: z.string().min(1).default("trellis-clients"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  WEB_ORIGIN: z.string().url().default("http://localhost:3100"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Directory that backs local asset storage. */
  ASSET_STORAGE_DIR: z.string().min(1).default(".storage"),
  /** Public origin used to build asset URLs. */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:4400"),
});

export type ApiConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTokenTtlSeconds: number;
  webOrigin: string;
  storageDir: string;
  publicBaseUrl: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
};

export function loadApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = envSchema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid API environment: ${details}`);
  }
  return {
    nodeEnv: parsed.data.NODE_ENV,
    host: parsed.data.API_HOST,
    port: parsed.data.API_PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    jwtSecret: parsed.data.JWT_SECRET,
    jwtIssuer: parsed.data.JWT_ISSUER,
    jwtAudience: parsed.data.JWT_AUDIENCE,
    accessTokenTtlSeconds: parsed.data.ACCESS_TOKEN_TTL_SECONDS,
    webOrigin: parsed.data.WEB_ORIGIN,
    storageDir: parsed.data.ASSET_STORAGE_DIR,
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL,
    logLevel: parsed.data.LOG_LEVEL,
  };
}

import { afterAll, describe, expect, it } from "vitest";

import { hashPassword, TokenService } from "@trellis/auth";
import type {
  AssetRepository,
  AuthRepository,
  CommentRepository,
  DocumentRecord,
  UserRecord,
  WorkspaceRecord,
  WorkspaceRepository,
} from "@trellis/db";
import type { FastifyInstance } from "fastify";

import { buildApi } from "../app.js";
import { MemoryStorage } from "../lib/storage.js";

const SECRET = "api-test-secret-that-is-definitely-long-enough";
const USER: UserRecord = {
  id: "60b403ec-c56c-41fe-84ce-bca14b33e3bb",
  email: "ada@example.test",
  displayName: "Ada",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  passwordHash: "",
};
const WORKSPACE: WorkspaceRecord = {
  id: "50b8c42e-ea1f-43d7-a81f-32fc1d82d8d0",
  name: "Design",
  slug: "design-1234abcd",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const apps: FastifyInstance[] = [];

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

async function buildTestApi(): Promise<FastifyInstance> {
  USER.passwordHash = await hashPassword("correct horse battery staple");

  const authRepository = {
    findById: async (id: string) => (id === USER.id ? USER : null),
    findByEmail: async (email: string) =>
      email.toLowerCase() === USER.email ? USER : null,
    createUser: async () => USER,
  } as unknown as AuthRepository;

  const workspaceRepository = {
    listWorkspaces: async () => [WORKSPACE],
    getWorkspace: async () => WORKSPACE,
    createWorkspace: async () => WORKSPACE,
    listMembers: async () => [],
    listDocuments: async () => [] as DocumentRecord[],
    getDocument: async () => null,
    createDocument: async () => {
      throw new Error("not used");
    },
    renameDocument: async () => {
      throw new Error("not used");
    },
    deleteDocument: async () => undefined,
    createInvitation: async () => {
      throw new Error("not used");
    },
    acceptInvitation: async () => WORKSPACE,
  } as unknown as WorkspaceRepository;

  const tokens = new TokenService({
    secret: SECRET,
    issuer: "trellis-api",
    audience: "trellis-clients",
    ttlSeconds: 3_600,
  });

  const app = await buildApi({
    deps: {
      pool: { query: async () => ({ rows: [] }) } as never,
      authRepository,
      workspaceRepository,
      assetRepository: {
        getWorkspaceRole: async () => "owner",
        insertAsset: async () => {
          throw new Error("not used");
        },
        listAssets: async () => [],
        getAssetForUser: async () => null,
        requireAssetForUser: async () => {
          throw new Error("not used");
        },
        deleteAsset: async () => undefined,
      } as unknown as AssetRepository,
      commentRepository: {
        listComments: async () => [],
        createComment: async () => {
          throw new Error("not used");
        },
        getCommentById: async () => null,
        setResolved: async () => {
          throw new Error("not used");
        },
        deleteComment: async () => undefined,
      } as unknown as CommentRepository,
      storage: new MemoryStorage(),
      tokens,
      webOrigin: "http://localhost:3100",
    },
    logger: false,
  });
  await app.ready();
  apps.push(app);
  return app;
}

async function tokenFor(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: USER.email, password: "correct horse battery staple" },
  });
  expect(response.statusCode).toBe(200);
  return response.json().accessToken as string;
}

describe("Fastify API", () => {
  it("rejects a protected route without a token", async () => {
    const app = await buildTestApi();
    const response = await app.inject({ method: "GET", url: "/v1/workspaces" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
  });

  it("logs in and returns the current user for a valid token", async () => {
    const app = await buildTestApi();
    const token = await tokenFor(app);
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(USER.email);
  });

  it("rejects malformed login bodies with a validation error", async () => {
    const app = await buildTestApi();
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "not-an-email" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("returns only the authenticated user's workspaces", async () => {
    const app = await buildTestApi();
    const token = await tokenFor(app);
    const response = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().workspaces).toEqual([WORKSPACE]);
  });
});

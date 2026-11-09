import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { hashPassword } from "@trellis/auth";
import {
  AuthRepository,
  WorkspaceRepository,
  closePool,
  createDatabasePool,
} from "@trellis/db";
import { config as loadEnv } from "dotenv";

loadEnv({
  path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")],
  quiet: true,
});

async function main(): Promise<void> {
  const nodeEnv = process.env["NODE_ENV"] ?? "development";
  if (nodeEnv === "production" && process.env["ALLOW_PRODUCTION_SEED"] !== "true") {
    throw new Error("Refusing to seed production. Set ALLOW_PRODUCTION_SEED=true to override.");
  }

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const email = (process.env["SEED_EMAIL"] ?? "demo@trellis.local").trim().toLowerCase();
  const password = process.env["SEED_PASSWORD"] ?? "demo-password-123";
  const displayName = process.env["SEED_DISPLAY_NAME"] ?? "Demo User";

  if (password.length < 12) {
    throw new Error("SEED_PASSWORD must be at least 12 characters");
  }

  const pool = createDatabasePool({ connectionString: databaseUrl, maxConnections: 3 });
  const authRepository = new AuthRepository(pool);
  const workspaceRepository = new WorkspaceRepository(pool);

  try {
    let user = await authRepository.findByEmail(email);
    let createdUser = false;
    if (!user) {
      user = await authRepository.createUser({
        email,
        displayName,
        passwordHash: await hashPassword(password),
      });
      createdUser = true;
    }

    const workspaces = await workspaceRepository.listWorkspaces(user.id);
    const workspace =
      workspaces[0] ??
      (await workspaceRepository.createWorkspace({
        ownerId: user.id,
        name: "Demo workspace",
        slug: `demo-${randomBytes(4).toString("hex")}`,
      }));

    const documents = await workspaceRepository.listDocuments(workspace.id, user.id);
    const document =
      documents[0] ??
      (await workspaceRepository.createDocument({
        workspaceId: workspace.id,
        userId: user.id,
        title: "Demo canvas",
      }));

    console.log("");
    console.log("Trellis seed complete.");
    console.log(`  user:      ${email}${createdUser ? " (created)" : " (existing; password unchanged)"}`);
    if (createdUser) console.log(`  password:  ${password}`);
    console.log(`  workspace: ${workspace.name} (${workspace.id})`);
    console.log(`  document:  ${document.title} (${document.id})`);
    console.log(`  open:      ${process.env["WEB_ORIGIN"] ?? "http://localhost:3100"}/documents/${document.id}`);
    console.log("");
  } finally {
    await closePool(pool);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

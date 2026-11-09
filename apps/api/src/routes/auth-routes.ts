import { hashPassword, verifyPassword } from "@trellis/auth";
import { AuthRepository } from "@trellis/db";
import type { TokenService } from "@trellis/auth";
import { loginSchema, registerSchema, type AuthResponseDto } from "@trellis/shared";
import type { FastifyInstance } from "fastify";

import { UnauthorizedError, ConflictApiError } from "../lib/errors.js";
import { parseBody, requireAuth } from "../lib/http.js";
import { toUserDto } from "./mappers.js";

export interface AuthRouteDependencies {
  authRepository: AuthRepository;
  tokens: TokenService;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AuthRouteDependencies,
): void {
  const { authRepository, tokens } = dependencies;

  app.post(
    "/v1/auth/register",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = parseBody(registerSchema, request.body);

      let user;
      try {
        user = await authRepository.createUser({
          email: body.email,
          displayName: body.displayName,
          passwordHash: await hashPassword(body.password),
        });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "conflict") {
          throw new ConflictApiError("An account with this email already exists");
        }
        throw error;
      }

      const issued = await tokens.issue({
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
      });
      const response: AuthResponseDto = {
        accessToken: issued.token,
        expiresIn: issued.expiresIn,
        user: toUserDto(user),
      };
      return reply.status(201).send(response);
    },
  );

  app.post(
    "/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const body = parseBody(loginSchema, request.body);
      const user = await authRepository.findByEmail(body.email);

      if (!user) {
        // Run the same expensive KDF path for unknown accounts so login timing
        // does not disclose whether an email is registered.
        await hashPassword(body.password);
        throw new UnauthorizedError("Invalid email or password");
      }

      const valid = await verifyPassword(body.password, user.passwordHash);
      if (!valid) throw new UnauthorizedError("Invalid email or password");

      const issued = await tokens.issue({
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
      });
      const response: AuthResponseDto = {
        accessToken: issued.token,
        expiresIn: issued.expiresIn,
        user: toUserDto(user),
      };
      return response;
    },
  );

  app.get("/v1/me", async (request, reply) => {
    const claims = await requireAuth(request, tokens);
    const user = await authRepository.findById(claims.sub);
    if (!user) {
      return reply.status(401).send({
        error: { code: "unauthorized", message: "Account no longer exists" },
      });
    }
    return { user: toUserDto(user) };
  });
}

import { defineConfig } from "vitest/config";

/**
 * The API suite builds a real Fastify instance per test and hashes passwords
 * with scrypt. Under `turbo run test` all six workspace packages run at once,
 * so the first test in this file can lose several seconds to CPU contention
 * before it even issues a request. The default 5s budget is too tight for that
 * cold start and produced a spurious timeout on the 401 assertion.
 *
 * The timeout is raised rather than the test weakened: the assertion itself is
 * correct and passes in well under a second when the machine is not saturated.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

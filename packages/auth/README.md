# @trellis/auth

Authentication primitives used by the API (issuer) and realtime (verifier).

- `password.ts` — scrypt hashing (`N=32768`, 64 MiB cap) with stored parameters; constant-time verification
- `tokens.ts` — HS256, issuer/audience-validated, UUID-subject access tokens with `jti`, `iat`, and `exp`

```bash
pnpm --filter @trellis/auth build
pnpm --filter @trellis/auth test
pnpm --filter @trellis/auth typecheck
```

The secret must be at least 32 characters. Refresh-token rotation/revocation is intentionally not implemented; see the root README's hardening section.

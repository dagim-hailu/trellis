import type { AuthResponseDto, UserDto } from "@trellis/shared";

export interface BrowserSession {
  accessToken: string;
  expiresAt: number;
  user: UserDto;
}

const SESSION_KEY = "trellis.session.v1";

export function readSession(): BrowserSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<BrowserSession>;
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      !parsed.user ||
      typeof parsed.user.id !== "string" ||
      typeof parsed.user.email !== "string" ||
      typeof parsed.user.displayName !== "string"
    ) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
      user: parsed.user,
    };
  } catch {
    return null;
  }
}

export function saveSession(auth: AuthResponseDto): BrowserSession {
  const session: BrowserSession = {
    accessToken: auth.accessToken,
    expiresAt: Date.now() + auth.expiresIn * 1000,
    user: auth.user,
  };
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function clearSession(): void {
  window.sessionStorage.removeItem(SESSION_KEY);
}

export function isSessionExpired(session: BrowserSession, skewMs = 10_000): boolean {
  return session.expiresAt <= Date.now() + skewMs;
}

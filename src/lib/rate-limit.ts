import type { RateLimitState } from "./types";

const DAILY_LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;

const serverStore = new Map<string, RateLimitState>();

export function checkRateLimit(ip: string): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} {
  const now = Date.now();
  let state = serverStore.get(ip);

  if (!state || now > state.resetAt) {
    state = { count: 0, resetAt: now + WINDOW_MS };
    serverStore.set(ip, state);
  }

  const allowed = state.count < DAILY_LIMIT;
  const remaining = Math.max(0, DAILY_LIMIT - state.count);

  return { allowed, remaining, resetAt: state.resetAt };
}

export function incrementRateLimit(ip: string): void {
  const now = Date.now();
  const state = serverStore.get(ip);

  if (!state || now > state.resetAt) {
    serverStore.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }

  state.count += 1;
  serverStore.set(ip, state);
}

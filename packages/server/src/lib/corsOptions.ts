import type { CorsOptions } from 'cors';

/**
 * Every REST call from the site is cross-origin with an Authorization header,
 * so the browser sends a preflight OPTIONS first. Without Access-Control-Max-Age
 * it re-asks after ~5 s, per URL — on a phone ~0.5–1 s away from this server
 * that doubled every request. Browsers cap the value (Chromium 2 h, Firefox
 * 24 h, Safari 10 min); the answer only depends on the origin allow-list.
 */
export const PREFLIGHT_MAX_AGE_S = 7200;

export function buildCorsOptions(origins: string | string[]): CorsOptions {
  return { origin: origins, credentials: true, maxAge: PREFLIGHT_MAX_AGE_S };
}

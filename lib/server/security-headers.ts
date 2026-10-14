/**
 * R1-08 security headers (issue #20 AC 4 基础安全头核验; ADR-0003 decision 4
 * carried forward: "完整部署加固（HTTPS/HSTS/CSP nonce）属 R1-08").
 *
 * CSP v0 with per-request nonces: every response carries a Content-Security-
 * Policy whose script allow-list is a FRESH nonce + 'strict-dynamic'. This
 * is the nonce-based XSS mitigation ADR-0003 deferred to R1-08: injected
 * markup can no longer execute scripts merely because they sit on the
 * app origin — only scripts that Next.js tagged with the request nonce (and
 * what those preload) run. DISCLOSED RESIDUALS (docs/adr/0006-*.md):
 * - style-src keeps 'unsafe-inline' (React style props + framer-motion
 *   injected <style> tags; a style injection can deface but cannot execute);
 * - 'self' host allow-lists are kept for non-script fetches only (with
 *   'strict-dynamic' they no longer authorize scripts);
 * - HSTS + TLS belong to the TLS-terminating reverse proxy (deploy/runbook.md
 *   — the app itself is loopback HTTP behind it).
 *
 * This module must stay edge-runtime-compatible (no node builtins) — it is
 * imported by middleware.ts.
 */

/** Request header carrying the per-request nonce to Next.js rendering. */
export const CSP_NONCE_HEADER = "x-lumithink-csp-nonce" as const;

/** Response header set by the middleware. */
export const CSP_RESPONSE_HEADER = "Content-Security-Policy" as const;

/**
 * Build the CSP value for one request. `nonce` is a fresh per-request value
 * (the middleware generates it from the edge crypto API). `nodeEnv` adds
 * 'unsafe-eval' ONLY in development (Next dev tooling requires it;
 * production builds do not).
 */
export function buildContentSecurityPolicy(nonce: string, nodeEnv: string): string {
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128) {
    // Fail-closed: a malformed nonce must never produce a CSP without one.
    nonce = "missing-nonce";
  }
  const scriptSelf = nodeEnv === "production" ? "" : " 'self'";
  const unsafeEval = nodeEnv === "development" ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    `script-src${scriptSelf} 'nonce-${nonce}' 'strict-dynamic'${unsafeEval}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * R1-08 CSP middleware (issue #20 AC 1 受限域名访问 / AC 4 基础安全头核验;
 * docs/adr/0003-guardian-auth-v0.md decision 4 carried to R1-08).
 *
 * Per-request nonce CSP: the middleware mints a fresh nonce, forwards it to
 * Next.js rendering via a request header (Next tags its scripts with the
 * nonce when it finds a CSP header on the request) and sets the same CSP on
 * the response. See lib/server/security-headers.ts for the directive set and
 * the disclosed residuals; HSTS/TLS belong to the reverse proxy
 * (deploy/runbook.md).
 */
import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy, CSP_NONCE_HEADER, CSP_RESPONSE_HEADER } from "./lib/server/security-headers.ts";

export function middleware(request: NextRequest): NextResponse {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const csp = buildContentSecurityPolicy(nonce, nodeEnv);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CSP_NONCE_HEADER, nonce);
  requestHeaders.set(CSP_RESPONSE_HEADER, csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_RESPONSE_HEADER, csp);
  return response;
}

export const config = {
  // All routes except immutable static assets (CSP on those is pointless and
  // the nonce machinery must not run per-asset).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

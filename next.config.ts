import type { NextConfig } from "next";

/**
 * R1-06 deployment-model review disposition (issue #18 实现范围 4,
 * docs/adr/0003-guardian-auth-v0.md): minimal, conservative security
 * headers on every route. The guardian session uses an Authorization
 * header instead of cookies, so no CSRF/cookie-affecting header knobs are
 * needed; these three headers close the classic content-sniffing /
 * framing / referrer leaks without touching Next.js runtime behavior.
 * Broader deployment hardening (HTTPS, CSP with nonces, HSTS) is R1-08.
 */
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;

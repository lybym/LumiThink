import type { Config } from "tailwindcss";

/**
 * Tailwind v3 configuration for the frozen 1.x prototype pages.
 * The existing app/globals.css uses the v3 directives
 * (`@tailwind base/components/utilities`), so the project stays on the v3
 * line until the 2.0 UI work (R1-05) decides otherwise.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;

import localFont from "next/font/local";

// Self-hosted and committed: both are OFL (licenses beside the files), so the
// build fetches nothing and the CSP's font-src 'self' holds. Latin subsets.
// The fallback stacks name system sans and mono faces only, so no element can
// fall back to a serif.
export const instrumentSans = localFont({
  src: [
    { path: "./fonts/instrument-sans/InstrumentSans-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/instrument-sans/InstrumentSans-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/instrument-sans/InstrumentSans-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/instrument-sans/InstrumentSans-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-instrument",
  display: "swap",
  fallback: ["ui-sans-serif", "system-ui", "Segoe UI", "Roboto", "sans-serif"],
});

export const jetbrainsMono = localFont({
  src: [
    { path: "./fonts/jetbrains-mono/JetBrainsMono-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/jetbrains-mono/JetBrainsMono-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-jetbrains",
  display: "swap",
  fallback: ["ui-monospace", "Menlo", "Consolas", "monospace"],
});

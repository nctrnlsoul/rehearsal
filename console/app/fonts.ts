import localFont from "next/font/local";

// Self-hosted. Switzer is fetched at build time by scripts/fetch-fonts.mjs
// because its license forbids committing the files; DM Mono is OFL and committed.
export const switzer = localFont({
  src: [
    { path: "./fonts/switzer/Switzer-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/switzer/Switzer-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/switzer/Switzer-Semibold.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-switzer",
  display: "swap",
});

export const dmMono = localFont({
  src: [
    { path: "./fonts/dm-mono/DMMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/dm-mono/DMMono-Medium.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-dm-mono",
  display: "swap",
});

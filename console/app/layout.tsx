import type { Metadata } from "next";
import { headers } from "next/headers";
import { instrumentSans, jetbrainsMono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rehearsal",
  description: "A PayPal sandbox scenario engine. Real sandbox records, real verified webhooks, verdicts on evidence.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request makes every page render per request, which is what lets
  // Next stamp this request's CSP nonce on its scripts (see middleware.ts).
  await headers();
  return (
    <html lang="en" className={`${instrumentSans.variable} ${jetbrainsMono.variable}`}>
      <body>
        {children}
      </body>
    </html>
  );
}

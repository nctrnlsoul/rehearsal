export const metadata = {
  title: "Ember and Wick",
  description: "A sample merchant app used as the subject of REHEARSAL's edge-case finder",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-monospace, monospace", padding: "2rem", lineHeight: 1.6 }}>
        {children}
      </body>
    </html>
  );
}

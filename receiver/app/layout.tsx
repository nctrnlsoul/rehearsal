export const metadata = {
  title: "REHEARSAL receiver",
  description: "Sandbox webhook receiver for REHEARSAL gate 5",
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

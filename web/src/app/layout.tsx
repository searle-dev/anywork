import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AnyWork - AI Agent Platform",
  description: "Open-source cloud-native AI agent platform powered by nanobot",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}

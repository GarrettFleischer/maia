/**
 * @fileoverview Root layout for Maia Next.js app.
 * @module app/layout
 */

import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Maia",
  description: "Maia agents platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="theme-midnight">
      <body>{children}</body>
    </html>
  );
}

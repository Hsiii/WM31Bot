import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WM31Bot",
  description: "Vercel-compatible Discord role management bot",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
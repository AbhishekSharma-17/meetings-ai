import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import "./styles.css";
import { PWA_COLORS } from "@/lib/pwa-colors";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Meetings AI",
  description: "An AI meeting assistant for thoughtful follow-through.",
  appleWebApp: { capable: true, title: "Meetings AI", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: PWA_COLORS.surfaceLight },
    { media: "(prefers-color-scheme: dark)", color: PWA_COLORS.surfaceDark },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body><ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>{children}</ThemeProvider></body>
    </html>
  );
}

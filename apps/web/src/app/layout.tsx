import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import "./styles.css";

export const metadata: Metadata = {
  title: "Meetings AI",
  description: "An AI meeting assistant for thoughtful follow-through.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body><ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>{children}</ThemeProvider></body>
    </html>
  );
}

import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Meetings AI",
  description: "An AI meeting assistant for thoughtful follow-through.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

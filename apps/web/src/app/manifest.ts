import type { MetadataRoute } from "next";
import { PWA_COLORS } from "@/lib/pwa-colors";

/** Installable app ("Add to home screen"), mainly so the in-person recorder opens in one tap on phones. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Meetings AI",
    short_name: "Meetings AI",
    description: "Record meetings, review minutes and ask your meeting knowledge.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: PWA_COLORS.surfaceLight,
    theme_color: PWA_COLORS.brand,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}

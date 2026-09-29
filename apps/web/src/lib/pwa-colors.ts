/**
 * Browser-chrome colours for the web app manifest and the theme-color meta tag. These must be
 * literal colours (CSS variables are not read there); they mirror the tokens in app/styles.css:
 * --background (light and dark) and --brand (light).
 */
export const PWA_COLORS = {
  surfaceLight: "rgb(249, 250, 252)",
  surfaceDark: "rgb(14, 17, 20)",
  brand: "rgb(21, 104, 100)",
} as const;

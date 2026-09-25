// Adapted from modern-frontend-design: verify actual Meetings AI OKLCH tokens.
import { readFileSync } from "node:fs";

function parseOklch(value) {
  const match = value.trim().match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.%]+)?\s*\)$/i);
  if (!match) throw new Error(`Not an OKLCH value: ${value}`);
  return { L: match[2] ? Number(match[1]) / 100 : Number(match[1]), C: Number(match[3]), h: Number(match[4]) };
}

function luminance(value) {
  const { L, C, h } = parseOklch(value);
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + .3963377774 * a + .2158037573 * b) ** 3;
  const m = (L - .1055613458 * a - .0638541728 * b) ** 3;
  const s = (L - .0894841775 * a - 1.291485548 * b) ** 3;
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
    -.0041960863 * l - .7034186147 * m + 1.707614701 * s,
  ];
  const clipped = channels.map((channel) => Math.min(1, Math.max(0, channel)));
  return { value: .2126 * clipped[0] + .7152 * clipped[1] + .0722 * clipped[2], outOfGamut: channels.some((channel) => channel < -.0005 || channel > 1.0005) };
}

export function contrast(foreground, background) {
  const first = luminance(foreground), second = luminance(background);
  const [high, low] = first.value >= second.value ? [first.value, second.value] : [second.value, first.value];
  return { ratio: (high + .05) / (low + .05), outOfGamut: first.outOfGamut || second.outOfGamut };
}

function tokensFor(selector, source) {
  const block = source.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
  if (!block) throw new Error(`Missing ${selector} tokens`);
  return Object.fromEntries([...block[1].matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

const source = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const themes = { light: tokensFor(":root", source), dark: tokensFor(".dark", source) };
const pairs = [];
for (const [theme, tokens] of Object.entries(themes)) {
  const pair = (label, foreground, background, need) => pairs.push([`${theme}: ${label}`, tokens[foreground] ?? foreground, tokens[background] ?? background, need]);
  for (const surface of ["card", "background", "muted", "sidebar"]) {
    pair(`primary on ${surface}`, "foreground", surface, 4.5);
    pair(`secondary on ${surface}`, "text-secondary", surface, 4.5);
  }
  pair("tertiary on card", "text-tertiary", "card", 4.5);
  pair("strong input border on card", "border-strong", "card", 3);
  pair("brand text on card", "brand", "card", 4.5);
  pair("brand text on subtle", "brand", "brand-subtle", 4.5);
  pair("brand on card", "brand", "card", 3);
  pair("brand foreground on brand", "brand-foreground", "brand", 4.5);
  pair("brand foreground on hover", "brand-foreground", "brand-hover", 4.5);
  pair("brand foreground on active", "brand-foreground", "brand-active", 4.5);
  for (const surface of ["card", "background", "muted", "sidebar"]) pair(`focus ring on ${surface}`, "ring", surface, 3);
  for (const status of ["success", "warning", "info", "destructive"]) {
    pair(`${status} text on card`, `${status}-text`, "card", 4.5);
    pair(`${status} text on subtle`, `${status}-text`, `${status}-subtle`, 4.5);
    pair(`${status} dot on card`, status, "card", 3);
  }
}

const [, , foregroundArg, backgroundArg] = process.argv;
if (foregroundArg && backgroundArg) {
  const result = contrast(foregroundArg, backgroundArg);
  console.log(`${result.ratio.toFixed(2)}:1${result.outOfGamut ? " [out of sRGB gamut]" : ""}`);
} else {
  let failures = 0;
  for (const [label, foreground, background, need] of pairs) {
    const result = contrast(foreground, background);
    const pass = result.ratio >= need && !result.outOfGamut;
    if (!pass) failures++;
    console.log(`${pass ? "PASS" : "FAIL"} ${result.ratio.toFixed(2)}:1 ${label}${result.outOfGamut ? " [out of sRGB gamut]" : ""}`);
  }
  console.log(`${pairs.length - failures}/${pairs.length} contrast checks passed`);
  if (failures) process.exitCode = 1;
}

// Adapted from modern-frontend-design for the single-admin Meetings AI SPA.
// Optional: MEETINGS_AI_ADMIN_PASSWORD lets this witness authenticated views.
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3020";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
  console.error("Smoke render accepts localhost only");
  process.exit(2);
}

for (let attempt = 0; attempt < 30; attempt++) {
  try { if ((await fetch(base)).ok) break; } catch { /* server is starting */ }
  if (attempt === 29) throw new Error(`Local preview did not start at ${base}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? undefined });
try {
  for (const path of ["/", "/styleguide"]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(base + path, { waitUntil: "networkidle" });
    if (!response || response.status() >= 500 || errors.length) throw new Error(`${path} did not render: ${response?.status() ?? "no response"} ${errors.join("; ")}`);
    if (!(await page.locator("h1").count())) throw new Error(`${path} rendered without a page heading`);
    if (path === "/" && process.env.MEETINGS_AI_ADMIN_PASSWORD) {
      await page.locator("#admin-password").fill(process.env.MEETINGS_AI_ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("heading", { name: /From conversation/ }).waitFor();
      await page.getByRole("button", { name: "AI providers" }).click();
      await page.getByRole("heading", { name: "AI providers" }).waitFor();
      await page.getByRole("button", { name: "Workspace", exact: true }).click();
      await page.getByRole("heading", { name: "Workspace settings" }).waitFor();
      await page.getByText("Not yet multi-tenant.").waitFor();
      await page.getByText("Local administrator").waitFor();
      if (errors.length) throw new Error(`Authenticated views crashed: ${errors.join("; ")}`);
      console.log("Authenticated dashboard, providers, and workspace rendered");
    }
    console.log(`${path} rendered`);
    await page.close();
  }
} finally {
  await browser.close();
}

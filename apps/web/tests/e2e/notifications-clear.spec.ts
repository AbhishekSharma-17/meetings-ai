import { expect, test, type Page } from "@playwright/test";

const workspace = {
  id: "00000000-0000-4000-8000-000000000001", slug: "genai-protos", display_name: "GenAI Protos", contact_email: null,
  status: "active", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", tenant_isolation_enabled: true,
};
const owner = {
  user_id: "00000000-0000-4000-8000-000000000002", organization_id: workspace.id, email: "owner@example.test",
  display_name: "Workspace owner", role: "owner", must_change_password: false,
};

type Note = { id: string; kind: string; severity: string; title: string; body: string | null; link_view: null; link_id: null; meeting_id: null; created_at: string; read_at: string | null };

function note(index: number, title: string, body: string | null, read: boolean): Note {
  return {
    id: `00000000-0000-4000-8000-00000000050${index}`, kind: "prep.ready", severity: "success", title, body,
    link_view: null, link_id: null, meeting_id: null, created_at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
    read_at: read ? new Date().toISOString() : null,
  };
}

/** A tiny in-memory notification API that honours DELETE /v1/notifications?read_only=. */
async function mockApi(page: Page, initial: Note[]) {
  let notes = [...initial];
  const clears: string[] = [];
  const unread = () => notes.filter((item) => !item.read_at).length;
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === "/v1/notifications" && method === "DELETE") {
      const readOnly = url.searchParams.get("read_only") === "true";
      clears.push(readOnly ? "read" : "all");
      const before = notes.length;
      notes = readOnly ? notes.filter((item) => !item.read_at) : [];
      return route.fulfill({ json: { cleared: before - notes.length, unread_count: unread() } });
    }
    if (path === "/v1/notifications") return route.fulfill({ json: { items: notes, next_cursor: null, unread_count: unread() } });
    if (path === "/v1/notifications/unread-count") return route.fulfill({ json: { unread_count: unread() } });
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: owner });
    if (path === "/v1/workspace") return route.fulfill({ json: workspace });
    if (path === "/v1/workspaces") return route.fulfill({ json: [{ id: workspace.id, slug: workspace.slug, display_name: workspace.display_name, role: "owner" }] });
    if (path === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (path === "/v1/provider-profiles" || path === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (path === "/v1/calendar/synced") return route.fulfill({ json: { events: [], syncs: [] } });
    if (path === "/v1/background-jobs") return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
  return clears;
}

const bell = (page: Page) => page.getByRole("button", { name: /^Notifications/ });
const seed = () => [
  note(1, "Briefing ready for “Acme Robotics”", "Your meeting briefing is saved.", false),
  note(2, "Minutes drafted for “Weekly sync”", "Review and send the recap.", false),
  note(3, "Recap sent", "Delivered to 4 attendees.", true),
  note(4, "Document indexed", "Pricing sheet.pdf is searchable.", true),
];

test("search filters the loaded notifications by title and body", async ({ page }) => {
  await mockApi(page, seed());
  await page.goto("/");
  await bell(page).click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  const search = panel.getByRole("searchbox", { name: "Search notifications" });
  await expect(panel.getByRole("listitem")).toHaveCount(4);

  await search.fill("recap");
  await expect(panel.getByRole("listitem")).toHaveCount(2); // "Recap sent" (title) and "Review and send the recap." (body)
  await search.fill("pricing sheet");
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel.getByText("Document indexed")).toBeVisible();

  await search.fill("zebra");
  await expect(panel.getByText("No notifications match “zebra”")).toBeVisible();
  await panel.getByRole("button", { name: "Clear filters" }).click();
  await expect(search).toHaveValue("");
  await expect(panel.getByRole("listitem")).toHaveCount(4);

  await panel.getByRole("button", { name: /^Unread/ }).click();
  await search.fill("recap");
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel.getByText("Minutes drafted for “Weekly sync”")).toBeVisible();
});

test("clear read keeps unread notifications after confirming", async ({ page }) => {
  const clears = await mockApi(page, seed());
  await page.goto("/");
  await expect(bell(page)).toHaveAccessibleName("Notifications, 2 unread");
  await bell(page).click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await panel.getByRole("button", { name: "Clear read" }).click();
  const confirm = panel.getByRole("group", { name: "Confirm clearing notifications" });
  await expect(confirm).toContainText("Clear read notifications? Unread ones stay.");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();

  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(clears).toEqual([]);
  await expect(panel.getByRole("listitem")).toHaveCount(4);

  await panel.getByRole("button", { name: "Clear read" }).click();
  await panel.getByRole("group", { name: "Confirm clearing notifications" }).getByRole("button", { name: "Clear read" }).click();
  await expect(panel.getByRole("listitem")).toHaveCount(2);
  await expect(panel.getByText("Recap sent")).toHaveCount(0);
  expect(clears).toEqual(["read"]);
  await expect(panel.getByRole("button", { name: "Clear read" })).toBeDisabled();
  await expect(bell(page)).toHaveAccessibleName("Notifications, 2 unread");
});

test("clear all empties the panel and the unread badge", async ({ page }) => {
  const clears = await mockApi(page, seed());
  await page.goto("/");
  await bell(page).click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await panel.getByRole("button", { name: "Clear all" }).click();
  const confirm = panel.getByRole("group", { name: "Confirm clearing notifications" });
  await expect(confirm).toContainText("Clear all notifications? This can’t be undone.");
  await confirm.getByRole("button", { name: "Clear all" }).click();

  await expect(panel.getByText("Notifications cleared")).toBeVisible();
  await expect(panel.getByRole("listitem")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Clear all" })).toHaveCount(0);
  await expect(panel.getByRole("searchbox", { name: "Search notifications" })).toHaveCount(0);
  await expect(bell(page)).toHaveAccessibleName("Notifications");
  expect(clears).toEqual(["all"]);
});

test("a failed clear keeps the list and explains what happened", async ({ page }) => {
  await mockApi(page, seed());
  await page.route((url) => url.pathname === "/v1/notifications" && url.searchParams.get("read_only") === "true", (route) => route.fulfill({ status: 500, json: { detail: "boom" } }));
  await page.goto("/");
  await bell(page).click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await panel.getByRole("button", { name: "Clear read" }).click();
  await panel.getByRole("group", { name: "Confirm clearing notifications" }).getByRole("button", { name: "Clear read" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Read notifications could not be cleared. Try again.");
  await expect(panel.getByRole("listitem")).toHaveCount(4);
});

import { apolloView } from "../fixtures/apollo";
import { json, noContent, problem, str, wait } from "../http";
import type { DemoRouter } from "../router";

/*
 * AI providers → Research sources in the demo: the sample workspace starts with Apollo connected.
 * A pasted key is never sent anywhere; keys containing "bad" are "rejected" to show the error state.
 */
export function registerApollo(router: DemoRouter): void {
  router
    .on("GET", "/v1/workspace/integrations/apollo", ({ store }) => json(apolloView(store.apollo)))
    .on("PUT", "/v1/workspace/integrations/apollo", async ({ store, body }) => {
      await wait(700);
      const key = (str(body.api_key) ?? "").trim();
      if (key.length < 8 || /\s/.test(key)) return problem(400, "Paste the Apollo API key exactly as shown in Apollo (8–200 characters, no spaces).");
      if (/bad/i.test(key)) return problem(400, "Apollo rejected this API key. Check it in Apollo → Settings → Integrations → API and try again.");
      const now = new Date().toISOString();
      store.apollo = { connected: true, hint: `••••${key.slice(-4)}`, connectedAt: now, checkedAt: now };
      return json(apolloView(store.apollo, true));
    })
    .on("POST", "/v1/workspace/integrations/apollo/test", async ({ store }) => {
      if (!store.apollo.connected) return problem(404, "Apollo is not connected for this workspace.");
      await wait(500);
      store.apollo = { ...store.apollo, checkedAt: new Date().toISOString() };
      return json(apolloView(store.apollo, true));
    })
    .on("DELETE", "/v1/workspace/integrations/apollo", ({ store }) => {
      if (!store.apollo.connected) return problem(404, "Apollo is not connected for this workspace.");
      store.apollo = { ...store.apollo, connected: false };
      return noContent();
    });
}

import { json, problem, readBody } from "./http";
import type { DemoStore } from "./store";

export type DemoRequest = {
  store: DemoStore;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  form: FormData | null;
  headers: Headers;
};

export type Handler = (request: DemoRequest) => Response | Promise<Response>;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };

export class DemoRouter {
  private readonly routes: Route[] = [];

  /** Registers `METHOD /v1/path/:param`; first match wins. */
  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const source = path.replace(/:([a-zA-Z]+)/g, (_, key: string) => { keys.push(key); return "([^/]+)"; });
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  async handle(store: DemoStore, method: string, url: URL, init: { body?: BodyInit | null; headers?: HeadersInit }): Promise<Response> {
    const path = url.pathname.replace(/\/+$/, "");
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(path);
      if (!match) continue;
      const params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
      const { json: body, form } = await readBody(init.body);
      try {
        return await route.handler({ store, method, path, params, query: url.searchParams, body, form, headers: new Headers(init.headers) });
      } catch {
        return problem(500, "Demo: this sample action could not be completed.");
      }
    }
    return json({ detail: `Demo: ${method} ${path} is not part of the sample workspace.` }, 404);
  }
}

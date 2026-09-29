import type { ReactNode } from "react";
import type { PrepSourceOrigin } from "@/lib/types";

/** Only follow web links; anything else renders as plain text. */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch { return undefined; }
}

export function hostname(url: string | null | undefined): string {
  if (!url) return "";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

type CitableSource = { id: string; title: string; url: string | null; origin?: PrepSourceOrigin };

export const originLabels: Record<PrepSourceOrigin, string> = {
  web: "Public web",
  provided_link: "Links you provided",
  our_documents: "Our documents",
  prep_upload: "Uploaded for this meeting",
  organization_brief: "Our company profile",
  apollo: "Apollo (verified B2B data)",
};

/** A source chip: a link for public URLs, an anchor to the source list for our own documents. */
export function Citation({ id, source }: { id: string; source: CitableSource }) {
  const href = safeHref(source.url);
  const internal = source.origin && source.origin !== "web" && source.origin !== "provided_link" && source.origin !== "apollo";
  if (href) return <a className="prep-citation" href={href} target="_blank" rel="noreferrer noopener" aria-label={`Source ${id}`} title={source.title}>{id}</a>;
  return <a className={internal ? "prep-citation internal" : "prep-citation"} href={`#prep-source-${id}`} aria-label={`Source ${id}`} title={source.title}>{id}</a>;
}

export function Citations({ ids, sources }: { ids: string[]; sources: Map<string, CitableSource> }) {
  const found = ids.filter((id) => sources.has(id));
  if (!found.length) return null;
  return <span className="prep-citations">{found.map((id) => <Citation key={id} id={id} source={sources.get(id)!} />)}</span>;
}

export function SectionHeading({ icon, children, count }: { icon: ReactNode; children: ReactNode; count?: number }) {
  return <h3><span className="prep-section-icon" aria-hidden="true">{icon}</span>{children}{count ? <span className="section-count">{count}</span> : null}</h3>;
}

export function ListSection({ title, icon, items, tone, ordered = false }: { title: string; icon: ReactNode; items: string[]; tone?: "warning"; ordered?: boolean }) {
  if (!items.length) return null;
  const List = ordered ? "ol" : "ul";
  return <section className={tone ? `prep-report-section ${tone}` : "prep-report-section"}>
    <SectionHeading icon={icon}>{title}</SectionHeading>
    <List className={ordered ? "prep-ordered" : undefined}>{items.map((item, index) => <li key={index}>{item}</li>)}</List>
  </section>;
}

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatTokens(input: number, output: number): string {
  const total = input + output;
  return `${total.toLocaleString()} tokens`;
}

export const briefingTime: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

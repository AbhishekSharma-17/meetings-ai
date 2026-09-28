"use client";

import { ExternalLink, FileText } from "lucide-react";
import type { PrepSourceOrigin, PrepSourceV2 } from "@/lib/types";
import { hostname, originLabels, safeHref } from "./prep-shared";
import { FilterInput, NoMatches } from "./scroll-panel";
import { useListSearch } from "./use-list-search";

const originOrder: PrepSourceOrigin[] = ["provided_link", "web", "prep_upload", "our_documents", "organization_brief"];

/** Sources grouped by where they came from, so public evidence and our private material stay distinct. */
export function PrepSources({ sources }: { sources: PrepSourceV2[] }) {
  const search = useListSearch(sources, (source) => [source.id, source.title, source.publisher, hostname(source.url), source.published_date, originLabels[source.origin]]);
  if (!sources.length) return null;
  const groups = originOrder.map((origin) => [origin, search.visible.filter((source) => source.origin === origin)] as const)
    .filter(([, items]) => items.length);
  return <section className="prep-report-section prep-sources" aria-labelledby="prep-sources-title">
    <h3 id="prep-sources-title">Sources <span className="section-count">{sources.length}</span></h3>
    {search.offered ? <div className="list-search-inline"><FilterInput id="prep-source-search" label="Search sources" value={search.query} onChange={search.setQuery} placeholder="Search title, publisher or site" /></div> : null}
    {search.noMatches ? <NoMatches query={search.query} noun="sources" onClear={search.clear} /> : null}
    <div className="prep-source-groups">
      {groups.map(([origin, items]) => <div key={origin} className="prep-source-group">
        <h4>{originLabels[origin]}</h4>
        <ol>{items.map((source) => {
          const href = safeHref(source.url);
          const detail = [source.publisher || hostname(source.url), source.published_date].filter(Boolean).join(" · ");
          return <li key={source.id} id={`prep-source-${source.id}`}>
            <span className="prep-source-id">{source.id}</span>
            <span className="prep-source-copy">
              {href
                ? <a href={href} target="_blank" rel="noreferrer noopener">{source.title} <ExternalLink aria-hidden="true" /></a>
                : <b><FileText aria-hidden="true" />{source.title}</b>}
              {detail ? <small>{detail}</small> : null}
            </span>
          </li>;
        })}</ol>
      </div>)}
    </div>
  </section>;
}

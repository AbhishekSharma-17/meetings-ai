"use client";

import { useEffect, useRef } from "react";
import { MessageSquareText } from "lucide-react";
import type { InPersonCaption } from "@/lib/in-person-types";
import { formatClock } from "./use-in-person";

/** Rough live captions while recording; the final transcript is made after stop. */
export function InPersonCaptions({ captions }: { captions: InPersonCaption[] }) {
  const list = useRef<HTMLOListElement>(null);
  const last = captions.at(-1);
  useEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [last?.seq, last?.text]);
  return <section className="card ip-captions" aria-labelledby="ip-captions-title">
    <div className="card-header"><div><h3 id="ip-captions-title">Live preview — speakers are identified after you stop</h3></div></div>
    <ol ref={list} className="ip-caption-list" role="log" aria-live="polite" aria-label="Live preview">
      {captions.map((caption) => <li key={`${caption.seq}-${caption.start_ms}`}><span className="ip-caption-time tabular">{formatClock(caption.start_ms)}</span><span>{caption.text}</span></li>)}
    </ol>
    {captions.length ? null : <p className="ip-caption-empty"><MessageSquareText aria-hidden="true" />Captions appear here a few seconds after people speak.</p>}
  </section>;
}

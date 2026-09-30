"use client";

import { useEffect, useRef } from "react";
import { MessageSquareText } from "lucide-react";
import type { InPersonCaption } from "@/lib/in-person-types";
import { EmptyState } from "./ui/feedback";
import { ScrollPanel } from "./scroll-panel";
import { formatClock } from "./use-in-person";

/** Rough live captions while recording; the final transcript is made after stop. */
export function InPersonCaptions({ captions, problem = null }: { captions: InPersonCaption[]; problem?: string | null }) {
  const list = useRef<HTMLOListElement>(null);
  const last = captions.at(-1);
  // Keep the newest line in view; the scrolling element is the panel's viewport around the list.
  useEffect(() => {
    const viewport = list.current?.parentElement;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [last?.seq, last?.text]);
  return <section className="card ip-captions" aria-labelledby="ip-captions-title">
    <div className="card-header">
      <div>
        <h2 id="ip-captions-title">Live preview</h2>
        <p>Rough captions from the room. Speakers are identified after you stop.</p>
        {problem ? <p role="status">Live preview paused: {problem}</p> : null}
      </div>
    </div>
    <ScrollPanel label="Live preview captions" size="sm">
      {/* The log stays mounted (even when empty) so screen readers announce the first captions. */}
      <ol ref={list} className="ip-caption-list" role="log" aria-live="polite" aria-label="Live preview">
        {captions.map((caption) => <li key={`${caption.seq}-${caption.start_ms}`}><span className="ip-caption-time tabular">{formatClock(caption.start_ms)}</span><span>{caption.text}</span></li>)}
      </ol>
      {captions.length ? null : <EmptyState plain icon={<MessageSquareText />} title="No captions yet">Captions appear here a few seconds after people speak.</EmptyState>}
    </ScrollPanel>
  </section>;
}

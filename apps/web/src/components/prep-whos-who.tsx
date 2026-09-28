"use client";

import { useEffect, useRef, useState } from "react";
import { prepService, serviceErrorStatus } from "@/lib/meetings-service";
import type { AttendeeSides, WhosWho } from "@/lib/types";
import { Skeleton } from "./ui/feedback";
import { WhosWhoView, type SideChange } from "./prep-whos-who-view";

const PREVIEW_DELAY_MS = 350;

/** `answered` is the request key the current value belongs to; a newer key means an update is on its way. */
type PreviewState = { status: "loading" | "ready" | "error" | "unavailable"; value: WhosWho | null; answered: string | null };

/** Applies one correction immutably: a side pins the attendee, null returns them to automatic. */
export function withSide(sides: AttendeeSides, key: string, side: "ours" | "theirs" | null): AttendeeSides {
  const rest = Object.fromEntries(Object.entries(sides).filter(([item]) => item !== key));
  return side ? { ...rest, [key]: side } : rest;
}

/** Corrections carried by a saved briefing, so a refresh keeps what the organizer fixed last time. */
export function sidesFromReport(value: WhosWho | null | undefined): AttendeeSides {
  const entries = (value?.attendees ?? []).filter((person) => person.overridden && (person.side === "ours" || person.side === "theirs"));
  return Object.fromEntries(entries.map((person) => [person.key, person.side as "ours" | "theirs"]));
}

/**
 * Live "who's who" for the prep inputs: our company and colleagues vs. the client and their people,
 * recomputed (debounced) as the target, website or corrections change. Hidden on APIs without it.
 */
export function PrepWhosWho({ eventId, targetCompany, website, sides, onSidesChange, canEdit, disabled = false, onOpenOrganization }: {
  eventId: string;
  targetCompany: string;
  /** Pass "" while the typed website is invalid so the preview ignores it. */
  website: string;
  sides: AttendeeSides;
  onSidesChange(next: AttendeeSides): void;
  canEdit: boolean;
  /** Corrections are paused (e.g. while a briefing is being generated). */
  disabled?: boolean;
  onOpenOrganization?(): void;
}) {
  const [state, setState] = useState<PreviewState>({ status: "loading", value: null, answered: null });
  const sequence = useRef(0);
  const sidesKey = JSON.stringify(sides);
  const requestKey = JSON.stringify([eventId, targetCompany.trim(), website.trim(), sidesKey]);
  const updating = state.status === "ready" && state.answered !== requestKey;

  useEffect(() => {
    const request = ++sequence.current;
    const timer = window.setTimeout(() => {
      prepService.previewWhosWho(eventId, {
        target_company: targetCompany.trim() || null, company_website: website.trim() || null,
        attendee_sides: JSON.parse(sidesKey) as AttendeeSides,
      }).then((value) => {
        if (request === sequence.current) setState({ status: "ready", value, answered: requestKey });
      }, (cause: unknown) => {
        if (request !== sequence.current) return;
        const status = serviceErrorStatus(cause);
        setState((current) => status === 404 || status === 405 ? { status: "unavailable", value: null, answered: requestKey }
          : { status: current.value ? "ready" : "error", value: current.value, answered: requestKey });
      });
    }, PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [eventId, targetCompany, website, sidesKey, requestKey]);

  if (state.status === "unavailable") return null;
  const change: SideChange = (key, side) => onSidesChange(withSide(sides, key, side));
  return <section className="prep-whos-who" aria-labelledby="prep-whos-who-title" aria-busy={updating || state.status === "loading"}>
    <div className="prep-whos-who-head">
      <div>
        <h3 id="prep-whos-who-title">Who’s who</h3>
        <p className="field-hint">How the briefing tells your side from the client’s. Only the client’s people and third parties are researched. Fix anything that’s wrong before generating.</p>
      </div>
      {updating ? <span className="spinner" role="status" aria-label="Updating who’s who" /> : null}
    </div>
    {state.status === "loading" ? <Skeleton lines={3} />
      : state.status === "error" || !state.value ? <p className="form-error" role="alert">Who’s who couldn’t be worked out right now. You can still generate; the briefing will classify attendees itself.</p>
        : <WhosWhoView value={state.value} onSide={canEdit ? change : undefined} disabled={disabled} onOpenOrganization={onOpenOrganization} />}
  </section>;
}

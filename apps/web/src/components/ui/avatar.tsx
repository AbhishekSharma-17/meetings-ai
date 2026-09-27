"use client";

import { useState } from "react";
import { initials } from "@/lib/meeting-status";

export type AvatarSize = "sm" | "md" | "lg";

const PIXELS: Record<AvatarSize, number> = { sm: 22, md: 28, lg: 40 };
const ASSISTANT_LOGO = "/icon.svg";

/**
 * A person's profile photo, falling back to initials; or the Meetings AI logo for the assistant.
 * Decorative by default (the name is shown next to it). Pass `standalone` when it is the only
 * thing identifying the person, so assistive tech gets the name.
 */
export function Avatar({ name, photoUrl, size = "md", kind = "person", standalone = false, fallback, className }: {
  name: string | null | undefined;
  photoUrl?: string | null;
  size?: AvatarSize;
  kind?: "person" | "assistant";
  standalone?: boolean;
  /** Text shown instead of computed initials, e.g. "?" for an unidentified speaker. */
  fallback?: string;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const label = name?.trim() || (kind === "assistant" ? "Meetings AI" : "Unknown person");
  const src = kind === "assistant" ? ASSISTANT_LOGO : photoUrl && photoUrl !== failedUrl ? photoUrl : null;
  const classes = ["avatar", size === "md" ? null : size, kind === "assistant" ? "avatar-assistant" : null, src ? "avatar-photo" : null, className]
    .filter(Boolean).join(" ");
  if (!src) {
    const a11y = standalone ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
    return <span className={classes} {...a11y}>{fallback ?? initials(name)}</span>;
  }
  return <span className={classes} aria-hidden={standalone ? undefined : true}>
    {/* Plain img on purpose: photos are per-user, cookie-authenticated API responses the Next optimizer must not proxy. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={src} alt={standalone ? label : ""} width={PIXELS[size]} height={PIXELS[size]} decoding="async" draggable={false}
      onError={kind === "person" ? () => setFailedUrl(src) : undefined} />
  </span>;
}

/** The assistant's name when a meeting does not say otherwise (see MeetingDetail.botName). */
export const DEFAULT_ASSISTANT_NAME = "Meetings AI";

/** True when a transcript speaker or participant label is the meeting's own assistant. */
export function isAssistantName(name: string | null | undefined, assistantName: string | null | undefined): boolean {
  const normalise = (value: string | null | undefined) => (value ?? "").trim().toLocaleLowerCase();
  const target = normalise(assistantName);
  return Boolean(target) && normalise(name) === target;
}

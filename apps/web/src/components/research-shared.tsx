"use client";

import { useState } from "react";
import { initials } from "@/lib/meeting-status";
import type { ApolloUsage } from "@/lib/research-types";

const DAY = 86_400_000;

/** "today", "yesterday", "3 days ago", "2 months ago" — how old saved Apollo data is. */
export function dataAge(value: string, now = Date.now()): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "at an unknown time";
  const days = Math.max(0, Math.floor((now - then) / DAY));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 45) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months < 18 ? `${months} months ago` : `${Math.round(days / 365)} years ago`;
}

export function employeesLabel(count: number | null | undefined): string | null {
  return count ? `~${count.toLocaleString()} employees` : null;
}

export function seniorityLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.replaceAll("_", " ");
  return value === "c_suite" ? "C-suite" : value === "vp" ? "VP" : text.charAt(0).toUpperCase() + text.slice(1);
}

/** https-only external link, or undefined. */
export function safeLink(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch { return undefined; }
}

/** A company's logo when Apollo has an https one, else its initials. Decorative: the name is always shown beside it. */
export function CompanyMark({ name, logoUrl, size = "md" }: { name: string; logoUrl?: string | null; size?: "md" | "lg" }) {
  const [failed, setFailed] = useState(false);
  const src = logoUrl && logoUrl.startsWith("https://") && !failed ? logoUrl : null;
  return <span className={`rx-mark ${size}`} aria-hidden="true">
    {src
      // eslint-disable-next-line @next/next/no-img-element -- third-party logo; never proxied through the Next optimizer
      ? <img src={src} alt="" width={size === "lg" ? 48 : 36} height={size === "lg" ? 48 : 36} loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(true)} />
      : initials(name)}
  </span>;
}

/** "12 of 100 Apollo lookups used today". */
export function UsageMeter({ usage }: { usage: ApolloUsage | null | undefined }) {
  if (!usage) return null;
  const left = Math.max(usage.daily_limit - usage.used_today, 0);
  const tone = left === 0 ? "danger" : left <= usage.daily_limit * 0.1 ? "warning" : "neutral";
  return <span className="rx-usage" data-tone={tone} title="Resets at midnight UTC">
    <b>{usage.used_today}</b> of {usage.daily_limit} Apollo lookups used today
  </span>;
}

const DOMAIN = /^(?=.{3,200}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** "https://www.Acme.io/about" → "acme.io"; used for website filters. */
export function cleanDomain(value: string): string {
  const text = value.trim().toLowerCase().replace(/^@/, "").replace(/^[a-z]+:\/\//, "").replace(/^[^@/]*@/, "");
  return text.split(/[/?#:]/)[0].replace(/^www\./, "").replace(/\.$/, "");
}

export function websiteProblem(value: string): string | null {
  return DOMAIN.test(cleanDomain(value)) ? null : "isn’t a website like acme.com";
}

/** One result page's pager: "Page 2 of 5" with previous / next. */
export function Pager({ page, totalPages, busy, onPage }: { page: number; totalPages: number | null; busy: boolean; onPage(page: number): void }) {
  const last = Math.min(totalPages ?? page + 1, 40);
  if (page <= 1 && last <= 1) return null;
  return <nav className="rx-pager" aria-label="Result pages">
    <button type="button" className="button secondary sm" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
    <span>Page {page}{totalPages ? ` of ${Math.min(totalPages, 40)}` : ""}</span>
    <button type="button" className="button secondary sm" disabled={busy || page >= last} onClick={() => onPage(page + 1)}>Next</button>
  </nav>;
}

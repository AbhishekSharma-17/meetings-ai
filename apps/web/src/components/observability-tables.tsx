"use client";

import { useState, type ReactNode } from "react";
import { meetingStatusLabel } from "@/lib/meeting-status";
import { Avatar } from "./ui/avatar";
import type { Meeting, UsageSummary, WorkspaceCalendarConnection, WorkspaceMember } from "@/lib/types";
import { Badge } from "./ui/feedback";
import { FilterInput, matchesQuery, NoMatches, ScrollPanel } from "./scroll-panel";
import { shouldOfferSearch } from "@/lib/search";
import { formatUsd } from "./usage-labels";
import { calendarProviderNames } from "./calendar-providers";
import { roleLabel } from "./workspace-people";

export const money = formatUsd;
const words = (value: string) => value.replaceAll("_", " ");
const capitalize = (value: string) => value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
const CHART_COLORS = 8;
type UsageRow = UsageSummary["by_purpose"][number];

function EmptyRow({ span, children }: { span: number; children: ReactNode }) {
  return <tr className="obs-empty-row"><td colSpan={span}>{children}</td></tr>;
}

/** Card with a heading, an optional search box and a body that scrolls on its own. */
function SearchableCard({ id, title, description, count, search, children, className = "" }: {
  id: string; title: string; description: string; count?: number; className?: string;
  search?: { label: string; placeholder: string; value: string; onChange(value: string): void };
  children: ReactNode;
}) {
  return <section className={`card obs-card ${className}`.trim()} aria-labelledby={`${id}-title`}>
    <div className="card-header">
      <div><h2 id={`${id}-title`}>{title}</h2><p>{description}</p></div>
      {count !== undefined ? <span className="section-count">{count}</span> : null}
    </div>
    {search ? <div className="card-toolbar"><FilterInput id={`${id}-search`} label={search.label} value={search.value} onChange={search.onChange} placeholder={search.placeholder} /></div> : null}
    {children}
  </section>;
}

export function UsageTable({ id, title, description, firstColumn, rows, format, renderName, empty }: { id: string; title: string; description: string; firstColumn: string; rows: UsageRow[]; format(value: string): string; /** Rich first-column content (e.g. a provider logo); defaults to `format`. */ renderName?(value: string): ReactNode; empty: string }) {
  const [query, setQuery] = useState("");
  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
  const visible = rows.filter((row) => matchesQuery(query, [row.name, format(row.name)]));
  const noun = `${firstColumn.toLowerCase()}${firstColumn.endsWith("s") ? "es" : "s"}`;
  return <SearchableCard id={id} title={title} description={description}
    search={shouldOfferSearch(rows.length, query) ? { label: `Search ${noun}`, placeholder: `Search ${noun}`, value: query, onChange: setQuery } : undefined}>
    {rows.length && !visible.length ? <NoMatches query={query} noun={noun} onClear={() => setQuery("")} /> : <div className="obs-table"><table className="data-table">
      <thead><tr><th>{firstColumn}</th><th className="num">Calls</th><th className="num">Tokens in / out</th><th className="num">Estimate</th></tr></thead>
      <tbody>{visible.length ? visible.map((row) => {
        const index = rows.indexOf(row);
        const share = totalRequests ? Math.round((row.requests / totalRequests) * 100) : 0;
        return <tr key={row.name}>
          <td><span className="obs-cell">{renderName ? renderName(row.name) : <span>{format(row.name)}</span>}<span className="obs-share" title={`${share}% of calls`}><span className="obs-bar" aria-hidden="true"><i style={{ width: `${share}%`, background: `var(--chart-${(index % CHART_COLORS) + 1})` }} /></span><small>{share}% of calls{row.unpriced_requests ? ` · ${row.unpriced_requests} unpriced` : ""}</small></span></span></td>
          <td className="num">{row.requests}</td>
          <td className="num">{row.input_tokens.toLocaleString()} / {row.output_tokens.toLocaleString()}</td>
          <td className="num">{money(row.estimated_usd)}</td>
        </tr>;
      }) : <EmptyRow span={4}>{empty}</EmptyRow>}</tbody>
    </table></div>}
  </SearchableCard>;
}

export function PeopleTable({ people }: { people: WorkspaceMember[] }) {
  const [query, setQuery] = useState("");
  const visible = people.filter((person) => matchesQuery(query, [person.display_name, person.email, roleLabel[person.role], person.status]));
  return <SearchableCard id="obs-people" title="People in this workspace" description="Member roles and access status." count={people.length}
    search={shouldOfferSearch(people.length, query) ? { label: "Search people", placeholder: "Search by name, email or role", value: query, onChange: setQuery } : undefined}>
    {people.length && !visible.length ? <NoMatches query={query} noun="people" onClear={() => setQuery("")} /> : <ScrollPanel label="People" className="obs-table"><table className="data-table">
      <thead><tr><th>Person</th><th>Role</th><th>Status</th></tr></thead>
      <tbody>{visible.length ? visible.map((person) => <tr key={person.user_id}>
        <td><span className="obs-person"><Avatar name={person.display_name} photoUrl={person.photo_url} size="sm" /><span className="obs-cell"><span>{person.display_name}</span><small>{person.email || "No email"}</small></span></span></td>
        <td>{roleLabel[person.role] ?? capitalize(person.role)}</td>
        <td><Badge tone={person.status === "active" ? "success" : person.status === "invited" ? "info" : "neutral"} dot>{capitalize(person.status)}</Badge></td>
      </tr>) : <EmptyRow span={3}>No members available.</EmptyRow>}</tbody>
    </table></ScrollPanel>}
  </SearchableCard>;
}

export function AccountsTable({ accounts, error }: { accounts: WorkspaceCalendarConnection[]; error: string | null }) {
  const [query, setQuery] = useState("");
  const visible = accounts.filter((account) => matchesQuery(query, [account.user_name, account.user_email, account.label, words(account.provider), account.status]));
  return <SearchableCard id="obs-accounts" title="Connected meeting accounts" description="Calendar and meeting-source connections for members." count={accounts.length || undefined}
    search={shouldOfferSearch(accounts.length, query) ? { label: "Search accounts", placeholder: "Search by person or source", value: query, onChange: setQuery } : undefined}>
    {error ? <div className="card-body obs-card-alert"><p className="form-error" role="alert">{error}</p></div> : null}
    {accounts.length && !visible.length ? <NoMatches query={query} noun="accounts" onClear={() => setQuery("")} /> : <ScrollPanel label="Connected accounts" className="obs-table"><table className="data-table">
      <thead><tr><th>Account</th><th>Source</th><th>Status</th></tr></thead>
      <tbody>{visible.length ? visible.map((account) => <tr key={account.id}>
        <td><span className="obs-cell"><span>{account.user_name}</span><small>{account.user_email || account.label}</small></span></td>
        <td><span className="obs-cell"><span>{calendarProviderNames[account.provider as keyof typeof calendarProviderNames] ?? capitalize(words(account.provider))}</span><small>{account.label}</small></span></td>
        <td><Badge tone={account.status.toLowerCase() === "active" ? "success" : "warning"} dot>{capitalize(account.status.toLowerCase())}</Badge></td>
      </tr>) : <EmptyRow span={3}>{error ? "Connections unavailable." : "No connected accounts found."}</EmptyRow>}</tbody>
    </table></ScrollPanel>}
  </SearchableCard>;
}

export function MeetingUsageTable({ meetings, usage }: { meetings: Meeting[]; usage: UsageSummary | null }) {
  const [query, setQuery] = useState("");
  const visible = meetings.filter((meeting) => matchesQuery(query, [meeting.title, meeting.platform, meetingStatusLabel[meeting.status] ?? meeting.status]));
  return <SearchableCard id="obs-meetings" className="obs-section" title="Meeting activity and AI use" description="Every meeting with its recorded AI spend in this period, including priced transcription. Unpriced calls are excluded." count={meetings.length}
    search={shouldOfferSearch(meetings.length, query) ? { label: "Search meetings", placeholder: "Search by meeting, platform or status", value: query, onChange: setQuery } : undefined}>
    {meetings.length && !visible.length ? <NoMatches query={query} noun="meetings" onClear={() => setQuery("")} /> : <ScrollPanel label="Meeting activity" className="obs-table"><table className="data-table">
      <thead><tr><th>Meeting</th><th>Capture</th><th className="num">AI calls</th><th className="num">Tokens in / out</th><th className="num">Estimated cost</th></tr></thead>
      <tbody>{visible.length ? visible.map((meeting) => {
        const entry = usage?.by_meeting.find((item) => item.meeting_id === meeting.id);
        return <tr key={meeting.id}>
          <td><span className="obs-cell"><span>{meeting.title}</span><small>{meeting.platform} · {meeting.startsAt}</small></span></td>
          <td><span className={`status ${meeting.status}`}>{meetingStatusLabel[meeting.status] ?? words(meeting.status)}</span></td>
          <td className="num"><span className="obs-cell"><span>{entry?.requests ?? 0}</span>{entry?.unpriced_requests ? <small>{entry.unpriced_requests} unpriced</small> : null}</span></td>
          <td className="num">{entry ? `${entry.input_tokens.toLocaleString()} / ${entry.output_tokens.toLocaleString()}` : <span className="text-tertiary">—</span>}</td>
          <td className="num">{entry ? money(entry.estimated_usd) : <span className="text-tertiary">—</span>}</td>
        </tr>;
      }) : <EmptyRow span={5}>No meeting records found.</EmptyRow>}</tbody>
    </table></ScrollPanel>}
  </SearchableCard>;
}

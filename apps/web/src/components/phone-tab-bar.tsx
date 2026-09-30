"use client";

import type { ReactNode } from "react";
import { BrainCircuit, CalendarDays, House, Menu, Mic, Share2 } from "lucide-react";

export type TabView = "dashboard" | "calendar" | "knowledge" | "shared";
type Role = "owner" | "admin" | "member" | "viewer";

type Tab = { key: string; label: string; icon: ReactNode; view?: TabView; badge?: number; badgeLabel?: string };

/** The tabs a role gets, in order. Record is an action (it opens the in-person setup), not a page. */
export function phoneTabs(role: Role, liveCount: number): Tab[] {
  const admin = role === "owner" || role === "admin";
  const canRecord = role !== "viewer";
  return [
    admin ? { key: "home", label: "Home", icon: <House />, view: "dashboard" as const, badge: liveCount || undefined, badgeLabel: `${liveCount} live` }
      : { key: "shared", label: "Shared", icon: <Share2 />, view: "shared" as const },
    ...(canRecord ? [{ key: "record", label: "Record", icon: <Mic /> }] : []),
    ...(canRecord ? [{ key: "calendar", label: "Calendar", icon: <CalendarDays />, view: "calendar" as const }] : []),
    { key: "knowledge", label: "Knowledge", icon: <BrainCircuit />, view: "knowledge" as const },
  ];
}

/**
 * Phones (≤ 640 px): a bottom tab bar for the most used places; everything else is under More, which
 * opens the same navigation sheet as the top bar's menu button. Hidden by CSS on larger screens.
 */
export function PhoneTabBar({ role, view, liveCount, moreOpen, onNavigate, onRecord, onMore }: {
  role: Role;
  view: string;
  liveCount: number;
  moreOpen: boolean;
  onNavigate(view: TabView): void;
  onRecord(): void;
  onMore(): void;
}) {
  const tabs = phoneTabs(role, liveCount);
  const covered = tabs.some((tab) => tab.view === view);
  return <nav className="phone-tabbar" aria-label="Quick navigation">
    <ul>
      {tabs.map((tab) => {
        const active = tab.view !== undefined && tab.view === view;
        const name = tab.badge ? `${tab.label}, ${tab.badgeLabel}` : tab.label;
        return <li key={tab.key}>
          <button type="button" className="phone-tab" aria-current={active ? "page" : undefined} aria-label={name}
            data-tab={tab.key} onClick={() => tab.view ? onNavigate(tab.view) : onRecord()}>
            <span className="phone-tab-icon" aria-hidden="true">{tab.icon}{tab.badge ? <span className="phone-tab-badge">{tab.badge > 9 ? "9+" : tab.badge}</span> : null}</span>
            <span className="phone-tab-label">{tab.label}</span>
          </button>
        </li>;
      })}
      <li>
        <button type="button" className="phone-tab" data-tab="more" data-active={!covered || moreOpen || undefined}
          aria-haspopup="dialog" aria-expanded={moreOpen} onClick={onMore}>
          <span className="phone-tab-icon" aria-hidden="true"><Menu /></span>
          <span className="phone-tab-label">More</span>
        </button>
      </li>
    </ul>
  </nav>;
}

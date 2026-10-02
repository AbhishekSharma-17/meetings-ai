"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notificationService } from "@/lib/meetings-service";
import type { AppNotification } from "@/lib/types";
import { formatDate, formatFullDateTime, zonedDayKey } from "@/lib/time-store";
import { JOB_ACTIVITY_EVENT } from "./use-background-job";

const POLL_MS = 20_000;
/** While a job this tab started may still be running, look more often so its result arrives promptly. */
const BUSY_POLL_MS = 4_000;
const BUSY_WINDOW_MS = 5 * 60_000;
const PAGE_SIZE = 20;
const TOAST_SEVERITIES = new Set<AppNotification["severity"]>(["success", "danger"]);

/** Where the shell should go when a notification is opened. */
export type NotificationTarget = { view: string; id: string | null };

export function notificationTarget(item: AppNotification): NotificationTarget | null {
  if (!item.link_view) return null;
  return { view: item.link_view, id: item.link_id };
}

export type NotificationGroup = { label: string; items: AppNotification[] };

/** "Today" first, then "Earlier", newest first inside each group. */
export function groupNotifications(items: AppNotification[], now = new Date()): NotificationGroup[] {
  // "Today" in the person's time zone.
  const todayKey = zonedDayKey(now);
  const today = items.filter((item) => zonedDayKey(item.created_at) === todayKey);
  const earlier = items.filter((item) => zonedDayKey(item.created_at) !== todayKey);
  return [{ label: "Today", items: today }, { label: "Earlier", items: earlier }].filter((group) => group.items.length);
}

const relative = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" }) : null;

export function relativeTime(value: string, now = Date.now()): string {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "Just now";
  if (!relative) return formatFullDateTime(value);
  if (abs < 3_600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3_600), "hour");
  if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), "day");
  return formatDate(value, { month: "short", day: "numeric" });
}

/**
 * The signed-in user’s notification feed. Polls the unread count every 20 s (every 4 s for a few minutes after a background job starts) and on window
 * focus (paused while the tab is hidden); loads the list when the panel opens; reports newly
 * arrived success/danger notifications once each so the shell can show a toast.
 */
export function useNotificationFeed(identity: string, open: boolean, onArrived: (item: AppNotification) => void, scope?: "personal" | "workspace") {
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const lastUnread = useRef<number | null>(null);
  const arrived = useRef(onArrived);
  const selection = `${identity}:${scope ?? "all"}`;
  const currentSelection = useRef(selection);
  useEffect(() => { currentSelection.current = selection; }, [selection]);
  useEffect(() => { arrived.current = onArrived; });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await notificationService.list({ limit: PAGE_SIZE, scope });
      if (currentSelection.current !== selection) return null;
      setItems(page.items); setCursor(page.next_cursor); setUnread(page.unread_count); setError(null);
      lastUnread.current = page.unread_count;
      return page.items;
    } catch {
      setError("Notifications could not be loaded.");
      return null;
    } finally { setLoading(false); }
  }, [scope, selection]);

  const announceNew = useCallback(async () => {
    const latest = await notificationService.list({ limit: 10 }).catch(() => null);
    if (!latest) return;
    const known = seen.current;
    seen.current = new Set([...(known ?? []), ...latest.items.map((item) => item.id)]);
    if (!known) return; // first look: everything already there is old news
    const fresh = latest.items.filter((item) => !known.has(item.id) && !item.read_at && TOAST_SEVERITIES.has(item.severity));
    if (fresh[0]) arrived.current(fresh[0]);
  }, []);

  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const count = await notificationService.unreadCount();
      const previous = lastUnread.current;
      lastUnread.current = count;
      setUnread(count);
      if (previous === null || count > previous) await announceNew();
    } catch { /* An API without notifications (404) or a brief outage: keep the last count. */ }
  }, [announceNew]);

  useEffect(() => {
    seen.current = null; lastUnread.current = null;
    queueMicrotask(() => void poll());
    let busyUntil = 0;
    let lastPoll = Date.now();
    const tick = () => {
      const interval = Date.now() < busyUntil ? BUSY_POLL_MS : POLL_MS;
      if (Date.now() - lastPoll >= interval - 250) { lastPoll = Date.now(); void poll(); }
    };
    const timer = window.setInterval(tick, BUSY_POLL_MS);
    const wake = () => { if (!document.hidden) { lastPoll = Date.now(); void poll(); } };
    const jobActivity = () => { busyUntil = Date.now() + BUSY_WINDOW_MS; wake(); };
    window.addEventListener("focus", wake);
    window.addEventListener(JOB_ACTIVITY_EVENT, jobActivity);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearInterval(timer); window.removeEventListener("focus", wake);
      window.removeEventListener(JOB_ACTIVITY_EVENT, jobActivity); document.removeEventListener("visibilitychange", wake);
    };
  }, [identity, poll]);

  useEffect(() => { if (open) queueMicrotask(() => void load()); }, [open, load]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await notificationService.list({ limit: PAGE_SIZE, cursor, scope });
      if (currentSelection.current !== selection) return;
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((known) => known.id === item.id))]);
      setCursor(page.next_cursor);
    } catch { setError("More notifications could not be loaded."); }
    finally { setLoading(false); }
  }, [cursor, scope, selection]);

  const markRead = useCallback((item: AppNotification) => {
    if (item.read_at) return;
    const readAt = new Date().toISOString();
    setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, read_at: readAt } : candidate));
    setUnread((count) => Math.max(0, count - 1));
    lastUnread.current = Math.max(0, (lastUnread.current ?? 1) - 1);
    setError(null);
    void notificationService.markRead(item.id).catch(() => {
      setItems((current) => current.map((candidate) => candidate.id === item.id && candidate.read_at === readAt ? { ...candidate, read_at: null } : candidate));
      setError("Could not mark this notification as read. Please try again.");
      void notificationService.unreadCount().then((count) => { setUnread(count); lastUnread.current = count; }).catch(() => undefined);
    });
  }, []);

  const markAllRead = useCallback(async () => {
    const readAt = new Date().toISOString();
    setItems((current) => current.map((item) => item.read_at ? item : { ...item, read_at: readAt }));
    setUnread(0); lastUnread.current = 0;
    try {
      const remaining = await notificationService.markAllRead(scope);
      setUnread(remaining); lastUnread.current = remaining;
    } catch { setError("Could not mark notifications as read."); void load(); }
  }, [scope, load]);

  const dismiss = useCallback((item: AppNotification) => {
    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    if (!item.read_at) { setUnread((count) => Math.max(0, count - 1)); lastUnread.current = Math.max(0, (lastUnread.current ?? 1) - 1); }
    void notificationService.remove(item.id).catch(() => undefined);
  }, []);

  /** Clears everything (or only read items) on the server, then shows what is left. Resolves false on failure. */
  const clear = useCallback(async (readOnly: boolean): Promise<boolean> => {
    try {
      const result = await notificationService.clear({ readOnly, scope });
      setUnread(result.unread_count); lastUnread.current = result.unread_count; setError(null);
      if (!readOnly) { setItems([]); setCursor(null); return true; }
      setItems((current) => current.filter((item) => !item.read_at));
      await load();
      return true;
    } catch {
      setError(readOnly ? "Read notifications could not be cleared. Try again." : "Notifications could not be cleared. Try again.");
      return false;
    }
  }, [load, scope]);

  return { unread, items, hasMore: Boolean(cursor), loading, error, loadMore, markRead, markAllRead, dismiss, clear, reload: load };
}

/** Pre-selects a record on the destination screen (it reads this saved selection when it mounts). */
export function rememberSelection(key: string, value: string): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* Navigation still works without the preselection. */ }
}

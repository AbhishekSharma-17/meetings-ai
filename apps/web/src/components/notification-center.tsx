"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatFullDateTime } from "@/lib/time-preferences";
import { Popover } from "@base-ui/react/popover";
import {
  Bell, BellOff, BookCheck, BrainCircuit, CalendarClock, CheckCheck, CircleAlert, CircleCheck, Clock, DoorOpen, FileCheck2,
  FileText, FileWarning, Info, MailCheck, MailWarning, NotebookPen, TriangleAlert, Video, VideoOff, X,
} from "lucide-react";
import type { AppNotification } from "@/lib/types";
import { groupNotifications, notificationTarget, relativeTime, useNotificationFeed, type NotificationTarget } from "./notification-feed";

const hidden = { "aria-hidden": true } as const;
const kindIcons: Record<string, ReactNode> = {
  "prep.ready": <NotebookPen {...hidden} />, "prep.failed": <NotebookPen {...hidden} />,
  "assistant.scheduled": <CalendarClock {...hidden} />, "meeting.reminder": <Clock {...hidden} />, "assistant.lobby": <DoorOpen {...hidden} />,
  "assistant.joined": <Video {...hidden} />, "assistant.attention": <TriangleAlert {...hidden} />, "assistant.join_failed": <VideoOff {...hidden} />,
  "assistant.capture_failed": <VideoOff {...hidden} />, "assistant.capture_finished": <FileCheck2 {...hidden} />, "assistant.schedule_missed": <CalendarClock {...hidden} />,
  "minutes.ready": <FileText {...hidden} />, "minutes.failed": <FileWarning {...hidden} />, "recap.sent": <MailCheck {...hidden} />, "recap.failed": <MailWarning {...hidden} />,
  "document.processed": <BookCheck {...hidden} />, "document.failed": <FileWarning {...hidden} />, "knowledge.indexed": <BrainCircuit {...hidden} />, "knowledge.index_failed": <BrainCircuit {...hidden} />,
};
const severityIcons: Record<AppNotification["severity"], ReactNode> = {
  info: <Info {...hidden} />, success: <CircleCheck {...hidden} />, warning: <TriangleAlert {...hidden} />, danger: <CircleAlert {...hidden} />,
};
const TOAST_MS = 6_000;

function NotificationIcon({ item }: { item: AppNotification }) {
  return <span className="notification-icon" data-tone={item.severity}>{kindIcons[item.kind] ?? severityIcons[item.severity] ?? <Info {...hidden} />}</span>;
}

/** Bell in the top bar: unread badge, a popover feed and toasts for new successes and failures. */
export function NotificationCenter({ identity, onNavigate }: { identity: string; onNavigate(target: NotificationTarget): void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [toast, setToast] = useState<AppNotification | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  const feed = useNotificationFeed(identity, open, setToast);
  const shown = filter === "unread" ? feed.items.filter((item) => !item.read_at) : feed.items;
  const groups = groupNotifications(shown);
  const label = feed.unread ? `Notifications, ${feed.unread} unread` : "Notifications";

  const openItem = useCallback((item: AppNotification) => {
    feed.markRead(item);
    const target = notificationTarget(item);
    setOpen(false); setToast(null);
    if (target) onNavigate(target);
  }, [feed, onNavigate]);

  return <>
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="icon-button notification-trigger" aria-label={label}>
        <Bell aria-hidden="true" />
        {feed.unread ? <span className="notification-count" aria-hidden="true">{feed.unread > 99 ? "99+" : feed.unread}</span> : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={12} className="ui-select-positioner">
          <Popover.Popup className="popover notification-panel" aria-label="Notifications">
            <header className="notification-panel-head">
              <Popover.Title className="notification-panel-title">Notifications</Popover.Title>
              <button type="button" className="text-button neutral" disabled={!feed.unread} onClick={() => void feed.markAllRead()}><CheckCheck aria-hidden="true" />Mark all as read</button>
            </header>
            <div className="segmented notification-filter" role="group" aria-label="Show notifications">
              <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</button>
              <button type="button" aria-pressed={filter === "unread"} onClick={() => setFilter("unread")}>Unread{feed.unread ? ` · ${feed.unread}` : ""}</button>
            </div>
            <div className="notification-scroll">
              {feed.error ? <p className="form-error" role="alert">{feed.error}</p> : null}
              {!groups.length ? feed.loading ? <div className="loading-row" role="status"><span className="spinner" aria-hidden="true" />Loading notifications…</div>
                : <div className="notification-empty">
                  <span className="empty-icon" aria-hidden="true">{filter === "unread" ? <CheckCheck /> : <BellOff />}</span>
                  <b>{filter === "unread" ? "You’re all caught up" : "No notifications yet"}</b>
                  <p>Briefings, meeting updates and anything that needs your attention appear here.</p>
                </div>
                : groups.map((group) => <section key={group.label} className="notification-group" aria-label={group.label}>
                  <h3 className="notification-group-label">{group.label}</h3>
                  <ul>{group.items.map((item) => <NotificationRow key={item.id} item={item} onOpen={openItem} onDismiss={feed.dismiss} />)}</ul>
                </section>)}
              {feed.hasMore && filter === "all" ? <button type="button" className="button ghost sm block notification-more" disabled={feed.loading} onClick={() => void feed.loadMore()}>{feed.loading ? "Loading…" : "Show older"}</button> : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
    <NotificationToast item={toast} onOpen={openItem} onDismiss={closeToast} />
  </>;
}

function NotificationRow({ item, onOpen, onDismiss }: { item: AppNotification; onOpen(item: AppNotification): void; onDismiss(item: AppNotification): void }) {
  const unread = !item.read_at;
  return <li className="notification-row" data-unread={unread ? "true" : undefined}>
    <button type="button" className="notification-item" onClick={() => onOpen(item)}>
      <NotificationIcon item={item} />
      <span className="notification-copy">
        <span className="notification-title">{item.title}</span>
        {item.body ? <span className="notification-body">{item.body}</span> : null}
        <time dateTime={item.created_at} title={formatFullDateTime(item.created_at)}>{relativeTime(item.created_at)}</time>
      </span>
      {unread ? <span className="notification-dot"><span className="sr-only">Unread</span></span> : null}
    </button>
    <button type="button" className="icon-button sm notification-dismiss" aria-label={`Dismiss: ${item.title}`} onClick={() => onDismiss(item)}><X aria-hidden="true" /></button>
  </li>;
}

function NotificationToast({ item, onOpen, onDismiss }: { item: AppNotification | null; onOpen(item: AppNotification): void; onDismiss(): void }) {
  useEffect(() => {
    if (!item || item.severity === "danger") return; // failures stay until dismissed
    const timer = window.setTimeout(onDismiss, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [item, onDismiss]);
  if (!item) return null;
  return <div className="notification-toast-region" role={item.severity === "danger" ? "alert" : "status"} aria-live={item.severity === "danger" ? "assertive" : "polite"}>
    <div className="notification-toast" data-tone={item.severity}>
      <NotificationIcon item={item} />
      <div className="notification-copy">
        <span className="notification-title">{item.title}</span>
        {item.body ? <span className="notification-body">{item.body}</span> : null}
      </div>
      <div className="notification-toast-actions">
        {notificationTarget(item) ? <button type="button" className="button secondary sm" onClick={() => onOpen(item)}>View</button> : null}
        <button type="button" className="icon-button sm" aria-label="Dismiss notification" onClick={onDismiss}><X aria-hidden="true" /></button>
      </div>
    </div>
  </div>;
}

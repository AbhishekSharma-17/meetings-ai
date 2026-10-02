"use client";

import { useEffect, useRef, useState } from "react";
import type { CurrentAccount } from "@/lib/types";
import type { NotificationTarget } from "./notification-feed";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Access emails survive login, then open only the named workspace's resource. */
export function useWorkspaceNoticeLink(account: CurrentAccount | null, ready: boolean,
  switchWorkspace: (id: string) => Promise<void>, navigate: (target: NotificationTarget) => void) {
  const handled = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ready || !account || account.must_change_password || handled.current) return;
    const url = new URL(window.location.href);
    const workspace = url.searchParams.get("workspace");
    if (!workspace || !uuid.test(workspace)) return;
    handled.current = true;
    if (workspace !== account.organization_id) {
      void switchWorkspace(workspace).catch(() => setError("You no longer have access to the workspace in this email. Ask its admin for access."));
      return;
    }
    const view = url.searchParams.get("view");
    const record = url.searchParams.get("record");
    if (view && ["knowledge", "meeting", "workspace", "shared"].includes(view) && (!record || uuid.test(record))) {
      navigate({ view, id: record });
    }
    for (const key of ["workspace", "view", "record"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [account, ready, switchWorkspace, navigate]);
  return error;
}

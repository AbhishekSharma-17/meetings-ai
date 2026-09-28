"use client";

import { Building2, Check } from "lucide-react";
import type { WorkspaceOption } from "@/lib/types";
import { FilterInput } from "./scroll-panel";
import { useListSearch } from "./use-list-search";

/** Workspace switcher rows in the account menu; searchable once someone belongs to many workspaces. */
export function WorkspaceMenuList({ workspaces, currentId, busy, onChoose }: {
  workspaces: WorkspaceOption[];
  currentId: string | undefined;
  busy: boolean;
  onChoose(id: string): void;
}) {
  const search = useListSearch(workspaces, (option) => [option.display_name, option.role, option.is_default ? "Default" : null]);
  return <>
    {search.offered ? <div className="popover-search"><FilterInput id="workspace-menu-search" label="Search workspaces" value={search.query} onChange={search.setQuery} placeholder="Search workspaces" /></div> : null}
    {search.noMatches ? <p className="popover-empty" role="status">No workspaces match “{search.query.trim()}”.</p> : null}
    {search.visible.map((option) => {
      const current = option.id === currentId;
      return <button key={option.id} type="button" className={current ? "menu-item profile-workspace current" : "menu-item profile-workspace"} disabled={busy || current} onClick={() => onChoose(option.id)}>
        <Building2 /><span>{option.display_name}</span>
        {option.is_default ? <span className="tag profile-workspace-default">Default</span> : null}
        {current ? <Check className="check" aria-label="Current" /> : <small>{option.role}</small>}
      </button>;
    })}
  </>;
}

"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Building2, Lock, Users, X } from "lucide-react";
import type { WorkspaceMember } from "@/lib/types";
import { Avatar } from "./ui/avatar";
import { FilterInput, NoMatches } from "./scroll-panel";
import { useListSearch } from "./use-list-search";

export type Visibility = "private" | "organization" | "specific";

const choices: { value: Visibility; label: string; hint: string; icon: typeof Lock }[] = [
  { value: "private", label: "Private to creator and admins", hint: "Only you and workspace admins can browse or ask.", icon: Lock },
  { value: "organization", label: "Everyone in this organization", hint: "Every member of this workspace can browse and ask.", icon: Building2 },
  { value: "specific", label: "Specific teammates", hint: "Choose exactly who can browse and ask.", icon: Users },
];

export function KnowledgeSharingDialog({ open, onOpenChange, baseName, visibility, onVisibility, userIds, onUserIds, members, currentUserId, busy, error, onSave }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  baseName: string;
  visibility: Visibility;
  onVisibility(value: Visibility): void;
  userIds: string[];
  onUserIds(update: (current: string[]) => string[]): void;
  members: WorkspaceMember[];
  currentUserId: string | undefined;
  busy: boolean;
  error: string | null;
  onSave(): void;
}) {
  const teammates = members.filter((member) => member.user_id !== currentUserId);
  const search = useListSearch(teammates, (member) => [member.display_name, member.email]);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog knowledge-sharing-dialog">
        <Dialog.Close className="close-button" aria-label="Close sharing"><X /></Dialog.Close>
        <Dialog.Title>Share {baseName}</Dialog.Title>
        <Dialog.Description className="dialog-intro">Access is checked on every search, answer and source link.</Dialog.Description>
        <fieldset className="dialog-body">
          <legend className="sr-only">Access</legend>
          {choices.map((choice) => <label key={choice.value} className="choice-card"><input type="radio" name="sharing" checked={visibility === choice.value} onChange={() => onVisibility(choice.value)} /><choice.icon className="choice-icon" aria-hidden="true" /><span><b>{choice.label}</b><small>{choice.hint}</small></span></label>)}
        </fieldset>
        {visibility === "specific" && search.offered ? <div className="list-search-inline share-members-search"><FilterInput id="share-member-search" label="Search teammates" value={search.query} onChange={search.setQuery} placeholder="Search by name or email" /><span className="list-search-count">{userIds.length} selected</span></div> : null}
        {visibility === "specific" ? <div className="share-members" role="group" aria-label="Teammates">
          {search.noMatches ? <NoMatches query={search.query} noun="teammates" onClear={search.clear} /> : teammates.length ? search.visible.map((member) => <label key={member.user_id} className="share-member"><input type="checkbox" checked={userIds.includes(member.user_id)} onChange={(event) => onUserIds((current) => event.target.checked ? [...current, member.user_id] : current.filter((id) => id !== member.user_id))} /><Avatar name={member.display_name} photoUrl={member.photo_url} size="sm" /><span><b>{member.display_name}</b><small>{member.email}</small></span></label>) : <p className="field-hint">No other teammates yet. Invite people from Organization & people.</p>}
        </div> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="dialog-footer"><button type="button" className="button secondary" onClick={() => onOpenChange(false)}>Cancel</button><button type="button" className="button primary" disabled={busy} onClick={onSave}>Save sharing</button></div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

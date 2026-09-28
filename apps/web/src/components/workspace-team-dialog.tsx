"use client";

import { FormEvent, useId, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { Team, TeamInput, WorkspaceMember } from "@/lib/types";
import { Avatar } from "./ui/avatar";
import { EmailChips, isValidEmail } from "./ui/email-chips";
import { FilterInput, matchesQuery } from "./scroll-panel";
import { shouldOfferSearch } from "@/lib/search";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
/** Above this many people the picker gets a search box. */

/** Create, edit or (read-only) view one team. Members are workspace people and/or outside addresses. */
export function TeamDialog({ open, team, members, readOnly, busy, error, onClose, onSave }: {
  open: boolean;
  /** null creates a new team. */
  team: Team | null;
  members: WorkspaceMember[];
  readOnly: boolean;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onSave(input: TeamInput): void;
}) {
  const titleId = useId();
  const current = new Set(members.map((member) => member.user_id));
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [userIds, setUserIds] = useState<string[]>(() => (team?.members ?? []).flatMap((member) => member.user_id && current.has(member.user_id) ? [member.user_id] : []));
  const [emails, setEmails] = useState<string[]>(() => (team?.members ?? []).flatMap((member) => member.user_id ? [] : [member.email]));
  const [query, setQuery] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const departed = (team?.members ?? []).filter((member) => member.user_id && !current.has(member.user_id));
  const withEmail = members.filter((member) => member.email);
  const searchable = shouldOfferSearch(withEmail.length, query);
  const visible = searchable ? withEmail.filter((member) => matchesQuery(query, [member.display_name, member.email])) : withEmail;
  const total = userIds.length + emails.length;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim().replace(/\s+/g, " ");
    if (!trimmed) { setLocalError("Give the team a name."); return; }
    const invalid = emails.find((email) => !isValidEmail(email));
    if (invalid) { setLocalError(`“${invalid}” isn’t a valid email address. Edit or remove it.`); return; }
    setLocalError(null);
    onSave({
      name: trimmed, description: description.trim() || null,
      members: [...userIds.map((user_id) => ({ user_id })), ...emails.map((email) => ({ email }))],
    });
  }

  const title = readOnly ? team?.name ?? "Team" : team ? `Edit ${team.name}` : "New team";
  const shownError = localError ?? error;
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog team-dialog" aria-labelledby={titleId}>
        <Dialog.Close className="close-button" aria-label="Close" disabled={busy}><X aria-hidden="true" /></Dialog.Close>
        <Dialog.Title id={titleId}>{title}</Dialog.Title>
        <Dialog.Description className="dialog-intro">
          {readOnly ? team?.description || "Recaps sent to this team reach its current members." : "Recaps sent to a team reach whoever is in it at send time."}
        </Dialog.Description>
        {readOnly && team ? <TeamMembersList team={team} /> : <form className="dialog-body" onSubmit={submit}>
          <div className="field">
            <label htmlFor="team-name">Team name</label>
            <input id="team-name" value={name} maxLength={NAME_MAX} required autoFocus disabled={busy} placeholder="e.g. Leadership" onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="team-description">Description <span className="optional">optional</span></label>
            <input id="team-description" value={description} maxLength={DESCRIPTION_MAX} disabled={busy} placeholder="Who is this for?" onChange={(event) => setDescription(event.target.value)} />
          </div>
          <fieldset className="field team-picker">
            <legend className="field-label">Workspace members <span className="optional">{userIds.length} selected</span></legend>
            {searchable ? <FilterInput id="team-member-search" label="Search workspace members" value={query} onChange={setQuery} placeholder="Search by name or email" /> : null}
            <div className="share-members team-member-options" role="group" aria-label="Workspace members">
              {visible.length ? visible.map((member) => <label key={member.user_id} className="share-member">
                <input type="checkbox" disabled={busy} checked={userIds.includes(member.user_id)}
                  onChange={(event) => setUserIds((ids) => event.target.checked ? [...ids, member.user_id] : ids.filter((id) => id !== member.user_id))} />
                <Avatar name={member.display_name} photoUrl={member.photo_url} size="sm" />
                <span><b>{member.display_name}</b><small>{member.email}</small></span>
              </label>) : <p className="field-hint">{withEmail.length ? "No one matches that search." : "No workspace members with an email address yet."}</p>}
            </div>
          </fieldset>
          <EmailChips id="team-external-emails" label="People outside the workspace" labelSuffix={<span className="optional">optional</span>}
            value={emails} onChange={setEmails} placeholder="partner@client.com" disabled={busy} />
          {departed.length ? <p className="field-hint" role="note">{departed.map((member) => member.display_name ?? member.email).join(", ")} left the workspace and will be removed when you save.</p> : null}
          {shownError ? <p className="form-error" role="alert">{shownError}</p> : null}
          <div className="dialog-footer">
            <span className="team-dialog-total">{total} {total === 1 ? "member" : "members"}</span>
            <button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="button primary" disabled={busy}>{busy ? "Saving…" : team ? "Save team" : "Create team"}</button>
          </div>
        </form>}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function TeamMembersList({ team }: { team: Team }) {
  if (!team.members.length) return <p className="field-hint team-dialog-empty">This team has no members yet.</p>;
  return <ul className="team-member-list" aria-label={`Members of ${team.name}`}>
    {team.members.map((member) => <li key={`${member.user_id ?? ""}:${member.email}`}>
      <Avatar name={member.display_name ?? member.email} photoUrl={member.photo_url} size="sm" />
      <span><b>{member.display_name ?? member.email}</b>{member.display_name ? <small>{member.email}</small> : <small>Outside the workspace</small>}</span>
      {!member.active ? <span className="tag">Left workspace</span> : null}
    </li>)}
  </ul>;
}

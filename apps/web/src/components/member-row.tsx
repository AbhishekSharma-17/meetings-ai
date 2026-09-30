"use client";

import { Menu } from "@base-ui/react/menu";
import { AudioLines, KeyRound, MoreHorizontal, Send, UserCog, UserMinus } from "lucide-react";
import type { WorkspaceMember } from "@/lib/types";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/feedback";
import { hasAnyAction, roleLabel, type MemberPermissions, type MemberState } from "./member-access";

export type MemberAction = "role" | "resend" | "reset" | "remove";

export function MemberRow({ member, state, isSelf, permissions, busy, hasVoiceSample = false, onAction }: {
  member: WorkspaceMember;
  state: MemberState;
  isSelf: boolean;
  permissions: MemberPermissions;
  busy: boolean;
  /** Shown to owners and admins only: they saved a voice sample in this workspace. */
  hasVoiceSample?: boolean;
  onAction(action: MemberAction): void;
}) {
  return <li className="people-row" data-state={state.key} aria-busy={busy || undefined}>
    <Avatar name={member.display_name} photoUrl={member.photo_url} />
    <span className="people-identity">
      <span className="people-name"><b>{member.display_name}</b>{isSelf ? <span className="tag">You</span> : null}{hasVoiceSample ? <span className="tag people-voice" title="Saved a voice sample for in-person name suggestions"><AudioLines aria-hidden="true" />Voice sample</span> : null}</span>
      <small>{member.email ?? "Local password sign-in"}</small>
    </span>
    <span className="people-meta">
      <span className="people-role">{roleLabel[member.role] ?? member.role}</span>
      <span className="people-status">
        <Badge tone={state.tone} dot>{state.label}</Badge>
        {state.detail ? <small>{state.detail}</small> : null}
      </span>
    </span>
    <span className="people-actions">
      {hasAnyAction(permissions) ? <MemberActionsMenu name={member.display_name} permissions={permissions} busy={busy} onAction={onAction} /> : null}
    </span>
  </li>;
}

function MemberActionsMenu({ name, permissions, busy, onAction }: {
  name: string; permissions: MemberPermissions; busy: boolean; onAction(action: MemberAction): void;
}) {
  return <Menu.Root>
    <Menu.Trigger className="icon-button" aria-label={`Actions for ${name}`} disabled={busy}>
      {busy ? <span className="spinner" aria-hidden="true" /> : <MoreHorizontal aria-hidden="true" />}
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner sideOffset={4} align="end">
        <Menu.Popup className="popover">
          {permissions.changeRole ? <Menu.Item className="menu-item" onClick={() => onAction("role")}><UserCog /> Change role</Menu.Item> : null}
          {permissions.resend ? <Menu.Item className="menu-item" onClick={() => onAction("resend")}><Send /> Resend invite</Menu.Item> : null}
          {permissions.reset ? <Menu.Item className="menu-item" onClick={() => onAction("reset")}><KeyRound /> Reset access</Menu.Item> : null}
          {permissions.remove ? <>
            {permissions.changeRole || permissions.resend || permissions.reset ? <Menu.Separator className="menu-separator" /> : null}
            <Menu.Item className="menu-item destructive" onClick={() => onAction("remove")}><UserMinus /> Remove from workspace</Menu.Item>
          </> : null}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
}

import type { CurrentAccount, WorkspaceMember } from "@/lib/types";
import type { Tone } from "./ui/feedback";

export type InviteRole = "admin" | "member" | "viewer";
export type MemberRole = WorkspaceMember["role"];
export type Option = { value: string; label: string };

export const roleLabel: Record<MemberRole, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

export const ROLE_HINT = "Admins run meetings and manage the workspace. Members use shared knowledge; viewers can’t create knowledge bases.";
export const LINK_MINUTES = 10;

const ownerRoleOptions: Option[] = [{ value: "owner", label: "Owner" }, { value: "admin", label: "Admin" }, { value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }];
const adminRoleOptions: Option[] = [{ value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }];
const ownerInviteOptions: Option[] = [{ value: "member", label: "Member" }, { value: "admin", label: "Admin" }, { value: "viewer", label: "Viewer" }];

export const roleOptions = (isOwner: boolean): Option[] => isOwner ? ownerRoleOptions : adminRoleOptions;
export const inviteRoleOptions = (isOwner: boolean): Option[] => isOwner ? ownerInviteOptions : adminRoleOptions;

export type MemberState = { key: "active" | "pending" | "expired" | "other"; label: string; tone: Tone; detail: string | null };

function minutesLeft(expiresAt: string, now: number): number {
  return Math.max(1, Math.ceil((new Date(expiresAt).getTime() - now) / 60_000));
}

/** "Invite pending" only while a link is still usable; anything else invited is "Invite expired". */
export function memberState(member: WorkspaceMember, now: number): MemberState {
  if (member.status === "active") return { key: "active", label: "Active", tone: "success", detail: null };
  if (member.status === "invited") {
    const expires = member.invite_expires_at ? new Date(member.invite_expires_at).getTime() : 0;
    if (expires > now) {
      const minutes = minutesLeft(member.invite_expires_at as string, now);
      return { key: "pending", label: "Invite pending", tone: "info", detail: `Link expires in ${minutes} min` };
    }
    return { key: "expired", label: "Invite expired", tone: "warning", detail: "Resend to send a new link" };
  }
  const label = member.status ? `${member.status[0].toUpperCase()}${member.status.slice(1)}` : "Unknown";
  return { key: "other", label, tone: "neutral", detail: null };
}

export type MemberPermissions = { changeRole: boolean; resend: boolean; reset: boolean; remove: boolean };

/** Mirrors the API: admins manage members and viewers, owners manage everyone, and a last owner is protected. */
export function memberPermissions(member: WorkspaceMember, account: CurrentAccount | null, ownerCount: number): MemberPermissions {
  const none = { changeRole: false, resend: false, reset: false, remove: false };
  if (!account || (account.role !== "owner" && account.role !== "admin")) return none;
  if (account.user_id === member.user_id) return none;
  const isOwner = account.role === "owner";
  const manageable = isOwner || member.role === "member" || member.role === "viewer";
  if (!manageable) return none;
  const lastOwner = member.role === "owner" && ownerCount <= 1;
  const invited = member.status === "invited";
  return {
    changeRole: !lastOwner,
    resend: invited && member.role !== "owner",
    reset: !invited && member.role !== "owner",
    remove: !lastOwner,
  };
}

export const hasAnyAction = (permissions: MemberPermissions) => Object.values(permissions).some(Boolean);

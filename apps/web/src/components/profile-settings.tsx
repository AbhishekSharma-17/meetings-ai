"use client";

import { FormEvent, useState } from "react";
import { Building2, Mail } from "lucide-react";
import type { CurrentAccount, Workspace } from "@/lib/types";
import { meetingsService } from "@/lib/meetings-service";
import { initials } from "@/lib/meeting-status";
import { PageHeader } from "./ui/page-header";
import { Badge } from "./ui/feedback";
import { SettingsToast } from "./settings-toast";

const roleLabel: Record<CurrentAccount["role"], string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

export function ProfileSettings({ account, workspace, onAccountChange }: { account: CurrentAccount; workspace: Workspace | null; onAccountChange(account: CurrentAccount): void }) {
  const [displayName, setDisplayName] = useState(account.display_name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null); setMessage(null); setSaving(true);
    try {
      const updated = await meetingsService.updateProfile(displayName.trim());
      onAccountChange(updated);
      setDisplayName(updated.display_name);
      setMessage("Your display name was updated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update your name.");
    } finally { setSaving(false); }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null); setMessage(null);
    if (newPassword !== confirmPassword) { setError("New passwords do not match."); return; }
    setSaving(true);
    try {
      await meetingsService.changePassword(currentPassword, newPassword);
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      setMessage("Password changed. Your other sessions have been revoked.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change password.");
    } finally { setSaving(false); }
  }

  const notice = error ? { tone: "danger" as const, text: error } : message ? { tone: "success" as const, text: message } : null;
  return <section className="page narrow profile-page" aria-labelledby="profile-title">
    <PageHeader titleId="profile-title" title="My profile" description="Your sign-in details and workspace membership." />
    <div className="stack-lg">
      <section className="card" aria-labelledby="profile-details-title">
        <div className="profile-identity">
          <span className="avatar profile-avatar" aria-hidden="true">{initials(account.display_name)}</span>
          <div className="profile-identity-copy">
            <h2 id="profile-details-title">{account.display_name}</h2>
            <div className="profile-facts">
              <span><Mail aria-hidden="true" />{account.email ?? "Local account"}</span>
              <span><Building2 aria-hidden="true" />{workspace?.display_name ?? "Workspace"}</span>
              <Badge tone="brand">{roleLabel[account.role] ?? account.role}</Badge>
            </div>
          </div>
        </div>
        <form className="card-body profile-name-form" onSubmit={(event) => void saveName(event)}>
          <div className="field">
            <label htmlFor="profile-display-name">Your display name</label>
            <div className="profile-inline-field">
              <input id="profile-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={120} required />
              <button className="button secondary" disabled={saving || displayName.trim() === account.display_name}>{saving ? "Saving…" : "Save name"}</button>
            </div>
            <p className="field-hint">Shown to teammates on meetings, minutes and shared knowledge.</p>
          </div>
        </form>
      </section>
      <section className="card" aria-labelledby="password-title">
        <div className="card-header"><div><h2 id="password-title">Change password</h2><p>Use at least 12 characters. Changing it signs you out everywhere else.</p></div></div>
        <form onSubmit={(event) => void changePassword(event)}>
          <div className="card-body form-stack">
            <div className="field"><label htmlFor="profile-current-password">Current password</label><input id="profile-current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></div>
            <div className="field-row">
              <div className="field"><label htmlFor="profile-new-password">New password</label><input id="profile-new-password" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></div>
              <div className="field"><label htmlFor="profile-confirm-password">Confirm new password</label><input id="profile-confirm-password" type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></div>
            </div>
          </div>
          <div className="card-footer"><button className="button primary" disabled={saving}>{saving ? "Updating…" : "Update password"}</button></div>
        </form>
      </section>
    </div>
    <SettingsToast notice={notice} onDismiss={() => { setError(null); setMessage(null); }} />
  </section>;
}

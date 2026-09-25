"use client";

import { FormEvent, useState } from "react";
import type { CurrentAccount, Workspace } from "@/lib/types";
import { meetingsService } from "@/lib/meetings-service";

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

  return <section className="page profile-page" aria-labelledby="profile-title">
    <p className="eyebrow">ACCOUNT</p><h1 id="profile-title">My profile</h1><p className="intro">Your sign-in and organization membership.</p>
    {message ? <p className="workspace-success" role="status">{message}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="profile-settings-grid">
      <section className="workspace-card"><h2>Profile details</h2><div className="profile-identity"><span className="profile-identity-avatar" aria-hidden="true">{account.display_name[0]?.toUpperCase() ?? "U"}</span><span><b>{account.display_name}</b><small>{account.email ?? "Local account"}</small></span></div><form onSubmit={(event) => void saveName(event)}><label htmlFor="profile-display-name">Your display name</label><input id="profile-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={120} required /><button className="button secondary" disabled={saving || displayName.trim() === account.display_name}>{saving ? "Saving…" : "Save name"}</button></form><dl className="profile-facts"><div><dt>Organization</dt><dd>{workspace?.display_name ?? "Workspace"}</dd></div><div><dt>Role</dt><dd>{account.role}</dd></div></dl></section>
      <form className="workspace-card" onSubmit={(event) => void changePassword(event)}><h2>Change password</h2><p>Use at least 12 characters. Changing your password revokes your other sessions.</p><label htmlFor="profile-current-password">Current password</label><input id="profile-current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /><label htmlFor="profile-new-password">New password</label><input id="profile-new-password" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /><label htmlFor="profile-confirm-password">Confirm new password</label><input id="profile-confirm-password" type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /><button className="button primary" disabled={saving}>{saving ? "Updating…" : "Update password"}</button></form>
    </div>
  </section>;
}

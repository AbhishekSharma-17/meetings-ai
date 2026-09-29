"use client";

import { ChangeEvent, FormEvent, useRef, useState } from "react";
import { Building2, ImageUp, Mail } from "lucide-react";
import type { CurrentAccount, Workspace } from "@/lib/types";
import { meetingsService } from "@/lib/meetings-service";
import { Avatar } from "./ui/avatar";
import { PageHeader } from "./ui/page-header";
import { Badge } from "./ui/feedback";
import { SettingsToast } from "./settings-toast";
import { TimePreferencesCard } from "./time-preferences-control";
import { PASSWORD_MIN } from "./set-password-form";

const roleLabel: Record<CurrentAccount["role"], string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };
const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export function ProfileSettings({ account, workspace, onAccountChange }: { account: CurrentAccount; workspace: Workspace | null; onAccountChange(account: CurrentAccount): void }) {
  const [displayName, setDisplayName] = useState(account.display_name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState<"upload" | "remove" | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  async function uploadPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null); setMessage(null);
    // The server sniffs the bytes and re-encodes; this only saves a pointless round trip.
    if (file.type && !PHOTO_TYPES.includes(file.type)) { setError("Choose a PNG, JPEG or WebP image."); return; }
    if (file.size > MAX_PHOTO_BYTES) { setError("Profile photos must be 5 MB or smaller."); return; }
    setPhotoBusy("upload");
    try {
      onAccountChange(await meetingsService.uploadProfilePhoto(file));
      setMessage("Profile photo updated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload your photo.");
    } finally { setPhotoBusy(null); }
  }

  async function removePhoto() {
    setError(null); setMessage(null); setPhotoBusy("remove");
    try {
      onAccountChange(await meetingsService.removeProfilePhoto());
      setMessage("Profile photo removed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove your photo.");
    } finally { setPhotoBusy(null); }
  }

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
          <Avatar name={account.display_name} photoUrl={account.photo_url} className="profile-avatar" />
          <div className="profile-identity-copy">
            <h2 id="profile-details-title">{account.display_name}</h2>
            <div className="profile-facts">
              <span><Mail aria-hidden="true" />{account.email ?? "Local account"}</span>
              <span><Building2 aria-hidden="true" />{workspace?.display_name ?? "Workspace"}</span>
              <Badge tone="brand">{roleLabel[account.role] ?? account.role}</Badge>
            </div>
          </div>
        </div>
        <div className="card-body profile-photo-row">
          <div className="profile-photo-copy">
            <span className="field-label" id="profile-photo-label">Profile photo</span>
            <p className="field-hint">PNG, JPEG or WebP up to 5 MB. Cropped to a square; photo metadata is removed.</p>
          </div>
          <div className="button-group">
            <input ref={photoInput} id="profile-photo-input" className="sr-only" type="file" accept={PHOTO_TYPES.join(",")} tabIndex={-1} aria-labelledby="profile-photo-label" onChange={(event) => void uploadPhoto(event)} />
            <button className="button secondary sm" type="button" disabled={photoBusy !== null} onClick={() => photoInput.current?.click()}>
              <ImageUp aria-hidden="true" />{photoBusy === "upload" ? "Uploading…" : account.photo_url ? "Change photo" : "Upload photo"}
            </button>
            {account.photo_url ? <button className="button ghost sm" type="button" disabled={photoBusy !== null} onClick={() => void removePhoto()}>{photoBusy === "remove" ? "Removing…" : "Remove photo"}</button> : null}
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
      <TimePreferencesCard />
      <section className="card" aria-labelledby="password-title">
        <div className="card-header"><div><h2 id="password-title">Change password</h2><p>Use at least {PASSWORD_MIN} characters. Changing it signs you out everywhere else.</p></div></div>
        <form onSubmit={(event) => void changePassword(event)}>
          <div className="card-body form-stack">
            <div className="field"><label htmlFor="profile-current-password">Current password</label><input id="profile-current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></div>
            <div className="field-row">
              <div className="field"><label htmlFor="profile-new-password">New password</label><input id="profile-new-password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></div>
              <div className="field"><label htmlFor="profile-confirm-password">Confirm new password</label><input id="profile-confirm-password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></div>
            </div>
          </div>
          <div className="card-footer"><button className="button primary" disabled={saving}>{saving ? "Updating…" : "Update password"}</button></div>
        </form>
      </section>
    </div>
    <SettingsToast notice={notice} onDismiss={() => { setError(null); setMessage(null); }} />
  </section>;
}

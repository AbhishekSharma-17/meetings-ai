"use client";

import { FormEvent, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (password !== confirm) return "The two passwords don’t match.";
  return null;
}

/** New password + confirmation with one show/hide toggle. Used to accept invites and reset passwords. */
export function SetPasswordForm({ email, submitLabel, busyLabel, busy, error, onSubmit }: {
  email: string | null;
  submitLabel: string;
  busyLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit(password: string): void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const type = visible ? "text" : "password";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = passwordProblem(password, confirm);
    setProblem(found);
    if (!found) onSubmit(password);
  }

  const shown = problem ?? error;
  return <form className="set-password-form" onSubmit={submit} noValidate>
    {/* Lets password managers file the new password under the right account. */}
    {email ? <input type="email" name="username" autoComplete="username" value={email} readOnly hidden /> : null}
    <div className="field">
      <label htmlFor="new-account-password">New password</label>
      <div className="password-input">
        <input id="new-account-password" type={type} autoComplete="new-password" value={password} maxLength={PASSWORD_MAX} disabled={busy} autoFocus
          aria-describedby="new-account-password-hint" onChange={(event) => { setPassword(event.target.value); setProblem(null); }} />
        <button type="button" className="icon-button sm" aria-pressed={visible} aria-label={visible ? "Hide passwords" : "Show passwords"} onClick={() => setVisible((value) => !value)}>
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
      </div>
      <p className="field-hint" id="new-account-password-hint">{PASSWORD_MIN}–{PASSWORD_MAX} characters. A short phrase is easier to remember.</p>
    </div>
    <div className="field">
      <label htmlFor="confirm-account-password">Confirm password</label>
      <input id="confirm-account-password" type={type} autoComplete="new-password" value={confirm} maxLength={PASSWORD_MAX} disabled={busy}
        onChange={(event) => { setConfirm(event.target.value); setProblem(null); }} />
    </div>
    {shown ? <p className="form-error" role="alert">{shown}</p> : null}
    <button className="button primary lg block" type="submit" disabled={busy}>{busy ? busyLabel : submitLabel}</button>
  </form>;
}

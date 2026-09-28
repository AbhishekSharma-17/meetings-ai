"use client";

import { FormEvent, useState } from "react";
import { ArrowLeft, MailCheck } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Self-service reset. The answer is the same whether or not the account exists. */
export function ForgotPasswordForm({ initialEmail, onBack }: { initialEmail: string; onBack(): void }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const clean = email.trim();
    if (!EMAIL_PATTERN.test(clean)) { setError("Enter the email address you sign in with."); return; }
    setBusy(true); setError(null);
    try {
      await meetingsService.requestPasswordReset(clean);
      setSentTo(clean);
    } catch (cause) {
      const limited = typeof cause === "object" && cause !== null && "status" in cause && (cause as { status: number }).status === 429;
      setError(limited ? "Too many reset requests. Wait a few minutes before trying again." : "We couldn’t send the request. Check your connection and try again.");
    } finally { setBusy(false); }
  }

  if (sentTo) return <div className="login-card account-link-problem" role="status">
    <span className="account-link-icon" aria-hidden="true"><MailCheck /></span>
    <div>
      <h1>Check your email</h1>
      <p className="intro">If an account exists for <b>{sentTo}</b>, we’ve emailed a link to set a new password. It works once and expires in 10 minutes.</p>
    </div>
    <p className="field-hint">Nothing arrived? Check spam, or ask your workspace admin to reset your access.</p>
    <button type="button" className="button secondary lg block" onClick={onBack}>Back to sign in</button>
  </div>;

  return <form className="login-card" onSubmit={(event) => void submit(event)} noValidate>
    <button type="button" className="back-button" onClick={onBack}><ArrowLeft aria-hidden="true" />Back to sign in</button>
    <div>
      <h1>Reset your password</h1>
      <p className="intro">Enter your work email and we’ll send you a link to choose a new password.</p>
    </div>
    <div className="field">
      <label htmlFor="reset-email">Work email</label>
      <input id="reset-email" type="email" autoComplete="username" placeholder="you@company.com" value={email} disabled={busy} autoFocus onChange={(event) => setEmail(event.target.value)} />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <button className="button primary lg block" type="submit" disabled={busy}>{busy ? "Sending…" : "Email me a reset link"}</button>
  </form>;
}

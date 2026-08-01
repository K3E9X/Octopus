"use client";

// Sign in and registration. One form, two intents, and it tells the truth about the
// deployment it is running on: without a database there are no accounts at all, and
// without a signing secret sessions cannot be issued. Saying "wrong password" when the
// real problem is a missing env var is how an hour gets lost.

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Logo } from "./Logo";

export default function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/app";
  const [mode, setMode] = useState<"signin" | "register">(params.get("mode") === "register" ? "register" : "signin");
  const [state, setState] = useState<{ authEnabled: boolean; sessionsUsable: boolean; firstAccount: boolean } | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { fetch("/api/auth").then((r) => r.json()).then(setState).catch(() => {}); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: mode, email, password, name }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d?.error || "could not sign in"); return; }
      router.push(d.firstAccount ? "/admin" : next);
    } catch {
      setError("network unavailable");
    } finally {
      setBusy(false);
    }
  }

  const blocked = state && (!state.authEnabled || !state.sessionsUsable);

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <Link className="auth-brand" href="/"><Logo size={30} /><span><b>OCTOPUS</b><small>OSINT</small></span></Link>

        {blocked ? (
          <div className="auth-blocked">
            <h1>{!state!.authEnabled ? "This deployment has no accounts" : "Sessions are not configured"}</h1>
            <p>
              {!state!.authEnabled
                ? "There is no database, so there is nowhere to keep them. The instance runs in single-operator mode and the tool is open — set POSTGRES_URL to put it behind accounts."
                : "Set OCTOPUS_SESSION_SECRET to 16 characters or more. Without it sessions cannot be signed, and a shared fallback secret would let any deployment forge another's."}
            </p>
            <Link className="auth-go" href="/app">Open the tool</Link>
          </div>
        ) : (
          <>
            <h1>{mode === "register" ? "Create an account" : "Sign in"}</h1>
            {state?.firstAccount && mode === "register" && (
              <p className="auth-note">This is the first account on this instance — it becomes the administrator.</p>
            )}
            <form onSubmit={submit}>
              {mode === "register" && (
                <label className="add-field"><span>name (optional)</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
                </label>
              )}
              <label className="add-field"><span>email</span>
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
              </label>
              <label className="add-field"><span>password{mode === "register" ? " — 10+ characters, letters and a digit" : ""}</span>
                <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "register" ? "new-password" : "current-password"} />
              </label>
              {error && <div className="auth-error">{error}</div>}
              <button className="auth-go" type="submit" disabled={busy}>
                {busy ? "…" : mode === "register" ? "Create the account" : "Sign in"}
              </button>
            </form>
            <button className="auth-switch" onClick={() => { setMode(mode === "register" ? "signin" : "register"); setError(""); }}>
              {mode === "register" ? "I already have an account" : "Create an account instead"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

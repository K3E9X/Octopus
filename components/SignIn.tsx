"use client";

// Access — the sign-in / create-access screen, built to the Abyss reference.
//
// Left: the creature, the mark, the pitch, behind a vignette that clears the ground
// under the copy. Right: the form, 380px, tab-switched between the two intents.
//
// Two things in the reference are NOT here, and their absence is the point. "Continue
// with passkey" and "forgot?" are both real controls in the mock, and this deployment
// has neither a WebAuthn flow nor a reset flow behind them. A dead button on an auth
// screen is not a cosmetic shortfall — it is a person typing an address into a form
// that will never send them anything. They come back when the backend does.
//
// Everything else is wired to the real /api/auth, including the two states the mock has
// no concept of: a deployment with no database has no accounts at all, and one with no
// signing secret cannot issue sessions. Saying "wrong password" when the real problem is
// a missing env var is how an hour gets lost.

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { OctoMark } from "./OctoMark";
import { passwordProblem, strength, STRENGTH_LABEL } from "@/lib/pwrule";

const Octo3D = dynamic(() => import("./Octo3D"), { ssr: false });

const STR_TOKEN = ["--reject", "--reject", "--type-email", "--type-location", "--accent"];

export default function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/app";
  const [mode, setMode] = useState<"signin" | "register">(params.get("mode") === "register" ? "register" : "signin");
  const [state, setState] = useState<{ authEnabled: boolean; sessionsUsable: boolean; firstAccount: boolean } | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
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
  const isSignup = mode === "register";
  const s = strength(password);
  // what the SERVER will say, shown while they type rather than after they submit
  const problem = isSignup ? passwordProblem(password) : null;

  return (
    <div className="ax">
      {/* left — the creature and the pitch */}
      <div className="ax-left">
        <div className="ax-scene"><Octo3D scene="hero" /></div>
        {/* clears the ground under the copy without hiding the creature */}
        <div className="ax-vignette" aria-hidden="true" />

        <Link className="ax-brand" href="/">
          <OctoMark size={34} float glow />
          <span><b>OCTOPUS</b><small>OSINT</small></span>
        </Link>

        <div className="ax-pitch">
          <h1>Eight arms.<br />One <span>verdict</span>.</h1>
          <p>
            Delegate collection. Own the correlation. The engine runs on your deployment —
            access is only how the arms know it&rsquo;s you.
          </p>
        </div>
      </div>

      {/* right — the form */}
      <div className="ax-right">
        <div className="ax-form">
          {blocked ? (
            <div className="ax-blocked">
              <h2>{!state!.authEnabled ? "This deployment has no accounts" : "Sessions are not configured"}</h2>
              <p>
                {!state!.authEnabled
                  ? "There is no database, so there is nowhere to keep them. The instance runs in single-operator mode and the tool is open — set POSTGRES_URL to put it behind accounts."
                  : "Set OCTOPUS_SESSION_SECRET to 16 characters or more. Without it sessions cannot be signed, and a shared fallback secret would let any deployment forge another's."}
              </p>
              <Link className="ax-submit" href="/app">Open the tool</Link>
            </div>
          ) : (
            <>
              <div className="ax-tabs" role="tablist">
                {([["signin", "Sign in"], ["register", "Create access"]] as const).map(([m, label]) => (
                  <button key={m} role="tab" aria-selected={mode === m}
                    className={mode === m ? "on" : ""}
                    onClick={() => { setMode(m); setError(""); }}>{label}</button>
                ))}
              </div>

              <h2>{isSignup ? "Create access" : "Re-enter the deep"}</h2>
              <p className="ax-sub">
                {isSignup
                  ? "One operator, one console. The engine runs local; this only proves it's you."
                  : "Your graphs and dossiers are where you left them."}
              </p>

              {state?.firstAccount && isSignup && (
                <p className="ax-first">This is the first account on this instance — it becomes the administrator.</p>
              )}

              <form onSubmit={submit}>
                {isSignup && (
                  <div className="ax-fld">
                    <label htmlFor="ax-name">operator handle</label>
                    <input id="ax-name" value={name} onChange={(e) => setName(e.target.value)}
                      spellCheck={false} autoComplete="name" placeholder="how the console addresses you" />
                  </div>
                )}

                <div className="ax-fld">
                  <label htmlFor="ax-email">email</label>
                  <input id="ax-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                    spellCheck={false} autoComplete="email" placeholder="you@domain" />
                </div>

                <div className="ax-fld">
                  <label htmlFor="ax-pass">passphrase</label>
                  <div className="ax-pass">
                    <input id="ax-pass" type={reveal ? "text" : "password"} required value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete={isSignup ? "new-password" : "current-password"}
                      placeholder="························" />
                    <button type="button" onClick={() => setReveal(!reveal)} aria-label={reveal ? "hide passphrase" : "show passphrase"}>
                      {reveal ? "hide" : "show"}
                    </button>
                  </div>
                </div>

                {isSignup && (
                  <>
                    <div className="ax-bars" aria-hidden="true">
                      {[0, 1, 2, 3].map((i) => (
                        <span key={i} className={i < s && !problem ? "on" : ""} style={{ background: i < s && !problem ? `var(${STR_TOKEN[s]})` : undefined }} />
                      ))}
                    </div>
                    {/* The RULE first, the vibe second. A meter that says "descending"
                        about a passphrase the server will reject invites someone to
                        submit, fail, and guess what the rule was. */}
                    <div className="ax-strength" style={{ color: password && !problem ? `var(${STR_TOKEN[s]})` : undefined }}>
                      {!password
                        ? "a passphrase, not a password"
                        : problem
                          ? <span className="ax-needs">needs {problem}</span>
                          : STRENGTH_LABEL[s]}
                    </div>
                  </>
                )}

                {error && <div className="ax-error" role="alert">{error}</div>}

                <button className="ax-submit" type="submit" disabled={busy}>
                  {busy ? "…" : isSignup ? "Descend" : "Sign in"}
                </button>
              </form>

              <p className="ax-switch">
                {isSignup ? "Already have access?" : "No access yet?"}{" "}
                <button onClick={() => { setMode(isSignup ? "signin" : "register"); setError(""); }}>
                  {isSignup ? "Sign in" : "Create one"}
                </button>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

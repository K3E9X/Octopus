"use client";

// Administration: who has access, what they have been running, and whether the audit
// chain is intact. Deliberately not a dashboard of charts — the questions an operator
// actually has are "who can get in" and "what did they do".

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "./Logo";

interface U { id: string; email: string; name?: string; role: string; createdAt: number; lastSeen?: number; credits?: number }
interface A { id: number; at: number; operator: string; kind: string; selector: string; legalBasis: string; caseId?: string }
/** What the server is willing to say about the token — a fingerprint, never the value. */
interface Source { source: "stored" | "environment" | "none"; tail?: string; length?: number; setAt?: number; setBy?: string }

export default function Admin({ me, disabledReason }: { me?: { id: string; email: string }; disabledReason?: string }) {
  const [users, setUsers] = useState<U[]>([]);
  const [activity, setActivity] = useState<A[]>([]);
  const [chain, setChain] = useState<{ intact: boolean; checked: number; brokenAt?: number } | null>(null);
  const [metered, setMetered] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [storable, setStorable] = useState(false);
  const [trial, setTrial] = useState("");
  const [role, setRole] = useState<string>("admin");
  const [cap, setCap] = useState(500);
  const [msg, setMsg] = useState("");

  async function load() {
    const r = await fetch("/api/admin");
    const d = await r.json();
    if (d?.users) { setUsers(d.users); setActivity(d.activity || []); setChain(d.chain || null); }
    setMetered(!!d.metered);
    setSource(d.source || null);
    setStorable(!!d.storable);
    setTrial(d.trial || "");
    setRole(d.me?.role || "admin");
    setCap(d.grantCap ?? 500);
  }
  useEffect(() => { if (!disabledReason) load(); }, [disabledReason]);

  async function changeRole(id: string, role: string) {
    const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, role }) });
    const d = await r.json();
    setMsg(d?.error || "role updated");
    setTimeout(() => setMsg(""), 4000);
    load();
  }

  // Granting credit is the lever that matters day to day — deciding who gets to keep
  // searching — so it is an inline control rather than a browser prompt, and it takes
  // an amount in dollars because that is the unit the bill arrives in.
  async function grant(id: string, email: string, credits: number) {
    const n = Math.trunc(credits);
    if (!Number.isFinite(n) || n === 0) { setMsg("enter a non-zero number of credits"); return; }
    const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "grant", id, credits: n }) });
    const d = await r.json();
    if (!r.ok) { setMsg(d.error || "grant failed"); return; }
    const b = d.balance ?? 0;
    setMsg(`${email}: ${b.toLocaleString("en-US")} credit${b === 1 ? "" : "s"} — about that many searches.`);
    load();
  }

  if (disabledReason) {
    return (
      <div className="adm">
        <header className="adm-top"><Link className="auth-brand" href="/"><Logo size={26} /><span><b>OCTOPUS</b><small>LEAK</small></span></Link></header>
        <p className="adm-empty">{disabledReason}</p>
      </div>
    );
  }

  return (
    <div className="adm">
      <header className="adm-top">
        <Link className="auth-brand" href="/"><Logo size={26} /><span><b>OCTOPUS</b><small>LEAK</small></span></Link>
        <span className="adm-me">{me?.email}</span>
        <span className="flex" />
        <Link className="ping-btn" href="/search">Open the search</Link>
        <button className="ping-btn" onClick={async () => { await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "signout" }) }); location.href = "/"; }}>Sign out</button>
      </header>

      {msg && <div className="adm-msg">{msg}</div>}

      <SourceKey source={source} storable={storable} onDone={(m) => { setMsg(m); setTimeout(() => setMsg(""), 6000); load(); }} />

      <section>
        <h2>Accounts <em>{users.length}</em></h2>
        {trial && <p className="adm-note">{trial}</p>}
        <table className="datatable">
          <thead><tr><th>email</th><th>name</th><th>role</th>{metered && <th>credits · searches</th>}<th>created</th><th>last seen</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="t-handle">{u.email}{u.id === me?.id ? " · you" : ""}</td>
                <td>{u.name || "—"}</td>
                <td>
                  {/* Nobody may act on a role at or above their own, so the options
                      stop where the caller's authority does. The server enforces it
                      again — a disabled option is a hint, never a guard. */}
                  <select className="api-select adm-role" value={u.role}
                    onChange={(e) => changeRole(u.id, e.target.value)}
                    disabled={u.id === me?.id || (role !== "owner" && u.role === "owner")}>
                    {role === "owner" && <option value="owner">owner</option>}
                    {role === "owner" && <option value="admin">admin</option>}
                    <option value="analyst">analyst</option>
                    <option value="tester">tester</option>
                    <option value="disabled">disabled</option>
                  </select>
                </td>
                {metered && (
                  <td className="adm-credits">
                    <span>{(u.credits ?? 0).toLocaleString("en-US")}</span>
                    <Grant
                      onGrant={(n) => grant(u.id, u.email, n)}
                      // An administrator funds other people, within a bound, and never
                      // their own account. Creating credit spends the upstream balance,
                      // which is the owner's to spend.
                      disabled={role !== "owner" && u.id === me?.id}
                      cap={role === "owner" ? undefined : cap}
                    />
                  </td>
                )}
                <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                <td>{u.lastSeen ? new Date(u.lastSeen).toLocaleString() : "never"}</td>
              </tr>
            ))}
            {users.length === 0 && <tr><td className="t-empty" colSpan={metered ? 6 : 5}>no account yet</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h2>
          Activity <em>{activity.length}</em>
          {chain && (
            <span className={"adm-chain " + (chain.intact ? "ok" : "bad")}>
              {chain.intact ? `audit chain intact · ${chain.checked} entries` : `CHAIN BROKEN at entry ${chain.brokenAt}`}
            </span>
          )}
        </h2>
        <p className="adm-note">
          Every selector query is written to an append-only, hash-chained trail. A deletion or an edit anywhere in the
          middle breaks the chain and shows up here — tamper-evident, not tamper-proof.
        </p>
        <table className="datatable">
          <thead><tr><th>when</th><th>operator</th><th>kind</th><th>selector</th><th>legal basis</th></tr></thead>
          <tbody>
            {activity.map((a) => (
              <tr key={a.id}>
                <td>{new Date(a.at).toLocaleString()}</td>
                <td>{a.operator}</td>
                <td className="t-type">{a.kind}</td>
                <td className="t-handle">{a.selector}</td>
                <td>{a.legalBasis}</td>
              </tr>
            ))}
            {activity.length === 0 && <tr><td className="t-empty" colSpan={5}>nothing recorded yet</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ---- the source token -------------------------------------------------------------
//
// The one credential the product needs. Pasted once here and used by every search on
// the deployment, so changing it is a paste rather than a redeploy.
//
// It is never displayed back. The server returns a fingerprint — where the token in
// force comes from, its last four characters, its length, when it was set and by whom —
// which is everything an administrator needs to answer "is the right one in there" and
// nothing that leaks through a screenshot or a support ticket.

function SourceKey({ source, storable, onDone }: { source: Source | null; storable: boolean; onDone: (m: string) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; detail?: string; reason?: string; spent?: string } | null>(null);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    return { ok: r.ok, d };
  };

  const save = async () => {
    const { ok, d } = await post({ action: "source-set", token });
    if (!ok) { onDone(d.error || "could not save the token"); return; }
    setToken(""); setTest(null);
    onDone("Token saved. Every search on this deployment now uses it.");
  };

  const clear = async () => {
    if (!window.confirm("Remove the stored token? Searches will fall back to LEAKOSINT_TOKEN in the environment, if one is set — otherwise the product stops returning data.")) return;
    const { ok, d } = await post({ action: "source-clear" });
    onDone(ok ? "Stored token removed." : (d.error || "could not remove the token"));
  };

  const runTest = async () => {
    if (!window.confirm("Testing runs one real query against the index, at the minimum depth — about $0.003.\n\nThere is no free way to check a token: a deliberately malformed request would be free, and the endpoint answers those by blocking this deployment's IP for about 30 seconds.\n\nRun it?")) return;
    setTest(null);
    const { d } = await post({ action: "source-test" });
    setTest(d);
  };

  const configured = source && source.source !== "none";
  return (
    <section>
      <h2>
        Leak source <em>LeakOSINT</em>
        <span className={"adm-chain " + (configured ? "ok" : "bad")}>
          {configured ? `token in force · from the ${source!.source}` : "no token — the product returns no data"}
        </span>
      </h2>
      <p className="adm-note">
        The only source this product queries. A token comes from the bot&rsquo;s <code>/api</code> command and bills per
        request, so it is never written to the audit log and never displayed back here — to change it, paste a new one.
      </p>

      <div className="adm-src">
        <div className="adm-src-state">
          {configured ? (
            <>
              <code>{"•".repeat(Math.max(4, (source!.length || 12) - 4))}{source!.tail}</code>
              <span>
                {source!.source === "environment"
                  ? "set by LEAKOSINT_TOKEN in the environment — a stored token below would take precedence"
                  : `stored ${source!.setAt ? new Date(source!.setAt).toLocaleString() : ""}${source!.setBy ? ` by ${source!.setBy}` : ""}`}
              </span>
            </>
          ) : (
            <span>Nothing configured. Every search will say the deployment has no leak source rather than return an empty report.</span>
          )}
        </div>

        {storable ? (
          <>
            <div className="adm-src-form">
              <input
                value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} autoComplete="off"
                type="password" placeholder="123456789:AbCdEf12"
                onKeyDown={(e) => { if (e.key === "Enter" && token.trim()) save(); }}
              />
              <button className="ping-btn" onClick={save} disabled={busy || !token.trim()}>
                {configured ? "Replace token" : "Save token"}
              </button>
              {configured && source!.source === "stored" && (
                <button className="ping-btn" onClick={clear} disabled={busy}>Remove</button>
              )}
              <button className="ping-btn" onClick={runTest} disabled={busy || !configured}>Test · ~$0.003</button>
            </div>
            {test && (
              <div className={"adm-src-test " + (test.ok ? "ok" : "bad")}>
                {test.ok
                  ? <>Reached the index{test.spent ? ` · spent ${test.spent}` : ""}. {test.detail}</>
                  : <>The source refused: {test.reason}</>}
              </div>
            )}
          </>
        ) : (
          <p className="adm-note">
            This deployment has no database, so there is nowhere to keep a token. Set <code>LEAKOSINT_TOKEN</code> in the
            environment instead — a field here would silently do nothing.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Add credit to one account, in SEARCHES.
 *
 * Three amounts that mean something — a handful, a hundred, five hundred — plus a free
 * field, because the useful grant is often neither. A claw-back is the same control
 * with a negative number; the server clamps the balance at zero so it can never go
 * under. The unit is the one the person receiving it cares about: one credit buys one
 * standard search.
 */
function Grant({ onGrant, disabled, cap }: { onGrant: (credits: number) => void; disabled?: boolean; cap?: number }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  if (disabled) {
    return <span className="adm-grant-off" title="an administrator cannot credit their own account — ask an owner">—</span>;
  }
  if (!open) return <button className="adm-grant" onClick={() => setOpen(true)}>credit</button>;
  const give = (n: number) => { onGrant(n); setOpen(false); setCustom(""); };
  return (
    <span className="adm-grantbox">
      {[10, 100, 500].filter((v) => !cap || v <= cap).map((v) => (
        <button key={v} className="adm-grant" onClick={() => give(v)}>+{v}</button>
      ))}
      <input
        value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^\d-]/g, ""))}
        placeholder="±n" inputMode="numeric" aria-label="number of credits"
        onKeyDown={(e) => { if (e.key === "Enter") give(Number(custom)); }}
      />
      <button className="adm-grant" onClick={() => give(Number(custom))} disabled={!custom.trim()}>add</button>
      <button className="adm-grant" onClick={() => setOpen(false)}>×</button>
      {cap && <em className="adm-cap">max {cap}</em>}
    </span>
  );
}

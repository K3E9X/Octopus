"use client";

// Administration: who has access, what they have been running, and whether the audit
// chain is intact. Deliberately not a dashboard of charts — the questions an operator
// actually has are "who can get in" and "what did they do".

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "./Logo";

interface U { id: string; email: string; name?: string; role: string; createdAt: number; lastSeen?: number }
interface A { id: number; at: number; operator: string; kind: string; selector: string; legalBasis: string; caseId?: string }

export default function Admin({ me, disabledReason }: { me?: { id: string; email: string }; disabledReason?: string }) {
  const [users, setUsers] = useState<U[]>([]);
  const [activity, setActivity] = useState<A[]>([]);
  const [chain, setChain] = useState<{ intact: boolean; checked: number; brokenAt?: number } | null>(null);
  const [msg, setMsg] = useState("");

  async function load() {
    const r = await fetch("/api/admin");
    const d = await r.json();
    if (d?.users) { setUsers(d.users); setActivity(d.activity || []); setChain(d.chain || null); }
  }
  useEffect(() => { if (!disabledReason) load(); }, [disabledReason]);

  async function changeRole(id: string, role: string) {
    const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, role }) });
    const d = await r.json();
    setMsg(d?.error || "role updated");
    setTimeout(() => setMsg(""), 4000);
    load();
  }

  if (disabledReason) {
    return (
      <div className="adm">
        <header className="adm-top"><Link className="auth-brand" href="/"><Logo size={26} /><span><b>OCTOPUS</b><small>OSINT</small></span></Link></header>
        <p className="adm-empty">{disabledReason}</p>
      </div>
    );
  }

  return (
    <div className="adm">
      <header className="adm-top">
        <Link className="auth-brand" href="/"><Logo size={26} /><span><b>OCTOPUS</b><small>OSINT</small></span></Link>
        <span className="adm-me">{me?.email}</span>
        <span className="flex" />
        <Link className="ping-btn" href="/app">Open the tool</Link>
        <button className="ping-btn" onClick={async () => { await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "signout" }) }); location.href = "/"; }}>Sign out</button>
      </header>

      {msg && <div className="adm-msg">{msg}</div>}

      <section>
        <h2>Accounts <em>{users.length}</em></h2>
        <table className="datatable">
          <thead><tr><th>email</th><th>name</th><th>role</th><th>created</th><th>last seen</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="t-handle">{u.email}{u.id === me?.id ? " · you" : ""}</td>
                <td>{u.name || "—"}</td>
                <td>
                  <select className="api-select adm-role" value={u.role} onChange={(e) => changeRole(u.id, e.target.value)} disabled={u.id === me?.id}>
                    <option value="admin">admin</option>
                    <option value="analyst">analyst</option>
                    <option value="disabled">disabled</option>
                  </select>
                </td>
                <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                <td>{u.lastSeen ? new Date(u.lastSeen).toLocaleString() : "never"}</td>
              </tr>
            ))}
            {users.length === 0 && <tr><td className="t-empty" colSpan={5}>no account yet</td></tr>}
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

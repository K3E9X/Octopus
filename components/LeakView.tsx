"use client";

// LEAK — the primary surface.
//
// Every other view in this tool reasons ABOUT an identity. This one goes and gets the
// records: which database, what that database was, and the rows themselves. It is the
// first screen because it is the one that produces the material everything else
// correlates.
//
// The thing this screen does that the API does not: IT QUOTES BEFORE IT SPENDS. The
// endpoint bills per request on a published formula and tells you nothing until the
// money is gone, and the formula is not intuitive — three unquoted words cost sixteen
// times one word, four cost forty, and a quoted phrase collapses back to one. So the
// quote is live, it breaks down which tokens are being billed and which are free, and
// the button says the price it is about to charge.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Signal } from "@/lib/signals";

interface Quote {
  limit: number;
  metered: boolean;
  credits: number;
  cost: number;
  formatted: string;   // credits when metered, dollars otherwise
  usd: string;
  breakdown: { query: string; words: string[]; ignored: string[]; complexity: number; cost: number; credits: number }[];
}

interface LeakResult {
  seed?: string;
  signals?: Signal[];
  databases?: { name: string; info: string; rows: number }[];
  rowCount?: number;
  formatted?: string;
  limit?: number;
  leads?: { kind: string; value: string; why: string }[];
  error?: string;
  hint?: string;
  configured?: boolean;
  empty?: boolean;
  charged?: number;
  balance?: number;
  insufficient?: boolean;
  needsAuth?: boolean;
  price?: number;
}

const LIMITS = [100, 300, 1000, 3000, 10000];

export default function LeakView({
  cfgHeaders, onIngest, onOpenSources, balance, onBalance,
}: {
  cfgHeaders: () => Record<string, string>;
  onIngest: (signals: Signal[], seed: string) => number;
  onOpenSources: () => void;
  balance?: number;        // current credit balance, or undefined when unmetered / signed out
  onBalance?: (b: number) => void;
}) {
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(100);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<LeakResult | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  const seq = useRef(0);

  // The quote is a GET that costs nothing and calls nothing upstream — it is pure
  // arithmetic on the published formula, so it can run on every keystroke.
  useEffect(() => {
    const text = q.trim();
    if (!text) { setQuote(null); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      fetch(`/api/leak?q=${encodeURIComponent(text)}&limit=${limit}`)
        .then((r) => r.json())
        .then((d) => { if (mine === seq.current && !d.error) setQuote(d); })
        .catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [q, limit]);

  const run = useCallback(async () => {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true); setRes(null); setAdded(null);
    try {
      const r = await fetch("/api/leak", {
        method: "POST",
        headers: { "content-type": "application/json", ...cfgHeaders() },
        body: JSON.stringify({ request: text, limit }),
      });
      const d: LeakResult = await r.json();
      setRes(d);
      if (typeof d.balance === "number" && onBalance) onBalance(d.balance);
      if (d.signals?.length) setAdded(onIngest(d.signals, text));
    } catch {
      setRes({ error: "network unavailable" });
    } finally {
      setBusy(false);
    }
  }, [q, limit, busy, cfgHeaders, onIngest]);

  const words = useMemo(() => quote?.breakdown.flatMap((b) => b.words) ?? [], [quote]);
  const ignored = useMemo(() => quote?.breakdown.flatMap((b) => b.ignored) ?? [], [quote]);
  const complexity = quote?.breakdown.reduce((m, b) => Math.max(m, b.complexity), 1) ?? 1;

  // Order the recovered fields the way an analyst reads them, from the signals the
  // search already returned. Credentials first, then who the person is, then how to
  // reach them, then infrastructure, then the rest — and the raw row-pair lines last.
  const FIELD_ORDER: Record<string, number> = {
    credential: 0, name: 1, identifier: 1, email: 2, phone: 2, address: 3, document: 4,
    ip: 5, login: 5, date: 6, breach: 9, record: 9, other: 7,
  };
  type Field = { kind: string; label: string; value: string; masked?: boolean };
  type DB = { name: string; info: string; fields: Field[] };

  const dbs = useMemo<DB[]>(() => {
    const out: DB[] = [];
    for (const sig of res?.signals ?? []) {
      const exp = (sig as any).exposure as Field[] | undefined;
      if (!exp || sig.platform === "LEAKOSINT") continue;      // skip the roll-up root
      const info = exp.find((f) => f.kind === "breach");
      const fields = exp
        .filter((f) => f.kind !== "breach")
        .sort((a, b) => (FIELD_ORDER[a.kind] ?? 7) - (FIELD_ORDER[b.kind] ?? 7));
      out.push({ name: sig.platform, info: info?.value || "", fields });
    }
    return out;
  }, [res]);

  // Correlation: a value that shows up in more than one database is the strongest thing
  // a multi-source search produces — the same fact, independently, in two dumps.
  const correlations = useMemo(() => {
    const seen = new Map<string, { kind: string; value: string; dbs: Set<string> }>();
    for (const db of dbs) {
      for (const f of db.fields) {
        if (f.masked || f.kind === "record" || f.kind === "date") continue;
        const k = f.kind + "\u0000" + f.value.toLowerCase();
        const e = seen.get(k) || { kind: f.kind, value: f.value, dbs: new Set<string>() };
        e.dbs.add(db.name);
        seen.set(k, e);
      }
    }
    return [...seen.values()].filter((e) => e.dbs.size > 1).sort((a, b) => b.dbs.size - a.dbs.size);
  }, [dbs]);


  return (
    <div className="lk">
      <div className="lk-head">
        <h2>LEAK SEARCH</h2>
        <p>
          The records themselves — which database, what that database was, and the rows. This is the source
          the rest of the graph corroborates, not the other way round.
        </p>
      </div>

      <div className="lk-bar">
        <textarea
          className="lk-q" value={q} spellCheck={false} rows={2}
          placeholder={'an email, a phone, a name, a nickname…\none query per line · "quote a phrase" to keep it as one word'}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } }}
        />
        <div className="lk-ctl">
          <div className="lk-limits">
            <span>limit</span>
            {LIMITS.map((l) => (
              <button key={l} className={l === limit ? "on" : ""} onClick={() => setLimit(l)}>{l}</button>
            ))}
          </div>
          <button className="lk-run" onClick={run} disabled={busy || !q.trim()}>
            {busy ? "searching…" : quote ? `search · ${quote.formatted}` : "search"}
          </button>
        </div>
      </div>

      {/* The breakdown. Not a nicety: it is the difference between a $0.003 query and
          a $0.09 one, and the rule that decides it is invisible in the query itself. */}
      {quote && (
        <div className="lk-quote">
          <div className="lk-qrow">
            <span className="lk-qk">billed words</span>
            <span className="lk-qv">
              {words.length ? words.map((w, i) => <b key={i}>{w}</b>) : <em>none — the query is one token</em>}
            </span>
          </div>
          {ignored.length > 0 && (
            <div className="lk-qrow">
              <span className="lk-qk">free</span>
              <span className="lk-qv">
                {ignored.map((w, i) => <i key={i}>{w}</i>)}
                <em>dates, anything under 4 characters, numbers under 6 digits</em>
              </span>
            </div>
          )}
          <div className="lk-qrow">
            <span className="lk-qk">complexity</span>
            <span className="lk-qv">
              <b>{complexity}×</b>
              {complexity >= 16 && (
                <em>quote the phrase to drop this to 1× — &ldquo;{q.trim().split("\n")[0]}&rdquo;</em>
              )}
            </span>
          </div>
          <div className="lk-qrow">
            <span className="lk-qk">a higher limit</span>
            <span className="lk-qv"><em>returns more rows AND searches a wider slice of the index — a miss at 100 is an unfinished search, not a clean identity</em></span>
          </div>
        </div>
      )}

      {typeof balance === "number" && (
        <div className="lk-balance">balance <b>{balance.toLocaleString("en-US")} cr</b></div>
      )}

      {res?.error && (
        <div className={"lk-err" + (res.insufficient ? " is-money" : "")}>
          <b>{res.insufficient ? "Not enough credits" : res.needsAuth ? "Sign in to search" : res.error}</b>
          <span>{res.insufficient
            ? `${res.error}. An administrator tops up your balance, or reduce the limit to lower the price.`
            : res.needsAuth
              ? "This deployment meters searches against your account."
              : res.hint || ""}</span>
          {res.configured === false && <button onClick={onOpenSources}>Open Sources →</button>}
          {res.needsAuth && <a className="lk-signin" href="/signin">Sign in →</a>}
        </div>
      )}

      {res && !res.error && (
        <div className="lk-res">
          <div className="lk-sum">
            {res.rowCount
              ? <><b>{res.rowCount} row(s)</b> across <b>{res.databases?.length}</b> database(s) · {res.formatted} · limit {res.limit}</>
              : <><b>no match</b> at limit {res.limit} · {res.formatted} spent — the search was bounded, the identity is not cleared</>}
            {added !== null && added > 0 && <span className="lk-added">+{added} node(s) on the graph</span>}
          </div>

          {correlations.length > 0 && (
            <div className="lk-corr">
              <div className="lk-corr-h">confirmed across sources</div>
              {correlations.slice(0, 8).map((c, i) => (
                <div className="lk-corr-row" key={i}>
                  <span className={"lk-ck k-" + c.kind}>{c.kind}</span>
                  <span className="lk-cv">{c.value}</span>
                  <span className="lk-cn">{c.dbs.size} sources</span>
                </div>
              ))}
            </div>
          )}

          {dbs.map((d) => (
            <div className="lk-db" key={d.name}>
              <div className="lk-db-h">
                <span className="lk-db-n">{d.name}</span>
                <span className="lk-db-c">{d.fields.filter((f) => f.kind !== "record").length} field(s)</span>
              </div>
              {d.info && <p className="lk-db-i">{d.info}</p>}
              <div className="lk-fields">
                {d.fields.filter((f) => f.kind !== "record").map((f, i) => (
                  <div className={"lk-f" + (f.masked ? " masked" : "")} key={i}>
                    <span className="lk-fl">{f.label}</span>
                    <span className="lk-fv">{f.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {res.leads && res.leads.length > 0 && (
            <div className="lk-leads">
              <div className="lk-leads-h">{res.leads.length} lead(s) recovered</div>
              {res.leads.slice(0, 12).map((l, i) => (
                <button key={i} className="lk-lead" title={l.why} onClick={() => { setQ(l.value); }}>
                  <span className="lk-lk">{l.kind}</span><span className="lk-lv">{l.value}</span><span className="lk-lg">search →</span>
                </button>
              ))}
            </div>
          )}

          <p className="lk-note">
            Every row is on the graph with its database as the source. Open a node for the full exposure,
            the credential reuse it creates and the compromise timeline.
          </p>
        </div>
      )}
    </div>
  );
}

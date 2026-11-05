"use client";

// The report, on the front page, before anybody pays for anything.
//
// It replaces four paragraphs about what a report contains. Describing a report is a
// weak form of showing one, and the thing this product is actually better at, rows
// from five dumps consolidated into one person, with the database behind every single
// fact, is almost impossible to claim convincingly and trivial to demonstrate.
//
// THE DATA IS INVENTED AND THE REPORT IS NOT. lib/demo.ts holds five dumps written by
// hand; every number here is computed from them by the same buildReport() a paid search
// runs, which facets are corroborated and by how many databases, what counts as
// critical, which sources are services and which are aggregated lists, how many rows
// were set aside as somebody else's. A screenshot would drift from the product the
// first time the product changed. This cannot.
//
// It also proves itself. Building it was what surfaced four real misclassifications, // a card number, an IP and a platform user id all reported as the subject's phone
// numbers, and one number listed twice because the spelling differed, on a page whose
// copy promises precisely that none of that happens.

import { useState } from "react";
import type { SearchReport } from "@/lib/report";
import { FACET_ORDER, FACET_LABEL } from "@/lib/identity";
import { VIEWS } from "@/lib/views";
import dynamic from "next/dynamic";

// The graph is the heaviest thing on this page and the last tab anybody opens, so it
// arrives when it is asked for.
const LeakOrbit = dynamic(() => import("./LeakOrbit"), { ssr: false });

const TABS = [
  { id: "subject", label: "Subject", note: "who the rows describe" },
  { id: "services", label: "Services", note: "who holds the data" },
  { id: "type", label: "By type", note: "worst first" },
  { id: "orbit", label: "Orbit", note: "what holds it together" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const KIND_HEAD: Record<string, string> = {
  social: "Social networks",
  service: "Other services",
  aggregate: "Aggregated lists, not accounts anywhere",
};

export default function Demo({ report }: { report: SearchReport }) {
  const [tab, setTab] = useState<TabId>("subject");
  const { corroborated, facets, databases } = report.identity.corroboration;

  const facetRows = FACET_ORDER
    .map((f) => [f, report.identity.facets[f]] as const)
    .filter(([, v]) => v && v.length);

  return (
    <div className="lk2m">
      <div className="lk2m-bar">
        <span className="lk2m-q">{report.subject.raw}</span>
        <span className={"lk2m-verdict v-" + report.verdict}>{report.verdict}</span>
        <span className="lk2m-spacer" />
        <b>{report.dataPoints}</b><span>data points</span>
        <b>{report.breachCount}</b><span>databases</span>
        {/* The rows that matched the query and were NOT this person. It is the number
            the rest of the category does not print, and the whole argument for the
            product: a result set is not a report. */}
        <b>{report.excluded.total}</b><span>set aside</span>
      </div>

      <div className="lk2m-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
            className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
            {t.label}<em>{t.note}</em>
          </button>
        ))}
      </div>

      <div className="lk2m-body">
        {tab === "subject" && (
          <>
            <p className="lk2m-sum">{report.summary}</p>
            <p className="lk2m-corr">
              <b>{corroborated} of {facets}</b> facets confirmed by more than one of the {databases} databases
            </p>
            <div className="lk2m-facets">
              {facetRows.map(([f, values]) => (
                <div className="lk2m-facet" key={f}>
                  <h4>{FACET_LABEL[f] || f}</h4>
                  {values!.map((v) => (
                    <div className={"lk2m-val" + (v.sources.length > 1 ? " corr" : "")} key={v.value}>
                      <code>{v.value}</code>
                      {/* every value names its databases: the claim is checkable by looking */}
                      <span>{v.sources.join(" · ")}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "services" && (
          <>
            <p className="lk2m-sum">{report.servicesSummary}</p>
            {(["social", "service", "aggregate"] as const).map((kind) => {
              const tiles = report.services.filter((t) => t.kind === kind);
              if (!tiles.length) return null;
              return (
                <div key={kind}>
                  <h5 className="lk2m-head">{KIND_HEAD[kind]}</h5>
                  <div className="lk2m-grid">
                    {tiles.map((t) => (
                      <div className={"lk2m-svc s-" + t.severity} key={t.name}>
                        <b>{t.name}</b>
                        <span>{t.fields} field{t.fields === 1 ? "" : "s"}{t.firstYear ? ` · ${t.firstYear}` : ""}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {tab === "type" && (
          <div className="lk2m-cats">
            {report.categories.map((c) => (
              <div className={"lk2m-cat s-" + c.severity} key={c.category}>
                <div className="lk2m-cat-h">
                  <b>{c.label}</b>
                  <span className="lk2m-sev">{c.severity}</span>
                  <span className="lk2m-n">{c.distinct}</span>
                </div>
                <p>{c.meaning}</p>
                <p className="lk2m-do"><span>do</span>{c.action}</p>
              </div>
            ))}
          </div>
        )}

        {tab === "orbit" && (
          <LeakOrbit report={{
            subject: report.subject.raw,
            sources: report.sources,
            breachCount: report.breachCount,
            dataPoints: report.dataPoints,
          }} />
        )}
      </div>

      <p className="lk2m-foot">
        Invented person. <code>example.com</code> is reserved by RFC&nbsp;2606 and the number is
        in the range ARCEP keeps for fiction, neither can reach anybody. Every figure above is
        computed from five hand-written dumps by the same code a paid search runs.
        {" "}{VIEWS.length} views ship in the product; four of them are here.
      </p>
    </div>
  );
}

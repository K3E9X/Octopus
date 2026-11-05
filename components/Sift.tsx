// The one picture worth drawing on this site.
//
// The product's whole argument is a sentence that sounds like pedantry until you see
// it: a result set is not a report. The index searches every word order, so what comes
// back is rows that matched SOMETHING, and a tool that renders all of them as one
// person's file produces a detailed, confident, wrong document.
//
// So the illustration is the mechanism, not a mood: rows arrive undifferentiated, then
// the ones carrying the subject settle and light while the ones that merely share a
// word drift aside and go quiet.
//
// NO JAVASCRIPT. The first version waited for an IntersectionObserver to decide it was
// visible, which meant the sorted state, the half that carries the meaning, existed
// only if a client event arrived. It froze at seven identical rows in a headless
// renderer, and would do the same in a throttled tab or a browser without the API,
// showing the exact opposite of what the paragraph beside it claims. The sorted state
// is now the BASE state, written into the markup; the animation runs backwards from
// the unsorted look and lands on it. Strip every animation and the picture still says
// what it means, which is the only version worth shipping.

/**
 * Each row: the columns it shows, and whether it is about the subject.
 *
 * EVERY VALUE HERE IS FICTIONAL, and deliberately unusable. This is a public page
 * about leaked personal data, so a label that looks like somebody's address is a
 * label that IS somebody's address, surnames belong to real people whether or not
 * one was in mind. So: the reserved `example.com` domain, "Doe" as the universal
 * placeholder for a person who does not exist, a number from the range regulators
 * reserve for fiction, and an IBAN whose country code is not a country. Each is also
 * cut short, so none of them is a complete value even by accident.
 *
 * The three "other" rows still make the point the illustration exists for: two share
 * a surname with the subject, and one is a STREET that merely contains it.
 */
const ROWS: { cells: number[]; mine: boolean; label: string }[] = [
  { cells: [34, 18, 26], mine: true, label: "j.doe@example…" },
  { cells: [22, 30, 14], mine: false, label: "a.doe@example…" },
  { cells: [28, 22, 30], mine: true, label: "+33 6 39 98…" },
  { cells: [18, 26, 22], mine: false, label: "rue Doe" },
  { cells: [30, 16, 24], mine: true, label: "XX00 0000…" },
  { cells: [24, 28, 18], mine: false, label: "s.doe@example…" },
  { cells: [20, 24, 28], mine: true, label: "1 Example St…" },
];

export default function Sift() {
  const mine = ROWS.filter((r) => r.mine).length;
  return (
    <div className="sift" aria-hidden>
      <div className="sift-col">
        <span className="sift-cap">what came back</span>
        <span className="sift-n">{ROWS.length} rows</span>
      </div>

      <div className="sift-rows">
        {ROWS.map((r, i) => (
          <div className={"sift-row" + (r.mine ? " mine" : " other")} key={i} style={{ ["--i" as any]: i }}>
            <span className="sift-mark" />
            {r.cells.map((w, j) => (
              <span className="sift-cell" key={j} style={{ width: w }} />
            ))}
            <span className="sift-label">{r.label}</span>
          </div>
        ))}
      </div>

      <div className="sift-col sift-out">
        <span className="sift-cap">about this subject</span>
        <span className="sift-n">{mine}</span>
        <span className="sift-cap sift-cap-2">someone else</span>
        <span className="sift-n sift-n-2">{ROWS.length - mine}</span>
      </div>
    </div>
  );
}

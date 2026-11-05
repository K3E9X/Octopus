// The views a report has, in one place.
//
// There were four claims about how many there are, "three views" in the report
// module, "Four ways to read the same facts" on the landing, "three views stay
// mounted" in a comment above four mounted divs, and "the three views" in the README, // while the interface rendered seven. Every one of them was written truthfully on the
// day it was written, and every one of them went stale the next time a view was added.
//
// A number nobody owns drifts. This is the list, the tabs read it, the landing reads
// it, and the count is something you derive rather than remember.

export type ViewId = "identity" | "services" | "orbit" | "category" | "source" | "timeline" | "records";

export interface ViewDef {
  id: ViewId;
  /** the tab label */
  label: string;
  /** what this view answers, for anywhere the product has to explain itself */
  blurb: string;
}

export const VIEWS: ViewDef[] = [
  {
    id: "identity",
    label: "Subject",
    blurb:
      "The person the rows describe: name, addresses, phones, documents. Each value names the databases that carried it, ranked by how many independently agree.",
  },
  {
    id: "services",
    label: "Services",
    blurb:
      "Who holds their data. Social networks first, then other companies, with aggregated credential lists kept apart: being in one of those is not an account anywhere.",
  },
  {
    id: "orbit",
    label: "Orbit",
    blurb:
      "What holds the identity together. Databases and the values they share, drawn as a graph. Take a value away and see whether the person survives without it.",
  },
  {
    id: "category",
    label: "By type",
    blurb:
      "Every field ranked worst-first: passwords and bank details at the top, each with what it means and the one thing to do about it.",
  },
  {
    id: "source",
    label: "By breach",
    blurb: "Which leak exposed what, with that breach's own description and date.",
  },
  {
    id: "timeline",
    label: "Timeline",
    blurb: "When each compromise happened, oldest to newest.",
  },
  {
    id: "records",
    label: "Records",
    blurb:
      "Every matched row verbatim, column by column, with the dump's own field names, including what the classifier drops as metadata. The views above judge; this one does not.",
  },
];

export const VIEW_COUNT = VIEWS.length;

/** Spelled out, because "7 ways to read the same facts" reads like a listicle. */
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export const viewCountWord = (): string => WORDS[VIEW_COUNT] ?? String(VIEW_COUNT);

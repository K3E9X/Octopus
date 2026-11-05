// The report the landing page shows, and the invented person it is about.
//
// THE DATA IS FAKE AND THE REPORT IS NOT. The dumps below are written by hand; every
// number on the screen, which facets are corroborated and by how many databases, what
// counts as critical, which sources are services and which are aggregated lists, how
// many rows were set aside as somebody else's, is computed by the same buildReport()
// the product runs on a paid search. A mocked-up screenshot drifts from the product the
// first time the product changes. This cannot: if the classifier stops calling a card
// number critical, the landing page stops saying so too.
//
// NOTHING HERE CAN REACH A REAL PERSON, and that is deliberate rather than hopeful:
//
//   example.com is reserved by RFC 2606 and can never be registered.
//   06 39 98 xx xx is the range ARCEP reserves for fiction; it is not assignable.
//   The card is the test number every payment processor publishes as a test number.
//   The name and the street are invented, and the street number does not exist.
//
// A demo built from a real breach would be the product committing the exact harm it
// sells protection from.

import { buildSubject } from "./subject";
import { buildReport, type SearchReport } from "./report";
import type { LeakDatabase } from "./leakosint";

export const DEMO_SELECTOR = "l.marchetti@example.com";

/**
 * Five sources, chosen so the report has something to say in every view.
 *
 * Two are services and one is a social network, so the grid can separate them. One is
 * an aggregated credential list, which is the distinction the probing products cannot
 * make, being in a combolist is not an account anywhere. The passwords across two
 * dumps are one stem with a rotating year, which is the pattern the habits view exists
 * to name. And the last dump carries a row belonging to somebody else entirely, so the
 * count of what was set aside is a real number rather than a claim.
 */
const DUMPS: LeakDatabase[] = [
  {
    name: "Vectra Fitness 2019",
    info: "In August 2019 the gym chain Vectra Fitness was breached. The dump carried names, addresses, dates of birth and bcrypt hashes.",
    rows: [
      {
        Email: "l.marchetti@example.com",
        FullName: "Lena Marchetti",
        BirthDate: "1991-04-17",
        Phone: "+33 6 39 98 41 02",
        Address: "14 rue des Sablons Hauts, 69007 Lyon",
        Password: "Sablon2019!",
      },
    ],
  },
  {
    name: "Pixelhub 2021",
    info: "A 2021 scrape of the design community Pixelhub exposed profile data for 1.9M accounts.",
    rows: [
      {
        Email: "l.marchetti@example.com",
        Username: "lmarchetti",
        JobTitle: "Product designer",
        Company: "Atelier Verone",
        LastLogin: "2021-11-02",
        ProfileID: "4418903255",
      },
    ],
  },
  {
    name: "Facebook 2021",
    info: "Profile data for 533M accounts, scraped before 2019 and published in April 2021.",
    rows: [
      {
        Email: "l.marchetti@example.com",
        Name: "Lena Marchetti",
        Phone: "0639984102",
        City: "Lyon",
        UID: "100008841220",
      },
    ],
  },
  {
    name: "Collection #2",
    info: "An aggregated credential list assembled from earlier breaches. Its contents cannot be traced to any one service.",
    rows: [
      { Email: "l.marchetti@example.com", Password: "Sablon2021!" },
      { Email: "l.marchetti@example.com", Password: "Sablon2019!" },
    ],
  },
  {
    name: "Nordeste Retail 2022",
    info: "A 2022 compromise of an online retailer exposed order records, including partial payment data.",
    rows: [
      {
        Email: "l.marchetti@example.com",
        CardNumber: "4111 1111 1111 1111",
        BillingAddress: "14 rue des Sablons Hauts, 69007 Lyon",
        OrderIP: "92.184.104.57",
      },
      // Somebody else, matched by the index because it searches every word order. It is
      // here so the "set aside" count on the page is produced rather than asserted.
      {
        Email: "t.okafor@example.com",
        CardNumber: "5555 5555 5555 4444",
        BillingAddress: "3 avenue Marcelin Fabre, 69100 Villeurbanne",
      },
    ],
  },
];

let cached: SearchReport | null = null;

/** Built once: it is deterministic, and the landing renders it on every tab switch. */
export function demoReport(): SearchReport {
  if (!cached) cached = buildReport(buildSubject(DEMO_SELECTOR), DUMPS);
  return cached;
}

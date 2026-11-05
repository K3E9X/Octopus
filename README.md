# Octopus Leak

**Breach data, turned into a subject.**

Give it an email address, a phone number, a handle or a name. It searches
[LeakOSINT](docs/leakosint-api.md), the one source here, and the only one that returns
the records themselves rather than a verdict, and gives back more than a list of hits:
the rows that are genuinely about that subject, consolidated into one person, with the
database behind every single fact.

The hard part is not the search. It is everything between the response and the report.

## The problem this exists to solve

The index searches **every permutation of the words in a query**. A result set is
therefore rows that matched *something*, not rows about the person asked for. Hand
those to a reader as one profile and you have produced a detailed, confident, wrong
document, which is worse than producing nothing.

Three things stand between the API and a claim:

**Attribution.** Every row is judged before it contributes anything, `direct`,
`partial`, or `none`. Only `direct` rows become facts about the subject. Partial and
unrelated rows are counted and shown as what they are: other people. They are never
merged, and never silently dropped either, because the operator paid for them and a
count of what was set aside is the only way to tell *nothing was found* apart from
*everything found belonged to someone else*.

**Matching that survives how dumps actually store things.** An address is canonicalised
on both sides, so a search for `johndoe@gmail.com` still matches a dump holding
`john.doe+shop@gmail.com`. A number is compared past the national trunk prefix, in most
of Europe the leading `0` is *replaced* by the country code rather than appended, so
`+33612345678` and `0612345678` share neither prefix nor suffix until that is handled,
and missing it loses the single most relevant row in a result set.

**Consolidation.** The subject's rows become one person, each value naming the databases
that carried it and ranked by how many **independent** dumps agree. Corroboration is
reported as *"2 of 5 facets confirmed by more than one database"*, a count, never a
percentage. Nobody calibrated a percentage, and a number out of 100 gets read as a
probability it has not earned.

## What a search costs, before it runs

The upstream API bills per request on a published formula and says nothing about the
price until the money is gone. The formula is reimplemented here and pinned by tests, so
every query is quoted first:

| Query at `limit=100` | Complexity | Cost |
|---|---|---|
| `example@gmail.com` | 1 | **$0.0030** |
| `Petya Ivanov` | 5 | $0.0055 |
| `Elon Reeve Musk` | 16 | $0.0090 |
| `"Elon Reeve Musk"` | 1 | **$0.0030** |

Quoting a name is a third of the price, and it is also **narrower**, matching the
phrase as written instead of every word order. That is a choice with two axes, so the
interface prices both and says which one buys what. Full contract, including where the
documentation and the live endpoint disagree, in [`docs/leakosint-api.md`](docs/leakosint-api.md).

## Selectors

An **email**, a **phone** and a **handle** designate someone, so their rows can be
presented as one person's report.

A **name** does not: thousands of people share one. A name search is still run, because
the index supports it and it is often the only thing an investigation has, but its
results are rendered as candidates grouped by who they appear to be. The interface says
so at the point of entry, not in a footnote under the results.

## Accountability instead of a gate

Any search runs against a real person's data, so the record of **why** exists before the
data does. Every query carries a declared basis from a closed list (own data, consent,
investigation, legal request, security research) and is written to an **append-only,
hash-chained** log *before* it runs, so a refused or failed attempt leaves a trace too. A
trail that records only successes hides the interesting half.

`GET /api/audit?verify=1` re-walks the chain. A break means a row was altered or removed.
This is tamper-**evident**, not tamper-proof: it survives challenge, it does not survive
an attacker with database write access and time.

## Run it

```bash
npm install
npm run dev            # http://localhost:3000
npm test               # unit tests over the lib layer
npm run build && npm start
```

```bash
docker compose up --build                 # unmetered, no accounts
docker compose --profile db up --build    # + Postgres: accounts, credits, audit trail
```

Configuration is env vars, all optional; see [`.env.example`](.env.example). The app
always runs and **says what is missing** rather than faking it:

| Variable | Absent |
|---|---|
| `LEAKOSINT_TOKEN` | No leak data, stated as such, never an empty report |
| `POSTGRES_URL` | Single-operator: no accounts, no metering, **no audit trail**. Fine for one analyst, never for anything public |
| `OCTOPUS_SESSION_SECRET` | Sessions are refused rather than signed with a shared constant |
| `OCTOPUS_MARKUP` | Dollar valuation of a credit, as a multiple of the raw API cost (default `1.6`). **Not the margin**; see below |

## The business layer

The product resells the API. Every query has a raw cost, the operator is charged a
marked-up price in credits, and the margin is the business.

**A credit is one search.** A plain address at the default depth costs one; a
multi-word name costs more because it genuinely is more work upstream, and so does a
deeper sweep. Charges round up to a whole credit, which keeps a balance a whole number
of searches and absorbs the variance in the upstream price.

The ledger underneath is in micro-dollars (integers), because floating-point dollars
drift and a balance that drifts leaks money in one direction.

`OCTOPUS_MARKUP` sets what a credit is *worth* in dollars, not what it is *sold* for.
It cannot change a credit price: a search costs what it costs in work, whatever margin
is being taken. **The margin lives in what a pack of credits sells for**, which is a
decision, not a config value, and there is no self-serve way to buy one yet. The balance check and the
deduction are **one statement**, so two requests racing on the same account cannot both
pass against a balance that covers one. A query the API refuses is refunded, because it
did not run. Every movement is recorded, so a balance is always explainable.

## Structure

```
app/search/        the product
app/api/search/    GET quotes · POST runs
lib/leakosint.ts   the source: cost, rate limit, parsing, refusals
lib/subject.ts     what was asked for, and what to match rows against
lib/attribution.ts is this row about the subject?
lib/identity.ts    rows → a person, every value citing its databases
lib/report.ts      the report, built from attributed rows
lib/views.ts       the views a report has, one list, so nothing can disagree about it
lib/credits.ts     the business layer
lib/audit.ts       the hash-chained query log
docs/              the API contract
```

## Legal note

For **legitimate** investigation: fraud, due diligence, threat intelligence, journalism,
and checking your own exposure. Processing personal data means GDPR applies, legal
basis, minimisation, limited retention, audit, and data-subject rights. The declared
basis and the query log exist so those obligations can actually be met rather than
asserted.

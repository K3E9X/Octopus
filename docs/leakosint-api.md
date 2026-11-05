# LeakOSINT API, the contract

The source this product is built on. Transcribed from the official documentation and
checked against the live endpoint, because the two do not agree everywhere and the
places they disagree are the places that cost money or hide a refusal.

Implemented in [`lib/leakosint.ts`](../lib/leakosint.ts). Nothing else in the codebase
talks to this endpoint.

## Endpoint

```
POST https://leakosintapi.com/
Content-Type: application/json
```

**The body must be JSON.** Form-encoded parameters return a `501`. This is the one
thing the documentation states twice, so it is presumably the one thing everybody gets
wrong first.

## Parameters

| Parameter | Required | Default | Notes |
|---|---|---|---|
| `token` | yes |, | From the bot's `/api` command. A new token carries **100 free requests**; after that it draws on the account balance. |
| `request` | yes |, | One query string, several separated by `\n`, or an array of strings. |
| `limit` | no | `100` | 100–10 000. Raises both how many rows come back and **how far into the databases the search reaches**, it is a depth control, not just a page size. It is also a price multiplier. |
| `lang` | no | `en` | Language of the `InfoLeak` descriptions. |
| `type` | no | `json` | `json`, `short`, `html`. We always send `json`. |
| `bot_name` | no |, | `@name`, needed only when the token does not belong to the main mirror group. |

## Price

```
cost_usd = 0.0002 * (5 + sqrt(limit * complexity))
```

`complexity` counts the **billable words** in the query, because a multi-word query is
searched in every permutation:

| Billable words | Complexity |
|---|---|
| 1 | 1 |
| 2 | 5 |
| 3 | 16 |
| 4 or more | 40 |

A token is **not** a billable word when it is:

- a date,
- a string shorter than 4 characters,
- a number shorter than 6 characters.

A span inside `"double quotes"` counts as **one** word. That is the documented escape
hatch and it is also the cheapest way to search a full name, it drops a three-word
query from complexity 16 to 1, which at `limit=100` is $0.009 → $0.003.

Worked examples at `limit=100`, verified against `estimateCost`:

| Query | Complexity | Cost |
|---|---|---|
| `example@gmail.com` | 1 | **$0.0030**, the documentation's own headline figure |
| `Petya Ivanov` | 5 | $0.0055 |
| `Elon Reeve Musk` | 16 | $0.0090 |
| `Jean Pierre De La Tour` | 16 | $0.0090, `De` and `La` are under 4 characters, so 5 words bill as 3 |
| `"Elon Reeve Musk"` | 1 | $0.0030 |

Raising the limit on a one-word query: 100 → $0.0030, 300 → $0.0045, 1 000 → $0.0073,
10 000 → $0.0210.

**Batching is assumed to bill per query**, and `estimateCost` sums accordingly. The
documentation does not say so outright; summing is the assumption that cannot
undercharge, and undercharging is the only error here that loses real money.

## Rate limit

**3 requests per second per IP.** The documented ways past it are to combine queries
into one request, or to create an additional key from the bot's `/app` tab, worth
knowing before scaling this to many concurrent users.

`lib/leakosint.ts` spaces its own calls 350 ms apart rather than discovering the limit
by being refused, because a refusal that is not distinguished from "no result" is how a
search silently under-reports.

## Response

```jsonc
{
  "List": {
    "SomeDatabase 2024": {
      "InfoLeak": "In March 2024, SomeService suffered a breach exposing…",
      "Data": [
        { "Email": "x@y.z", "Password": "…", "FullName": "…", "Phone": "…" }
      ]
    }
  }
}
```

Three properties that drive the whole design:

1. **Results are grouped by database, with an `InfoLeak` description per database.**
   That per-database provenance is the most valuable thing the API returns and
   flattening it into one list would destroy it.
2. **Column names are the dump's own** and vary between databases. There is no fixed
   schema, so `lib/leakosint.ts` classifies by column name and value shape and shows
   anything it does not recognise under the column's own name rather than dropping it.
3. **`"No results found"` arrives as a database name**, not as an error and not as an
   empty `List`. A clean search is a successful search.

## Refusals, the part the documentation gets wrong

The endpoint answers **HTTP 200 to everything**, including refusals, and signals them
only in the body. It uses **two different keys**:

| Key | Where it comes from |
|---|---|
| `Error code` | The official documentation and its Python sample |
| `error` | **What the live endpoint actually sends** for an invalid token and for the rate limit |

Observed live, verbatim:

```json
{"error":"You have made too many requests that have invalid data. You will be able to make requests again in 30 seconds. If you have a large list of queries that need to be completed, use file search in the bot."}
```

The official Python sample only tests `"Error code" in response`, so on this payload it
falls straight through to `response["List"]` and raises a `KeyError`. Our own client had
the same hole and silently did something worse: it found no `List`, handed the body to
the salvage harvester, and returned the refusal sentence as a **finding**.

`refusalIn()` therefore reads every key either source has been seen to use, and runs
before anything else touches the payload. "The API refused" and "this person is clean"
are opposite findings and must never be able to render the same way.

## What can be searched

The documentation's own examples are `google`, `Petya Ivanov`, `example@gmail.com` and
`Elon Reeve Musk`, so the API takes **any string**, not just a verifiable identifier.
That is broader than the identifier-only products in this category, and it is a product
decision rather than a technical one:

- An **email** or a **phone number** resolves to one person. Rows can be presented as a
  report about that person.
- A **name** does not. A name query returns rows belonging to **different people who
  share a name**, and presenting them as one person's report would be a fabrication.
  Name results have to be rendered as candidate records to be disambiguated, never
  merged.

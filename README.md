# Octopus

**The OSINT correlation cockpit.**
Octopus's job is not to re-scrape the web — proven open-source collectors (Maigret, Holehe, SpiderFoot…) already do that. Octopus's job is the part that's rarely done well: **resolve one identity across everything those collectors surface** — merge, deduplicate, link, score with an honest tier, extract identifiers, pivot, and synthesize a person. It orchestrates the collectors and owns the correlation, the graph, the dossier, and the investigation workflow.

> Design principle: *delegate collection, own correlation.* Plug collectors into the [worker](collector/), pull their output, and let Octopus do the intelligence.

The signature view is **Orbit**: identity correlation shown as a **gravitational system**. The seed (a username, an email, a person) sits at the center; every presence found on the net is a body in orbit; **the matching engine's confidence = the pull of gravity**. Strong evidence → tight orbit (the "confirmed self"); weak or contradicted evidence → drift into the cold. Spring physics: everything glides, nothing is frozen.

> Status: interface prototype with a live scan backend. Full ingestion, matching engine, and persistence are described in [`docs/architecture.md`](docs/architecture.md) and land in stages.

## Run locally

```bash
npm install
npm run dev            # http://localhost:3000
npm test               # unit tests (node:test over the lib layer)
npm run build && npm start   # production build
```

Works on **Windows and Linux** identically (pure Node.js; no native build step).

## Run it yourself — Docker / Kubernetes (self-host anywhere)

Octopus is not tied to Vercel. It ships a standalone Docker image and a full local
stack. Every external dependency is optional — remove one and the app keeps running,
degrading cleanly.

**Single container:**

```bash
docker build -t octopus .
docker run -p 3000:3000 octopus          # http://localhost:3000
```

**Full stack (app + deep-scan collector, one command)** — identical on Windows
(Docker Desktop / WSL2) and Linux:

```bash
docker compose up --build              # app + Maigret/Holehe/SpiderFoot collector
docker compose --profile db up --build # + a local Postgres for durable cases
```

**Kubernetes** (any cluster — EKS/GKE/AKS/k3s/minikube):

```bash
# build & push both images to your registry, edit the image: fields in k8s/octopus.yaml
kubectl apply -f k8s/octopus.yaml        # namespace, app (x2), collector, secrets
```

All configuration is env vars (see [`.env.example`](.env.example)); all are optional.

**Face recognition (optional).** The `◉ FACES` button (match the same person across
different photos) needs the model weights once — `npm run fetch-face-models` (~7 MB
into `public/models`, not committed). Until then it degrades gracefully.

## Deploy on Vercel (free)

Standard Next.js app, zero-config deploy.

1. Push this repo to GitHub (already done: `K3E9X/Tusna`).
2. Go to [vercel.com/new](https://vercel.com/new) and sign in with GitHub.
3. **Import** the `K3E9X/Tusna` repo (pick the working branch if not merged to `main`).
4. Vercel auto-detects Next.js — nothing to change (build `next build`, output `.next`).
5. **Deploy**. Preview URL is ready in ~1 min; every push redeploys.

No environment variables are required yet. Connector API keys (Shodan, HIBP, etc.) will be added as Vercel env vars when those paid sources are wired — never committed.

## Structure

```
app/            # Next.js App Router (layout, page, global styles)
  api/scan/     # server route: live scan + sourced scoring
components/     # OrbitBoard.tsx — the Orbit view (canvas + spring physics)
lib/            # signals.ts (typed model) · connectors.ts (13 public APIs)
                # wmn.ts (WhatsMyName) · phash.ts (avatar hashing)
                # email.ts (email→accounts) · cases.ts (local persistence)
docs/           # architecture, osint-tools-research, llm-correlation
```

## Live connectors (real scan)

The **seed** accepts a **username, email, phone number, or full name** (auto-detected).

**Username mode** — **SCAN** queries **13 official public APIs** in parallel (no key, no scraping, ToS-respecting): GitHub, GitLab, Reddit, Hacker News, **Keybase**, **Gravatar**, Bluesky, Mastodon, Chess.com, Codeforces, npm, Docker Hub, Wikipedia. Keybase and Gravatar also surface **declared linked accounts** (verified cross-links) — a strong correlation signal.

**Email mode** — `email → accounts`, no key: (1) **Gravatar by hash** (MD5/SHA256) → verified profile + declared linked accounts (the anchor); (2) a **handle derived** from the local-part (gmail dot/tag normalization) re-run across every source, flagged **"derived (inference)"** and scored lower — the link to the person still needs confirming; (3) **MX validation** of the domain.

**Phone mode** — a phone number (with `+` and spaces, or a national number; default region FR, override with `?country=`) yields **deterministic offline intel** via libphonenumber: validity, country, line type (mobile / fixed), and E.164 / national / international formats — a typed **☎ phone node**. Free automated *owner* lookup doesn't exist, so the node points to the pre-filled **Epieos / Truecaller / PhoneInfoga / Numverify** pivots to go further.

**Name mode** — a full name ("Jean Dupont") has no free resolver, so name mode generates **candidate handles** (jeandupont, jean.dupont, jdupont, dupontjean…) as pivot-ready nodes around a ◆ person node, and exposes the **Name pivots** (Google exact-search, LinkedIn, people-search) pre-filled. Pivot / auto-expand the candidates → real accounts → the dossier confirms the name.

**Broad layer — WhatsMyName.** On top of the 13 APIs, the scan queries the **official WhatsMyName dataset** (600+ sites, loaded at runtime from the maintained repo). These presences are detected by **URL pattern**: they are explicitly flagged **"unverified"**, scored low and placed in cold orbit — the human confirms. This broadens coverage **without manufacturing false positives**. Sites checked per scan are capped (`?depth=`, default 100, to fit a serverless function's time limit) and the response exposes `coverage.capped` — **never a silent truncation**.

**Linking by photo — pHash.** Avatars of the presences found are hashed (perceptual dHash, local) and compared pairwise: two accounts whose photos match (low Hamming distance) are linked by a strong "Matching/near-match avatar" evidence. This is **deterministic and verifiable** — so no hallucination — and links accounts even when usernames differ. No external facial service: we compare images, not faces (no biometric exposure).

**Linked-account web.** Declared/verified links (Keybase proofs, Gravatar accounts) are expanded into **connected nodes** and drawn as **inter-node edges** — the board shows who is linked to whom, not just each body to the seed.

Deliberately **excluded** from automated connectors: Instagram, X/Twitter, Facebook, LinkedIn, TikTok (closed APIs / restrictive ToS) — those belong to the **manual pivots** catalogue (cipher387), not automation.

## Apps (connectors marketplace)

The **APPS** panel is a registry of sources you install and combine:

- **Built-in connectors** (GitHub, Keybase, Gravatar, WhatsMyName, avatar pHash, …) are **toggles**: turning one on/off actually changes what the scan runs. Enable more → more sources feed the **same correlation engine** (shared entity model, cross-signals like matching avatars and declared links) → a richer, more cross-linked result. The enabled set is sent to `/api/scan?connectors=…` and persisted in the browser.
- **Manual pivots** (the cipher387 catalogue: Epieos, Sherlock, PimEyes, Shodan, IntelX, …) can be **added**; once added they **open pre-filled with the current seed** (`{seed}` substituted in the tool's URL) so the analyst can run them and paste findings back. Each is labeled `free / freemium / paid`.

This is the "install an app → it adapts to the seed and correlates with the others" model: automated connectors plug straight into the pipeline, manual tools bridge what can't be automated (closed APIs / restrictive ToS).

**Deep collection (Maigret) + entity extraction.** Existence ("the handle exists here") isn't the goal — *knowledge* is. Two things build a real schema from a single username:

- **Entity extraction** (always on, runs on Vercel): every collected bio / display name is mined for **emails, other aliases, and links**, which become their own **typed nodes** wired to the source — so the board grows from "platform presences" into a graph of a person's identifiers. An alias that matches an existing platform links them instead of duplicating.
- **Maigret collector** (optional worker in [`collector/`](collector/)): for real depth, Octopus delegates to **Maigret** — 3000+ sites *with profile-data extraction and identifier discovery* — and pulls the structured result into the same graph. **One-click deploy** via the [`render.yaml`](render.yaml) blueprint ([Deploy to Render](https://render.com/deploy?repo=https://github.com/K3E9X/Tusna)), then set `COLLECTOR_URL` on Vercel; the "Maigret (deep)" app then feeds every scan. Without it, the built-in connectors are used. This is the "let a proven tool do the heavy collection, we pull and correlate" model.

**Typed nodes.** Discovered entities are styled by kind so the graph reads at a glance: **platform** accounts (2-letter tag), **emails** (✉, dashed warm ring), **aliases** (~, violet ring). Confidence stays encoded by orbit distance + brightness.

**Recursive pivot & auto-expand.** Select any discovered node (an email, an alias, a platform) — the inspector offers **⌖ PIVOT** (rescan that identifier and merge the new hop into the same board, linked to the node you pivoted from) and **⇲ AUTO-EXPAND · 2 hops** (automatically pivots on the newly-discovered emails/aliases for two hops, capped at ~40 new nodes, deduping visited identifiers). One seed grows outward into a real constellation, under your control. A pivoted account that's genuinely the same as one already on the board reuses its node; a different person's same-platform account is namespaced so it never collides.

**Closing the manual loop.** When a manual pivot surfaces a finding, add it to the board: `+ result` on an installed pivot (or the `+ NODE` button) opens a small form (platform, handle, url) and drops a new body into the live orbit, tied to the seed and marked "added manually — to confirm". It then behaves like any other node (confirm / review / reject, save with the case). So a manual tool's output re-enters the same correlated view instead of living in a separate tab.

## Real-person sources (where free OSINT usually fails)

Dev-platform APIs return nothing on an ordinary person. Two free, high-signal sources close that gap:

- **Hudson Rock (infostealer)** — is the email/username in infostealer logs, and **which services did the victim log into** (Instagram, PayPal…)? That surfaces real accounts we could never scan directly. Free, defensive; credentials are never shown. On by default.
- **Holehe (email → accounts)** — via the [worker](collector/), checks 120+ mainstream sites for an account tied to the email, silently. This is the real answer to "email → where is this person".

## Honest scoring — tiers, not a fake %

A "68% match" nobody calibrated is worthless. Every node gets a **qualitative tier** derived from its evidence classes (hard / soft / weak) plus a **corroboration count**:

- **VERIFIED** — at least one *hard* cross-signal (matching avatar pHash, declared+verified linked account, PGP, breach).
- **PROBABLE** — several corroborating *soft* signals.
- **POSSIBLE** — a single soft signal.
- **WEAK** — existence-only / inferred / derived (e.g. a WhatsMyName URL-pattern hit).

A single weak signal can never masquerade as strong. The numeric confidence is shown but secondary — the tier is what you trust.

## Deep scan (async jobs)

Long collectors (SpiderFoot, deep Maigret, Holehe) can't run inside a serverless timeout, so the [worker](collector/) runs them as **background jobs**: **⛏ DEEP** starts a job for the seed (Maigret for a username, Holehe for an email, SpiderFoot for a domain), Octopus polls it, and merges the normalized result into the board when it finishes — with a live `running… Ns` readout. Needs the worker (`COLLECTOR_URL`); the fast built-in scan works without it.

## Three views

- **ORBIT** — the gravitational graph, for exploring and seeing the web of links.
- **TABLE** — a dense, sortable, filterable data table (tier · type · platform · handle · corroborating signals · status), for actually working the data.
- **TIMELINE** — the footprint over time (account creation, compromise dates), year by year.

## Intelligence layer — the DOSSIER

Finding nodes isn't the point; *identifying the person* is. The **DOSSIER** consolidates the whole correlated graph into one synthesized identity:

- **Likely name** (the most-corroborated display name across confirmed/high accounts), **emails**, **phones**, **locations** (from GitHub/Gravatar location fields + Maigret), **aliases**, **accounts** (confirmed first), and **leaks** (IntelX).
- An **identification confidence** score from cross-type corroboration (a name + an email + a phone + a location + confirmed accounts scores high).
- Pure & deterministic — it only consolidates **verified nodes**, it invents nothing (no unsourced LLM inference).

**⚡ INVESTIGATE** runs it end-to-end in one click: scan the seed → auto-expand one hop from a discovered identifier → open the synthesized dossier. **▤ DOSSIER** opens the synthesis for the current board at any time.

**Breach search (IntelX).** Set `INTELX_API_KEY` (freemium) on Vercel to enable the **Intelligence X** app — a scan then also searches leaks/pastes/darkweb for the identifier and adds ⚠ leak nodes (sensitive: use under a legal basis; credentials are never redistributed).

## Interface

One rule: the graph gets the screen, the tools get a place. Everything is reachable two ways — a **rail** on the left grouping tools by intent (Investigate, Enrich, Sources, Cases, Data, Configure), and a **command palette** (`⌘K` / `Ctrl K`) that searches every action in one list. `/` focuses the seed, `1-4` switch view, `Esc` closes. Light and dark are both first-class: the theme follows your system until you choose one, and the choice is resolved before first paint so there is no flash. The art direction is unchanged — void ground, one hairline, one accent, monospace, no fills, no icons that aren't geometry.

**Local corpora (data you hold).** **DATA → Local corpora** loads datasets you already have — a breach dump, a forum archive, an exported Telegram channel — and every scan then searches them **silently**: nothing leaves the machine, and no source is told you looked. The format is detected (plain lines, CSV/TSV with a header, JSON, JSONL), credentials are redacted at ingest, ingestion is chunked so a large file goes through, and rows are written in blocks rather than one statement each. Search an exact selector to attribute, or `@domain.com` to sweep a domain — a sweep returns records about **different people**, so it is shown as a lead list and never becomes a node. Corpora persist with `POSTGRES_URL`; without it they live in memory for the session, and the panel says so.

**Darkweb / .onion.** Every scan queries the onion search indexes reachable from the clearnet (Ahmia), so darkweb discovery works with nothing installed. Configure a **SOCKS5 proxy** (Tor: `socks5://127.0.0.1:9050`, or `docker compose --profile tor up`) in the API panel or `OCTOPUS_PROXY`, and the onion-only engines (Torch, Haystak) join in, Ahmia is reached through its onion mirror, and **TOOLS → Open hidden service** retrieves a specific `.onion` to harvest the emails, wallets, keys and handles published on it.

Three properties matter more than the coverage:

- **Only verbatim matches become nodes**, never above **WEAK**, each carrying an explicit "attribution not established" caveat. An index mention is not evidence that the person owns, runs or visited a service.
- **Coverage is stated, not implied.** The scan reports which engines answered and which were skipped for lack of Tor, so silence is never read as "nothing on the darkweb".
- **A `.onion` request without Tor is refused, not attempted** — the DNS lookup alone would hand your resolver the address. Likewise, if a proxy is configured and cannot be used, requests are **blocked** rather than quietly sent direct. Node's `fetch` cannot use a proxy at all, so Octopus speaks SOCKS5/HTTP-CONNECT over its own socket (`lib/socks.ts`, `lib/proxyfetch.ts`), always resolving hostnames **at the proxy**.

**Grounded LLM brief (optional).** In the dossier, **✦ SYNTHESIZE** produces a short intelligence brief from the evidence — provider-agnostic (OpenAI-compatible: Ollama, Groq, OpenRouter, Together…). Set `LLM_API_URL` (base, e.g. `http://host:11434/v1`), `LLM_MODEL`, and optionally `LLM_API_KEY`. The prompt enforces the anti-hallucination discipline (grounded to the collected evidence, every claim cited in `[brackets]`, doubt-biased, no invented facts) — see [`docs/llm-correlation.md`](docs/llm-correlation.md). Disabled gracefully when unset.

Every brief is then **verified deterministically** (no second LLM): each `[citation]` is checked against the real sources on the board, and any email / @alias / phone the brief states is checked against the evidence. The dossier shows a verdict — **✓ grounded** (all citations valid, no unsupported facts) or **⚠ warnings** listing the unknown citations and the facts *not in evidence*. So even if a model drifts, a hallucinated name-source or invented email is caught and shown, not trusted.

## Persistence

Investigations can be **saved and reloaded** (SAVE / CASES in the top bar). Storage is hybrid:

- **No config → browser (`localStorage`)**: zero setup, works on Vercel immediately. Single-browser.
- **With a Postgres/Neon URL → server-side**: durable, multi-device. Set one of `POSTGRES_URL` / `DATABASE_URL` / `NEON_DATABASE_URL` as a Vercel env var (e.g. create a free Neon database from the Vercel Marketplace and copy its connection string). The `octopus_cases` table is created automatically on first use. The CASES panel shows which backend is active (`stored: server` / `local`).

Cases can also be **exported and imported as JSON files** (EXPORT / IMPORT), independent of storage — the simplest way to move a case between machines or back it up.

## Art direction

Purist, minimal, spare. A void, hairline rings, monospace as the hero face (a scientific instrument), **a single accent** (desaturated cyan). Confidence is encoded by **distance and brightness**, not loud colors. Negative space is part of the design.

## LLM correlation — no hallucination

The LLM **assists, it does not decide, and it never invents**. The correlation score aggregates only **evidence tied to a verifiable source** (avatar pHash, observed cross-link, PGP key, commit email…). Every evidence item carries its provenance and weight. No unsourced assertion is produced. The human decides (confirm / review / reject) — never a silent automatic merge on a person. Details in [`docs/llm-correlation.md`](docs/llm-correlation.md).

## Roadmap (summary)

1. **Done** — Orbit view, live username/email scan (13 APIs + WhatsMyName + pHash + linked-account web), local persistence, reference architecture, tools research.
2. Server-side persistence (hosted DB) + shared investigations.
3. Matching engine hardening (Splink + embeddings) + triage queue.
4. Grounded LLM layer (extraction, tie-break, summary).
5. Auth, audit, GDPR compliance, multi-tenant.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/osint-tools-research.md`](docs/osint-tools-research.md).

## Legal note

Intended for **legitimate** OSINT investigation (threat intel, due diligence, brand protection, journalism). Processing personal data → GDPR by design (legal basis, minimization, limited retention, audit, data-subject rights). Source ToS respected; sources with restrictive ToS are excluded or clearly labeled.

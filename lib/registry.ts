// App registry — the catalogue shown in the APPS panel.
//  - "builtin" apps are real connectors/engine stages: toggling them changes what
//    the scan runs and correlates (enable more → richer, cross-linked results).
//  - "manual" apps are cipher387-style external tools: "Add" installs them, then
//    they open pre-filled with the current seed (analyst pastes findings back).

export type AppInput = "username" | "email" | "both" | "image" | "phone" | "domain" | "name";
export type AppStatus = "free" | "freemium" | "paid";

export interface AppDef {
  id: string;
  name: string;
  category: string;
  kind: "builtin" | "manual";
  input: AppInput;
  status: AppStatus;
  /** manual apps: URL with {seed} substituted at open time */
  url?: string;
  desc: string;
}

// Built-in connectors + engine stages (ids match the scan pipeline).
export const BUILTIN_APPS: AppDef[] = [
  { id: "github", name: "GitHub", category: "Dev", kind: "builtin", input: "username", status: "free", desc: "Public profile, name, bio, avatar." },
  { id: "gitlab", name: "GitLab", category: "Dev", kind: "builtin", input: "username", status: "free", desc: "Public user profile." },
  { id: "npm", name: "npm", category: "Dev", kind: "builtin", input: "username", status: "free", desc: "Registry user." },
  { id: "dockerhub", name: "Docker Hub", category: "Dev", kind: "builtin", input: "username", status: "free", desc: "Public user." },
  { id: "codeforces", name: "Codeforces", category: "Dev", kind: "builtin", input: "username", status: "free", desc: "Competitive-programming profile." },
  { id: "reddit", name: "Reddit", category: "Social", kind: "builtin", input: "username", status: "free", desc: "Public about.json." },
  { id: "bluesky", name: "Bluesky", category: "Social", kind: "builtin", input: "username", status: "free", desc: "Public AppView profile." },
  { id: "mastodon", name: "Mastodon", category: "Social", kind: "builtin", input: "username", status: "free", desc: "mastodon.social lookup." },
  { id: "hn", name: "Hacker News", category: "Social", kind: "builtin", input: "username", status: "free", desc: "Public user + karma." },
  { id: "keybase", name: "Keybase", category: "Identity", kind: "builtin", input: "username", status: "free", desc: "Cryptographically-verified linked accounts." },
  { id: "gravatar", name: "Gravatar", category: "Identity", kind: "builtin", input: "both", status: "free", desc: "Profile + declared linked accounts." },
  { id: "chesscom", name: "Chess.com", category: "Games", kind: "builtin", input: "username", status: "free", desc: "Public player profile." },
  { id: "wikipedia", name: "Wikipedia", category: "Reference", kind: "builtin", input: "username", status: "free", desc: "User existence + edit count." },
  { id: "steam", name: "Steam", category: "Social", kind: "builtin", input: "username", status: "free", desc: "Public community profile — often exposes REAL NAME, location and avatar." },
  { id: "telegram", name: "Telegram", category: "Social", kind: "builtin", input: "username", status: "free", desc: "Public t.me page — display name, bio, avatar." },
  { id: "linktree", name: "Linktree", category: "Social", kind: "builtin", input: "username", status: "free", desc: "Link-in-bio page — lists every account the person links to. A pivot goldmine." },
  { id: "soundcloud", name: "SoundCloud", category: "Social", kind: "builtin", input: "username", status: "free", desc: "Public profile — name, bio, avatar." },
  { id: "pinterest", name: "Pinterest", category: "Social", kind: "builtin", input: "username", status: "free", desc: "Public profile page." },
  { id: "spotify", name: "Spotify", category: "Social", kind: "builtin", input: "username", status: "free", desc: "Public user page — display name." },
  { id: "behance", name: "Behance", category: "Creative", kind: "builtin", input: "username", status: "free", desc: "Portfolio profile — name, bio, avatar." },
  { id: "deviantart", name: "DeviantArt", category: "Creative", kind: "builtin", input: "username", status: "free", desc: "Public artist profile." },
  { id: "letterboxd", name: "Letterboxd", category: "Social", kind: "builtin", input: "username", status: "free", desc: "Film profile — name, bio, avatar." },
  { id: "patreon", name: "Patreon", category: "Social", kind: "builtin", input: "username", status: "free", desc: "Creator page — name, description." },
  { id: "kofi", name: "Ko-fi", category: "Social", kind: "builtin", input: "username", status: "free", desc: "Creator page — name, description." },
  { id: "lichess", name: "Lichess", category: "Games", kind: "builtin", input: "username", status: "free", desc: "Open API — bio, country, first/last name and declared links." },
  { id: "roblox", name: "Roblox", category: "Games", kind: "builtin", input: "username", status: "free", desc: "Open API — display name (very large young user base)." },
  { id: "whatsmyname", name: "WhatsMyName", category: "Coverage", kind: "builtin", input: "username", status: "free", desc: "600+ sites by URL pattern (unverified layer)." },
  { id: "maigret", name: "Maigret (deep)", category: "Coverage", kind: "builtin", input: "username", status: "free", desc: "3000+ sites WITH profile data + identifier discovery. Needs the collector worker (COLLECTOR_URL)." },
  { id: "holehe", name: "Holehe (email)", category: "Coverage", kind: "builtin", input: "email", status: "free", desc: "Email → accounts on 120+ mainstream sites (Insta, Spotify…), no alert. Needs the collector worker." },
  { id: "hudsonrock", name: "Hudson Rock", category: "Leaks", kind: "builtin", input: "both", status: "free", desc: "Infostealer intel (free): is the email/username compromised + which services it logged into. Defensive." },
  { id: "intelx", name: "Intelligence X", category: "Leaks", kind: "builtin", input: "both", status: "freemium", desc: "Breaches / pastes / darkweb. Needs INTELX_API_KEY. Sensitive — legal basis required." },
  { id: "recordedfuture", name: "Recorded Future", category: "Leaks", kind: "builtin", input: "both", status: "paid", desc: "BONUS (enterprise): credential exposure + risk. Off unless RECORDED_FUTURE_API_KEY is set — never a base source. Legal basis required." },
  { id: "phash", name: "Avatar pHash", category: "Correlation", kind: "builtin", input: "image", status: "free", desc: "Links accounts by matching profile photos." },
  { id: "network", name: "Network graph", category: "Correlation", kind: "builtin", input: "username", status: "free", desc: "GitHub followers / following / orgs → related people + activity-based timezone." },
  { id: "geo", name: "Geo resolve", category: "Correlation", kind: "builtin", input: "both", status: "free", desc: "Geocode locations (Nominatim) + reward locations several sources agree on. Powers the map." },
  { id: "variants", name: "Handle variants", category: "Coverage", kind: "builtin", input: "username", status: "free", desc: "Also search plausible variants of the handle (separators, initials, trailing digits). Hits are scored strictly weaker than the exact match — the link stays unproven until corroborated." },
  { id: "corpus", name: "Local corpora", category: "Leaks", kind: "builtin", input: "both", status: "free", desc: "Silent search of datasets you already hold (breach dumps, archives). Nothing leaves the machine and the source is never told you looked. Credentials are redacted at ingest." },
  { id: "darkweb", name: "Darkweb / .onion", category: "Leaks", kind: "builtin", input: "both", status: "free", desc: "Onion indexes (Ahmia clearnet; Torch/Haystak when a Tor SOCKS5 proxy is set in the API panel). Only verbatim matches become nodes, never above WEAK — an index mention is not attribution. A .onion request without Tor is refused, not attempted." },
  { id: "domain", name: "Domain / infra", category: "Infrastructure", kind: "builtin", input: "domain", status: "free", desc: "Domain enrichment (RDAP registrant, DNS, subdomains via crt.sh, hosting geo) that feeds the identity graph. Also enriches a personal site found in a profile." },
];

// Curated cipher387-style manual pivots (open externally with the seed).
export const MANUAL_APPS: AppDef[] = [
  { id: "wmn-web", name: "WhatsMyName (web)", category: "Username", kind: "manual", input: "username", status: "free", url: "https://whatsmyname.app/?q={seed}", desc: "Web UI over the WhatsMyName ruleset." },
  { id: "instantusername", name: "Instant Username", category: "Username", kind: "manual", input: "username", status: "free", url: "https://instantusername.com/#/{seed}", desc: "Fast availability across many sites." },
  { id: "sherlock", name: "Sherlock", category: "Username", kind: "manual", input: "username", status: "free", url: "https://github.com/sherlock-project/sherlock", desc: "CLI username hunter (~400 sites)." },
  { id: "maigret", name: "Maigret", category: "Username", kind: "manual", input: "username", status: "free", url: "https://github.com/soxoj/maigret", desc: "CLI, ~2500 sites + profile data." },
  { id: "epieos", name: "Epieos", category: "Email", kind: "manual", input: "email", status: "freemium", url: "https://epieos.com/", desc: "Email/phone → Google account + services." },
  { id: "hibp", name: "Have I Been Pwned", category: "Email", kind: "manual", input: "email", status: "freemium", url: "https://haveibeenpwned.com/account/{seed}", desc: "Which breaches an email appears in." },
  { id: "emailrep", name: "EmailRep", category: "Email", kind: "manual", input: "email", status: "freemium", url: "https://emailrep.io/{seed}", desc: "Email reputation/risk score." },
  { id: "holehe", name: "holehe", category: "Email", kind: "manual", input: "email", status: "free", url: "https://github.com/megadose/holehe", desc: "Email → account existence on 120+ sites." },
  { id: "phoneinfoga", name: "PhoneInfoga", category: "Phone", kind: "manual", input: "phone", status: "free", url: "https://github.com/sundowndev/phoneinfoga", desc: "Phone recon (country, carrier, dorks)." },
  { id: "truecaller", name: "Truecaller", category: "Phone", kind: "manual", input: "phone", status: "freemium", url: "https://www.truecaller.com/search/global/{seed}", desc: "Reverse phone → name (GDPR-sensitive)." },
  { id: "epieos-phone", name: "Epieos (phone)", category: "Phone", kind: "manual", input: "phone", status: "freemium", url: "https://epieos.com/", desc: "Number → WhatsApp/Telegram/Facebook sign-ups." },
  { id: "numverify", name: "Numverify", category: "Phone", kind: "manual", input: "phone", status: "freemium", url: "https://numverify.com/", desc: "Validation + carrier/line-type API." },
  { id: "pimeyes", name: "PimEyes", category: "Face", kind: "manual", input: "image", status: "paid", url: "https://pimeyes.com/en", desc: "Reverse face search (biometric caveat)." },
  { id: "facecheck", name: "FaceCheck.id", category: "Face", kind: "manual", input: "image", status: "freemium", url: "https://facecheck.id/", desc: "Reverse face over social/news." },
  { id: "yandex-img", name: "Yandex Images", category: "Face", kind: "manual", input: "image", status: "free", url: "https://yandex.com/images/", desc: "Best free reverse-image for faces." },
  { id: "google-dork", name: "Google", category: "Name", kind: "manual", input: "name", status: "free", url: "https://www.google.com/search?q=%22{seed}%22", desc: "Exact-name web search (dork)." },
  { id: "linkedin", name: "LinkedIn", category: "Name", kind: "manual", input: "name", status: "freemium", url: "https://www.linkedin.com/search/results/people/?keywords={seed}", desc: "People search by name." },
  { id: "truepeoplesearch", name: "TruePeopleSearch", category: "Name", kind: "manual", input: "name", status: "free", url: "https://www.truepeoplesearch.com/results?name={seed}", desc: "US public-records people search." },
  { id: "shodan", name: "Shodan", category: "Infra", kind: "manual", input: "domain", status: "freemium", url: "https://www.shodan.io/search?query={seed}", desc: "Exposed devices/services search." },
  { id: "crtsh", name: "crt.sh", category: "Infra", kind: "manual", input: "domain", status: "free", url: "https://crt.sh/?q={seed}", desc: "Certificate transparency → subdomains." },
  { id: "intelx", name: "Intelligence X", category: "Leaks", kind: "manual", input: "both", status: "freemium", url: "https://intelx.io/?s={seed}", desc: "Leaks, pastes, darkweb, historical data." },
  { id: "ahmia", name: "Ahmia", category: "Leaks", kind: "manual", input: "both", status: "free", url: "https://ahmia.fi/search/?q={seed}", desc: "Onion-service search index, reachable from the clearnet." },
  { id: "onionsearch", name: "Tor Browser", category: "Leaks", kind: "manual", input: "both", status: "free", url: "https://www.torproject.org/download/", desc: "Needed to open .onion results by hand; also provides the SOCKS5 port Octopus uses." },
];

export const ALL_APPS: AppDef[] = [...BUILTIN_APPS, ...MANUAL_APPS];
export const BUILTIN_IDS = BUILTIN_APPS.map((a) => a.id);

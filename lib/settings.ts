// Client-side settings — API keys the analyst enters in the API panel, stored in the
// browser (localStorage) and sent to the server per request via the `x-octopus-cfg`
// header. Keys stay on the analyst's machine; nothing is persisted server-side. This
// lets a self-hosted deploy configure everything from the UI, no redeploy, while env
// vars still work in production.

export interface OctopusSettings {
  intelx?: string;
  intelxUrl?: string;
  recordedfuture?: string;
  collectorUrl?: string;
  collectorToken?: string;
  // --- paid breach providers: these return everything IN CLEAR ---
  /** "account-email:api-key" — Dehashed auth is HTTP basic */
  dehashed?: string;
  snusbase?: string;
  leakcheckPro?: string;
  hudsonrockPro?: string;
  llmUrl?: string;
  llmModel?: string;
  llmKey?: string;
  llmWeb?: boolean;
  // --- tradecraft ---
  /** OPSEC posture: direct | careful | no-touch */
  posture?: string;
  /** outbound proxy (http(s):// or socks5://, incl. Tor) */
  proxy?: string;
  /** case id — anchors the egress fingerprint so cases are not correlatable */
  caseId?: string;
  /** operator identity recorded in the audit trail */
  operator?: string;
  /** why this collection is lawful — recorded with every query */
  legalBasis?: string;
}

const KEY = "octopus:settings:v1";

export function loadSettings(): OctopusSettings {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(window.localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}

export function saveSettings(s: OctopusSettings): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota */ }
}

/** Server-shaped config object (matches lib/reqconfig.ClientConfig). */
export function toClientConfig(s: OctopusSettings) {
  return {
    intelx: s.intelx || undefined,
    intelxUrl: s.intelxUrl || undefined,
    recordedfuture: s.recordedfuture || undefined,
    collectorUrl: s.collectorUrl || undefined,
    collectorToken: s.collectorToken || undefined,
    dehashed: s.dehashed || undefined,
    snusbase: s.snusbase || undefined,
    leakcheckPro: s.leakcheckPro || undefined,
    hudsonrockPro: s.hudsonrockPro || undefined,
    llm: (s.llmUrl || s.llmModel || s.llmKey) ? { url: s.llmUrl, model: s.llmModel, key: s.llmKey, web: s.llmWeb } : undefined,
  };
}

function b64(str: string): string {
  if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(str)));
  return Buffer.from(str, "utf8").toString("base64");
}

/** Headers to attach to any fetch that should honour the analyst's saved keys. */
export function cfgHeaders(): Record<string, string> {
  const cfg = toClientConfig(loadSettings());
  try { return { "x-octopus-cfg": b64(JSON.stringify(cfg)) }; } catch { return {}; }
}

/** Headers carrying OPSEC posture and audit identity for every collection request. */
export function tradecraftHeaders(): Record<string, string> {
  const s = loadSettings();
  const h: Record<string, string> = {};
  if (s.posture) h["x-octopus-posture"] = s.posture;
  if (s.proxy) h["x-octopus-proxy"] = s.proxy;
  if (s.caseId) h["x-octopus-case"] = s.caseId;
  if (s.operator) h["x-octopus-operator"] = s.operator;
  if (s.legalBasis) h["x-octopus-legal-basis"] = s.legalBasis;
  return h;
}

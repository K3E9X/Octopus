// Per-request config from the operator's browser.
//
// The client sends its LeakOSINT token (entered in the UI, kept in localStorage) as a
// base64-encoded JSON blob in the `x-octopus-cfg` header; server routes read it and use
// it to OVERRIDE the environment. That is what lets a self-hosted instance change its
// token without a redeploy, while a hosted deployment still runs purely on env vars.
//
// Keys are never logged and never persisted server-side. They exist for the duration of
// the request that carried them.

import type { NextRequest } from "next/server";

export interface ClientConfig {
  /** LeakOSINT token, the only credential the product needs */
  leakosint?: string;
  /** rows per query, 100–10000; raises both the result count and the price */
  leakosintLimit?: number;
  /** report language passed through to the API (en, ru, …) */
  leakosintLang?: string;
}

export function readClientConfig(req: NextRequest): ClientConfig {
  try {
    const raw = req.headers.get("x-octopus-cfg");
    if (!raw) return {};
    const json = typeof atob === "function" ? atob(raw) : Buffer.from(raw, "base64").toString("utf8");
    const o = JSON.parse(json);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

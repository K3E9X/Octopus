// Per-request config from the API panel. The client sends its keys (from the browser)
// as a base64-encoded JSON blob in the `x-octopus-cfg` header; server routes read it and
// use it to OVERRIDE env vars. This lets keys live in the UI (self-host, no redeploy)
// while env vars still work in production. Keys are never logged or persisted server-side.

import type { NextRequest } from "next/server";
import type { LLMConfig } from "./llmconfig";

export interface ClientConfig {
  intelx?: string;
  intelxUrl?: string;
  recordedfuture?: string;
  collectorUrl?: string;
  collectorToken?: string;
  dehashed?: string;
  snusbase?: string;
  leakcheckPro?: string;
  hudsonrockPro?: string;
  llm?: Partial<LLMConfig>;
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

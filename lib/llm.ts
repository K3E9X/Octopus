// Grounded LLM synthesis — narrates the dossier from the collected evidence ONLY.
// Provider-agnostic (OpenAI-compatible chat API): works with Ollama, Groq, OpenRouter,
// Together, OpenAI… Set LLM_API_URL (base, e.g. http://host:11434/v1), LLM_MODEL, and
// optionally LLM_API_KEY. Disabled (graceful) when not configured.
//
// Anti-hallucination is enforced by prompt discipline (grounding + mandatory citation +
// doubt bias). See docs/llm-correlation.md for the full architecture.

import type { Dossier } from "./dossier";
import { resolveLLM, llmChat, type LLMConfig } from "./llmconfig";

const SYSTEM = [
  "You are an OSINT analyst assistant. You summarize ONLY the evidence provided about a subject.",
  "Rules, strictly:",
  "1. Every factual claim MUST cite a source in brackets, e.g. [GitHub], [entity extraction], [libphonenumber].",
  "2. If the evidence is thin, partial, or contradictory, say so explicitly.",
  "3. NEVER invent names, accounts, emails, locations, phone numbers, or links that are not in the evidence.",
  "4. Prefer 'not established' over guessing. Do not speculate beyond the evidence.",
  "Output: a 4-6 sentence intelligence brief, then a line 'Uncertainties:' followed by short bullets.",
].join("\n");

export async function synthesize(dossier: Dossier, evidenceLines: string[], override?: Partial<LLMConfig>): Promise<string | null> {
  const cfg = resolveLLM(override);
  if (!cfg.enabled) return null;
  const user =
    "SUBJECT DOSSIER (consolidated from verified nodes only):\n" +
    JSON.stringify(dossier, null, 1) +
    "\n\nRAW EVIDENCE (each line: [source] name: detail):\n" +
    evidenceLines.slice(0, 60).join("\n");
  return llmChat(cfg, [{ role: "system", content: SYSTEM }, { role: "user", content: user }], { temperature: 0.2, maxTokens: 700 });
}

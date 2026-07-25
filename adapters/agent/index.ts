/**
 * Agent-harness registry.
 *
 * opencode is implemented. The rest are deliberate stubs: they exist so the
 * harness axis (§8 — "opencode vs pi vs little-coder on identical tasks and
 * models") is an adapter addition rather than a redesign, and so a run that names
 * one fails immediately with a reason instead of half-working.
 *
 * To implement one, replace the `stubAdapter` call with an `AgentAdapter` that
 * satisfies `adapters/agent/common.ts`. The contract in one line: never throw,
 * always report tokens, honour `timeoutMs`.
 */

import { stubAdapter, type AgentAdapter } from "./common.ts";
import { opencodeAdapter } from "./opencode.ts";

export * from "./common.ts";

/** STUB. `pi` is a local agent CLI; invocation and token reporting unverified. */
export const piAdapter: AgentAdapter = stubAdapter(
  "pi",
  "invocation not wired up yet — needs the argv form and where it reports token usage",
);

/** STUB. `little-coder` — same. */
export const littleCoderAdapter: AgentAdapter = stubAdapter(
  "little-coder",
  "invocation not wired up yet — needs the argv form and where it reports token usage",
);

/**
 * STUB. Raw `ollama` is not an agent harness: it has no tool loop, so the
 * adapter also has to extract the solution from a code fence and write the file
 * itself. That is a deliberate difference in the harness axis, not an oversight,
 * and it needs its own decision about how much scaffolding is fair.
 */
export const ollamaAdapter: AgentAdapter = stubAdapter(
  "ollama",
  "no tool loop: needs a code-fence extractor and a decision on how much scaffolding is fair",
);

export const AGENTS: Record<string, AgentAdapter> = {
  [opencodeAdapter.id]: opencodeAdapter,
  [piAdapter.id]: piAdapter,
  [littleCoderAdapter.id]: littleCoderAdapter,
  [ollamaAdapter.id]: ollamaAdapter,
};

export function agentFor(id: string): AgentAdapter {
  const a = AGENTS[id];
  if (!a) throw new Error(`unknown agent harness '${id}' (have: ${Object.keys(AGENTS).join(", ")})`);
  return a;
}

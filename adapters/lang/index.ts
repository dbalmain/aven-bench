/**
 * Language adapter registry. Aven, Python and Ruby are implemented; Lua and Wren
 * drop in by satisfying `LangAdapter` and registering here.
 */

import type { LangAdapter } from "./common.ts";
import { avenAdapter } from "./aven.ts";
import { pythonAdapter } from "./python.ts";
import { rubyAdapter } from "./ruby.ts";

export * from "./common.ts";

export const ADAPTERS: Record<string, LangAdapter> = {
  [avenAdapter.id]: avenAdapter,
  [pythonAdapter.id]: pythonAdapter,
  [rubyAdapter.id]: rubyAdapter,
};

export function adapterFor(id: string): LangAdapter {
  const a = ADAPTERS[id];
  if (!a) throw new Error(`unknown language '${id}' (have: ${Object.keys(ADAPTERS).join(", ")})`);
  return a;
}

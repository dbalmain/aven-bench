# The local-model arm (ollama)

**No ollama-specific agent adapter exists, and none is needed.** The stub that
used to sit here assumed a local model could not drive a tool loop. That premise
was wrong: opencode talks to ollama through an OpenAI-compatible provider, so
local models arrive as ordinary `ollama/<model>` model ids and flow through
`opencode.ts` unchanged — same session resume, same `step_finish` token
accounting, same survey turn.

What follows is the setup, and the measurements that justify each choice.

## Verified

- **The tool loop works.** A `two-fer` run wrote a correct `solution.py` using
  the `write` tool and finished `reason: "stop"` in two steps.
- **The sandbox reaches the host daemon.** `runner/sandbox.ts` passes
  `--unshare-all --share-net`, so the sandbox shares the host network namespace
  and `localhost:11434` inside it is the host's ollama. Confirmed by running
  `curl http://localhost:11434/api/tags` under the same bwrap flags: HTTP 200.
- **Cost is structurally zero.** `runner/prices.ts` prices any `ollama/*` model
  at zero via `isLocalModel` rather than a table entry, because local inference
  has no marginal token price. The real cost of this arm is wall clock, which
  `wallMs` already records.

## Context size is the thing that will bite

The first attempt failed with `reason: "length"` at `input: 4095, output: 1`.
Ollama's default `num_ctx` is 4096, and opencode's scaffolding alone does not
fit in it.

Measured on a trivial one-line task: **8804 input tokens** before the task
prompt contributes anything. That is all system prompt and tool schemas. A real
corpus prompt, plus a language skill doc, plus two or three accumulating repair
rounds, plausibly reaches 20–30k — so 32k is far tighter than it looks, and
overflow presents as a `length` failure that is easy to misread as the model
failing the task.

Two derived models exist, since `num_ctx` is a load-time parameter:

```sh
printf 'FROM qwen3.6:35b-a3b\nPARAMETER num_ctx 32768\n' > Modelfile.32k
ollama create qwen3.6-32k -f Modelfile.32k
```

`qwen3.6-64k` is built the same way with `65536`. Deriving is a manifest-only
operation — it reuses the parent's weight blobs, costs no disk and takes ~0.1s.

**Prefer `qwen3.6-64k`.** Its memory headroom is the open question: the parent
is ~24GB resident at 32k, and this machine has ~31GB available, so 64k should
fit but **has not been tested under load**. If it thrashes, fall back to 32k and
treat any `length` failure as a harness error rather than a model verdict.

## The one manual step

Add this to `~/.config/opencode/opencode.jsonc`, merging with what is already
there:

```jsonc
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": {
        "qwen3.6-64k": { "name": "qwen3.6 35b-a3b, 64k ctx (local)" },
        "qwen3.6-32k": { "name": "qwen3.6 35b-a3b, 32k ctx (local)" },
      },
    },
  },
}
```

This block is proven — it is what the successful end-to-end test ran under, from
a scratch config directory.

It is deliberately **not** applied to the real config yet. That file is read by
every `opencode` invocation, including the ones a running sweep is making, and
adding a provider whose npm package is not yet installed can trigger an install
on next launch. Applying it mid-sweep risks a multi-hour run for no gain, so it
waits for an idle machine.

## Do not run this arm concurrently with a remote-model sweep

The model is ~24GB resident and CPU-only at 100% across cores. A remote-model
sweep is mostly network-bound, but its gates are local, so ollama contention
inflates `gateWallMs` on the _other_ arm — quietly corrupting the latency axis
for both. Run the local arm alone.

Warm inference on the trivial task was 16.3s; cold start ran to ~4 minutes,
dominated by repacking 23GB. Budget accordingly: this is the "overnight low-n
queue" the plan describes, not something to sweep 71 tasks with at n=3.

# Results — model A/B (`model-03`), Qwen 3.7 Plus at n = 1

Pre-registration: `analysis/prereg-model-03.md`, committed `41254c4` before any
arm-B row existed, together with the `--min-samples` change the analysis needs.

Arms:

| Arm | Model                           | Run                       | Samples |
| --- | ------------------------------- | ------------------------- | ------- |
| A   | `opencode-go/deepseek-v4-flash` | `phase4-diagfmt-text-01`  | 3       |
| B   | `opencode-go/qwen3.7-plus`      | `phase5-model-qwen37p-01` | **1**   |

Reproduce with:

```sh
bun run analysis/model-ab.ts --arm-b phase5-model-qwen37p-01 \
  --model opencode-go/qwen3.7-plus --min-samples 1
```

## Headline

**DeepSeek V4 Flash beats Qwen 3.7 Plus on both dependent variables, and Qwen
costs 3.9× more per working solution.**

|                        | arm A (DeepSeek) | arm B (Qwen 3.7 Plus) | diff     |      p | verdict        |
| ---------------------- | ---------------- | --------------------- | -------- | -----: | -------------- |
| green rate (primary)   | **85.9%**        | 74.6%                 | −11.3 pp | 0.0098 | `arm-a-better` |
| censored repair rounds | **1.127**        | 1.563                 | +0.437   | 0.0005 | `arm-a-better` |
| first-shot pass        | **49.8%**        | 39.4%                 | −10.4 pp | 0.1322 | descriptive    |

### The n = 1 power caveat does not bite here

`prereg-model-03` fixed in advance that at 1 sample per task a `no-difference`
or `below-effect-bar` result would carry **no** information — it would be
consistent with both a genuine tie and a real gap the design was too small to
resolve. Only a directional verdict would mean anything.

**Both DVs came back directional**, and the primary cleared the 10.0 pp bar with
1.3 pp to spare. So the weakened design produced an interpretable result after
all: the gap was large enough to survive the noise, exactly as the prereg
predicted a MiMo-sized effect would. Nothing here needs the caveat applied.

Note the contrast with round 2, which is instructive. Hy3's 9.9 pp gap at n = 2
returned `below-effect-bar`; Qwen's 11.3 pp gap at n = 1 returned
`arm-a-better`. The bar, not the sample size, is what separates them.

## All 71 tasks paired

Arm B produced 2 `harness_error` rows, both `agent-no-tokens` (`alphametics`,
`pov`) — the provider returning nothing at all. At n = 1 each would have removed
its task from the comparison outright, with no second sample to fall back on.

The preregistered retry pass recovered both as real observations (`alphametics`
→ `timeout` $0.1472, `pov` → `runtime_error` $0.1611). **Zero tasks dropped;
71/71 paired.**

This is the third consecutive round where the retry procedure absorbed a loss
that would otherwise have silently changed which tasks the arms were compared
on, and the round where it mattered most.

## Cost — the real story

Post-dedup, harness errors excluded, all four models on the same 71-task
holdout:

| model             |   n |  pass |  spend |   $/attempt | $/green solution | agent time |
| ----------------- | --: | ----: | -----: | ----------: | ---------------: | ---------: |
| DeepSeek V4 Flash | 209 | 86.6% | $3.626 |     $0.0174 |      **$0.0200** |      25.2h |
| MiMo-V2.5         | 142 | 62.7% | $2.482 |     $0.0175 |          $0.0279 |      21.2h |
| Hy3               | 142 | 76.1% | $3.023 |     $0.0213 |          $0.0280 |      10.6h |
| Qwen 3.7 Plus     |  71 | 74.6% | $4.156 | **$0.0585** |      **$0.0784** |   **8.6h** |

Qwen 3.7 Plus is **3.4× the per-attempt cost** of DeepSeek and **3.9× the cost
per working solution**, while solving fewer tasks. It is the worst
value-for-money model measured so far by a wide margin, and it breaks the
pattern `cost-drivers.md` established — that per-attempt price is nearly flat
across models and the pass rate is what moves cost. Qwen's price is not flat; it
is 3× everyone else's, and no pass-rate advantage offsets it.

It is, however, the **fastest** arm measured: 8.6h against DeepSeek's 25.2h for
a third of the attempts, continuing the pattern Hy3 started.

## Ranking after three rounds

Against the common DeepSeek baseline:

**DeepSeek V4 Flash > Hy3 ≈ Qwen 3.7 Plus > MiMo-V2.5**

Hy3 (76.1%) and Qwen (74.6%) are within 1.5 pp of each other and were never
compared directly, so the `≈` is doing real work — that ordering is not
established. On cost the two are not close at all: Hy3 delivers effectively the
same green rate for 36% of the price per solution.

DeepSeek remains the model to spend sweep budget on, now against three
challengers.

## Probe calibration — the correction runs both ways

`cost-drivers.md` measured probes **understating** by 2.4× (Hy3: $0.0079 quoted,
$0.0193 realised) and `prereg-model-02` applied that as a padding multiplier.
This round ran the experiment on the multiplier itself:

|            |  quoted | realised |          error |
| ---------- | ------: | -------: | -------------: |
| Hy3 probe  | $0.0079 |  $0.0193 | 2.4× **under** |
| Qwen probe | $0.1039 |  $0.0585 |  1.8× **over** |

The bias direction tracks whether the probe's own failure rate lands above or
below the corpus base rate (~25%). Hy3's probe drew 3 passes and understated;
Qwen's drew 2 failures in 3 and overstated. **A 3-task probe is high-variance in
both directions, so a fixed multiplier is the wrong correction.**

This has a concrete consequence for the decision made in `prereg-model-02`. The
gate refused an n = 2 Qwen arm on a projection of $14.75 unadjusted / $35.40
padded. The true n = 2 cost would have been about **$8.3**. The refusal was
still correct — $8.3 is well past the $4.50 threshold — but the figure escalated
was roughly double the truth, and had the threshold been $8 rather than $4.50
that error would have flipped the decision. Future gates should quote a range
from the corpus mean in `cost-drivers.md`, not a padded point estimate from
three tasks.

## Threats to validity

Unchanged and still live: **non-concurrent arms** (arm A ran 2026-08-02, arm B
2026-08-05), **binary hash differing at an identical source commit**, and a
**pinned compiler now materially behind HEAD** — `8ca8620` predates both the
`Bool` exhaustiveness fix (`2e37df6`) and the bare-match-arm diagnostic
(`843af8a`). The absolute green rates here describe a compiler we no longer ship
and must not be quoted as current Aven capability.

The n = 1 power limitation is discharged above rather than dismissed: it would
have mattered had the result been null, and it did not.

## Known cosmetic defect

`formatModelReport` hard-codes `Pre-registration: analysis/prereg-model-01.md`
in its header, so the generated report for this round names the wrong prereg
file. The number in this document is the correct one (`prereg-model-03.md`).
Worth fixing when the analysis code is next touched; not fixed here because a
concurrent agent held the repo.

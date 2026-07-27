/**
 * Detecting attempts that fetched the answer instead of writing it.
 *
 * Every task in the corpus is derived from a public Exercism exercise, so the
 * canonical test suite and a worked example are both a `curl` away. The
 * bubblewrap sandbox does not stop this and cannot: it runs with `--share-net`
 * because the agent has to reach its provider API, so it is a filesystem
 * boundary only. `suiteVisibility: "hidden"` therefore means *hidden locally*,
 * not unavailable — a distinction that went unnoticed until a passing row was
 * found with the upstream `affine_cipher_test.py` quoted verbatim in its log.
 *
 * Why this matters more than an ordinary defect: Aven has no upstream tests to
 * fetch, so contamination can only ever inflate the **control** arm. Since every
 * headline number is `aven_pass_rate − baseline_pass_rate`, an undetected fetch
 * manufactures an Aven gap out of a baseline advantage.
 *
 * ## Why this does not match on hostnames
 *
 * The obvious detector — "does the log mention exercism.org or github.com" —
 * fires on almost every attempt, because the *prompt itself* carries upstream
 * attribution inherited from the exercise text:
 *
 *   - `https://assets.exercism.org/images/exercises/darts/...svg` (an image in
 *     the problem statement)
 *   - `https://exercism.org/profiles/habere-et-dispertire` (a contributor credit)
 *   - `exercism/problem-specifications` (a provenance line)
 *
 * The harness writes the prompt into the log, so a host match would flag the
 * harness's own text as model misconduct. Instead this matches **paths that can
 * only lead to a suite or a solution**, none of which appear in any attribution
 * footer, plus a couple of content signatures for the case where a model prints
 * fetched text without echoing the URL.
 *
 * ## Why the tiers exist
 *
 * The zero-token lesson applies directly: an over-broad exclusion rule shrinks
 * the denominator and silently inflates every rate it leaves behind. So only
 * `suite` and `solution` hits — where the fetched thing *is* the answer — mark a
 * row excluded. A bare `lookup` (browsing the exercise page, listing a repo
 * tree) is recorded for triage but left in the measurement, because reading a
 * problem description the model was already given is not cheating.
 */

/**
 * Hosts serving the *source repositories* — where a path names a directory, that
 * directory holds the tests and the worked answer.
 */
const REPO_HOSTS = ["raw.githubusercontent.com", "api.github.com", "github.com", "githubusercontent.com"];

/**
 * The website. It publishes the problem *description* — which the model was
 * already given — so the same path shape means something much weaker here than
 * on a repo host. `exercism.org/tracks/python/exercises/darts` is a rendered
 * exercise page; `github.com/exercism/python/.../exercises/practice/darts` is a
 * folder containing `darts_test.py`.
 */
const SITE_HOSTS = ["exercism.org", "exercism.io"];

const UPSTREAM_HOSTS = [...REPO_HOSTS, ...SITE_HOSTS];

/**
 * Severity of what an attempt reached for.
 *
 * `suite` and `solution` are disqualifying; `lookup` is advisory. Ordered
 * most-severe first so `worstTier` can scan.
 */
export type ContaminationTier = "suite" | "solution" | "lookup";

export type ContaminationHit = {
  tier: ContaminationTier;
  /** Why this fired, as a stable slug — queryable without prose matching. */
  rule: string;
  /** Bounded excerpt around the match, for human triage. */
  evidence: string;
};

type Rule = {
  tier: ContaminationTier;
  rule: string;
  pattern: RegExp;
  /**
   * Hosts that must appear near the match for it to count. Empty means the
   * pattern is self-evidencing.
   *
   * Two jobs. It keeps generic filenames from firing on the model's own local
   * scratch files, and it separates repo paths from site paths: the same
   * `/exercises/<task>/` shape is a folder holding the answer on GitHub and a
   * rendered description page on exercism.org.
   */
  hosts: readonly string[];
};

/**
 * Ordered most-severe first. Every pattern is deliberately narrow: it should be
 * possible to state, for each one, the single upstream artifact it names.
 */
const RULES: Rule[] = [
  // The generated header Exercism puts at the top of every practice test file.
  // Present in fetched *content* even when the URL was never echoed.
  {
    tier: "suite",
    rule: "generated-test-header",
    pattern: /These tests are auto-generated with test data from/i,
    hosts: [],
  },
  // The canonical case data the suites are generated from — equivalent to the
  // suite for our purposes, since the harness generates from the same source.
  {
    tier: "suite",
    rule: "canonical-data",
    pattern: /canonical[-_]data\.json/i,
    hosts: UPSTREAM_HOSTS,
  },
  // An upstream track's test file: `.../exercises/practice/<task>/<task>_test.py`
  {
    tier: "suite",
    rule: "upstream-test-file",
    pattern: /\/[A-Za-z0-9_.-]*[_.]test[_.]?[A-Za-z0-9]*\.(?:py|rb|js|ts|exs?|rs)\b/i,
    hosts: REPO_HOSTS,
  },
  // The worked answer. Upstream calls it `.meta/example.py`; models guess
  // `exemplar` about as often, so both are named here.
  {
    tier: "solution",
    rule: "meta-example",
    pattern: /\.meta\/(?:example|exemplar|solution)[A-Za-z0-9_.-]*/i,
    hosts: [],
  },
  // A practice-exercise directory listing, which contains both of the above.
  {
    tier: "solution",
    rule: "upstream-exercise-dir",
    pattern: /\/exercises\/(?:practice\/)?[a-z0-9-]+\/?(?:["'\s)]|$)/i,
    hosts: REPO_HOSTS,
  },
  // Browsing for the task without confirmed suite/solution content.
  {
    tier: "lookup",
    rule: "exercism-track-page",
    pattern: /exercism\.(?:org|io)\/tracks\//i,
    hosts: [],
  },
  {
    tier: "lookup",
    rule: "github-api-exercism",
    pattern: /api\.github\.com\/repos\/exercism/i,
    hosts: [],
  },
];

/** Characters of context kept either side of a match. */
const EVIDENCE_RADIUS = 90;
/** Window in which a rule requiring a host will accept one. */
const HOST_WINDOW = 400;
/** Hits retained per attempt. Enough to triage, bounded so logs stay small. */
const MAX_HITS = 12;

function excerpt(text: string, at: number, len: number): string {
  const from = Math.max(0, at - EVIDENCE_RADIUS);
  const to = Math.min(text.length, at + len + EVIDENCE_RADIUS);
  return text.slice(from, to).replace(/\s+/g, " ").trim();
}

function hostNear(text: string, at: number, hosts: readonly string[]): boolean {
  const from = Math.max(0, at - HOST_WINDOW);
  const window = text.slice(from, at + HOST_WINDOW).toLowerCase();
  return hosts.some((h) => window.includes(h));
}

/**
 * Scan one attempt's harness log for evidence it fetched upstream material.
 *
 * Pass the log exactly as stored. `promptText`, when given, is subtracted from
 * consideration first: the harness writes the prompt into the log verbatim, and
 * the prompt legitimately carries Exercism attribution URLs, so anything found
 * only inside it is the harness's own text rather than the model's doing.
 */
export function detectContamination(log: string, promptText?: string): ContaminationHit[] {
  if (log === "") return [];
  // Blank the prompt rather than deleting it, so match offsets still line up
  // with the original text and `evidence` excerpts stay meaningful.
  const haystack =
    promptText && promptText.length > 0 && log.includes(promptText)
      ? log.replace(promptText, " ".repeat(promptText.length))
      : log;

  const hits: ContaminationHit[] = [];
  const seen = new Set<string>();
  for (const { tier, rule, pattern, hosts } of RULES) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const m of haystack.matchAll(re)) {
      const at = m.index ?? 0;
      if (hosts.length > 0 && !hostNear(haystack, at, hosts)) continue;
      const evidence = excerpt(haystack, at, m[0].length);
      // One hit per rule per distinct excerpt: a fetched file echoed three times
      // is one finding, not three.
      const key = `${rule}::${evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ tier, rule, evidence });
      if (hits.length >= MAX_HITS) return hits;
    }
  }
  return hits;
}

/** Most severe tier present, or null for a clean attempt. */
export function worstTier(hits: ContaminationHit[]): ContaminationTier | null {
  for (const tier of ["suite", "solution", "lookup"] as const) {
    if (hits.some((h) => h.tier === tier)) return tier;
  }
  return null;
}

/**
 * Whether these hits disqualify the row from measurement.
 *
 * Only a fetched suite or solution does. See the tier rationale at the top of
 * the file: excluding mere lookups would shrink the denominator on the strength
 * of a guess, which is the failure mode the zero-token rule was narrowed to
 * avoid.
 */
export function isDisqualifying(hits: ContaminationHit[]): boolean {
  const tier = worstTier(hits);
  return tier === "suite" || tier === "solution";
}

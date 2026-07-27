import { describe, expect, test } from "bun:test";
import {
  detectContamination,
  isDisqualifying,
  worstTier,
  type ContaminationHit,
} from "./contamination.ts";

const rules = (hits: ContaminationHit[]) => [...new Set(hits.map((h) => h.rule))].sort();

describe("upstream material is detected", () => {
  // Verbatim from the log of `python/affine-cipher`, `ling-3.0-flash-free`,
  // which passed. This is the case the detector exists for.
  test("fetched test file, quoted with its URL", () => {
    const log = `
      === https://raw.githubusercontent.com/exercism/python/main/exercises/practice/affine-cipher/affine_cipher_test.py ===
      # These tests are auto-generated with test data from:
      # https://github.com/exercism/problem-specifications/tree/main/exercises/affine-cipher/canonical-data.json
      def test_encode_yes(self): self.assertEqual(encode("yes", 5, 7), "xbt")
    `;
    const hits = detectContamination(log);
    expect(worstTier(hits)).toBe("suite");
    expect(isDisqualifying(hits)).toBe(true);
    expect(rules(hits)).toContain("generated-test-header");
    expect(rules(hits)).toContain("upstream-test-file");
  });

  test("the generated-test header alone is enough, with no URL echoed", () => {
    // A model that fetches into a variable and prints the body leaves no path
    // for the touched-path extractor, which is why content is matched too.
    const hits = detectContamination(
      "output: # These tests are auto-generated with test data from: ...\nimport unittest",
    );
    expect(worstTier(hits)).toBe("suite");
  });

  test("the worked answer counts as solution-tier", () => {
    const hits = detectContamination(
      "curl -s https://raw.githubusercontent.com/exercism/python/main/exercises/practice/etl/.meta/example.py",
    );
    expect(isDisqualifying(hits)).toBe(true);
    expect(rules(hits)).toContain("meta-example");
  });

  test("browsing the exercise page is recorded but not disqualifying", () => {
    // Reading a problem description the model was already handed is not
    // cheating, and excluding it would shrink the denominator on a guess.
    const hits = detectContamination("GET https://exercism.org/tracks/python/exercises/darts");
    expect(worstTier(hits)).toBe("lookup");
    expect(isDisqualifying(hits)).toBe(false);
  });
});

describe("our own attribution text is not contamination", () => {
  // Every one of these appears in real corpus prompts. A hostname-matching
  // detector fires on all of them, flagging the harness's own writing as model
  // misconduct — this is the class that dictated the design.
  const footers = [
    "![bullseye](https://assets.exercism.org/images/exercises/darts/darts-scoreboard.svg)",
    "Contributed by https://exercism.org/profiles/habere-et-dispertire",
    "Source: exercism/problem-specifications",
    "This exercise comes from the Exercism problem specifications repository.",
  ];

  for (const footer of footers) {
    test(`clean: ${footer.slice(0, 48)}…`, () => {
      expect(detectContamination(footer)).toEqual([]);
    });
  }

  test("a prompt echoed back in the log is subtracted", () => {
    // The harness writes the prompt into the log verbatim, so anything found
    // only inside it belongs to us, not the model.
    const prompt = "Solve darts. ![board](https://assets.exercism.org/images/exercises/darts/x.svg)";
    expect(detectContamination(`--- prompt ---\n${prompt}\n--- end ---`, prompt)).toEqual([]);
  });

  test("subtraction does not blind the detector to a real fetch elsewhere", () => {
    const prompt = "Solve etl. See https://exercism.org/profiles/someone";
    const log = `${prompt}\nthen: curl .../exercises/practice/etl/.meta/example.py`;
    expect(isDisqualifying(detectContamination(log, prompt))).toBe(true);
  });
});

describe("host-dependent rules stay local", () => {
  test("the model's own scratch test file does not fire", () => {
    // `upstream-test-file` needs a host nearby, or every attempt that writes a
    // local `foo_test.py` to try its work would be flagged.
    const hits = detectContamination("wrote ./my_solution_test.py and ran it");
    expect(hits).toEqual([]);
  });

  test("a clean attempt produces nothing", () => {
    const hits = detectContamination("def encode(text): return text.upper()\nAll 16 tests passed.");
    expect(hits).toEqual([]);
    expect(worstTier(hits)).toBeNull();
    expect(isDisqualifying(hits)).toBe(false);
  });

  test("an empty log is clean", () => {
    expect(detectContamination("")).toEqual([]);
  });
});

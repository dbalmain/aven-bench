import { describe, expect, test } from "bun:test";
import { countRuntimeInvocations, runtimeExecutables } from "./runtime.ts";

describe("runtimeExecutables", () => {
  test("names each control arm's interpreter and leaves Aven to avenBin", () => {
    expect(runtimeExecutables("python")).toEqual(["python3"]);
    expect(runtimeExecutables("ruby")).toEqual(["ruby"]);
    expect(runtimeExecutables("aven")).toEqual([]);
    expect(runtimeExecutables("pseudocode")).toEqual([]);
  });
});

describe("countRuntimeInvocations", () => {
  const python = (command: string): number => countRuntimeInvocations("python", command);

  test("counts the interpreter at a command head, however the shell phrases it", () => {
    for (const command of [
      "python3 solution.py",
      "python solution.py",
      "cd /tmp && python3 -m unittest",
      'bash -c "python3 solution.py"',
      "ls; python3 solution.py",
      "cat x | python3 -",
      "PYTHONPATH=. python3 solution.py",
      "/nix/store/abc-python3-3.12/bin/python3 solution.py",
      "./venv/bin/python3 solution.py",
      "echo a\npython3 solution.py",
    ]) {
      expect([command, python(command)]).toEqual([command, 1]);
    }
  });

  test("does not count the name as an argument or inside a longer word", () => {
    for (const command of [
      "ls python3-notes.txt",
      "cat notes-about-python.md",
      "grep python3 README.md",
      "rm pythonic.py",
    ]) {
      expect([command, python(command)]).toEqual([command, 0]);
    }
  });

  test("counts each occurrence in a chained command", () => {
    expect(python("python3 a.py && python3 b.py; python c.py")).toBe(3);
  });

  test("python3 is one invocation, not also a bare python", () => {
    expect(python("python3 x.py")).toBe(1);
  });

  test("is scoped to the arm's own runtime", () => {
    expect(countRuntimeInvocations("ruby", "ruby solution.rb")).toBe(1);
    expect(countRuntimeInvocations("ruby", "python3 solution.py")).toBe(0);
    expect(countRuntimeInvocations("python", "ruby solution.rb")).toBe(0);
    // The Aven arm counts `aven` runs from the session log instead.
    expect(countRuntimeInvocations("aven", "aven check solution.av")).toBe(0);
  });

  test("state does not leak between calls on the same cached pattern", () => {
    expect(python("python3 a.py")).toBe(1);
    expect(python("python3 a.py")).toBe(1);
  });
});

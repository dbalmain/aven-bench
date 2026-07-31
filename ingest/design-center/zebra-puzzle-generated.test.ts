import { describe, expect, test } from "bun:test";
import {
  generateZebraPuzzleTask,
  solvePositions,
  ZEBRA_PUZZLE_COUNT,
  ZEBRA_PUZZLE_SEED,
  type Category,
  type Constraint,
} from "./zebra-puzzle-generated.ts";

function argument<T>(
  taskCase: ReturnType<typeof generateZebraPuzzleTask>["task"]["cases"][number],
  name: string,
): T {
  const found = taskCase.args.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing argument ${name}`);
  return found.value as T;
}

describe("generated zebra puzzle", () => {
  test("is deterministic for its recorded seed", () => {
    const first = generateZebraPuzzleTask(ZEBRA_PUZZLE_SEED);
    const second = generateZebraPuzzleTask(ZEBRA_PUZZLE_SEED);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.task.generator?.seed).toBe(ZEBRA_PUZZLE_SEED);
    expect(first.task.cases).toHaveLength(ZEBRA_PUZZLE_COUNT);
  });

  test("matches the checked-in corpus byte for byte", async () => {
    const generated = generateZebraPuzzleTask();
    const directory = `${import.meta.dir}/../../corpus/zebra-puzzle-generated`;
    expect(await Bun.file(`${directory}/task.json`).text()).toBe(
      JSON.stringify(generated.task, null, 2) + "\n",
    );
    expect(await Bun.file(`${directory}/prompt.md`).text()).toBe(generated.prompt);
  });

  test("changes its corpus when the seed changes", () => {
    const first = generateZebraPuzzleTask(ZEBRA_PUZZLE_SEED, 1);
    const second = generateZebraPuzzleTask(ZEBRA_PUZZLE_SEED + 1, 1);
    expect(first.task.cases).not.toEqual(second.task.cases);
  });

  test("emits only uniquely solvable puzzles", () => {
    const { task } = generateZebraPuzzleTask();
    for (const taskCase of task.cases) {
      const categories = argument<Category[]>(taskCase, "categories");
      const constraints = argument<Constraint[]>(taskCase, "constraints");
      expect(solvePositions(categories, constraints, 2), taskCase.name).toHaveLength(1);
    }
  });

  test("the solver detects ambiguity instead of selecting an arbitrary answer", () => {
    const { task } = generateZebraPuzzleTask(ZEBRA_PUZZLE_SEED, 1);
    const taskCase = task.cases[0]!;
    const categories = argument<Category[]>(taskCase, "categories");
    expect(solvePositions(categories, [], 2)).toHaveLength(2);
  });
});

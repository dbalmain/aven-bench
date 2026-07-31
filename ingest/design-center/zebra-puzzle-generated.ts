import { fromPortable, valueKinds } from "../json.ts";
import { TASK_SCHEMA_VERSION, type Task, type TaskCase } from "../task.ts";

export const ZEBRA_PUZZLE_SEED = 20_260_801;
export const ZEBRA_PUZZLE_COUNT = 10;

const HOUSE_COUNT = 5;
const FULL_DOMAIN = (1 << HOUSE_COUNT) - 1;

export type Category = {
  name: string;
  values: string[];
};

export type Constraint =
  | { kind: "sameHouse"; a: string; b: string }
  | { kind: "rightOf"; right: string; left: string }
  | { kind: "adjacent"; a: string; b: string }
  | { kind: "atPosition"; value: string; position: number };

export type Query = {
  subject: string;
  category: string;
};

export type PositionAssignment = ReadonlyMap<string, number>;

export type DesignCenterTask = {
  task: Task;
  prompt: string;
};

const CATEGORY_BANK: readonly Category[] = [
  { name: "people", values: ["Aria", "Bram", "Cora", "Dax", "Elin"] },
  { name: "colors", values: ["amber", "cobalt", "ivory", "jade", "violet"] },
  { name: "drinks", values: ["cider", "cocoa", "kombucha", "lemonade", "tea"] },
  { name: "pets", values: ["ferret", "gecko", "heron", "rabbit", "turtle"] },
  { name: "hobbies", values: ["chess", "pottery", "rowing", "stargazing", "weaving"] },
];

class DeterministicRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b_79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  integer(upperBound: number): number {
    if (!Number.isInteger(upperBound) || upperBound <= 0) {
      throw new Error(`upperBound must be a positive integer, got ${upperBound}`);
    }
    return this.nextUint32() % upperBound;
  }

  shuffled<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.integer(i + 1);
      const value = result[i]!;
      result[i] = result[j]!;
      result[j] = value;
    }
    return result;
  }
}

type IndexedConstraint =
  | { kind: "sameHouse"; a: number; b: number }
  | { kind: "rightOf"; right: number; left: number }
  | { kind: "adjacent"; a: number; b: number }
  | { kind: "atPosition"; value: number; position: number };

type SolverModel = {
  values: string[];
  categories: number[][];
  constraints: IndexedConstraint[];
};

function bitCount(value: number): number {
  let remaining = value;
  let count = 0;
  while (remaining !== 0) {
    remaining &= remaining - 1;
    count++;
  }
  return count;
}

function singletonHouse(domain: number): number {
  for (let house = 0; house < HOUSE_COUNT; house++) {
    if (domain === 1 << house) return house;
  }
  throw new Error(`domain ${domain} is not a singleton`);
}

function buildSolverModel(
  categories: readonly Category[],
  constraints: readonly Constraint[],
): SolverModel {
  if (categories.length !== HOUSE_COUNT) {
    throw new Error(`expected ${HOUSE_COUNT} categories, got ${categories.length}`);
  }

  const values: string[] = [];
  const categoryIndexes: number[][] = [];
  const valueIndex = new Map<string, number>();
  const categoryNames = new Set<string>();

  for (const category of categories) {
    if (categoryNames.has(category.name)) {
      throw new Error(`duplicate category name ${JSON.stringify(category.name)}`);
    }
    categoryNames.add(category.name);
    if (category.values.length !== HOUSE_COUNT) {
      throw new Error(
        `category ${JSON.stringify(category.name)} must contain ${HOUSE_COUNT} values`,
      );
    }
    const indexes: number[] = [];
    for (const value of category.values) {
      if (valueIndex.has(value)) {
        throw new Error(`duplicate puzzle value ${JSON.stringify(value)}`);
      }
      indexes.push(values.length);
      valueIndex.set(value, values.length);
      values.push(value);
    }
    categoryIndexes.push(indexes);
  }

  const indexOf = (value: string): number => {
    const index = valueIndex.get(value);
    if (index === undefined) throw new Error(`unknown puzzle value ${JSON.stringify(value)}`);
    return index;
  };

  const indexed = constraints.map((constraint): IndexedConstraint => {
    switch (constraint.kind) {
      case "sameHouse":
        return { kind: constraint.kind, a: indexOf(constraint.a), b: indexOf(constraint.b) };
      case "rightOf":
        return {
          kind: constraint.kind,
          right: indexOf(constraint.right),
          left: indexOf(constraint.left),
        };
      case "adjacent":
        return { kind: constraint.kind, a: indexOf(constraint.a), b: indexOf(constraint.b) };
      case "atPosition": {
        if (constraint.position < 1 || constraint.position > HOUSE_COUNT) {
          throw new Error(`position must be between 1 and ${HOUSE_COUNT}`);
        }
        return {
          kind: constraint.kind,
          value: indexOf(constraint.value),
          position: constraint.position - 1,
        };
      }
    }
  });

  return { values, categories: categoryIndexes, constraints: indexed };
}

function restrict(domains: number[], index: number, allowed: number): boolean {
  const next = domains[index]! & allowed;
  if (next === domains[index]) return false;
  domains[index] = next;
  return true;
}

function propagate(model: SolverModel, domains: number[]): boolean {
  let changed = true;
  while (changed) {
    changed = false;

    for (const category of model.categories) {
      let assigned = 0;
      for (const index of category) {
        const domain = domains[index]!;
        if (domain === 0) return false;
        if (bitCount(domain) === 1) {
          if ((assigned & domain) !== 0) return false;
          assigned |= domain;
        }
      }
      for (const index of category) {
        if (bitCount(domains[index]!) > 1) {
          changed = restrict(domains, index, FULL_DOMAIN & ~assigned) || changed;
          if (domains[index] === 0) return false;
        }
      }
      for (let house = 0; house < HOUSE_COUNT; house++) {
        const bit = 1 << house;
        const candidates = category.filter((index) => (domains[index]! & bit) !== 0);
        if (candidates.length === 0) return false;
        if (candidates.length === 1) {
          changed = restrict(domains, candidates[0]!, bit) || changed;
        }
      }
    }

    for (const constraint of model.constraints) {
      switch (constraint.kind) {
        case "sameHouse": {
          const shared = domains[constraint.a]! & domains[constraint.b]!;
          changed = restrict(domains, constraint.a, shared) || changed;
          changed = restrict(domains, constraint.b, shared) || changed;
          break;
        }
        case "rightOf": {
          const rightAllowed = (domains[constraint.left]! << 1) & FULL_DOMAIN;
          const leftAllowed = domains[constraint.right]! >>> 1;
          changed = restrict(domains, constraint.right, rightAllowed) || changed;
          changed = restrict(domains, constraint.left, leftAllowed) || changed;
          break;
        }
        case "adjacent": {
          const aAllowed =
            ((domains[constraint.b]! << 1) | (domains[constraint.b]! >>> 1)) & FULL_DOMAIN;
          const bAllowed =
            ((domains[constraint.a]! << 1) | (domains[constraint.a]! >>> 1)) & FULL_DOMAIN;
          changed = restrict(domains, constraint.a, aAllowed) || changed;
          changed = restrict(domains, constraint.b, bAllowed) || changed;
          break;
        }
        case "atPosition":
          changed = restrict(domains, constraint.value, 1 << constraint.position) || changed;
          break;
      }
    }

    if (domains.some((domain) => domain === 0)) return false;
  }
  return true;
}

/** Enumerate at most `limit` full assignments; two are enough for uniqueness. */
export function solvePositions(
  categories: readonly Category[],
  constraints: readonly Constraint[],
  limit = 2,
): PositionAssignment[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`solution limit must be a positive integer, got ${limit}`);
  }
  const model = buildSolverModel(categories, constraints);
  const solutions: PositionAssignment[] = [];

  const search = (input: number[]): void => {
    if (solutions.length >= limit) return;
    const domains = [...input];
    if (!propagate(model, domains)) return;

    let branch = -1;
    let branchSize = HOUSE_COUNT + 1;
    for (const [index, domain] of domains.entries()) {
      const size = bitCount(domain);
      if (size > 1 && size < branchSize) {
        branch = index;
        branchSize = size;
      }
    }

    if (branch === -1) {
      solutions.push(
        new Map(model.values.map((value, index) => [value, singletonHouse(domains[index]!)])),
      );
      return;
    }

    for (let house = 0; house < HOUSE_COUNT; house++) {
      const bit = 1 << house;
      if ((domains[branch]! & bit) === 0) continue;
      const next = [...domains];
      next[branch] = bit;
      search(next);
      if (solutions.length >= limit) return;
    }
  };

  search(Array.from({ length: model.values.length }, () => FULL_DOMAIN));
  return solutions;
}

function randomAssignment(
  categories: readonly Category[],
  random: DeterministicRandom,
): Map<string, number> {
  const assignment = new Map<string, number>();
  const houses = Array.from({ length: HOUSE_COUNT }, (_, index) => index);
  for (const category of categories) {
    const positions = random.shuffled(houses);
    for (const [index, value] of category.values.entries()) {
      assignment.set(value, positions[index]!);
    }
  }
  return assignment;
}

function valuesAtHouses(
  categories: readonly Category[],
  assignment: PositionAssignment,
): string[][] {
  const houses = Array.from({ length: HOUSE_COUNT }, () => [] as string[]);
  for (const category of categories) {
    for (const value of category.values) houses[assignment.get(value)!]!.push(value);
  }
  return houses;
}

function trueConstraintPool(
  categories: readonly Category[],
  assignment: PositionAssignment,
): Constraint[] {
  const houses = valuesAtHouses(categories, assignment);
  const constraints: Constraint[] = [];

  for (const values of houses) {
    for (let a = 0; a < values.length; a++) {
      for (let b = a + 1; b < values.length; b++) {
        constraints.push({ kind: "sameHouse", a: values[a]!, b: values[b]! });
      }
    }
  }

  for (let house = 0; house < HOUSE_COUNT - 1; house++) {
    for (const left of houses[house]!) {
      for (const right of houses[house + 1]!) {
        constraints.push({ kind: "rightOf", right, left });
        constraints.push({ kind: "adjacent", a: left, b: right });
      }
    }
  }

  for (const category of categories) {
    for (const value of category.values) {
      constraints.push({ kind: "atPosition", value, position: assignment.get(value)! + 1 });
    }
  }

  return constraints;
}

function minimizeConstraints(
  categories: readonly Category[],
  assignment: PositionAssignment,
  random: DeterministicRandom,
): Constraint[] {
  let kept = random.shuffled(trueConstraintPool(categories, assignment));
  for (const candidate of random.shuffled(kept)) {
    const trial = kept.filter((constraint) => constraint !== candidate);
    if (solvePositions(categories, trial, 2).length === 1) kept = trial;
  }
  return random.shuffled(kept);
}

function queryAnswer(
  categories: readonly Category[],
  assignment: PositionAssignment,
  query: Query,
): string {
  const subjectHouse = assignment.get(query.subject);
  if (subjectHouse === undefined) throw new Error(`unknown query subject ${query.subject}`);
  const category = categories.find((candidate) => candidate.name === query.category);
  if (!category) throw new Error(`unknown query category ${query.category}`);
  const answer = category.values.find((value) => assignment.get(value) === subjectHouse);
  if (answer === undefined) throw new Error(`no answer for ${query.subject}/${query.category}`);
  return answer;
}

function randomQueries(
  categories: readonly Category[],
  assignment: PositionAssignment,
  random: DeterministicRandom,
): Query[] {
  const queries: Query[] = [];
  while (queries.length < 2) {
    const subjectCategoryIndex = random.integer(categories.length);
    let answerCategoryIndex = random.integer(categories.length - 1);
    if (answerCategoryIndex >= subjectCategoryIndex) answerCategoryIndex++;
    const subjectCategory = categories[subjectCategoryIndex]!;
    const query = {
      subject: subjectCategory.values[random.integer(subjectCategory.values.length)]!,
      category: categories[answerCategoryIndex]!.name,
    };
    const duplicate = queries.some(
      (existing) => existing.subject === query.subject && existing.category === query.category,
    );
    if (!duplicate) queries.push(query);
  }
  for (const query of queries) queryAnswer(categories, assignment, query);
  return queries;
}

function deterministicUuid(seed: number, index: number): string {
  const random = new DeterministicRandom((seed ^ Math.imul(index + 1, 0x9e37_79b1)) >>> 0);
  const bytes = Array.from({ length: 16 }, () => random.nextUint32() & 0xff);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

function generatedCases(seed: number, count: number): TaskCase[] {
  const random = new DeterministicRandom(seed);
  return Array.from({ length: count }, (_, index) => {
    const categories = random
      .shuffled(CATEGORY_BANK)
      .map((category) => ({ ...category, values: random.shuffled(category.values) }));
    const target = randomAssignment(categories, random);
    const constraints = minimizeConstraints(categories, target, random);
    const solutions = solvePositions(categories, constraints, 2);
    if (solutions.length !== 1) {
      throw new Error(`generated puzzle ${index + 1} has ${solutions.length} solutions`);
    }
    const queries = randomQueries(categories, solutions[0]!, random);
    const description = `generated puzzle ${String(index + 1).padStart(2, "0")}`;
    return {
      uuid: deterministicUuid(seed, index),
      name: description,
      group: [],
      description,
      property: "solve",
      args: [
        { name: "categories", value: categories },
        { name: "constraints", value: constraints },
        { name: "queries", value: queries },
      ],
      expected: {
        kind: "value",
        value: queries.map((query) => queryAnswer(categories, solutions[0]!, query)),
      },
    };
  });
}

function kindsFor(cases: readonly TaskCase[]): string[] {
  const kinds = new Set<string>();
  for (const taskCase of cases) {
    for (const argument of taskCase.args) valueKinds(fromPortable(argument.value), kinds);
    if (taskCase.expected.kind === "error") kinds.add("error");
    else valueKinds(fromPortable(taskCase.expected.value), kinds);
  }
  return [...kinds].sort();
}

export function generateZebraPuzzleTask(
  seed = ZEBRA_PUZZLE_SEED,
  count = ZEBRA_PUZZLE_COUNT,
): DesignCenterTask {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error(`seed must be an unsigned 32-bit integer, got ${seed}`);
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`puzzle count must be a positive integer, got ${count}`);
  }

  const cases = generatedCases(seed, count);
  const task: Task = {
    schemaVersion: TASK_SCHEMA_VERSION,
    id: "zebra-puzzle-generated",
    title: "Generated Zebra Puzzle",
    blurb: "Solve seeded, uniquely determined zebra-style logic puzzles.",
    source: "design-center",
    sourceCommit: "zebra-puzzle-generated-v1",
    generator: {
      name: "ingest/design-center/zebra-puzzle-generated.ts",
      version: 1,
      seed,
    },
    promptFiles: ["design-center/zebra-puzzle-generated.md"],
    comments: [],
    properties: [
      {
        name: "solve",
        argNames: ["categories", "constraints", "queries"],
        arity: 3,
        caseCount: cases.length,
        returnsResult: false,
        argOrderVariants: [["categories", "constraints", "queries"]],
        ambiguousArgOrder: false,
      },
    ],
    cases,
    stats: {
      caseCount: cases.length,
      errorCaseCount: 0,
      droppedCaseCount: 0,
      valueKinds: kindsFor(cases),
    },
  };

  return { task, prompt: PROMPT };
}

const PROMPT = `# Generated Zebra Puzzle

Solve each supplied zebra-style logic puzzle.

There are five houses in a row, numbered 1 through 5 from left to right. The
\`categories\` argument contains five categories with five values each. Every
value belongs to exactly one house, and every house contains exactly one value
from each category. The order of categories and values in the input has no
meaning.

The \`constraints\` argument contains these clause kinds:

- \`sameHouse(a, b)\`: \`a\` and \`b\` belong to the same house.
- \`rightOf(right, left)\`: \`right\` is in the house immediately to the right
  of \`left\`.
- \`adjacent(a, b)\`: \`a\` and \`b\` are in neighboring houses.
- \`atPosition(value, position)\`: \`value\` is in the numbered house.

Each query has a \`subject\` value and a \`category\` name. Return an array of
answers in query order. An answer is the value from the requested category that
shares a house with the subject.

Every supplied puzzle has exactly one full assignment satisfying all of its
constraints.
`;

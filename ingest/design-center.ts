#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { CORPUS_DIR } from "./paths.ts";
import { loadIndex, type CorpusIndex, type Task } from "./task.ts";
import {
  generateZebraPuzzleTask,
  type DesignCenterTask,
} from "./design-center/zebra-puzzle-generated.ts";

function indexEntry(task: Task): CorpusIndex["tasks"][number] {
  return {
    id: task.id,
    title: task.title,
    caseCount: task.stats.caseCount,
    errorCaseCount: task.stats.errorCaseCount,
    properties: task.properties.map((property) => property.name),
    valueKinds: task.stats.valueKinds,
  };
}

export function generateDesignCenterTasks(): DesignCenterTask[] {
  return [generateZebraPuzzleTask()];
}

export async function writeDesignCenterTasks(index: CorpusIndex): Promise<number> {
  const generated = generateDesignCenterTasks();
  const generatedIds = new Set(generated.map(({ task }) => task.id));

  for (const { task, prompt } of generated) {
    const directory = `${CORPUS_DIR}/${task.id}`;
    mkdirSync(directory, { recursive: true });
    await Bun.write(`${directory}/task.json`, JSON.stringify(task, null, 2) + "\n");
    await Bun.write(`${directory}/prompt.md`, prompt);
  }

  index.tasks = [
    ...index.tasks.filter(({ id }) => !generatedIds.has(id)),
    ...generated.map(({ task }) => indexEntry(task)),
  ].sort((a, b) => a.id.localeCompare(b.id));
  index.taskCount = index.tasks.length;
  index.caseCount = index.tasks.reduce((total, task) => total + task.caseCount, 0);
  index.errorCaseCount = index.tasks.reduce((total, task) => total + task.errorCaseCount, 0);
  return generated.length;
}

if (import.meta.main) {
  const index = await loadIndex(CORPUS_DIR);
  const count = await writeDesignCenterTasks(index);
  await Bun.write(`${CORPUS_DIR}/index.json`, JSON.stringify(index, null, 2) + "\n");
  console.log(`wrote ${count} design-center task${count === 1 ? "" : "s"}`);
}

import type { PlannedTask, TaskStatus } from "./types.js";

export interface GraphValidation {
  valid: boolean;
  errors: string[];
  order: string[];
}

/** Validate references and cycles while preserving declaration order for stable scheduling. */
export function validateTaskGraph(tasks: readonly PlannedTask[]): GraphValidation {
  const ids = new Set(tasks.map((task) => task.id));
  const errors: string[] = [];
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  const children = new Map(tasks.map((task) => [task.id, [] as string[]]));
  for (const task of tasks) {
    const dependencies = [...new Set(task.dependsOn ?? [])];
    if (dependencies.includes(task.id)) errors.push(`${task.id} 不能依赖自身`);
    for (const dependency of dependencies) {
      if (!ids.has(dependency)) {
        errors.push(`${task.id} 引用了未知依赖 ${dependency}`);
        continue;
      }
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      children.get(dependency)!.push(task.id);
    }
  }
  if (errors.length) return { valid: false, errors, order: [] };
  const queue = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  if (order.length !== tasks.length) errors.push("任务依赖图存在环");
  return { valid: errors.length === 0, errors, order };
}

export function readyTaskIds(
  tasks: readonly PlannedTask[],
  statuses: ReadonlyMap<string, TaskStatus>,
): string[] {
  return tasks.filter((task) => {
    if ((statuses.get(task.id) ?? "pending") !== "pending") return false;
    return (task.dependsOn ?? []).every((id) => statuses.get(id) === "completed");
  }).map((task) => task.id);
}

export function blockedByFailedDependency(
  task: PlannedTask,
  statuses: ReadonlyMap<string, TaskStatus>,
): boolean {
  return (task.dependsOn ?? []).some((id) => {
    const status = statuses.get(id);
    return status === "failed" || status === "blocked";
  });
}

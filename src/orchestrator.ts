import { blockedByFailedDependency, readyTaskIds } from "./graph.js";
import type { PlannedTask, TaskStatus, WorkerResult } from "./types.js";

export interface RoutedStageNode<TDecision> {
  task: PlannedTask;
  decision: TDecision;
  worker: boolean;
}

export interface StageCallbacks<TDecision> {
  launch(node: RoutedStageNode<TDecision>): Promise<WorkerResult>;
  onTransition(taskId: string, status: TaskStatus, result?: WorkerResult, error?: unknown): void;
}

/** Runtime-agnostic DAG state machine. UI, model sessions and persistence are injected. */
export class StageOrchestrator<TDecision> {
  readonly statuses: Map<string, TaskStatus>;
  readonly results = new Map<string, WorkerResult>();
  readonly promise: Promise<WorkerResult[]>;
  private readonly running = new Set<string>();
  private settled = false;
  private resolve!: (results: WorkerResult[]) => void;

  constructor(
    private readonly nodes: readonly RoutedStageNode<TDecision>[],
    private readonly order: readonly string[],
    private readonly maxConcurrency: number,
    private readonly signal: AbortSignal,
    private readonly callbacks: StageCallbacks<TDecision>,
  ) {
    this.statuses = new Map(nodes.map(({ task }) => [task.id, "pending" as const]));
    this.promise = new Promise((resolve) => { this.resolve = resolve; });
  }

  updateManager(taskId: string, status: TaskStatus): void {
    if (!this.statuses.has(taskId)) return;
    this.statuses.set(taskId, status);
    this.callbacks.onTransition(taskId, status);
    this.kick();
  }

  kick = (): void => {
    if (this.settled || this.signal.aborted) return;
    let propagated = true;
    while (propagated) {
      propagated = false;
      for (const { task } of this.nodes) {
        if (this.statuses.get(task.id) === "pending" && blockedByFailedDependency(task, this.statuses)) {
          this.statuses.set(task.id, "blocked");
          this.callbacks.onTransition(task.id, "blocked");
          propagated = true;
        }
      }
    }

    const tasks = this.nodes.map(({ task }) => task);
    const ready = readyTaskIds(tasks, this.statuses);
    for (const id of ready) {
      const node = this.nodes.find(({ task }) => task.id === id)!;
      if (!node.worker) {
        this.statuses.set(id, "running");
        this.callbacks.onTransition(id, "running");
      }
    }

    const slots = Math.max(0, this.maxConcurrency - this.running.size);
    const workerReady = ready
      .map((id) => this.nodes.find(({ task }) => task.id === id)!)
      .filter((node) => node.worker)
      .slice(0, slots);
    for (const node of workerReady) this.start(node);
    this.finishIfSettled();
  };

  private start(node: RoutedStageNode<TDecision>): void {
    const id = node.task.id;
    this.statuses.set(id, "running");
    this.running.add(id);
    this.callbacks.onTransition(id, "running");
    void this.callbacks.launch(node).then((result) => {
      this.results.set(id, result);
      const ok = result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted";
      this.statuses.set(id, ok ? "completed" : "failed");
      this.callbacks.onTransition(id, ok ? "completed" : "failed", result);
    }).catch((error) => {
      this.statuses.set(id, "failed");
      this.callbacks.onTransition(id, "failed", undefined, error);
    }).finally(() => {
      this.running.delete(id);
      this.kick();
    });
  }

  private finishIfSettled(): void {
    const workerIds = this.nodes.filter((node) => node.worker).map(({ task }) => task.id);
    const done = workerIds.every((id) => {
      const status = this.statuses.get(id);
      return status === "completed" || status === "failed" || status === "blocked";
    });
    if (!this.settled && done) {
      this.settled = true;
      this.resolve(this.order.flatMap((id) => this.results.get(id) ?? []));
    }
  }
}

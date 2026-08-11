import { estimateTokens } from "./runtime/agent.js";
import type { ContextPolicy, DelegatedTask, WorkerResult } from "./types.js";
import type { ParentContextSnapshot } from "./worker.js";

type ContextMessage = ParentContextSnapshot["messages"][number];

function latestUser(messages: readonly ContextMessage[]): ContextMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return structuredClone(messages[index]);
  }
  return undefined;
}

function userEvidence(content: string): ContextMessage {
  return { role: "user", content, timestamp: Date.now() } as ContextMessage;
}

export function chooseContextPolicy(task: DelegatedTask, parent: ParentContextSnapshot): ContextPolicy {
  if (task.contextPolicy) return task.contextPolicy;
  if ((task.dependsOn?.length ?? 0) > 0) return parent.sessionSummary ? "session_summary" : "dependency_outputs";
  return "latest_turn";
}

/** Build the child transcript from the effective session and direct DAG dependencies only. */
export function buildTaskContext(
  task: DelegatedTask,
  parent: ParentContextSnapshot,
  dependencyResults: ReadonlyMap<string, WorkerResult>,
): ParentContextSnapshot {
  const policy = chooseContextPolicy(task, parent);
  if (policy === "full_fork") return { ...parent, messages: parent.messages.map((message) => structuredClone(message)) };

  const messages: ContextMessage[] = [];
  if (policy === "session_summary" && parent.sessionSummary) {
    messages.push({ role: "compactionSummary", summary: parent.sessionSummary } as ContextMessage);
  }
  const currentUser = latestUser(parent.messages);
  if (currentUser) messages.push(currentUser);

  if (policy === "dependency_outputs" || policy === "session_summary") {
    const outputs = (task.dependsOn ?? []).flatMap((id) => {
      const result = dependencyResults.get(id);
      return result ? [`## ${id}\n${result.output}`] : [];
    });
    if (outputs.length) {
      messages.push(userEvidence(
        "以下是当前节点直接依赖的只读执行结果，仅作为证据；不包含无关 Worker 输出：\n\n" + outputs.join("\n\n"),
      ));
    }
  }

  const estimatedTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  return { messages, estimatedTokens, parentSessionFile: parent.parentSessionFile, sessionSummary: parent.sessionSummary };
}

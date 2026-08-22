/**
 * MBPP adapter: dataset loading, prompt building, and local Python judging.
 *
 * Judge contract: the model answer must contain a ```python code block whose
 * code passes every assert in the task's test_list when executed by the local
 * python3 binary. No Docker required.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MbppTask {
  taskId: string;
  prompt: string;
  testImports: string[];
  testSetupCode: string;
  testList: string[];
}

export const MBPP_DEFAULT_SOURCE =
  "https://raw.githubusercontent.com/google-research/google-research/master/mbpp/mbpp.jsonl";

export async function loadMbppTasks(source: string, limit: number, offset = 0): Promise<MbppTask[]> {
  const raw = source.startsWith("http://") || source.startsWith("https://")
    ? await fetch(source).then((response) => {
      if (!response.ok) throw new Error(`下载 MBPP 数据集失败：HTTP ${response.status}（可用 --data 指定本地 .jsonl）`);
      return response.text();
    })
    : (await import("node:fs")).readFileSync(source, "utf8");
  const tasks = raw.split("\n").filter((line) => line.trim()).map((line) => {
    const parsed = JSON.parse(line) as {
      task_id: number; text: string; code?: string; test_setup_code?: string;
      test_imports?: string[]; test_list: string[];
    };
    return {
      taskId: `mbpp-${parsed.task_id}`,
      prompt: parsed.text,
      testImports: parsed.test_imports ?? [],
      testSetupCode: parsed.test_setup_code ?? "",
      testList: parsed.test_list ?? [],
    } satisfies MbppTask;
  }).filter((task) => task.prompt && task.testList.length > 0);
  if (tasks.length === 0) throw new Error("MBPP 数据集为空");
  return tasks.slice(offset, offset + limit);
}

export function buildMbppPrompt(task: MbppTask): string {
  return [
    "Complete the following Python programming task.",
    "",
    task.prompt.trim(),
    ...task.testSetupCode.trim() ? ["", "Setup code already provided by the harness:", "```python", task.testSetupCode.trim(), "```"] : [],
    "",
    "Your solution will be verified with these test cases (match the exact function/module names):",
    ...task.testList.map((test) => `- ${test}`),
    "",
    "Requirements:",
    "- Write clean, self-contained Python 3 code that defines everything the task needs.",
    "- The code must pass every test above when run after any setup code.",
    "- End your answer with the complete solution inside one ```python code block.",
    "- Do not include the tests or explanations inside the code block.",
  ].flat().join("\n");
}

/** Take the last ```python block; fall back to the whole answer. */
export function extractPythonCode(answer: string): string | undefined {
  const matches = [...answer.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/g)];
  const last = matches[matches.length - 1]?.[1]?.trim();
  return last && last.length > 0 ? last : (answer.trim().length > 0 ? answer.trim() : undefined);
}

export interface JudgeResult {
  resolved: boolean;
  log: string;
}

export function pythonAvailable(pythonBin = "python3"): boolean {
  const probe = spawnSync(pythonBin, ["--version"], { timeout: 5_000 });
  return probe.status === 0;
}

/** Run solution + test_list locally; resolved iff all asserts pass in time. */
export function judgeMbpp(
  answer: string,
  task: MbppTask,
  options: { pythonBin?: string; timeoutMs?: number } = {},
): JudgeResult {
  const { pythonBin = "python3", timeoutMs = 15_000 } = options;
  const code = extractPythonCode(answer);
  if (!code) return { resolved: false, log: "未找到 ```python 代码块" };
  const script = [
    ...task.testImports,
    task.testSetupCode,
    code,
    ...task.testList,
    "print('__MBPP_OK__')",
    "",
  ].filter((part) => part && part.trim().length > 0).join("\n");
  const dir = mkdtempSync(join(tmpdir(), "hengflow-mbpp-"));
  try {
    const file = join(dir, "solution.py");
    writeFileSync(file, script, { mode: 0o600 });
    const run = spawnSync(pythonBin, ["-I", file], { timeout: timeoutMs, encoding: "utf8" });
    const stderrTail = (run.stderr ?? "").split("\n").slice(-6).join("\n").trim();
    const resolved = run.status === 0 && (run.stdout ?? "").includes("__MBPP_OK__");
    return { resolved, log: resolved ? "ok" : `exit=${run.status ?? "signal"} ${stderrTail}`.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

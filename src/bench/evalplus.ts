/**
 * EvalPlus-family adapter (HumanEval+ / MBPP+).
 *
 * These datasets ship *hardened* test inputs (base + plus) that expose
 * pass@1 gaps between models — exactly the failure-rate variance the router
 * needs to learn from. The runner materializes concrete assert calls from
 * base_input + plus_input per entry_point so judging is plain local python,
 * no evalplus package or Docker required.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export type EvalPlusFamily = "humanevalplus" | "mbppplus";

export interface EvalPlusTask {
  taskId: string;
  family: EvalPlusFamily;
  /** Function-completion prompt (HumanEval) or instruction (MBPP). */
  prompt: string;
  entryPoint: string;
  /** Concrete call-args rows (base + plus) for assert materialization. */
  inputs: unknown[][];
  /** Optional atol for float comparisons. */
  atol?: number;
  /** True when prompt is a function signature awaiting a body (HumanEval):
   * solutions are bodies, and the check script must embed prompt+body. */
  completionStyle?: boolean;
}

interface RawEvalPlusRow {
  task_id: string;
  prompt?: string;
  entry_point?: string;
  base_input?: unknown[][];
  plus_input?: unknown[][];
  assertion?: string;
  atol?: number;
}

function safeLiteral(value: unknown): string {
  if (value === Number.POSITIVE_INFINITY) return "float('inf')";
  if (value === Number.NEGATIVE_INFINITY) return "float('-inf')";
  if (typeof value === "number" && Number.isNaN(value)) return "float('nan')";
  if (typeof value === "number") {
    // Python ints can be arbitrary precision; keep integers exact.
    if (Number.isInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER) return String(value);
    return reprFloat(value);
  }
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null) return "None";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(safeLiteral).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${safeLiteral(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

function reprFloat(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "float('inf')" : "float('-inf')";
  if (Number.isInteger(value) && Math.abs(value) >= 1e21) return String(value);
  // repr floats with full precision; exponent form is valid Python too.
  const text = String(value);
  return text.includes(".") || text.includes("e") || text.includes("Infinity") ? text : `${text}.0`;
}

/** One arg row → `assert fn(args...) == expected`-style deterministic check.
 * evalplus compares against the canonical solution output, so we execute the
 * candidate against a reference implementation embedded from the row's own
 * canonical_solution when needed. Simpler and equally deterministic: compare
 * candidate(row) to canonical(row) by running both in the same interpreter. */
export function buildCheckScript(task: EvalPlusTask, candidateCode: string, canonicalSolution: string): string {
  const rows = task.inputs.map((row) => `[${row.map(safeLiteral).join(", ")}]`).join(",\n    ");
  // HumanEval solutions are function bodies: the prompt carries the def line,
  // so both candidate and canonical are completed by appending to the prompt.
  const prefix = task.completionStyle ? task.prompt.trimEnd() + "\n" : "";
  const candidate = prefix + candidateCode;
  // Canonical twin: rename the def so both versions coexist in one process.
  const twinName = `${task.entryPoint}__canon__`;
  const twin = (prefix + canonicalSolution).replace(
    new RegExp(`^def\\s+${task.entryPoint}\\b`, "m"),
    `def ${twinName}`,
  );
  return [
    "import json, math",
    candidate,
    twin,
    "",
    `def __close__(a, b, atol=${task.atol ?? 1e-6}):`,
    "    if isinstance(a, float) or isinstance(b, float):",
    "        return math.isclose(a, b, rel_tol=1e-6, abs_tol=atol)",
    "    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):",
    "        return all(__close__(x, y, atol=atol) for x, y in zip(a, b))",
    "    if isinstance(a, tuple) and isinstance(b, tuple) and len(a) == len(b):",
    "        return all(__close__(x, y, atol=atol) for x, y in zip(a, b))",
    "    return a == b",
    "",
    `__ROWS__ = [`,
    `    ${rows},`,
    `]`,
    "for args in __ROWS__:",
    `    got = ${task.entryPoint}(*args)`,
    `    want = ${twinName}(*args)`,
    "    if not __close__(got, want):",
    "        print(json.dumps({'fail': [str(a)[:80] for a in args], 'got': str(got)[:120], 'want': str(want)[:120]}))",
    "        raise SystemExit(1)",
    "print('__EVALPLUS_OK__')",
    "",
  ].join("\n");
}

/** Take the last ```python block verbatim (no trim: completion-style
 * bodies depend on leading newlines/indent). Fall back to raw answer. */
export function extractPythonCode(answer: string): string | undefined {
  const matches = [...answer.matchAll(/```(?:python|py)?[ \t]*\r?\n([\s\S]*?)```/g)];
  const last = matches[matches.length - 1]?.[1];
  if (last !== undefined && last.trim().length > 0) return last.replace(/\s+$/, "");
  return answer.trim().length > 0 ? answer : undefined;
}

export interface JudgeOutcome {
  resolved: boolean;
  log: string;
}

export function judgeEvalPlus(
  answer: string,
  task: EvalPlusTask,
  canonicalSolution: string,
  options: { pythonBin?: string; timeoutMs?: number } = {},
): JudgeOutcome {
  const { pythonBin = "python3", timeoutMs = 20_000 } = options;
  const code = extractPythonCode(answer);
  if (!code) return { resolved: false, log: "未找到 ```python 代码块" };
  const dir = mkdtempSync(join(tmpdir(), "hengflow-evalplus-"));
  try {
    const file = join(dir, "check.py");
    writeFileSync(file, buildCheckScript(task, code, canonicalSolution), { mode: 0o600 });
    const run = spawnSync(pythonBin, ["-I", file], { timeout: timeoutMs, encoding: "utf8" });
    const resolved = run.status === 0 && (run.stdout ?? "").includes("__EVALPLUS_OK__");
    const tail = `${run.stderr ?? ""}\n${run.stdout ?? ""}`.split("\n").filter(Boolean).slice(-4).join(" | ");
    return { resolved, log: resolved ? "ok" : `exit=${run.status ?? "signal"} ${tail}`.slice(0, 300) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface LoadedEvalPlusTask extends EvalPlusTask {
  canonicalSolution: string;
}

/** Python-flavored JSON: evalplus rows may contain Infinity/-Infinity/
 * NaN literals which strict JSON.parse rejects. Normalize to null-free
 * string markers, then revive known shapes. */
function parseLooseJson(line: string): RawEvalPlusRow & { canonical_solution?: string } {
  const normalized = line
    .replace(/(^|[^\w"])(-?Infinity)(?=[,\]\s])/g, '$1"$2"')
    .replace(/(^|[^\w"])(NaN)(?=[,\]\s])/g, '$1"$2"');
  return JSON.parse(normalized) as RawEvalPlusRow & { canonical_solution?: string };
}

const INF_MARKER = "Infinity";
const NEG_INF_MARKER = "-Infinity";
const NAN_MARKER = "NaN";

/** Revive the markers back into JS numbers for literal generation. */
function revive(value: unknown): unknown {
  if (value === INF_MARKER) return Number.POSITIVE_INFINITY;
  if (value === NEG_INF_MARKER) return Number.NEGATIVE_INFINITY;
  if (value === NAN_MARKER) return Number.NaN;
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, revive(v)]));
  }
  return value;
}

/** JS numbers beyond 2^53 cannot round-trip exact Python ints; evalplus
 * extreme rows using them would produce float literals and crash int-typed
 * canonicals. Drop those rows (sound: fewer extreme checks, no false fails). */
function rowIsExactlyRepresentable(row: unknown[]): boolean {
  return row.every((value) => {
    if (typeof value !== "number") return true;
    if (!Number.isFinite(value)) return true; // inf/nan handled by literal
    if (Number.isInteger(value)) return Math.abs(value) <= Number.MAX_SAFE_INTEGER;
    return true; // float32/64 JSON round-trips exactly enough for isclose
  });
}

/** Drop tasks whose own canonical solution cannot pass their inputs
 * (dataset soundness holes, e.g. extreme rows the reference crashes on).
 * Called once before training; costs only local python time. */
export async function filterSelfConsistent(
  tasks: LoadedEvalPlusTask[],
  pythonBin = "python3",
): Promise<LoadedEvalPlusTask[]> {
  const verdicts = await Promise.all(tasks.map((task) => {
    const answer = "```python\n" + task.canonicalSolution + "\n```";
    return Promise.resolve(judgeEvalPlus(answer, task, task.canonicalSolution, { pythonBin, timeoutMs: 25_000 }))
      .then((result) => ({ task, ok: result.resolved }))
      .catch(() => ({ task, ok: false }));
  }));
  return verdicts.filter((v) => v.ok).map((v) => v.task);
}

export async function loadEvalPlusTasks(
  family: EvalPlusFamily,
  dataPath: string,
  limit: number,
  offset = 0,
): Promise<LoadedEvalPlusTask[]> {
  const raw = (await readFile(dataPath, "utf8")).split("\n").filter((line) => line.trim());
  const tasks: LoadedEvalPlusTask[] = [];
  for (const line of raw) {
    const row = parseLooseJson(line);
    const base = Array.isArray(row.base_input) ? row.base_input : [];
    const plus = Array.isArray(row.plus_input) ? row.plus_input : [];
    const inputs = [...base, ...plus]
      .map((row) => revive(row) as unknown[])
      .filter(rowIsExactlyRepresentable);
    if (!row.entry_point || inputs.length === 0 || !row.canonical_solution) continue;
    tasks.push({
      taskId: row.task_id.replace(/[\\/]/g, "_"),
      family,
      prompt: row.prompt ?? "",
      entryPoint: row.entry_point,
      inputs,
      atol: row.atol,
      canonicalSolution: row.canonical_solution,
      completionStyle: family === "humanevalplus",
    });
  }
  return tasks.slice(offset, offset + limit);
}

export function buildEvalPlusPrompt(task: EvalPlusTask): string {
  if (task.family === "humanevalplus") {
    return [
      "Complete the following Python function. The docstring specifies the behavior.",
      "",
      "```python",
      task.prompt.trim(),
      "```",
      "",
      "Requirements:",
      `- Implement \`${task.entryPoint}\` exactly (keep the signature).`,
      "- The implementation must be correct for arbitrary edge-case inputs, not only obvious ones.",
      "- End your answer with the complete implementation inside one ```python code block (imports + function).",
      "- Do not include tests, examples, or explanations inside the code block.",
    ].join("\n");
  }
  return [
    "Complete the following Python programming task.",
    "",
    task.prompt.trim(),
    "",
    "Requirements:",
    `- Define a function named \`${task.entryPoint}\` with a sensible signature that satisfies the task.`,
    "- The implementation must be correct for arbitrary edge-case inputs, not only obvious ones.",
    "- End your answer with the complete solution inside one ```python code block.",
    "- Do not include tests or explanations inside the code block.",
  ].join("\n");
}

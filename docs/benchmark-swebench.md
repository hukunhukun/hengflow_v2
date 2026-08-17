# SWE-bench 路由 Benchmark 执行方案

## 目标

用一个小型、可复现的实验回答两个问题：

1. 多 Agent 协作相对 Manager 单独执行，是否提升 SWE-bench 修复成功率或降低全路径 Token 成本？
2. 在相同 Worker 工作流下，HengFlow ROI Router 是否优于固定模型映射？

第一轮只作为认知验证，不将结果作为统计显著性结论。

## 实验规模与边界

- 数据集：`SWE-bench Verified`。
- 样本：3 个任务，按小范围修复、跨文件根因分析、复杂/长上下文修复各选一个 instance。
- 重复：每个 task、variant 重复 3 次。
- 总运行数：`3 tasks × 3 variants × 3 repeats = 27`。
- 成功定义：使用官方 SWE-bench evaluator，`resolved = 1` 为成功；模型的自我判断不计分。
- Manager：固定 `openai-codex/gpt-5.6-sol` 和 thinking level。
- Worker：固定为 `deepseek/deepseek-v4-flash` 与 `zai-coding-cn/glm-5.3`。
- Worker 保持只读；补丁、测试和最终回答仍由 Manager 完成。因此本实验测量的是“只读委派和路由对 Manager 修复的辅助效果”。

## 三个实验组

| Variant | 名称 | Worker 规则 | 用途 |
| --- | --- | --- | --- |
| A | `manager_only` | 禁用全部 Worker | Manager 单 Agent 基线 |
| B | `fixed_mapping` | `simple`、`research` 固定 DeepSeek；`coding`、`long-context` 固定 GLM | 固定多 Agent 基线 |
| C | `roi_router` | 使用 HengFlow 当前 Router 选择 Worker 与单次 fallback | 测量 Router 的增量价值 |

三个 variant 必须拥有相同的仓库基线、Manager、系统提示、工具权限、最大 turn、超时、测试命令和模型价格表。

写入、高风险、`synthesis`、无可用 Worker 等现有安全硬门槛在 B、C 中保持一致；只有安全允许委派的只读任务允许不同的 Worker 选型。

## 固定 benchmark 价格表

所有成本按 USD / 百万 Token 重算；Coding Plan 也使用影子价格。实际订阅扣费、余额、配额、reset 和 Provider 账单不进入成本指标。

```json
{
  "openai-codex/gpt-5.6-sol": {
    "input": 5,
    "cacheRead": 0.5,
    "output": 30
  },
  "deepseek/deepseek-v4-flash": {
    "input": 0.14,
    "cacheRead": 0.0028,
    "output": 0.28
  },
  "zai-coding-cn/glm-5.3": {
    "input": 1.4,
    "cacheRead": 0.26,
    "output": 4.4
  }
}
```

一次运行的成本为所有 Manager、Worker、验证、返工和 fallback 调用之和：

```text
cost = Σ((input_tokens - cache_read_tokens) × input_price
       + cache_read_tokens × cache_read_price
       + output_tokens × output_price) / 1,000,000
```

`cache_write_tokens` 需原样记录；第一轮价格表不包含 cache-write 定价时，报告中单列该 Token 数，不纳入上述主成本，避免隐含假设。

## Router 控制变量

Benchmark 使用临时配置，禁止配额与在线学习带来跨运行干扰：

```json
{
  "routing": {
    "quotaWeight": 0,
    "explorationWeight": 0
  },
  "budget": {
    "sessionUsdLimit": 0,
    "providerLimitsUsd": {},
    "hardFeasibility": false
  }
}
```

每次运行使用空的、独立的 `HENGFLOW_DATA_DIR`。这意味着首轮 C 测的是冷启动的静态 Router，而不是历史验收数据的长期学习效果。后续若评测学习能力，必须以训练集和未见测试集分离的时间序列实验进行。

## 运行隔离

每个 run 都必须：

1. 在独立 Docker 容器或独立 worktree 中检出 SWE-bench 指定的 `base_commit`；
2. 使用临时 `HENGFLOW_AGENT_DIR`，其中仅引用本机认证文件并写入该 variant 的配置；不得复制认证内容到结果目录或 Git 仓库；
3. 设置唯一 `HENGFLOW_DATA_DIR`，使 `usage.sqlite` 只包含本次 run；
4. 运行 Agent，保留 session、执行日志、最终 patch 和账本；
5. 在同一任务镜像中运行官方 evaluator；
6. 导出结构化结果后销毁容器/工作目录。

推荐结果目录：

```text
bench/runs/<instance_id>/<variant>/<repeat>/
├── result.json
├── patch.diff
├── evaluator.json
├── ledger.sqlite
├── session.jsonl
└── logs/
```

结果目录和所有 `*.sqlite`、session、patch、日志应被 Git 忽略，防止提交任务上下文、测试数据或潜在敏感信息。

## 单次运行记录

`result.json` 至少包含：

```json
{
  "runId": "uuid",
  "instanceId": "owner__repo-123",
  "variant": "roi_router",
  "repeat": 1,
  "startedAt": "ISO-8601",
  "endedAt": "ISO-8601",
  "resolved": false,
  "durationMs": 0,
  "totalCostUsd": 0,
  "calls": [
    {
      "role": "manager",
      "provider": "openai-codex",
      "model": "gpt-5.6-sol",
      "inputTokens": 0,
      "cacheReadTokens": 0,
      "cacheWriteTokens": 0,
      "outputTokens": 0,
      "costUsd": 0
    }
  ],
  "routes": [],
  "fallbacks": [],
  "evaluator": { "exitCode": 0, "summary": "" }
}
```

`routes` 需保存 task kind、候选模型、选择模型、Router score、预测成本、失败率与解释，以便复盘 C 与 B 的差异。

## 执行顺序

### 1. 环境预检

- 确认 Docker 可用；
- 安装并锁定 SWE-bench evaluator 版本；
- 拉取或缓存 3 个 task 所需镜像；
- 验证当前 Manager、DeepSeek、GLM 认证可用；
- 在临时目录验证成本采集与 evaluator 的 JSON 输出。

### 2. 实现 benchmark 支持

当前代码没有强制固定映射的策略，也没有 `runId`/`instanceId` 维度的账本。第一轮需要补齐：

- `manager_only`、`fixed_mapping`、`roi_router` 三种 benchmark policy；
- B 的强制映射，不能使用 `preferredWorker`，因为它只是评分偏好；
- 一个独立成本导出器，从本次独立 ledger 读取 `model_calls` 并依据固定价格表重算；
- result JSON 写入器；
- 汇总报告脚本。

Benchmark 支持应与产品正常默认路由隔离，默认行为仍是当前 `roi_router`。

### 3. 冒烟实验

先只运行一个 task 的 A/B/C 各一次。通过条件：

- 三种策略均可完成并生成 patch；
- evaluator 能返回结果；
- B 的模型映射、C 的 Router 选择符合预期；
- 账本和 `result.json` 的 Token/成本一致；
- 没有上一轮的 ledger、workspace 或 patch 泄漏到下一轮。

### 4. 完整实验

冒烟通过后，执行其余任务，直至获得完整 27 次结果。为避免 Provider 短期波动造成系统性偏差，各 variant 的运行顺序应轮换，而不是先连续跑完 A 再跑 B/C。

### 5. 汇总与判定

按 variant 输出：

```text
resolved_rate = resolved_runs / total_runs
mean_cost = total_cost / total_runs
cost_per_resolved = total_cost / max(1, resolved_runs)
```

并在任务维度做 A/B/C 配对比较：

```text
Δresolved(C - B)
Δcost(C - B)
incremental_cost_per_success = Δtotal_cost / Δresolved
```

判定：

- C 与 B 成功率相近且成本更低：Router 有经济收益；
- C 成功率更高且成本增幅可接受：Router 有质量收益；
- C 更贵且成功率没有改善：当前 Router 在该 workload 无收益；
- 仅 3 task × 3 repeat 的结果只用于方向判断；后续需扩大 task 数量并采用 bootstrap 或 McNemar 等统计检验。

## 当前 Router 在本实验中的含义

关闭配额、预算与探索后，C 仍会综合模型质量先验、任务复杂度、历史失败率、历史成本倍率、延迟、affinity、指定模型偏好和全路径 ROI。对完全静态的价格 benchmark，独立空账本会使历史学习项回到冷启动先验。

Manager 的计划/DAG 本身也会波动。第一轮端到端实验接受该波动；若要严格归因 Router，下一阶段应为每个 instance 固化同一份 `TaskSpec[]`，使 B/C 在完全相同的 DAG 上仅比较 Worker 选型。

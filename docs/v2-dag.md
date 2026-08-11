# HengFlow v2 DAG 与上下文策略

## 执行生命周期

1. Manager 一次调用 `execute_plan`，任务可用 `dependsOn` 声明直接依赖。
2. Harness 校验未知边、自依赖和环，路由全部节点并建立任务板。
3. 只启动当前 ready 的 Worker；`execute_plan` 立即返回 `delegationId`。
4. Manager 同时处理 ready Manager 节点，并用 `update_task_status` 标记完成。
5. Worker 或 Manager 节点完成后，Harness 自动激活后继；失败会递归阻塞依赖节点。
6. Manager 调用 `collect_stage_results` 作为阶段屏障。Worker 输出只在此处按拓扑顺序注入 Manager。
7. Manager 最终综合；正常成功样本低置信度自动回流，异常使用 `report_task_outcomes`。

Pi 扩展 API 没有 background execution mode，因此 v2 在扩展内部维护后台 Promise、取消控制器和显式阶段屏障，而不是修改 Pi Runtime。

## ContextPolicy

```ts
type ContextPolicy =
  | "latest_turn"
  | "dependency_outputs"
  | "session_summary"
  | "full_fork";
```

- `latest_turn`：当前原始用户消息；系统安全约束由 Worker system prompt 注入。
- `dependency_outputs`：当前用户消息 + 当前节点直接依赖的 Worker 结果。
- `session_summary`：Pi 最新 compaction summary + 当前用户消息 + 直接依赖结果。
- `full_fork`：完整的 Pi effective transcript，仅显式要求时使用。

默认无依赖使用 `latest_turn`；有依赖时优先 `session_summary`（若 Pi 有摘要），否则 `dependency_outputs`。Harness 从 Pi session entries 和 DAG 结果构造上下文。

## 有限模型探索

低风险只读、未指定模型的任务可获得探索奖励。DeepSeek 在对应任务桶的样本数低于 `explorationMinSamples` 时具有势能缺口：

`V = max(0, minSamples - samples)`

Router 从原利用分数减去有界奖励 `weight * V / minSamples`。只有探索改变贪心选择时才消耗会话预算；达到 `explorationBudgetUsd` 或样本缺口归零后恢复纯利用。高风险、写入、显式模型偏好和超预算任务不探索。

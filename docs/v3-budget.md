# v3 预算路由（Budget-Aware Routing）

v3 在 v2 的固定权重 ROI Router 之上增加跨时间的预算分配层。核心变化：成本不再以固定
`costWeight` 进入分数，而是乘以**影子价格 λ_t**——预算超速的窗口让美元按比例变贵。

## 状态层（ledger）

- `budget_windows` 表：每个 scope（`session`、`provider:<p>`）持久化 `debt_usd`、
  `lambda_multiplier`、窗口边界与花费快照。**花费本身不落此表**，始终从
  `model_calls` 按 `created_at ∈ [window_start, now)` 推导，单一事实来源。
- `route_decisions.phase`（`plan` / `launch`）：计划时与启动时两次决策都落库，
  供离线 replay 与校准使用。
- `getQuotaState()`：配额压力 + `timeToResetMs`，"剩 50%、1 小时后重置"与
  "剩 50%、29 天后重置"从此是不同的路由状态。
- `getCalibration()`：`route_decisions ⋈ task_outcomes`，输出预测失败率的 Brier
  分数与预测/实际成本偏差（costBias），暴露学习数据的系统性偏差。

## 决策层（budget-controller.ts）

虚拟队列按窗口更新：

```
rho_t     = B_remaining / T_remaining
Q_{t+1}   = max(0, Q_t + spend_delta - rho_t * dt)
lambda_t  = 1 + kappa * min(1, Q_t / (0.1 * limit))
```

- `routeTask` 的成本项：`costWeight * lambda * predictedCostUsd`；λ 无压力时为 1，
  与 v2 行为一致（默认不配置预算则完全不变）。
- 候选级硬可行性预过滤：provider 窗口装不下本次调用的候选被剔除（仍有可行候选时）。
- `routePlannedTask` 对**全路径成本**（planning + worker + verification + 期望返工）
  做最终硬检查；不可行 → 降级为 Manager 直做。
- 降级链：更便宜 Worker → Manager 直接执行 → 节点暂停（任务板标注 + UI 通知）。
  软队列只负责 pacing，硬可行性负责兜底，两者不混用。
- 准入控制：λ 超过阈值时，Worker 启动最多延迟一次 `admissionMaxWaitMs`（有界，
  不永久阻塞并发槽）。

## 时序层（extension.ts）

- **懒路由**：计划时决策是暂定的；Orchestrator 的 launch 回调用最新的 λ、学习画像
  和已完成的依赖输出重新路由。模型变化会记录在任务板（`launch 重路由 A → B`），
  两次决策分别以 `plan`/`launch` phase 落库。质量型翻转让沿用计划路由防抖动；
  只有预算不可行会暂停节点。
- **分解经济学门禁**：`evaluateSplit` 复活——`execute_plan` 先对 Manager 的拆分做
  全路径成本 vs 直做的经济学评估，不通过则拒绝并说明理由（可再次调用覆盖一次）。
  Manager 仍是提案者，Harness 成为经济验证者。

## 探索预算

原独立 `explorationBudgetUsd` 保留为样本缺口探索的额外护栏；探索调用的花费照常
进入 model_calls，因此同样计入 session/provider 窗口，不能用独立预算绕开全局约束。
"Lyapunov 势能缺口" 全部更名为"样本缺口探索"（sample-deficit exploration）。

## 配置

```json
{
  "budget": {
    "sessionUsdLimit": 0,
    "providerLimitsUsd": {},
    "lambdaKappa": 2,
    "hardFeasibility": true,
    "admissionLambdaThreshold": 2.5,
    "admissionMaxWaitMs": 30000
  }
}
```

默认全关（λ 恒为 1，行为与 v2 一致）。`/hf-status` 显示各窗口
`spent/limit λ debt` 与校准摘要。

## 已知边界

- 毫秒分辨率的窗口边界归因：rollover 同一毫秒内完成的花费会记入新窗口
  （≤1ms 模糊，6h/24h 窗口下无实际影响）。
- 学习数据仍依赖 Manager 验收回流；`getCalibration` 是监控该偏差的手段，
  修复（如强制上报）留给下一阶段。
- 离线 replay 目前是最小实现（`src/test/replay.test.ts`：静态 vs λ 调速对比）；
  基于 ledger 历史的完整 replay 与 oracle 对比是下一步。

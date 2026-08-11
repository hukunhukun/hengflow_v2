# HengFlow 架构设计（草案）

## 1. 总体结构

```text
User
  │
  ▼
Pi CLI / TUI ───────────── Pi Auth + ModelRuntime + Session
  │
  ▼
Manager Agent
  ├── direct answer
  └── execute_plan(mode, returnPolicy, TaskSpec[])
          │ atomic Todo + full-path route + execution
          │
          ▼
      Pi SDK context fork ── canonical parent transcript
          │
          ▼
      Orchestrator ── cancel / concurrency / progress
          │
          ▼
        Router ───── Policy + Model Catalog + Budget Queues
       ╱   │   ╲
      ▼    ▼    ▼
  DeepSeek GLM  Strong-model fallback
      │    │    │
      └────┴────┘
           │ structured results
           ▼
     passthrough OR Manager stage synthesis / verification

All decisions and calls ──► Local SQLite Telemetry
Provider adapters ────────► Quota snapshots / price catalog
```

## 2. 模块边界

### PiAdapter

- 获取当前 Manager session、模型目录和认证可用性；
- 从 Manager 的 compaction-aware 有效消息创建独立 Worker `AgentSession`；
- 剔除当前尚未完成的派发 tool call，避免悬空工具调用进入子会话；
- 将模型 usage 和 stop reason 规范化；
- 不暴露原始认证秘密。

### ManagerPolicy

- 强制行动型请求先提交一次原子执行计划；
- 注册 `execute_plan`，支持 `direct_manager`、`direct_worker`、`parallel`；
- 单个低风险 Worker 支持 `passthrough`，并行与关键任务使用 `manager_synthesis`；
- 校验至少一个 Manager 配置；
- 控制最终答案与高风险操作的责任归属。

### Orchestrator

- 验证 TaskSpec；
- 当前处理并发、取消、超时和结果聚合；下一阶段增加依赖 DAG 和阶段检查点；
- 使用 Pi SessionManager 的真实父会话消息作为 Worker 背景；
- 在原子执行时按继承上下文 token、规划、验收和期望返工计算全路径 ROI；
- MVP 中限制 Worker 为只读。

### Router

- 生成候选模型并做能力硬过滤；
- 预测成本、质量、时延和失败率；
- 应用预算队列与用户策略；
- 输出选择结果、备选链和可解释原因。

### UsageLedger

- 记录调用和 route decision；
- 维护模型滚动统计；
- 合并官方、限流、本地预算和估算额度；
- 为命令行状态页提供查询。

### ProviderAdapter

- 查询 Provider 可公开获得的配额/账单数据；
- 读取标准化后的 rate-limit headers；
- 维护价格目录和更新时间；
- 返回 capability level，而不是强行统一成一个“余额”数字。

## 3. 核心数据契约

```ts
type TaskSpec = {
  id: string;
  objective: string;
  contextRefs?: string[];
  dependsOn?: string[];
  requiredCapabilities?: Array<
    "tools" | "vision" | "reasoning" | "long-context" | "code-write"
  >;
  risk: "low" | "medium" | "high";
  minQuality?: number;
  maxCostUsd?: number;
  deadlineMs?: number;
  outputSchema?: object;
};

type RouteDecision = {
  taskId: string;
  selected: ModelRef;
  fallbacks: ModelRef[];
  predicted: {
    quality: number;
    costUsd: number;
    latencyMs: number;
    failureProbability: number;
  };
  constraintsApplied: string[];
  explanation: string[];
  policyVersion: string;
};

type QuotaSnapshot = {
  provider: string;
  metric: "money" | "tokens" | "requests";
  remaining?: number;
  resetAt?: string;
  source: "authoritative" | "rate_limit" | "configured_budget" | "estimated" | "unknown";
  observedAt: string;
};
```

## 4. 初始存储模型

SQLite 表：

- `runs`：一次用户请求及总开销；
- `tasks`：Manager 拆出的子任务、依赖与验收状态；
- `route_decisions`：候选、打分、约束和最终选择；
- `model_calls`：token、缓存、费用、时延、错误和重试；
- `model_stats`：按任务类型和模型聚合的 EWMA；
- `quota_snapshots`：额度来源与新鲜度；
- `policy_versions`：可复现当时的路由参数。

原始 prompt/response 默认不进入长期账本，只存哈希、大小和可选摘要；调试模式也要支持脱敏和保留期限。

## 5. 配置层次

建议优先级：

```text
CLI flags
  > project .pi/hengflow.yaml
  > user ~/.pi/agent/hengflow.yaml
  > built-in safe defaults
```

配置只保存模型引用、策略和预算，不保存 Provider 密钥。模型名称启动时通过 Pi registry 解析，避免硬编码随时间失效的模型 ID。

## 6. 决策模式

- `manual`：Manager 提议分派，用户确认模型与预算；
- `suggest`：自动选择模型，但执行前显示建议；
- `auto`：在预先授权的预算和风险范围内直接执行。

高风险任务、超预算、向未授权外部 Provider 发送数据、启用写权限时，无论模式如何都应触发明确审批。

## 7. Pi 改动预算

按优先顺序：

1. **零核心改动**：Package 使用公开 Extension/SDK API；
2. **窄上游接口**：若必要，增加可复用 ModelRuntime 或 child-session factory；
3. **不接受**：复制认证文件、劫持 OAuth、长期维护 Pi 私有 fork。

这个边界是 HengFlow 能持续跟随 Pi 模型和认证更新的关键。

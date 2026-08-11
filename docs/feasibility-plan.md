# HengFlow 可行性与实施方案

## 1. 需求判断

方案可行，而且可以把对 Pi 的改动控制在“零改动优先、一个窄接口兜底”的范围内。

HengFlow 不重新实现终端 Agent，而是在 Pi 的现有能力上增加三层：

1. **Manager policy**：确保每条用户输入先到达至少一个 Manager；
2. **Task orchestration**：把 Manager 产生的结构化子任务变成独立 Worker 会话；
3. **Economic routing**：在满足能力与质量底线后，选择预期 ROI 更高的模型。

## 2. 为什么不直接 fork Pi 或 OMP

Pi 已经承担了最难维护、最敏感的部分：登录、凭证刷新、模型注册、消息协议、工具循环、会话和交互界面。复制这些逻辑会引入安全风险，也会让上游升级变得昂贵。

OMP 证明了“Manager + task tool + 子 Agent 会话”的路线可用，但 HengFlow 的差异化重点是：

- 复用 Pi 而不是维护大 fork；
- 跨供应商、按成本/质量/额度动态路由；
- 对实际成本和任务成功率形成闭环；
- 明确区分官方额度、限流窗口、本地预算和推算余额。

因此首选 Pi Package / Extension；OMP 只作为任务编排、隔离和并发控制的设计参考。

## 3. 最小侵入实现

### 3.1 认证与模型接入

- 用户继续在 Pi 中使用 `/login`、环境变量、`auth.json` 和自定义模型配置。
- HengFlow 只调用 Pi 的模型运行时查询“当前哪些模型可用”，不读取、复制、打印或迁移原始 token。
- Manager 和 Worker 共用同一模型运行时；每个 Worker 使用独立 AgentSession。
- OpenAI-compatible 模型沿用 Pi 的自定义 Provider/Model 配置，因此 DeepSeek、GLM、本地 vLLM/Ollama 等不需要 HengFlow 各自重写协议。

目标是 Pi 核心零改动。如果扩展上下文无法安全获得可复用的 ModelRuntime，则只向 Pi 增加一个公开的 `createChildSession()` 或 `modelRuntime` 访问点；认证仍由 Pi 独占。

### 3.2 Manager 行为

配置中至少有一个 Manager：

```yaml
managers:
  - id: primary
    model: openai-codex/gpt-5.6-sol # 示例，启动时按 Pi registry 解析
    role: primary

routing:
  mode: auto # manual | suggest | auto
  min_quality: 0.82
  max_concurrency: 3
```

每次用户输入都进入主会话的 Manager。Manager 只有两种主要动作：

1. 直接处理：短问题、强上下文依赖、敏感操作或拆分收益不足；
2. 对行动型请求先调用一次 `execute_plan`；Harness 原子地建立 Todo、计算全路径 ROI 并启动 Router 认可的只读子任务。

“每次都能规划”并不是模型的隐藏能力，而是系统提示、工具协议和运行时共同作用：Manager 根据用户消息一次性选择 `direct_manager`、`direct_worker` 或 `parallel`；`execute_plan` 负责可视化任务面、从真实父会话分叉 Pi SDK 子会话并等待结果。单个低风险 Worker 可以直返，只有并行或关键结果才进入 Manager 阶段验收。

### 3.3 Worker 安全边界

MVP 默认采用：

- 研究、搜索、代码阅读、测试分析等任务可并行；
- Worker 默认只读工作区并返回结构化结果或 patch 建议；
- 最终合成和实际写入由 Manager 完成；
- 后续再增加 git worktree / 临时目录隔离，允许并行写操作。

这可以避免多个便宜模型同时修改同一文件造成冲突，也减少低质量模型直接执行高风险操作的概率。

## 4. 成本与 ROI 路由

### 4.1 先过滤，再打分

候选模型先经过硬约束：

- 已认证且当前可用；
- 支持任务需要的上下文长度、图像、工具调用和推理能力；
- 在用户允许的 Provider/数据边界内；
- 未触发并发、限流或本地预算硬上限；
- 预测质量不低于任务的最低门槛。

然后计算软评分：

```text
utility(m, task)
  = predicted_quality
  - λ_cost    × predicted_cost
  - λ_latency × predicted_latency
  - λ_failure × predicted_failure
  + λ_cache   × cache_affinity
```

选择效用最高的模型；便宜模型预测质量不达标时，回退到 Manager 或更强的 Worker。高风险任务可以直接规定只能由指定模型执行或由 Manager 复核。

### 4.2 李雅普诺夫思想的轻量应用

把“预算超支压力”维护为虚拟队列：

```text
Q_budget(t+1) = max(0, Q_budget(t) + actual_cost(t) - allowed_cost(t))
```

路由时近似最小化：

```text
V × predicted_loss(task, model)
+ Q_budget(t) × predicted_cost(task, model)
+ Q_latency(t) × predicted_latency(task, model)
+ Q_failure(t) × predicted_failure(task, model)
```

- `V` 越大，系统越偏向质量；
- 预算队列越积压，系统越偏向便宜模型；
- 失败或延迟压力高时，相应模型会受到更大惩罚。

首版先使用规则和历史 EWMA 估计，不急于实现在线强化学习。等积累足够任务验收数据后，再引入 UCB/Thompson Sampling 做有限探索。

## 5. 用量与余额

HengFlow 应把额度信息分层展示：

| 类型 | 含义 | 展示方式 |
|---|---|---|
| authoritative | Provider 的账单/额度 API 返回 | 官方余额，带更新时间 |
| rate_limit | 响应头中的请求/token 剩余量与 reset | 当前限流窗口 |
| configured_budget | 用户设定的日/月预算减去本地观测消费 | 本地预算余额 |
| estimated | 根据本机历史和订阅窗口推算 | 明确标记“估算” |
| unknown | Provider 未公开或尚未接适配器 | 显示未知，不伪造数字 |

OpenAI 的组织级 Usage/Cost API 需要单独的 Admin API Key；普通推理 Key、ChatGPT/Codex 订阅登录不能一概视为可查询官方余额。其他 Provider 也通过独立 quota adapter 接入，不能假设协议统一。

建议记录的指标：

- input/output/cache token 与实际/估算费用；
- 首 token 和总时延；
- 重试、限流、失败原因；
- 子任务类型、选择理由和候选模型；
- Manager 是否接受、重做或升级；
- 每个模型的 EWMA 成本、成功率、p50/p95 时延、每成功任务成本；
- Provider 额度快照及其来源、可信度和新鲜度。

## 6. 分阶段路线图

### v0.5：原子执行与全路径 ROI

- Pi Package 骨架；
- Manager 配置和启动校验；
- 原子的 `execute_plan` 工具与三种执行模式；
- `passthrough` / `manager_synthesis` 返回策略；
- 规划、验收、上下文和期望返工的全路径成本；
- 继承 Manager 有效上下文的 Pi SDK Worker session；
- 基于静态价格、能力和阈值的 Router；
- SQLite telemetry；
- `/hf status`、`/hf models`、`/hf budget`；
- 手动/建议/自动三种路由模式。

验收标准：同一 Pi 登录状态下，Manager 能把一个可拆任务交给至少两种不同 Provider 的模型，并输出可解释的选型理由与调用成本。

### 下一阶段：DAG 调度与上下文视图

- Provider quota/rate-limit adapters；
- 失败重试、熔断和模型降级链；
- 依赖 DAG、阶段检查点和 ready queue；
- latest-turn / dependency-output / full-fork 上下文视图；
- 数据脱敏与外部 Provider 策略；
- 任务级成本上限和超限审批。

### v0.3：自适应经济路由

- 任务特征提取和成本/质量预测；
- Lyapunov 风格虚拟队列；
- 基于验收结果的在线更新；
- 有界探索；
- 仿真与离线回放，比较成本、成功率和时延。

### v1.0：产品化

- 可选的 `hengflow` 品牌 CLI，但底层仍调用 Pi runtime；
- 可视化费用与 ROI 面板；
- 多 Manager 角色与仲裁；
- worktree/容器隔离的写任务；
- 可分享的 Router policy 与 Provider adapter。

## 7. 关键风险

1. **认证耦合**：不得解析或持久化 Pi 的 OAuth token；只依赖公开运行时接口。
2. **额度不可得**：对订阅和第三方 Provider，官方剩余量可能没有公开 API，必须支持 unknown/estimated。
3. **Manager 自身成本**：拆分判断、提示和结果合成也消耗昂贵模型 token，需要记录 orchestration overhead。
4. **低价模型返工**：低价但高失败率可能降低 ROI，所以核心指标应是“每个成功任务成本”，而不是单次 token 单价。
5. **并发写冲突**：MVP 限制 Worker 写权限，之后用隔离工作区解决。
6. **Prompt injection 与数据外流**：外部 Provider 路由必须受敏感数据策略约束。

## 8. 下一步建议

进入实现前先完成两个小型技术验证（spike）：

1. 在 Pi Extension 内复用 ModelRuntime，分别创建 Manager/Worker 子会话，并确认 `/login` 后无需重启即可发现新凭证；
2. 对 OpenAI-compatible 的两个便宜模型完成一次结构化工具调用、用量采集、失败降级和取消。

两个 spike 通过后再固定 TypeScript 接口和 SQLite schema，可以避免在 Pi 接口边界尚未验证时过早搭建大量框架。

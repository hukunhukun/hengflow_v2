# v4 学习型 Manager（Learned Manager）设计与实施

## 目标

1. **不强制用户选择 Manager**：启动时只要求配置 **≥ 2 个模型**（含每百万 Token 价格），首位为**锚点**（兜底模型）。Manager 由系统每轮自动学习选择。
2. **可训练**：在训练 bench 上运行，独立 ledger 记录每次调用的真实 Token 消耗、成本与成功率，优化路由机制。
3. **可评测**：机制训练好之后，在 held-out bench 上与每个单模型基线比较耗费与得分。

## 核心机制（承接 v3 演进）

```
启动：/models 配置 ≥2 模型 + 价格（首位 = 锚点）
每轮：Manager 由 sticky Thompson 采样从池中选出（两级 bandit 第 1 级）
      → 选中的 Manager 产出 execute_plan
      → Harness 按净效用 U(w) + Beta-TS 路由 Worker（第 2 级）
      → 执行 → 外部判定 → 两级归因回流（含 verifier 校准）
```

### 第 1 级：Manager 选择（`src/manager-selector.ts`）

- **资格门禁**：`requiresWrite`/高风险轮次只允许 θ 样本充足的模型或锚点担任 Manager。
- **Thompson 采样**：每个候选 `θ ~ Beta(2q + successes, 2(1−q) + failures)`，q 为先验质量。种子化 RNG 保证 bench 可复现。
- **效用**：`U(M) = θ̃·V − c_plan(M) − c_switch(M)`，其中 `V = 锚点规划成本`（价值尺度），`c_switch = 会话历史 Token × 现任 Manager 缓存价`（前缀缓存损失）。
- **冠军-挑战者滞回**：挑战者效用必须超过现任冠军一个裕量才切换，抑制抖动。
- **锚点兜底**：池首位永久保留，学习永远不会让系统失去可用 Manager。

### 第 2 级：Worker 路由（Router v4，Phase 2 落地）

净效用 `U(w) = θ̃·V − [c_w·verbosity_w + (1−θ̃)·c_rework(M*) + c_verify(M*)]`，
硬安全门禁（write/high/synthesis → Manager）不变，成本常数按**本轮选中的 Manager** 计价。
预算层（λ/虚拟队列/准入）在 v4 中整体退役，`BudgetController` 保留但默认不注册任何窗口。

## 配置模型（Phase 0 已落地）

```jsonc
// ~/.hengflow/agent/config.json（v4 canonical）
{
  "modelsConfigured": true,
  "pool": [                          // ≥2；首位 = 锚点
    { "provider": "openai-codex",   "model": "gpt-5.6-sol",        "thinking": "high",
      "quality": 0.96, "inputUsdPerMillion": 5,    "cachedInputUsdPerMillion": 0.5,  "outputUsdPerMillion": 30 },
    { "provider": "deepseek",       "model": "deepseek-v4-flash",  "thinking": "max",
      "quality": 0.79, "inputUsdPerMillion": 0.14, "cachedInputUsdPerMillion": 0.0028,"outputUsdPerMillion": 0.28 },
    { "provider": "zai-coding-cn",  "model": "glm-5.3",            "thinking": "max",
      "quality": 0.87, "inputUsdPerMillion": 1.4,  "cachedInputUsdPerMillion": 0.26, "outputUsdPerMillion": 4.4 }
  ]
}
```

- 旧版 `manager` + `workers` 配置自动折叠为 pool（manager 为锚点），完全向后兼容。
- 运行时每轮 `config.manager` 被覆写为选中的 Manager——`router.ts` 的成本常数与
  `discoverWorkers` 的排除逻辑自动跟随，无需侵入式改造。

## Ledger v4（Phase 3 落地）

新增表（迁移式，不破坏现有数据）：

```sql
role_stats(provider, model, role, task_kind, complexity_bucket, samples, reward_sum,
           successes, ewma_cost_ratio, ewma_latency_ms, updated_at,
           PRIMARY KEY(provider, model, role, task_kind, complexity_bucket));
manager_decisions(turn_id, provider, model, sampled_utility, champion_before,
                  switched, reason_json, created_at);
turn_outcomes(turn_id, bench_id, task_id, manager_provider, manager_model,
              final_status, total_cost_usd, duration_ms, rework_count, created_at);
verifier_calibration(provider, model, leniency_ewma, pairs, updated_at,
                     PRIMARY KEY(provider, model));
```

`route_decisions.phase` 扩展 `"manager"` 值（已落地），Manager 选择决策留痕可 replay。

## Benchmark 协议

### 变体定义（`src/bench/schema.ts` 已落地基础部分）

| variant | 定义 | 用途 |
| --- | --- | --- |
| `single:<model>` | 池中某模型 vanilla 单 Agent（无 execute_plan 门禁） | **单模型基线** |
| `fixed_mapping` | 固定模型映射多 Agent | 固定路由基线 |
| `learned` | 两级 TS 路由（训练用） | 被测机制 |
| `learned_frozen` | 冻结 role_stats + 固定 seed（评测用） | 被测机制（无学习） |

### Bench 适配器与 Docker 需求

| bench | 类型 | 判定方式 | Docker |
| --- | --- | --- | --- |
| MBPP 子集 | 训练 | 本地 Python 执行测试（subprocess + 超时） | **不需要**（可选用于隔离） |
| HumanEval 子集 | 训练 | 同上 | **不需要** |
| HotpotQA 子集 | 训练 | 答案 exact-match / F1，纯文本 | **不需要** |
| SWE-bench Verified 子集 | **评测** | 官方 evaluator（按 repo@commit 构建环境） | **必需** |

**结论：Docker 只在 Phase 6（SWE-bench 评测）必需**；Phase 5 训练全部使用本地
Python（≥3.11）与文本判定，无需 Docker。若只做 MBPP/HotpotQA 的 held-out 评测
也可以无 Docker，但主张强度弱于 SWE-bench。

### 成本口径（`benchCallCostUsd` 已落地）

```
cost = Σ (input−cache_read)×in_price + cache_read×cache_price + output×out_price) / 1e6
```

- 价格表按 run 固定（用户在 pool 中配置的价格），与订阅扣费/配额无关，保证公平对比。
- `cache_write_tokens` 原样记录，不进主成本。
- 未定价模型的调用成本记 0 并列入 `unpriced` 警告清单。

### 运行隔离（沿 `docs/benchmark-swebench.md`）

每 run 独立 `HENGFLOW_AGENT_DIR` / `HENGFLOW_DATA_DIR`，产物目录：

```
bench/runs/<bench>/<task_id>/<variant>/<repeat>/
├── result.json      # BenchResultRecord
├── ledger.sqlite    # 本次 run 独立账本
├── session.jsonl
└── logs/
```

### 训练与评测协议

- **训练（Phase 5）**：MBPP + HumanEval + HotpotQA 子集（各 50–100 task × ≥2 repeat），
  variant=`learned`，seed 轮换、顺序随机化。调参只做离线 replay（不烧 API）。
- **达标判据**：Brier ↓、costBias→1.0±0.2、每模型样本无饿死、
  learned 在训练集 cost_per_resolved 优于 `single:锚点`（配对 bootstrap）。
- **评测（Phase 6）**：SWE-bench Verified 子集 + 一个非编码 bench；`learned_frozen`
  vs `single:<每个模型>` vs `fixed_mapping`；同价格表、同 judge、同超时、repeat ≥3；
  报告 `(mean_cost, resolved_rate)` Pareto + McNemar 配对检验。

### 公平性红线

1. `single:*` 基线不用 HengFlow 规划门禁（诚实 vanilla）；
2. judge 一律外部（测试执行 / 官方 evaluator），模型自评不计分；
3. 评测期冻结学习 + 固定 RNG seed；
4. 训练 / 评测 bench 完全不相交。

## 快速上手（bench）

```bash
npm run build
# 冒烟（1 task，~$0.05）
hengflow-v2 bench run --bench mbpp --limit 1 --variants learned
# 训练（学习跨 task 累积，ledger 共享）
hengflow-v2 bench run --bench mbpp --limit 50 --repeats 2 --variants learned --ledger session --out bench/train
# 冻结训练账本 + 单模型基线对比（评测）
hengflow-v2 bench run --bench mbpp --offset 50 --limit 20 --repeats 3 \
  --variants learned_frozen,single:openai-codex/gpt-5.6-sol,single:deepseek/deepseek-v4-flash,single:zai-coding-cn/glm-5.3 \
  --ledger frozen --frozen-ledger bench/train/ledger/usage.sqlite --out bench/eval
hengflow-v2 bench report --dir bench/eval
```

前置条件：本机 `python3` 可用（判定）、已在 TUI `/models` 配置 ≥2 模型含价格、`/login` 已认证。

## API Key 与成本时间线

| 阶段 | 需要 API Key？ | 预估成本 |
| --- | --- | --- |
| Phase 0–3（配置池化 / 选择器 / Router v4 / 学习闭环） | **否**（全部离线单测，合成账本） | $0 |
| Phase 4 冒烟（1 task × 各变体 × 1 repeat） | **是 ← 此刻配置** | <$1 |
| Phase 5 训练（3 bench × 50–100 task × 2–3 repeat） | 是 | ~$5–40（MBPP/HotpotQA 大部分轮次由便宜模型担任 Manager，成本可控；缩小 task 数/repeat 可线性下调） |
| Phase 6 评测（SWE-bench 3–10 instance × ≥3 repeat × 5 变体） | 是 | ~$10–60（gpt-5.6-sol 单价高，instance 数是主旋钮） |

**配置方式**：TUI 中对每个 provider 执行 `/login`（写入 `~/.hengflow/agent/auth.json`），
`hengflow-v2 auth status` 验证；bench runner 复用同一份认证，绝不复制进结果目录。

## 实验记录（v4 已完成）

| 实验 | 训练 | 评测（held-out） | 结论 |
| --- | --- | --- | --- |
| MBPP 50 题 | 98/100 @ $0.023/run | 38/40 @ $0.0269 vs deepseek 40/40 @ $0.0003 | 饱和负载：编排纯开销 |
| HumanEval+ 80 题 | 153/160 @ $0.0011/run；deepseek 295/295 轮当选 Manager（引导配额 2 轮解锁） | 76/86(88%) @ $0.0009 vs deepseek 79/86(92%) @ $0.0005 | 学习器正确收敛“全用 deepseek”，但架构无零开销坍缩；6 run 被综合步骤弄丢答案（待修：passthrough 加强/坍缩模式） |

已知待修：同质负载下应允许机制坍缩为单模型直答（性能下限 = 最优单模）；综合税（Manager 改坏 Worker 代码）。下一阶段：SWE-bench（Docker），见 `docs/v5-migration-guide.md`。

## TODO

- [x] P0 配置池化：`pool` canonical + 旧配置迁移 + `savePoolSelection`（`config.ts`）
- [x] P1a 种子化 RNG + Beta 采样（`src/rng.ts`）
- [x] P1b Manager 选择器：门禁 + TS + 滞回 + c_switch + 锚点兜底（`src/manager-selector.ts`）
- [x] P1c extension 接线：`enforcePool` 每轮选 Manager、决策落库 phase="manager"
- [x] P4a bench 基础 schema：价格表 / 成本重算 / 变体 / 汇总（`src/bench/schema.ts`）
- [x] P2 Router v4：净效用 U(w) + Beta-TS + Pareto 预过滤；budget/探索预算退出路由路径（`src/router.ts`，v4 语义 replay 测试就绪）
- [x] P3 ledger v4：`role_stats`（含 role 维度）/ `turn_outcomes` / `verifier_calibration`（leniency EWMA）+ Manager 轮级归因 + 验收折扣
- [x] P4b bench runner：headless 跑批 + 独立 agent/data 目录 + result.json + 冻结账本快照（`src/bench/runner.ts`）
- [x] P4c MBPP 适配器：数据集加载 / prompt / 本地 python 判定，含 test_setup_code（`src/bench/mbpp.ts`）
- [x] CLI：`hengflow-v2 bench run|report`（含 Wilson 区间汇总）
- [x] P4d 冒烟：learned 变体 1 task 端到端验证通过（两级选择 + 写入门禁 + 学习回流均生效）
- [ ] P1d `/models` 交互重写：池多选 + 每模型价格录入（当前沿用旧流程，产物已自动折叠为 pool）
- [ ] P4e 适配器扩展：humaneval / hotpotqa（训练集多样化）
- [ ] P5 训练跑批 + `bench/tune.ts` 离线 replay 调参（建议：`--ledger session --limit 50~100 --repeats 2`）
- [ ] P6 held-out 评测：SWE-bench（需 Docker）+ Pareto 报告 + 统计检验；README 更新

依赖顺序：P0 → P1 → P2 → P3 硬串行；P4b/c 只依赖 P0，可并行；P5 依赖 P3+P4；P6 依赖 P5。

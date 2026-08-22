# HengFlow v4 迁移与评测指南（SWE-bench / Docker 机器）

> 面向在另一台 PC 上从零接手 HengFlow 的工程师。读完本文即可：理解机制 → 配置环境 →
> 复现已有结论 → 在 SWE-bench（Docker）上完成新一轮训练与评测。

---

## 1. HengFlow 是什么（5 分钟版）

成本感知的多模型 Multi-Agent Runtime：**不固定 Manager**，每轮由学习机制从 ≥2 个模型的池中
自动选择 Manager 和 Worker，按"净效用"（成功率 × 任务价值 − 全路径成本）路由，并用外部
判定结果持续学习各模型的真实成功率/成本。

### 两级路由（v4 核心）

```
用户请求（一轮）
 ├─ 第 1 级：Manager 选择（src/manager-selector.ts）
 │    Thompson 采样 Beta 后验 + 冠军-挑战者滞回 + 写入门禁（风险分层）+ 锚点兜底
 │    · 引导配额：样本 <3 的挑战者最多 2 次探索性写入轮，一次失败即吊销
 │    · 决策落库 route_decisions.phase='manager'
 ├─ Manager 产出 execute_plan（DAG）
 ├─ 第 2 级：Worker 路由（src/router.ts）
 │    U(w) = θ̃·V − [c_w·成本倍率 + (1−θ̃)·返工成本(M*) + 验收成本(M*)]
 │    θ̃ ~ Beta（分桶后验），V 默认 = Manager 直做成本；Pareto 预过滤；单次 fallback
 │    硬门禁不变：requiresWrite / risk:high / synthesis → Manager
 └─ 执行 → 阶段屏障 → （训练时）外部判定真值回流账本
```

### 学习账本（SQLite，`$HENGFLOW_DATA_DIR/usage.sqlite`）

| 表 | 作用 |
|---|---|
| `model_calls` | 每次调用的 token/成本/成败（唯一成本事实来源） |
| `route_decisions` | 全部路由决策（phase=manager/plan/launch，带任务特征） |
| `role_stats` | **第 1 级**：模型 × role 的成功率（manager 池后验） |
| `model_task_stats` | **第 2 级**：模型 × kind × 复杂度桶的后验质量/失败率/成本倍率 |
| `turn_outcomes` | 轮级结果（bench 判定真值） |

**关键约束**：学习统计按 `(model × kind × bucket)` 分桶，**不跨 bench 域迁移**。
HumanEval+ 学到的桶在 SWE-bench 上无效 → 新 bench 必须重新训练。

### 已验证的结论（迁移前必读）

| 实验 | 结果 | 结论 |
|---|---|---|
| MBPP（饱和）50题 | learned 98% @ $0.023；deepseek 单模 100% @ $0.0003 | 同质负载上编排是纯开销 |
| HumanEval+（轻度分化）80题训练/44题评测 | learned_frozen 88% @ $0.0009；deepseek 92% @ $0.0005 | 学习器正确收敛到"全用 deepseek"（295/295 轮），但架构不允许零开销坍缩；且综合步骤弄丢 6 run 答案（−4pp） |
| 已知问题 | 综合税：Manager 改写 Worker 代码时弄丢/改坏（4 题） | 待修：passthrough 加强 / 坍缩模式 |

**SWE-bench 的意义**：真实 repo 修复预计模型间失败率强分化（deepseek ~10-30%，gpt ~40-50%）
+ 高返工成本 → 正是 `U(w)` 失败率项的套利主场。这是前两个 bench 测不出的。

---

## 2. 环境搭建（新 PC）

```bash
# Node ≥ 22.19, Python ≥ 3.9（判定用）, Docker（SWE-bench 专用）
git clone https://github.com/hukunhukun/hengflow_v2.git
cd hengflow_v2 && git checkout hengflow-v3
npm install && npm run build && npm test        # 应 83/83 通过
```

### 认证与模型配置（一次性）

```bash
hengflow-v2            # 启动 TUI
/login                 # 逐个登录 provider（openai-codex 走 OAuth；deepseek/zai 走 API Key）
/models                # 配置模型池：≥2 个模型 + 每个的每百万 Token 价格（USD）
hengflow-v2 auth status  # 验证三个 provider 都 logged in
```

- `/models` 保存后 `~/.hengflow/agent/config.json` 出现 `pool`（首位 = 锚点兜底）
- **价格必须填**：bench 成本全部按此表重算；缺价 = 成本记 0 = 报告无效
- 参考价格（本机用的）：gpt-5.6-sol $5/$0.5/$30，glm-5.3 $1.4/$0.26/$4.4，deepseek-v4-flash $0.14/$0.0028/$0.28（input/cacheRead/output 每百万）

**注意**：zai 网关可能把响应回报成别名模型名（曾见 glm-5.3 → "gpt-5.5"）。v4 已改为按
路由配置名记账，若 report 出现"未定价警告"，检查网关别名。

### 验证管道（不花大钱）

```bash
hengflow-v2 bench run --bench mbpp --limit 1 --variants learned --out bench/smoke
# 预期：✓ ~$0.01-0.03；然后
hengflow-v2 bench run --bench humanevalplus --limit 1 --variants single:deepseek/deepseek-v4-flash --out bench/smoke
```

---

## 3. Bench 体系（src/bench/）

| bench | 数据 | 判定 | Docker |
|---|---|---|---|
| mbpp | 官方 jsonl（在线拉取） | 本地 python 跑 test_list 断言 | 否 |
| humanevalplus / mbppplus | `bench/data/*.jsonl`（已入库） | candidate vs canonical 对照 base+plus 输入 | 否 |
| swebench | 官方 instances（新机器按 §5 拉取） | **官方 evaluator**（容器内跑 FAIL_TO_PASS/PASS_TO_PASS） | **是** |

### 变体（公平对比的核心）

| variant | 行为 |
|---|---|
| `learned` | 全机制 + 学习写入（**仅训练用**） |
| `learned_frozen` | 拷贝训练账本快照 + `freezeLearning`（抑制一切学习写入）+ 固定 seed → **评测用，路由逐位可复现** |
| `single:<provider/model>` | vanilla 单 Agent：无规划门禁、无编排工具、无 Worker（诚实基线） |
| `fixed_mapping` | 固定 kind→模型映射（可选基线） |

### 成本口径

```
cost = Σ (input−cacheRead)×in价 + cacheRead×cache价 + output×out价) / 1e6
```
- 每 run 独立 `HENGFLOW_AGENT_DIR`（写冻结配置）+ `HENGFLOW_DATA_DIR`（独立账本）
- 凭证用 symlink 指向 `~/.hengflow/agent/auth.json`，不复制
- cache_write token 只记录不计价

### 训练时的真值回流（重要机制）

`applyJudgeGroundTruth()`（runner）：外部 judge 结果以 confidence=1.0 写入共享账本——
更新 worker 的 `model_task_stats`（分桶）和 manager 的 `role_stats`；进程内弱信号
（stopReason 等）在 bench 模式下全部抑制，避免双计。这就是"训练"的全部含义：
**不训模型权重，只训路由统计**。

---

## 4. 已有实验复现（可选）

本机结果（分支内已含训练/评测产物目录已被 gitignore，结论数字如下）：

```bash
# HumanEval+ 训练（~80min, ~$2）
hengflow-v2 bench run --bench humanevalplus --limit 80 --repeats 2 \
  --variants learned --ledger session --out bench/he-train
# 评测（~3h, ~$3）：learned_frozen 88%@$0.0009 vs deepseek 92%@$0.0005
hengflow-v2 bench run --bench humanevalplus --offset 80 --limit 44 --repeats 2 \
  --variants learned_frozen,single:openai-codex/gpt-5.6-sol,single:deepseek/deepseek-v4-flash,single:zai-coding-cn/glm-5.3 \
  --ledger frozen --frozen-ledger bench/he-train/ledger/usage.sqlite --out bench/he-eval
hengflow-v2 bench report --dir bench/he-eval
```

训练后检查学习状态：
```bash
node -e '
const {DatabaseSync} = require("node:sqlite");
const db = new DatabaseSync("bench/he-train/ledger/usage.sqlite", {readOnly: true});
console.log(db.prepare("SELECT provider, model, samples, successes FROM role_stats WHERE role=\u0027manager\u0027").all());
console.log(db.prepare("SELECT provider, model, task_kind, samples, semantic_successes FROM model_task_stats ORDER BY samples DESC LIMIT 8").all());
db.close();'
```

---

## 5. SWE-bench 训练与评测（Docker 机器的新任务）

### 5.1 回答"是否需要学习 / 评测时路由是否变化"

- **需要重新训练**：学习分桶不跨域迁移；SWE-bench 的 coding/high 桶是冷启动。
  训练 = `learned` + `--ledger session`，判定真值持续回流。
- **评测期间路由绝不变化**：`learned_frozen` + `--ledger frozen --frozen-ledger <快照>`
  → 账本只读、学习写入抑制、seed 固定。这是协议红线，代码已强制。
- 训练/评测 instance 必须**不相交**（用 --offset 切分）。

### 5.2 需要新写的代码（本机未完成，估计 1-2 天）

`src/bench/swebench.ts` 适配器，接口契约与 mbpp/evalplus 相同（实现 `BenchTask`：
`buildPrompt()` + `judge(answer)`），要点：

1. **数据**：`https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite`（300 instance），
   取 `instance_id / repo / base_commit / problem_statement / patch / FAIL_TO_PASS / PASS_TO_PASS`。
2. **工作区**：每 run 在容器内 `git clone <repo> && git checkout <base_commit>`，
   把 problem_statement（含复现测试失败信息）作为 prompt。
3. **判定**：模型输出 patch（要求答案含 ```diff 块）→ 容器内 `git apply` → 跑官方
   evaluator（`swebench.harness.run_evaluation`，锁版本）→ `resolved=1` 才算成功。
4. **runner 复用**：`runBench()` 已支持 `benchId` 分发、隔离目录、成本重算、
   真值回流——适配器只需实现任务加载与判定两件事。
5. **超时**：单 run 建议 20-30 分钟（构建镜像 + 修复 + 评测）。
6. 训练切片建议 40-50 instance × 1 repeat（SWE-bench 单 run $0.3-1，先冒烟 2-3 个）。

### 5.3 执行序列（新机器上的完整命令）

```bash
# 0) 冒烟（1 instance × learned，验证容器/判定/记账全链路）
hengflow-v2 bench run --bench swebench --limit 1 --variants learned --out bench/sw-smoke

# 1) 训练（40-50 instance，学习真值回流）
hengflow-v2 bench run --bench swebench --limit 50 --repeats 1 \
  --variants learned --ledger session --out bench/sw-train

# 2) 评测（held-out × 2 repeat × 4 变体；冻结快照，路由不变）
hengflow-v2 bench run --bench swebench --offset 50 --limit 20 --repeats 2 \
  --variants learned_frozen,single:openai-codex/gpt-5.6-sol,single:deepseek/deepseek-v4-flash,single:zai-coding-cn/glm-5.3 \
  --ledger frozen --frozen-ledger bench/sw-train/ledger/usage.sqlite --out bench/sw-eval

# 3) 报告
hengflow-v2 bench report --dir bench/sw-eval
```

### 5.4 看什么指标下什么结论

| 观察 | 结论 |
|---|---|
| learned_frozen 解决率 ≈ gpt 基线，成本显著低 | **机制成立**：路由在分化负载上套利成功（核心假设验证） |
| learned ≈ deepseek 基线 | 负载分化仍不足，或 SWE-bench Lite 对三模型同难 |
| learned < 最优单模 | 查失败 run 的 judgeLog：是能力缺口（两变体同败）还是流程丢失（综合税）→ 后者是 bug |
| role_stats 里 Manager 分布 | 学习器是否真的按难度轮换 Manager（分化负载的预期行为） |

预算参考：训练 ~$25-50，评测 ~$25-60（instance 数是主旋钮）。

---

## 6. 常见坑（本机踩过的）

1. **网关别名**：响应里的 model 名 ≠ 配置名 → 按回报名记账会丢价格。已修（按路由名记）。
2. **判定器必须先自测**：用 canonical solution 喂 judge 必须 100% pass（`filterSelfConsistent`
   会剔除数据集自身不 sound 的题）。换任何新 bench 先做这一步。
3. **共享账本归因**：session 模式下成本必须按 run 前的 `maxCallId` 过滤，否则算出累积值。
4. **completion 式答案不能 trim**：HumanEval 类 body 依赖前导缩进，`extractPythonCode`
   保留原样（已修）。
5. **python 字面量**：`Infinity/NaN/true/null/大整数` 必须转 Python 字面量（已修）。
6. **proxy**：HTTPS_PROXY 已设时数据集拉取走代理；cli 内部会自动 `configureNetworkProxy`。

## 7. 目录地图

```
src/
├── manager-selector.ts   # 第 1 级：Manager 选择（TS + 门禁 + 引导配额）
├── router.ts             # 第 2 级：净效用 + Beta-TS + Pareto
├── extension.ts          # 接线：每轮选 Manager、工具门禁、bench 变体行为
├── ledger.ts             # SQLite 学习账本（v4 表结构）
├── rng.ts                # 种子化 RNG（Beta 采样，评测可复现的根基）
├── bench/
│   ├── schema.ts         # 变体/价格表/成本重算/汇总
│   ├── runner.ts         # headless 跑批 + 隔离 + 真值回流
│   ├── mbpp.ts / evalplus.ts   # 两个已验证适配器
│   └── swebench.ts       # ← 新机器要写的（§5.2）
└── test/                 # 83 个测试
docs/
├── v4-learned-manager.md # v4 设计文档
└── v5-migration-guide.md # 本文
```

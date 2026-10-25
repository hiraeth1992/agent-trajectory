# Agent Trajectory 代码重评与下一阶段升级清单

> 重评日期：2026-10-25
> 代码基线：`HEAD=28ffb15` 加当前工作区全部 tracked/untracked 变更
> 对标规格：
> [行业评测实践对标](./AGENT-EVALUATION-BENCHMARK-2026-10-24.md)、
> [DeepSeek Harness 底层实现对比](./DEEPSEEK-HARNESS-IMPLEMENTATION-COMPARISON-2026-10-24.md)

## 结论

当前代码已经跨过“只有单会话评测”的阶段。昨日建议中的 Evaluation Contract、
Facts Quality、Requirement/Chain、合成 Gold、Process Check、Batch EvaluationRun、
baseline diff、真实轨迹冻结、双 Reviewer、Kappa、裁决和评测中心都已形成真实源码与测试，
不能再列为“缺失”。

底层四项高价值修正也已完整落地：

- DSH `image/offload` 只改变 model context，保留 durable transcript；
- `assistant/live-chunk` 已从持久事件词表移除并有固定上游快照门禁；
- turn 汇总已从重复全表扫描改为一次分组；
- `SourceRegistry.load()` 已具备同会话 single-flight。

新的瓶颈转为**评测结果是否真的可信、可复现、可比较**。当前最需要先修的不是再加模块，
而是：

1. Run/Dataset/Gold 的内容身份没有完整进入 run identity；
2. exact、precision/recall 和 baseline diff 口径可能过度乐观或方向错误；
3. Facts Quality 尚未消费已知但未投影的 coverage gap；
4. 合成 12-case 只能证明契约回归，不能证明 Evaluator 对真实轨迹准确；
5. Requirement/Chain 与 Process Check 仍是保守雏形；
6. “评测中心”目前主要是标注工作台，Run、裁决、diff、门禁仍停留在 CLI。

建议的新顺序是：

```text
P0 评测身份与统计正确性
  → P1 语义、Process Check 与产品闭环
  → P2 badcase/采纳闭环和性能架构
```

## 重评范围与验证

### 审查范围

相对 `HEAD=28ffb15`：

- tracked diff：28 个文件，约 `+1429/-57`；
- untracked 新模块：`server/evaluation/*`、评测/标注类型、Evaluation Center、
  Annotation Workspace、Process Check 和 10 组专项测试；
- 评测/标注相关新增代码与测试约 15 个文件、5611 行；
- 当前重评报告本身是用户已有未提交文件，本轮只重写该文件。

### 实际验证

| 验证 | 当前结果 |
| --- | --- |
| `npm test` | 45 个测试文件、345 项测试全部通过，15.68 秒 |
| `npm run typecheck` | 通过 |
| `npm run build` | Web 与 CLI 生产构建通过 |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm pack --dry-run --json` | 压缩 300,965 bytes；解包 1,140,633 bytes；13 个文件 |
| `npm run doctor` | DSH 13、Codex 40、ZCode 14 个会话均 available |
| `git diff --check` | 通过 |

Codex 当前会附带“协议探测达到扫描上限”的提示，但状态已正确保持 `available`，不再把纯
扫描未完成泛化为兼容性 degraded。

### 验证能证明与不能证明的内容

这些结果能证明：

- 当前实现编译、打包和内部契约测试自洽；
- 私有校准文件权限、manifest/case hash、Reviewer 隔离和悬空 evidence 门禁有测试；
- 三来源真实读取仍可用。

这些结果不能证明：

- `local-trajectory-v1` 与真实人工判断一致；
- 12 条合成 case 足以代表生产分布；
- baseline diff 当前一定正确表达质量改善/退化；
- Requirement/Chain 启发式能处理复杂真实对话；
- Process Check 已在真实诊断链路持续运行。

### P0 口径最小复现

本轮使用当前源码和内置 dataset 做了只读最小复现：

| 复现场景 | 当前实际结果 |
| --- | --- |
| `zcode-verified-success` 只声明 2 个 expected criterion，实际输出 5 个 | `case.exact=true` |
| 只把该 case 的 Gold `outcome` 从 `pass` 改为 `warning` | runId 不变 |
| baseline `warning`、candidate `fail`，两边 mismatch 数均为 1 | case 被列为 `unchanged`，但 `changedCriteria` 显示退化 |
| expected `fail`、actual `insufficient_evidence` 且 `denominatorEligible=false` | 仍计为 1 个 FN，recall 从 1 降为 0.8333 |

这些不是推测，而是当前实现的直接输出；它们构成本报告 P0-1～P0-4 的验收基线。

## 已完成能力

### 1. 来源事实与性能修正

| 旧建议 | 当前证据 | 状态 |
| --- | --- | --- |
| DSH `image/offload` | `src/projector.ts:427-519, 1276-1402`；上游同构校验；多 target、连续 offload、tool result、非法 target、脱敏测试 | 完整 |
| 持久事件词表 | `KNOWN_EVENT_TYPES` 无 `assistant/live-chunk`；`tests/projector.test.ts:12-93,1297` 固定上游快照 | 完整 |
| turn 线性分组 | `src/projector.ts:1343-1350` 使用 `recordsByTurn` | 完整 |
| Registry single-flight | `server/sources/registry.ts:164-210`；并发/失败清理测试 | 完整 |
| Codex 探测分级 | `server/sources/codex.ts` 不再把 bounded scan 当 degraded；真实 doctor 为 available + 提示 | 完整 |
| 历史 DSH 协议可发现 | `server/sources/dsh.ts:39,101-129,294-346` 能探测 vN 并明确 blocked/degraded | 部分：可发现，但 list 仍只读取 v4 |

### 2. Evaluation Contract 与事实门禁

`src/evaluation-types.ts` 已建立：

- `pass / fail / warning / not_applicable / insufficient_evidence /
  evaluator_error / out_of_scope`；
- attribution、denominator、evidence boundary、blockedBy；
- live/frozen Target；
- Requirement、Chain、Dataset、Run、Diff、人工标注和裁决协议。

`src/trajectory-evaluation.ts` 已实现：

- 五维分析到 `local-trajectory@1` 的映射；
- protocol、未知事件、运行态、截断、工具缺结果、trace/usage capability 的 Facts Quality；
- 阻断项不计入 Agent 质量分母；
- facts hash；
- 保守 RequirementResult 与 ChainResult。

状态：**最小合同完整落地，语义和覆盖门禁仍需加强。**

### 3. Dataset、Run、校准和 Process Check

已实现：

- 12 条三来源合成冻结 case；
- calibration/regression split；
- 本地 JSON/Markdown EvaluationRun；
- stable runId；
- precision/recall、FP/FN、N/A/insufficient/error 统计；
- baseline 可比性检查与 case/criterion diff；
- 6 条 `trajectory-diagnosis` Process Check；
- 三来源真实轨迹的稳定冻结、匿名化和隐私审计；
- Reviewer A/B 盲态模板；
- exact agreement、Cohen's Kappa、分歧列表；
- 独立 adjudication；
- manifest、case、annotation、adjudication 与 evidence fail-closed；
- CLI `evaluate`、`calibrate prepare/agreement`。

状态：**基础设施完整；真实 Gold 尚未完成，统计与版本身份存在 P0 缺口。**

### 4. 评测中心与人工标注

已实现：

- 顶层“会话分析 / 评测中心”导航；
- 只发现 `<data-dir>/calibration/*` 且隐私审计通过的数据集；
- Reviewer A/B 独立进度；
- 中文标注表单与英文协议值；
- record 概览和按需详情；
- criteria、requirements、chain 的 evidence 选择；
- dataset hash + annotation revision 乐观锁；
- 符号链接拒绝、真实文件门禁、私有 `0600` 写入；
- 未保存修改的切换/退出确认。

状态：**标注工作台完整；评测中心整体流程仍不完整。**

## 昨日升级项完成度

### Evaluation Loop 12 项

| 旧建议 | 当前状态 | 重评 |
| --- | --- | --- |
| P0-1 Evaluation Contract | 完整 | 类型、verdict、attribution、denominator、evidence boundary 已落地 |
| P0-2 Facts Quality | 部分 | 有主要门禁，但遗漏 projection coverage gap 和更细 context scope |
| P0-3 Requirement/Chain | 部分 | 有保守结构；语义仍主要靠 user-turn 与关键词 |
| P0-4 Gold Benchmark | 部分 | 合成 12-case 完整；真实双标/裁决基础设施完整，但尚无首批人工 Gold |
| P1-1 Process Check | 部分 | 6 条可执行检查存在，但未接入真实诊断事件与 EvaluationRun |
| P1-2 Batch EvaluationRun | 完整 | Dataset、Run、JSON/Markdown、split CLI 已落地 |
| P1-3 Baseline/Candidate | 部分 | 有严格可比性和 diff，但 identity、方向和门禁口径需修 |
| P1-4 Evaluator Registry | 部分 | 有两个 evaluator id/version；无统一 registry、contract hash、calibration/gate metadata |
| P2-1 Badcase Casebook | 缺失 | 能准备真实候选，但没有诊断结果一键回流、去重与生命周期 |
| P2-2 采纳账本 | 缺失 | OptimizationSuggestion 仍无 accepted/rejected/run/result |
| P2-3 外部 Run 导入 | 缺失 | 仍无不可信外部 EvaluationRun adapter |
| P2-4 AI Judge 稳定性 | 部分 | 事实门禁增强；无重复稳定性、顺序偏置、quote grounding 和模型校准 |

统计：**完整 2，部分 7，缺失 3，不再适用 0。**

### DeepSeek Harness / 底层 10 项

| 旧建议 | 当前状态 | 重评 |
| --- | --- | --- |
| P0-1 `image/offload` | 完整 | 与固定上游 projection 同构 |
| P0-2 持久事件词表 | 完整 | 有固定 commit 快照门禁 |
| P1-1 真增量 reducer | 缺失 | Worker append 后仍完整 replay |
| P1-2 turn 线性聚合 | 完整 | 一次 Map 分组 |
| P1-3 delta 按变化规模 | 部分 | record upsert/delete 已有；projection 与 recordOrder 仍全量 |
| P1-4 load single-flight | 完整 | 同 key 并发共享；失败可重试 |
| P1-5 历史 generation 可发现 | 部分 | probe 可诊断 vN；list/load 仍只接受 v4 文件 |
| P2-1 zstd frame 增量 | 缺失 | 压缩文件变化后仍整流解压 |
| P2-2 record cache 旧版本回收 | 缺失 | cache key 含状态/summary，旧版本仍可能累积 |
| P2-3 增量估重 | 缺失 | Worker 每次 `JSON.stringify` 完整 state |
| P2-4 Worker 排队观测 | 缺失 | 有总往返性能测试，无 queue/payload/append p50/p95 |

统计：**完整 4，部分 2，缺失 5。**
说明：底层表实际包含 11 条建议；原摘要把 record cache 与估重合并为一项，因此标题称
“10 项”。本表按可独立实施项列出。

## Standards / Spec 双轴审查

### Standards

没有发现违反以下仓库硬标准的已证实问题：

- source adapter 保持只读；
- loopback 与 opaque routing 未放宽；
- 真实轨迹候选默认写入私有目录并 `.gitignore`；
- record 的 raw/searchText 被禁止进入候选；
- home path、credential shape 和 identity mismatch 有隐私审计；
- Reviewer 文件互相隔离；
- manifest/case 使用 hash，annotation 使用 revision 乐观锁；
- 关键行为有 synthetic test。

代码异味判断：

- `server/evaluation/calibration.ts` 已超过 1500 行，同时承担匿名化、抽样、manifest、
  privacy audit、annotation parser、agreement、adjudication 和 dataset 编译，属于
  **Divergent Change** 候选；
- `EvaluationCenter.tsx` 把样本数硬编码成 30，而 CLI 支持 3～120，属于小型
  **Primitive Obsession / duplicated truth**；
- annotation 完整性在前端与服务端有两套实现，未来容易漂移，属于 **Duplicated Code**。

这些是可维护性风险，不是当前安全边界违规。

### Spec

规格大部分最小切片已经落实；实质缺口集中在：

1. Gold/Run 身份没有包含裁决内容 hash；
2. exact 和 precision/recall 允许部分标签产生过度乐观统计；
3. baseline diff 以 mismatch 数而非 verdict 风险方向判断；
4. Process Check 没有接入真实诊断链；
5. Requirement/Chain 仍是启发式；
6. 真实人工 Gold 尚未完成；
7. Evaluation Center 只完成标注阶段。

最严重缺口是第 1～3 项，因为它们会让一个格式完整的报告给出错误的“可比、100% exact、
无 FP/FN”结论。

## 升级点清单

## P0：先修评测身份与统计正确性

### P0-1：给 Dataset、Gold 和 Run 建立完整内容身份

#### 原因

当前：

- `EvaluationDataset` 只有 `id/version`，没有 dataset hash 或 adjudication hash；
- `runId()` 只 hash 实际输出和 facts，不 hash Gold 期望；
- CLI 报告文件名使用该 runId；
- baseline 可比性只检查 dataset/evaluator/facts 版本与 Target fingerprint。

如果裁决标签或 expected evidence 改变，但人工没有同步提升 dataset version：

- runId 可能不变；
- 同名报告可能被覆盖；
- baseline 仍可能被判断为可比；
- “准确率变化”无法归因于代码还是 Gold 改动。

#### 升级方案

新增：

```ts
interface EvaluationDataset {
  schemaVersion: 1
  id: string
  version: string
  contentHash: string
  goldHash: string
  cases: FrozenEvaluationCase[]
}

interface EvaluationRun {
  datasetHash: string
  goldHash: string
  evaluatorBuildHash: string
  contractHash: string
  contextPolicyHash: string
}
```

规则：

- `contentHash` 覆盖 case identity、split、Target fingerprint、case payload hash；
- `goldHash` 覆盖 expected verdict/attribution/evidence、Requirement、Chain；
- `evaluatorBuildHash` 至少绑定 Git commit 或 evaluator source digest；
- runId 和报告文件名包含上述 hash；
- baseline 比较要求相同 dataset/gold/contract/context；允许 evaluator build 不同，以支持
  baseline/candidate。

#### 修改落点

- `src/evaluation-types.ts`
- `server/evaluation/runner.ts`
- `server/evaluation/calibration.ts::loadAdjudicatedDataset`
- `server/evaluation/gold-dataset.ts`
- `server/cli.ts::evaluate`
- `tests/evaluation-runner.test.ts`
- `tests/evaluation-calibration.test.ts`

#### 验收

- 只改一个 Gold verdict，runId/goldHash 必须变化；
- 不改 dataset/gold、只改 evaluator build，可比较；
- 改 Target 或 context policy，拒绝比较；
- 同名文件不得静默覆盖语义不同的 Run。

### P0-2：修正 exact 与 Gold 完整性口径

#### 原因

内置 12-case 的多数 case 只声明部分 criterion。`runEvaluationDataset()` 只比较已声明项，
但 `case.exact=true`，最终报告显示 `12/12 (100%)`。

这只能证明“已声明断言通过”，不能证明：

- 五个 criterion 全部正确；
- Requirement/Chain 全部正确；
- Evaluator 与完整 Gold 100% 一致。

#### 升级方案

将数据集显式分成两类：

```ts
goldCompleteness: 'partial-contract' | 'full-gold'
```

- partial-contract：报告 `assertionsPassed/assertionsTotal`，禁止叫 exact agreement；
- full-gold：必须为每个 criterion、Requirement 和 Chain 提供完整期望，才允许计算
  case exact；
- 内置 12-case 改名为 contract regression dataset；
- 只有 adjudicated real dataset 可称 Gold。

#### 修改落点

- `src/evaluation-types.ts`
- `server/evaluation/gold-dataset.ts`
- `server/evaluation/runner.ts`
- `server/cli.ts`
- README 与评测中心文案

#### 验收

- 缺任何 required expectation 的 case 不能进入 exact 分母；
- 内置数据集报告不再显示“Gold 100%”；
- 完整人工 Gold 的 exact 逐项包含 criteria、Requirement 和 Chain。

### P0-3：修正 precision/recall、FP/FN 与 denominator

#### 原因

当前只把 `fail/warning` 视为 issue，其余状态都等价为“非 issue”。于是：

- expected issue + actual `insufficient_evidence` 会计为 FN；
- actual `evaluator_error` 可能计为 FN；
- `not_applicable/out_of_scope` 会混入分类判断；
- denominatorEligible 没有用于 precision/recall 的样本选择。

这会把来源缺证据或 Evaluator 故障误写成 Agent 漏判。

#### 升级方案

建立显式 confusion eligibility：

```ts
function issueClass(result): 'positive' | 'negative' | 'abstain' | 'error'
```

- positive：fail/warning；
- negative：pass；
- abstain：not_applicable/insufficient_evidence/out_of_scope；
- error：evaluator_error；
- precision/recall 只在 expected/actual 都 eligible 时计算；
- 单列 abstention、coverage、evaluator error；
- 同时输出宏/微平均和每 criterion 指标。

#### 修改落点

- `server/evaluation/runner.ts:73-190`
- `src/evaluation-types.ts::EvaluationRun.aggregate`
- `evaluationRunMarkdown()`
- `tests/evaluation-runner.test.ts`

#### 验收

- insufficient evidence 不产生 FP/FN；
- evaluator error 不进入质量 confusion matrix；
- 报告明确 eligible N、abstain N、error N；
- 每 criterion 的 precision/recall 可核查。

### P0-4：让 baseline/candidate 真正表达质量方向

#### 原因

当前：

- evaluator version 不同直接拒绝比较；
- evaluator version 又是硬编码 `"1"`，代码变更可能不升版本；
- improved/regressed 只看 mismatch 数量；
- 相同 mismatch 数但 `pass→fail` 会被列为 unchanged；
- `insufficient→pass` 与 `fail→warning` 没有风险方向；
- 没有 required criterion、正控、abstain、成本预算门禁。

#### 升级方案

比较身份与质量分离：

- 同一 contract/dataset/gold/context 下，允许 evaluator build A/B；
- 定义 verdict 风险矩阵，而不是简单线性总分；
- case 状态：improved/regressed/mixed/unchanged/inconclusive；
- required criterion 退化直接 fail；
- 单列 positive-control FP、issue-set recall、abstention 变化；
- 加入 duration/Token/tool-call 预算；
- diff 写入明确 gate decision 和 reasons。

#### 修改落点

- `src/evaluation-types.ts::EvaluationRunDiff`
- `server/evaluation/runner.ts::compareEvaluationRuns`
- `server/cli.ts::evaluate`
- 新增双侧 dataset metadata
- Evaluation Center 的 Run diff UI

#### 验收

- 同 mismatch 数的 `pass→fail` 必须 regressed；
- evaluator build 不同但 contract 相同可以比较；
- Gold 或 Target 不同必须拒绝；
- 总体提升但 required criterion 退化时 gate 失败；
- issue set 改善但正控误伤时标记 suspected overfit。

## P1：补齐语义、Process Check 与产品闭环

### P1-1：Facts Quality 纳入完整 projection coverage

#### 原因

当前只检查 `unknownEventTypes`。已知但 disposition 为 `raw-only/unsupported` 的事件，或
`coverageSummary.gap > 0`，没有进入质量门禁。

Judge 可能在“事件已知但没有语义投影”的事实包上给出 outcome/reliability 结论。

#### 升级方案

- 按 event type、disposition 和受影响 criterion 建 coverage policy；
- required semantics gap 为 blocking；
- relation-only/raw-only 根据 evaluator contract 决定 warning 或 blocking；
- quality report 输出 consumed/total/gap；
- context scope 从固定 `session` 扩展到 evaluator 声明的 turn/step/span/tool-call。

#### 修改落点

- `src/trajectory-evaluation.ts::buildFactsQualityReport`
- `src/evaluation-types.ts::FactsQualityReport`
- `src/projector.ts` coverage 元数据
- `tests/trajectory-evaluation.test.ts`

#### 验收

- 已知但 unsupported/raw-only 的 required fact 能短路相关 criterion；
- 不相关 raw-only 不误伤；
- quality hash 随 coverage policy/事实变化；
- 报告可解释是“没发生”还是“没投影”。

### P1-2：升级 Requirement/Chain 的语义边界

#### 原因

当前 Requirement：

- 基本按一个 user/steering record 生成一项；
- 同一消息内多个并列要求不会拆分；
- 单一 active requirement 直接由 overall outcome 映射为 implemented/unimplemented。

当前 Chain：

- 用户后续说“继续/按方案”即可判 normal；
- 这证明用户引用了前文，不证明 Agent 实际承接；
- `incorrect` 几乎没有生成路径。

#### 升级方案

- 将“候选 Requirement”和“已验收 Requirement”分层；
- code 层只做显式列表、编号和 supersede 状态机；
- 复杂拆解由人工 Gold 或受限 semantic evaluator 提供；
- RequirementResult 必须有逐项产物/验证证据，不由 overall outcome 反推；
- Chain 同时检查用户要求、assistant/工具后续使用和最终状态；
- normal 至少需要“前序事实 + 后续使用”两端 evidence；
- 无两端证据返回 insufficient，不返回 normal。

#### 修改落点

- `src/trajectory-evaluation.ts:304-475`
- `src/objective-synthesis.ts`
- `src/annotation-types.ts`
- Annotation Workspace requirement/chain 辅助提示

#### 验收

- 单条消息两个要求可独立标注；
- “继续”但 Agent 未使用方案时不是 normal；
- 合法目标替换不判丢失；
- 用户明确纠错与客观错误承接可区分 missing/incorrect。

### P1-3：把 Process Check 接入真实诊断与 EvaluationRun

#### 原因

`evaluateTrajectoryDiagnosisProcess()` 当前只在单元测试中调用。生产诊断只生成 Prompt，
没有保存结构化 evidence-access log，也没有在报告完成后运行 Process Check。

因此“6 条机器检查”目前是可执行规范原型，不是实际质量门禁。

#### 升级方案

- evidence CLI 记录 snapshot-local access ledger：view、recordId、顺序、截断；
- 诊断报告以本地文件或显式导入方式返回；
- Process Check 从 ledger + report 运行；
- 作为独立 evaluator 注册并进入 EvaluationRun；
- 不自动控制外部 Agent，也不读取 live source。

#### 修改落点

- `server/diagnosis/evidence-cli.ts`
- `server/diagnosis/evidence-query.ts`
- `server/diagnosis/evidence-store.ts`
- `server/evaluation/process-check.ts`
- evaluator registry / runner

#### 验收

- 真实诊断能生成 6 条结构化结果；
- 不同 snapshot、先明细后概览、live read、标题错误均可检测；
- access ledger 本身脱敏、私有、有界；
- Process Check 失败不改诊断源和外部 Agent。

### P1-4：完成 Evaluation Center 的四阶段闭环

#### 原因

当前页面只完成：

- dataset 概览；
- Reviewer A/B 进度；
- 标注表单。

尚无：

- agreement/分歧详情；
- adjudication UI；
- 启动/查看 EvaluationRun；
- baseline/candidate diff；
- gate decision；
- case 到原轨迹证据的对比视图。

README 把评测中心描述为“分歧裁决和批量 EvaluationRun”，当前 UI 尚未兑现。

#### 升级方案

以四个显式状态驱动页面：

1. prepare；
2. blind annotation；
3. agreement/adjudication；
4. run/diff/gate。

所有权威协议仍留在 CLI/JSON；UI 只做受限 adapter。

顺手修正：

- “30 条”改用 `dataset.cases`；
- 前端完整性复用服务端同一 validation schema；
- 完成前禁止或显著警告访问 independent 结果；
- 不在浏览器 URL/localStorage 暴露 Reviewer 内容或标签。

#### 修改落点

- `src/components/EvaluationCenter.tsx`
- `src/components/AnnotationWorkspace.tsx`
- `src/annotation-types.ts`
- `server/evaluation/annotation-workspace.ts`
- `server/api.ts`

#### 验收

- 3～120 条数据集文案正确；
- Reviewer 未完成时不能进入裁决；
- 分歧可逐项裁决并保留 Reviewer 原文件；
- Run 和 diff 可按 case/criterion 下钻；
- UI 与 CLI 对同一 dataset 产出一致。

### P1-5：建立真正的 Evaluator Registry

#### 原因

当前 evaluator id/version 分散在：

- `local-trajectory@1` 常量；
- `trajectory-diagnosis-process@1` spec；
- AI summary adapter。

缺少统一 contract、build hash、context policy、dependencies、calibration status 和 gate level。

#### 升级方案

首批注册：

- local trajectory rule evaluator；
- diagnosis process evaluator；
- human Gold/imported evaluator；
- 后续可选 semantic model evaluator。

Registry 只做静态、显式注册，不引入动态插件系统。

#### 验收

- Run 可列出每个 evaluator 的完整 identity；
- 未校准 evaluator 只能 `advisory`；
- required dependency 缺失时输出 evaluator_error/insufficient，而不是 Agent fail；
- registry 变化进入 contract/build hash。

## P2：形成运营闭环并继续性能治理

### P2-1：完成首批真实双标与裁决

这是运营交付，不是代码缺陷。建议：

- 先做 30 条三来源均衡候选；
- 两位 Reviewer 盲态完成；
- 独立裁决全部分歧；
- calibration 调规则，regression 日常检查，independent 只做最终验收；
- 输出每 criterion agreement/Kappa/precision/recall/abstention；
- 记录 annotation guide 和裁决准则变更。

没有这一步，不能声称 Evaluator 已被 Gold 校准。

### P2-2：Badcase Casebook 与建议采纳账本

新增：

- 诊断快照 → candidate；
- 去重与相似 case 合并；
- expected behavior 人工补录；
- accepted/rejected/deferred；
- baseline/candidate run；
- 实际改善与回滚；
- 本地私有存储和删除策略。

保持不自动改 Skill、代码、Hook 或提交 MR。

### P2-3：AI Judge 稳定性与 grounding

在真实 Gold 就绪后再做：

- 相同 facts 重复运行；
- A/B 顺序交换；
- quote 必须匹配脱敏 evidence preview；
- invalid evidence ID、过长复制、伪造路径扫描；
- 低置信转人工；
- model/prompt/context hash；
- 成本与延迟。

### P2-4：真增量投影、delta 和 cache 估重

当前：

- append 输入已增量；
- Worker 仍完整 replay；
- projection 和 `recordOrder` 仍全量返回；
- Worker 每次完整 `JSON.stringify` 估重；
- record cache key 随状态变化，旧版本可能累积。

升级前先补：

- 10k 历史 + 1 条 append 的 p50/p95；
- Worker queue wait；
- request/reply payload bytes；
- cache state/record version 数；
- 主线程响应性。

确认收益后再做 reducer watermark、changed facets、order ops、旧版本替换和增量估重。

### P2-5：Hook/runtime 事务化

当前迁移 doctor 已完成，但安装仍是三宿主并发写入，成功后才写 installation record。

升级方案：

- staging ledger；
- fault injection；
- 部分失败自动回滚或明确 resume；
- running runtime health 返回 packageVersion/runtimeFile/dataRoot；
- 升级后旧 runtime 不静默复用。

## 暂不升级

当前不建议投入：

1. 更多故事线布局或总结模块；
2. 自动创建、执行或控制外部 Agent；
3. 自动修改 Skill、代码、Hook 或提交 MR；
4. 云端全量评测平台；
5. 没有消费者时的外部 Run 导入；
6. 没有 queue/payload 数据时的 Worker 池；
7. 用单一总分替代分项证据；
8. 在真实 Gold 前训练或微调小 Judge；
9. 直接复制商品/短剧领域 Rubric；
10. 把工具成功率当作业务正确率。

## 推荐实施顺序

### 阶段 1：评测可信度修正

范围：

1. Dataset/Gold/Run hash；
2. partial/full Gold 口径；
3. confusion eligibility；
4. direction-aware diff；
5. coverage quality gate。

通过条件：

> 同一冻结数据与 Gold 下，两个 evaluator build 可以可靠比较；Gold、Target、contract 或
> context 变化时拒绝归因；报告不会把 abstain/error 计成 FP/FN，也不会用部分断言宣称
> 100% exact。

### 阶段 2：真实校准与 Process Check

范围：

1. 首批 30 条真实双标/裁决；
2. Requirement/Chain 语义增强；
3. 诊断 access ledger；
4. Process Check 进入 Run；
5. 静态 Evaluator Registry。

通过条件：

- 有真实 agreement/Kappa/precision/recall；
- 所有结论可定位 record evidence；
- 评测器错误、来源缺口和 Agent 问题分开；
- independent 集未参与规则开发。

### 阶段 3：Evaluation Center 闭环

范围：

1. agreement；
2. adjudication；
3. Run；
4. diff；
5. gate；
6. case/criterion/evidence 下钻。

通过条件：

- UI 与 CLI 协议一致；
- 真实数据仍只在本机私有目录；
- Reviewer 隔离与 revision lock 不退化；
- 3～120 条数据集均正确展示。

### 阶段 4：运营与性能

范围：

- casebook；
- 采纳账本；
- AI Judge 稳定性；
- 真增量投影；
- Hook/runtime 事务。

每项先测量再实施，不与评测可信度修正混成一个大改动。

## 验收矩阵

| 升级 | 必测场景 |
| --- | --- |
| Run identity | 改 Gold、改 Target、改 contract、只改 evaluator build |
| Exact | partial contract 不进 full exact；完整 Gold 缺一项 fail closed |
| Precision/Recall | pass/fail/warning、N/A、insufficient、error 四类分母 |
| Diff | pass→fail、fail→warning、insufficient→pass、mixed case、required 退化 |
| Coverage | unknown、raw-only、unsupported、relation-only |
| Requirement | 单消息多要求、追加约束、替换、部分完成 |
| Chain | “继续”但未承接、合法改道、用户纠错、客观错误承接 |
| Process Check | 不同 snapshot、读取顺序、live read、报告结构、无建议 |
| Calibration | Reviewer 隔离、Kappa、分歧裁决、independent 防泄漏 |
| UI | 任意 case 数、未保存修改、冲突保存、裁决与 Run 下钻 |
| Privacy | home/path/token/raw/searchText/symlink/文件权限 |
| 性能 | append p50/p95、queue wait、payload bytes、cache versions |

## 文件影响建议

按升级阶段预计：

| 文件/模块 | 主要调整 |
| --- | --- |
| `src/evaluation-types.ts` | dataset/gold/build/contract identity，metric/diff/gate |
| `src/trajectory-evaluation.ts` | coverage、Requirement/Chain 语义 |
| `server/evaluation/runner.ts` | exact、confusion matrix、direction-aware diff |
| `server/evaluation/calibration.ts` | gold hash、拆分职责、independent 使用门禁 |
| `server/evaluation/process-check.ts` | 接入 access ledger/registry/run |
| `server/evaluation/annotation-workspace.ts` | agreement/adjudication/run adapter |
| `server/diagnosis/*` | 私有 access ledger 与报告导入 |
| `src/components/EvaluationCenter.tsx` | 四阶段状态机和 Run/diff/gate |
| `src/components/AnnotationWorkspace.tsx` | 共享 validation、动态 case 数和辅助语义 |
| `server/projection-worker*` | 后续增量 reducer 与观测 |
| `server/hook-installation.ts` | 后续事务化 ledger/rollback |

## 交付状态

本轮只重写：

- `docs/AGENT-EVALUATION-REEVALUATION-2026-10-25.md`

本轮没有修改：

- 产品源码；
- 测试；
- 配置；
- 外部系统；
- 用户现有未提交代码。

遗留风险：

- 当前全部实现仍在未提交工作区，无法绑定新的可复现 commit；
- 合成测试全部通过不能替代真实人工校准；
- 当前报告给出的 P0 缺口会影响评测可信度，不宜在修复前把 baseline diff 用作发布硬门禁。

## 最终判断

Agent Trajectory 已经从“单会话轨迹查看器”进入了**本地 Evaluation Loop 原型**阶段：
事实层、安全边界、评测合同、冻结样本、人工标注基础设施和批量 runner 都已存在。

下一阶段不应再证明“能不能跑一次评测”，而应证明：

> 同一冻结数据、同一完整 Gold、同一 contract/context 下，两个明确标识的 Evaluator
> build 是否真的可比较；报告中的 exact、FP/FN 和改善/退化是否在统计与证据上都成立。

先完成这个可信度闭环，再扩展 Process Check、UI、badcase 自进化和性能架构，项目才会从
“功能齐全的评测原型”变成“可用于版本决策的评测产品”。

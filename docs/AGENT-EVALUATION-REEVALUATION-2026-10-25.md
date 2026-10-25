# Agent Trajectory 行业实践重评与下一阶段优化建议

> 重评日期：2026-10-25
> 当前代码基线：`d5a7f952bf8b41d5fe3090952512b4ee8fa180ff` 加当前工作区未提交改动
> 对标基线：[AGENT-EVALUATION-BENCHMARK-2026-10-24.md](./AGENT-EVALUATION-BENCHMARK-2026-10-24.md) 及其 11 路行业/内部实践报告

## 结论

经过多轮迭代，Agent Trajectory 已经从“多来源轨迹查看器”成长为完成度较高的
**本地、多来源、证据优先的单会话轨迹分析与诊断产品**。当前强项包括：

- DSH、Codex、ZCode 的统一投影、能力协商和来源故障隔离；
- 来源协议的 detected/supported/fingerprint 诊断；
- snapshot/delta、增量读取、Worker 投影、LRU、raw 懒加载和完整审计导出；
- 多轮目标合成、故事线、五维过程评测、纠错恢复与 Token/耗时分析；
- 本地确定性优化建议和受证据约束的 AI 语义增强；
- 私有脱敏冻结快照、按需取证和轻量诊断 Prompt；
- 轻量 Node 分发、SessionStart Relay、Hook 安装、迁移感知 doctor 和 CI 包体门禁；
- 36 个测试文件、295 项测试全部通过，类型检查、生产构建与高危依赖审计通过。

与行业实践相比，项目已经解决了“如何可靠看清单条轨迹”的大部分问题，但仍未解决
“如何证明评测器可信、如何批量比较版本、如何持续回流 badcase”。

与此同时，底层仍有两个比评测平台化更优先的语义正确性缺口：

1. DSH `image/offload` 尚未投影到模型真实可见消息；
2. `assistant/live-chunk` 仍被错误列入持久 Session 已知事件。

因此新的优先级应是：

```text
P0-A  来源语义正确性
  → DSH image/offload + 持久事件词表同步门禁

P0-B  评测可信度最小闭环
  → Evaluation Contract + Facts Quality + Requirement/Chain + 小型 Gold

P1    轻量 Evaluation Loop
  → Process Check + Batch Run + Evaluator 校准 + Baseline/Candidate

P1/P2 规模与运营可靠性
  → single-flight + turn 线性聚合 + 真增量投影 + Hook/runtime 事务与版本诊断
```

下一轮不应继续把主要精力投入到故事线样式、更多总结模块或自动启动外部 Agent。当前 UI、
分发、诊断交互和基础工程已足以承载下一阶段，真正的产品缺口已经转移到**来源事实正确性**
与**评测结果可信度**。

## 本次重评方法

### 基线口径

当前大量功能仍未提交到新的 Git commit，所以本报告绑定的是 2026-10-25 当前工作区，
不能声称对应一个可复现提交。

判断顺序：

1. 当前源码；
2. 当前测试；
3. 实际构建、doctor、npm pack 和 audit；
4. README 与实现一致的描述；
5. 昨日行业报告仅作为问题清单，不作为当前实现事实。

### 实际验证

| 验证 | 结果 |
| --- | --- |
| `npm test` | 36 个测试文件、295 项测试全部通过，7.12 秒 |
| `npm run typecheck` | 通过 |
| `npm run build` | Web 与 CLI 构建通过 |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm pack --dry-run --json` | 压缩包 259,732 bytes，解包 960,500 bytes，共 12 个文件，无 runtime dependencies |
| `node dist-cli/agent-trajectory.mjs doctor` | DSH 13 sessions available；ZCode 14 sessions available；Codex 34 sessions degraded，原因是协议探测达到扫描上限 |

### 真实运行发现

Codex 实际会话可发现，但 `doctor` 持续显示：

```text
codex degraded
协议探测已达到本地扫描上限；会话发现将在后台继续
```

这证明有界协议探测和降级展示已经工作，也说明当前 `availability=degraded` 同时承载了
“真实协议风险”和“探测尚未完成”两种不同严重度，健康状态语义仍可优化。

## 相比昨日新增或显著加强的能力

### 1. 来源协议诊断已经产品化

`SourceStatus` 新增：

- `sessionCountState: pending | ready`；
- `protocol.detected`；
- `protocol.supported`；
- `protocol.fingerprint`。

三来源行为：

- DSH 能区分 v4、未知 generation 和有界扫描；
- Codex 能区分 `session_meta`、未知 header、未写完 header 和有界扫描；
- ZCode 能输出 schema fingerprint，并将核心 schema 不兼容与可选能力缺失分开。

UI 对 blocked source 展示 detected/supported/fingerprint；来源列表发现失败不会拖垮其他来源。

证据：

- `src/types.ts`：`SourceProtocolDiagnostic`、`sessionCountState`；
- `server/sources/dsh.ts::probe()`；
- `server/sources/codex.ts::probe()`；
- `server/sources/zcode.ts::probe()`；
- `server/sources/registry.ts::listSources()`；
- `tests/sources/dsh.test.ts`、`codex.test.ts`、`zcode.test.ts`；
- `tests/App.test.tsx` 的 portable protocol diagnosis。

这使昨日“历史协议至少要可发现、明确不支持”的方向部分落地：当前能诊断未知 DSH/Codex
协议，但尚未覆盖所有历史 DSH 文件命名和迁移语义。

### 2. 审计导出更接近完整事实层

v2 审计导出不只导出投影记录，还通过各来源 `audit()` 返回全部脱敏 source events，
包括 `raw-only` 和未形成可见 record 的事实。

这改善了：

- 投影覆盖审计；
- 新事件类型兼容排查；
- 后续 benchmark 的冻结证据完整性；
- “看不到”与“没发生”之间的区分。

证据：

- `SessionSource.audit()`；
- `SourceRegistry.audit()`；
- `server/api.ts` audit export；
- 三来源 audit 测试。

### 3. 目标合成从“取最后一句”升级为上下文目标综合

`objectiveFrom()` 已能：

- 过滤环境与 AGENTS 注入；
- 识别用户确认、继续执行和上下文指令；
- 把新增约束附加到已确认方案；
- 区分运行中当前目标和已完成会话目标；
- 处理浏览器反馈格式。

昨日“只有单一 objective”的判断需修正为：

> 当前已有较强的多轮目标合成，但输出仍压成一个字符串；缺的是结构化逐项需求验收，
> 不是基本目标理解。

证据：

- `src/objective-synthesis.ts`；
- `tests/trajectory-analysis.test.ts` 中多轮目标、上下文执行提示、浏览器反馈测试。

### 4. 诊断入口权限边界更稳

旧实现自动创建并打开诊断会话；当前实现改为：

1. 服务冻结目标；
2. 生成 `trajectory-diagnosis-v1` 轻量 Prompt；
3. 浏览器复制 Prompt；
4. 用户自行打开新会话粘贴执行。

收益：

- 不依赖 Agent 会话创建 API；
- 不自动发送消息；
- 不控制外部 Agent UI；
- 三来源统一；
- Prompt 只携带协议、Skill 路径、snapshot ID 和 evidence command。

证据：

- `src/diagnosis-types.ts`；
- `server/diagnosis/task.ts`；
- `TrajectoryDiagnosisService.preparePrompt()`；
- `TrajectoryDiagnosisButton`；
- `tests/trajectory-diagnosis-api.test.ts`；
- `tests/TrajectoryDiagnosisButton.test.tsx`。

因此昨日“不要执行 Agent、不要自动修改外部系统”的架构约束已经解决，不应再列为新增功能。

### 5. Hook 与跨机器迁移诊断显著加强

安装记录现在包含：

- packageVersion；
- platform；
- nodeExecutable；
- runtimeFile；
- dataRoot；
- installedAt。

`doctor` 能识别：

- 旧安装无记录；
- Node/runtime 文件不存在；
- 平台变化；
- dataRoot 变化；
- runtime 路径变化；
- package version 变化；
- 已安装 Hook 与安装记录不一致。

证据：

- `server/hook-installation.ts::HookInstallation`；
- `server/cli.ts::doctor()`；
- `tests/cli-doctor.test.ts`；
- `tests/hook-installation.test.ts`。

当前缺口已从“有没有迁移诊断”转为“安装是否事务化、running runtime 是否也有版本诊断”。

### 6. 分发和供应链基础已达到轻量产品水平

当前：

- 不再分发 Electron；
- Node 22+ 单包运行；
- Web、projection worker、ZCode worker、诊断 CLI、Skill 一起打包；
- 包体约 254 KiB；
- CI 检查测试、构建、2 MiB 包体上限、Electron/Chromium 文件、高危依赖；
- 发行 workflow 生成 tgz artifact。

因此“轻量化分发”已不再是主要优化方向。

## 当前行业能力矩阵

| 能力 | 当前状态 | 重评判断 |
| --- | --- | --- |
| 多来源统一轨迹 | 强 | 已是核心优势 |
| 来源协议透明诊断 | 强 | 新增成熟能力 |
| 投影 provenance/coverage | 强 | 可作为评测证据底座 |
| 完整脱敏审计 | 强 | 较昨日显著增强 |
| 单会话结果与过程评测 | 强 | 固定五维成熟 |
| 多轮目标综合 | 中强 | 已能综合，仍非逐项验收 |
| 故事线与恢复链 | 强 | 不再是核心缺口 |
| 成本/Token/耗时分析 | 强 | 不再是核心缺口 |
| 本地优化建议 | 中强 | 有证据和动作，缺采纳复测闭环 |
| AI 语义增强 | 中强 | 事实包、schema、补证完善，缺校准 |
| 冻结诊断 Target | 强 | 可直接复用为 benchmark target |
| CLI/Hook/迁移/分发 | 中强 | 主要缺事务和 runtime 版本一致性 |
| Evaluation Contract | 缺失 | 行业核心差距 |
| Judge-ready Facts Quality | 缺失 | coverage 尚未形成判前质量报告 |
| RequirementResult | 缺失 | 单字符串 objective 不能表达部分完成 |
| ChainResult | 缺失 | story 不能证明信息承接正确 |
| Process Check/Rubric | 缺失 | 固定规则不能表达 Skill 合同 |
| Gold/Calibration Dataset | 缺失 | 测试 fixture 不等于人工 Gold |
| Batch EvaluationRun | 缺失 | 仍是单会话产品 |
| Evaluator Registry/Version | 缺失 | AI adapter 不等于 evaluator registry |
| Human calibration | 缺失 | 没有 agreement/precision/recall/Kappa |
| Baseline/Candidate Diff | 缺失 | 无法证明版本真的变好 |
| Badcase 回流 | 缺失 | snapshot 不能标为 dataset candidate |
| 采纳与复测账本 | 缺失 | 建议尚未闭环 |

## 昨日 P0/P1/P2 完成度审计

### P0

| 昨日建议 | 当前状态 | 重评 |
| --- | --- | --- |
| P0-1 Evaluation Contract | 部分解决 | 有固定 `AnalysisEvaluation`，没有统一 verdict/criterion/evaluator/denominator |
| P0-2 Facts Quality | 部分解决 | 有 coverage、capability、truncation，未形成 Judge-ready 质量报告 |
| P0-3 Requirement/Chain | 部分解决 | 目标合成与 story 已增强，结构化 Requirement/Chain 仍缺失 |
| P0-4 Gold Benchmark | 部分解决 | 有匿名 fixture 和冻结 snapshot，无人工标签与校准指标 |

### P1

| 昨日建议 | 当前状态 | 重评 |
| --- | --- | --- |
| P1-1 Process Check | 部分解决 | `trajectory-diagnosis` 有文本合同，无机器可执行 spec |
| P1-2 Batch EvaluationRun | 仍缺失 | 没有 dataset/case/run/report |
| P1-3 Baseline/Candidate | 仍缺失 | 没有双侧样本、diff、门禁 |
| P1-4 Evaluator Registry | 仍缺失 | summary adapter 不能替代 evaluator registry/calibration |

### P2

| 昨日建议 | 当前状态 | 重评 |
| --- | --- | --- |
| P2-1 Badcase Casebook | 仍缺失 | snapshot 是底座，不是 case |
| P2-2 建议采纳账本 | 部分解决 | suggestion 很具体，缺 accepted/rejected/run/result |
| P2-3 外部 Run 导入 | 仍缺失 | 当前没有明确需求，继续保持低优先 |
| P2-4 AI Judge 稳定性 | 部分解决 | AI 事实门禁完善，未做重复稳定性、顺序偏置、quote grounding |

整体结论：昨日 12 项中没有一项完整落地；6 项已有明显底座，6 项仍完全缺失。

## 新优先级

## P0-A：先修来源语义正确性

### A1. 实现 DSH `image/offload` 消息投影

当前 `image/offload` 在 `KNOWN_EVENT_TYPES` 中，但不属于 surface、record 或 folded-state，
最终被归为 `raw-only`。

影响：

- “模型上下文”可能不是模型真实看到的内容；
- Token/上下文分析可能包含已经 offload 的图片；
- 非法 target、重复 target、越界 image index 不会 fail-closed；
- 后续任何评测都可能建立在错误上下文上。

修改候选：

- `src/projector.ts::foldSurface()` 或独立 message projection reducer；
- coverage 增加 `message-projection` 或使用 `folded-state`；
- facts/模型上下文使用 projected message；
- transcript/audit 保留原始内容。

验收：

- 单 target、多 target、tool result、连续 offload 与固定上游结果一致；
- 非 current seq、重复 target、越界 index 明确拒绝；
- transcript 原始、model context offloaded、audit 完整。

### A2. 修正持久事件词表

从 DSH 持久 known set 移除 `assistant/live-chunk`，并建立：

- persisted event set 快照；
- required message projection set 快照；
- 固定上游版本与差异审查流程。

验收：

- durable、非 ignorable 的 `assistant/live-chunk` fixture 被拒绝；
- 本地持久词表与固定上游清单完全一致；
- 更新上游版本时测试明确显示新增/删除事件。

这两项应在任何新评测平台功能之前完成，因为评测不能建立在错误来源语义上。

## P0-B：建立评测可信度最小闭环

### B1. 薄 Evaluation Contract

新增独立层，不重写现有分析：

```ts
type EvaluationVerdict =
  | 'pass'
  | 'fail'
  | 'warning'
  | 'not_applicable'
  | 'insufficient_evidence'
  | 'evaluator_error'
  | 'out_of_scope'

interface EvaluationResult {
  evaluatorId: string
  evaluatorVersion: string
  criterionId: string
  verdict: EvaluationVerdict
  evidenceRecordIds: string[]
  counterEvidenceRecordIds: string[]
  evidenceBoundary: string
  blockedBy: string[]
}
```

先把当前五维分析映射为 `local-trajectory-v1`，不要先做通用插件系统。

验收：

- N/A、证据不足、Evaluator 错误和质量失败分母隔离；
- 每个结论可定位 evidence；
- 系统/投影问题不会被记为 Agent 质量失败；
- result 记录 target fingerprint、facts/schema/evaluator version。

### B2. Judge-ready Facts Quality

在评测前输出：

- source capability 与 protocol 状态；
- coverage gap；
- input/output/error 缺失或截断；
- tool call/result 配对；
- trace/span 断裂；
- live/frozen 和 fingerprint；
- 当前 context scope；
- blocked evaluator/criterion。

facts quality 必须进入 facts hash。

验收：

- 三来源 fixture 有稳定质量报告；
- source gap 产生 `insufficient_evidence`，而不是 `fail`；
- 事实质量变化使 AI/evaluator 缓存失效。

### B3. RequirementResult 与 ChainResult

当前目标合成继续保留，新增结构化层：

- requirement text/state/required/evidence；
- superseded 与 out-of-scope；
- overall outcome 与 required requirement 一致性；
- 多轮 transition continuity 与 failed transition。

验收：

- 多要求、部分完成、用户改道、后续遗忘前轮信息各有 fixture；
- 单轮 ChainResult 为 `not_applicable`；
- story 负责叙事，ChainResult 负责承接判定，二者不混用。

### B4. 最小 Gold Benchmark

第一阶段只做 12～20 条：

- 三来源；
- 正常正控、未验证、未恢复、已恢复、长会话、工具密集；
- DSH offload/未知事件等来源正确性 case；
- 人工 outcome、criterion verdict、证据 ID、主因标签；
- calibration 与独立 regression 分开。

指标：

- exact agreement；
- precision/recall/FP/FN；
- N/A 与 insufficient evidence；
- 重复运行稳定性；
- 成本和延迟。

## P1：轻量 Evaluation Loop

### 1. Process Check Spec

以 `trajectory-diagnosis` 为首个对象，把已有 Skill 规范转成 4～6 条机器检查：

- 只诊断指定 frozen snapshot；
- 先 overview/findings；
- records/record 按需读取；
- 不读取 live source；
- 报告固定四块；
- 建议必须有证据、验证和单一首选方案。

支持最小字段：

- `applicable_if`；
- `pass_if`；
- criticality；
- context scope；
- dependencies；
- allowed verdict。

### 2. 本地 Batch EvaluationRun

首版只支持：

- 显式选定 frozen target；
- 有界并发；
- 本地 JSON/Markdown；
- case-level verdict、evidence 和 error；
- 质量/成本/性能聚合；
- 不执行 Agent、不扫描整盘、不上传。

### 3. Baseline/Candidate 和双侧样本

必须比较同一：

- dataset version；
- target fingerprint；
- evaluator version；
- facts schema；
- context policy。

同时维护：

- issue/badcase set；
- population/positive-control set。

门禁不能只看总通过率，应包含：

- required criterion 不退化；
- 正控误报不超阈值；
- unknown/N/A 不异常升高；
- Token/延迟在预算内；
- 样本不一致时拒绝做因果比较。

### 4. Evaluator Registry 与校准

首批只注册：

- `local-trajectory-v1`；
- `trajectory-diagnosis-process-v1`；
- 可选 `ai-semantic-v1`。

记录：

- code/model/human/composite 类型；
- contract 和 schema；
- prompt/rubric/context hash；
- calibration status；
- gate level：可门禁、需人工、仅辅助。

## P1：低风险工程优化

这些优化不应阻塞 Evaluation Contract 设计，但适合并行实施。

### 1. DSH turn 汇总改为一次分组

当前 `src/projector.ts` 每个 turn 都执行一次 `records.filter()`，应改为
`Map<number, TrajectoryRecord[]>`，复杂度由 `O(turns × records)` 降为 `O(turns + records)`。

### 2. `SourceRegistry.load()` 增加 single-flight

同 session/fingerprint 的详情、raw、export、AI 请求共享一次 load/project。

验收：10 个并发请求只执行一次 adapter load；失败后正确清理 in-flight。

### 3. Codex 协议探测状态分级

实际 `doctor` 中 Codex 因扫描上限持续 degraded，但 34 个会话可用。

建议：

- 将 `probe_incomplete` 与 `compatibility_degraded` 分开；
- pending 探测不使用与未知协议相同的健康严重度；
- 后台发现完成后刷新状态；
- doctor 显示“可用，协议探测未完成”而不是泛化 degraded。

### 4. Hook 安装事务与 running runtime 版本诊断

当前三宿主 Hook 并发写入，安装记录最后落盘；任一中途失败可能留下半安装。

建议：

- partial installation ledger 或自动回滚；
- fault injection 测试；
- runtime ping 返回 packageVersion/runtimeFile/dataRoot/source fingerprint；
- 旧 runtime 不再静默复用。

## P2：测量后实施

### 1. 真正端到端增量投影

当前只做到：

- 文件读取增量；
- 主线程发给 Worker 的输入增量。

Worker 内仍全量 replay，随后完整返回 projection；API 仍全量 hash、完整 `recordOrder`。

应作为一个整体设计：

- reducer watermark；
- record upsert/remove/order ops；
- changed fragments；
- source rewrite 和 state eviction 回退 snapshot；
- 客户端 merge 失败回退 snapshot。

在没有 append p50/p95、payload bytes 和队列等待数据前，不先建 Worker 池。

### 2. 压缩 DSH frame 级增量

只有确认上游独立 zstd frame 语义并完成 corpus 原型后实施；否则继续明确回退完整解压。

### 3. Worker/cache 增量估重

避免每次 append 对完整 state `JSON.stringify` 估重。

### 4. CLI 与供应链完善

- `--help`、`--version`、`doctor --json`、稳定 exit code；
- Windows/Linux Hook quoting 与 browser open 测试矩阵；
- pack manifest/SBOM、敏感文件扫描、checksum；
- secret store 威胁模型与可选系统 Keychain。

这些是成熟度提升，不是当前行业评测能力的主要瓶颈。

## 当前不应继续投入

1. 更多故事线布局或固定视图变体；
2. 更多无 Gold 校准的 AI 总结模块；
3. 自动创建、控制或运行外部 Agent；
4. 自动修改 Skill、代码、Hook 或自动提交 MR；
5. 云端全量评测平台；
6. 没有明确消费者时的外部 Evaluation Run 导入；
7. 没有队列观测前的 Worker 池；
8. 用单一总分替代分项证据；
9. 把测试数量当作 Evaluator 可信度；
10. 把工具成功等同业务正确。

## 推荐下一轮最小实施切片

建议拆成两个相邻但独立可验收的 PR/阶段。

### 阶段 A：来源正确性与低风险热点

范围：

1. DSH `image/offload`；
2. 持久事件词表快照和 `assistant/live-chunk` 修正；
3. turn 一次分组；
4. Registry single-flight；
5. Codex probe pending/degraded 分级。

验收：

- 固定上游语义 fixture；
- 词表同步测试；
- 多 turn 性能基准；
- 并发 load 计数测试；
- 真实 `doctor` 不再把纯扫描未完成泛化为兼容性 degraded。

### 阶段 B：评测可信度最小闭环

范围：

1. `src/evaluation-types.ts`；
2. 当前五维映射到 `local-trajectory-v1`；
3. facts quality；
4. RequirementResult/ChainResult 最小结构；
5. 12～20 个 Gold case；
6. `trajectory-diagnosis` 4～6 条 Process Check；
7. 本地 CLI runner；
8. JSON/Markdown baseline report。

暂不做：

- UI Run 管理页；
- AI Judge 门禁；
- 外部系统导入；
- 自动执行 Agent；
- 采纳账本。

阶段 B 验收问题只有一个：

> 对同一批 frozen trajectories，在固定合同和 evaluator 版本下，当前代码相对 baseline
> 改善了哪些 case、退化了哪些 case；每个变化能否定位到 criterion 和 record evidence，
> 并区分 Agent 问题、来源缺口与 Evaluator 错误？

## 风险

1. 当前工作区没有新的提交基线，所有结果无法绑定可复现 commit；
2. DSH 语义缺口会污染 model-context 和后续 Gold；
3. `unknown` 目前承载多种语义，直接聚合会失真；
4. snapshot 默认最多 24 个、256 MiB，会被 prune，不能直接当长期 benchmark store；
5. AI facts hash 尚未包含质量边界；
6. Hook 安装中途失败可能留下半安装；
7. running runtime 可能在升级后被静默复用；
8. Timeline 在全范围仍遍历/渲染全部可见记录，大轨迹需继续测量；
9. 真实 Codex doctor 的有界探测状态会持续告警；
10. 295 项产品测试不等于 Evaluator 已被 Gold 校准。

## 验证与交付状态

本轮新增文件：

- `docs/AGENT-EVALUATION-REEVALUATION-2026-10-25.md`

本轮没有修改：

- `src/`；
- `server/`；
- `tests/`；
- 配置或外部系统。

已执行验证：

- 295 tests passed；
- TypeScript typecheck passed；
- Web/CLI production build passed；
- npm audit 0 vulnerabilities；
- npm package dry-run：259,732 bytes，12 个文件；
- real doctor：DSH/ZCode available，Codex sessions 可读但协议探测有界降级。

遗留项：

- 本报告只完成重新评估，没有实施任何优化；
- 当前工作区仍有大量用户未提交改动；
- 正式开发前建议先建立可复现 Git 基线，否则 baseline/candidate 无法可靠归因。

## 最终判断

当前 Agent Trajectory 已经“能把一条 Agent 会话看清、解释清、诊断清”，工程可靠性也已
达到可分发产品水平。下一阶段最有价值的提升，不是继续增加展示，而是同时守住两个问题：

1. **事实是否正确**：DSH 等来源投影必须与真实模型上下文一致；
2. **评测是否可信**：同一批冻结样本上，Evaluator 结论必须可版本化、可校准、可比较。

只有先补齐这两层，Process Check、批量 Run、回归门禁和 badcase 自进化才不会变成
“对错误事实做更自动化的评分”。

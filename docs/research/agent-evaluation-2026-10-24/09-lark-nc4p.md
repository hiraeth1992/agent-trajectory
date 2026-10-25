# 第 9 路调研：飞书 Wiki「短剧平台评测（机评）体系建设」与 Agent Trajectory 对比

调研日期：2026-10-24
唯一研究对象：https://bytedance.larkoffice.com/wiki/NC4pwDRQniynqEkC43qcD2WMnRs

## 1. 来源元信息与访问状态

### 1.1 只读访问结果

- Wiki 节点解析：成功，身份为 `--as user`。
- 正文读取：成功，身份为 `--as user`，使用 `docs +fetch` 只读读取目录与章节。
- 写操作：未对飞书 Wiki、Docx、引用文档、表格或其他外部系统执行任何写操作。
- 本地落盘：仅新增本文件。

### 1.2 节点与文档元信息

| 字段 | 结果 |
| --- | --- |
| Wiki 节点标题 | 短剧平台评测（机评）体系建设 |
| wiki node token | `NC4pwDRQniynqEkC43qcD2WMnRs` |
| obj type | `docx` |
| obj token / document_id | `L3UbdWwpQofY5Zx89MucjtYInKh` |
| space_id | `7068833421052690460` |
| has_child | `false` |
| 文档 revision | `826` |
| Wiki 节点更新时间 | `2026-10-09T08:51:45Z` |

说明：文档正文中存在引用的 Docx、Sheet、Wiki 和白板资源；本轮“唯一研究对象”限定为当前 Wiki 节点，因此没有下钻读取这些外部引用。本文只保留必要摘要，不复制大段内部正文。

## 2. 核心实践总结

这份内部实践的核心不是“让大模型给一个分”，而是建设一套可闭环的评测系统：

1. 先把评测对象按产物层级拆开：资产层、分镜层、视频层。
2. 每个层级拆成可验收的维度，并给出 1/2/3 三档评分锚点、边界条件和低分证据要求。
3. 用归因标签把问题落到研发能处理的位置，例如提示词链路、模型响应、一致性、全局连贯性。
4. 机评采用组合式方法：结构化、可计算的部分优先规则/代码；语义边界用 LLM；视觉/音频能力接专家模型或 VLM；主观强的维度保留人评主导。
5. 通过金标集、校准集、对抗集与人机一致性指标，持续校准机评，不把一次 pilot 结果当作准出依据。
6. 平台策略是“主线平台 + 补充平台”，而不是把所有维度强行塞进同一个系统。

对 Agent Trajectory 最有参考价值的是：维度分层、组合式评测、结构化输出、证据强制、金标/校准集、人机一致性度量和 badcase 归因闭环。

## 3. 流程、指标、数据模型与案例

### 3.1 流程模型

文档给出的流程可以抽象为：

```text
业务产物分层
  → 维度与评分标准
  → 数据集构建
  → 评测方法选择
  → 结构化打分与证据输出
  → 人机一致性校验
  → badcase 归因与迭代
  → 回归看板 / 版本对比
```

对应到本文档中的关键节点：

- 评测对象分层：资产层、分镜层、视频层。
- 评测类型：版本评测、竞品评测、专项评测、回归评测。
- MVP 收敛：优先做能稳定验收、可自动化、可归因、可复用的维度；复杂美学、全局叙事等后置。
- 平台落地：Fornax 作为主线平台，ByteVal 作为复杂 workflow、自定义脚本和看板补充。

### 3.2 指标模型

文档中的指标有两类：

一类是业务质量指标：

- MOS：分维度均分或整体均分。
- GSB：相对 baseline 的 Good / Same / Bad。
- 1/2/3 三档评分：每档要有阈值、反例与边界条件。
- 低分证据：非满分必须给出证据与一句话归因。

另一类是机评校准指标：

- 完全一致率：机评分数与人评分数完全一致。
- 容差一致率：允许一定分差后的匹配率。
- 低分召回率：人评低分 case 中，机评能抓出的比例。
- 低分准确率：机评判低分的 case 中，真实低分比例。
- 归因标签 F1：机评归因与人评归因的一致性。
- Pearson 相关系数：连续分数场景下的人机相关性。

这些指标背后的思想是：不要只看总体平均分，要按维度、剧本类型、样本类型和低分 case 单独验收。

### 3.3 数据模型

文档要求样本至少记录以下字段：

- `sample_id`
- 来源
- 剧本类型
- 评测层级
- 评测维度
- 输入剧本 / 提示词
- 生成产物
- 判定点
- 人评分
- 机评分
- 归因标签
- 样本集类型：golden / calibration / boundary / adversarial

如果映射到 Agent Trajectory，可演化为：

| 内部实践字段 | Agent Trajectory 候选字段 |
| --- | --- |
| `sample_id` | `trajectory_sample_id` / 固定来源会话 hash |
| 来源 | `source`：`dsh` / `codex` / `zcode` |
| 剧本类型 | `task_type`：代码修改、调研、诊断、UI 操作、长链路执行等 |
| 评测层级 | 会话级 / 轮次级 / 步骤级 / 记录级 |
| 评测维度 | outcome、reliability、recovery、efficiency、observability、safety |
| 输入剧本 / 提示词 | 用户目标、约束、计划、AGENTS/skill 规则摘要 |
| 生成产物 | 最终回答、文件变更、诊断报告、导出证据 |
| 判定点 | 是否达成目标、是否验证、是否误判、是否越权、是否浪费 |
| 人评分 | 人工轨迹评审标签 |
| 机评分 | 本地规则 / AI summary / trajectory-diagnosis 输出 |
| 归因标签 | source / projection / planning / tool-use / verification / safety / environment |
| 样本集类型 | golden / calibration / adversarial / regression |

### 3.4 结构化输出

文档要求 VLM/LLM 机评输出结构化 JSON，关键字段包括：

- `score`
- `reason`
- `evidence`
- `attribution`
- `confidence`
- `cannot_judge`

Agent Trajectory 当前已经有相近基础：本地分析和 AI 增强都强调 `evidenceRecordIds`、`confidence`、结构化 schema 和“不得编造证据”。但可以补齐两个字段：`cannot_judge` 与更细的 `attribution`。

### 3.5 典型案例抽象

文档的典型低分案例不是泛泛说“质量差”，而是按链路归因，例如：

- 输入/提示词漏掉关键实体：归因到上游 Agent 或提示词生成。
- 提示词正确但生成结果不符：归因到模型响应。
- 单分镜内部问题：归入准确性。
- 跨分镜漂移：归入一致性。
- 高主观维度：短期由人评主导，机评只作为参考或筛查。

对 Agent Trajectory 的启发是：不要只输出“这个轨迹不好/很好”，而应定位为：

- 目标理解偏差；
- 约束忽略；
- 工具选择错误；
- 原样重试；
- 缺少验证；
- 推断过度；
- 来源事实缺失；
- UI/投影层丢失语义；
- 安全边界或隐私处理风险。

## 4. 与当前 Agent Trajectory 的映射

### 4.1 当前项目已有的对应能力

| 内部实践 | Agent Trajectory 当前证据 | 判断 |
| --- | --- | --- |
| 评测对象分层 | [src/types.ts](../../../src/types.ts) 中 `TrajectoryProjection`、`TrajectoryRecord`、`TrajectoryTurnSummary`、`TrajectoryTaskState` 已把会话、记录、轮次、任务状态分开 | 已有良好基础 |
| 多来源统一 | [README.md](../../../README.md) 定位为只读、多来源轨迹查看器；支持 DSH、Codex、ZCode | 已有 |
| 维度化评估 | [src/trajectory-analysis.ts](../../../src/trajectory-analysis.ts) 中 `AnalysisEvaluation` 覆盖 outcome、reliability、recovery、efficiency、observability | 已有，但可进一步校准 |
| 证据强制 | [src/trajectory-analysis.ts](../../../src/trajectory-analysis.ts) 与 [src/ai-summary-types.ts](../../../src/ai-summary-types.ts) 使用 `evidenceRecordIds` | 已有 |
| 结构化机评 | [server/summary/protocol.ts](../../../server/summary/protocol.ts) 定义 AI summary 输出 schema；[server/summary/adapters/openai-compatible.ts](../../../server/summary/adapters/openai-compatible.ts) 默认使用 JSON Schema | 已有 |
| 组合式评测 | [src/trajectory-analysis.ts](../../../src/trajectory-analysis.ts) 做确定性本地分析；[server/summary/engine.ts](../../../server/summary/engine.ts) 做可选 AI 增强；[skills/trajectory-diagnosis/SKILL.md](../../../skills/trajectory-diagnosis/SKILL.md) 做按需证据诊断 | 已有，但缺金标校准闭环 |
| 问题归因 | [src/trajectory-optimization.ts](../../../src/trajectory-optimization.ts) 已有 duplicate、retry、environment、verification、detour、search、context、constraint 等优化类别 | 已有，可扩展为评测归因标签 |
| 覆盖率 / 不可观测性 | [src/types.ts](../../../src/types.ts) 有 `ProjectionCoverage`、`ProjectionCoverageSummary`；[src/projector.ts](../../../src/projector.ts) 汇总 consumed/gap | 已有，很适合映射 `cannot_judge` |
| 任务状态 | [src/types.ts](../../../src/types.ts) 有 target/todos；[src/projector.ts](../../../src/projector.ts) 折叠 goal/todo | 已有 |
| 隐私与安全 | [src/projector-utils.ts](../../../src/projector-utils.ts) 脱敏；[README.md](../../../README.md) 说明 loopback、opaque ID、只读和不读取凭据 | 已有 |
| 回归与真实来源证据 | [scripts/verify-real-sources.ts](../../../scripts/verify-real-sources.ts) 和 README 验证章节说明真实来源摘要不含正文和原始 ID | 已有 |

### 4.2 当前项目缺口

1. 缺少人工金标 / 校准集：当前已有很多单元测试和真实来源摘要，但还不是“人类评委标注的轨迹质量数据集”。
2. 缺少人机一致性报表：本地规则、AI summary、trajectory-diagnosis 与人工判断之间没有固定一致率、低分召回、归因 F1。
3. `cannot_judge` 语义还没有成为评测输出的一等字段：项目已经会区分未知、低置信度、coverage gap，但可以更明确地暴露给评测层。
4. 归因标签可更系统：优化建议里有问题类别，但评测报告和诊断报告可共享统一 taxonomy。
5. 维度权重尚未数据化：当前评测维度存在，但没有基于用户感知或人类标注来调权。

## 5. 候选优化

### 5.1 建立 Agent Trajectory 金标 / 校准 / 对抗样本集

- 价值：让本地规则、AI summary 和 trajectory-diagnosis 的质量可量化，避免只凭主观体验判断。
- 成本：中。需要定义样本 manifest、人工标注表和评测脚本。
- 风险：真实轨迹可能含敏感信息；人工标注口径若不统一，会把噪声固化为标准。
- 验证：先抽 30-50 条脱敏轨迹做 golden set，至少两名评审交叉标注，计算一致率；再扩展到 calibration set。

候选数据模型：

```json
{
  "sample_id": "trajectory-golden-0001",
  "source": "codex",
  "source_session_sha256": "...",
  "task_type": "code_change",
  "level": "session",
  "dimensions": ["outcome", "reliability", "recovery", "efficiency", "observability"],
  "human_labels": {
    "outcome": "verified_success",
    "reliability": "warning",
    "primary_attribution": "missing_verification"
  },
  "evidence_record_ids": ["..."],
  "set_type": "golden"
}
```

### 5.2 把评测方法路由做成“规则优先，AI 补充”

- 价值：契合内部实践的组合式机评原则；降低成本并提高可解释性。
- 成本：中。需要将现有 `analyzeTrajectory`、`analyzeTrajectoryOptimizations`、AI summary 和 diagnosis 统一成 evaluator registry。
- 风险：规则可能过拟合当前代码行为，AI 可能在证据不足时补想象。
- 验证：在金标集上分别跑规则、AI、规则+AI，比较低质量召回、准确率和归因 F1。

建议优先规则化的维度：

- 最后修改后是否有验证；
- 是否出现原样重试；
- 是否有未恢复错误；
- 是否越过只读/安全边界；
- coverage gap 是否影响结论；
- Token 是否无法归属到步骤；
- 轨迹是否仍在运行。

### 5.3 给评测输出补齐 `cannot_judge` 与 `attribution`

- 价值：避免“证据不足也硬判”；与内部实践的结构化 JSON 输出一致。
- 成本：低到中。现有类型已经有 `confidence`、`evidenceRecordIds`，新增字段相对自然。
- 风险：UI 增加字段后可能变复杂；旧缓存或旧 summary schema 需要兼容。
- 验证：构造 coverage gap、无验证、会话仍在运行、来源不支持 trace 的样本，确认评测能明确返回不可判断或低置信度。

可落点：

- [src/trajectory-analysis.ts](../../../src/trajectory-analysis.ts)：本地 `AnalysisEvaluation` 增加不可判断原因或 attribution。
- [src/ai-summary-types.ts](../../../src/ai-summary-types.ts)：AI enhancement schema 增加 `cannotJudge` / `attribution`。
- [server/summary/protocol.ts](../../../server/summary/protocol.ts)：同步约束 schema。

### 5.4 统一轨迹归因标签 taxonomy

- 价值：把诊断、优化建议、AI summary 和人工评审统一到同一套问题分类，方便看板统计。
- 成本：中。需要整理现有类别并迁移 UI 文案。
- 风险：标签太多会降低可用性；标签太少又无法定位。
- 验证：以 20 条 badcase 回放，检查每条是否能被单一主因 + 可选辅因解释。

建议初版标签：

| 大类 | 标签示例 |
| --- | --- |
| 目标与约束 | 目标理解偏差、用户约束忽略、未等待确认 |
| 工具与流程 | 工具选择错误、原样重试、重复读取、非最短路径 |
| 验证 | 缺少验证、验证晚于修改、验证覆盖不足 |
| 来源与投影 | 来源缺字段、投影 coverage gap、schema 降级 |
| 安全与隐私 | 越权写入、敏感信息泄露风险、外部系统副作用 |
| 环境 | 依赖缺失、路径错误、命令不可用 |
| 恢复能力 | 失败未恢复、恢复但无独立验证、误判完成 |

### 5.5 建立人机一致性看板

- 价值：让评测能力本身可观测，能回答“AI summary / diagnosis 是否真的靠谱”。
- 成本：中到高。需要样本仓库、运行器、报表。
- 风险：看板指标可能被当作绝对质量；样本偏置会误导优化。
- 验证：每次评测脚本输出完全一致率、容差一致率、低质量召回/准确率、归因 F1，并按来源和任务类型分层。

### 5.6 对抗集覆盖“容易误判为成功”的轨迹

- 价值：Agent Trajectory 的核心价值是避免把“没报错”误读为“完成正确”。这类对抗集收益很高。
- 成本：中。可以从现有测试 fixture 和真实脱敏轨迹中构造。
- 风险：对抗样本过度集中会让评测变保守。
- 验证：确保本地评测对以下样本不会给出高置信成功：
  - 最后一次验证早于最后一次修改；
  - 工具失败后没有恢复证据；
  - 会话仍在 running；
  - 来源 coverage gap 明显；
  - AI summary 请求了不存在的 evidence id；
  - 诊断目标冻结前后 fingerprint 变化。

## 6. 不建议照搬项

1. 不建议照搬短剧领域维度。角色一致性、字幕同步、OS 嘴动、竖版裁切等是视频生成业务特有维度，对 Agent Trajectory 只能作为“分层与归因”的方法参考。
2. 不建议把 1/2/3 MOS 直接套到所有轨迹结论。Agent 轨迹很多问题更适合 categorical label，例如 verified_success、unverified、blocked、unsafe、cannot_judge。
3. 不建议用 LLM-as-Judge 替代已有确定性规则。当前项目已经有本地可验证事实，规则/代码应优先。
4. 不建议把所有维度强行接入外部评测平台。Agent Trajectory 的定位是本地优先、只读、安全边界清晰；外部平台只适合脱敏样本和离线评测。
5. 不建议把文档里的权重直接迁移。短剧用户感知权重不等于 Agent 执行质量权重；Agent 侧权重应由人工标注和真实任务风险校准。
6. 不建议读取或复制当前 Wiki 中引用的其他内部文档作为本轮依据。本轮唯一研究对象是当前 Wiki，外部引用只能记录为“存在但未读取”。

## 7. 证据清单

### 7.1 飞书来源证据

- `lark-cli wiki +node-get --node-token <wiki-url> --as user --format json`：成功解析 Wiki 节点，得到标题、node token、obj token、obj type、space_id、更新时间。
- `lark-cli docs +fetch --doc <wiki-url> --as user --scope outline --max-depth 4 --detail with-ids --doc-format xml --format json`：成功读取目录和 block id，document_id 为 `L3UbdWwpQofY5Zx89MucjtYInKh`，revision 为 `826`。
- `lark-cli docs +fetch --doc <wiki-url> --as user --scope section ... --doc-format markdown --format json`：成功读取一至六章正文片段，包括评测对象与目标、评测标准、组合式机评、人机一致性、路线图、附录。
- 未执行 `docs +update`、`wiki +move`、`wiki +node-create`、`wiki +member-*` 等写操作。

### 7.2 本地项目证据

- [README.md](../../../README.md)：项目定位、已实现能力、架构、安全边界、验证方式。
- [src/types.ts](../../../src/types.ts)：统一数据模型，包括 `TrajectoryRecord`、`TrajectoryProjection`、`ProjectionCoverage`、`TrajectoryTaskState`、snapshot/delta 响应类型。
- [src/projector.ts](../../../src/projector.ts)：DSH 投影、surface fold、coverage 汇总、taskState 折叠。
- [src/trajectory-analysis.ts](../../../src/trajectory-analysis.ts)：本地轨迹评测、证据定位、过程评测维度、Token/验证/恢复判断。
- [src/trajectory-optimization.ts](../../../src/trajectory-optimization.ts)：本地优化建议、问题类别、证据合并和 AI proposal 合并约束。
- [src/ai-summary-types.ts](../../../src/ai-summary-types.ts)：AI enhancement 模块、结构化输出、evidence requests 和 validated summary。
- [server/summary/protocol.ts](../../../server/summary/protocol.ts)：AI summary JSON Schema 与 evidence id 校验。
- [server/summary/adapters/openai-compatible.ts](../../../server/summary/adapters/openai-compatible.ts)：结构化输出模式与“不得编造事实/证据 ID”的系统约束。
- [server/summary/engine.ts](../../../server/summary/engine.ts)：按需读取补充证据并脱敏。
- [server/diagnosis/service.ts](../../../server/diagnosis/service.ts) 与 [server/diagnosis/evidence-store.ts](../../../server/diagnosis/evidence-store.ts)：冻结诊断证据、fingerprint 稳定性检查和只读证据快照。
- [skills/trajectory-diagnosis/SKILL.md](../../../skills/trajectory-diagnosis/SKILL.md)：诊断报告要求、只读证据命令、禁止编造与证据定位规则。
- [src/projector-utils.ts](../../../src/projector-utils.ts)：敏感信息脱敏。
- [scripts/verify-real-sources.ts](../../../scripts/verify-real-sources.ts)：真实来源验证摘要与隐私约束。

## 8. 结论

这份内部实践对 Agent Trajectory 的最大启发是：评测系统要先有明确的对象层级、维度、证据、归因和校准数据，再谈自动化。当前 Agent Trajectory 已经具备统一投影、证据定位、结构化 AI 输出、诊断快照、安全脱敏和过程评测等工程基础；下一阶段最值得做的不是增加更多泛化总结，而是建立金标/校准/对抗样本集，把“本地规则 + AI 增强 + 诊断报告”纳入同一套人机一致性与 badcase 归因闭环。

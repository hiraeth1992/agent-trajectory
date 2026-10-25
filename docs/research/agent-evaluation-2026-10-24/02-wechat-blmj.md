# 02 路调研：淘宝 AI 购物助手在线评测落地实践

研究对象：<https://mp.weixin.qq.com/s/blMjReLQZUuSK6bl6Bt3yA>
访问日期：2026-10-24
调研目标：完整阅读该分享，分析其中 Agent 评测 / 轨迹分析实践，并与当前 Agent Trajectory 工作区逐项对比，提炼可落地功能改进。

## 1. 来源信息与访问状态

| 项目 | 记录 |
| --- | --- |
| 标题 | 《淘宝AI购物助手在线评测落地实践》 |
| 微信 URL | <https://mp.weixin.qq.com/s/blMjReLQZUuSK6bl6Bt3yA> |
| 页面作者 / 署名 | 页面 `author` 元数据与正文头部为“营销&交易技术”；正文“团队介绍”称“本文作者 盈衣，来自 淘天集团-交易数据技术团队” |
| 公众号 | “大淘宝技术”（页面变量 `nick_name: '大淘宝技术'`，`user_name: 'gh_4b3f15bce4d8'`） |
| 发布时间 | 页面 `createTime = 2026-10-12 10:59`；页面 `ct=1791773982` 对应 2026-10-12 10:59:42 +08:00 |
| 摘要 / 描述 | 页面 `description` / `og:description` 为“淘宝AI助手日级评测实践” |
| 访问状态 | 使用桌面 Chrome UA 可读取完整 HTML 正文，正文抽取到 202 个文本块；简单 UA 会返回空壳页，说明访问方式对 UA 敏感 |
| 访问缺口 | 正文图片未做完整 OCR；页面可见外链主要为公众号专辑，不含论文 / 资料原始链接；文中提及的“美团 Agent 分层评测”“EvEye”等本轮未定位到稳定第一方资料，因此只作为“文章声称”记录 |

## 2. 文章核心方法

这篇分享的主线不是“用 LLM 打个分”，而是把 LLM-as-a-Judge 做成日级、可归因、可校准、可持续运营的线上 Agent 质量系统。最值得迁移到 Agent Trajectory 的不是电商业务细节，而是三件事：评测输入的证据治理、Rubric 的短路漏斗、以及评测结论到根因 / 修复验证的闭环。

### 2.1 目标指标：执行成功率

文章把购物助手质量定义为“执行成功率”：对每条线上 query，判定它是否被正确路由到对应 skill，并且被合理回应。它被拆成三层漏斗：

- 路由准确率；
- 回复正确率；
- 路由准确率 × 回复正确率 = 执行成功率。

评测粒度是多轮会话中的每轮对话，由 LLM-as-a-Judge 自动判断用户诉求是否被有效推进。文章强调不同域有不同判定口径，例如时效准确性、流程合规、知识准确性，不能用一个通用标准评所有场景。

### 2.2 五阶段 Pipeline

整体方案为：

1. 数据采集；
2. 数据清洗；
3. LLM 推理；
4. 结果解析与聚合；
5. 人工校验闭环。

工程分工上，文章采用“数仓 SQL + 推理平台 workflow”：数据预处理、过滤规则、后处理和指标聚合在数仓 SQL 中完成；推理平台只负责拼 Prompt、调用模型、返回结构化结果。这样 Prompt、数据清洗、过滤规则可以相对独立迭代。

### 2.3 四层数据清洗

文章把数据质量视为 Judge 可信度的第一瓶颈，提出四层清洗：

1. 修复数据格式不一致：补齐线上日志与离线 Prompt 期待字段之间的映射，处理卡片协议差异和超长文本截断。
2. 语义对齐：把用户语义和系统枚举显式映射，例如“已揽收”和系统状态枚举不应被 Judge 字面误解。
3. 屏蔽干扰信号：从 `tool_calls_json` 中剔除工具接口透传的内部系统提示词 / 生产链路提示词，只保留 Agent 实际调用参数和返回。
4. 过滤规则精化：用 skill 标识等精确过滤入口，避免把不属于该域真实意图的 query 抓进分母。

这部分对 Agent Trajectory 很关键：当前项目已经能展示 raw / projected 轨迹，但“某条轨迹是否适合被某个 Judge 判定”仍缺一层数据质量说明。

### 2.4 Workflow 稳定性设计

文章列出三类工程坑：

- 推理输出缺失：推理后设置 check 节点，对比 input 表和 output 表条数，完全一致才进入结果解析。
- 超长 Prompt 静默空结果：多轮对话 + 完整 tool_calls 可能超过上下文窗口，平台不报错但返回空结果，因此需要 token 预检、截断或摘要。
- 回刷分区追加而非覆盖：历史回刷前必须清空目标分区，否则新旧结果叠加导致通过率失真。

工作流按域拆分独立 workflow，避免“一个大 workflow”带来的短板效应、故障扩散和迭代耦合。

### 2.5 Judge 模型策略

文章当前选择指令遵循能力强、支持长上下文的大模型做 Judge，理由是 Judge 任务本质上是“按 Rubric 做复杂分类 / 判定”，比开放生成更依赖指令遵循和逻辑推理。模型策略分两步：

- 第一阶段：大模型 + Prompt 工程验证效果天花板，并沉淀标注数据。
- 第二阶段：基于多轮打标样本微调垂直小 Judge，降低日级推理成本。

温度参数上，文章通过梯度实验把 temperature 设为 0.1，以追求稳定可复现，同时避免 temperature=0 的偶发僵死。这个数值不应直接照搬到 Agent Trajectory，但“Judge 配置需要实测并版本化”值得吸收。

### 2.6 CNT 六层 Rubric 漏斗

文章最有价值的方法之一是统一 Rubric 框架：CTX / OOSR / OOC / TCC / CNT / RED 六层漏斗。

| 层 | 含义 | 文章中的作用 |
| --- | --- | --- |
| CTX | 上下文门控 | 判断证据是否足够；唯一产生 N/A 的层，证据不足时诚实剔除，不进通过率分母 |
| OOSR | 越界拒答 | query 不该由当前 skill 承接时，Agent 是否正确拒答或交回上层 |
| OOC | 能力边界诚实 | query 在 skill 范围内但超出当前能力时，是否诚实说明边界而非编造 |
| TCC | 工具执行链路 | 工具是否正确、参数是否匹配意图、调用链路是否自洽 |
| CNT | 内容与文本 | 回复内容正确性、完整性和表达质量；域差异最大 |
| RED | 安全红线 | 内部信息外泄、隐私泄露、敏感词、违规引导、编造政策；与串行层并联、恒评 |

串行层短路：任一层判 0，后续串行层记 N/A，整体判 0；RED 不受短路影响。这个设计同时提供失败主因定位和安全兜底。

### 2.7 Prompt 设计

文章沉淀了六类 Prompt / 解析实践：

- 输入输出变量声明：明确 `user_query`、`agent_reply`、`tool_calls_json`、`session_context` 等字段含义。
- 严格 JSON schema：评分字段只允许 `0/1/剔除`，理由字段必须是字符串，多维度输出位置固定。
- 幻觉压制：只基于输入判断，不引入外部知识；先摘录输入证据再判定；边界 case few-shot；信息不足时输出“剔除”。
- 时间锚点：把用户提问时间戳拼入输入，要求 Judge 以该时间戳评估“明天”“近一年”等时间表达。
- 分域 Prompt：不同域有不同评测重点，不用通用 Prompt 覆盖所有场景。
- 跨轮信息隔离：不是上下文越多越好；文章中的流程类域曾因把全对话工具链喂给 Judge，导致模型用前几轮工具返回误判当前轮回复，改为只传当条调用的 `tool_calls` 后通过率明显提升。

解析侧还有三层兜底：Prompt 结构化约束、输出校验器拦截非标输出、标签归一化处理新旧格式和空值。

### 2.8 多轮打标与归因闭环

文章把评测上线视为持续校准，而非一次性通过：

- 迭代流程：抽样打标 → Judge-Human 一致性校验 → 归因分析 → 优化 Prompt/Rubric → 发车评测 → 重抽样。
- 抽样口径：纯随机 HASH% 采样，保证通过率无偏。
- 置信区间经验：±1pp 约需 4k 样本，±0.5pp 约需 15k 样本；如果通过率波动远超 CI，应排查 Rubric / 模型 / 数据实质变化。
- 单 case 归因四层：数据层、Prompt 层、Rubric 层、Agent 真实质量问题。文章强调排除前三类后，剩余失败才应反馈为 Agent 质量缺陷。

归因输出分两层：

- 宏观：按 CNT 六层漏斗和子项码拆解失败分布。
- 微观：对具体问题构建可复跑 SQL / 正则检测规则，在修复前后分区对比命中数，验证问题是否收敛。

## 3. 关键能力、指标与案例

### 3.1 关键能力

- 日级自动评测：从人工月度 / 季度抽检转为日级自动观测。
- 多域独立 workflow：各域独立 Prompt、队列、并发度、重试策略。
- 数据清洗与证据门控：先判“是否可评”，再判“是否通过”。
- Rubric 版本化：每个域的 Rubric 以 Markdown 存储，包含 YAML 版本元数据和 changelog，在线 Prompt 从 Rubric 文件生成。
- Judge-Human 校准：每轮迭代后抽样人工标注，检查 Judge 与人工一致性。
- 归因驱动修复：失败不是只报通过率，而是定位到数据 / Prompt / Rubric / Agent 层。
- 修复核验：通过评分理由字段构造检测规则，对比修复前后命中数。
- 能力成熟度模型：L1 能评、L2 评得准、L3 省又全、L4 自动闭环、L5 自运营。

### 3.2 关键指标

- 执行成功率；
- 路由准确率；
- 回复正确率；
- 各域通过率；
- CNT 六层 / 子项码失败分布；
- Judge-Human 一致性；
- 抽样置信区间；
- 推理输入 / 输出完整性；
- Prompt 长度 / 推理缺失率；
- 解析失败率 / 标签归一化异常；
- 修复前后问题命中数；
- 成本、耗时、资源排队。

### 3.3 典型案例

1. 过滤规则导致路由成功率骤跌：某域路由通过率下降，归因发现分子稳定、分母暴涨；进一步拆子 label 后发现上游另一个 skill 放量导致大量咨询类 query 被误抓进该域分母。剔除该 label 后跌幅消失。
2. 跨轮信息串扰：流程类域把全对话工具链传给 Judge，模型用前几轮工具返回评判当前轮回复，导致误判；改为只传当前调用后通过率显著提升。
3. 干扰提示词误读：`tool_calls` 中未清洗系统提示词，Judge 误以为 Agent 输出了大量无关内容；清洗后通过率和人工一致性提升。
4. 定点修复核验：针对五类失败问题构造评分理由正则，修复前后对比分区命中数，判断哪些问题显著修复、部分收敛或未收敛。

## 4. 与当前 Agent Trajectory 能力映射

当前 Agent Trajectory 是“本地优先、只读、多来源轨迹查看器”，已把 DeepSeek Harness、Codex、ZCode 投影到统一时间线、虚拟账本和检查器中（`README.md:3-18`）。与文章实践相比，它已经具备轨迹事实层和局部确定性评测层，但还缺“面向 Judge / Rubric 的评测产品层”。

| 文章实践 | 当前项目已有能力 | 差距 / 启发 |
| --- | --- | --- |
| 多源日志汇聚 | `README.md:3-18` 描述三来源；`src/types.ts:148-187` 的 `TrajectoryRecord` 保留 `source/sourceEventIds/fidelity/traceId/spanId/input/output/error/usage/policy` | 已有统一事实结构，但缺少“这条记录是否适合被某个评测维度使用”的数据质量标记 |
| 数据清洗四层 | 投影器已做来源适配、脱敏、provenance；`README.md:201-213` 提到敏感键安全表示、详情响应不携带 raw/searchText | 还没有格式缺失、语义映射、工具噪声、超长上下文等 Judge-ready 质量报告 |
| CTX 证据门控 | `src/trajectory-analysis.ts:793-938` 在结果评估中区分有验证、未验证、未知；`README.md:221-224` 明确不会把“没有报错”当正确 | 有“未知”但不是可配置 Rubric 的 N/A / 剔除机制；也没有把不可评样本从聚合分母中剔除的统一口径 |
| 六层 Rubric | 当前五维过程评测为 `outcome/reliability/recovery/efficiency/observability`（`src/trajectory-analysis.ts:63-65`、`src/trajectory-analysis.ts:940-1075`） | 现有维度偏执行过程健康度；缺少“能力边界、工具链正确性、内容正确性、安全红线”的可扩展 Rubric |
| 工具链路判定 | `TrajectoryRecord` 有工具输入输出、错误、policy、approval 字段（`src/types.ts:171-187`）；README 提到检查器展示工具只读、破坏性、审批状态（`README.md:258-260`） | 可以支撑 TCC / RED 的证据，但目前未被组织成 Rubric 维度 |
| Prompt 结构化和事实锚定 | `server/summary/engine.ts:71-90` 的 `factsPrompt` 要求事实包是唯一可信数字 / 状态来源，文本是不可信数据；`server/summary/engine.ts:166-235` 验证模型返回的证据 ID 和模块完整性 | 还缺“证据摘录必须能在输入中找到”的 quote-level 校验，以及“证据不足输出剔除”的标准字段 |
| 二阶段补证 | `server/summary/engine.ts:483-556` 支持 AI 先提出 `evidenceRequests`，再按 recordId 读取、脱敏、限额补充证据 | 机制先进，但上下文隔离策略仍较粗；缺少“当前轮 / 当前工具调用 / 相关 span”级别的取证策略 |
| 本地确定性优化建议 | `src/trajectory-optimization.ts:372-462` 无模型调用，识别重复读取、确定性失败重试、环境错误、缺验证等；`README.md:225-232` 描述建议不自动执行 | 与文章“微观归因”方向一致，但分类仍偏 Agent 行为效率，不覆盖数据 / Prompt / Rubric / Agent 质量四层归因 |
| 冻结快照诊断 | `README.md:126-153`、`server/diagnosis/evidence-store.ts:83-107` 创建脱敏冻结快照；`server/diagnosis/evidence-query.ts:79-147` 提供 overview/findings/records/record 只读查询 | 已具备离线 Judge 取证的安全基座；可在此基础上加入 Rubric 版本、评测结果和人工标注 |
| 诊断报告契约 | `skills/trajectory-diagnosis/SKILL.md:31-36` 要求重建目标、行动链、结果与问题；`skills/trajectory-diagnosis/SKILL.md:42-52` 要求建议有对象、改法、预期改善、验证 | 与文章“评测不是报数，而是驱动修复”高度一致；但当前报告不是可聚合指标体系 |
| 版本化事实包 | `src/trajectory-facts.ts:19-73` 生成 `SummaryFactPackage`，`src/trajectory-facts.ts:76-103` 计算 hash 和估算 token | 可作为 Rubric / Prompt 版本化入口；当前缺 Rubric hash、Judge 配置 hash、上下文策略 hash |
| 成本可观测 | `README.md:240-244` 展示墙钟 / 活跃耗时、Token、缓存读取、覆盖率；`src/types.ts:133-145` 有 token 与 TTFT/decode/throughput | 适合评估 Judge 成本，但尚未对“评测自身”的 token、缺失率、解析失败率做单独看板 |

## 5. 候选优化项

### 5.1 引入可配置 Rubric 层：从五维过程评测扩展到“证据门控 + 短路漏斗”

- 价值：高。能把当前“过程健康度”评测升级为可解释的任务质量判定：先判断是否可评，再定位失败发生在目标理解、工具链、内容、安全等哪一层。
- 建议落点：在 `src/trajectory-analysis.ts` 的 `AnalysisEvaluation` / `buildEvaluations` 周边新增可配置 Rubric 数据结构；保留当前五维为默认本地视图。
- 最小设计：
  - `gate`: evidence 可用性，输出 `pass/fail/na` 和 `abstainReason`；
  - `layers`: 可短路的串行层；
  - `parallelLayers`: 类似 RED 的恒评层；
  - 每层包含 `id/title/verdict/evidenceRecordIds/confidence/limitations`。
- 成本：中到高。需要 UI、测试 fixture、AI summary schema 和诊断证据一起调整。
- 风险：如果 Rubric 太像电商 CNT，会偏离 coding-agent 场景；应抽象为“证据门控 / 能力边界 / 工具链 / 结果产物 / 安全约束”。
- 验证：
  - 用现有 fixtures 构造“缺工具输出”“最终修改未验证”“破坏性工具调用”等样本；
  - 断言不可评样本进入 N/A，不被算入通过率；
  - 断言短路层后续记 N/A，但安全层仍评估。

### 5.2 增加 Judge-ready 事实包质量报告

- 价值：高。文章反复说明 Judge 可信度瓶颈在数据质量；Agent Trajectory 目前能展示事实，但还没有告诉用户“哪些事实不适合评测”。
- 建议落点：扩展 `src/trajectory-facts.ts:19-73` 的 `buildSummaryFacts`，或新增 `buildEvaluationFacts`。
- 最小检查项：
  - 记录是否缺 `input/output/error/sourceEventIds`；
  - 是否有超长字段被截断；
  - 工具结果是否缺失；
  - trace/span/parent 关系是否断裂；
  - 时间锚点是否可用；
  - policy/readOnly/destructive/approval 是否缺失；
  - 是否存在来源 coverage gap。
- 成本：中。
- 风险：质量提示过多会干扰主流程；应按“会影响 Judge 判定 / 只影响展示”分级。
- 验证：
  - 为 Codex / DSH / ZCode fixture 分别快照质量报告；
  - 对已知缺字段 fixture 输出稳定 `qualityWarnings`；
  - summary facts hash 因质量报告变化而变化，缓存不会误复用。

### 5.3 为 AI 增强和诊断加入上下文隔离策略

- 价值：高。文章的跨轮串扰案例与 Agent 轨迹高度相关：前一轮工具输出、旧目标、被 shadowed 的上下文都可能污染当前判断。
- 建议落点：`server/summary/engine.ts:71-90` 的 facts prompt、`server/summary/engine.ts:483-556` 的补证流程、`server/diagnosis/evidence-query.ts:79-147` 的查询视图。
- 最小设计：
  - 为每个模块声明 `contextScope`: `session` / `turn` / `step` / `span` / `toolCall`；
  - 默认 outcome/story 可看 session，工具链正确性优先看 step/span/toolCall；
  - evidence request 返回时带上“为什么允许这条 record 进入上下文”。
- 成本：中。
- 风险：隔离过严会漏掉真正跨轮依赖，例如用户后续修正目标；需要允许 Rubric 显式声明跨轮依赖。
- 验证：
  - 构造多轮 fixture：前一轮工具返回 A，当前轮工具返回 B；
  - 断言当前轮评测不会引用 A；
  - 目标演化类评测仍能读取 steering / user correction。

### 5.4 强化结构化 Judge schema：从“证据 ID 合法”升级到“证据摘录可核验”

- 价值：高。当前 `validateDraft` 会校验证据 ID 属于允许集合，但还不验证模型理由是否 grounded 在具体文本。
- 建议落点：`src/ai-summary-types.ts` 的 AI enhancement 类型、`server/summary/engine.ts:166-235` 的 `validateDraft`。
- 最小字段：
  - `verdict`: `pass/fail/na/unknown`；
  - `quotedEvidence`: `{ recordId, quote, field }[]`；
  - `abstainReason`: 信息不足时必填；
  - `rubricLayerId` / `criterionId`；
  - `counterEvidenceRecordIds`。
- 成本：中。
- 风险：引用原文可能增加 token 和隐私暴露；需要沿用脱敏和字节上限。
- 验证：
  - 模型返回不存在的 quote 时应被拒绝或降级；
  - 信息不足但硬判 pass/fail 时应校验失败；
  - 大字段截断时 quote 只能匹配 preview 或明确标注不可核验。

### 5.5 建立“评测归因层”而不只是“优化建议类别”

- 价值：高。文章的四层归因（数据 / Prompt / Rubric / Agent 真实质量）可以直接改善当前优化建议的解释力。
- 建议落点：`src/trajectory-optimization.ts:3-10` 的 category / measure 枚举和 `OptimizationSuggestion`。
- 最小设计：
  - 新增 `rootCauseLayer`: `source-data` / `projection` / `rubric` / `prompt` / `agent-behavior` / `environment` / `verification`；
  - 每条建议必须说明“为什么不是前一层问题”或标记未排除；
  - 对无法排除的数据质量问题，建议先补证，不直接归因给 Agent。
- 成本：中。
- 风险：自动归因容易过度自信；默认应输出“候选归因 + 下一步补证”，只有结构化证据充分时才高置信。
- 验证：
  - 对缺工具输出样本，归因为 `source-data/projection` 而非 Agent 错；
  - 对明确失败且数据完整样本，才进入 `agent-behavior`；
  - UI 中同一根因建议能合并展示。

### 5.6 增加人工校准 / 标注导出小工具

- 价值：中到高。Agent Trajectory 要评估 Judge 是否可信，迟早需要小规模人工标注闭环。
- 建议落点：新增只读 CLI 或页面导出能力，不必引入外部系统。
- 最小功能：
  - 从本地 sessions / fixtures 抽样 record 或 step；
  - 导出 JSONL/CSV：目标、上下文、证据、当前本地评测、待标注字段；
  - 回读标注结果，计算准确率、冲突样本、置信区间；Kappa 可作为第二阶段。
- 成本：中。
- 风险：本地轨迹可能含敏感信息；必须默认脱敏，并让用户显式选择导出位置。
- 验证：
  - synthetic 标注集能算出稳定通过率和 CI；
  - 无标注时不影响现有 UI；
  - 导出文件不含 `raw` 和已脱敏字段原文。

### 5.7 评测自身的可观测性面板

- 价值：中。当前项目展示被观察 Agent 的耗时 / Token，但尚未单独展示“评测过程”质量。
- 建议落点：summary / diagnosis 相关服务和 UI。
- 指标：
  - AI 增强事实包 token 估算（已有 `estimateSummaryInputTokens`，`src/trajectory-facts.ts:82-103`）；
  - evidenceRequests 数量、命中率、被拒绝 ID 数；
  - 模型结构化解析失败数；
  - quote 校验失败数；
  - 证据截断数；
  - 每个 Rubric 版本的判定分布。
- 成本：低到中。
- 风险：面板过重；可以先放入调试 / 详情区域。
- 验证：
  - 对同一 fixture 重跑，评测元指标稳定；
  - 模型返回非法 evidence ID 时计入 rejected；
  - 大证据被截断时计入 truncation。

### 5.8 Rubric / Prompt / Judge 配置版本化

- 价值：中。文章强调 Rubric 像代码一样 review 和追溯；当前项目已有 facts hash 和 prompt version，但缺 Rubric 版本。
- 建议落点：AI summary cache 和 diagnosis snapshot。
- 最小字段：
  - `rubricId`、`rubricVersion`、`rubricHash`；
  - `judgeAdapterId`、`judgeModel`、`judgeTemperature`；
  - `promptVersion` 已有，可继续保留；
  - `contextPolicyHash`。
- 成本：低到中。
- 风险：版本字段过多导致缓存频繁失效；但这是评测可追溯性的必要成本。
- 验证：
  - 修改 Rubric 后旧缓存失效；
  - 诊断快照能显示当时使用的 Rubric / Judge 配置；
  - 同一事实包、同一 Rubric、同一配置可复用缓存。

## 6. 不建议照搬项

1. 不建议照搬“路由准确率 × 回复正确率 = 执行成功率”作为唯一北极星。Coding Agent 的“路由”不是固定电商 skill，很多任务是探索式、多工具、多阶段协作，更适合抽象为“目标识别 / 工具链 / 产物 / 验证 / 安全约束”的多层 Rubric。
2. 不建议建设数仓 + 日级全量分布式推理平台。Agent Trajectory 的产品定位是本地优先、只读查看器；可以做本地 batch / fixture regression，但不应把项目变成在线数据仓库系统。
3. 不建议把整段会话和全部 tool_calls 默认喂给 Judge。文章案例说明这会引发跨轮串扰；Agent Trajectory 尤其有 replacement、shadowed context、父子会话、trace/span，必须做上下文隔离。
4. 不建议为了“通过率上升”调 Prompt。文章明确多轮优化目标是让数字更可信，而不是更好看；Agent Trajectory 也应把数据层 / Prompt 层 / Rubric 层 / Agent 行为层分开。
5. 不建议早期投入小 Judge SFT 或 GRPO 闭环。当前项目缺人工标注集、线上分布和稳定 Rubric；应先做 Rubric 版本化、证据质量、校准导出。
6. 不建议直接采用电商 CNT 子项。CTX/OOSR/OOC/TCC/CNT/RED 的结构值得借鉴，但子项必须重写为 coding-agent 场景，例如目标约束、文件修改、验证证据、外部副作用、敏感信息、不可恢复错误。
7. 不建议把 temperature=0.1 当通用最优。文章是在其模型、业务和 Prompt 下实验得出；Agent Trajectory 应记录 Judge 配置并用标注集比较稳定性。

## 7. 证据清单

### 7.1 指定来源

- 微信原文：《淘宝AI购物助手在线评测落地实践》，<https://mp.weixin.qq.com/s/blMjReLQZUuSK6bl6Bt3yA>。2026-10-24 使用桌面 Chrome UA 访问，HTML 正文可读，抽取 202 个文本块。
- 页面元数据：`og:title=淘宝AI购物助手在线评测落地实践`，`description=淘宝AI助手日级评测实践`，`author=营销&交易技术`，`createTime=2026-10-12 10:59`，`nick_name=大淘宝技术`。
- 正文署名：团队介绍称“本文作者 盈衣，来自 淘天集团-交易数据技术团队”。

### 7.2 外部第一方 / 高可信资料追溯

- Zheng et al., “Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena”, arXiv: <https://arxiv.org/abs/2306.05685>。摘要中说明 GPT-4 judge 与受控和众包人类偏好匹配，达到超过 80% agreement，并揭示位置、冗长、自我增强等偏差。
- AlpacaEval 官方仓库：<https://github.com/tatsu-lab/alpaca_eval>。仓库首页说明 AlpacaEval 2.0 length-controlled win-rates 与 Chatbot Arena 的 Spearman correlation 为 0.98，并强调低成本、快速和 length gameability 降低。
- JudgeLM 论文：<https://arxiv.org/abs/2310.17631>；官方仓库：<https://github.com/baaivision/JudgeLM>。摘要 / README 说明训练 7B/13B/33B judge，JudgeLM-7B 可在 8 张 A100 上约 3 分钟评 5K 样本，并达到超过 90% teacher judge agreement。
- Arena-Hard-Auto 官方仓库：<https://github.com/lmarena/arena-hard-auto>。仓库说明 v2.0 preview 包含 500 个新鲜、困难的真实用户查询和 250 个 creative writing 查询，并使用 GPT-4.1 / Gemini-2.5 等自动 Judge。

未完全追溯：文章提到的“美团 Agent 分层评测”“EvEye”、以及“Arena-Hard 500 题达到 MT-Bench 三倍区分度”的具体出处，本轮没有定位到稳定第一方链接；报告中未把这些作为已核验事实使用。

### 7.3 本地项目证据

- 项目定位和三来源：`README.md:3-18`。
- 本地诊断入口、冻结快照、受控 Skill、只读证据：`README.md:120-153`。
- 已实现轨迹评测、五维过程评测、优化建议、故事线、成本和诊断：`README.md:221-255`。
- 会话头展示 trace/span、Goal/Todo、工具审批 / 副作用：`README.md:258-260`。
- 统一记录结构：`src/types.ts:148-187`。
- 轨迹投影结构：`src/types.ts:245-266`。
- 结果评估逻辑：`src/trajectory-analysis.ts:793-938`。
- 五维过程评测：`src/trajectory-analysis.ts:940-1075`。
- 分析入口：`src/trajectory-analysis.ts:1077-1095`。
- 本地优化建议类型与确定性分析：`src/trajectory-optimization.ts:1-60`、`src/trajectory-optimization.ts:372-462`。
- AI summary 事实包：`src/trajectory-facts.ts:19-73`；facts hash / token 估算：`src/trajectory-facts.ts:76-103`。
- AI 增强事实 Prompt 与校验：`server/summary/engine.ts:71-90`、`server/summary/engine.ts:166-235`。
- AI 二阶段补证：`server/summary/engine.ts:483-556`。
- 诊断 Skill 的证据循环和报告契约：`skills/trajectory-diagnosis/SKILL.md:18-83`。
- 诊断快照写入与脱敏：`server/diagnosis/evidence-store.ts:43-107`。
- 诊断证据查询视图：`server/diagnosis/evidence-query.ts:79-147`。

## 8. 结论

这篇文章对 Agent Trajectory 的最大启发是：轨迹评测要从“展示过程 + 给出局部建议”继续前进到“可审计的 Judge 输入、可版本化的 Rubric、可校准的评测结论、可归因的修复闭环”。当前项目已经有非常好的底座：多来源投影、provenance、只读冻结快照、二阶段补证、本地确定性优化建议。优先落地时，不应先追求大规模自动打分，而应先补三块基础能力：

1. Judge-ready 事实包质量报告；
2. 可配置 Rubric / 证据门控 / 短路漏斗；
3. 上下文隔离 + 证据摘录可核验的结构化 Judge schema。

这三项完成后，人工标注校准、评测元指标面板、Rubric 版本化和本地 batch regression 才会有稳定地基。

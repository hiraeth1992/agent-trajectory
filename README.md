# Agent Trajectory

一个独立、只读的多来源 Agent 轨迹查看器。它把 DeepSeek Harness、Codex 和
ZCode 的本地会话投影到同一套时间线、虚拟账本和检查器中。

## 来源状态

| 来源 | 当前支持 | 本地事实源 |
| --- | --- | --- |
| DeepSeek Harness | 可用 | `~/.dsh/sessions/**/session.v4.jsonl.zstd` |
| Codex | 可用 | `~/.codex/sessions/**/rollout-*.jsonl` |
| ZCode | 可用 | `~/.zcode/cli/db/db.sqlite` |

ZCode 适配器读取正式的 `session`、`message`、`part`、`model_usage`、
`tool_usage` 和 `turn_usage` 表，支持消息、推理片段、工具调用、模型计时与
Token 用量。核心六表保持强 schema 门禁；`trace / lineage / policy / tasks` 通过
可选能力探针渐进启用，旧数据库缺少这些字段时仍可读取核心轨迹并明确显示降级状态。
它不会读取 `credentials.json`、证书、Cookie、浏览器存储或模型请求头。

## 轻量运行与分发

Agent Trajectory 不再分发 Electron 安装包。发行物只包含本地 Node 服务、React 静态页面、
SQLite Worker、投影 Worker 和内置 Zstandard 解码器，通过系统浏览器展示；不携带
Chromium，也不会安装系统服务。

环境要求：Node.js 22.12+。

在线运行：

```bash
npx agent-trajectory
```

离线或内网分发：

```bash
npm run pack:tgz
npx --yes ./agent-trajectory-0.1.0.tgz
```

当前压缩包约 200 KiB、解包后不足 1 MiB。启动器只监听随机的 `127.0.0.1` 端口，
使用一次性启动 URL 为浏览器建立本机会话；关闭前台进程会同步关闭服务和 Worker。
常用命令：

```bash
agent-trajectory                     # 启动或复用现有实例并打开页面
agent-trajectory start --no-open     # 只启动服务
agent-trajectory doctor              # 检查三类来源的路径、状态和会话数
agent-trajectory setup               # 交互式保存自定义来源路径
agent-trajectory install-hooks       # 安装三类 Agent 的新会话联动
agent-trajectory uninstall-hooks     # 只移除本项目安装的联动项
```

`install-hooks` 会把轻量运行时复制到 `~/.agent-trajectory/runtime/`，因此一次性 `npx`
缓存被清理后，Agent Hook 仍能按需启动查看器。它会增量合并 Codex/ZCode 的现有 Hook，
为 DSH 添加独立插件和带标记的配置块，并为被修改的配置创建一次
`.agent-trajectory.bak` 备份。Codex 会要求用户通过 `/hooks` 检查并信任新增 Hook；
DSH 和 ZCode 需要重启后加载配置。

Hook 是当前机器的本地生成物：命令中包含安装时的 Node、轻量运行时和数据目录绝对路径。
`install-hooks` 可重复执行，并会用当前环境刷新这些路径和
`~/.agent-trajectory/hook-installation.json` 安装清单。Node 安装位置、操作系统、数据目录
或 Agent Trajectory 版本变化后，`doctor` 会将 Hook 标记为 `stale` 并给出修复命令。
手动启动查看器和已有轨迹数据不受失效 Hook 影响，但新会话不会再自动打开或切换页面。

新建顶层会话时，Codex、ZCode 和 DSH 都会把来源及 `session_id` 发送给本机 Relay：

- 已有 Trajectory 页面时，复用该页面并切换到当前会话；
- 没有页面时，打开系统默认浏览器；
- 会话文件尚未落盘时，页面显示等待状态并自动接入；
- `compact`、`clear` 和重复事件不会重复打开页面；
- Hook 失败不会阻断 Agent 会话。

当前安装版本的 DSH/ZCode 没有稳定公开的“把任意 URL 导航到内置浏览器”入口，Codex
Hook 也不能直接控制其内置浏览器，因此发行版统一使用系统浏览器。联动 Interface 与
深链接保持宿主无关，未来可在 Agent 提供公开导航能力后增加内置浏览器 Adapter。

精确会话链接格式为：

```text
http://127.0.0.1:<随机端口>/?source=codex&session=<session-id>
```

普通查看时，原始轨迹始终留在对应 Agent 的目录中，不复制、不上传。只有用户主动启动
轨迹诊断时，服务才会在本地数据目录写入一份私有、脱敏的冻结快照，供新建的只读诊断
会话使用。

来源路径按以下优先级解析：

```text
CLI 参数 → ~/.agent-trajectory/config-v1.json → 环境变量 → 当前用户默认目录
```

对应参数为 `--dsh-dir`、`--codex-home`、`--codex-sessions-dir` 和
`--zcode-db`。配置文件支持 `${HOME}` 与 `${CONFIG_DIR}`，因此可以复制到用户名或
Home 目录不同的电脑。项目不会扫描整块磁盘；非默认位置应通过 `setup`、CLI 参数或
环境变量明确指定。

迁移到其他电脑或用户时，可以复制使用 `${HOME}` / `${CONFIG_DIR}` 的来源配置；不要复用
旧机器生成的 `runtime/`、`hook-installation.json` 或 Agent Hook 命令。推荐在新环境执行：

```bash
agent-trajectory doctor
agent-trajectory install-hooks
agent-trajectory doctor
```

首次 `doctor` 用于核对来源路径并识别旧 Hook，安装命令会重建当前机器的轻量运行时和
三类 Agent Hook，第二次 `doctor` 用于确认迁移后的状态。若使用了非默认数据目录，三个
命令都应附加相同的 `--data-dir <路径>`。

## 开发模式

环境要求：

- Node.js 22.12+

```bash
npm install
npm run dev
```

默认地址：<http://127.0.0.1:4317>

可选配置：

```bash
PORT=4318 npm run dev
DSH_SESSIONS_DIR=/path/to/sessions npm run dev
CODEX_HOME=/path/to/.codex npm run dev
CODEX_SESSIONS_DIR=/path/to/codex/sessions npm run dev
ZCODE_DB=/path/to/zcode/db.sqlite npm run dev
ZSTD_BIN=/path/to/zstd npm run dev
```

默认使用内置的纯 JavaScript Zstandard 解码器。`ZSTD_BIN` 只用于显式切换到外部
`zstd` 可执行文件。

### 本地轨迹诊断

“轨迹评测”中的本地事实分析和优化建议始终自动运行且不调用模型。本地建议只分析有
结构化证据的重复读取、同类错误重试、明确环境错误和修改后验证缺口；正常轮询、验证重跑、
用户要求复核和修改后的重新执行不会被直接当作浪费。

执行结论区提供“本地 Agent 诊断”入口。点击后，服务会在目标来源指纹保持稳定时创建一份
私有、脱敏的冻结快照，并生成轻量诊断 Prompt。页面把 Prompt 写入剪贴板并提示用户
打开新会话粘贴执行，不会自动创建、命名、发送消息或打开任何 Agent 会话。

Prompt 显式调用发行包内的 `$trajectory-diagnosis` Skill，并只携带 Skill 路径、诊断协议、
来源、`session_id`、快照 ID、只读取证命令和证据目录。取证流程、风险边界、诊断方法、
建议规范和报告格式都由 Skill 统一维护，不在 Prompt 中重复。新会话通过专用只读命令按需
读取概览、本地问题发现、分页记录或指定 `record_id` 的详情证据；超大输入输出默认按字段
限制为 64 KiB 并明确标记截断。最终报告固定为四块：

- `【最终目标】`：最终收敛目标、目标演化及是否偏离用户初衷；
- `【模型思维&行动】`：抽象可观察到的判断、行动、反馈和调整，不展示或编造隐藏思维链；
- `【结果】`：完成度、产物、验证、目标偏差、遗留问题和根因；
- `【问题&建议】`：相同根因和改法先合并，每个问题只给一个首选方案；有代码证据时指出
  真实文件与修改位置并给出最小草案，属于 Agent 行为时给出可直接加入 `AGENTS.md` 的完整
  规则，最后写明预期改善和可核查的通过条件。证据不足时只标记候选位置并给出最小补证步骤。

复制 Prompt 不会读取或保存 Agent 凭证，也不会调用 Agent 的会话创建接口。冻结证据和只读
命令都位于当前运行 Agent Trajectory 的本机，因此 Prompt 需要在能够访问该本机路径的新
会话中执行。

生产构建：

```bash
npm run build
npm start
```

## 已实现

- 统一 `SessionSource` 契约、来源 Registry、安全 opaque ID 路由和指纹缓存。
- DSH v4 header、连续 `seq`、未知 required event 与 torn tail 校验。
- DSH turn/step、assistant、tool、PTC subtool、compaction、TTFT 与 Token 投影。
- DSH model surface replacement fold：append-origin transcript、当前模型上下文和完整
  audit 轨迹分层展示；记录标记 `current / shadowed`，并保留 append/replace 的完整
  replacement/source 关系；非法或重复来源引用 fail closed。
- DSH 会话谱系原样贯通 `parentSession / origin / delegationDepth`；`goal/change` 折叠为
  当前目标，并按上游 revision/阶段/轮次/时间戳状态机严格 replay，首次失败后冻结在最后
  可信状态；`todo/write` 仅接受完整合法快照、last-write-wins，并在下一次
  `turn/start` 清除。
- DSH 事件使用 `record / folded-state / relation-only / raw-only / unsupported`
  disposition 统计投影覆盖，未消费的已知事件不再被“无未知事件”掩盖。
- Codex `session_meta / turn_context / event_msg / response_item / token_usage_record` 投影。
- Codex function/custom tool call-result 配对，并用完成事件补充计时、退出码和输出。
- Codex 在来源没有原生 step 字段时，以每轮模型响应边界派生逻辑步骤：输入/上下文为步骤
  0，同一响应关联的推理、助手消息、工具和模型用量共享步骤号，下一响应递增，跨轮次重置。
- ZCode SQLite schema 门禁、可见/运行时上下文消息区分、工具/用量关联和递归脱敏。
- ZCode message/part、model/tool/turn usage 的时间、状态、TTFT 和 Token 投影。
- ZCode 可选 schema 能力协商：支持会话 parent/trace、模型 trace/span、工具副作用与
  审批属性、turn 可靠性计数，以及 target/todo；部分存在的可选列不会泄露成半套语义。
- Codex/未压缩 DSH 按 byte offset 增量读取；ZCode message/part 按更新时间水位合并。
- ZCode 使用单个常驻 SQLite Worker 保持主线程非阻塞；WAL 更新可见，删除/替换缓存
  不一致时自动回退完整快照。
- 三来源投影统一在一个共享 Worker 中执行。DSH/Codex 安全追加只传新增事件；Worker
  状态淘汰或追加前提不成立时自动请求完整快照。ZCode 为正确处理旧行更新和删除，仍传
  完整合并输入，但投影计算不占用 HTTP 主线程。
- ZCode 指纹按当前会话的 session/message/part 水位与实际投影的 model/tool/turn usage、
  trace/policy/task 事实计算；即使来源原地修正 usage 或可选字段且时间戳不变，也能触发
  当前会话刷新，同时不会因无关会话或 WAL/SHM 元数据变化误刷新。
- 加密内容和敏感键只保留安全表示，不尝试解密。
- `/api/sources` 统一提供 label/color/icon token、来源筛选、能力和 blocked 原因。
- 每条展示记录保留 `source / sourceEventIds / fidelity` provenance。
- 1.5 秒指纹 SSE，只刷新当前来源和会话的已落盘数据。Codex 首次列表建立共享
  页面/目录索引；稳定轮询只 stat 已知目录、当前会话页面和 session index，目录变化时
  才读取新增 rollout 的首行，因此能发现跨日期目录续页而不会反复读取无关会话。
- 同一会话已有详情请求在途时，连续 SSE 更新只合并为一次待刷新；当前请求结束后最多
  补拉一次，切换会话仍会取消旧请求。
- 详情接口使用内容 revision：首次返回 snapshot，后续按记录 ID 返回 upsert/delete delta；
  revision 过期或客户端合并失败时自动回退完整 snapshot。相同详情对象复用已准备的
  transport/revision，避免同一版本重复脱敏、序列化和摘要计算。
- 详情响应不携带 raw 和 `searchText`；检查器打开“原始事件”后按记录懒加载，
  大输入/输出显式截断，搜索文本由客户端基于脱敏后的可见预览生成。
- Registry 详情、三来源解析结果和 API revision 历史均使用条目数与估算字节数双重
  有界 LRU；超预算只触发安全重建或完整 snapshot，不影响当前请求。
- 可切换的对话/轨迹视图：对话展示用户和助手正文，运行上下文、推理与工具按轮次折叠。
- DSH 会话在有 replacement 事实时额外提供“模型上下文”视图；“对话”始终保留 durable
  transcript，“轨迹”始终保留完整审计记录；切换到不支持独立模型上下文的会话时自动
  回到“对话”视图。
- 对话消息可一键定位到轨迹记录；两个视图共用搜索和检查器。
- 新增默认“轨迹评测”视图：以执行结论、决策与行动路径、分步耗时/Token/缓存成本、
  纠错改道链和五维过程评测解释模型做了什么、为什么这样做以及异常是否恢复；所有证据均
  可反向定位到轨迹记录。评测区分轨迹事实、相邻步骤推断和来源未记录，不会在缺少测试、
  断言或业务真值时把“没有报错”表述为“结果正确”。
- “过程评测”下方新增“优化建议”：本地规则默认生成有证据的可执行建议，逐项展示问题、
  原因、推荐措施、实施位置、预期改善、验证方式和判断限制，并支持证据定位与复制。建议
  只用于展示，不会自动修改代码、规则、Hook、插件或环境。
- 每条优化建议同时给出至少一项结构化“可执行动作”，可包含直接放入 `AGENTS.md` 的规则、
  候选代码位置与最小代码草案、Hook 或工作流步骤，并可独立复制。没有真实文件证据时只写
  “候选位置”，不会伪造项目路径；复制内容仍需用户审阅，不提供一键执行。
- 优化建议会为未恢复错误生成高优先级收敛建议；同一轮出现多个不同错误并最终恢复时，
  达到阈值后提示增加能力或环境预检。单次已恢复错误和正常暂时性重试保持安静。
- 总结分析以 `turn + step` 聚合逻辑步骤：同一步内的推理、助手消息、工具和模型用量只
  展示一次，并通过本地确定性模板生成中文行动、原因、执行和结果摘要。纠错链保持紧凑
  单行，使用“触发 / 模型判断 / 调整 / 结果”小型高亮标签；每段正文最多显示 30 个字符
  且不追加省略号，悬停或键盘聚焦可查看完整内容，证据链可定位原始记录，不调用外部模型。
- A 故事线布局将本地执行故事线放在统计区和轮次明细之间：把逻辑步骤确定性压缩为最多
  8 个阶段，失败与后续修正/验证归入同一恢复阶段；点击或播放阶段会展开并高亮下方
  关联轮次和步骤，点击轮次/步骤也会反向选择所属阶段，原始证据仍通过独立定位按钮查看。
- 总结同时展示会话创建至更新的墙钟耗时，以及与轨迹概览复用同一套区间并集口径的活跃
  耗时；Token 指标合并展示总量、输入、输出、推理输出和缓存读取，步骤成本按逻辑步骤
  聚合并去重模型用量；墙钟范围同时包络来源会话时间和实际记录区间；耗时和 Token 模式
  分别严格降序，步骤条长度代表相对总量，颜色按总量关系生成互斥拆分。无法归属到具体
  步骤的 Token 会单独显示未分配量和步骤覆盖率，不参与成本集中度判断。
- 轨迹评测页采用故事线布局：单击阶段查看聚合结论，双击展开对应步骤明细
  三套信息结构，底部切换器和方向键可切换；生产构建固定使用 A 故事线布局。
- 轨迹评测页在原“查看结论证据”位置提供“触发图标 + 本地 Agent 诊断”按钮；点击后直接
  使用当前来源/会话生成冻结快照和轻量 Prompt，复制后提示用户打开新会话；入口不会
  自动创建、发送或打开 Agent 会话，且可分析三种来源。
- 诊断 Prompt 显式调用发行包内 `$trajectory-diagnosis` Skill；Skill 通过专用只读命令
  按需查询冻结证据，避免将完整会话或诊断规范重复注入上下文。
- 诊断报告固定为最终目标、模型思维&行动、结果、问题&建议四块；只抽象可观察判断和行动，
  不输出或编造隐藏思维链。问题建议按根因和改法去重，优先给出真实文件/代码修改草案或
  可直接粘贴到 `AGENTS.md` 的规则，并附明确验证条件。
- Token 成本图例支持多选筛选与“全部”恢复；排行、步骤值、条形总长度和条内占比均按
  当前选中的 Token 类型重新计算，至少保留一种类型，切换到耗时后仍保留本次选择。
- 会话头展示输入/输出/总 Token、已完成/总轮次、投影 coverage、父会话/trace 和当前
  Goal/Todo 状态；检查器展示 trace/span 与工具只读、破坏性、审批状态。
- 三泳道概览、轮次/调用折叠、虚拟账本、检查器，以及投影/完整审计双导出。
- 1440x900 与 390x844 响应式布局。

## 架构

```text
DSH files -----> DshSource ----+
Codex JSONL ---> CodexSource --+--> shared projection Worker --> SourceRegistry
ZCode SQLite --> SQLite Worker +--> ZcodeSource -------------------+
                                                                  |
                                                                  v
                                                              API + SSE
                                                                  |
                                                                  v
                                                 timeline + ledger + inspector
```

Adapter 直接返回统一 `SessionDetail`，不会把不同来源事件伪装成 DSH
`SessionEvent`。来源失败相互隔离；未知数据库结构和无法证明的关联一律 fail closed。

## 详情同步与缓存预算

`GET /api/sessions/:source/:id` 返回：

- 无 `revision`：`{ kind: "snapshot", revision, detail }`
- revision 仍在历史中：`{ kind: "delta", baseRevision, revision, upserts, removedIds, recordOrder, ... }`
- revision 已淘汰：自动返回新的 snapshot

Delta 以稳定 record ID 为边界，因此既能追加记录，也能更新运行中记录、删除记录和调整顺序。
服务端最多为 64 个会话保留最近 2 个网络快照，总预算 64 MiB。

详情路由必须显式携带来源：`GET /api/sessions/:source/:id`。旧的
`GET /api/sessions/:id` 路由已移除；路径段含非法 URL 编码时返回 400。

## 导出

- “投影导出”由浏览器导出当前已加载的会话投影，适合查看和二次处理；它不包含按需加载的
  原始事件，超长输入/输出可能是详情接口返回的显式截断预览。
- “审计导出”请求 `GET /api/sessions/:source/:id/export`，返回 v2 格式：保留完整、已脱敏的
  投影详情，并在 `sourceEvents` 中包含来源 adapter 读取的全部原始事件，包括未形成投影记录的
  `raw-only` 和语义校验失败事件；不包含内部 `searchText`。所有源事件都在导出边界统一脱敏。

默认内存预算：

| 缓存 | 条目上限 | 估算字节上限 |
| --- | ---: | ---: |
| SourceRegistry 详情 | 16 | 128 MiB |
| DSH / Codex / ZCode 各来源解析缓存 | 各 8 | 各 96 MiB |
| 每个 SourceRegistry 的投影 Worker 状态 | 16 | 192 MiB |
| Codex 页面/目录索引 | 磁盘现存 rollout 与目录 | 每页仅保留路径、会话 ID 和 summary 元数据 |
| API revision 历史 | 64 个会话 | 64 MiB |

LRU 的字节数按 JSON 序列化大小估算，不代表进程 RSS 的精确值。单个条目若已超过预算，
本次请求仍正常返回，但该条目不会驻留缓存。

## 安全边界

- HTTP 只绑定 `127.0.0.1`。
- `HOST` 只允许 loopback；每个静态资源和 API 请求同时校验 Host、端口和远端地址，
  拒绝 DNS rebinding 与非本机转发。
- 客户端只能提交来源和 opaque session ID，不能提交本地路径。
- DSH 和 Codex 仅扫描预设会话目录中的白名单文件名。
- ZCode 数据库通过 Node SQLite 的 `readOnly` 模式打开，所有查询使用绑定参数。
- 不读取 `.credentials`、`credentials.json`、证书、Cookie、token 或浏览器存储。
- 工具输入/输出及原始事件中的敏感键会递归脱敏。
- 不修改、注入、Hook、解密或重签名任何原应用。
- 准实时只承诺持久数据变化后约 1–2 秒可见，不读取进程内未落盘 Token。

## 验证

```bash
npm test
npm run build
npm audit --registry=https://registry.npmjs.org
```

在本机三个来源都可用时，可重新生成真实来源验证摘要：

```bash
# 冒烟验证：选择各来源当前最新会话
npm run verify:real-sources
# 以下文件只保留在本机，已被 Git 忽略
npm run verify:real-sources -- --output evidence/real-source-verification.json

# 可复现验证：三个 ID 必须同时提供，不能与“最新会话”混用
npm run verify:real-sources -- \
  --dsh-session '<dsh-session-id>' \
  --codex-session '<codex-session-id>' \
  --zcode-session '<zcode-session-id>' \
  --output evidence/real-source-verification.json
```

默认只向标准输出写结果；指定 `--output` 才会写文件。摘要只包含生成时间、计数、布尔
覆盖标记和 SHA-256，不包含会话正文、原始 session ID、主目录路径、凭据形态字段或
原始记录。`selectionMode` 区分 `latest` 冒烟与 `explicit` 固定选择；
`sourceSessionSha256` 是 session ID 的不可逆标识，`sha256` 覆盖完整的已脱敏详情，
用于证明同一份输入可复核，而不是用于恢复内容。

显式 ID 固定的是会话身份，不是文件快照；如果被选会话后来继续写入，详情 `sha256`
仍会随内容变化。需要长期稳定的仓库证据时，应选择已结束、已静置的会话，并结合生成时间
复核。即使摘要不包含会话正文，它仍由本机真实会话派生，因此默认不应提交到公开仓库。

测试覆盖三来源匿名生产形状 fixture、DSH/Codex 增量 JSONL 与 torn tail、
DSH surface replacement、append/replace source lineage、projection coverage、lineage、
严格 Goal replay 与 Todo 快照 fold、call-result 去重、abort、TTFT/Token、
ZCode SQLite 可选能力/schema/WAL/水位合并/删除回退及投影事实指纹、
运行中 assistant/tool、大输出、递归敏感信息脱敏、有界 LRU、Registry 来源隔离、
snapshot/delta API、完整审计导出、客户端 revision 失配回退、SSE、前端请求竞态、
证据摘要隐私白名单，以及 10 万事件复杂度、三来源 parse/project、共享 Worker 往返和
长工具输出脱敏的分阶段性能门禁。

性能、可靠性和可维护性的分级优化建议见
[`docs/OPTIMIZATION.md`](docs/OPTIMIZATION.md)。

## 参与贡献

提交修改前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。安全问题请按
[`SECURITY.md`](SECURITY.md) 中的方式私下报告，避免在公开 Issue 中附带真实会话、
本地路径、凭据或未脱敏导出。

## 许可证

本项目采用 [MIT License](LICENSE)。

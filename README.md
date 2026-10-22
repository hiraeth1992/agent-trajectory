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

## 桌面安装包

桌面版将本地服务、React 界面、SQLite Worker 和 Zstandard 解码器一并打包。普通用户安装后
直接启动，不需要预装 Node.js、npm 或 `zstd`。应用只在本机随机回环端口提供服务，退出
应用时同步关闭服务和 Worker。

当前支持的发行目标：

| 平台 | 产物 |
| --- | --- |
| macOS | `.dmg`、`.zip` |
| Windows x64 | NSIS `.exe` |
| Linux x64 | `.AppImage`、amd64 `.deb` |

本机开发运行：

```bash
npm install
npm run desktop
```

生成当前平台安装包：

```bash
npm run dist
```

也可以使用 `npm run dist:mac` 或 `npm run dist:win`。Linux DEB 需要公开项目元数据；
在仓库根目录运行：

```bash
npm run dist:linux -- \
  --config.extraMetadata.homepage='https://github.com/hiraeth1992/agent-trajectory' \
  --config.linux.maintainer='hiraeth1992 <hiraeth1992@users.noreply.github.com>'
```

发行文件输出到 `release/`。建议在对应操作系统的 CI runner 上分别构建；公开发布
macOS 版本还需要 Developer ID 签名与 notarization，Windows 版本建议配置代码签名证书。

Linux DEB 要求 homepage 与 maintainer 元数据。项目仅使用公开仓库账号和 GitHub noreply
地址，不包含个人邮箱；GitHub Actions 会在发行构建时根据 `GITHUB_REPOSITORY` 动态注入
同类元数据。若在其他 CI 中构建 DEB，请通过 electron-builder 的
`--config.extraMetadata.homepage` 和 `--config.linux.maintainer` 参数提供对应的公开项目元数据。

## 浏览器开发模式

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

生产构建：

```bash
npm run build
NODE_ENV=production npm run preview
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
  transcript，“轨迹”始终保留完整审计记录。
- 对话消息可一键定位到轨迹记录；两个视图共用搜索和检查器。
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
- “审计导出”请求 `GET /api/sessions/:source/:id/export`，下载完整、已脱敏的输入、输出和
  每条记录的原始事件，不包含内部 `searchText`。该导出不会绕过 projector 重新读取未脱敏数据。

默认内存预算：

| 缓存 | 条目上限 | 估算字节上限 |
| --- | ---: | ---: |
| SourceRegistry 详情 | 16 | 128 MiB |
| DSH / Codex / ZCode 各来源解析缓存 | 各 8 | 各 96 MiB |
| 共享投影 Worker 状态 | 16 | 192 MiB |
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

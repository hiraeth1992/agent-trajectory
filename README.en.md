# Agent Trajectory

[简体中文](README.md) | **English**

Agent Trajectory is a local-first, read-only trajectory viewer for multiple
coding agents. It converts local sessions from DeepSeek Harness, Codex,
Claude Code, Doubao Work, WorkBuddy, Qoder, OpenCode, and ZCode into one
unified view that helps answer three questions:

- What did the agent actually see and do?
- Where did time and tokens go, and did the agent recover and verify after a
  failure?
- Did trajectory quality really improve across agents or versions?

The project runs as a local Node.js service and opens in your system browser;
it does not bundle Chromium. Session reading, deterministic trajectory
evaluation, diagnosis preparation, and the human-evaluation workflow all stay
local. Agent Trajectory does not modify source sessions or upstream agent
configuration except when hooks are explicitly installed or removed.

## Product demo

The animation below shows Session analysis, Trajectory evaluation, and the
Evaluation center in the current version:

![Agent Trajectory product demo](docs/assets/readme/product-overview.gif)

## Highlights

- **View eight agents together:** Browse different sources through a shared
  model of sessions, turns, steps, records, and relationships.
- **Reconstruct execution:** Inspect messages, reasoning excerpts, tool calls,
  errors, retries, timings, and lineage by turn and step.
- **Explain context changes:** Distinguish the user-visible conversation, the
  context used for the model's next request, and the complete audit trajectory.
- **Analyze resource usage:** When the source provides the data, aggregate
  tokens, cache reads, TTFT, model time, and tool time.
- **Evaluate trajectory quality:** Check goal completion, requirement
  coverage, error recovery, and verification gaps with links to source
  evidence.
- **Close the evaluation loop locally:** Freeze datasets, double-annotate,
  adjudicate disagreements, compare baselines, and regress badcases.
- **Protect local data:** Keep source access read-only, bind the service to a
  loopback address, and recursively redact previews, exports, and evaluation
  artifacts.

## Supported data sources

| Source | Default source of truth | Main facts currently projected |
| --- | --- | --- |
| DeepSeek Harness | `~/.dsh/sessions/**/session.vN.jsonl[.zst\|.zstd]` | v4 sessions, model context, Goal/Todo, nested tools, attachments, lineage, and usage |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | Messages, reasoning excerpts, tool calls, timing, completion state, and token usage |
| Claude Code | `~/.claude/projects/**/*.jsonl` | Messages, reasoning excerpts, tool calls, attachments, usage, and message relationships |
| Doubao Work | `~/Library/Application Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.sessions` | Messages, tools, attachments, and multi-agent lineage; the protocol omits per-event timing and usage |
| WorkBuddy | `~/.workbuddy/workbuddy.db` + `projects/**/*.jsonl` | Messages, reasoning excerpts, tools, attachments, timing, usage, trace, and message relationships |
| Qoder | `~/.qoder-cn/projects/**/*.jsonl` | Messages, reasoning excerpts, nested tools, attachments, timing, usage, and message relationships |
| OpenCode | `~/.local/share/opencode/opencode.db` | Messages, reasoning excerpts, tools, attachments, timing, usage, and message relationships |
| ZCode | `~/.zcode/cli/db/db.sqlite` | Messages, tools, model and turn usage, plus trace, lineage, policy, and task data when those tables exist |

"Supported" does not mean that every source contains the same fields. Adapters
project only facts that can be verified from the source. Missing fields,
incompatible protocols, and partial parse failures appear as blocked or
degraded states and projection coverage gaps instead of inferred values.

## Quick start

### Requirements

- Node.js 22.12 or newer

### Launch

```bash
npx agent-trajectory
```

The command starts a local service and opens your default browser. The service
uses a random `127.0.0.1` port. Stopping the foreground process also stops the
service and its Workers.

To start the service without opening a browser:

```bash
npx agent-trajectory start --no-open
```

### Check and configure data sources

```bash
npx agent-trajectory doctor
```

`doctor` reports the resolved path, availability, and session count for all
eight sources, plus whether installed hooks need to be refreshed.

If agent data is not in its default location, save paths interactively:

```bash
npx agent-trajectory setup
```

You can also provide paths directly:

```bash
npx agent-trajectory setup \
  --dsh-dir /path/to/dsh/sessions \
  --codex-home /path/to/.codex \
  --codex-sessions-dir /path/to/codex/sessions \
  --claude-projects-dir /path/to/claude/projects \
  --doubao-work-sessions-dir /path/to/doubao/.sessions \
  --workbuddy-home /path/to/.workbuddy \
  --qoder-projects-dir /path/to/qoder/projects \
  --opencode-db /path/to/opencode.db \
  --zcode-db /path/to/zcode/db.sqlite
```

Source path precedence is:

```text
CLI arguments → ~/.agent-trajectory/config-v1.json → environment → defaults
```

The configuration file supports `${HOME}` and `${CONFIG_DIR}` for portability
across users and machines. Agent Trajectory stores its own runtime state,
diagnosis snapshots, and evaluation artifacts in `~/.agent-trajectory/` by
default. Select another directory with `--data-dir` or
`AGENT_TRAJECTORY_DATA_DIR`.

## Usage

### Session analysis

After launch, select a source and session in **Session analysis**. An
unavailable source does not block the others, and newly persisted sessions
normally appear within about one to two seconds.

The page provides four complementary views:

- **Conversation:** Focuses on user and assistant content while grouping
  runtime context, reasoning, and tools by turn.
- **Model context:** Appears only when the source provides replacement facts
  and shows what the model actually saw in its next request.
- **Trajectory:** Shows the complete audit record, step relationships, tool
  inputs and outputs, state, timing, and tokens.
- **Trajectory evaluation:** Explains progress through goals, execution
  outcomes, a storyline, correction chains, and process metrics.

Search, time ranges, evidence navigation, and the inspector are shared across
views. The inspector exposes provenance, relationships, trace/span data,
errors, and redacted raw events loaded on demand for an individual record.

### Local agent diagnosis

Local analysis in **Trajectory evaluation** always runs automatically without
calling a model. When deeper diagnosis is needed, select **Local agent
diagnosis**:

1. The service creates a private, redacted, frozen snapshot locally.
2. The page generates and copies a lightweight diagnosis prompt.
3. Paste it into a new agent session that can access local files.
4. The bundled `trajectory-diagnosis` skill reads evidence on demand and
   produces a report.

This entry point does not create agent sessions, send messages, or read agent
credentials automatically. Reports summarize observable decisions, actions,
and feedback; they neither reveal nor invent hidden chain of thought.

### Evaluation center

The **Evaluation center** supports quality assessment across sessions and
versions. Its browser workflow prepares private datasets, collects double
annotations, adjudicates disagreements, runs selected splits, chooses
baselines, and displays badcase summaries. Badcase decisions and retests are
managed with the CLI casebook commands. All artifacts stay in the current local
data directory.

The CLI can also run the bundled redacted synthetic contract dataset directly:

```bash
npx agent-trajectory evaluate
```

Reports are written to `~/.agent-trajectory/evaluations/` by default. You can
select another directory or a baseline:

```bash
npx agent-trajectory evaluate --output-dir ./evaluation-reports
npx agent-trajectory evaluate --baseline ./evaluation-reports/baseline.json
```

To calibrate with real local trajectories, use the three-stage workflow:

```bash
# 1. Freeze and redact candidates
npx agent-trajectory calibrate prepare \
  --dataset ~/.agent-trajectory/calibration/real-v1 \
  --count 30

# 2. After two reviewers complete their templates, generate the agreement
#    report and adjudication template
npx agent-trajectory calibrate agreement \
  --dataset ~/.agent-trajectory/calibration/real-v1 \
  --reviewer-a ~/.agent-trajectory/calibration/real-v1/reviewer-a.json \
  --reviewer-b ~/.agent-trajectory/calibration/real-v1/reviewer-b.json

# 3. After independent adjudication, run a selected split
npx agent-trajectory evaluate \
  --dataset ~/.agent-trajectory/calibration/real-v1 \
  --adjudication ~/.agent-trajectory/calibration/real-v1/adjudication.json \
  --split regression
```

Real candidates are frozen, redacted, pseudonymized, and privacy-audited, but
may still contain business text needed for evaluation. Keep them in private
local directories and never commit or upload them. The `independent` split is
reserved for final acceptance to prevent tuning rules against an independent
test result.

### Automatic session activation

Automatic activation supports **DSH, Codex, and ZCode only**. After hooks are
installed, a new top-level session from one of these sources starts or reuses
Agent Trajectory and switches to that session:

```bash
npx agent-trajectory install-hooks
```

Restart DSH and ZCode after installation. For Codex, inspect and trust the new
hook through `/hooks`. Run `install-hooks` again after changes to the Node.js
path, operating system, data directory, or installed version.

To remove only the entries installed by this project:

```bash
npx agent-trajectory uninstall-hooks
```

The other five sources remain fully discoverable and viewable, but do not
provide new-session activation. Hook installation and removal are the only
features that modify upstream agent configuration. Changes use project markers
and file transactions; any failed step restores the original content. Hook
failures never block agent sessions.

## Common commands

| Command | Purpose |
| --- | --- |
| `agent-trajectory` | Start or reuse an instance and open the page |
| `agent-trajectory start --no-open` | Start the local service only |
| `agent-trajectory doctor` | Check all eight sources and hook status |
| `agent-trajectory setup` | Save source paths interactively |
| `agent-trajectory install-hooks` | Install DSH, Codex, and ZCode activation |
| `agent-trajectory uninstall-hooks` | Remove activation entries installed by this project |
| `agent-trajectory evaluate` | Run a synthetic or adjudicated dataset and generate a report |
| `agent-trajectory calibrate prepare ...` | Freeze real-trajectory calibration candidates |
| `agent-trajectory calibrate agreement ...` | Measure reviewer agreement and create an adjudication template |
| `agent-trajectory casebook list` | List the local badcase casebook |
| `agent-trajectory casebook decide ...` | Record a badcase decision |
| `agent-trajectory casebook retest ...` | Attach an evaluation run as a badcase retest |

All commands accept `--data-dir <path>` to select the local Agent Trajectory
data directory. Evaluation commands enforce their parameter contracts: an
external dataset must be paired with adjudication and an explicit
`calibration`, `regression`, or `independent` split.

### Offline or internal distribution

```bash
npm run pack:tgz
npx --yes ./agent-trajectory-0.1.0.tgz
```

The package contains only the Node.js service, React static assets, Workers,
and the bundled Zstandard decoder.

## Export

- **Projection export:** Exports the unified session view currently loaded by
  the browser for inspection or further processing.
- **Audit export:** Exports the complete redacted projection and source events,
  including events that did not become visible records.

Detail APIs return redacted previews by default. Oversized inputs and outputs
are explicitly marked as truncated, and raw events are loaded on demand.

## How it works

```text
DSH / Codex / Claude / Doubao / Qoder files ---> Source adapters --+
WorkBuddy SQLite + JSONL ----------------------> Read-only Worker --+--> Projection Worker
OpenCode / ZCode SQLite -----------------------> Read-only Worker --+         |
                                                                           v
                                                                  SourceRegistry
                                                                           |
                                                                    Local API + SSE
                                                                           |
                                                                    React Web UI
```

1. **Source adapters** scan only allowlisted files under configured roots.
   SQLite sources query through read-only Workers so database work does not
   block the main service thread.
2. **Unified projection** converts source events into common session, turn,
   step, record, usage, and relationship models while retaining source IDs,
   evidence IDs, and fidelity.
3. **Service layer** exposes source probing, session details, raw events on
   demand, exports, evaluation workflows, and SSE updates through a Node.js API
   bound only to `127.0.0.1`. Caches and Workers have explicit capacity limits.
4. **Presentation layer** provides Session analysis and the Evaluation center
   in the system browser without an embedded browser runtime.

Discovery, parsing, and projection remain isolated for all eight sources. One
unavailable source or corrupt file does not block the others. Structures and
relationships that cannot be verified fail safely instead of being presented
as unified facts.

## Security and privacy

- The service binds only to `127.0.0.1` and validates the Host header, port,
  and remote address.
- The client can submit only a source and opaque session ID, never an arbitrary
  local path.
- File-based sources scan only allowlisted files under configured roots;
  WorkBuddy, OpenCode, and ZCode databases are opened read-only.
- Credentials, certificates, cookies, browser storage, and model request
  headers are not read.
- Sensitive keys in tool inputs and outputs, raw events, and exports are
  recursively redacted.
- Ordinary browsing, projection, diagnosis preparation, and evaluation do not
  contact external network services, modify source sessions, or execute agent
  tools.
- Diagnosis snapshots, calibration data, evaluation reports, and badcases stay
  in the local data directory.
- Hooks modify DSH, Codex, and ZCode configuration only after an explicit
  install or uninstall command, using file transactions for rollback.

See the [Security Policy](SECURITY.md) for the complete security boundary and
vulnerability-reporting process.

## Local development

```bash
npm ci
npm run dev
```

The development service defaults to <http://127.0.0.1:4317> and watches both
frontend and server source files.

For a production build and launch:

```bash
npm run build
npm start
```

Common environment variables:

```bash
PORT=4318 npm run dev
DSH_SESSIONS_DIR=/path/to/sessions npm run dev
CODEX_HOME=/path/to/.codex npm run dev
CODEX_SESSIONS_DIR=/path/to/codex/sessions npm run dev
CLAUDE_PROJECTS_DIR=/path/to/claude/projects npm run dev
DOUBAO_WORK_SESSIONS_DIR=/path/to/doubao/.sessions npm run dev
WORKBUDDY_HOME=/path/to/.workbuddy npm run dev
QODER_PROJECTS_DIR=/path/to/qoder/projects npm run dev
OPENCODE_DB=/path/to/opencode.db npm run dev
ZCODE_DB=/path/to/zcode/db.sqlite npm run dev
```

The bundled JavaScript Zstandard decoder is used by default. An external
`zstd` executable is used only when `ZSTD_BIN` is set explicitly.

## Verification

```bash
npm test
npm run build
npm audit --registry=https://registry.npmjs.org
```

For sources covered by the existing real-source verifier, run a read-only
smoke test:

```bash
npm run verify:real-sources
```

The verification summary is written to standard output by default and omits
session content, raw session IDs, home-directory paths, and credentials. An
output file created with `--output` is still derived from real local sessions
and must not be committed to a public repository.

## Contributing

Read the [Contributing Guide](CONTRIBUTING.md) before submitting changes. Use
synthetic fixtures only. Never commit real agent sessions, local paths,
credentials, private prompts, or unredacted exports.

## License

This project is licensed under the [MIT License](LICENSE). A
[Chinese translation](LICENSE.zh-CN.md) is available for reference only.

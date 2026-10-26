# Agent Trajectory

[简体中文](README.md) | **English**

Agent Trajectory is a local-first, read-only trajectory viewer for multiple
coding agents. It converts local sessions from DeepSeek Harness, Codex, and
ZCode into one unified view for inspecting conversations, model context, tool
calls, token usage, execution flow, and evaluation results.

The project runs as a local Node.js service and opens in your system browser.
It does not bundle Chromium. Ordinary browsing neither uploads nor modifies
source sessions, and optional AI enhancement calls a selected model only after
an explicit user action.

## Product demo

![Agent Trajectory product demo](docs/assets/readme/product-overview.gif)

## Highlights

- **View multiple agents together:** Browse DSH, Codex, and ZCode sessions
  through the same interface.
- **Reconstruct execution:** Inspect messages, reasoning excerpts, tool calls,
  errors, retries, and timings by turn and step.
- **Analyze resource usage:** Aggregate tokens, cache reads, TTFT, model time,
  and tool time.
- **Explain context changes:** Distinguish the user-visible conversation, the
  model's current context, and the complete audit trajectory.
- **Evaluate trajectory quality:** Check goal completion, requirement
  coverage, error recovery, and verification gaps with links to source
  evidence.
- **Diagnose and calibrate locally:** Generate redacted frozen snapshots for
  agent diagnosis, double annotation, adjudication, and regression evaluation.
- **Enhance wording with AI when requested:** Use the current Codex
  configuration or a custom OpenAI-compatible model.
- **Protect local data:** Keep source access read-only, bind the service to
  localhost, and recursively redact sensitive fields.

## Supported data sources

| Source | Default source of truth | Main capabilities |
| --- | --- | --- |
| DeepSeek Harness | `~/.dsh/sessions/**/session.vN.jsonl[.zst\|.zstd]` | v4 sessions, model context, Goal/Todo, lineage, tools, and usage |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | Messages, reasoning, tool calls, completion state, and token usage |
| ZCode | `~/.zcode/cli/db/db.sqlite` | Messages, tools, model and turn usage, plus optional trace/policy/task data |

When a source omits optional fields, the UI marks the capability as degraded
instead of inferring facts that are not present.

## Architecture

```text
DSH JSONL/Zstd ---> DshSource -----+
Codex JSONL ------> CodexSource ---+--> Projection Worker --> SourceRegistry
ZCode SQLite -----> SQLite Worker -+                            |
                                                                v
                                                       Local API + SSE
                                                                |
                                                                v
                                                        React Web UI
```

The architecture has four layers:

1. **Source adapters** read the three local formats. DSH and Codex support safe
   incremental reads; ZCode queries through a read-only SQLite Worker to avoid
   blocking the main service thread.
2. **Unified projection** converts source events into common session, turn,
   step, record, usage, and relationship models while retaining source IDs and
   fidelity for navigation back to original evidence.
3. **Service layer** exposes session lists, details, exports, and SSE updates
   through a Node.js API bound only to `127.0.0.1`. Caches and Workers have
   explicit capacity limits.
4. **Presentation layer** provides conversation, model context, trajectory,
   inspector, process evaluation, and evaluation-center views in the browser.

Parsing logic for each source remains isolated. An unavailable source does not
block the others. Structures and relationships that cannot be verified fail
safely instead of being presented as unified facts. Optional AI enhancement is
an independent branch: it may improve semantic wording but cannot overwrite
local facts, numbers, states, or evidence relationships.

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

### Check data sources

```bash
npx agent-trajectory doctor
```

`doctor` reports each source path, availability, session count, and whether
installed hooks need to be refreshed.

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
  --zcode-db /path/to/zcode/db.sqlite
```

Source path precedence is:

```text
CLI arguments → ~/.agent-trajectory/config-v1.json → environment → defaults
```

The configuration file supports `${HOME}` and `${CONFIG_DIR}` for portability
across users and machines.

## Usage

### Session analysis

After launch, select a source and session in **Session analysis**. The page
provides these views:

- **Conversation:** Focuses on user and assistant content while grouping
  runtime context, reasoning, and tools by turn.
- **Model context:** When the source provides replacement facts, shows what the
  model actually saw in its next request.
- **Trajectory:** Shows the complete audit record, step relationships, tool
  inputs and outputs, state, timing, and tokens.
- **Trajectory evaluation:** Explains progress through a storyline, execution
  outcome, correction chains, and process metrics.
- **Inspector:** Shows source provenance, relationships, trace/span data,
  errors, and redacted raw events for an individual record.

Search, evidence navigation, and the inspector are shared across views. After
the current session is persisted, the page usually updates within about one to
two seconds.

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

### Optional AI enhancement

Trajectory evaluation uses deterministic local analysis by default and does
not call a model. You may explicitly run **AI enhancement** to improve the
Chinese wording of goals, outcomes, storylines, evaluations, and suggestions:

- Reuse the current Codex configuration or add a custom
  OpenAI-compatible HTTPS or local endpoint.
- Preview the redacted fact bundle and estimated input tokens before a run.
- Send only facts required by the selected modules. Any follow-up evidence
  request is redacted again and size-limited.
- Require every model response to pass local structure and fact validation;
  numbers, states, and evidence IDs cannot be changed.
- Load API keys from environment variables or store them encrypted in the
  local data directory.

When a remote model endpoint is selected, the redacted facts shown in the
preview are sent to that provider. Usage, scope, and model selection are always
explicit. Local analysis makes no model request when AI enhancement is not run.

### Evaluation center

The **Evaluation center** supports cross-session quality assessment with
datasets, double annotation by reviewers, disagreement adjudication,
EvaluationRuns, baseline comparison, and badcase management. Run the bundled
redacted synthetic dataset directly:

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

Real candidates may contain business text needed for evaluation. Keep them in
private local directories and never commit or upload them. The `independent`
split is reserved for final acceptance to prevent tuning rules against an
independent test result.

### Automatic session activation

After hooks are installed, a new top-level DSH, Codex, or ZCode session opens
or reuses Agent Trajectory and switches to that session:

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

Hook installation and removal are the only features that modify agent
configuration. Changes use project markers and file transactions; any failed
step restores the original content. Hook failures never block agent sessions.

## Common commands

| Command | Purpose |
| --- | --- |
| `agent-trajectory` | Start or reuse an instance and open the page |
| `agent-trajectory start --no-open` | Start the local service only |
| `agent-trajectory doctor` | Check source and hook status |
| `agent-trajectory setup` | Save custom source paths |
| `agent-trajectory install-hooks` | Install new-session activation |
| `agent-trajectory uninstall-hooks` | Remove activation entries installed by this project |
| `agent-trajectory evaluate` | Run the built-in evaluation and generate a report |
| `agent-trajectory casebook list` | List local badcases |
| `agent-trajectory calibrate prepare ...` | Prepare a real-trajectory calibration dataset |

All commands accept `--data-dir <path>` to select the local Agent Trajectory
data directory.

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

## Security and privacy

- The service binds only to `127.0.0.1` and validates the Host header, port,
  and remote address.
- The client can submit only a source and opaque session ID, never an arbitrary
  local path.
- DSH and Codex scan only allowlisted files under configured roots; the ZCode
  database is opened read-only.
- Credentials, certificates, cookies, browser storage, and model request
  headers are not read.
- Sensitive keys in tool inputs and outputs, raw events, and exports are
  recursively redacted.
- Ordinary browsing, projection, diagnosis, and evaluation neither modify
  source sessions nor execute agent tools.
- Optional AI enhancement sends previewable redacted facts only after a user
  action. Remote endpoints are governed by the selected provider's policies.
- Diagnosis snapshots, calibration data, evaluation reports, and badcases stay
  in the local data directory.

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

When all three sources are available, run a smoke test against real sources:

```bash
npm run verify:real-sources
```

The verification summary is written to standard output by default and omits
session content, raw session IDs, home-directory paths, and credentials. An
output file created with `--output` is still derived from real local sessions
and must not be committed to a public repository.

## Related documentation

The following project notes are currently maintained in Chinese:

- [Performance and architecture optimization notes](docs/OPTIMIZATION.md)
- [Capability comparison with upstream projects](docs/UPSTREAM-COMPARISON-2026-10-21.md)
- [DeepSeek Harness implementation comparison](docs/DEEPSEEK-HARNESS-IMPLEMENTATION-COMPARISON-2026-10-24.md)
- [Agent evaluation review](docs/AGENT-EVALUATION-REEVALUATION-2026-10-25.md)

## Contributing

Read the [Contributing Guide](CONTRIBUTING.md) before submitting changes. Use
synthetic fixtures only. Never commit real agent sessions, local paths,
credentials, private prompts, or unredacted exports.

## License

This project is licensed under the [MIT License](LICENSE). A
[Chinese translation](LICENSE.zh-CN.md) is available for reference only.

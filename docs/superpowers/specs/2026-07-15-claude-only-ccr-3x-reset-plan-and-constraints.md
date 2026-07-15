# Claude-only CCR 3.x 重置计划与硬约束

> 本文是上下文恢复用的规划基线，不是已批准的详细设计，也不是源码实施授权。

## 0. 文档状态

- 日期：2026-07-15（Asia/Shanghai）
- 当前分支：`codex/claude-cannbot-auth-fix`
- 当前阶段：停止继续叠加补丁，等待架构方案确认
- 兼容范围：CCR `3.0.0` 至 `3.0.13`（含两端）
- 范围快照：`3.0.13` 是 2026-07-15 核验到的官方最新发布版
- 明确不承诺：`3.0.14+`、`3.1.x`、`4.x` 或其他未来版本

发生上下文压缩或任务转交时，先完整阅读本文，再继续工作。不得根据旧计划直接恢复实现。

## 1. 不可变目标

`cannbot-cc-router` 的产品边界是：**只为 Cannbot 场景拉起 Claude，不启动、不配置、不管理 Codex。**

成功标准不是“命令可以运行”，而是同时满足：

1. 能在 CCR `3.0.0` 至 `3.0.13` 范围内拉起 Claude。
2. 不启动 `codex`，不改变 Codex 的配置、路由、凭据、进程或行为。
3. 不通过修改共享 CCR 状态间接影响正在使用同一 CCR 的 Codex。
4. 退出后只清理本项目创建并明确拥有的临时文件和进程。

## 2. 硬约束

以下约束立即生效，优先级高于仓库内旧设计和旧实现。

### 2.1 Claude-only 边界

- 唯一允许由本项目拉起的 AI 客户端是 `claude`。
- 生产代码不得执行、包装、代理执行或自动探测执行 `codex`。
- 本项目可以为 Claude 会话启动必要的内部支持进程，但这些进程必须是会话私有、项目拥有且可精确清理的；它们不得成为共享 CCR 服务。
- CLI、README、帮助文本和示例不得暗示本项目支持拉起 Codex。

### 2.2 Codex 零影响

- 生产代码不得读取、创建、写入、删除或迁移 `~/.codex`、`CODEX_HOME` 或等价 Codex 路径。
- 不得修改 Codex 环境变量、默认模型、路由、API 地址、认证信息或启动配置。
- 不得为了“兼容 CCR”修改 CCR 中面向 Codex 的 profile、built-in rule 或其他路由数据。
- 不得停止、重启或接管无法证明由本项目创建的进程；尤其不得按端口或进程名粗暴终止共享服务。

### 2.3 共享 CCR 零写入

- 不得写入或迁移用户共享 CCR 的配置数据库、API Key 数据库、JSON 配置、Router、profiles、providers、models 或默认项。
- 不得使用会改变共享默认路由的 `--set-default`；该能力必须移除或禁用。
- 不得在 `status`、`doctor`、版本探测或读取配置时执行 `CREATE TABLE`、schema migration、WAL 切换等写操作。
- 共享 CCR 只允许进行无副作用的可执行文件/包版本探测。共享凭据和数据库内容不应成为本项目的隐式输入。
- 如果某个 CCR 版本无法在不写共享状态的前提下工作，则该版本必须走隔离实例或外部托管方案，不能降低此约束。

### 2.4 Claude 配置最小侵入

- 本项目不得覆盖用户全局 `~/.claude/settings.json` 或其他全局 Claude 配置。
- 会话需要的 `settings.json`、`apiKeyHelper` 或环境变量必须放在会话私有临时目录，并在正常退出、异常退出和信号中断后清理。
- Claude 自身在正常会话中产生的状态不属于本项目配置写入；本项目不得主动迁移或重写这些状态。

### 2.5 网络、进程与凭据

- 本地支持服务默认只监听 loopback 地址。
- 端口必须动态分配或经过独占验证，不能抢占、复用或终止未知占用者。
- 清理必须基于明确的父子关系、会话标识或所有权记录，而不是仅凭 PID 文件、端口或进程名。
- API Key、token、OAuth 数据和完整认证头不得写入日志、测试快照、提交记录或错误消息。
- 未获得用户明确授权，不执行会产生真实模型请求、费用或外部副作用的 smoke test。

### 2.6 过程约束

- 当前分支作为失败链和审计证据保留；在方案批准前不继续修补 CCR v3 adapter。
- 不删除、移动或吸收当前未跟踪的嵌套目录 `cannbot-cc-router/`，除非用户另行明确授权。
- 不因旧文档标为 design 就视为仍然有效；本文硬约束覆盖旧文档冲突内容。
- 在用户批准架构方案前，不进入源码实施、分支重置、工作树创建或详细任务拆解。

## 3. 已确认的版本范围

### 3.1 支持定义

- 目标范围是 CCR `3.0.0 <= version <= 3.0.13`。
- “当前最新”是带日期的快照，不是对未来所有 `3.0.0+` 的无限承诺。
- 若未来需要支持 `3.0.14+`，必须重新核验其 CLI、存储、进程和配置隔离能力，再显式扩展范围。

### 3.2 版本识别原则

- 项目当前实际调用的是全局 `ccr` 可执行文件，因此检测对象必须是“实际会执行的 artifact”，不能只信任某个无关 `package.json`。
- 版本号只用于选择经过验证的兼容路径，不能替代行为探测和集成测试。
- 本机已发现版本 `3.0.3` 只能作为一个矩阵样本，不能代表整个支持范围。

### 3.3 验证矩阵

- 强制边界样本：`3.0.0`、本机样本 `3.0.3`、最新样本 `3.0.13`。
- 在可获得对应 CLI artifact 的前提下，应覆盖 `3.0.0` 至 `3.0.13` 的全部已发布版本。
- 任一版本若跳过，必须记录 artifact 不可获得等客观原因；没有证据时不得声称该版本已验证。
- 合成 fixture 只能验证解析逻辑，不能替代真实 CCR artifact 的启动、健康检查、退出和隔离验证。

官方版本依据：

- [CCR Releases](https://github.com/musistudio/claude-code-router/releases)
- [CCR 中文 README](https://github.com/musistudio/claude-code-router/blob/main/README_zh.md)
- [CCR default config](https://github.com/musistudio/claude-code-router/blob/main/packages/core/src/config/default-config.ts)
- [CCR app config store](https://github.com/musistudio/claude-code-router/blob/main/packages/core/src/config/app-config-store.ts)
- [CCR API key store](https://github.com/musistudio/claude-code-router/blob/main/packages/core/src/config/api-key-store.ts)

## 4. 对当前修改的反思

### 4.1 事实摘要

- 相对 `origin/codex/cannbot-cc-router`，当前分支累计约 34 个提交、51 个文件变更、`+3850/-174`。
- 修复范围先后跨越版本识别、存储路径、SQLite schema、安全更新、凭据来源、认证、路由和网关端口。
- 当前测试为 116/116 通过，但主体依赖合成 fixture，尚未证明真实 CCR `3.0.0..3.0.13` 的端到端兼容。
- 当前 `src/claude-launcher.ts` 直接拉起的是 `claude`，未发现直接拉起 `codex` 的实现；主要风险来自对共享 CCR 状态的间接修改。
- 当前 `src/ccr-v3-store.ts` 在打开数据库时设置 WAL 并创建 schema，使本应只读的 `status`、`doctor`、加载和验证路径可能产生写入。
- 当前 `src/ccr-config.ts` 的默认路由写入以及 README 中的 `--set-default` 会改变共享 Router，因此可能同时影响 Claude 和 Codex。

### 4.2 根因判断

失败不是单一字段、端口或认证值错误，而是边界设计错误：项目把不断变化的 CCR 3.x 内部数据库和共享路由结构当成了可维护 API。

这会形成重复循环：

1. 适配一个 CCR 内部细节。
2. 新版本改变 schema、存储位置、凭据或进程行为。
3. 再增加一个修补层。
4. 测试 fixture 继续通过，但真实环境仍失败或产生共享状态副作用。

因此，继续扩展 `ccr-v3-adapter`、直接编辑共享 SQLite 或同步全局 Router 不再是可接受路线。

## 5. 候选架构

以下方案尚未获用户批准。不得把本节当作实施指令。

### 方案 A：每次会话使用私有 CCR（推荐）

项目为一次 Claude 会话创建隔离的数据目录、配置、端口和支持进程；启动 Claude 后，在会话结束时只清理这些项目自有资源。

优点：

- 可以从结构上保证不写共享 CCR，也不影响 Codex。
- 项目能控制一次性启动、健康检查和清理体验。
- 兼容问题被限制在公开 CLI/进程行为和私有配置生成，不依赖共享数据库内部结构。

风险与前置验证：

- 必须先证明 CCR `3.0.0..3.0.13` 能通过明确的 home/data/config 隔离机制启动。
- 不同版本的隔离入口若不一致，需要小而明确的版本适配层。
- 如果某版本无法可靠隔离，不能回退到修改共享数据库，而应改用方案 B。

### 方案 B：用户托管 CCR，本项目只连接并拉起 Claude

用户或外部工具负责准备 CCR endpoint 和认证信息；本项目把 CCR 当作不透明外部服务，只生成临时 Claude 会话配置并执行 `claude`。

## 14. Lifecycle safety correction (2026-07-15)

This section supersedes every earlier statement that treats CCR `3.0.3` through `3.0.13` as equally eligible for an owned private lifecycle.

- The official release page currently identifies `v3.0.13` as the latest release. It is the only release eligible for automatic private lifecycle work in this branch until a separate source-and-artifact audit expands the set.
- CCR `3.0.0` through `3.0.7` must never enter automatic private start/stop: their stop behavior can terminate the PID recorded in state without proving process identity. CCR `3.0.8` through `3.0.12` remain unverified and are also rejected before private database creation or control commands.
- Version parsing may recognize the reviewed `3.0.0` through `3.0.13` range for diagnostics. Recognition is not private-lifecycle eligibility and does not permit a shared-state fallback.
- A v3.0.13 session may call `ccr stop` only after its own post-start `service.json` proof has been parsed without logging it: a non-empty service token, positive PID, loopback Web URL on the session's allocated Web port, and Web-auth token are required. The recorded PID, token, and URL must match again immediately before stop; an authenticated `getServiceIdentity` RPC must confirm the same token and PID.
- If the proof is absent, malformed, changed, or not authenticated, the session must not invoke `ccr stop`, signal a PID, or kill a port. It fails closed. A detached-start timeout with no proof is an upstream cleanup limitation: retain the isolated root rather than deleting it while an unproven child might still use it, and report only a redacted ownership-cleanup failure.
- Gateway readiness remains a separate loopback check on the configured gateway port; the Web-management port and ownership RPC do not prove gateway readiness. No model request is permitted.

优点：

- 产品边界最窄，最符合“只负责拉起 Claude”。
- 几乎消除 CCR 存储 schema 和进程管理兼容风险。
- 最容易证明 Codex 零影响。

代价：

- 用户需要先准备可用 CCR 服务，开箱体验较弱。
- 本项目只能验证连接能力，不能保证外部 CCR 的配置正确性。

### 方案 C：继续修改共享 CCR 数据库和 Router（拒绝）

该路线与 Codex 零影响、共享 CCR 零写入和跨版本可维护性冲突，后续不得继续投入。

## 6. 暂定推荐设计

在用户确认前，推荐方案 A，并保留方案 B 作为某些版本无法可靠隔离时的显式模式；禁止自动回退到共享状态写入。

方案 A 的预期一次性生命周期是：

1. 只读检测实际 `ccr` artifact 及版本。
2. 检查版本是否在 `3.0.0..3.0.13`。
3. 创建会话私有目录并分配 loopback 端口。
4. 生成私有 CCR/代理配置，不读取或写入共享凭据数据库。
5. 启动项目自有支持进程并等待健康检查。
6. 创建临时 Claude `settings.json` 与会话认证桥接。
7. 只执行 `claude`，并把终端控制权交给 Claude。
8. 在正常退出、异常退出和信号中断后，仅清理本会话拥有的资源。

若隔离能力探测失败，必须给出可操作错误，并要求用户显式选择方案 B；不得静默触碰共享 CCR。

## 7. CLI 收缩方向

本节仍需随架构一起批准。

- 保留主命令 `code`：准备一次性会话并拉起 Claude。
- 可保留严格只读的 `doctor`：只做版本、依赖、端口和显式 endpoint 检查。
- `--set-default`：移除或直接报错，不能再写共享 Router。
- `init`、`sync`：若含共享写入则移除；如保留，只能生成项目私有会话模板。
- `start`、`restart`、`stop`、`status`：不得管理共享 CCR；如保留，语义必须限定为本项目拥有的私有会话。

## 8. 验收标准

### 8.1 自动化隔离合同

- 进程记录证明没有执行 `codex`；唯一 AI 客户端是 `claude`。
- 生产代码扫描和运行时文件审计证明没有访问 `.codex`。
- 在隔离测试 HOME 中预置 Codex、共享 CCR 和全局 Claude 哨兵文件，运行前后内容、mtime 和目录结构保持不变。
- 测试框架可以只读检查哨兵；产品代码本身仍不得访问 `.codex`。
- 共享 CCR 数据库、Router、profiles 和 API keys 前后哈希不变。
- 全局 `~/.claude/settings.json` 前后哈希不变。
- 端口冲突不会杀死未知进程，退出只终止项目自有子进程。
- 正常退出、启动失败、Claude 启动失败、Ctrl+C 和父进程终止都能完成私有资源清理。
- 日志和错误输出不包含凭据。

### 8.2 真实版本验证

- 对第 3.3 节矩阵执行真实 artifact 集成测试。
- 每个版本至少验证：版本识别、隔离启动、健康检查、Claude 启动参数、退出清理、共享状态不变。
- 自动化通过后，再在用户明确授权下执行一次真实 Cannbot/Claude smoke test。
- smoke test 前后由外部测试工具核验 Codex 和共享 CCR 状态不变。

### 8.3 完成判定

只有自动化隔离合同、真实版本矩阵和获授权 smoke test 都有证据时，才能宣称目标完成。单纯单元测试通过、CLI 能启动或某一个 CCR 版本可用都不算完成。

## 9. 重置后的工作计划

### 阶段 1：冻结与取证

- 保留当前分支和现有失败链，不再追加修补。
- 保留未跟踪嵌套仓库，等待用户决定如何处理。
- 把当前测试结果和已知风险作为对照证据。

### 阶段 2：架构确认

- 用户选择方案 A，或方案 B，或明确批准“A 为默认、B 为显式回退”。
- 确认 CLI 收缩范围。
- 获批后另写详细设计与可执行实施计划。

### 阶段 3：失败优先测试

- 先写 Codex 零影响、共享 CCR 零写入、Claude-only、所有权清理测试。
- 再写 CCR `3.0.0..3.0.13` artifact harness。
- 先看到测试因缺少新架构而失败，再开始实现。

### 阶段 4：最小纵向实现

- 只实现版本探测、一个隔离会话、Claude 启动和可靠清理。
- 不移植共享数据库 adapter、全局 sync 或 set-default 行为。
- 最小路径通过后，再补齐 Windows/macOS/Linux 差异和诊断信息。

### 阶段 5：矩阵与真实验证

- 跑完整自动化和真实 CCR artifact 矩阵。
- 修复必须维持硬约束，不允许为通过某版本而加入共享状态写入。
- 获得用户授权后执行真实 smoke test，并保存脱敏证据。

### 阶段 6：文档与交付

- README 只描述 Claude-only 边界和已验证版本范围。
- 删除或改写所有 `--set-default`、共享 CCR 管理和 Codex 相关暗示。
- 交付时列明已验证 artifact、平台、限制和未承诺版本。

## 10. 上下文恢复检查清单

恢复任务后必须按顺序执行：

1. 阅读本文并确认版本快照日期。
2. 检查 `git status`，保护用户已有修改和未跟踪嵌套目录。
3. 不继续修改 `src/ccr-v3-store.ts` 或共享 DB adapter。
4. 确认用户是否已批准方案 A/B；没有批准则只做只读分析。
5. 若官方已发布 `3.0.14+`，仍以本文的 `3.0.13` 为当前任务上限，除非用户明确扩展范围。
6. 实施前先编写详细计划和失败优先隔离测试。
7. 任何设计若可能触碰 Codex 或共享 CCR，立即停止并回到硬约束复核。

## 11. 当前待用户确认的唯一设计决策

是否批准以下推荐：**默认采用方案 A（每次 Claude 会话使用私有 CCR），当某个已支持版本无法可靠隔离时，只允许用户显式使用方案 B（外部托管 CCR），绝不回退到修改共享 CCR。**

> **EFFECTIVE STATUS — APPROVED (2026-07-15)**
>
> The user approved private CCR per Claude session as the default design, with a user-supplied external CCR endpoint as the only explicit fallback. This status block supersedes earlier text in this document that says approval is pending.
>
> The authoritative execution plan is `docs/superpowers/plans/2026-07-15-claude-only-ccr-3x-isolation.md`. The hard constraints in this document override that plan if they ever conflict. Source implementation remains gated on explicit consent to create an isolated worktree.
>
> Local CCR 3.0.3 evidence: child-only `CCR_INTERNAL_HOME_DIR`, `CCR_INTERNAL_APP_DATA_DIR`, `CCR_INTERNAL_USER_DATA_DIR`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, XDG, and TEMP/TMP can confine CCR data to a session root. The `ccr start --port` option is the Web-management port, not the LLM gateway port. A normal private start must be preceded by an artifact-validated private configuration with `profile.profiles: []` and Codex profile/rule disabled; default profile behavior is not acceptable. This evidence is not proof for any other release.

## 12. Execution update and artifact-source evidence

> **CURRENT CHECKOUT AUTHORIZED (2026-07-15)**
>
> The user explicitly authorized implementation in the current `codex/claude-cannbot-auth-fix` checkout. Do not create, switch to, reset, clean, or otherwise require a worktree for this run. Preserve the untracked nested `cannbot-cc-router/` directory.
>
> Official-source audit found that releases `3.0.0` through `3.0.2` expose only the profile-launch CLI and have no public `start`/`stop` private-gateway lifecycle. Releases `3.0.3` and later expose the lifecycle and child-path controls under investigation. Private mode for every release remains unverified until the artifact matrix passes; a version without a safe private layout must require the user-supplied external endpoint mode and must never use shared CCR state.
>
> Until matrix evidence exists, version acceptance means only that the artifact falls within the reviewed release range. It is not a claim that private startup has passed for that artifact.

## 13. Private-store implementation ledger (2026-07-15)

- Private-start eligibility is intentionally narrower than release acceptance: `3.0.3` through `3.0.13` have the observed public lifecycle and child path controls. `3.0.0` through `3.0.2` are accepted only for a future explicit external-endpoint mode; they must fail private-start preparation without creating a database or consulting shared CCR state.
- The private layout is derived only from the session root: Windows `3.0.3` uses `<private APPDATA>/Claude Code Router`; Windows `3.0.4` through `3.0.13` use `<private APPDATA>/claude-code-router`; all use `<private user-data>/api-keys.sqlite`. The generated gateway config path is also below that same private config directory.
- The session seed creates only `app_config` and `api_keys` with the artifact-audited schema. It does not copy, back up, migrate, open, or set WAL mode on a user database.
- The private config writes exactly one loopback Cannbot provider, keeps the gateway credential only in the private API-key database, and uses a distinct CCR-to-shim credential in the provider. It explicitly disables profiles, the Codex profile/rule, proxy/system-proxy/browser capture, bot integration, login auto-start, observability, and tool hub.
- Port ownership is not inferred from an existing listener: gateway, core, and shim ports must be distinct. The private gateway credential must differ from the shim credential. Both checks occur before filesystem writes.
- Current evidence is unit-level only: private environment/version/store contracts pass locally. It is not a claim that any CCR artifact has passed a private-start or model-traffic test. Real artifact matrix and real-model smoke authorization remain separate gates.

---
approved_by: user-chat-2026-11-02
status: approved
risk_level: high
---

# Agent 自动化中台（codeg 本机方案）

## 背景

目标是让任务的起点从人身上拿掉：事件触发 Agent，Agent 自己处理能处理的事，只把需要拍板的事推给人。参考对象是「数字生命卡兹克」的公开文章《折腾了整整1年，毫无保留地分享一下我这套Agent自动化系统》，以及作者开源的 `KKKKhazix/AIHOT` 中事件生产方的实现（`packages/backend/src/notify/agent.ts`、`operations/alerts.ts`）。作者的中台和 CI 中台本身没有开源。

另参考 DeepSeek Harness 团队公开的 Super-agent 架构文章及研究原型 `deepseek-ai/dsh-superagent-prototype`（MIT，官方声明为仅供参考的研究原型）。从中吸收四点：按 Thread 订阅并直通原任务、规则级 `observe` 模式、更细的汇报状态、独立 Watchdog。不直接采用该插件：它绑定 `dsh` 运行时，只服务单个 GitHub 仓库，Worker 以系统账号免审批运行，Agent 自己启用自动合并，与 `gh-pr-guard` 和「无授权不合并」冲突。

现有零件已覆盖大半，本方案只补缺口，不另起服务：

| 能力 | 现有 owner | 缺口 |
|---|---|---|
| Forge 事件 | codeg `forge/auto/`（webhook 或定时扫描、规则匹配、每个 item 只建一次任务、不可信内容封装） | 无 |
| 定时任务 | codeg `automation/engine.rs`（`TriggerKind::{Schedule, Manual}`） | 没有事件触发 |
| 任务执行 | codeg `work_task/`、ACP 连接 | 不处理 submodule |
| worktree | `agent-skills/git-worktree-submodule/scripts/wtree.py`（`create --json`、`remove`、`session-check`） | 无 |
| headless 约束 | dev-rules `global/CLAUDE.md` §4，`check_workflow_yaml.py` | 无 |
| 门禁 | dev-rules `templates/preflight.sh`、xj-review、`gh-pr-guard.py` | 本方案 P1 再接 CI |
| 飞书 | codeg `chat_channel/backends/lark.rs`（长连接收消息、发卡片） | 卡片按钮回调未实现（`callback_data: None`，`send_interactive_message` 走默认降级） |
| 出口 IP | infra-skills `cc0`/`codex0`/`agy0` | 无 |
| 跨项目分发 | `dev-rules-fanout` | 写死 `/Users/xuejiao` 路径，需人工启动 |

## 已定决策（2026-11-02，用户对话确认）

- **D1 中台位置**：本机兼任中台和 worker，通过 Tailscale 只对 tailnet 开放。不部署公网服务器，不开 Tailscale Funnel。运行形态见「监听」：桌面版内置 web 服务目前只能绑定 `0.0.0.0`，P0 需要先补一个监听地址配置，或改用 `codeg-server`。
- **D2 公网事件**：GitHub/GitLab 改用 Forge 定时扫描（间隔 1 到 2 分钟，`MIN_SCAN_INTERVAL_MINUTES = 1`），不接公网 webhook。飞书走现有长连接，P0 只出站（通知），不处理入站指令；入站指令是 P2。
- **D3 事件协议**：与 AIHOT 完全兼容（见「事件协议」）。来源按 API key 区分，不信任消息体自报。扩展字段只放可选的 `meta`。
- **D4 worktree 单一 owner**：带 submodule 的仓库由 codeg 调 `wtree.py create --json` / `remove`，codeg 不再自己实现 submodule 处理。不带 submodule 的仓库保持现状。zhifu 自身挂着 `dev-rules` submodule，所以第一个场景就会走 wtree.py 这条路径。
- **D5 合并**：P0 不自动合并。P1 先全部推卡片跑两周，再按白名单放开（见「合并策略」）。Agent 永远不执行合并，`gh-pr-guard` 照旧生效。
- **D6 Tailscale 与 ClashX 共存**（`100.64.0.0/10`、MagicDNS `100.100.100.100`、`*.ts.net` 直连，不进 fake-ip）由 infra-skills 负责。已完成：`youxuanxue/infra-skills` PR #33 已于 2026-11-02 合并。
- **D7 Thread 订阅直通**：事件的 `subject` 作为 Thread 键。任务启动后订阅对应 Thread，同一 Thread 的后续事件由程序直接送给原任务，不再走规则匹配（见「Thread 订阅」）。P0 的首个场景是「一个事件对应一个独立任务」，没有后续事件，所以订阅直通放到 P1 实现。
- **D8 规则级 `mode`**：每条规则有 `off`、`observe`、`auto` 三档。新规则先 `observe`，只记录「本来会做什么」，不执行；看过记录再切 `auto`。
- **D9 一个项目一个飞书群**：群就是项目的标识。某个项目的通知、卡片、以后的入站指令都在它自己的群里；另有一个总览群，只收跨项目的汇总和 Watchdog 告警。第一个接入的项目是 zhifu（`youxuanxue/zhifu`，私有，Python）；它的专属群建好之前，通知先发到总览群。群 id 只放在私有配置仓库里，不写进本文档。
- **D10 出站多群走单渠道**：改 Lark 后端的发送路径，消息目标带 `chat_id` 时优先使用它，一个飞书应用、一条长连接覆盖所有群。机器人不在目标群里导致发送失败时，错误报到总览群。实现时机：zhifu 的专属群建好时；在此之前，P0 的所有通知都发总览群，来源绑定项目也先不做。
- **D11 Forge 规则 P0 不并入 `rules.json`**：两套并存，只统一通知出口；是否合并在 P2 重新评估。配置仓库 `rules.json` 的规则不得监听 Forge 已覆盖的仓库 issue/PR（见校验规则）。
- **D12 配置仓库**：新建私有仓库 `youxuanxue/agent-hub-config`，存放 `rules.json`、`projects.json`。

## 非目标

- 公网可达的中台、多用户、多租户。
- 自建 CI 中台（属于 P1，单独审批）。
- 替换 Forge 自动处理的现有规则；P0 只把它的通知改走统一出口。
- 使用 cli-agent-orchestrator：它没有入站事件，功能与 codeg 重叠。
- 常驻 Router 模型：P0 的事件都是结构化的，确定性规则够用。飞书群聊、issue 评论这类非结构化来源的模型判断层放到 P2。

## 架构

```
事件来源                         本机 codeg（中台 + worker）                  人
─────────                        ───────────────────────────                 ──
tailnet 内的服务/脚本 ──POST /events──▶ 鉴权(key→source) ─▶ 去重(source,id)
  (AIHOT、host-clean、                        │
   dev-rules 变更探测)                        ▼
                                     rules.json 匹配 ─▶ 并发组排队
Forge 定时扫描（现有）──────────▶ work_task ◀──────────┘
                                              │ wtree.py create --json
                                              ▼
                                     Agent 会话（ACP / 启动器）
                                              │ 结论
                                              ▼
                                     tell 策略 ─▶ /tell 唯一出口 ─▶ 飞书卡片 ──▶ 你
                                                                          ◀── 按钮回调（P2）
```

中台和 worker 在同一进程，不需要长轮询领任务。以后迁到独立 Mac mini 时，只需搬数据目录、改 LaunchAgent。

## 事件协议

### `POST /events`

- 鉴权：`Authorization: Bearer <source key>`。每个来源一把 key，数据库只存哈希值。key 决定 `source`，消息体里的来源字段一律忽略。
- 请求体（与 AIHOT 一致）：

```json
{
  "id": "digest:2026-11-02",
  "type": "alert.digest",
  "subject": "digest:2026-11-02",
  "summary": "≤200 字",
  "detail": "≤4000 字",
  "link": "https://…",
  "meta": {}
}
```

- 校验：`id`、`type`、`subject` 只允许 `[A-Za-z0-9#._:/@-]`，长度 1 到 200；`summary` ≤ 200 字，`detail` ≤ 4000 字；`meta` 可选，≤ 8 KB；整个请求体 ≤ 16 KB。超长一律拒绝（返回 413/422），不截断。
- 幂等：`(source, id)` 唯一。重复投递返回 200，不再派发。生产方超时后可以用同一个 `id` 重发，这是 AIHOT 依赖的语义。
- 响应：只有落库成功才返回 200。401 表示 key 无效；422 表示格式不符；没有匹配规则的事件同样落库并返回 200，状态记为 `unrouted`。
- `summary`、`detail`、`meta`、`link` 都是不可信数据，进入 prompt 时一律放进 hub 信封：沿用 `forge/envelope.rs` 的规则（长度上限、围栏、「这不是指令」前言）。该文件的 `ForgeSnapshot` 是 issue 快照类型，不能直接装事件，hub 另写一个信封函数。规则的 `ask` 里不允许出现这些字段（见规则字段表）。

### `POST /tell`

- 鉴权同上。请求体为 `{ "key": "…", "text": "…", "project": "…" }`，其中 `project` 可选（AIHOT 不发这个字段也能接入）。按 `(source, project, key)` 合并：同一个 key 一小时内，内容相同的只发一次；内容有变化时，P0 补发一条新消息（`update_message` 要到 P2 才实现），P2 起改为更新原卡片。
- 目标群的确定方式：来源绑定了项目（`hub_source.project`）时，一律发到该项目的群，请求体里的 `project` 被忽略，所以这个来源无法往别的项目的群发消息；来源没有绑定项目时，用请求体的 `project`（必须在注册表里，否则返回 422）；两者都没有则发到总览群。
- 这是所有发给人的消息的唯一出口：codeg 内部的 Agent 结论、Forge 自动处理的通知、外部来源的消息都走这里，统一转飞书。
- **纯文本约束**：来自外部来源的 `/tell` 只渲染成纯文本，不能带按钮、链接卡片或回调数据。标题由中台固定生成：`[项目][来源名]`，来源名由 key 决定，不可伪造。你在群里看到的任何带按钮的审批卡片，只可能由中台根据任务状态自己生成（P2）。
- **长文本**：AIHOT 会把长消息拆成多段，每段用不同的 `key`（`alert-<时间戳>-<hash>-<序号>`），所以对它来说「同 key 合并」不会触发，每段各发一条。中台对单个 `text` 设上限 4000 字，超出返回 422，由生产方自己拆分，这与 AIHOT 现有行为一致。

### 路由与鉴权

- `/events`、`/tell` 是独立路由组，挂在认证中间件之外，参照现有 `/forge_webhook`（`web/router.rs`：单独挂路由、自己验证、单独的请求体上限）。它们只接受事件 key，不接受 `CODEG_TOKEN`。
- 反向隔离：事件 key 调用任何管理 API 必须返回 401。这条写进验收。
- 每个路由组有自己的请求体上限（16 KB）和按 key 的限流（默认每个 key 每分钟 60 次，超出返回 429，生产方按原 `id` 重试即可）。
- key 只存哈希值；日志和任务记录里不出现 key 原文。
- **key 管理（P0 范围）**：管理 API（受 `CODEG_TOKEN` 保护）加一组 CLI 子命令：`codeg hub source create <name>`（key 只在创建时显示一次）、`list`、`rotate`、`revoke`。来源名不得以 `forge:` 开头（保留给 Forge 自己）。另有 `codeg hub check <配置目录>`，校验 `rules.json` 和 `projects.json`，既给热加载用，也给配置仓库的 CI 用。

### 监听

- **现状（已读代码）**：桌面版内置 web 服务的配置只有 `token`、`port`、`auto_start`，监听地址默认是 `0.0.0.0`（`web/mod.rs`）。`CODEG_HOST` 是 `codeg-server` 二进制的环境变量，桌面版不读。`CODEG_HOST` 也只能写一个地址。
- **做法**：只绑定本机的 tailnet 地址（`100.x.y.z`），本机自己的访问也走这个地址，不再同时绑定 `127.0.0.1`。
  - 用 `codeg-server`：设 `CODEG_HOST=<tailnet 地址>`，不需要改代码。
  - 用桌面版：在 `WebServiceConfig` 增加 `host` 字段（默认保持 `0.0.0.0` 以不影响现有用户），属于 P0 的改动。
  - 两种形态由实现前的一次评估决定，评估项：是否需要桌面 UI 与中台同进程，以及 `work_task` 引擎的单进程选举（数据目录文件锁）会选中哪个进程。
- Tailscale ACL 只放行用户自己的设备和登记过的服务器。
- 现有 `CODEG_TOKEN` 继续保护管理 API，与事件 key 互不通用。

### Thread 订阅（P1 实现）

- **Thread 键**：`(source, subject)`。同一个 PR、同一个告警、同一个飞书话题，生产方应使用同一个 `subject`。
- **订阅**：规则命中并创建任务后，任务自动订阅该 Thread。一个任务可以订阅多个 Thread，一个 Thread 也可以被多个任务订阅（例如两个任务在同一个 PR 上工作）。
- **直通**：新事件的 `(source, subject)` 已有存活的订阅时，程序直接把事件作为输入送给订阅它的任务，不匹配规则、不新建任务。事件状态记为 `delivered`。
- **没有订阅时**：走规则匹配。任务结束后订阅保留，但 P0 不会因为后续事件恢复已结束的任务：`/events` 里的事件都是程序投递的，系统无法确认背后是不是人。恢复已结束的任务属于 P2，且只对满足 `meta.actor_kind = "human"`、来源在白名单内、并且是该任务授权人的事件开放（例如飞书项目群里白名单发送者的消息）。
- **解除**：任务可以对认为无关的 Thread 取消订阅，并把事件交回规则匹配；人可以在管理界面解除某个 Thread 的全部订阅。被人停止的任务不再接收任何事件。
- **并发与送达**：订阅直通的输入不占用并发组的新名额。任务正在执行时，输入按到达顺序排队，在 Agent 当前这一步结束后一次性送入会话，不打断正在执行的工具调用；任务空闲（`waiting`）时直接送入并唤醒。送入失败（会话不可用）时输入保留，状态记为 `delivery_failed`，按 2 秒起、翻倍、上限 1 分钟的间隔重试。

## 项目与飞书群

项目注册表 `projects.json` 与 `rules.json` 放在同一个配置仓库里，同样先校验再热加载。

```json
{
  "version": 1,
  "overview_chat": "<总览群 id，见配置仓库>",
  "projects": {
    "zhifu": { "cwd": "~/Codes/zhifu", "feishu_chat": null }
  }
}
```

`feishu_chat` 为 `null` 表示该项目还没有专属群，通知发到总览群。以后接入 sub2api、ai4s 时，往 `projects` 里加一项即可，格式相同。

- `cwd` 必须是已有的 git 仓库，并且已登记在 dev-rules 的 `.registered-projects`；`feishu_chat` 非空时在注册表内不能重复，并且不能等于 `overview_chat`；规则里的 `project` 必须存在于注册表。校验失败时继续使用旧文件，并通过 `/tell` 向总览群报错。
- **项目到 codeg 文件夹的映射**：`work_task` 需要 `folder_id`。中台启动和热加载时，按 `cwd` 找到对应的 codeg 文件夹（没有则登记，入口大概率是 `folder_service::add_folder`，实现前核实它对已存在路径是否幂等）。找不到或登记失败，校验失败。
- 出口 IP / 启动器（cc0、codex0）：我没有核实 `build_runtime_env_for_agent` 能否按规则选择启动器，所以 P0 的规则里不提供 `launcher` 字段，沿用 codeg 的 Agent 全局运行环境设置。能否按规则选择，列入待核实项。
- 项目的通知一律带项目名：卡片标题以 `[sub2api]` 开头，任务记录里也带 `project`，方便在总览里按项目筛。
- 总览群收三类消息：每日跨项目汇总、Watchdog 告警、找不到项目的 `unrouted` 事件摘要。
- **渠道约束（已读代码）**：codeg 的 Lark 渠道一个实例只绑定一个 `chat_id`（`chat_channel/backends/lark.rs:150`），发送时用的也是这个值（第 233 行），不看消息目标里的 `chat_id`。按 D10，P0 改发送路径：`target.chat_id` 有值时用它，否则用渠道默认群；机器人不在目标群里时发送失败，错误计入 `hub_tell` 并向总览群报告。需要为这条改动补测试：有 `target.chat_id` 时请求的 `receive_id` 是它；没有时是默认群；平台返回「机器人不在群里」类错误时不静默吞掉。
- **入站（P2）的约束**：入站消息按事件里的 `chat_id` 映射到项目，所以同一个飞书应用只应开一条长连接，不能每个群一条。我没有核对飞书对「同一应用多条长连接」的投递规则（可能只随机投给其中一条），实现前要先查官方文档，核实之前按「一个应用一条连接」设计。

## 路由规则 `rules.json`

规则文件放在一个 git 管理的配置仓库里，codeg 通过 `CODEG_HUB_RULES` 指向它。修改后执行 `rules check` 校验，通过后热加载；校验失败时继续使用旧规则，并通过 `/tell` 报错。

```json
{
  "version": 1,
  "defaults": { "worktree": "wtree", "parallel": 1, "tell": "needed", "mode": "observe", "timeout_minutes": 30 },
  "rules": [
    {
      "name": "zhifu 同步 dev-rules",
      "enabled": true,
      "mode": "auto",
      "when": { "source": "dev-rules-watch", "types": ["dev-rules.main.updated"] },
      "to": { "agent": "claude" },
      "project": "zhifu",
      "skill": "dev-rules-fanout",
      "ask": "dev-rules 的 main 更新到 {{id}}。只处理当前这个项目：更新它的 dev-rules submodule，同步 .cursor/rules，开一个 PR。",
      "group": "dev-rules-fanout",
      "risk": "low"
    }
  ]
}
```

顶层：`version`（必填，目前为 `1`）、`defaults`（各规则共用的默认值，规则里的同名字段优先）、`rules`（按顺序匹配）。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `name` | 是 | 唯一名称，写进任务记录 |
| `enabled` | 否，默认 `true` | `false` 表示停用，不必删除规则 |
| `mode` | 否，默认 `observe` | `off`：不匹配；`observe`：命中后只记录「本来会做什么」，不创建任务、不执行；`auto`：执行 |
| `when` | 是 | `source` 精确匹配，`types` 取其一；可选 `subject_prefix` |
| `to` | 是 | `agent`：codeg 里已配置的 Agent 类型（如 `claude`、`codex`），对应任务配置的 `agent_type` |
| `acp` | 否 | 与 `WorkTaskConfig` 的 `mode_id`、`config_values` 同形，用来选权限模式、模型、推理深度等；省略则继承该文件夹的设置。模型和推理深度对应哪些 `config_values` 键因 Agent 而异，实现前以 ACP 返回的选项为准 |
| `project` / `cwd` / `worktree` | `project` 与 `cwd` 二选一 | `project` 引用项目注册表（推荐），同时决定通知发到哪个群；`cwd` 直接写路径，通知发到总览群。`worktree` 取 `wtree`（默认，由 wtree.py 新建）或 `none`（只读任务，直接在目录里执行） |
| `skill` / `ask` | 是 | 要用的 skill 和一句指令。`ask` 只能引用 `{{id}}`、`{{type}}`、`{{subject}}`，这三个字段的字符集受限（`[A-Za-z0-9#._:/@-]`），不能带注入文本。`summary`、`detail`、`link`、`meta` 一律不进指令，放进 hub 信封单独附上 |
| `group` / `parallel` | 否 | 并发组（默认等于 `name`）和组内上限（默认 `1`）。同一个 `subject` 同时只跑一轮；运行中又来同 subject 的事件时，合并成「结束后再跑一次」，语义与 `forge/auto` 一致 |
| `risk` | 是 | `low`、`regular`、`high`，取值与 `product-dev.mdc` 一致，决定 tell 策略和以后的合并策略 |
| `timeout_minutes` | 否，默认 `30` | 单个任务的最长运行时间，到点由中台取消并通过 `/tell` 报告（取消入口实现前核实）。这是 P0 唯一由中台自己执行的限制，见「执行」 |
| `tell` | 否，默认 `needed` | `never`；`needed`（只在 Agent 报告需要决策、受阻或失败时通知）；`always` |

校验失败的情形：`when.source` 以 `forge:` 开头（Forge 的 issue 和 PR 只由 Forge 自己处理，D11，避免同一件事被两套规则各建一个任务）；`project` 不在注册表里；`skill` 在 agent-skills 里不存在；`ask` 引用了 `id`、`type`、`subject` 之外的字段；`name` 重名；`risk` 不在 `low`、`regular`、`high` 里。

一个事件先看有没有存活的订阅（见「Thread 订阅」），没有再按顺序匹配规则，只命中第一条 `enabled` 且 `mode` 不是 `off` 的规则。`mode: observe` 命中的事件状态记为 `observed`，并在记录里写明本来会用的 Agent、cwd 和 `ask`；这类事件不通知人，只在管理界面和每日汇总里出现。命中 `risk: high` 的任务，在执行前也要先推卡片等人确认。P0 没有按钮回调，这类任务只通知、不执行。

## 执行

- **来源标记**：hub 创建的任务带 `source_kind = "hub_event"`，来源键为 `hub:<source>:<event id>`。来源只能由中台内部传入，不进 `WorkTaskDraft`（该类型故意不带来源字段，防止客户端伪造）。`engine.rs:6463` 对带 `source_kind` 的任务有一条硬规则：**永远不自动合并**。hub 任务沿用它，正好符合 D5。实现前要逐处核对 `source_kind` 的其他分支（`engine.rs` 里有多处按 `forge_pr` 判断，需确认对 `hub_event` 无副作用）。
- **任务创建**：通过 `work_task_service::create`（内部参数传来源），任务 prompt 由 skill 加 `ask` 加 hub 信封组成。会话链接写回任务记录，方便从任务直接跳到当时的 Agent 会话。
- **worktree**：带 submodule 的仓库（zhifu 就是）调 `wtree.py create --json <slug>`（具体参数以实现时 `wtree.py create --help` 为准，已确认的只有输出里有 `session_switch.workdir`），按返回的 `session_switch.workdir` 绑定 cwd，再执行 `wtree.py session-check --expected <workdir>`，通过后才启动 Agent。任务结束后调 `wtree.py remove`。slug 取 `hub-<rule>-<短 id>`。接入点在 `work_task` 创建 worktree 的位置（`git.rs` 的 `worktree add` 一带），实现前先定位。
- **P0 的限制手段**（已读代码：`src-tauri/src` 里没有 `max-budget`、`allowedTools` 这类执行机制，ACP 任务可配置的只有 `mode_id` 和 `config_values`）：
  1. `acp.mode_id` 选更严的权限模式；
  2. 中台自己执行的 `timeout_minutes`；
  3. 并发组上限 `parallel`；
  4. 带来源的任务永远不自动合并，且不执行合并；
  5. 一个规则一个项目，任务只写自己的 worktree。

  **没有金额预算，也没有工具白名单**。这与 dev-rules §4 对 `claude -p` 的要求不同（那条约束的是无头调用，不是 ACP）。要强约束，需要无头运行器或脚本执行，见「待定问题」第 1 条。
- **汇报**：不新建 `hub_report`。codeg 已有 `task_progress` 和 `task_complete`，结论为 `success`、`needs_review`、`blocked`（`acp/delegation/companion.rs:1414` 校验），引擎据此结算：`blocked` 变为失败，`success` 和 `needs_review` 进入 review。P0 只新增一个结论 `dropped`，表示查过后没有要做的事，任务静默结束，不通知人。对应关系：

  | 要表达的 | 现有机制 |
  | --- | --- |
  | 有进展 | `task_progress`，不通知 |
  | 结果就绪，等人审 | `needs_review` / `success`，任务进入 review |
  | 缺信息或权限 | `blocked` |
  | 失败 | 引擎结算为 failed |
  | 没有要做的事 | **新增** `dropped` |

  `tell: needed` 时，只有进入 review、`blocked`、失败三种情形才通知。`question` 和 `options`（相当于文章里的「票拟」）放进 `task_complete` 的 summary，P0 不做结构化字段，P2 做卡片时再结构化。「等后续事件」的 `waiting` 状态属于订阅直通，随 P1 引入。

## 合并策略（P1 起生效）

- 第 1 到 2 周：CI 加审查都通过后，一律推卡片，由人在 GitHub 合并。同时统计每类 PR 的驳回率。
- 之后放开：只有 `risk: low`、改动路径全在白名单内、CI 全绿、审查没有阻断项的 PR，才由 CI 打上 `automerge` 标签，交给 GitHub auto-merge 合并。
- 首批白名单：dev-rules 分发产生的 PR（只改 submodule 指针、`.cursor/rules/`、`AGENTS.md` 托管块）、纯文档改动、纯测试改动。
- 永远推卡片：上游合并、数据库迁移、鉴权与权限、密钥、发布配置、依赖大版本升级。
- 白名单本身作为长期授权写进决策台账（附原话和日期）。xj-review 规则补一句「台账内的类别视为已授权」。这句规则的修改属于 dev-rules 的变更，另提 PR。

## 数据模型（SeaORM 迁移，只新增表）

- `hub_source`：`id`、`name`、`key_hash`、`project`（可空，绑定后该来源只能向此项目的群发消息）、`enabled`、`created_at`、`revoked_at`。
- `hub_event`：`id`、`source_id`、`event_id`、`type`、`subject`、`summary`、`detail`、`link`、`meta`、`received_at`、`status`（`unrouted`、`observed`、`queued`、`running`、`delivered`、`delivery_failed`、`done`、`needs_decision`、`failed`、`coalesced`）、`rule_name`、`work_task_id`。唯一约束 `(source_id, event_id)`。
- `hub_subscription`：`work_task_id`、`source_id`、`subject`、`context_only`（只提供上下文，不带授权，也不唤醒已结束的任务）、`created_at`、`dropped_at`。唯一约束 `(work_task_id, source_id, subject)`。
- `hub_tell`：`source_id`、`project`（可空，空表示总览群）、`key`、`text`、`last_sent_at`、`message_id`。唯一约束 `(source_id, project, key)`。

- **保留期**：`hub_event` 默认保留 30 天，`observed` 和 `unrouted` 只保留 7 天，超期由 Watchdog 同一个定时任务清理；`hub_tell` 保留 30 天。已关联 `work_task` 的事件随任务保留。

不修改现有表。回滚方式：关掉功能开关，新表保留不删。

## 分阶段

### 前置（各自单独提 PR）

1. `dev-rules-fanout/SKILL.md` 去掉写死的 `/Users/xuejiao`，改为从 `.local-projects` 或环境变量解析。
2. `.local-projects` 里 sub2api、agent-skills 改为指向正式 checkout。
3. ~~infra-skills：Tailscale 与 ClashX 共存规则（D6）~~ 已完成（PR #33，2026-11-02 合并）。
4. 本机常驻：`pmset -a sleep 0 disksleep 0 autorestart 1`；codeg 通过 dev-rules 的 `templates/launchagent.plist` 开机自启动。
5. 确定运行形态并补监听配置：用 `codeg-server` 还是桌面版加 `host` 配置（见「监听」）。
6. 新建私有仓库 `youxuanxue/agent-hub-config`，放 `rules.json` 和 `projects.json`；总览群 id 写在这里。
7. `dev-rules-fanout` skill 增加单项目模式（只处理 `ask` 指定的当前项目），否则第一个场景的 skill 会按 `.registered-projects` 扫全部项目。
8. 接入 zhifu：本机已克隆到 `~/Codes/zhifu`（仓库已有 `dev-rules` submodule 和 `.cursor/rules/`）；还需要拉取 submodule，并在 dev-rules 的 `.registered-projects` 登记（`sync.sh --local`，会改动两个仓库，各自走 PR）。zhifu 的专属飞书群建好后补 `feishu_chat`。sub2api 已在注册表里；ai4s 暂不接入，仓库和群准备好再加。

### P0：打通

- `/events`、`/tell`、`hub_event` 和 `hub_source` 和 `hub_tell` 三张表、key 管理命令和 `codeg hub check`、`rules.json` 与 `projects.json` 的加载和校验、并发组、`timeout_minutes`、work_task 接入 wtree.py、`dropped` 结论。飞书只通知、不审批，通知带项目名，全部发总览群（专属群建好后再做 D10）。
- 三条事件按顺序接入，每周一条：
  1. **dev-rules main 变更 → 同步 zhifu**（一条规则一个项目，一个事件产生一个任务）：用一个独立的小脚本（LaunchAgent 每 2 分钟跑一次，`git ls-remote` 加 `curl` 投递）检测 dev-rules 的 main 有没有变化，有变化就以 `id = <sha>` 投递事件。不用 codeg 的定时任务：它的动作是启动 Agent 会话或入队任务（`automation/engine.rs`），每次轮询都会产生一次模型调用。脚本先把最近一次已投递的 sha 写到本地文件再发，失败时用同一个 sha 重发，按 sha 天然幂等。以后给 sub2api 等项目加同步，就是各加一条规则，互不影响。这个场景同时验证 wtree.py（zhifu 有 submodule）。
  2. **Forge issue**：沿用现有自动处理，扫描间隔调到 1 到 2 分钟，通知改走 `/tell`。
  3. **上游合并**：`upstream-merge-notify` 开出的 `[upstream-merge]` issue 由 Forge 规则接手，Agent 执行合并并开 PR，`tell: always`，由人合并。

### P1：门禁

- **Thread 订阅直通**（D7）：`hub_subscription` 表、直通与恢复、送达与重试、`waiting` 结论。第一个有后续事件的场景（例如 PR 上的评论和 CI 结果）出现时实现。
- **多群出站**（D10）：zhifu 专属群建好时，改 Lark 发送路径，同时做来源绑定项目。
- 在 M4 或本机装 GitHub self-hosted runner，跑 `preflight.sh`，再加一个 Codex 只读审查（断网、读不到密钥、最多 3 轮、只报真 bug，结果沿用 review record 格式）。
- 公开仓库继续用 GitHub 自带的机器，参照 AIHOT 的 `check.yml`：action 钉到完整 SHA，PR 检查数据库迁移能否在线执行。
- 自动合并白名单、发布后核实 job。CI 部分单独出审批文档。
- **Watchdog**：一个定时任务，每小时检查三件事：任务有无实质进展（长时间 `running` 且没有 `progress` 汇报的标为疑似卡住）；事件有无积压（`queued` 超时）；`/tell` 有无送达。发现异常时通过 `/tell` 报告，而不是自动重启。它自己只读，不修改任何状态。

### P2：审批与告警

- 飞书 `card.action.trigger` 回调接入 `lark.rs`，产出 `callback_data`。实现 `send_interactive_message` 和 `update_message`，点击后卡片改为显示结论。
- 决策台账：每个仓库放 `docs/decisions/decided.md` 和 `docs/decisions/declined.md`，由一个 skill 读写。推卡片之前先查台账，已定的事不再问第二遍。
- 告警事件：`host-clean`、`clash-edge-health` 等来源投递 `alert.*` 事件。上升给人的条件参照 AIHOT：交出去 1 小时（读者受影响）或 3 小时（今天要处理）后还没恢复，或者同一个问题一天里第三次交出去，才通知人。这部分逻辑放在事件来源一侧。
- **模型判断层**：飞书群聊、issue 评论等非结构化来源，先用程序做白名单与来源筛选（确定性、不调模型），通过的候选事件再交给一个轻量模型判断是否需要行动。仅对这类来源启用，结构化来源仍走确定性规则。判断层的规则同样有 `observe` 档。
- **谁能提需求**：开放渠道（飞书群、外部用户的 issue 评论）增加提需求者白名单。不在名单内的消息最多作为候选，不能直接触发执行。
- **群内指令**：在某个项目的群里发消息，按 `chat_id` 自动归到该项目，不用每条都写项目名。范围限定为三类：查这个项目的任务状态、停止这个项目的某个任务、给某个任务追加一句指令。不开放任意命令，也不能操作别的项目的任务。每个项目有自己的发送者白名单（飞书 open_id），不在名单内的人发的消息直接忽略。总览群只读，不接收指令。
- 任务列表和看板页面。

## 验收（P0）

- 单元和集成测试（`cargo test --features test-utils` 加 server 模式）：
  - 鉴权：无 key、错误 key、已吊销 key 都返回 401。
  - 幂等：同一个 `(source, id)` 并发投递 10 次，只落一行、只派发一次。
  - 超长或非法字段返回 422/413，不落库。
  - 规则匹配按顺序取第一条；没有匹配的记为 `unrouted`。
  - 并发组：同一 subject 运行中又来事件时合并成一次补跑；组内上限生效。
  - 规则文件校验失败（`project` 不存在、`ask` 引用了 `summary`、`when.source` 以 `forge:` 开头、`name` 重名）时，继续使用旧规则，并向总览群报错。
  - `ask` 里出现 `{{summary}}` 被拒绝；事件的 `summary` 带「忽略以上指令」之类文本时，只出现在信封里，不进指令。
  - hub 任务永远不会自动合并（`source_kind` 非空）。
  - 任务超过 `timeout_minutes` 被取消，并向总览群报告。
  - key 管理：`create` 只显示一次 key；`revoke` 后该 key 立即返回 401；`rotate` 后旧 key 失效。
  - `/tell` 同一个 key 一小时内，内容相同的只发一次；内容不同则补发新消息。
  - （P1）订阅直通：任务存活期间，同一 `(source, subject)` 的新事件送给原任务，不新建任务、不匹配规则；任务被人停止后不再收到任何事件。
  - `mode: observe` 的规则命中后不创建任务、不通知，只留记录；改成 `auto` 后同类新事件才执行。
  - `task_complete` 的 `dropped` 结论让任务静默结束，不通知人。
  - （D10 时）多项目：规则指向项目 A，通知只出现在 A 的群，B 的群和总览群都收不到；绑定了项目 A 的来源传 `project: B` 时仍发到 A 的群；未绑定项目的来源传注册表里没有的项目名返回 422；`projects.json` 里出现重复的 `feishu_chat` 时校验失败并保留旧文件。
  - 带 submodule 的仓库：wtree.py 创建、`session-check` 通过后才启动；`session-check` 失败时任务失败，不启动 Agent。
  - 鉴权隔离：事件 key 调用任意管理 API 返回 401；`CODEG_TOKEN` 调用 `/events` 返回 401；同一个 key 超过限流返回 429。
  - `/tell` 纯文本：请求体里带按钮、卡片或回调字段时被忽略，飞书上收到的消息标题固定为 `[项目][来源名]`。
  - （P1）订阅直通的送达：任务执行中到达的事件在当前步结束后送入且不打断；送入失败时状态为 `delivery_failed` 并按退避重试。
  - 保留期：超期的 `observed` 事件被清理，关联了任务的事件不被清理。
- 实机验证：在 dev-rules 推一个只改文档的 commit，2 分钟内看到分发 PR 开到已登记的项目，飞书收到一条通知；把同一个 sha 再投递一次，不产生第二个任务。
- 监听检查：`lsof -iTCP -sTCP:LISTEN` 显示 codeg 只监听 tailnet 地址，没有 `0.0.0.0` 或 `*`；从 tailnet 之外的设备访问不通。
- P0 不新增 UI，因此不需要 Playwright e2e；P2 加看板时再补。

## 风险与回滚

- 本机兼任日常开发机，Agent 会和人抢 CPU 和模型额度。P0 没有金额预算，只能用 `parallel`、`timeout_minutes` 和一个规则一个项目来限制；任务多了以后迁到独立 Mac mini。
- Agent 在任务 worktree 里仍然有完整的 shell 权限，工具白名单在 P0 不存在。因此 P0 只接 `risk: low` 的场景，并且所有 PR 由人合并。
- 关机或重启期间 `/events` 收不到事件。能否补回取决于来源：AIHOT 先存再发、按 `id` 重发，会补投；Forge 扫描恢复后会补扫；dev-rules 检测脚本记录了最近已投递的 sha，恢复后会补发。新来源必须遵守「先存再发、用同一个 `id` 重试」，并在接入验收里证明这一点；做不到的来源不得接入。
- 功能开关 `CODEG_HUB_ENABLED` 默认关闭。关闭后 `/events` 返回 503，已有的 Forge 自动处理和定时任务不受影响。

## 待定问题

1. **金额预算和工具白名单**：codeg 的 ACP 任务没有这类执行机制。选项：A，新增无头运行器，让中台任务走 `claude -p` 一类的无头调用，能带 `--allowedTools` 和 `--max-budget-usd`，但要写一套新的执行路径；B，中台只收事件、路由和通知，执行交给 agent-skills 里的脚本；C，留在 ACP，用 P0 的五种限制手段，只接低风险场景。**P0 按 C 推进（用户于 2026-11-02 确认）**；将来要接中高风险场景时再评估 A。
2. Forge 自动处理的规则是否并入 `rules.json`：P0 不并入（D11），P2 再评估。
3. zhifu 专属飞书群的群 id（建群后提供）；sub2api、ai4s 何时接入。
4. 路由规则放私有仓库 `agent-hub-config`（D12，已建）。该仓库里现有的 `projects.json` 还带着已移除的 `launcher` 字段，下一次提交配置时一并去掉。

**实现前需要核实的项**（本方案没有读到代码或没有实测）：
- `launcher` 能否按规则作用到 ACP 启动的 Agent（`commands/acp.rs` 的 `build_runtime_env_for_agent`）。
- 中台取消运行中任务的入口。
- worktree 守卫是否允许任务按预期写入自己的 worktree 之外的位置；一个规则一个项目时不涉及，但 wtree.py 创建的 submodule worktree 路径要确认在守卫允许的范围内。
- `folder_service::add_folder` 对已存在路径是否幂等。
- `source_kind` 在 `engine.rs` 中的全部分支对 `hub_event` 的影响。
- 飞书对同一应用多条长连接的投递规则（P2 入站前）。
- dev-rules 和 zhifu 是否配置了分支保护。

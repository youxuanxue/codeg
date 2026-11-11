---
approved_by: user-chat-2026-11-02
status: approved
risk_level: high
---

# Agent 自动化（codeg 本机方案）

## 目标

Agent 自己处理能处理的事，只在需要人拍板时找人；人在飞书上就能回应。重复的运维和合并，能交给机器的都交给机器。

参考对象是「数字生命卡兹克」的公开文章《折腾了整整1年，毫无保留地分享一下我这套Agent自动化系统》，以及作者开源的 `KKKKhazix/AIHOT` 中事件生产方的实现（`packages/backend/src/notify/agent.ts`、`operations/alerts.ts`）。作者的中台和 CI 中台本身没有开源。

实施分四步：

| 步骤 | 内容 | 状态 |
|---|---|---|
| 0 | 本机运行 codeg（`scripts/local-deploy.sh`，launchd 开机自启） | 已完成 |
| 1 | 只在需要人时推送，人在飞书上回应 | 已完成 |
| 2 | 定期运维任务交给 Agent | 已完成，部分场景待首次触发 |
| 3 | 低风险 PR 由 Agent 合并 | 已完成，待首个真实 PR |
| 4 | 事件中台（`/events`、路由规则、Watchdog） | **暂缓**，见文末「暂缓：事件中台」 |

## 已定决策

每条附用户原话出处。改动这些决策要有用户新的明确答复。

- **D1 运行位置**（2026-11-02）：本机兼任 worker，codeg 以 `codeg-server` 运行，由 `scripts/local-deploy.sh install` 安装成 launchd 用户服务（`com.codeg.server`）。不部署公网服务器。
- **D2 只在需要人时推送**（2026-11-09）：推送给人的事件限定为五类：任务进入 review、任务失败、Agent 提问、权限请求、出错。其余进度不推送。
- **D3 人在飞书上回应**（2026-11-09、2026-11-10，用户：「同意。继续」）：飞书不只是出站通知。回复提问卡片即作答；@ 机器人说一句话即开任务。
- **D4 低风险 PR 由 Agent 合并**（2026-11-11，用户：「低风险 PR 由 Agent 自动执行。同意。」「私有仓库也是低风险 PR 由 Agent 自动执行。只是没有 GitHub 硬拦截而已。」）：Agent 合并的唯一入口是 dev-rules 的 `auto-merge-low-risk`；常规和高风险 PR 由人合并。
- **D5 公开仓库开分支保护**（2026-11-10，用户：「先把本机 codes 里面最近一个月有更新的公开仓库，都打开这个 ci 全绿才能合并 pr 的约束。」）：CI 未全绿的 PR 由 GitHub 拒绝合并。
- **D6 决策台账**（2026-11-09）：已定的事不问第二遍，规则在 dev-rules `rules/product-dev.mdc`「决策台账」。
- **D7 Tailscale 与 ClashX 共存**（2026-11-02）：由 infra-skills 负责，`youxuanxue/infra-skills` PR #33 已合并。仅在事件中台启用 tailnet 监听时需要。
- **D8 事件中台暂缓**（2026-11-11，用户：「保留，标记暂缓。」）：设计保留在文末，未批准实现。启动前须对照当时的代码重新审查并取得用户确认。

## 现状（2026-11-11）

### 推送：只在需要人时

- 任务进入 review 或失败时推送，事件名 `task_attention`（`chat_channel/event_subscriber.rs`）。按 `(任务 id, settled_at)` 去重，同一次结算只推一次。codeg PR #21。
- Agent 提问、权限请求、出错沿用 codeg 已有的 ACP 事件推送。
- 推哪些事件由全局筛选决定（`app_metadata` 的 `chat_event_filter`），本机配置为 `error`、`permission_request`、`question_request`、`task_attention` 四项，覆盖上述五类；`chat_event_top_level_only` 为 `true`，子 Agent 的事件不推。单个渠道还可用 `event_filter_json` 再收窄，飞书渠道未设置。

### 飞书：回复作答

- 提问推送带「直接回复这条消息作答」。回复该卡片（无需 @ 机器人）后，回复原文交给等待中的 Agent，飞书回执「已提交回答。」。回「跳过 / 你定 / skip」等于不作答，由 Agent 自行判断。实现在 `chat_channel/question_reply.rs`，codeg PR #22。
- 只有飞书提供回复引用的消息 id（`parent_id`），所以只在飞书生效；Telegram、微信仍提示到 Codeg 作答。保密问题在任何渠道都不经聊天作答。
- 卡片与问题的对应关系只存内存，上限 256 条。服务重启后，回复重启前的卡片不会被当作作答。
- 飞书应用须开通「获取群组中所有消息」（`im:message.group_msg`）权限，否则不 @ 机器人的回复不会推给 codeg。改权限后，codeg 的飞书渠道要重连或重启才生效。
- 2026-11-10 实测通过：回复「想吃火锅。」，Agent 收到原话并继续执行。

### 飞书：一句话开任务

- @ 机器人说一句普通的话，消息里出现项目名就在该项目开会话，并把它设为当前目录；没出现项目名就用当前目录；两者都没有才回帮助。项目名按整词、不分大小写匹配，同时出现多个时取更长的；任务 worktree 不参与匹配。实现在 `chat_channel/session_commands.rs` 的 `folder_for_plain_text`，codeg PR #25。
- 已上线，尚未实测。

### 定期运维

- **sub2api 每周清理**：codeg 定时任务，每周日 09:17 启动。已跑通，产出 sub2api PR #3118，已合并。
- **Claude Code 版本漂移**：codeg Forge 自动处理（sub2api 文件夹），每 60 分钟扫描一次带 `client-release:claude-code` 标签的 issue，按仓库 skill 做静态版本对齐并开 PR。已配好，尚未遇到首次触发。

### 合并

- **分支保护**（2026-11-10）：codeg（11 项必需检查）、cc-switch（3 项）已开启，sub2api 原本就有。三者均允许 auto-merge、合并后删除分支，不要求人工审批，管理员可绕过（`enforce_admins=false`，与 sub2api 一致）。dev-rules 没有 CI，不开必需检查。私有仓库（zhifu、fde、science-core、agent-skills、infra-skills、agent-hub-config）在免费账号下开不了分支保护。
- **`auto-merge-low-risk <PR号>`**（dev-rules `global/bin`，dev-rules PR #117）：以下条件全部满足才合并，否则打印原因、留给人：
  1. PR 打开、非草稿、目标为默认分支、无冲突；
  2. 带 `risk:low` 标签，且没有 `risk:normal` / `risk:high`；
  3. 未改动合并后会自动发布或天然高风险的路径（工作流、部署、迁移、schema、计费与定价、密钥、`ops/gemini-web/**` 等），文件分页取全，改名的新旧路径都检查；
  4. CI 全部完成且全绿。
- 默认分支有必需检查的仓库走 `gh pr merge --auto`，由 GitHub 再核 CI；没有的仓库（私有仓库、dev-rules）只靠脚本把关，确认后直接合并。合并锁定检查过的 head commit，脚本不打 tag、不发 release、不部署。
- 直接执行 `gh pr merge` 仍被 `gh-pr-guard` 拦截，除非用户本次会话亲口授权（dev-rules PR #115）。xj-review 已同步（agent-skills PR #89）。
- `gh-pr-guard` 对 codeg 经 ACP 启动的 Claude 会话生效：本方案的实施会话本身就是这类会话，hook 多次实际拦截与提示。
- 尚未在真实低风险 PR 上执行过。

### 合并后自动发布的仓库

合并到 main 即对外生效的 workflow 只在 sub2api：`pricing-registry-publish`（改价格表后经 AWS 生产角色同步到 prod）、`gemini-web-worker`（推镜像到 ghcr.io）。其余发布都要打 tag 或发 release。上述路径都在 `auto-merge-low-risk` 的保护路径内。

## 风险与回滚

- 低风险判断仍是 Agent 的判断。标错的 PR 会被自动合并；保护路径只兜住「会发布 / 高风险位置」这一类。
- 私有仓库没有 GitHub 侧拦截，`auto-merge-low-risk` 是唯一门禁。
- 本机兼任日常开发机，Agent 与人共用 CPU 和模型额度。
- 部署会重启 `codeg-server`，正在进行的 codeg 会话随之断开。
- 回滚：删除对应仓库 main 的分支保护并关闭 `allow_auto_merge`；改动前的设置备份在本机 `/tmp/branch-protection-backup/`。停用自动合并只需不再调用脚本，或撤回 dev-rules PR #117。

## 未完成

- 一句话开任务：待实测。
- 低风险 PR 自动合并：待首个真实 PR。
- 版本漂移自动处理：待首次触发。
- 私有仓库是否升级 GitHub Pro 以获得分支保护：未定。

---

## 暂缓：事件中台

**状态：暂缓，未批准实现**（2026-11-11，见 D8）。以下保留 2026-11-02 至 2026-11-08 的设计与读代码结论，引用的代码位置以 main `b8483dde` 为准，可能已过时。启动前须对照当时的代码重新审查，并与上文「已定决策」「现状」对齐：其中「通知只走 `/tell`」「Agent 不合并」「飞书入站放到 P2」等前提已被上文 D2 到 D4 取代；下文的 D 编号均指上文「已定决策」。

### 中台的原设计决策（暂缓期间不生效）

- **事件来源**：GitHub/GitLab 用 Forge 定时扫描，不接公网 webhook。中台只对 tailnet 开放，不开 Tailscale Funnel。
- **事件协议**：与 AIHOT 完全兼容。来源按 API key 区分，不信任消息体自报；扩展字段只放可选的 `meta`。
- **worktree 单一 owner**：带 submodule 的仓库由 codeg 调 `wtree.py create --json` / `remove`。
- **Thread 订阅直通**：事件的 `subject` 作为 Thread 键，同一 Thread 的后续事件直接送给原任务。
- **规则级 `mode`**：`off`、`observe`、`auto` 三档，新规则先 `observe`。
- **一个项目一个飞书群**：另有总览群只收跨项目汇总和告警；出站多群走单渠道（消息目标带 `chat_id` 时优先使用）。
- **Forge 规则不并入 `rules.json`**：两套并存，是否合并以后再评估。
- **配置仓库**：私有仓库 `youxuanxue/agent-hub-config`（已建），存放 `rules.json`、`projects.json`。

### 非目标

- 公网可达的中台、多用户、多租户。
- 自建 CI 中台。
- 替换 Forge 自动处理的现有规则。
- 使用 cli-agent-orchestrator：它没有入站事件，功能与 codeg 重叠。
- 常驻 Router 模型：结构化事件用确定性规则就够。

### 架构

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
                                     结论 ─▶ 现有推送（task_attention 等）─▶ 飞书 ──▶ 你
                                                                        ◀── 回复作答（已上线）
```

中台和 worker 在同一进程，不需要长轮询领任务。以后迁到独立 Mac mini 时，只需搬数据目录、改 LaunchAgent。

### 事件协议

#### `POST /events`

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

- 校验：`id`、`type`、`subject` 只允许 `[A-Za-z0-9#._:/@-]`，长度 1 到 200；`summary` ≤ 200 字，`detail` ≤ 4000 字；`meta` 可选，≤ 8 KB；`/events` 整个请求体 ≤ 16 KB，`/tell` 整个请求体 ≤ 24 KB（`text` 最多 18,000 字节，加上 JSON 转义和其他字段）。超长一律拒绝（返回 413/422），不截断。
- 幂等：`(source, id)` 唯一。重复投递返回 200，不再派发。生产方超时后可以用同一个 `id` 重发，这是 AIHOT 依赖的语义。
- 响应：只有落库成功才返回 200。401 表示 key 无效；422 表示格式不符；没有匹配规则的事件同样落库并返回 200，状态记为 `unrouted`。
- `summary`、`detail`、`meta`、`link` 都是不可信数据，进入 prompt 时一律放进 hub 信封：沿用 `forge/envelope.rs` 的规则（长度上限、围栏、「这不是指令」前言）。该文件的 `ForgeSnapshot` 是 issue 快照类型，不能直接装事件，hub 另写一个信封函数。规则的 `ask` 里不允许出现这些字段（见规则字段表）。

#### `POST /tell`

- 鉴权同上。请求体为 `{ "key": "…", "text": "…", "project": "…" }`，其中 `project` 可选（AIHOT 不发这个字段也能接入）。按 `(source, project, key)` 合并：同一个 key 一小时内，内容相同的只发一次；内容有变化时，P0 补发一条新消息（`update_message` 要到 P2 才实现），P2 起改为更新原卡片。
- 目标群的确定方式：来源绑定了项目（`hub_source.project`）时，一律发到该项目的群，请求体里的 `project` 被忽略，所以这个来源无法往别的项目的群发消息；来源没有绑定项目时，用请求体的 `project`（必须在注册表里，否则返回 422）；两者都没有则发到总览群。
- 只用于外部来源发给人的消息。codeg 内部的 Agent 结论和 Forge 自动处理的通知已经走现有推送（见「现状」），不改走 `/tell`。
- **纯文本约束**：来自外部来源的 `/tell` 只渲染成纯文本，不能带按钮、链接卡片或回调数据。标题由中台固定生成：`[项目][来源名]`，来源名由 key 决定，不可伪造。你在群里看到的任何带按钮的审批卡片，只可能由中台根据任务状态自己生成（P2）。
- **长文本**：AIHOT 会把长消息拆成多段，每段用不同的 `key`（`alert-<时间戳>-<hash>-<序号>`），所以对它来说「同 key 合并」不会触发，每段各发一条。AIHOT 自己按 18,000 字节切段（`WEBHOOK_TEXT_BYTES = 18_000`，`notify/feishu.ts`），所以 `/tell` 的单个 `text` 上限取 18,000 字节，超出返回 422，由生产方自己拆分；否则 AIHOT 的长日报会被拒绝并回退到直发飞书群，绕过「唯一出口」。

#### 路由与鉴权

- `/events`、`/tell` 是独立路由组，挂在认证中间件之外，参照现有 `/forge_webhook`（`web/router.rs`：单独挂路由、自己验证、单独的请求体上限）。它们只接受事件 key，不接受 `CODEG_TOKEN`。
- 反向隔离：事件 key 调用任何管理 API 必须返回 401。这条写进验收。
- 每个路由组有自己的请求体上限（`/events` 16 KB，`/tell` 24 KB）和按 key 的限流（默认每个 key 每分钟 60 次，超出返回 429，生产方按原 `id` 重试即可）。
- key 只存哈希值；日志和任务记录里不出现 key 原文。
- **key 管理（P0 范围）**：新增管理接口（受 `CODEG_TOKEN` 保护）：创建来源（key 只在创建时显示一次）、列出、轮换、吊销。命令行入口放在 `codeg-cli` 的 `hub` 子命令下（`codeg-cli hub source create|list|rotate|revoke`），它连接已运行的 Codeg，所以依赖上述管理接口。来源名只允许 `[a-z0-9-]`，长度 1 到 64：它是来源键 `hub:<source>:<subject>` 的一段，不能含 `:`，否则不同的来源和 subject 可能拼出同一个键。另有 `codeg-cli hub check <配置目录>`，**离线**校验 `rules.json` 和 `projects.json`，不需要运行实例，既给热加载用，也给配置仓库的 CI 用。

#### 监听

- **现状（已读代码）**：桌面版内置 web 服务的配置只有 `token`、`port`、`auto_start`，监听地址默认是 `0.0.0.0`（`web/mod.rs`）。`CODEG_HOST` 是 `codeg-server` 二进制的环境变量，桌面版不读。`CODEG_HOST` 也只能写一个地址。
- **做法**：只绑定本机的 tailnet 地址（`100.x.y.z`），本机自己的访问也走这个地址，不再同时绑定 `127.0.0.1`。
- **运行形态（已定）**：中台用 `codeg-server`，由 `scripts/local-deploy.sh install` 安装为 launchd 用户服务（`com.codeg.server`，`RunAtLoad`、`KeepAlive`，main 的 #19 合入）。这个脚本是本机运行 codeg 的唯一 owner，中台不另写 LaunchAgent。桌面版不改：不给 `WebServiceConfig` 加 `host` 字段。
  - 监听地址：安装时设 `CODEG_HOST=<tailnet 地址>`。脚本默认是 `0.0.0.0`，不满足本方案，所以 hub 的部署必须显式传这个值。
- **启动顺序**：`codeg-server` 绑定失败时只记录错误并以退出码 1 结束，不重试（`bin/codeg_server.rs`）。如果开机时 Tailscale 还没分配地址，中台会起不来。`local-deploy.sh` 生成的 plist 有 `KeepAlive`，launchd 会按默认节流（约 10 秒一次）反复重启直到绑定成功，期间每次失败都写一条错误日志。P0 对 `local-deploy.sh` 的改动：`CODEG_HOST` 是 `100.64.0.0/10` 内的地址时，启动命令先轮询 `tailscale ip -4`（上限 60 秒）再 `exec codeg-server`。
- Tailscale ACL 只放行用户自己的设备和登记过的服务器。
- 现有 `CODEG_TOKEN` 继续保护管理 API，与事件 key 互不通用。

#### Thread 订阅（P1 实现）

- **Thread 键**：`(source, subject)`。同一个 PR、同一个告警、同一个飞书话题，生产方应使用同一个 `subject`。
- **订阅**：规则命中并创建任务后，任务自动订阅该 Thread。一个任务可以订阅多个 Thread，一个 Thread 也可以被多个任务订阅（例如两个任务在同一个 PR 上工作）。
- **直通**：新事件的 `(source, subject)` 已有存活的订阅时，程序直接把事件作为输入送给订阅它的任务，不匹配规则、不新建任务。事件状态记为 `delivered`。
- **没有订阅时**：走规则匹配。任务结束后订阅保留，但 P0 不会因为后续事件恢复已结束的任务：`/events` 里的事件都是程序投递的，系统无法确认背后是不是人。恢复已结束的任务只对满足 `meta.actor_kind = "human"`、来源在白名单内、并且是该任务授权人的事件开放（例如飞书项目群里白名单发送者的消息）。
- **解除**：任务可以对认为无关的 Thread 取消订阅，并把事件交回规则匹配；人可以在管理界面解除某个 Thread 的全部订阅。被人停止的任务不再接收任何事件。
- **并发与送达**：订阅直通的输入不占用并发组的新名额。任务正在执行时，输入按到达顺序排队，在 Agent 当前这一步结束后一次性送入会话，不打断正在执行的工具调用；任务空闲（`waiting`）时直接送入并唤醒。送入失败（会话不可用）时输入保留，状态记为 `delivery_failed`，按 2 秒起、翻倍、上限 1 分钟的间隔重试。

### 项目与飞书群

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
- **项目到 codeg 文件夹的映射**：`work_task` 需要 `folder_id`。中台启动和热加载时，按 `cwd` 找到对应的 codeg 文件夹（没有则登记，用 `folder_service::add_folder`：按路径幂等，已存在时只刷新名称和打开状态、清除软删除标记，不改父子关系，见 `db/service/folder_service.rs`）。找不到或登记失败，校验失败。
- 出口 IP / 启动器（cc0、codex0）：我没有核实 `build_runtime_env_for_agent` 能否按规则选择启动器，所以 P0 的规则里不提供 `launcher` 字段，沿用 codeg 的 Agent 全局运行环境设置。能否按规则选择，列入待核实项。
- 项目的通知一律带项目名：卡片标题以 `[sub2api]` 开头，任务记录里也带 `project`，方便在总览里按项目筛。
- 总览群收三类消息：每日跨项目汇总、Watchdog 告警、找不到项目的 `unrouted` 事件摘要。
- **渠道约束（已读代码）**：codeg 的 Lark 渠道一个实例只绑定一个 `chat_id`（`chat_channel/backends/lark.rs` 的 `LarkBackend::new`），发送时用的也是这个值（`send_lark_message`），不看消息目标里的 `chat_id`。按「出站多群走单渠道」，P0 改发送路径：`target.chat_id` 有值时用它，否则用渠道默认群；机器人不在目标群里时发送失败，错误计入 `hub_tell` 并向总览群报告。需要为这条改动补测试：有 `target.chat_id` 时请求的 `receive_id` 是它；没有时是默认群；平台返回「机器人不在群里」类错误时不静默吞掉。
- **入站的约束**：飞书入站（回复作答、一句话开任务）已在单渠道、单长连接上运行。多群时入站消息按事件里的 `chat_id` 映射到项目，同一个飞书应用只应开一条长连接，不能每个群一条。我没有核对飞书对「同一应用多条长连接」的投递规则（可能只随机投给其中一条），实现前要先查官方文档，核实之前按「一个应用一条连接」设计。

### 路由规则 `rules.json`

规则文件放在一个 git 管理的配置仓库里，codeg 通过 `CODEG_HUB_RULES` 指向它。修改后执行 `codeg-cli hub check` 校验，通过后热加载；校验失败时继续使用旧规则，并通过 `/tell` 报错。

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
      "acp": { "mode_id": "<实测后确定>" },
      "project": "zhifu",
      "skill": "dev-rules-fanout",
      "ask": "dev-rules 的 main 更新到 {{id}}。只处理当前这个项目：更新它的 dev-rules submodule，同步 .cursor/rules，提交到任务分支。不要 push，也不要开 PR。",
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
| `to` | 是 | `agent`：codeg 里已配置的 Agent 类型，对应任务配置的 `agent_type`。P0 只允许 `claude`（`gh-pr-guard` 只对 Claude Code 有效） |
| `acp` | 否 | 与 `WorkTaskConfig` 的 `mode_id`、`config_values` 同形，用来选权限模式、模型、推理深度等；省略则继承该文件夹的设置，但 `mode: auto` 的规则必须写 `mode_id`（见「执行」的限制手段第 1 条）。模型和推理深度对应哪些 `config_values` 键因 Agent 而异，实现前以 ACP 返回的选项为准 |
| `project` / `cwd` / `worktree` | `project` 与 `cwd` 二选一 | `project` 引用项目注册表（推荐），同时决定通知发到哪个群；`cwd` 直接写路径，通知发到总览群。`worktree` 取 `wtree`（默认，由 wtree.py 新建）或 `none`（只读任务，直接在目录里执行） |
| `skill` / `ask` | 是 | 要用的 skill 和一句指令。`ask` 只能引用 `{{id}}`、`{{type}}`、`{{subject}}`，这三个字段的字符集受限（`[A-Za-z0-9#._:/@-]`），不能带注入文本。`summary`、`detail`、`link`、`meta` 一律不进指令，放进 hub 信封单独附上 |
| `group` / `parallel` | 否 | 并发组（默认等于 `name`）和组内上限（默认 `1`）。同一个 `subject` 同时只跑一轮；运行中又来同 subject 的事件时，合并成「结束后再跑一次」，思路与 `forge/auto` 的 `rerun` 一致，但事件带载荷，所以补充规定：补跑只用**最新一个**事件的载荷；被合并的事件状态记 `coalesced`，并记录最终处理它的事件 id（`coalesced_into`），不再单独执行。补跑的任务完结后，这些 `coalesced` 事件的显示状态随它。dev-rules 同步场景用 sha 同时当 `id` 和 `subject`，补跑取最新 sha 即可 |
| `risk` | 是 | `low`、`regular`、`high`，取值与 `product-dev.mdc` 一致，决定 tell 策略和以后的合并策略 |
| `timeout_minutes` | 否，默认 `30` | 单个任务的最长运行时间，到点由中台取消并通过 `/tell` 报告（取消入口实现前核实）。这是 P0 唯一由中台自己执行的限制，见「执行」 |
| `tell` | 否，默认 `needed` | `never`；`needed`（只在 Agent 报告需要决策、受阻或失败时通知）；`always` |

校验失败的情形：`when.source` 不是已登记的 hub 来源名（Forge 不经过 `/events`，没有 hub 来源，所以规则无法监听 Forge 的 issue 和 PR，见「Forge 规则不并入 `rules.json`」。来源登记在数据库里，离线的 `codeg-cli hub check` 只检查名字格式，是否已登记由运行中的实例在热加载时检查）；`to.agent` 不是 `claude`（P0）；`project` 不在注册表里；`skill` 在 agent-skills 里不存在；`ask` 引用了 `id`、`type`、`subject` 之外的字段；`name` 重名；`risk` 不在 `low`、`regular`、`high` 里；`mode: auto` 的规则没有 `acp.mode_id`。

P0 没有订阅：事件直接按顺序匹配规则，同一 `subject` 的并发事件走「合并成结束后再跑一次」。P1 引入订阅后，先看有没有存活的订阅（见「Thread 订阅」），已订阅的 subject 改为直通，取代合并；没有订阅的再按顺序匹配规则。匹配时只命中第一条 `enabled` 且 `mode` 不是 `off` 的规则。`mode: observe` 命中的事件状态记为 `observed`，并在记录里写明本来会用的 Agent、cwd 和 `ask`；这类事件不通知人，只在管理界面和每日汇总里出现。命中 `risk: high` 的任务，在执行前也要先推送等人确认；没有确认机制之前，这类任务只通知、不执行。

### 执行

- **来源标记**：hub 创建的任务带 `source_kind = "hub_event"`，来源键为 `hub:<source>:<subject>`（按 Thread 而不是按事件，原因见「任务创建」）。来源只能由中台内部传入，不进 `WorkTaskDraft`（该类型故意不带来源字段，防止客户端伪造）。`auto_merge_candidate`（`work_task/engine.rs`）对带 `source_kind` 的任务有一条硬规则：**永远不自动合并**（判断条件是 `source_kind.is_some()`）。hub 任务沿用它；hub 任务产出的 PR 如需合并，按 D4 走 `auto-merge-low-risk` 或由人合并。`engine.rs` 里 `source_kind` 的其他分支已逐处核对（按函数名引用，行号随代码变化）：`pr_checkout_point`、`drop_pr_fetch_refs`、`merge_task_inner`、`own_work_anchor` 只对 `forge_pr` 生效，`forge_writeback` 只对 `forge_issue` / `forge_pr` 发评论，`hub_event` 都落入默认分支，无副作用。例外是两个交付网关 `delivery_source` 和 `recovery_source`：它们只认 `forge_issue`、`forge_pr` 和无来源，其他值一律报错「a task from '…' cannot be delivered」（测试 `a_task_without_deliverable_provenance_is_refused` 锁定），所以 hub 任务现在**无法交付**，见下一条。数据库层和前端对 `source_kind` 的使用没有查。
  - **不走 Agent 自己 push：改用新的交付接口。** main 新增了 `TaskEngine::deliver_pr`（`work_task_deliver_pr_core`，2026-11-03 合入，commit `56749eee`）：任务完成（review）后，中台直接调它，由该接口用「host 的默认账号」push 并开 PR，PR 号记在 `work_task.delivery` 字段，任务若留在 review，下次交付会推进同一个 PR。hub 任务不用 Agent 在会话里自己跑 `git push` / `gh pr create`，省掉一处不确定性（Agent 会话里 `gh` 的登录状态、PR 标题格式），也不用中台自己维护「这个任务对应哪个 PR」的映射。调用时 `mark_done` 传 `false`：开 PR 后任务留在 review，等人在 GitHub 上合并（P0 没有卡片按钮），这一步不能把任务标记为 `done`。`delete_worktree` 跟随文件夹的清理设置。这条仍然绕不开「带 `source_kind` 的任务永远不自动合并」的硬规则：该规则看的是 `source_kind.is_some()`，与是否调用 `deliver_pr` 无关。
  - **P0 代码改动：让 `hub_event` 可交付。** `delivery_source` 和 `recovery_source` 各加一个 `hub_event` 分支，走与无来源任务相同的 `DeliverySource::Local` 路径（交付到项目 `origin`，首次交付后由 `work_task.delivery` 固定目标）。`source_kind` 仍保持非空，「永远不自动合并」不受影响。测试：`hub_event` 任务能交付到 `origin` 并记录 PR 号；交付中断后的恢复走同一目标；未知来源（例如 `automation`）仍被拒绝；`hub_event` 任务仍不是 `auto_merge_candidate`。
  - **PR 的结局回写任务（P0）。** `mark_done=false` 之后，引擎不会自己发现 PR 已合并，任务会一直停在 review，同一 subject 的补跑也就永远等不到（见「数据模型」的非终态定义）。所以中台加一个定时检查（与 Forge 扫描同间隔）：对 `source_kind = "hub_event"`、状态为 review 且 `delivery` 已记录 PR 号的任务，用 `ForgeDeliveryApi::get_pull` 查 PR 状态。已合并：调 `deliver_pr(mark_done = true)` 完结任务，PR 已在本任务的 commit 上合并时它不再 push（测试 `a_kept_task_finishes_on_its_merged_pull_request_without_pushing`）。关闭但没合并：调 `TaskEngine::cancel`，原因写「PR 被关闭」，并按 `tell` 规则通知。仍开着：不动。查询失败只记录、下一轮再查，不改任务状态。
- **前端（已读代码）**：看板的交付判断写成 `source_kind == null`：`task-acceptance.ts` 的 `deliversIntoOpenPr` 和 `canDeliverToPr`（后者只对 Forge 任务或已读到远端的任务为真），`task-deliver-pr-dialog.tsx` 的 `firstLocal`，`task-detail-sheet.tsx` 读取项目远端的条件。`hub_event` 任务不满足这些条件，所以自动交付失败、任务回到 review 后，看板不提供交付按钮，人无法重试。P0 改动：在 `task-acceptance.ts` 加一个判断「按本地任务交付」（`source_kind` 为空或为 `hub_event`），这几处都改用它，与后端 `delivery_source` 的 `Local` 分支对应。任务时间线的「由自动处理创建」按 `auto_trigger` 显示触发方式，`AUTO_TRIGGER_KEYS`（`task-detail-sheet.tsx`）没有 `hub` 时会原样显示 `hub`，所以同时加 `hub` 的文案（10 种语言）。
- **任务创建（已读代码）**：公开的 `work_task_service::create` 只收 `WorkTaskDraft`，不能带来源；唯一写来源列的入口是 `create_from_forge_by`。hub 直接调它（`auto_trigger` 传 `"hub"`，`force` 传 `false`）。它在同一事务里写 `work_task_source_key` 行，并在插入后检查同一来源键有没有别的活跃任务（`other_active_for_keys`，活跃的定义是 `ACTIVE_STATUSES`），有则回滚并返回 `Duplicate`。来源键取 `hub:<source>:<subject>`，这个检查就正好回答「同一 subject 是否还在跑」：返回 `Duplicate` 时事件记为 `coalesced`，hub 不另写一套判断。函数名带 forge，但不改名：它是上游代码，改名会增加每次上游合并的冲突。hub 的键以 `hub:` 开头，Forge 的键以 provider 开头，`source_keys_ever_tasked` 等 Forge 扫描用的查询不会碰到 hub 的键。任务 prompt 由 skill 加 `ask` 加 hub 信封组成。会话链接写回任务记录，方便从任务直接跳到当时的 Agent 会话。
- **worktree（接入点已定位）**：任务 worktree 由 `TaskEngine::ensure_worktree`（`work_task/engine.rs`）创建：先记下 base 分支和 sha，再调 `git_worktree_add`（`commands/folders.rs`），分支固定为 `task/<任务 id>`，目录为 `<项目目录名>-task-<任务 id>`，放在该文件夹设置的 `worktree_root` 下；随后 `open_worktree_folder_core` 把它登记成以任务文件夹为父的 worktree 文件夹，`work_task_service::attach_worktree` 记录 `worktree_folder_id`、base 和分支。`work_task/*.rs` 和 `commands/folders.rs` 里没有任何 submodule 处理（搜索 `submodule` 无结果）。
  - **做法**：只在 `ensure_worktree` 里加一个分支：仓库有 `.gitmodules` 时，用 `wtree.py create --json --repo <根目录> --branch task/<id> --base <记录的 base_sha> <slug>` 代替 `git_worktree_add`，取返回的 `session_switch.workdir` 作为 `wt_path`，后面的登记和 `attach_worktree` 原样不动。这样分支命名和 diff 的 base 都与引擎一致。不抽象成 provider 接口，只有这一处分支。
  - **要处理的差异**：① `wtree.py` 的 `--branch`、`--base` 与默认目录规则（默认分支名取自 `../<repo>-wt-<name>` 的目录名）以 `create --help` 为准，组合起来的行为实现时实测；目录位置由 wtree 决定，与 `worktree_root` 设置要对齐或明确忽略。② 清理：引擎现有的移除路径（`recreate_worktree_from_branch`、任务删除和取消时的 worktree 移除）不认识 submodule worktree，带 submodule 的任务必须改调 `wtree.py remove --path <路径>`，所有移除点都要覆盖。③ `session-check --expected <workdir>` 在 cwd 等于 workdir 时运行，作为创建后的校验；ACP 任务的 cwd 由引擎直接设定，不依赖会话切换。
  - 这是 P0 里改动面最大的一块，先单独提 PR，再接事件入口。
- **P0 的限制手段**（已读代码：`src-tauri/src` 里没有 `max-budget`、`allowedTools` 这类执行机制，ACP 任务可配置的只有 `mode_id` 和 `config_values`）：
  1. `acp.mode_id` 显式指定权限模式。Claude Code 会话没有指定模式时，先用它自己的 `permissions.defaultMode`，没有才用 Auto（main 的 `503645bc`，见 `docs/cli.md`「Permissions」）。本机 `~/.claude/settings.json` 的 `defaultMode` 是 `bypassPermissions`：ACP 会话如果读取用户设置，不指定模式的 hub 任务就会以 bypass 运行。所以 `mode: auto` 的规则必须写 `acp.mode_id`，不继承文件夹设置（校验项）。取哪个值实测后定：Auto 会自己拒绝它判断为有风险的命令，经 API 网关时可能全部拒绝；
  2. 中台自己执行的 `timeout_minutes`（也是无人值守时的兜底：更严的权限模式可能让任务停在等待应答，引擎把这类请求记进未应答请求集合，任务随之进入 `awaiting_input`（`work_task/engine.rs` 模块注释），没人应答就一直等到超时；`mode_id` 的取值和无人值守行为要实测）；
  3. 并发组上限 `parallel`；
  4. 带来源的任务不由引擎自动合并；PR 合并按 D4（低风险走 `auto-merge-low-risk`，其余由人）；
  5. 一个规则一个项目，任务只写自己的 worktree。

  **没有金额预算，也没有工具白名单**。这与 dev-rules §4 对 `claude -p` 的要求不同（那条约束的是无头调用，不是 ACP）。要强约束，需要无头运行器或脚本执行，见「待定问题」第 1 条。
- **汇报**：不新建 `hub_report`。codeg 已有 `task_progress` 和 `task_complete`，结论为 `success`、`needs_review`、`blocked`（`acp/delegation/companion.rs` 的 `build_tools_call_spawn` 校验），引擎据此结算：`blocked` 变为失败，`success` 和 `needs_review` 进入 review。P0 只新增一个结论 `dropped`，表示查过后没有要做的事，任务静默结束，不通知人。落点与改动（三处）：① `build_tools_call_spawn` 的校验和错误文案增加 `dropped`；② `work_task` 迁移和实体里列出结论值的注释同步；③ 引擎结算（`work_task/engine.rs` 的 `on_turn_complete`）把 `dropped` 当作 review 处理，并在 `tell` 策略里跳过通知，然后由中台调用现有的 `complete_without_merge`（`work_task_service.rs`，review → done，引擎会拿 git 重新核对「没有改动」）自动完结并清理 worktree。若 Agent 报了 `dropped` 但 worktree 里有改动，不自动完结，按普通 review 通知，避免静默丢弃工作。对应关系：

  | 要表达的 | 现有机制 |
  | --- | --- |
  | 有进展 | `task_progress`，不通知 |
  | 结果就绪，等人审 | `needs_review` / `success`，任务进入 review |
  | 缺信息或权限 | `blocked` |
  | 失败 | 引擎结算为 failed |
  | 没有要做的事 | **新增** `dropped` |

  `tell: needed` 时，只有进入 review、`blocked`、失败、`awaiting_input` 四种情形才通知。`awaiting_input` 是无人值守时 Agent 停在提问或权限请求上的状态，必须立刻通知（并带上问题内容），`timeout_minutes` 只是最后的兜底，不是主要手段。`question` 和 `options`（相当于文章里的「票拟」）放进 `task_complete` 的 summary，P0 不做结构化字段。「等后续事件」的 `waiting` 状态属于订阅直通，随 P1 引入。


### 数据模型（SeaORM 迁移，只新增表）

- `hub_source`：`id`、`name`、`key_hash`、`project`（可空，绑定后该来源只能向此项目的群发消息）、`enabled`、`created_at`、`revoked_at`。
- `hub_event`：`id`、`source_id`、`event_id`、`type`、`subject`、`summary`、`detail`、`link`、`meta`、`received_at`、`disposition`（只存路由时刻就确定的结果：P0 为 `unrouted`、`observed`、`routed`、`coalesced`；P1 增加 `delivered`、`delivery_failed`）、`coalesced_into`（可空）、`rule_name`、`work_task_id`。唯一约束 `(source_id, event_id)`。
  - **事件的处理进度不单独存**：`routed` 事件的显示状态由其 `work_task` 的状态派生，管理界面和每日汇总都读这个派生值，避免两处手动同步。映射：`todo` / `queued` / `preparing` 显示为 queued；`running` 显示为 running；`awaiting_input` 显示为 needs_decision；`review` 显示为 needs_review（等人审，按 `tell` 规则通知）；`done` 显示为 done（含 `dropped` 自动完结）；`failed` 显示为 failed；`canceled` 显示为 canceled（人取消、超时取消或 PR 被关闭，原因取自任务时间线）；`merging` 显示为 delivering：hub 任务不走引擎的本地合并，但 `deliver_pr` 交付期间任务短暂处于 `merging`。
  - 「同一 subject 是否还在跑」由创建任务时的来源键检查回答（见「任务创建」），活跃状态只在 `work_task_service::ACTIVE_STATUSES` 定义一次（含 `review` 和 `merging`），hub 不另列。Watchdog 读同一个定义。已交付的任务在 PR 合并或关闭后，由「PR 的结局回写任务」离开 review，补跑才会开始。
- `hub_subscription`：`work_task_id`、`source_id`、`subject`、`context_only`（只提供上下文，不带授权，也不唤醒已结束的任务）、`created_at`、`dropped_at`。唯一约束 `(work_task_id, source_id, subject)`。
- `hub_tell`：`source_id`、`project`（可空，空表示总览群）、`key`、`text`、`last_sent_at`、`message_id`。唯一约束 `(source_id, project, key)`。

- **保留期**：`hub_event` 默认保留 30 天，`observed` 和 `unrouted` 只保留 7 天，超期由 Watchdog 同一个定时任务清理；`hub_tell` 保留 30 天。已关联 `work_task` 的事件随任务保留。

不修改现有表。回滚方式：关掉功能开关，新表保留不删。


### 分阶段（暂缓，启动时重新排）

#### 前置（各自单独提 PR）

1. `dev-rules-fanout/SKILL.md` 去掉写死的 `/Users/xuejiao`，改为从 `.local-projects` 或环境变量解析。
2. `.local-projects` 里 sub2api、agent-skills 改为指向正式 checkout。
3. `local-deploy.sh` 增加等待 tailnet 地址的启动步骤，并以 `CODEG_HOST=<tailnet 地址>` 安装（见「监听」）。
4. `dev-rules-fanout` skill 增加单项目模式（只处理 `ask` 指定的当前项目），否则第一个场景的 skill 会按 `.registered-projects` 扫全部项目。
5. 接入 zhifu：本机已克隆到 `~/Codes/zhifu`（仓库已有 `dev-rules` submodule 和 `.cursor/rules/`）；还需要拉取 submodule，并在 dev-rules 的 `.registered-projects` 登记（`sync.sh --local`，会改动两个仓库，各自走 PR）。

#### P0：打通

- `/events`、`/tell`、`hub_event` 和 `hub_source` 和 `hub_tell` 三张表、key 管理接口和 `codeg-cli hub` 子命令、`rules.json` 与 `projects.json` 的加载和校验、并发组、`timeout_minutes`、work_task 接入 wtree.py、`dropped` 结论、`hub_event` 可交付与 PR 结局回写（见「执行」）。通知带项目名，全部发总览群（专属群建好后再做多群出站）。
- 第一条事件：**dev-rules main 变更 → 同步 zhifu**。用一个独立的小脚本（LaunchAgent 每 2 分钟跑一次，`git ls-remote` 加 `curl` 投递）检测 dev-rules 的 main 有没有变化，有变化就以 `id = <sha>` 投递事件。不用 codeg 的定时任务：它的动作是启动 Agent 会话或入队任务（`automation/engine.rs`），每次轮询都会产生一次模型调用。脚本先把最近一次已投递的 sha 写到本地文件再发，失败时用同一个 sha 重发，按 sha 天然幂等。这个场景同时验证 wtree.py（zhifu 有 submodule）。

#### P1

- **Thread 订阅直通**：`hub_subscription` 表、直通与恢复、送达与重试、`waiting` 结论。第一个有后续事件的场景（例如 PR 上的评论和 CI 结果）出现时实现。
- **多群出站**：zhifu 专属群建好时，改 Lark 发送路径，同时做来源绑定项目。
- **Watchdog**：一个定时任务，每小时检查三件事：任务有无实质进展（长时间 `running` 且没有 `progress` 汇报的标为疑似卡住）；事件有无积压（`queued` 超时）；消息有无送达。发现异常时报告，而不是自动重启。它自己只读，不修改任何状态。

#### P2

- 告警事件：`host-clean`、`clash-edge-health` 等来源投递 `alert.*` 事件。上升给人的条件参照 AIHOT：交出去 1 小时（读者受影响）或 3 小时（今天要处理）后还没恢复，或者同一个问题一天里第三次交出去，才通知人。这部分逻辑放在事件来源一侧。
- **模型判断层**：飞书群聊、issue 评论等非结构化来源，先用程序做白名单与来源筛选（确定性、不调模型），通过的候选事件再交给一个轻量模型判断是否需要行动。判断层的规则同样有 `observe` 档。
- **谁能提需求**：开放渠道增加提需求者白名单。不在名单内的消息最多作为候选，不能直接触发执行。
- **项目群内指令**：在某个项目的群里发消息，按 `chat_id` 自动归到该项目。每个项目有自己的发送者白名单（飞书 open_id）。总览群只读，不接收指令。
- 任务列表和看板页面。

### 验收（P0）

- 单元和集成测试（`cargo test --features test-utils` 加 server 模式）：
  - 鉴权：无 key、错误 key、已吊销 key 都返回 401。
  - 幂等：同一个 `(source, id)` 并发投递 10 次，只落一行、只派发一次。
  - 超长或非法字段返回 422/413，不落库。
  - 规则匹配按顺序取第一条；没有匹配的记为 `unrouted`。
  - 并发组：同一 subject 运行中又来事件时合并成一次补跑；组内上限生效。
  - 规则文件校验失败（`project` 不存在、`ask` 引用了 `summary`、`when.source` 不是已登记的来源、`name` 重名）时，继续使用旧规则，并向总览群报错。
  - `ask` 里出现 `{{summary}}` 被拒绝；事件的 `summary` 带「忽略以上指令」之类文本时，只出现在信封里，不进指令。
  - hub 任务不由引擎自动合并（`source_kind` 非空）。
  - 同一 subject 已有活跃任务时，`create_from_forge_by` 返回 `Duplicate`，事件记为 `coalesced`，不新建任务；来源名含 `:` 时创建来源被拒绝。
  - `mode: auto` 的规则缺 `acp.mode_id` 时校验失败；hub 任务的会话以规则指定的模式启动（实测，读会话的当前模式）。
  - 前端：「按本地任务交付」的判断对无来源和 `hub_event` 为真，对 `forge_issue`、`forge_pr` 为假（vitest）。
  - 交付：`hub_event` 任务经 `deliver_pr(mark_done = false)` 开 PR 到项目 `origin`，任务留在 review 并记录 PR 号；未知来源仍被拒绝。
  - PR 结局回写：PR 合并后任务变为 done，且不再 push；PR 关闭未合并时任务变为 canceled 并通知；查询失败时任务状态不变。之后同一 subject 的 `coalesced` 事件才开始补跑。
  - 任务进入 `awaiting_input` 时立刻通知，通知里带问题内容；超过 `timeout_minutes` 仍无人应答才取消。
  - 事件的显示状态由任务派生：任务进入 `review` 时事件显示 needs_review，人取消后显示 canceled，不需要单独回写。
  - 并发合并：同一 `subject` 运行中连续来 3 个事件，结束后只补跑一次，且用的是第 3 个事件的载荷；前两个事件的 `coalesced_into` 指向第 3 个。
  - Agent 报 `dropped` 且 worktree 无改动时，任务自动完结、不通知；有改动时按 review 通知。
  - 在 hub 任务的会话里直接执行 `gh pr merge` 被 `gh-pr-guard` 拦下，`auto-merge-low-risk` 对不满足条件的 PR 拒绝合并（实测，不是读配置）。
  - 带 submodule 的仓库：worktree 由 wtree 创建，分支为 `task/<id>`，base 与记录的 `base_sha` 一致，登记为任务的 `worktree_folder_id`；任务取消、删除、重试时，submodule worktree 一并移除，不留残留。
  - 任务超过 `timeout_minutes` 被取消，并向总览群报告。
  - key 管理：`create` 只显示一次 key；`revoke` 后该 key 立即返回 401；`rotate` 后旧 key 失效。
  - `/tell` 同一个 key 一小时内，内容相同的只发一次；内容不同则补发新消息。
  - （P1）订阅直通：任务存活期间，同一 `(source, subject)` 的新事件送给原任务，不新建任务、不匹配规则；任务被人停止后不再收到任何事件。
  - `mode: observe` 的规则命中后不创建任务、不通知，只留记录；改成 `auto` 后同类新事件才执行。
  - `task_complete` 的 `dropped` 结论让任务静默结束，不通知人。
  - （多群出站时）多项目：规则指向项目 A，通知只出现在 A 的群，B 的群和总览群都收不到；绑定了项目 A 的来源传 `project: B` 时仍发到 A 的群；未绑定项目的来源传注册表里没有的项目名返回 422；`projects.json` 里出现重复的 `feishu_chat` 时校验失败并保留旧文件。
  - 带 submodule 的仓库：wtree.py 创建、`session-check` 通过后才启动；`session-check` 失败时任务失败，不启动 Agent。
  - 鉴权隔离：事件 key 调用任意管理 API 返回 401；`CODEG_TOKEN` 调用 `/events` 返回 401；同一个 key 超过限流返回 429。
  - `/tell` 纯文本：请求体里带按钮、卡片或回调字段时被忽略，飞书上收到的消息标题固定为 `[项目][来源名]`。
  - （P1）订阅直通的送达：任务执行中到达的事件在当前步结束后送入且不打断；送入失败时状态为 `delivery_failed` 并按退避重试。
  - 保留期：超期的 `observed` 事件被清理，关联了任务的事件不被清理。
- 实机验证：在 dev-rules 推一个只改文档的 commit，2 分钟内看到分发 PR 开到已登记的项目，飞书收到一条通知；把同一个 sha 再投递一次，不产生第二个任务；在 GitHub 上合并这个 PR 后，任务在一个扫描间隔内变为 done。
- 监听检查：`lsof -iTCP -sTCP:LISTEN` 显示 codeg 只监听 tailnet 地址，没有 `0.0.0.0` 或 `*`；从 tailnet 之外的设备访问不通。
- P0 不新增页面，但改了现有交付入口对 hub 任务的显示，所以补一条 Playwright e2e：一个处于 review、自动交付失败的 hub 任务，详情里出现交付按钮，对话框显示项目的 `origin`。看板页面在 P2，届时再补。


### 中台的风险与回滚

- 关机或重启期间 `/events` 收不到事件。能否补回取决于来源：AIHOT 先存再发、按 `id` 重发，会补投；Forge 扫描恢复后会补扫；dev-rules 检测脚本记录了最近已投递的 sha，恢复后会补发。新来源必须遵守「先存再发、用同一个 `id` 重试」，并在接入验收里证明这一点；做不到的来源不得接入。
- 功能开关 `CODEG_HUB_ENABLED` 默认关闭。关闭后 `/events` 返回 503，已有的 Forge 自动处理和定时任务不受影响。

### 待定问题

1. **金额预算和工具白名单**：codeg 的 ACP 任务没有这类执行机制。选项：A，新增无头运行器，让中台任务走 `claude -p` 一类的无头调用，能带 `--allowedTools` 和 `--max-budget-usd`，但要写一套新的执行路径；B，中台只收事件、路由和通知，执行交给 agent-skills 里的脚本；C，留在 ACP，用 P0 的五种限制手段，只接低风险场景。**P0 按 C 推进（用户于 2026-11-02 确认）**；将来要接中高风险场景时再评估 A。
2. Forge 自动处理的规则是否并入 `rules.json`：P0 不并入，P2 再评估。
3. zhifu 专属飞书群的群 id（建群后提供）；sub2api、ai4s 何时接入。
4. 路由规则放私有仓库 `agent-hub-config`（已建）。该仓库里现有的 `projects.json` 还带着已移除的 `launcher` 字段，下一次提交配置时一并去掉。

**已核实（2026-11-03，读代码；2026-11-08 对照 main `b8483dde` 复核）**：`add_folder` 按路径幂等；取消入口是 `TaskEngine::cancel(task_id, reason)`（`work_task/engine.rs`），`merging` 状态不能取消，worktree 保留，移除是另一个调用；`engine.rs` 里 `source_kind` 的其他分支对 `hub_event` 无副作用，交付网关除外；数据库层的来源只由 `create_from_forge_by` 写入，前端的交付判断需要改（均见「执行」）；任务 worktree 的创建点是 `ensure_worktree`。

**实现前仍需核实**：
- 不指定 `mode_id` 时 ACP 会话是否落到 `bypassPermissions`（`gh-pr-guard` 对 ACP 会话生效已确认，见「现状」）。
- `mode_id` 取哪个值，以及在这个模式下无人值守的任务是否会停在等待应答。
- `wtree.py create` 同时给 `--branch` 和 `--base` 的行为，以及目录位置与 `worktree_root` 的关系。
- 引擎里所有 worktree 移除点，逐个改为认识 submodule worktree。
- `deliver_pr` 所用的 host 默认账号（`ForgeDeliveryApi::local_target`）能否 push 到 zhifu 这个私有仓库并开 PR。
- `launcher`（cc0、codex0）能否按规则作用到 ACP 启动的 Agent（`commands/acp.rs` 的 `build_runtime_env_for_agent`）。
- 飞书对同一应用多条长连接的投递规则（多群入站前）。

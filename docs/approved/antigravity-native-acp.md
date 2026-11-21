---
status: approved
approved_by: feng
approved_at: 2026-11-21
approval_source: 本会话明确指令，见下方原话
---

# 原生 Antigravity ACP 接入

用户授权原话：
> 那就直接在 Codeg 里接入原生 agy acp，补齐 TokenKey API Key、认证模式和自定义 endpoint 的配置传递，补回归测试，跑 xj-review 后单独提交 PR，盯 CI 到全绿。

采用系统安装的 `agy acp`，不再启动缓存中的 Python ACP 服务端。用户更新原生 CLI，Codeg 与终端共用同一运行时。

设置面板拥有 `AGY_AUTH_METHOD`、对应的 Key/项目配置，以及 API Key 模式的 `GOOGLE_GEMINI_BASE_URL`。Key 与 endpoint 只进入子进程环境，不落入原生 settings.json、不出现在命令行参数。切换认证方式清除不适用的变量；留空 endpoint 清除继承地址，回到官方 API。

原生 `antigravity-cli/settings.json` 只合并 `modelProvider` 和必要的 gcp 字段，保留未知字段和用户模型目录；不可安全修改则拒绝启动，不回退到另一账户。未在 Codeg 选择认证方式时不修改原生配置。握手后对显式选择发送 ACP authenticate，再创建或恢复会话。

`GEMINI_HOME` 经路径解析后以 `--gemini-dir` 传入；原生配置、会话和退出登录使用同一目录。历史同时读取原生目录与旧 `antigravity-acp` 目录，不迁移或删除旧凭据。

Google OAuth 由主机终端的 `agy acp --login` 完成，Codeg 提供可复制命令。旧 Python 回调接口保留明确的迁移错误，不启动旧服务、不接收或转发回调。退出登录仍通过原生 ACP logout，先停止该智能体的活动连接。

验收：真实原生 CLI + 本地模拟 Gemini SSE 服务验证 endpoint、占位 Key、流式回复；Rust 验证启动/配置/凭据隔离、原生及旧历史读取；组件回归与 Playwright 验证保存和模式切换；完整机械门禁、xj-review 和 PR CI。真实 Google OAuth 与 TokenKey 付费推理不作为自动化测试依赖。用户授权提交独立 PR，合并仍待用户指令。

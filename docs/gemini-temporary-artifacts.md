# Gemini 临时产物兼容

Gemini 原生 `read_file` 在构建工具调用时检查路径，早于 `BeforeTool`
和 ACP 文件读取请求。仅拦截 ACP fs 或配置 BeforeTool 无法修复 `/tmp`
图片读取失败。Codeg 在 Gemini 启动环境的 `NODE_OPTIONS` 中追加一个
`--import`，使用 Node module loader 在内存中包装原生路径校验器。
安装文件、全局 Gemini 设置和工作区白名单无需修改。

## 目录契约

- 使用原生 `Storage.getProjectTempDir()` 获取项目临时目录，支持 Gemini
  自己的数据目录迁移与命名规则，并发布 `CODEG_GEMINI_PROJECT_TEMP`。
- 每次非空 Gemini prompt 追加内部目录契约，指导模型将中间产物直接写入
  session_context 中的原生项目临时目录。共用内部帧清理器隐藏历史消息和标题中的契约。
- 原生校验拒绝的绝对路径若位于系统临时目录，则复制到原生项目临时目录后
  再运行原生校验。macOS `/tmp`、`/private/tmp` 和符号链接通过 realpath 统一处理。
- 只复制当前用户拥有、最大 16 MiB 的普通文件。不处理目录、FIFO、工作区内
  被拒绝的文件、原生项目临时目录内被拒绝的文件，以及指向临时目录外的链接。
  staging 失败时返回工具错误，保留原生权限校验。
- 每个进程独占 staging 子目录，以规范路径和内容的 SHA-256 命名，保留扩展名。
  staging 是副本，修改副本不会写回原文件。正常退出清理 staging；非正常退出
  后由原生项目临时目录保留策略处理。

## 验证与维护

要求 Node >= 20.6（`module.register` 最低版本），CI 使用 Node 22。
兼容器只转换最近 package.json 名称为 `@google/gemini-cli` 或
`@google/gemini-cli-core` 的 ESM `.js` 模块。已在官方 0.60.0 和 0.70.0
bundle 上离线验证原生 Config、Storage、ReadFileTool 的 PNG 完整读取流程。
此入口依赖上游类声明形态；升级 Gemini 时须运行原生探针，声明改名可能使转换不再命中。

```sh
node --test src-tauri/src/acp/gemini_compat/artifacts.test.mjs
cd src-tauri
cargo test --no-default-features --features server-bin --lib gemini
```

原生探针不调用模型、不需要 API key，并使用隔离的临时 home。参数为官方
core 模块文件（新版 CLI 通常为 `bundle/chunk-*.js` 中导出 Config 和
ReadFileTool 的文件）：

```sh
node --import ./src-tauri/src/acp/gemini_compat/register.mjs \
  ./src-tauri/src/acp/gemini_compat/native-probe.mjs /absolute/path/to/core.js
```

兼容器只对重新启动的 Gemini 进程生效，已运行的 CLI 需要重启。

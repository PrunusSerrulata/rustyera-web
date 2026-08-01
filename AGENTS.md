# AGENTS.md

本文件适用于仓库根目录及其所有子目录。若更深层目录存在 `AGENTS.md`，以更具体的
规则为准。

## 项目边界

本仓库实现共享的 Vue 3 前端和两种 runtime host：Tauri 2 原生主机，以及在 Web Worker
中运行的 WebAssembly bridge。Runtime、协议与 VM 位于独立的 `rustyera-core` 仓库。
浏览器与 Tauri 应共享展示、状态和交互语义，平台差异只应存在于项目 I/O、持久化、权限
和 runtime transport 边界。

所有 core Git 依赖必须固定到 `rustyera-core.rev` 记录的同一个完整 SHA。本地兄弟仓开发
由外层 Cargo patch 指向 `../rustyera-core`；不得把本地相对 path dependency 写入可发布
清单。`../eraTW` 和 core 构建产物是本地测试输入，不得提交。

## 仓库结构

- `src/`：共享 Vue/TypeScript 应用。
  - `components/`：展示、媒体、调试及应用对话框等 Vue 组件。
  - `core/`：与平台无关的协议类型、展示、日志、资源、音频和交互策略。
  - `stores/`：Pinia 状态及 runtime 消息编排。
  - `platform/`：浏览器/Tauri transport、Web Worker、项目 I/O 和 IndexedDB 适配。
  - `testing/`：浏览器端测试控制接口。
  - `App.vue`、`main.ts`、`styles.css`：应用组合、入口与全局样式。
- `crates/era-web-bridge/`：共享 Rust bridge，将公共 runtime/协议接口投影给 host。
- `crates/era-web-wasm/`：WebAssembly adapter 和浏览器 host 边界。
- `src-tauri/`：Tauri 原生入口、项目/存储命令、权限、配置和图标资源。
- `tests/`：Vitest 单元、组件和回归测试。
- `e2e/`：若存在，为 Playwright 浏览器端到端测试。
- `tools/runtime-tester/`：真实 UI/WASM 的固定流程及长流程场景测试。
- `scripts/`：WASM 构建、core revision 检查及 Web/Tauri 测试启动器。
- `package.json`、`package-lock.json`：Node 依赖和命令的权威来源。
- `Cargo.toml`、`Cargo.lock`：Rust workspace 和锁定依赖。
- `rustyera-core.rev`：所有 core Git 依赖共同绑定的 revision。

## 实现规范

- 使用 `package.json`、TypeScript、ESLint 和 Prettier 的现有配置；Node 依赖使用 `npm`，
  修改依赖时同步更新 `package-lock.json`。
- `src/core` 和共享组件不得直接依赖浏览器或 Tauri 私有 API；平台能力通过 `src/platform`
  中明确、可测试的接口注入。两种 host 必须保持相同的 runtime 消息和展示语义。
- Runtime 持有权威游戏及规范化展示状态。Pinia 和组件只投影状态、提交输入或转发不透明
  interaction token，不得根据 DOM 文本重建游戏状态。
- Runtime/WASM 工作、项目哈希和大量文件处理不得阻塞 Vue 主线程；保持 Web Worker 和
  transport 边界，正确处理启动、重连、终止、过期响应及资源释放。
- 对来自 runtime、项目文件、浏览器存储和 Tauri command 的数据进行边界校验。协议变更
  应同步更新 Rust bridge、TypeScript 类型、两种 transport、调用方和测试。
- 保持展示 revision、稳定 line ID、delta gap 重同步和按钮 capability 语义；不得以仅对
  当前 DOM 可见的虚拟化窗口替代完整规范状态。
- 项目数据留在用户授权的目录中；IndexedDB 只保存设计明确允许的全局设置和目录 handle。
  路径处理必须防止目录穿越，Tauri command 权限保持最小化。
- 应用自有对话框复用现有可访问外壳，并维持键盘、焦点和 ARIA 行为；系统文件及权限选择器
  继续由平台拥有。
- Rust 使用 workspace 既有 edition、格式和 lint 约定。实现思路、兼容性原因和非显然算法
  使用英文注释；避免无关重构、批量格式化和非必要跨层 API 变化。
- 不提交 `node_modules`、`public/wasm`、`dist`、`target`、Tauri bundle、Playwright 浏览器、
  测试结果、游戏内容或本机缓存。

## 测试要求

每个开发任务都必须包含与行为改动对应的最小测试，不能只以成功构建作为完成标准。修复
bug 时添加能稳定复现问题的回归用例；优先测试用户可观察行为、跨 host 契约和错误路径，
避免只断言实现细节。

## 重构审查要求

涉及功能开发或修改、问题修复，或本次任务新增与改动的代码合计超过 100 行时，在最终
测试验收前必须委派独立的子智能体使用 `$refactor-rustyera-code` skill 审查本次任务涉及
的全部代码文件，尤其是新增和修改的部分。该子智能体须报告是否有重构必要；如有，须
提供可执行的重构方案。审查认为有必要重构时，必须先按该方案完成重构，再进行最终测试
验收；不得以时间、预算或“改动已能工作”为由跳过。最终交付必须说明审查结论，以及在
需要时已落实的方案。

所有验证必须使用仓库 skill `$test-rustyera-web`（位于
`.agents/skills/test-rustyera-web/`）。该 skill 是浏览器/WASM、Tauri、agent 驱动流程、
Emuera 差分和结果报告的权威规范。修改浏览器场景、页面 action 或 Tauri 测试前，分别
读取其 `references/test-cli.md`、`references/page-api.md` 或
`references/tauri-e2e.md`。不得以直接修改 Pinia、mock IPC、自建 runtime 状态机或仅凭
截图代替真实客户端验证。

每条测试命令必须委派给运行 **gpt-5.6-luna high** 的子智能体。该子智能体只能执行测试
并返回各命令、退出码和相关输出，不得编辑、格式化或提交代码、fixture、文档及配置；
测试生成文件只能写入临时目录或已忽略目录。实现、格式化、测试编写、失败诊断和修复仍
由主智能体负责，不得用主智能体亲自运行测试替代测试子智能体。相关测试开始后若实现、
测试、fixture、依赖或构建输入发生变化，必须立即告知测试子智能体，要求其按需重建并
重跑所有受影响检查；旧结果一律作废。

- 先运行与改动直接相关的最小 Vitest，再按顺序运行完整前端门禁：

  ```sh
  npm test
  npm run typecheck
  npm run lint
  npm run format:check
  npm run build
  npm run build:wasm
  ```

- Rust bridge、WASM 或 Tauri Rust 改动还应运行：

  ```sh
  cargo fmt --all --check
  cargo check --workspace
  cargo clippy --workspace --all-targets -- -D warnings
  cargo test --workspace
  ```

- 浏览器 transport、Worker、项目 I/O、展示交互或 runtime-facing 改动必须覆盖生产 Vue UI
  和真实 WASM Worker 的三浏览器矩阵：`npm run test:game` 驱动 Chromium 固定场景，
  `npm run test:browser-compat` 驱动本机 Firefox 和 Safari；不得以组件 mock、Playwright 的
  Firefox/WebKit bundle、直接 test global 提交游戏输入或截图替代。命令为：

  ```sh
  npm run test:game -- run --scenario SCENARIO [--project PROJECT]
  npm run test:browser-compat -- --browser firefox
  npm run test:browser-compat -- --browser safari
  ```

- 需要 agent 探索时使用持久 `serve` 会话，逐条解析 NDJSON observation 后再执行一个输入、
  UI action、query 或 inspect。游戏输入必须通过可见 prompt，UI 行为使用 Playwright action；
  test global 只可用于生命周期配置和只读观察。
- Tauri command、权限、原生存储、native transport 或桌面 UI 改动必须使用
  `npm run test:tauri -- --project PROJECT` 驱动测试专用 Tauri binary、真实 Rust command、
  平台 WebView 和 WebdriverIO，并在断言前确认 `bridgeKind: "tauri"`。浏览器通过不代表
  Tauri 通过；mock `invoke`、Chromium、坐标点击和进程存活均不能替代原生结果。
- 优先复用已提交场景；仅为可复用行为新增场景。随机探索可以省略 `seed`，但复现前必须
  固定 `start` 事件记录的有效 seed。浏览器测试同时记录固定 clock。
- Emuera 差分中的空响应、超时、能力缺失、schema drift 或浏览器崩溃均属于基础设施失败，
  不能标记为跳过。canonical presentation text 是输出差分依据；DOM 是可见性、可访问性、
  属性、焦点和 enabled 状态的依据。出现第一处差异时停止并保留 trace。
- 修改 `rustyera-core.rev` 或 core Git 依赖时，更新 `Cargo.lock`，运行
  `npm run check:core-rev`，并验证 Rust workspace、WASM 构建及两种 host 的相关契约。若
  修改了 reference CLI，还必须执行其所属仓库规定的验证门禁。
- 只运行部分测试时，交付说明必须列出选择依据及未运行项目；不得把缺少浏览器、系统依赖
  或平台能力导致的跳过描述为通过。浏览器场景应报告命令、退出码、seed、fixed clock、
  trace 路径、DOM/状态断言和第一处差异；Tauri 应报告真实项目路径、平台/WebView 会话、
  可见操作及精确 debugger/runtime 输出。预算耗尽默认属于失败。

## 工作区与 Git 安全

- 开始和结束任务时检查仓库状态；保留用户已有修改，不覆盖、回滚或格式化无关文件。
- 不使用 `git reset --hard`、`git checkout --` 等破坏性命令。
- 完成实现与验证后运行 `git diff --check`，检查生成物未被加入，且 diff 中没有密钥、
  本机绝对路径或本地游戏数据。
- 每次开发任务完成后，必须为本次改动生成 commit message，包含简洁的标题和说明动机、
  主要改动及测试结果的正文；随后仅暂存本任务涉及的文件并创建 commit。不得暂存或提交
  用户的无关修改。

## 任务交付

最终说明应简要列出：实现的行为、测试增改、实际执行及结果、未验证内容或已知限制、
已提交的 commit 及其 commit message（标题和正文）。若任务涉及 core revision、
公共协议、WASM 或 Tauri 平台差异，应同时说明版本关系、两个 host 的验证情况和兼容性
影响。

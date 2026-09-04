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

## 蛇版兼容开发

- 使用 `feature/snake-compatibility` 分支及专用 worktree，`../rustyera-core` 必须是同组
  core worktree；开工核对分支和工作树，不修改原 master 工作区。位置、共享输入和
  构建/会话隔离要求遵循主工作区规范。
- 开工或续做前必须读取同组 core 的[改造思路](../rustyera-core/docs/snake-compatibility/SNAKE_EMUERA_MIGRATION_PLAN.md)
  和[分批次实施记录](../rustyera-core/docs/snake-compatibility/SNAKE_EMUERA_IMPLEMENTATION_LOG.md)，
  核对当前及上游批次依赖；实施前细化 Browser/Tauri 方案，收尾/暂停时把实际改动、
  验收证据、commit、未完成项和恢复入口写回对应批次，范围或依赖变化同步更新改造思路。
- 原版 profile 为 `emuera.em`，蛇版为 `emuera.skia.snake`。能力经 runtime 协商，
  Vue 只投影规范化状态；SQL、资源、pointer、测量和音频观察须维护命名空间及
  revision/epoch 边界，不能通过私有 Pinia/DOM 状态补做 core 语义或伪造能力成功。
- 构建前确认 Cargo patch 指向本组 core，target 位于本组；优先使用 `npm run cargo:local`
  与 `npm run build:wasm` 保持锁文件。本地覆盖不替代发布绑定：需要更新 core 时仍须
  同步完整 `rustyera-core.rev`、所有 Git rev 与 `Cargo.lock` 并通过既有检查。
- Browser 的 `public/wasm` 和 Tauri binary 都须在本 worktree 重建，记录实际 core SHA，
  不共享原目录的 node_modules、bundle、target 或测试输出。独立选定端口和浏览器配置，
  Tauri 的 devUrl/启动端口必须一致；原生会话与另一个 worktree 冲突时串行，不抢占会话。
- 本工作区已核验的 Chromium 可执行文件为
  `rustyera-web/.playwright-browsers/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
  （Chrome for Testing 151.0.7922.34）。`npm run test:game` 必须通过
  `--chromium-executable` 显式复用该文件，同时继续隔离 profile、端口和测试输出；路径失效
  时只在工作区根目录内重新查找，不搜索工作区外位置，也不自动下载浏览器。
- Browser/WASM 与 Tauri/原生 host 分别验收，不用一个 host 的结果代替另一个；原版
  eraTW、蛇版 TW 和两种 oracle 分开记录。动态测试仍必须等相关静态/共享 core 门禁
  通过，并遵守本仓库的真实客户端测试与每 5 秒完整快照规则。

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

用户提出多个开发/修改/修复点时，按工作区根 `AGENTS.md` 先评估规模：小项目合并实现、
重构和测试，共享一个批次；大项目各自独立实现、重构、测试及预算。无论是否合并执行，
每个功能点必须分开提交；跨组件分别提交，共用基础改动单独记录依赖。以下审查次数、
全量次数、静态门禁与 60 分钟预算均以当前批次为范围。循环迭代任务中，此范围进一步限定
为当前批次的当前轮次：各轮独立审查和计时，不能把单轮预算当成整个任务时限。未达用户
目标且未到用户时限时应继续迭代；用户要求暂停或确有阻塞时按根规则处理。有时限须预留
收尾并在截止前完成验证、分项提交或撤回本轮未完成改动，不留半成品。暂停时保留测试流程、
脚本、fixture 和必要临时材料及恢复记录，仅在用户明确表示任务完成或中止时才允许清理。

遵循工作区根 `AGENTS.md` 的并行与依赖调度规则：互不干扰的分析、开发、重构、测试尽可能
并行，依赖步骤流水线推进；共享可变资源须隔离。测试命令列表表达门禁依赖，不要求将无依赖
的检查全部串行；重构完成、最小回归通过、静态门禁通过等前置条件仍必须满足。

每个开发任务都必须包含与行为改动对应的最小测试，不能只以成功构建作为完成标准。修复
bug 时添加能稳定复现问题的回归用例；优先测试用户可观察行为、跨 host 契约和错误路径，
避免只断言实现细节。

浏览器、WebView 和原生客户端测试必须优先使用仓库既有 CLI、Playwright、WebDriver、
WebdriverIO、CDP 及平台原生自动化接口。除非待验证的必要系统界面或操作完全没有可用的
自动化接口，且已记录现有工具无法处理的具体能力缺口，否则禁止使用 Computer Use、坐标
点击、屏幕键鼠控制等需要额外授权的交互方式；仅仅因为自动化配置困难、驱动启动失败、
测试超时或申请授权更方便，不构成例外。确需例外时，只允许用该方式完成无法自动化的最小
步骤，前后断言、状态采集和其余流程仍须回到可复现的自动化工具，并在结果中报告原因、
范围及自动化证据。此限制不影响按仓库规范为 WebDriver、浏览器启动、本地服务或构建命令
申请必要的沙箱外执行授权。

浏览器、原生客户端及其他端到端动态测试，必须在当前批次获准范围内的全部静态门禁通过后
才能委派给测试子智能体或启动。静态门禁包括适用的定向单元/集成测试、类型检查、ESLint、
Prettier 检查和构建检查；用户明确限制验证范围时，只运行该范围内的项目，不得扩大全量
门禁。静态失败会使受影响的旧结果失效；修复后只重跑最小受影响静态集合，恢复全绿前不得
创建、恢复、追加轮次或指派动态测试子智能体。

同一套全量测试每个批次只能启动一次；发现问题并修复后，只重跑直接受影响的最小
测试集，不得重跑全量。所有浏览器和 Tauri 端到端测试必须每 5 秒输出一次完整快照，
快照必须枚举当前文档的全部 HTML 元素及其标签、属性、文本/值和可见性，并包含 runtime、
展示、输出和日志状态。忽略时间戳等报告元数据后，若本次内容与上次相同，必须立即判定
画面静止/测试卡死并退出。唯一例外是 Android Firefox 已在 DocumentsUI 确认目录、但
Firefox 尚未显示上传确认或向页面交付 `FileList` 的原生 provider 复制阶段；该阶段允许
黑屏和相同原生画面，但仍须每 5 秒记录最后可用完整 DOM、全部 Android UI 层级、Firefox
进程/前台状态和 RDP 标签页状态，且在进程退出、标签页消失、取消或报错时立即失败。确认框
或页面重新可观察后立即恢复普通静止判定。5 秒完整快照只能作为并行看门狗，不得用作目录
选择、授权或确认步骤之间的固定等待；这些步骤应快速轮询当前状态并在目标出现后立即继续。
每个批次的测试流程从本批次首条测试命令开始共享 60 分钟墙钟预算；该批次/轮次测试超时
立即停止其测试进程，并报告命令、用例/阶段、最后完整快照、已用时间及未验证项。

## 重构审查要求

涉及功能开发或修改、问题修复，或当前批次新增与改动的代码合计超过 100 行时，在最终
测试验收前必须委派独立的子智能体使用 `$refactor-rustyera-code` skill 审查当前批次涉及
的全部代码文件，尤其是新增和修改的部分。该子智能体须报告是否有重构必要；如有，须
提供可执行的重构方案。审查认为有必要重构时，必须先按该方案完成重构，再进行最终测试
验收；不得以时间、预算或“改动已能工作”为由跳过。最终交付必须说明审查结论，以及在
需要时已落实的方案。

每个触发上述条件的批次，重构子智能体必须且只能运行一次。它必须在该批次任何测试启动前
完成对本批次全部代码的完整审查；主智能体必须在本批次首条测试命令前解决其提出的所有重构
要求。该批次测试开始后不得为其新建、恢复、追加轮次或再次启动重构子智能体；也不得以二次
审查替代主智能体对首次审查要求的完整落实。

所有验证必须使用仓库 skill `$test-rustyera-web`（位于
`.agents/skills/test-rustyera-web/`）。该 skill 是浏览器/WASM、Tauri、agent 驱动流程、
Emuera 差分和结果报告的权威规范。修改浏览器场景、页面 action 或 Tauri 测试前，分别
读取其 `references/test-cli.md`、`references/page-api.md` 或
`references/tauri-e2e.md`。不得以直接修改 Pinia、mock IPC、自建 runtime 状态机或仅凭
截图代替真实客户端验证。

每条测试命令必须委派给运行 **gpt-5.6-terra low** 的子智能体。该子智能体只能执行测试
并返回各命令、退出码和相关输出，不得编辑、格式化或提交代码、fixture、文档及配置；
测试生成文件只能写入临时目录或已忽略目录。实现、格式化、测试编写、失败诊断和修复仍
由主智能体负责，不得用主智能体亲自运行测试替代测试子智能体。相关测试开始后若实现、
测试、fixture、依赖或构建输入发生变化，必须立即告知测试子智能体，要求其按需重建并
重跑所有受影响检查；旧结果一律作废。

- 先运行与改动直接相关的最小 Vitest，通过后运行一次完整 Vitest；其余静态门禁在输入和
  产物无冲突时可并行，全部适用静态检查通过后才能启动动态测试：

  ```sh
  npm test
  npm run typecheck
  npm run lint
  npm run format:check
  npm run build
  npm run build:wasm
  ```

  完整 Vitest 如果失败，修复后仅按测试文件、名称或最小相关集重跑受影响用例，不得
  再次执行 `npm test`。

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

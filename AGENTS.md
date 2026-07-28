# RustyEra Web development

本仓库包含 Vue 浏览器前端、Tauri 主机、WebAssembly adapter 和 `era-web-bridge`。Runtime、
协议与 VM 位于独立 [rustyera-core](https://github.com/PrunusSerrulata/rustyera) 仓库。

- 所有 core Git 依赖必须固定到 `rustyera-core.rev` 的同一个完整 SHA；修改后运行
  `npm run check:core-rev` 并更新 `Cargo.lock`。
- 本地兄弟仓开发由外层 Cargo `[patch]` 使用 `../rustyera-core`，不得把相对 core path
  写入本仓可发布清单。
- Vue/TypeScript 修改运行 Vitest、typecheck、ESLint、Prettier 和相关 E2E；Rust 修改还要
  运行 fmt、check、Clippy 和 workspace tests。
- 长流程 eraTW 测试默认使用 `../eraTW`，可由 `ERATW_PROJECT` 覆盖；不得提交游戏内容。
- `public/wasm`、`dist`、Tauri bundle、Playwright 浏览器和 node_modules 都是本地产物。

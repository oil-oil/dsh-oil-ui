# dsh-oil-ui

`dsh-oil-ui` 是 Host-only 的 DeepSeek Harness 插件，向模型注册五个 Oil UI 工具。没有 Client UI 入口；不要为了演示而增加设置页或浏览器侧 bundle。

## 版本与发布

- 插件版本只看 `package.json`，内置 Skill 版本和上游来源只看 `skills/oil-ui.manifest.json`。
- `main` 是开发分支，Release 是已发布快照，线上 Skill 版本由官方 versions API 提供；三者不能用同一个数字互相代替。
- 发布后把开发分支切到下一预发布版本。功能、整理和机械格式化分别提交，不用一个提交覆盖所有变化。
- 定时同步通过自动 PR 合入，不由 bot 直接推 `main`。发布流程见 `docs/releasing.md`。

## 目录所有权

| 路径                                            | 规则                                         |
| ----------------------------------------------- | -------------------------------------------- |
| `src/index.ts`                                  | 只装配插件、Skill Provider 和命令            |
| `src/tools/`                                    | 五个工具的参数、注册和展示，手写             |
| `src/workbench/`                                | 工作区、截图、素材与图片实现，手写           |
| `src/skill/`                                    | Skill 发现、加载、状态、转换算法与规则，手写 |
| `src/oil-api.ts`                                | oiloil 认证、请求与积分客户端，手写          |
| `scripts/`                                      | 同步、编译、打包和验证，手写                 |
| `tests/`                                        | 默认离线测试与显式集成测试，手写             |
| `docs/`、`README*.md`                           | 使用和维护文档，手写                         |
| `lib/`                                          | `pnpm build` 生成并提交，不手改              |
| `skills/oil-ui/`、`skills/oil-ui.manifest.json` | `pnpm sync:skill` 生成并提交，不手改         |
| `.work/`、`.eval/`、`node_modules/`             | 本地产物，不提交                             |

GitHub 直接安装依赖已提交的 `lib/` 和 `skills/`，不能把它们当成可以随便删除的临时文件。

## 标准命令

| 命令                                   | 用途                                                   |
| -------------------------------------- | ------------------------------------------------------ |
| `pnpm check`                           | 格式、类型、默认测试和生成物验证                       |
| `pnpm build`                           | 更新 `lib/index.js`                                    |
| `pnpm test`                            | 默认离线测试，不依赖相邻仓库或真实凭据                 |
| `pnpm test:integration`                | 显式上游集成测试，需要 `OIL_UI_SOURCE_DIR`             |
| `pnpm sync:skill`                      | 从 `OIL_UI_SOURCE_DIR` 或 `../oil-ui` 同步内置 Skill   |
| `pnpm sync:skill --check`              | 只检查上游能否重现提交快照，不覆盖文件                 |
| `pnpm compile:skill <source> <target>` | 编译指定 Skill                                         |
| `pnpm verify:generated`                | 临时重建并比较 `lib/`，核对 Skill manifest、哈希和权限 |
| `pnpm pack:plugin`                     | 构建、打包并解包验证                                   |
| `pnpm release:check`                   | 发布前完整检查                                         |

`vendor:skill` 和 `build:skill` 只是旧命令别名，新文档使用 `sync:skill` 和 `compile:skill`。

## 修改规则

- 默认先跑 `pnpm check`；修改生成逻辑后还要运行真实上游集成测试和 `pnpm pack:plugin`。
- 上游同步只接受公开 `oil-ui`。`scripts/public-skill-files.mjs` 是人工审核白名单，新增文件必须连同来源、用途和公开性一起审阅，不能自动放行 Pro 资源。
- manifest 必须记录上游仓库、完整 commit、Skill 版本和 transform 版本。非 Git 源需要显式提供 `OIL_UI_SOURCE_COMMIT`。
- 默认测试不得读取相邻仓库、真实 HOME、真实令牌或访问真实付费服务。集成测试必须显式传入目录，真实付费验证单独授权。
- Pro 专用转换数据只从本机安装包的 `adapters/dsh/` 读取，不得写入公开源码、测试、`lib/`、测试日志或 PR 说明；测试只用虚构规则。协议或 transform 版本不兼容时必须回退 Lite，编译和评审手册缓存必须同时随文档及规则变化失效。
- 不打印、复制或提交 `OIL_TOKEN` 和 `~/.config/oil/config.json` 的内容。文档只说明读取规则，不写入真实凭据。
- 工作区路径约束、Symlink 检查、输出覆盖保护和进程清理属于安全边界，重构时不能复制出一份更宽松的实现。
- 修改工具数量、命令、环境变量、目录职责或发布方式时，同步更新中英文 README、`AGENTS.md` 和相关 docs。
- 提交信息使用中文并带范围前缀，例如 `refactor(tools):`、`chore(skill):`、`docs(release):`。

# 开发指南

## 环境

- Node.js 使用 `package.json#engines.node` 声明的版本，目前是 22.19.0 或更高。
- pnpm 使用 `packageManager` 锁定的版本。
- 截图需要 Chrome / Chromium；录屏抽帧另需 FFmpeg。
- 本机 `image-gen` 是可选能力，需要 Python 3。没有它时，插件可在已登录 oiloil 的情况下使用后备生图。
- 插件目标 Harness 版本以 `package.json#engines.dsh` 为准，不在普通测试中假定其他版本兼容。

安装依赖：

```bash
pnpm install --frozen-lockfile
```

## 日常开发

```bash
pnpm test
pnpm typecheck
pnpm check
pnpm build
```

`pnpm check` 是提交前的主入口，依次检查格式、类型、默认测试和生成物。`verify:generated` 会在临时目录重建，不会因为检查而覆盖 `lib/`；需要更新提交产物时明确运行 `pnpm build`。

格式化：

```bash
pnpm format          # 修改手写源码、脚本和文档
pnpm format:check    # 只检查
```

`lib/`、`skills/`、依赖和本地产物不经过 Prettier。生成物的格式由生成器决定。

## 源码边界

- `src/index.ts` 负责插件装配，不堆工具实现。
- `src/tools/` 定义五个工具的 schema、注册和展示。
- `src/workbench/` 实现工作区与运行时能力，图片流程独立在 `workbench/image.ts`。
- `src/skill/upstream.ts` 负责发现、原文加载和实际状态；`install.ts` 固定经过核对的 oil-cli 提交。没有 Skill 转换器。
- 插件 Provider 只发布内置 Lite；Pro 发布交给 Harness filesystem。Lite 与 Pro 原文均不得改写；不得在任何作用域注册同名 Pro，详见 `docs/pro-single-publisher.md`。
- `src/oil-api.ts` 只处理 oiloil 客户端能力，不管理页面或 Skill 编译。

先保持对外工具契约，再移动内部实现。每个重构边界都应能用现有测试验证。

## 测试分层

默认测试：

```bash
pnpm test
```

默认测试不得访问真实网络、读取真实用户配置或依赖 `../oil-ui`、`../oil-ui-pro-dev`。机器上恰好存在这些目录，也不应改变默认测试结果。

显式上游集成测试：

```bash
OIL_UI_SOURCE_DIR=/path/to/oil-ui pnpm test:integration
```

此命令只读取显式提供的公开 Lite 源。可用当前 Pro 分支的 `scripts/build_lite.py --output <临时目录>` 构建候选，再在临时插件副本中以 `--allow-unreleased` 验证原文字节、白名单和 installer pin；不会把候选写入已提交的内置快照。默认测试不读相邻 Pro 仓库。所有内置版本断言从 manifest 读取，外部 Skill 测试用虚构内容。

`tests/provider-ownership.test.ts` 与状态测试覆盖实际正文、目录、入口、版本及调用权限。filesystem Lite 与内置版本不同并不构成错误覆盖。评审子 Agent 由系统提示注入实际生效 Skill 的原始手册，手册不转换、不缓存；宿主工具和资源基准路径在外围提示中说明。

显式运行真实 Harness 冒烟：

```bash
npm run smoke:dsh
```

脚本使用真实 CLI 安装包，分别启动 Host 和标准 preset Agent，覆盖内置 Lite、仅 filesystem Lite、两者并存、追加 filesystem Pro。每次核对原生 skill 返回原文、状态对应实际胜出定义、资源目录、五个工具及 manifest 版本；Pro 只有 filesystem 一个发布者。仅 filesystem 场景通过正式配置 `bundledSkill: false` 关闭插件的 Lite 发布，工具继续注册。全部使用隔离 HOME/DSH/XDG，外部 Skill 是虚构内容，不提交模型任务、不调用付费服务，退出清理。

本地模拟定时同步 workflow：

```bash
npm run test:sync-workflow
```

脚本在临时副本中创建虚构的公开 `999.0.0` tag，执行 workflow 的同步、复核、pin 检查、check 和 pack 验证块，再确认正文没改、差异仅为生成物。GitHub 查询已发布 Release 和创建 PR 的步骤不执行。此模拟不修改正式内置快照，也不推送。

安装依赖可能访问 npm registry，但 Host 阶段禁止外部请求。系统 pnpm/Corepack 不可用时，可用 `DSH_SMOKE_PNPM=/absolute/path/to/pnpm npm run smoke:dsh` 指定 pnpm；未指定时脚本准备临时独立 pnpm，不改系统安装或真实用户配置。详细断言和受测 DSH 版本由脚本输出。

真实 oiloil 生图会产生积分消耗，不属于上述任何默认或集成测试。需要验证时必须单独授权，不能用 mock 结果冒充真实 API 已验证。

## Skill 同步

从 Git checkout 同步：

```bash
OIL_UI_SOURCE_DIR=/path/to/oil-ui pnpm sync:skill
```

只检查、不写正式文件：

```bash
OIL_UI_SOURCE_DIR=/path/to/oil-ui pnpm sync:skill --check
```

同步脚本检查公开文件白名单、Pro 资源、Symlink 和 manifest，所有文件逐字节复制，保留权限。默认源必须为已发布公开版本的 tag；不要在 Pro 同步流程中调用插件同步器。`OIL_UI_REPO` 仅作为弃用别名保留，新脚本和文档统一使用 `OIL_UI_SOURCE_DIR`。

## 打包

```bash
pnpm pack:plugin
```

默认生成 `.work/dsh-oil-ui-<version>.tgz`。本地测试安装时可指定一个稳定路径，避免文档写死版本：

```bash
pnpm pack:plugin .work/dsh-oil-ui.tgz
dsh plugin --profile web add ./.work/dsh-oil-ui.tgz
```

打包脚本会重新构建、恢复 Skill 文件权限、解包复核并检查 AppleDouble 文件。生成的 `.tgz` 留在本地产物目录，不提交。

公开源归档需解压在任何 Git 仓库之外，再显式提供 `OIL_UI_SOURCE_COMMIT` 与 `OIL_UI_SOURCE_RELEASE`。Git 子目录不能靠归档环境变量绕过自身发布 tag 校验；候选构建仅在隔离副本使用 `--allow-unreleased`。

已人工核对 Pro 的公开 copy 清单：`lite/README.ja.md` 生成的 `README.ja.md` 是日文仓库介绍，未被 Skill 入口或运行时参考链接；和 README 展示图片、重复英文 README 一样显式排除。未知新增文件仍必须失败，不能自动扩展白名单。

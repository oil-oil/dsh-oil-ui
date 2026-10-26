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
- `src/skill/transform.ts` 负责转换算法，`src/skill/rules.ts` 负责上游文案转换规则，`src/skill/upstream.ts` 负责发现、加载和状态。
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

需要检查 Pro 转换时再设置 `OIL_UI_PRO_DIR`。上游集成测试会验证公开上游能否重现当前内置 Skill，因此上游 commit 与 manifest 不一致时应当失败，而不是自动选择另一份本地副本。

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

同步脚本会检查公开文件白名单、Pro 资源、Symlink、转换规则和 manifest。`OIL_UI_REPO` 仅作为弃用别名保留，新脚本和文档统一使用 `OIL_UI_SOURCE_DIR`。

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

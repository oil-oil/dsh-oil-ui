# 发布流程

发布以 GitHub Release 和 tarball 为准，不发布 npm 包，也不把 `main` 直接当成已经发布。

## 发布前

1. 确认所有功能、Skill 同步和整理 PR 已分别合入，CI 通过。
2. 在发布 PR 中把 `package.json#version` 从预发布版本改成正式版本，例如 `0.4.1-dev.0` 改为 `0.4.1`。
3. 确认 `skills/oil-ui.manifest.json` 包含目标 Skill 版本、上游仓库和完整 commit。
4. 运行：

```bash
pnpm install --frozen-lockfile
npm run release:check
OIL_UI_SOURCE_DIR=../oil-ui npm run test:integration
npm run smoke:dsh
DSH_SMOKE_PROFILE=headless npm run smoke:dsh
```

`release:check` 会执行完整检查、生成并解包验证 tarball，再核对发布元数据。打包测试会实际加载解包后的 Lite，调用 `oil_ui_skill_status`、`oil_ui_explorer` 和 `oil_ui_shoot` 的离线解析，防止源码目录与安装目录不同造成运行时路径失效。发布后还要下载正式附件，核对安装和实际加载。需要模拟 tag 校验时运行：

```bash
node scripts/release-check.mjs --tag vX.Y.Z
```

其中 `vX.Y.Z` 必须与 `package.json#version` 完全一致。

## 创建 Release

发布 PR 合入后，由维护者创建并推送 `vX.Y.Z` Tag。Tag workflow 会：

- 再跑一次 `release:check`；
- 生成包含插件版本、内置 Skill 版本、原文分发标记和上游 commit 的 Release 说明；
- 上传经过解包验证的 `.tgz`。

GitHub 分支保护应要求 PR 和 CI 通过。定时 Skill 同步也只创建自动 PR，不直接推 `main`。

## 发布后

- 核对 Release 的 tarball 能安装，GitHub 直接安装所需的 `lib/` 和 `skills/` 已随对应提交发布。
- 可复现安装使用 Release commit，不长期使用移动的分支名。
- 开发分支进入下一预发布版本，避免继续用刚发布的正式版本号提交不同内容。
- 发布后问题用新的修复 PR 处理，不移动已经发布的 Tag，也不覆盖原 Release 资产。

## 发布边界

普通整理和 CI 运行不创建 Tag、Release 或线上更新。真实 oiloil 生图需要单独授权，不是发布检查的隐含步骤。若目标 Harness 版本、实际安装或真实模型执行尚未验证，应在发布说明中明确写出，不能只凭单元测试宣称全部运行时场景已覆盖。

所有 Skill 正文均原样使用；Pro 由 Harness filesystem Provider 唯一发布，插件不发布同名 Pro。状态以标准 preset Agent 实际拿到的正文、资源目录、入口路径、版本与调用权限为准。不得仅凭全局注册表、发现路径或 Provider 标签宣称可用。`npm run smoke:dsh` 是每次发版前的必跑步骤，覆盖内置 Lite、仅 filesystem Lite、两者并存、追加虚构 Pro，使用真实 DSH，不需要真实 Pro、凭据或付费调用；详见 [测试分层](development.md#测试分层)。离线 `check` 和 `pack:plugin` 不能代替它。

## 和 Pro 配对发版

Pro 或公开 `oil-ui` 有改动、插件也要跟着发时：

1. 先按 Pro 仓库的流程配对发布 Pro 和公开 `oil-ui`。插件只从已发布的公开 `../oil-ui` 同步，不从 Pro 源目录或未发布的构建同步。
2. 在插件仓库运行：

   ```bash
   # ../oil-ui 必须 checkout 到已发布公开版的 tag
   OIL_UI_SOURCE_DIR=../oil-ui npm run sync:skill
   node scripts/check-public-pin.mjs ../oil-ui
   npm run build
   npm run release:check
   OIL_UI_SOURCE_DIR=../oil-ui npm run test:integration
   npm run smoke:dsh
   ```

3. 核对 manifest 的上游仓库、完整 commit 和 Skill 版本，再提发布 PR、合入后打 Tag。
4. 已发布的插件版本号不再复用；同步晚于某次插件发布时，用新的插件版本。

Pro 仓库的 `adapters/dsh/` 只为已发布的旧插件（0.4.9 及更早）保留，本插件不读取；上游计划在 `0.35.0` 移除，达到该版本仍保留目录时检查会失败。

本次虚构 Pro 冒烟只验证原文发布、作用域、工具和状态契约，不代表真实模型已经执行设计或付费生图。

## 当前快照与后续同步

插件已发布 `0.4.12`（修复了 `0.4.11` 的 `agents` 注入错误），当前开发版为 `0.4.13-dev.0`；内置公开 Skill 为 `0.33.2`（`v0.33.2` / `16b30579489155ed4fae723c4d031e9f4d3c36df`）。实际来源始终以 manifest 为准。

公开新版发布后：从其 tag 同步，核对 source.release/commit、原文哈希与公开 installer pin，运行 build、check、pack、integration、smoke:dsh、smoke:install、test:sync-workflow 和 release:check，再把插件版本改为新的正式版并由维护者发布。不得从未发布 Pro 构建同步正式快照；`--allow-unreleased` 仅用于隔离验证，其 manifest 禁止发布。

定时 sync-skill workflow 只查询最新已发布公开 Release，检出其 tag，验证 pin 后创建同步 PR。本地用 `npm run test:sync-workflow` 模拟虚构升级，不调用 GitHub 写操作。

## 安装回归

发布前同时执行 web 与 headless 冒烟；使用与目标 DSH 相容的 Node（0.2.2-rc.1 要求 >=24.9.0）。至少在最低支持版和当前 latest 上确认加载日志无插件错误、系统提示生效、原生工具及其他插件保留，再检查状态、Lite/虚构 Pro 和卸载恢复。Desktop 需额外使用其自带 Node/DSH/pnpm 与 Desktop patch；普通 CLI 冒烟不能宣称验证了 Electron 设置页。Corepack 故障应通过 npm 临时提供固定 pnpm 复测，不要求用户改全局安装。此次实测范围与尚未覆盖项见 [安装验证报告](real-install-verification.md)。

### 跨平台真实安装 CI

`ci.yml` 的真实安装 job 独立于依赖版本的单元测试矩阵：Ubuntu / Windows，Node 24 + DSH 0.2.2-rc.1、Node 22 + DSH 0.2.1-rc.5，分别跑 web/headless。只用 npm 临时安装固定 pnpm 10.16.1 与指定 DSH 到隔离 prefix，以 README 的 tgz 安装路径启动真实 Host，不要求系统预装 pnpm。CI 结果需在实际提交推送后核对；本地 macOS 成功不能替代它。触发范围沿用 main 的 push、面向 main 的 PR 和手动 workflow_dispatch；仅推送功能分支时，在 Actions 手动选择该分支运行 `ci`，或由维护者后续创建 PR。

```bash
# 在相应 Node 下运行；默认最新受测版本
npm run smoke:install
npm run smoke:install -- --dsh-version 0.2.1-rc.5
# PowerShell 的 headless 选择：$env:DSH_SMOKE_PROFILE='headless'
```

自检下载或安装失败必须返回非零，保留原始错误并给出检查 Node、网络、profile、pnpm 的提示；不得忽略加载错误使 CI 变绿。不带凭据、不访问付费服务。发布前确认真实安装 job 全部通过，且包含当前修复的正式附件、GitHub main / Release commit 和 AtomGit 镜像能够实际加载。镜像自动同步是异步的，核对 main 的 commit，不能仅凭“已启用”认定追平。补充证据见 [本轮验证](real-install-followup.md)。

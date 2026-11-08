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

## 本次架构调整的交付顺序

当前代码保留插件 `0.4.11-dev.0`，建议正式发布 `0.4.11`；Pro/公开版建议下一补丁 `0.33.2`。先验收 Pro 改动并按其流程完成同一发布提交的 Linux 和 Windows 完整 CI，再配对发布 Pro 与公开版。Pro 的 `sync_all.py` 不触碰插件。

本次仅将已发布公开 `0.33.1` 恢复为原始字节，仍记录 commit `98187634fc45c934d36f71d050e8773d6bdea83b`。它的更新脚本保留历史 oil-cli pin，插件代码和 Pro 候选统一为 `e6ee580c01e854919ee50ef1f3de6876c3c52c18`。不能为消除差异改写已发布 Skill。`release:check` 的 pin 检查会在这里阻塞，直到新公开版发布后重新同步；默认离线 check 不把历史快照误当成新公开版。

公开新版发布后：从其 tag 同步，核对 source.release/commit、原文哈希与相同 pin，运行 build、check、pack、integration、smoke:dsh、test:sync-workflow 和 release:check，再把插件版本改为正式版并由维护者发布。若在此之前已发布 `0.4.11`，后续同步须使用新版本。不得从未发布 Pro 构建同步正式快照；`--allow-unreleased` 仅用于隔离验证，其 manifest 禁止发布。

定时 sync-skill workflow 只查询最新已发布公开 Release，检出其 tag，验证 pin 后创建同步 PR。本地用 `npm run test:sync-workflow` 模拟虚构升级，不调用 GitHub 写操作。

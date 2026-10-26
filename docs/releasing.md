# 发布流程

发布以 GitHub Release 和 tarball 为准，不发布 npm 包，也不把 `main` 直接当成已经发布。

## 发布前

1. 确认所有功能、Skill 同步和整理 PR 已分别合入，CI 通过。
2. 在发布 PR 中把 `package.json#version` 从预发布版本改成正式版本，例如 `0.4.1-dev.0` 改为 `0.4.1`。
3. 确认 `skills/oil-ui.manifest.json` 包含目标 Skill 版本、上游仓库和完整 commit。
4. 运行：

```bash
pnpm install --frozen-lockfile
pnpm release:check
```

`release:check` 会执行完整检查、生成并解包验证 tarball，再核对发布元数据。需要模拟 tag 校验时运行：

```bash
node scripts/release-check.mjs --tag vX.Y.Z
```

其中 `vX.Y.Z` 必须与 `package.json#version` 完全一致。

## 创建 Release

发布 PR 合入后，由维护者创建并推送 `vX.Y.Z` Tag。Tag workflow 会：

- 再跑一次 `release:check`；
- 生成包含插件版本、内置 Skill 版本、transform 版本和上游 commit 的 Release 说明；
- 上传经过解包验证的 `.tgz`。

GitHub 分支保护应要求 PR 和 CI 通过。定时 Skill 同步也只创建自动 PR，不直接推 `main`。

## 发布后

- 核对 Release 的 tarball 能安装，GitHub 直接安装所需的 `lib/` 和 `skills/` 已随对应提交发布。
- 可复现安装使用 Release commit，不长期使用移动的分支名。
- 开发分支进入下一预发布版本，避免继续用刚发布的正式版本号提交不同内容。
- 发布后问题用新的修复 PR 处理，不移动已经发布的 Tag，也不覆盖原 Release 资产。

## 发布边界

普通整理和 CI 运行不创建 Tag、Release 或线上更新。真实 oiloil 生图需要单独授权，不是发布检查的隐含步骤。若目标 Harness 版本、实际安装或真实模型执行尚未验证，应在发布说明中明确写出，不能只凭单元测试宣称全部运行时场景已覆盖。

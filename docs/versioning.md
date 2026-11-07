# 版本与来源

这个仓库同时出现插件、内置 Skill 和线上 Skill 三种版本。它们有关联，但不是同一个发布对象。

| 信息                | 唯一来源                                           | 说明                                |
| ------------------- | -------------------------------------------------- | ----------------------------------- |
| 插件开发版本        | `package.json#version`                             | 决定 tgz 名称和 Release tag         |
| 内置 Skill 版本     | `skills/oil-ui.manifest.json#version`              | 当前随插件提交的公开 `oil-ui`       |
| 内置 Skill 来源     | manifest 的 `source.repository` 与 `source.commit` | 必须能追溯到完整上游 commit         |
| 转换规则版本        | manifest 的 `transformVersion`                     | 与 `src/skill/transform.ts` 一致    |
| 正式插件发布        | GitHub Tag / Release                               | 已验证的不可变快照                  |
| 线上 Skill 最新版本 | `https://ui.oiloil.org/api/store/versions`         | 外部服务当前提供普通版与 Pro 的版本 |

## main 与 Release

- `main` 保存已合并、准备继续开发的内容，不自动等于最新 Release。
- Release 发布后，开发分支进入下一预发布版本。例如准备 `0.4.1` 时使用 `0.4.1-dev.0`，发布前再把版本写成 `0.4.1`。
- 不在正式版本号后面持续叠加不同内容。只是同步 Skill 的提交，也仍属于新的开发快照。
- Skill 同步本身不自动改变插件版本；发布时根据实际对用户的影响确定插件 SemVer。
- 不为了与 Skill 数字一致而强行调整插件版本。

## Skill 同步来源

正常同步使用 Git checkout，脚本直接读取其 `HEAD`。使用源码压缩包时，必须额外设置完整 `OIL_UI_SOURCE_COMMIT`，否则不能生成可发布快照。

每次同步同时更新：

- `skills/oil-ui/`；
- `skills/oil-ui.manifest.json`；
- 受影响时需要更新的 `lib/index.js`。

`pnpm verify:generated` 会检查当前 manifest 的 transform 版本、上游 commit、全部文件哈希和权限。`pnpm sync:skill --check` 进一步确认指定上游能重现这些内容。

## 可复现安装

仓库提交预构建的 `lib/` 和内置 Skill，因此用户可以直接通过 GitHub 安装，不需要授权安装期构建。需要固定环境时使用完整 commit：

```text
github:oil-oil/dsh-oil-ui#<full-commit-sha>
```

分支名和版本号都不能代替 commit 提供同样的可复现性。

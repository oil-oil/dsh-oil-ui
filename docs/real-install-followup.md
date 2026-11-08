# 安装验证补充：2026-11-08

本轮继续在 `fix/real-install-verification` 修复安装路径并补自动化，不推送、不发版。历史调查和公开旧包的根因见 [首轮报告](real-install-verification.md)。下面把本地已跑的结果与推送后才能看到的 CI 结果分开记录。

## 改动

- 新增 `npm run smoke:install`：npm 在临时 prefix 安装指定 DSH 和固定 pnpm 10.16.1，然后打包当前 checkout，通过真实 `dsh plugin --profile <profile> add <tgz>` 安装并启动 Host。
- Windows 不直接 spawn `.cmd`；从 DSH/pnpm 包的 manifest 定位 JavaScript bin，使用当前 Node 启动。构建入口也复用该处理，路径作为独立 argv 传入。
- 真实安装 CI 覆盖 Ubuntu/Windows、Node24+DSH0.2.2-rc.1 与 Node22+DSH0.2.1-rc.5，web/headless 两种 profile。默认离线测试不下载运行时；显式冒烟才联网。
- 隔离 HOME、DSH_HOME、agents/XDG、npm 配置/缓存/prefix；只使用虚构的外部 Lite/Pro。Host 不运行模型，不读取凭据，不调用付费服务。四场景检查原文、实际来源、五工具、状态、系统提示、插件加载错误及原生 read。
- 失败返回非零，报告阶段和原始错误；README 中英版增加 Node、pnpm/Corepack、错误 profile、版本跳过、旧锁文件、缺资源、长路径和网络故障的排查步骤。
- 发布文档纠正已完成的历史 Skill/pin 阻塞，要求新真实安装 CI 通过后再发布。

## 本地验证

验证机器为 macOS arm64。独立临时前缀安装 DSH 0.2.1-rc.3、0.2.1-rc.5、0.2.2-rc.1，旧版运行于 Node22.19.0，latest 运行于临时 Node24；不改变全局安装。

| 命令 / 范围                                                          | 实跑结果                                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm run check`                                                      | 通过：9 文件、111/111；格式、类型与生成物一致性通过                                                      |
| `npm run pack:plugin -- <隔离输出>/plugin-delivery.tgz`              | 通过：46 个 Skill 资源，72 归档条目；build 后 lib 无差异                                                 |
| `OIL_UI_SOURCE_DIR=../oil-ui npm run test:integration`               | 通过：1/1，只读显式公开源                                                                                |
| `npm run smoke:dsh` + `DSH_SMOKE_PROFILE=headless npm run smoke:dsh` | 三个独立 DSH 各两次，合计 6 次 × 4 场景 = 24/24                                                          |
| Node24.22.2：`npm run smoke:install`                                 | 通过：全新 DSH0.2.2-rc.1/pnpm 下载、tgz 安装和 4/4；约478秒                                              |
| Node22.19.0：`npm run smoke:install -- --dsh-version 0.2.1-rc.5`     | 通过：全新 DSH0.2.1-rc.5/pnpm 下载、tgz 安装和 4/4；约795秒                                              |
| Node22.19.0：`npm run smoke:install`（故意不相容）                   | 正确拒绝，退出1，明确 DSH 0.2.2-rc.1 需要 Node >=24.9.0                                                  |
| 无 pnpm / 故障 Corepack × 三个 DSH                                   | 六种环境复现失败，再用 README 的 npm 临时 pnpm 命令修复并验证 Host，6/6                                  |
| 六种来源 × 三版 DSH × web/headless                                   | 36/36 完成安装、加载检查、虚构 Pro、已有插件保留与卸载恢复；公开旧包的30个加载失败场景均由本地修复包恢复 |

完整矩阵来源沿用首轮报告：GitHub shortcut、AtomGit Git URL、完整 Release commit、正式0.4.11附件、全新公开main源码打包、本分支tgz。前五种旧来源仍报 `Error: cannot get property "agents" without inject`；这是未发布修复的预期复现，不算旧包“通过”。本分支包六场景直接通过。每种来源的三版本/两profile都实际执行 `dsh plugin --profile <P> add <source>`，启动公开 `runProfile` 检查，之后 `dsh plugin --profile <P> remove dsh-oil-ui`；卸载后的 composed config 与安装前逐字一致，原生 read 与虚构已有插件工具保留。

六次常规冒烟的 PATH 明确选择临时 `dsh-<version>/bin`，旧版配 Node22、latest 配 Node24；pnpm 指定临时 npm 包真实 JS 入口。`smoke:install` 两次则从没有预装 pnpm 的受控 PATH 自行下载运行时；不是复用全局 DSH。

冷安装并不快：初始三个隔离前缀耗时约501、1005、502秒，rc.5 为约17分钟；因此显式 bootstrap 预算为20分钟，CI job45分钟。初始 latest 前缀曾在 Node22 npm 下安装并产生 EBADENGINE 警告，随后运行于Node24；新的 `smoke:install` latest 从安装到 Host 全程使用Node24，并在下载前校验最低版本，不把不相容Node当正式支持。一次开发调度在rc.5冷安装未完成时提前启动了后续命令，脚本正确报告找不到CLI；等安装完成后重跑两项环境和web/headless均通过。它是测试调度错误，未冒称插件缺陷。

命令参数、脱敏日志、矩阵结果和审计脚本保留在本机忽略目录 `.work/real-install-followup/`。

公开正式附件的普通下载地址本轮连续返回：

```text
curl: (56) The requested URL returned error: 504
```

通过无认证的 GitHub 公开 API `GET /repos/oil-oil/dsh-oil-ui/releases/assets/722805787`，发送 `Accept: application/octet-stream` 下载成功。SHA-256 为 `33f1ec917d83bf239994bd4fc84f81bafd47dc497bac0f1c4e44748a5a422a34`，与 Release 公布值一致。没有把本地重打包冒充正式附件；网络失败也没有算作插件加载错误。

第一次开发中 `npm run check` 仅因新增文件尚未格式化而退出 1；按仓库 Prettier 格式化后重新执行。最终检查另列，不以开发中的失败作为交付结果。

## AtomGit

在已登录浏览器中打开本仓库的「项目设置 → 仓库镜像 → Pull」。`启用` 原本已经勾选，上游地址为 `https://github.com/oil-oil/dsh-oil-ui.git`；`覆盖分叉分支（pull-f）` 也原本启用，本轮没有改变该设置。点击「立即同步」并确认后，页面先显示「同步中…」，随后「更新于刚刚」。没有出现密码、令牌或 API Key 输入框，也没有读取或创建凭据。

同步后镜像代码页的 main 为 `da19b86de7e7431cb6b9743f10790e1146dad9e2`，与 GitHub main 相同；`git ls-remote` 对两个公开地址返回同一提交。此前镜像停在 `da8e659`。本地分支改动没有推送，当然也还没有同步到镜像。

页面证据留在本机忽略目录 `.work/real-install-followup/atomgit-mirror-enabled.png` 和 `atomgit-main-synced.png`。自动 Pull 的未来调度频率没有通过等待下一轮来验证；本轮证明的是开关已启用、人工同步完成且 main 追平。

## 仍然不能承诺百分之百

Ubuntu/Windows 的 job 已加入，但本轮禁止推送，因此云端结果待维护者推送后核对。工作流沿用 main push / 面向 main 的 PR / 手动触发；只推送此功能分支时，还需在 Actions 手动选择该分支运行 `ci`（或维护者后续创建 PR）。任意网络、未来 DSH 预发布、任意第三方插件组合、Electron 设置页完整交互、所有私有 Pro 历史版及付费生图仍不能由上述测试证明。已发布 0.4.11 和公开 main 尚不含本分支修复；需要先验收与发布新版本，再核对正式附件、GitHub 和镜像。

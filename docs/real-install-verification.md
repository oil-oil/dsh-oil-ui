# 真实安装验证：2026-11-08

后续的跨平台安装 CI、Windows 启动入口、排错文档、重跑结果和 AtomGit 同步见 [补充记录](real-install-followup.md)。本页保留首轮证据。

结论：不能对用户承诺“百分之百可用”。本轮确实找到并修复了插件加载错误，也复现了安装器和版本来源问题。修复尚在 `fix/real-install-verification`，没有推送或发布；公开安装命令不会自动得到本地修复。

## 发现与修复

### 插件漏声明 Cordis 服务依赖

三个 CLI 版本、web/headless，以及 Desktop 自带运行时，都复现了：

```text
Error: cannot get property "agents" without inject
```

`src/index.ts` 的系统提示 callback 只注入 `systemPrompt`，却读取 `ctx.agents?.list()`。Cordis 的服务 getter 会在可选链判断前抛错。原构建调用点是 `lib/index.js:3021`，注入入口是 `:3009`。修复为同时注入 `systemPrompt`、`agents`，并重新 build。

这不是“DSH 进程必定崩溃”的证据：实测有错误时 Host 仍能监听，部分工具甚至真实设计任务也能完成。它是插件加载不完整、过去冒烟误判正常的直接证据。

回归现在模拟严格的注入边界；旧实现会失败。真实冒烟同时检查 Cordis 的插件错误、Oil UI 系统提示、五个 Oil UI 工具、原生 read/write/edit/bash/skill，并实际读取临时文件。不能再以“HTTP 存活”或“工具已注册”代替无错误加载。

### pnpm 缺失与 Corepack 故障

三个 DSH 版本均在没有 pnpm 的 PATH 下失败，退出 127：

```text
dsh: pnpm was not found; install pnpm and make it available on PATH.
```

三个版本均在全新 Corepack 缓存下选中 pnpm 12.18.0，然后退出 1：

```text
Error: Cannot find module '<临时 COREPACK_HOME>/v1/pnpm/12.18.0/bin/pnpm.cjs'
code: 'MODULE_NOT_FOUND'
```

错误中的临时目录前缀在这里省略；验收附件保留完整错误。此时插件尚未加载。DSH 随后打印的 Git `prepare` / `allowBuilds` 提示是泛化建议，与本次原因不符；本插件没有安装期构建脚本。

相同六个失败环境随后执行以下命令，均安装成功，并通过 Host/Agent/状态检查：

```bash
npm exec --yes --package=pnpm@10.16.1 -- dsh plugin --profile web add /path/to/plugin-after.tgz
```

README 中的安装、源码打包命令因此改为通过 npm 临时提供固定 pnpm，不要求改全局 Corepack 或全局安装 pnpm。

最终在更深的临时目录复跑时，还暴露 pnpm 的本地 tarball 路径限制：

```text
ERR_PNPM_ENAMETOOLONG Failed to add tarball ... ENAMETOOLONG: name too long, rename
```

macOS 的 `/var` 与 `/private/var` 混用，使 pnpm 将本可很短的相对路径展开成含大量父目录和完整路径的单个 store 文件名。冒烟现在创建目录后立刻 realpath，统一所有隔离路径的拼写，再用相同深目录复跑。没有修改 pnpm 或 DSH 源码；这也不等于承诺任意包管理器和任意长度路径都可安装。

### Node 与安装来源

- npm `latest` 实查为 DSH `0.2.2-rc.1`；它自己的 `engines.node` 是 `>=24.9.0`。旧 README 的 Node 22 前提不完整，已按 DSH 版本说明。额外的 Node 22 + latest Host 测试虽然通过，也不将上游明确不支持的组合列为正式支持。
- GitHub main：`da19b86de7e7431cb6b9743f10790e1146dad9e2`，插件 `0.4.12-dev.0`。
- AtomGit main：`da8e659c7548fac7ea9971c1c96d9ecdc6d0fdd2`，插件 `0.4.11-dev.0`。镜像当时落后，不能声称两个源必定等价。
- 完整提交 `362053dcfb169eb133abbb6ade1a1ca198439fe2` 和正式附件都为 `0.4.11`。正式附件 SHA-256 为 `33f1ec917d83bf239994bd4fc84f81bafd47dc497bac0f1c4e44748a5a422a34`。

## 实际命令与安装矩阵

机器为 macOS arm64。每个安装场景有独立 HOME、DSH_HOME、DSH_AGENTS_HOME、XDG、npm 配置/缓存、Corepack 缓存及工作目录。PATH 明确选择临时 Node/pnpm/DSH，不改变全局安装。Git 全局配置隔离；环境白名单不传入用户令牌。

运行时准备命令：

```bash
npm view @deepseek-ai/dsh dist-tags --json
npm install -g --prefix "$AUDIT/dsh-0.2.1-rc.3" @deepseek-ai/dsh@0.2.1-rc.3 --no-audit --no-fund
npm install -g --prefix "$AUDIT/dsh-0.2.1-rc.5" @deepseek-ai/dsh@0.2.1-rc.5 --no-audit --no-fund
npm install -g --prefix "$AUDIT/dsh-0.2.2-rc.1" @deepseek-ai/dsh@0.2.2-rc.1 --no-audit --no-fund
npm install --prefix "$AUDIT/node24" node@24 --no-audit --no-fund
npm install --prefix "$AUDIT/pnpm10" pnpm@10.16.1 --no-audit --no-fund
```

Node 22 是现有 `22.19.0` 二进制的只读引用；临时 Node 24 实际解析为 `24.22.2`。首次 npm 冷安装被审计脚本的四分钟预算中断；延长预算、复用临时下载缓存后，三个独立前缀全部安装成功。重试耗时分别约 740、292、430 秒，不能把审计超时算作插件加载失败。

中英 README 的相同命令去重后，以下六个来源全部实装；每个来源各跑三个 DSH × 两个 profile，共 36 个独立场景。`P` 分别为 `web`、`headless`，`dsh` 指向对应临时前缀；安装器为独立 pnpm 10.16.1。

| 来源              | 实际安装命令主体                                                                                   | 安装修复前来源的结果               | 替换本地修复包后 |
| ----------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------- |
| GitHub shortcut   | `dsh plugin --profile "$P" add github:oil-oil/dsh-oil-ui`                                          | 安装 0；加载报 agents 错误         | 六场景通过       |
| AtomGit           | `dsh plugin --profile "$P" add git+https://atomgit.com/oil-oil/dsh-oil-ui.git`                     | 安装 0；加载报同一错误，且版本落后 | 六场景通过       |
| README 完整 pin   | `dsh plugin --profile "$P" add github:oil-oil/dsh-oil-ui#362053dcfb169eb133abbb6ade1a1ca198439fe2` | 安装 0；加载报同一错误             | 六场景通过       |
| 正式 Release 附件 | `dsh plugin --profile "$P" add "$AUDIT/release-0.4.11.tgz"`                                        | 安装 0；加载报同一错误             | 六场景通过       |
| 全新源码打包      | `dsh plugin --profile "$P" add "$AUDIT/source-built.tgz"`                                          | 安装 0；加载报同一错误             | 六场景通过       |
| 本分支修复包      | `dsh plugin --profile "$P" add "$AUDIT/plugin-after.tgz"`                                          | 安装与加载均正常                   | 六场景直接通过   |

三个 DSH 的主矩阵组合分别为 `0.2.1-rc.3/Node22`、`0.2.1-rc.5/Node22`、`0.2.2-rc.1/Node24`。30 个公开旧来源场景均复现同一加载错误；替换修复包后，36/36 完成以下完整序列：

1. 先安装一个虚构但合法的已有插件，其工具返回固定哨兵。
2. `dsh --profile "$P" --dump-config`；启动基础组合，调用原生 read 与已有插件工具。
3. 执行表中安装命令和 `dsh --profile "$P" --help`。
4. 用公开 `runProfile` 启动：web 挂标准 preset；headless 保留自己的启动/沙箱组合，只用临时 patch 禁用模型 runner，不塞入 web preset。
5. 核对插件加载错误为零、五工具、`oil_ui_skill_status`、Lite 原文/目录/版本；再放入虚构原文 Pro，核对 filesystem 唯一发布者和 ready。
6. `dsh plugin --profile "$P" remove dsh-oil-ui`，再次启动、读取文件、调用已有插件工具；卸载后的 composed config 与安装前逐字一致。

源码打包与附件下载也实际执行：

```bash
git clone --depth 1 https://github.com/oil-oil/dsh-oil-ui.git "$AUDIT/github-source"
git clone --depth 1 https://atomgit.com/oil-oil/dsh-oil-ui.git "$AUDIT/atomgit-source"
# 在全新 github-source 中：
pnpm install --frozen-lockfile
pnpm pack:plugin "$AUDIT/source-built.tgz"
curl --fail --location --silent --show-error \
  https://github.com/oil-oil/dsh-oil-ui/releases/download/v0.4.11/dsh-oil-ui-0.4.11.tgz \
  --output "$AUDIT/release-0.4.11.tgz"
```

新增 README 的 npm 临时 pnpm 入口已在六个无 pnpm/Corepack 故障环境实际执行并恢复；不是只把正常机器上的 pnpm 改了名字。相同入口的 remove 命令也逐一验证。

此外在 latest CLI 的 web profile 做了实际 HTTP 前端探测：安装前、安装修复包后、卸载后，经 cookie 认证的首页都为 200 text/html，引用的客户端 JS 都为 200 text/javascript。探测按浏览器规则解码 HTML 实体，未把测试脚本的错误 URL 拼接误判为 DSH 静态资源故障。

## 已有其他插件

虚构兼容插件在完整矩阵安装前、安装后、卸载后均保留且可调用。`cordis.patch.yml` 实际只有一条插入自己的 entry，没有覆盖、禁用或删除 DSH 自带 entry；默认测试固定这个边界。

真实旧插件 `dsh-better-sidebar@0.16.1` 被 DSH 在安装前拒绝，原文包含：

```text
dsh: installation rejected: Plugin dsh-better-sidebar@0.16.1 is incompatible with dsh 0.2.1-rc.5
dsh: nothing was installed.
```

其 peer 范围指向旧 `0.1.0-rc.8` 系列，与 Oil UI 无关。没有授予风险豁免。为复现“旧版时已安装，升级 DSH 后被跳过”，在隔离 profile 用 pnpm 安装该真实包及 `dsh-whale-widget@0.2.10`，声明其 bundle，再启动当前 DSH。保留 DSH 自身的兼容检查，观察 skipping profile bundle；随后安装/卸载修复版 Oil UI，基础工具与兼容哨兵仍正常，卸载后配置恢复一致。此额外场景使用 Node 24 + DSH 0.2.1-rc.5。

## Desktop 0.12.1

本机生产应用的源码确认：设置/市场把插件安装到独立 Harness 根的 `profiles/web`，macOS 数据根为 `~/Library/Application Support/dsh-desktop/harness`。真实 Desktop profile 当时还引用旧 `0.4.9.tgz`，不能把终端 profile 的 0.4.11 当成桌面已安装版本。

桌面运行时实际为 Electron Node `24.17.0`、DSH `0.2.1-rc.2`、pnpm `10.34.5`。没有启动或修改真实 Electron 数据。使用其真实子进程入口、默认 Desktop patch 和临时数据目录执行安装及 Host 验证，命令主体是：

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop" \
  --expose-internals \
  "/Applications/DSH Desktop.app/Contents/Resources/harness-node-entry.mjs" \
  "/Applications/DSH Desktop.app/Contents/Resources/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add "$AUDIT/plugin-after.tgz"

# 相同隔离环境，Desktop host 组合：
# 上述 Electron + harness-node-entry + bin.js 后接：
web --patch "/Applications/DSH Desktop.app/Contents/Resources/dsh-desktop.patch.yml" \
  --no-open --host 127.0.0.1 --port 58126
```

Desktop 的 packaged pnpm 通过以下环境变量选择；HOME/DSH/XDG/npm/Git 配置全部隔离，命令由 `env -i` 白名单启动：

```bash
DSH_DESKTOP_PNPM_ENTRY="/Applications/DSH Desktop.app/Contents/Resources/app.asar/node_modules/pnpm/bin/pnpm.cjs"
DSH_DESKTOP_PNPM_RUNNER="/Applications/DSH Desktop.app/Contents/Resources/app.asar/node_modules/dsh-desktop-market-installer/pnpm-runner.mjs"
```

初始包出现同一 agents 错误；修复包启动错误为零。匿名 HTTP 为 401，持临时启动令牌的请求为 303，令牌只在内存使用。公开 `runProfile` + 标准 preset Agent 检查五工具及原生工具；Lite 0.33.2 原文正常，虚构 Pro 由 filesystem 发布，status ready。修复包卸载后 manifest 恢复 base/web，重启同 Desktop 组合，token 换 cookie 为 303、HTML 200、JS 200、匿名 401，Harness 与 Oil UI 错误数均为零。

临时 Agent 的清理曾出现 goal projection 缺失告警；它属于未运行正式 goal 任务的测试 Agent 清理路径，未将其冒称为“所有日志完全无告警”。Electron 设置页的点击、IPC、渲染和市场交互没有执行，不能据此宣称完整桌面 UI 验证通过。

## 真实模型

使用用户已安装的 headless profile 定义与其 0.4.11 包，在临时 HOME/DSH 副本运行，凭据只由 DSH 凭据服务按 patch 解析。没有读取、复制或打印 Key。命令结构为：

```bash
dsh --profile headless \
  --patch /Users/linzhihuang/Desktop/project/oil-ui-gallery/_work/flow-demo-20261108/enable-credentials.patch.yml \
  --patch "$AUDIT/live-model/credentials-path.patch.yml" \
  '<在临时目录生成咖啡活动单页，调用状态、skill、截图、按钮验证与 read_image；禁止生图和用户文件访问>'
```

首次运行约 361 秒，退出 0。生成 index.html、五张桌面/手机及切换状态截图；最终五份截图报告的 issues/lint 均为空。模型修掉自己初稿中的装饰溢出和小字问题，未把页面缺陷误归于插件。

安装本分支修复包到独立 headless profile 后再跑真实模型，约 46 秒、退出 0：状态为 Lite 0.33.2、ready；原生 skill 成功；修改标题并在 1440×900/390×844 截图，验证真实按钮切换并 read_image。两份最终报告没有控制台错误、横向溢出或断图。

第二次模型曾把 JSON 数组编码到 steps 字符串参数中，工具拒绝；改为 `click #wantBtn; wait 700` 后成功。会话事件确认这是模型传参错误；工具说明补充正确例子和数组分组语义，没有放宽解析器或改写 Skill。

页面、截图、报告和命令记录保留在本地忽略目录 `.work/real-install-verification/`，不进入 Git。临时运行时、凭据路径 patch、缓存和会话数据结束后清理。

## 检查与发布边界

最终验证结果如下，全部实际执行：

| 命令                                                   | 结果                                      |
| ------------------------------------------------------ | ----------------------------------------- |
| `npm run build`                                        | 通过，lib 已更新                          |
| `npm run check`                                        | 通过，108/108，格式、类型、生成物检查通过 |
| `npm run pack:plugin -- <隔离输出>`                    | 通过，46 资源、72 归档条目                |
| `OIL_UI_SOURCE_DIR=../oil-ui npm run test:integration` | 通过，1/1                                 |
| `npm run smoke:dsh`，PATH 逐一选择三种独立 DSH         | 三版本各 4/4                              |
| `DSH_SMOKE_PROFILE=headless npm run smoke:dsh`，同上   | 三版本各 4/4                              |

六次最终冒烟使用同一深目录环境，路径规范化后均通过。24 个 Host 场景的五工具、原文、状态、无插件错误、系统提示与原生 read 断言全通过。Node 22 用于 rc.3/rc.5，Node 24 用于 rc.1；脚本自身输出实际版本和 profile。

历史 [#12](https://github.com/oil-oil/dsh-oil-ui/issues/12) 是旧版包内资源路径错误；修复包的真实安装布局、无 Pro/虚构 Pro 状态测试均未复现 ENOENT。[#26](https://github.com/oil-oil/dsh-oil-ui/issues/26) 是旧版精确 engines 范围拒绝 rc.5；本轮当前包未被这三个 CLI 版本按 engines 跳过。它们不能代替本轮新找到的注入缺陷。

此次没有验证 Windows/Linux 的真实用户安装、任意未来 DSH 预发布、全部第三方插件组合、所有网络环境、Electron 设置页完整流程、真实私有 Pro 各历史版本或付费生图。下一步是维护者验收并发布包含本修复的新版本，核对镜像与正式附件，再逐步补充这些平台与交互验证。可以说“已验证所列组合并修复已复现问题”，不能说“对所有真实用户百分之百可用”。

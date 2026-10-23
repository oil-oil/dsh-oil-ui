<p align="center">
  <img src="assets/readme/hero.webp" alt="dsh-oil-ui — 把 DeepSeek 的 UI 设计能力，推到极限。" width="100%">
</p>

<p align="center">
  <a href="https://ui.oiloil.org">作品画廊</a> ·
  <a href="https://ui.oiloil.org/pro/">Oil UI Pro</a> ·
  <a href="https://github.com/oil-oil/oil-ui">上游 oil-ui</a> ·
  <a href="#安装">安装</a> ·
  <a href="#原生工具与快捷命令">原生工具</a> ·
  <a href="README.en.md">English</a>
</p>

---

**`dsh-oil-ui` 是 [oil-ui](https://github.com/oil-oil/oil-ui) 的 DeepSeek Harness 原生插件。**

它把 `oil-ui` 的界面设计流程直接接进 `@deepseek-ai/dsh`：先在同屏对比页里摆开 3 个真正拉开差距的方向，挑定后再在当前目录里写代码、截真图、点交互、查多端，照着真实画面一轮轮把界面改到位。

关于设计方法与作品画廊，可直接看 **[oil-ui 仓库](https://github.com/oil-oil/oil-ui)** 和 **[ui.oiloil.org](https://ui.oiloil.org)**。这里重点说明 `dsh-oil-ui` 在 DeepSeek Harness 里做了什么，以及怎样配合 **Oil UI Pro** 使用。

<p align="center">
  <img src="assets/readme/showcase.webp" alt="DeepSeek Harness + dsh-oil-ui 实跑作品" width="100%">
</p>

上图 6 件作品（`ARCHON`、`Sonar 声场`、`Tempo 2026`、`Atelier Volders`、`Fonderie Mercier`、`Vesper`）均由 `DeepSeek 4.1 Flash` 搭配 `dsh-oil-ui`，仅凭一段简短任务描述在隔离目录里自主探索、生成对比页并完成全部交互与多端校验。

---

## 为什么做原生插件

DeepSeek Harness 本身已经有文件读写（`read` / `write` / `edit`）、终端（`bash`）、看图（`read_image`）和子代理（`subagent`）。如果再包一层项目沙箱或过渡 `ADAPTER`，模型反而要在两套读写工具和两套目录规则之间来回猜。

`dsh-oil-ui` 直接按 DeepSeek Harness 的原生插件机制设计：

- **直接在当前工作目录读写**：不创建额外的 `projects/<uuid>` 嵌套目录，页面、样式、脚本和截图都落在当前目录，和原生 `read` / `write` / `read_image` 完全一致。
- **只注册 `oil-ui` 独有的 5 个工具**：对比页打包、浏览器截图与交互巡检、公有领域素材检索、AI 生图修图，以及 Skill 状态检查。
- **从上游 `oil-ui` 自动编译派生**：插件把上游 `SKILL.md` 和 `references/*.md` 里的命令行示例自动改写为原生工具调用。上游更新后，跑一条 `pnpm vendor:skill` 就能同步派生，不用手工维护两套文档。

---

## 在 DeepSeek Harness 里怎么跑

给一句简单的需求，Agent 会自己走完 **探索方向 → 生成同屏对比页 → 实现完整页面 → 截图与子代理走查**：

<p align="center">
  <img src="assets/readme/proof-tempo.webp" alt="Tempo 2026 移动端三方向同屏对比页" width="100%">
</p>

<p align="center">
  <img src="assets/readme/proof-archon.webp" alt="ARCHON 桌面端三方向同屏对比页" width="100%">
</p>

1. 先调 `oil_ui_skill_status` 检查当前可用的 Skill（已装 `oil-ui-pro` 会优先使用 Pro），再用原生 `skill` 工具加载指南和对应分册。
2. 在 `explore/` 下写出 3 个构图、色调和视觉引擎完全不同的首屏候选，调 `oil_ui_explorer` 打包出单文件 `style-explorer.html`。
3. 选定方向后写出完整的 `index.html`（或多屏 `screens.html`），调 `oil_ui_shoot` 在真实无头浏览器里截图、模拟点击与输入、检查多端断点，并用原生 `read_image` 看图改到干净为止。

---

## 原生工具与快捷命令

插件向模型暴露 5 个专用工具，参数全部以当前工作目录（`cwd`）为基准：

| 工具 | 作用 |
| --- | --- |
| `oil_ui_skill_status` | 刷新 Skill 状态，返回当前生效的 `activeSkillName`、生图来源与 oiloil 余额，同时处理版本更新检查和一次性 Pro 提示 |
| `oil_ui_explorer` | 读取 `explore/manifest.json`（兼容常见简写字段），把多个首屏候选内联打包成可交互的 `style-explorer.html` 对比页 |
| `oil_ui_shoot` | 在真实浏览器里打开本地页面或 URL：支持指定视口尺寸、2x 特写、多状态连拍（`states`）、交互步骤脚本（`steps`）、录屏抽帧（`record` / `motion`）以及证据拼图（`evidence`），并自动检查控制台报错、横向溢出、断图与文字对比度 |
| `oil_ui_media` | 搜索、预览和下载免版权/公有领域图片、博物馆馆藏（Met、AIC、Cleveland、Wikimedia、Openverse 等）、视频与地图素材 |
| `oil_ui_image` | 优先调用本地 `image-gen`；本机不可用时使用 oiloil 生成或编辑图片，支持指定分辨率；oiloil 返回格式不同时按实际格式保存并返回路径 |

同时向聊天输入框注册 3 个以 `oil-ui-` 为前缀的 Slash 快捷命令（与其他 `oil-*` 系列 Skill 区分）：

| 命令 | 作用 |
| --- | --- |
| `/oil-ui-status [update]` | 直接查看当前生效版本（`oil-ui` / `oil-ui-pro`）、更新状态与 `image-gen` 状态；带 `update` 参数时直接原地更新 |
| `/oil-ui-explore <需求描述>` | 支持附带参考图/文件，直接发起三方向探索并生成 `style-explorer.html` 对比页 |
| `/oil-ui-review [目标页面或文件]` | 支持附带截图/文件，对目标页面抓真图并执行视觉层级 + 可用性双轨走查 |

---

## Oil UI Pro 与更新检查

`dsh-oil-ui` 内置免费版 `oil-ui`，开箱就能跑通方向探索与同屏对比页。如果你经常做正式上线页、复杂工作台或需要多轮视觉精修，可以搭配 **[Oil UI Pro](https://ui.oiloil.org/pro/)** 使用。

### Oil UI Pro 多了什么

| 能力 | `oil-ui`（内置免费版） | `Oil UI Pro` |
| --- | :---: | :---: |
| 设计方向探索 + `style-explorer.html` 同屏对比 | ✓ | ✓ |
| 真实截图驱动的多轮视觉精修与对比度/排版巡检 | — | ✓ |
| 多状态连拍（`states`）、交互步骤（`steps`）与录屏抽帧 | — | ✓ |
| 博物馆/公有领域素材检索（`oil_ui_media`）与 AI 生图修图（`oil_ui_image`）完整分册 | — | ✓ |
| 独立视觉与 UX 走查 | 主要流程轻量 UX 走查 | 自主风险探针、深入洞察与同路径复核 |
| 完整场景分册（营销落地页、数据后台、移动多屏、重绘改版、字体子集化） | — | ✓ |

### 自动识别本地 Pro 与子代理评审注入

在本机安装好 `oil-ui-pro`（默认位于 `~/.agents/skills/oil-ui-pro` 或 `~/.dsh/skills/oil-ui-pro`）后，不需要重启 DeepSeek Harness。Agent 在任务开始调用 `oil_ui_skill_status` 时，插件会扫描本机目录，把 `oil-ui-pro` 的 `SKILL.md` 和分册编译为原生工具说明，并以高于宿主内置文件加载器的优先级生效。当主 Agent 派发子代理（`subagent`）做视觉与交互走查时，插件会自动向子代理注入原生化的 `reviewer-manual.md` 及 `references/` 目录路径，主 Agent 无需手动拼接手册路径。

### 版本检查与一次性 Pro 提醒

原来在 `oil-ui` 脚本里的版本更新检查和一次性 Pro 推荐，在 `dsh-oil-ui` 里直接合进了 `oil_ui_skill_status`：

- **版本检查与一键更新**：调用 `oil_ui_skill_status` 时，插件每天最多向 `https://ui.oiloil.org/api/store/versions` 静默核对一次版本号（结果缓存在 `~/.local/state/oil/<name>-update.json`，断网或超时会自动跳过并进入退避冷却，不会阻塞任务）。发现新版本时会在返回结果里附上 `updateNotice`；传入 `{"update": true}`（或执行 `/oil-ui-status update`）可直接把当前生效的 Skill 更新到最新。
- **一次性 Pro 提醒**：当本机只装了免费版 `oil-ui` 时，首次调用 `oil_ui_skill_status` 会在 `~/.local/state/oil-ui/recommended-oil-ui-pro` 写下标记，并返回一次 `recommendOnceNotice`，让 Agent 在任务收尾时顺带提一句 [ui.oiloil.org/pro](https://ui.oiloil.org/pro/)，之后不再重复打扰。

---

## 安装

### 1. 一行命令安装到 DeepSeek Harness

如果你使用 DeepSeek Harness 的默认 Web 界面（`dsh web`），直接在终端运行：

```bash
dsh plugin --profile web add github:oil-oil/dsh-oil-ui
```

（若使用命令行无头模式，将 `--profile web` 换成 `--profile headless` 即可。）

仓库已包含预编译好的 `lib/index.js` 和内置的免费版 `oil-ui`，安装后无需任何额外构建授权，直接启动 `dsh web` 即可使用。

<details>
<summary>从本地源码打包安装</summary>

```bash
git clone https://github.com/oil-oil/dsh-oil-ui.git
cd dsh-oil-ui
pnpm install
pnpm pack:plugin
dsh plugin --profile web add ./.work/dsh-oil-ui-0.3.2.tgz
```

</details>

### 2. 可选配置与运行依赖

插件开箱即用，默认会自动扫描本机的 `oil-ui-pro` 和 `image-gen` Skill。如需自定义路径或端口，可在 `~/.dsh/cordis.patch.yml`（全局）或 `~/.dsh/profiles/web/cordis.patch.yml`（当前 profile）中按行覆盖配置（对应 [`src/config.ts`](src/config.ts)）：

```yaml
- id: dsh-oil-ui
  name: dsh-oil-ui
  config:
    # 是否优先启用本机已安装的 oil-ui-pro（默认 true）
    preferPro: true
    # 可选：指定自定义的 oil-ui-pro 目录（默认自动扫描 .dsh/skills 与 .agents/skills）
    # proSkillDir: /Users/you/.agents/skills/oil-ui-pro
    # 可选：指定 image-gen 脚本路径（默认自动扫描 ~/.dsh/skills/image-gen 与 ~/.agents/skills/image-gen）
    # imageGenScript: /Users/you/.agents/skills/image-gen/scripts/image_gen.py
    # 可选：覆盖默认工作目录与本地截图预览服务端口（0 为自动分配空闲端口）
    # workspaceRoot: /path/to/workspace
    # previewPort: 0
```

- **浏览器截图（`oil_ui_shoot`）**：使用本机安装的 Chrome / Chromium（或 Playwright Chromium）；若使用录屏抽帧（`record` / `motion`），需本机装有 `ffmpeg`。
- **AI 生图修图（`oil_ui_image`）**：优先使用本机 `image-gen`（需 `python3`）；不可用时读取 `OIL_TOKEN` 或 `~/.config/oil/config.json` 的登录状态调用 oiloil。可用 `OIL_API` 覆盖 API 地址，默认 `https://api.oiloil.org`。

---

## 从上游 `oil-ui` 同步更新

当上游 `oil-ui` 更新了 `SKILL.md`、分册或脚本时，在仓库根目录运行：

```bash
pnpm vendor:skill   # 同步 ../oil-ui（或设置 OIL_UI_SOURCE_DIR）
pnpm test           # 运行插件与编译转换测试
pnpm pack:plugin    # 重新构建并打出 .tgz 插件包
```

---

## 许可

基于 [MIT License](LICENSE) 开源。

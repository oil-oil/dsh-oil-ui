# 工具

所有路径相对于当前工作目录解析。查看图片用 `read_image`，派发独立视觉评审用 `subagent`。
## 截图和录屏

### 什么时候截，截多少

截图分两种用途，不要混在一起：

- **看一眼**：改完一批，想看效果。只截当前这一屏，一次 `oil_ui_shoot` 调用。把一批改动攒在一起改完再截，不是每改一处截一次；页面没有变，就不重复截。
- **取证**：用 `oil_ui_shoot`（`evidence: true`）一次取齐状态图、并排图、遮字图、2 倍图和录屏。只在两个时候做：送评审之前，交付之前。方向首屏那一轮每个方向只截一张，不取证。

每一轮评审只重新取这一轮改动影响到的证据。没有动过的状态和动效，沿用上一轮的文件，交接时注明哪些是沿用的；拿不准有没有被影响到，例如改了共享样式，就重取那一项。

### 常用调用方式（`oil_ui_shoot`）

`oil_ui_shoot` 对工作目录内的本地 HTML 文件（包括子目录如 `explore/a.html`）会自动通过工作区根目录的本地 HTTP 服务打开，`assets/...`、`../assets/...` 与 `?state=...` 地址参数都能直接解析，无需自己起静态服务器。

| 要什么 | `oil_ui_shoot` 参数 |
| --- | --- |
| 看一眼桌面效果 | `{ "target": "index.html", "size": "desktop", "out": "shots/desktop.png" }`（不传 `size` 默认 `1440x900`；支持 `desktop`、`mobile`、`1440x900,390x844`；只看整体版式可加 `"thumb": true`） |
| 一次截完多个候选并出并排图 | `{ "target": "explore", "size": "desktop", "thumb": true, "out": "shots/explore" }`（也可传 `["explore/a.html", "explore/b.html", "explore/c.html"]`，同一次浏览器会话截完并自动出 `sheet.png`） |
| 只看改过的局部组件或区域 | `{ "target": "index.html", "size": "desktop", "selector": ".card", "out": "shots/card.png" }`（自动滚入视口并只截该元素区域） |
| 操作几步再截 | `{ "target": "index.html", "size": "desktop", "steps": "click .open; wait 300", "out": "shots/open.png" }` |
| 按地址参数切多状态连拍 | `{ "target": "index.html", "size": "desktop", "states": ["idle", "done"], "out": "shots" }`（状态参数名默认 `state`，可用 `param` 修改；额外查询串用 `query: "a=1&b=2"`） |
| 送评审或交付前取证 | `{ "target": "index.html", "size": "desktop", "evidence": true, "states": ["idle", "done"], "steps": ["send: click .send"], "out": "evidence" }` |
| 2 倍高清截图（@2x） | `{ "target": "index.html", "size": "desktop", "zoom": 2, "out": "shots/desktop-2x.png" }`（或 `zoom: "1,2"`） |
| 落地页录一段从头滚到底 | `{ "target": "index.html", "size": "desktop", "record": true, "steps": "scroll 600; scroll 600; scroll 600", "out": "evidence" }` |
| 截图还原：和参考图比对 | `{ "target": "index.html", "size": "1440x900", "compare": "refs/target.png", "out": "shots/compare.png" }` |
| 给元素画框、标编号 | `{ "target": "index.html", "size": "desktop", "mark": "1=.page-head .btn; 2=.toggle-row", "fullPage": true, "out": "shots/marked.png" }` |
| 看清一段过渡序列帧 | `{ "target": "index.html", "size": "desktop", "record": true, "frames": 8, "steps": "click .open", "out": "evidence" }` |
| 把几张图拼成一张对比图 | `{ "stitch": [{ "path": "shots/a.png", "label": "修改前" }, { "path": "shots/b.png", "label": "修改后" }], "out": "shots/stitch.png" }` |

状态靠地址参数进入，所以页面要能用 `?state=<名字>` 直接打开每个状态。`steps` 动作写法（分号分隔）：`click <选择器>`、`hover <选择器>`、`dblclick <选择器>`、`waitfor <选择器>`、`drag <选择器> <dx> <dy>`、`type <选择器> <文字>`、`fill <选择器> <文字>`、`select <选择器> <值>`、`key <按键>`、`scroll <dy>`、`wait <毫秒>`。

### 检索和下载真实素材（`oil_ui_media`）

需要真实材质贴图、设计器物、历史摄影、工程测绘图、古地图、科学版画或 NASA 视频时，调用 `oil_ui_media`：

- **一步检索并下载（默认）**：
  `oil_ui_media({ "query": "oak planks | belgian oak", "kind": "photo", "limit": 6, "use": "page", "dir": "assets/media", "sheet": true })`
- **分步检索 / 预览 / 按编号拉取**：
  1. 搜索并生成候选联系表：`oil_ui_media({ "action": "search", "query": "wood", "kind": "texture", "limit": 6, "sheet": true, "dir": "candidates" })`
  2. 用 `read_image` 查看返回的联系表 PNG，挑选编号后拉取：`oil_ui_media({ "action": "fetch", "refs": ["C1", "T2"], "dir": "assets", "sheet": true })`
  3. 拉取完整 PBR 贴图（Diffuse / Roughness / Normal）：`oil_ui_media({ "action": "fetch", "refs": ["T2"], "maps": "all", "resolution": "1k", "dir": "assets" })`

`kind` 支持 `all|texture|design|photo|blueprint|map|plate|science|video`。每项 `use` 说明用途：`page` 可放进页面（CC BY/BY-SA 要署名），`reference` 只可下载到不上线的目录作为生图参考。单个 URL 下载可用 `oil_ui_media({ "action": "fetch", "refs": "https://example.org/image.jpg", "out": "assets/image.jpg" })`；单文件下载不传 `dir`，输出路径不可覆盖已有文件。所有成功下载自动记入 `SOURCES.md`。

### 生图与改图（`oil_ui_image`）

当 `oil_ui_skill_status` 显示 `imageGenAvailable: true` 时，调用 `oil_ui_image` 生成或编辑图片：

- **文生图（`mode: "generate"`）**：`oil_ui_image({ "prompt": "...", "out": "assets/hero.png", "size": "1536x1024", "quality": "high" })`
- **透明底抠图（`background: "transparent"`）**：`oil_ui_image({ "prompt": "...", "background": "transparent", "out": "assets/cutout.png" })`
- **基于参考图的图生图 / 同模多材质变体（`mode: "edit"`）**：传入 1–16 张本地参考图（如先生成原色器物，再派生烟熏、绿锈等表面，保持角度与光影一致）：`oil_ui_image({ "mode": "edit", "images": ["assets/raw.png"], "prompt": "...", "out": "assets/variant.png" })`

### 组装风格对比页（`oil_ui_explorer`）

写好三个候选首屏（如 `explore/a.html`、`explore/b.html`、`explore/c.html`）后，调用 `oil_ui_explorer({ "manifest": "explore/manifest.json", "out": "style-explorer.html" })` 即可生成内嵌全部本地资源的独立对比页。
### 看结果

交给评审前先自己看一眼：默认状态是不是已经加载完，遮字版有没有把图形也一起盖掉。证据有错先重截，再交给评审。汇总里提示录屏和截图不一致时，静止的终态以截图为准，再单独重录那一段核对过渡。画面是空的 WebGL 截图不能当证据。

每张截图还会查一组能从页面样式里直接判断的问题，`oil_ui_shoot` 返回的 `domHints` 与输出里以“默认做法提示”列出：

- **要改的可读性问题**：文字对比度不达标、正文小于 13px、多行正文行高过紧、首屏里停在透明状态的内容。
- **改掉或写出理由**：有色底上的灰字、正文行太长，以及模型默认做法：标题上方的眉标和编号标签、彩色单侧边线、渐变文字、卡片里套卡片、表情符号当图标、中文界面里的英文大写标签、标题离上文比离下文还近。保留的项，在交付说明里写出它怎样服务方向。

检查会误报，例如真实的步骤编号、确实需要的标签；误报在交付说明里写一句。它只认得写法，判断不了好不好看：提示清零之后，仍要自己看截图。检查报出接口 401、404 这类和画面无关的错误时，在交付说明里记一行，不为了让检查通过去改登录、接口这类业务代码。

## 写可操作的小样

方向探索阶段的首屏不做交互，用不到这一节；选定方向后做完整页面时再用。存量项目照用项目自己的技术栈。

一个组件或一个页面只写一个文件，用地址参数切换状态，不要每个状态复制一份。颜色、字号、间距、圆角先定成十来个 CSS 变量，后面一律引用变量，不引入需要构建的工具。表单、切换、展开这类状态用 Alpine.js 写在 HTML 属性上：把 `<skill>/assets/vendor/alpine.min.js` 复制到任务目录的 `vendor/` 再引用，状态集中在一个 `x-data` 里，初始状态读地址参数。手势跟手、物理模拟、Canvas 和 WebGL 绘制放进单独的 JS 模块，每帧更新的数据不放进 Alpine 的状态。

# 工具

所有路径相对于当前工作目录解析。查看图片用 `read_image`，派发独立视觉评审用 `subagent`。
## 截图和录屏

### 什么时候截，截多少

截图分两种用途，不要混在一起：

- **看一眼**：改完一批，想看效果。只截当前这一屏，一次 `oil_ui_shoot` 调用。把一批改动攒在一起改完再截，不是每改一处截一次；页面没有变，就不重复截。
- **取证**：只在送评审之前、交付之前，调用 `oil_ui_shoot`，保留足以判断的标准视口图；常规单页应用一次截取桌面与手机标准视口（`--size desktop,mobile`），并用 `--steps` 验证 1–2 个代表交互状态即可收尾。交互状态直接用 `--steps "click ..."` 触发，不要在页面代码里为了截图专门开发 `?state=<名字>` 地址参数路由；带 `sticky` 顶栏或 `100vh`/`resize` 监听的工作台不要加 `--full`（`fullPage: true`），避免产生空白拼接伪影，也不要对每个局部卡片逐一单拍。需要比较状态时加 `oil_ui_shoot` 的 `sheet` 参数，需要遮字时加 `oil_ui_shoot` 的 `mask` 参数。方向首屏那一轮每个方向只截一张，不取整套证据。

动效默认用 `oil_ui_shoot` 的 `frames` 参数 生成带时间的序列图，或让评审者打开页面直接操作。只有确实要判断正常速度下的手感、且评审能播放视频时才用 `oil_ui_shoot` 的 `record` 参数，不为交付而录屏。确实需要整套证据时用 `oil_ui_shoot`（`evidence: true, frames: <帧数>`）；满足上述录屏条件才加 `oil_ui_shoot` 的 `record` 参数。

每一轮评审只重新取这一轮改动影响到的证据。没有动过的状态和动效，沿用上一轮的文件，交接时注明哪些是沿用的；拿不准有没有被影响到，例如改了共享样式，就重取那一项。评审者只提出扩大覆盖、却说不清哪条判断缺少依据时，不补图也不加一轮。

### 常用调用方式（`oil_ui_shoot`）

`oil_ui_shoot` 对工作目录内的本地 HTML 文件（包括子目录如 `explore/a.html`）会自动通过工作区根目录的本地 HTTP 服务打开，`assets/...` 与 `../assets/...` 相对路径都能直接解析，无需自己起静态服务器。

| 要什么 | `oil_ui_shoot` 参数 |
| --- | --- |
| 看一眼桌面效果 | `{ "target": "index.html", "size": "desktop", "out": "shots/desktop.png" }`（不传 `size` 默认 `1440x900`；支持 `desktop`、`mobile`、`1440x900,390x844`；只看整体版式可加 `"thumb": true`） |
| 一次截完多个候选并出并排图 | `{ "target": "explore", "size": "desktop", "thumb": true, "out": "shots/explore" }`（也可传 `["explore/a.html", "explore/b.html", "explore/c.html"]`，同一次浏览器会话截完并自动出 `sheet.png`） |
| 只看改过的局部组件或区域 | `{ "target": "index.html", "size": "desktop", "selector": ".card", "out": "shots/card.png" }`（自动滚入视口并只截该元素区域） |
| 操作几步再截 | `{ "target": "index.html", "size": "desktop", "steps": "click .open; wait 300", "out": "shots/open.png" }` |
| 同时截桌面与手机标准视口 | `{ "target": "index.html", "size": "desktop,mobile", "out": "shots" }` |
| 2 倍高清截图（@2x） | `{ "target": "index.html", "size": "desktop", "zoom": 2, "out": "shots/desktop-2x.png" }`（或 `zoom: "1,2"`） |
| 核对长页滚动动效 | `{ "target": "index.html", "size": "desktop", "frames": 8, "steps": "scroll 600; scroll 600; scroll 600", "out": "evidence" }` |
| 给元素画框、标编号 | `{ "target": "index.html", "size": "desktop", "mark": "1=.page-head .btn; 2=.toggle-row", "out": "shots/marked.png" }` |
| 看清一段过渡序列帧 | `{ "target": "index.html", "size": "desktop", "frames": 8, "steps": "click .open", "out": "evidence" }` |
| 把几张图拼成一张对比图 | `{ "stitch": [{ "path": "shots/a.png", "label": "修改前" }, { "path": "shots/b.png", "label": "修改后" }], "out": "shots/stitch.png" }` |

动效默认使用 `frames` 序列图或直接操作；只有需要判断正常速度下的手感且评审能播放视频时才传 `record: true`。拼图可在各项设置 `matchWidth`（共有元素在原图里的像素宽）或 `scale`（数值、百分比或分数），两者不混用；全局 `crop`（如 `"0,0,800,600"`）在统一比例后裁切，超出任一图片时报错。

常规单页工作台或原型直接截取桌面与手机标准视口（`size: "desktop,mobile"`），并用 `steps` 验证 1–2 个核心交互即可交付；不要为了截图专门给页面编写 `?state=` 地址参数路由，不要使用 `fullPage: true` 截整页长图，也不要对每个局部卡片单独跑 `selector` 截图。`steps` 动作写法（分号分隔）：`click <选择器>`、`hover <选择器>`、`dblclick <选择器>`、`waitfor <选择器>`、`drag <选择器> <dx> <dy>`、`type <选择器> <文字>`、`fill <选择器> <文字>`、`select <选择器> <值>`、`key <按键>`、`scroll <dy>`、`wait <毫秒>`。

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

查看 `oil_ui_skill_status.imageSource`：有本机 `image-gen` 时优先使用；否则使用 oiloil；显示 `none` 时按返回说明继续。尺寸可用 `size` 指定为 `1K`、`2K`、`4K` 或支持的宽高值。

- **文生图**：`oil_ui_image({ "prompt": "...", "out": "assets/hero.png", "size": "2K" })`
- **参考图改图**：`oil_ui_image({ "mode": "edit", "images": ["assets/source.png"], "prompt": "...", "out": "assets/edited.png" })`（oiloil 一次支持一张参考图）

### 组装风格对比页（`oil_ui_explorer`）

写好三个候选首屏（如 `explore/a.html`、`explore/b.html`、`explore/c.html`）后，调用 `oil_ui_explorer({ "manifest": "explore/manifest.json", "out": "style-explorer.html" })` 即可生成内嵌全部本地资源的独立对比页。
### 看结果

交给评审前先自己看一眼：默认状态是不是已经加载完，遮字版有没有把图形也一起盖掉。证据有错先重截，再交给评审。汇总里提示录屏或序列图和截图不一致时，静止的终态以截图为准，再单独查看那一段操作或补序列图核对过渡。序列图能判断状态与变化，不能据此宣称正常速度下的手感已验证。画面是空的 WebGL 截图不能当证据。

截图和取证优先用这里的截图工具。确实要自己写浏览器脚本（例如 Puppeteer 或 Playwright）时，启动参数加 `--use-mock-keychain --password-store=basic`，并用临时的用户数据目录；否则在 macOS 上会反复弹出钥匙串授权窗口，打断用户。

每张截图还会查 4 项可读性与渲染硬问题（文字对比度不达标、正文小于 11px、多行正文行高过紧、首屏里停在透明状态的内容），`oil_ui_shoot` 返回的 `domHints` 与输出里以“默认做法提示”列出并写进 `report.json` 的 `lint`。提示清零之后，仍要自己看截图。检查报出接口 401、404 这类和画面无关的错误时，在交付说明里记一行，不为了让检查通过去改登录、接口这类业务代码。

## 写可操作的小样

方向探索阶段的首屏不做交互，用不到这一节；选定方向后做完整页面时再用。存量项目优先沿用已安装的组件库、图标库、样式体系与技术栈。新建项目按用户约束、技术栈和主要交互选择组件基础，原生控件、轻量基础组件或完整组件库均可，不强制引入完整库；已有工程或交付约定优先于下面的独立 HTML 小样做法。

没有工程约束、交付独立小样时，默认一个入口 `index.html`，优先将 HTML、`<style>` 与 `<script>` 内聚在单文件中，服从项目与交付约定。颜色、字号、间距、圆角先定成少量 CSS 变量，后面一律引用变量；独立小样不额外引入构建链。可用原生脚本或轻量库实现真实筛选、切换与详情交互。正式入口 HTML 的本地依赖放到同目录的 `vendor/` 再引用，过程小样及其依赖才放任务目录。

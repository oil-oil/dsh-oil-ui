const NATIVE_TOOL_COMMANDS_SECTION = `### 常用调用方式（\`oil_ui_shoot\`）

\`oil_ui_shoot\` 对工作目录内的本地 HTML 文件（包括子目录如 \`explore/a.html\`）会自动通过工作区根目录的本地 HTTP 服务打开，\`assets/...\`、\`../assets/...\` 与 \`?state=...\` 地址参数都能直接解析，无需自己起静态服务器。

| 要什么 | \`oil_ui_shoot\` 参数 |
| --- | --- |
| 看一眼桌面效果 | \`{ "target": "index.html", "size": "desktop", "out": "shots/desktop.png" }\`（不传 \`size\` 默认 \`1440x900\`；支持 \`desktop\`、\`mobile\`、\`1440x900,390x844\`；只看整体版式可加 \`"thumb": true\`） |
| 一次截完多个候选并出并排图 | \`{ "target": "explore", "size": "desktop", "thumb": true, "out": "shots/explore" }\`（也可传 \`["explore/a.html", "explore/b.html", "explore/c.html"]\`，同一次浏览器会话截完并自动出 \`sheet.png\`） |
| 只看改过的局部组件或区域 | \`{ "target": "index.html", "size": "desktop", "selector": ".card", "out": "shots/card.png" }\`（自动滚入视口并只截该元素区域） |
| 操作几步再截 | \`{ "target": "index.html", "size": "desktop", "steps": "click .open; wait 300", "out": "shots/open.png" }\` |
| 按地址参数切多状态连拍 | \`{ "target": "index.html", "size": "desktop", "states": ["idle", "done"], "out": "shots" }\`（状态参数名默认 \`state\`，可用 \`param\` 修改；额外查询串用 \`query: "a=1&b=2"\`） |
| 送评审或交付前取状态图 | \`{ "target": "index.html", "size": "desktop", "states": ["idle", "done"], "sheet": true, "out": "evidence" }\` |
| 2 倍高清截图（@2x） | \`{ "target": "index.html", "size": "desktop", "zoom": 2, "out": "shots/desktop-2x.png" }\`（或 \`zoom: "1,2"\`） |
| 核对长页滚动动效 | \`{ "target": "index.html", "size": "desktop", "frames": 8, "steps": "scroll 600; scroll 600; scroll 600", "out": "evidence" }\` |
| 截图还原：和参考图比对 | \`{ "target": "index.html", "size": "1440x900", "compare": "refs/target.png", "out": "shots/compare.png" }\` |
| 给元素画框、标编号 | \`{ "target": "index.html", "size": "desktop", "mark": "1=.page-head .btn; 2=.toggle-row", "fullPage": true, "out": "shots/marked.png" }\` |
| 看清一段过渡序列帧 | \`{ "target": "index.html", "size": "desktop", "frames": 8, "steps": "click .open", "out": "evidence" }\` |
| 把几张图拼成一张对比图 | \`{ "stitch": [{ "path": "shots/a.png", "label": "修改前" }, { "path": "shots/b.png", "label": "修改后" }], "out": "shots/stitch.png" }\` |

动效默认使用 \`frames\` 序列图或直接操作；只有需要判断正常速度下的手感且评审能播放视频时才传 \`record: true\`。拼图可在各项设置 \`matchWidth\`（共有元素在原图里的像素宽）或 \`scale\`（数值、百分比或分数），两者不混用；全局 \`crop\`（如 \`"0,0,800,600"\`）在统一比例后裁切，超出任一图片时报错。

状态靠地址参数进入，所以页面要能用 \`?state=<名字>\` 直接打开每个状态。\`steps\` 动作写法（分号分隔）：\`click <选择器>\`、\`hover <选择器>\`、\`dblclick <选择器>\`、\`waitfor <选择器>\`、\`drag <选择器> <dx> <dy>\`、\`type <选择器> <文字>\`、\`fill <选择器> <文字>\`、\`select <选择器> <值>\`、\`key <按键>\`、\`scroll <dy>\`、\`wait <毫秒>\`。

### 检索和下载真实素材（\`oil_ui_media\`）

需要真实材质贴图、设计器物、历史摄影、工程测绘图、古地图、科学版画或 NASA 视频时，调用 \`oil_ui_media\`：

- **一步检索并下载（默认）**：
  \`oil_ui_media({ "query": "oak planks | belgian oak", "kind": "photo", "limit": 6, "use": "page", "dir": "assets/media", "sheet": true })\`
- **分步检索 / 预览 / 按编号拉取**：
  1. 搜索并生成候选联系表：\`oil_ui_media({ "action": "search", "query": "wood", "kind": "texture", "limit": 6, "sheet": true, "dir": "candidates" })\`
  2. 用 \`read_image\` 查看返回的联系表 PNG，挑选编号后拉取：\`oil_ui_media({ "action": "fetch", "refs": ["C1", "T2"], "dir": "assets", "sheet": true })\`
  3. 拉取完整 PBR 贴图（Diffuse / Roughness / Normal）：\`oil_ui_media({ "action": "fetch", "refs": ["T2"], "maps": "all", "resolution": "1k", "dir": "assets" })\`

\`kind\` 支持 \`all|texture|design|photo|blueprint|map|plate|science|video\`。每项 \`use\` 说明用途：\`page\` 可放进页面（CC BY/BY-SA 要署名），\`reference\` 只可下载到不上线的目录作为生图参考。单个 URL 下载可用 \`oil_ui_media({ "action": "fetch", "refs": "https://example.org/image.jpg", "out": "assets/image.jpg" })\`；单文件下载不传 \`dir\`，输出路径不可覆盖已有文件。所有成功下载自动记入 \`SOURCES.md\`。

### 生图与改图（\`oil_ui_image\`）

查看 \`oil_ui_skill_status.imageSource\`：有本机 \`image-gen\` 时优先使用；否则使用 oiloil；显示 \`none\` 时按返回说明继续。尺寸可用 \`size\` 指定为 \`1K\`、\`2K\`、\`4K\` 或支持的宽高值。

- **文生图**：\`oil_ui_image({ "prompt": "...", "out": "assets/hero.png", "size": "2K" })\`
- **参考图改图**：\`oil_ui_image({ "mode": "edit", "images": ["assets/source.png"], "prompt": "...", "out": "assets/edited.png" })\`（oiloil 一次支持一张参考图）

### 组装风格对比页（\`oil_ui_explorer\`）

写好三个候选首屏（如 \`explore/a.html\`、\`explore/b.html\`、\`explore/c.html\`）后，调用 \`oil_ui_explorer({ "manifest": "explore/manifest.json", "out": "style-explorer.html" })\` 即可生成内嵌全部本地资源的独立对比页。`;

export const hasDirectionImagery = (markdown: string) =>
  (markdown.includes('把每个方向用三四行写给用户') || markdown.includes('把方向用三四行写给用户')) &&
  markdown.includes('再列出首屏和关键区块需要的图') &&
  markdown.includes('oil_ui_image') &&
  markdown.includes('oil_ui_media');

export type SkillEdition = 'lite' | 'pro';

export interface MarkdownRule {
  id: string;
  file: string;
  match: RegExp;
  replacement: string;
  requiredIn: readonly SkillEdition[];
  editions?: readonly SkillEdition[];
  optionalReason?: string;
  // Deletions cannot use replacement text as evidence in an already compiled tree.
  nativeSatisfied?: (markdown: string) => boolean;
}

// Rules run in declaration order. Only compatibility fallbacks may be optional;
// upstream wording changes must be fixed, not silenced by making a rule optional.
export const MARKDOWN_RULES: readonly MarkdownRule[] = [
  {
    id: 'skill.remove-allowed-tools',
    file: 'SKILL.md',
    requiredIn: ['lite', 'pro'],
    match: /\r?\nallowed-tools:\r?\n(?:\s+-\s+[^\r\n]+\r?\n)+/,
    replacement: '\n',
    nativeSatisfied: (markdown) => !/^allowed-tools:/m.test(markdown),
  },
  {
    id: 'skill.compatibility',
    file: 'SKILL.md',
    requiredIn: ['lite', 'pro'],
    match: /compatibility:\s*"[^"]*"/,
    replacement:
      'compatibility: "通过 oil_ui_shoot、oil_ui_media、oil_ui_image、oil_ui_explorer、oil_ui_skill_status 与 read_image、subagent 完成截图取证、真实素材检索、AI 生图修图、对比页组装和独立视觉与 UX 走查。"',
  },
  {
    id: 'skill.startup',
    file: 'SKILL.md',
    requiredIn: ['lite', 'pro'],
    match: /## 开始前\r?\n\r?\n[\s\S]*?(?=\r?\n## 选择范围)/,
    replacement: `## 开始前\n\n先调用 \`oil_ui_skill_status\` 查看当前激活版本、更新提示（\`updateNotice\`）与生图来源（\`imageSource\`）。若 \`updateNotice\` 非空，照常完成任务并在最终回复末尾转述一次；只有用户明确要求更新时才调用 \`oil_ui_skill_status({ "update": true })\`。截图录屏用 \`oil_ui_shoot\`，素材检索与下载用 \`oil_ui_media\`，需要图片时用 \`oil_ui_image\`，风格对比页用 \`oil_ui_explorer\`，看图用 \`read_image\`，独立视觉与 UX 走查用 \`subagent\`。`,
  },
  {
    id: 'skill.single-direction-images',
    file: 'SKILL.md',
    requiredIn: ['lite'],
    match: /用三四行写清它给人什么感觉、首屏长什么样、核心动作怎样完成、字体、色彩和主视觉/,
    replacement:
      '把方向用三四行写给用户：它给人什么感觉，首屏长什么样，核心动作怎样完成，用什么字体和色彩，主视觉靠什么；再列出首屏和关键区块需要的图，逐张标注来源（检索、生成、代码绘制）。若图要呈现特定产品、地点或场景本身而检索只能找到泛化替代品，且 `imageSource` 不是 `none`，用 `oil_ui_image` 生成；已有历史影像、材质、科学图版用 `oil_ui_media` 检索',
    nativeSatisfied: hasDirectionImagery,
  },
  {
    id: 'skill.direction-images',
    file: 'SKILL.md',
    requiredIn: [],
    optionalReason: '兼容 0.26 及更早版本的 Lite 多方向文案；0.27 单方向由共享规则处理。',
    match:
      /把每个方向用三四行写给用户：它给人什么感觉，首屏长什么样，(?:核心动作怎样完成，)?用什么字体和色彩，主视觉靠什么。/,
    replacement:
      '把每个方向用三四行写给用户：它给人什么感觉，首屏长什么样，核心动作怎样完成，用什么字体和色彩，主视觉靠什么；再列出首屏和关键区块需要的图，逐张标注来源（检索、生成、代码绘制）。若图要呈现特定产品、地点或场景本身而检索只能找到泛化替代品，且 `imageSource` 不是 `none`，用 `oil_ui_image` 生成；已有历史影像、材质、科学图版用 `oil_ui_media` 检索。',
    nativeSatisfied: hasDirectionImagery,
  },
  {
    id: 'skill.explore-images',
    file: 'references/task-explore.md',
    requiredIn: [],
    optionalReason: '0.27 起多方向探索迁移到独立模块；旧版本没有此文件。',
    match: /先用三四行写清每个方向的感觉、首屏、核心动作、字体、色彩和主视觉，附上推荐及理由/,
    replacement:
      '先用三四行写清每个方向的感觉、首屏、核心动作、字体、色彩和主视觉，再列出首屏和关键区块需要的图，逐张标注来源（检索、生成、代码绘制）。若图要呈现特定产品、地点或场景本身而检索只能找到泛化替代品，且 `imageSource` 不是 `none`，用 `oil_ui_image` 生成；已有历史影像、材质、科学图版用 `oil_ui_media` 检索。附上推荐及理由',
  },
  {
    id: 'skill.prototype-images',
    file: 'SKILL.md',
    requiredIn: [],
    optionalReason: '0.26 及更早版本的首屏素材规则仍保留在主文件，0.27 起由独立探索模块承接。',
    match: /主视觉靠图的方向，生成一张，至多重新生成一次；其余图位先用从页面取色的色块占着。/,
    replacement: '首屏对比图按方向卡中标注的来源准备；其余图位用代码占位。',
  },
  {
    id: 'skill.explore-prototype-images',
    file: 'references/task-explore.md',
    requiredIn: [],
    editions: ['lite'],
    optionalReason: '0.27 起多方向首屏素材规则迁移到独立模块；旧版本没有此文件。',
    match:
      /主视觉靠图的方向按 \[素材\]\(media\.md\) 生成一张，至多重新生成一次；页面已有专项候选流程时按专项，不重复增加生成批次。其余图位先用从页面取色的色块占着。/,
    replacement: '首屏对比图按方向卡中标注的来源准备；已有专项候选流程时按专项，其余图位用代码占位。',
  },
  {
    id: 'skill.compare',
    file: 'SKILL.md',
    requiredIn: ['lite', 'pro'],
    match: /用截图工具的 `--compare` 和参考图比对/g,
    replacement: '用 `oil_ui_shoot` 的 `compare` 参数和参考图比对',
  },
  {
    id: 'skill.evidence',
    file: 'SKILL.md',
    requiredIn: ['lite', 'pro'],
    match: /送评审前和交付前，/g,
    replacement: '送评审前和交付前，调用 `oil_ui_shoot` 取证，',
  },
  {
    id: 'skill.evidence.legacy',
    file: 'SKILL.md',
    requiredIn: [],
    optionalReason: 'Compatibility with pre-0.28 evidence wording.',
    match: /一条 `--evidence` 命令就能出齐/g,
    replacement: '调用 `oil_ui_shoot`（`evidence: true`）就能出齐',
  },
  {
    id: 'skill.pro-notice',
    file: 'SKILL.md',
    requiredIn: ['lite'],
    editions: ['lite'],
    match: /## 完整版提示\r?\n\r?\n[\s\S]*$/,
    replacement: `## 完整版提示\n\n首次使用开源版 \`oil-ui\` 时，\`oil_ui_skill_status\` 会返回非空的 \`recommendOnceNotice\`（状态写入 \`~/.local/state/oil-ui/recommended-oil-ui-pro\`，后续调用为 \`null\`）。仅当 \`recommendOnceNotice\` 非空时，在最终回复末尾按用户语言提示一次完整版 \`oil-ui-pro\`（https://ui.oiloil.org/pro/ ，英文对话用 https://ui.oiloil.org/en/pro/）；为 \`null\` 时不提，不在任务中途插入。\n`,
  },
  {
    id: 'skill.fallback-update-check',
    file: 'SKILL.md',
    requiredIn: [],
    optionalReason:
      'Fallback for standalone mentions in custom/minimal SKILL.md; the startup section normally consumes these.',
    match: /[^\r\n]*check_update\.sh[^\r\n]*/g,
    replacement: '先调用 `oil_ui_skill_status` 查看当前激活版本、版本更新提示与生图工具可用状态。',
  },
  {
    id: 'skill.fallback-shoot',
    file: 'SKILL.md',
    requiredIn: [],
    optionalReason:
      'Fallback for standalone mentions in custom/minimal SKILL.md; the startup section normally consumes these.',
    match: /`scripts\/shoot\.mjs`/g,
    replacement: '`oil_ui_shoot`',
  },
  {
    id: 'skill.fallback-media',
    file: 'SKILL.md',
    requiredIn: [],
    optionalReason:
      'Fallback for standalone mentions in custom/minimal SKILL.md; the startup section normally consumes these.',
    match: /`scripts\/curate-media\.mjs`/g,
    replacement: '`oil_ui_media`',
  },
  {
    id: 'skill.fallback-explorer',
    file: 'SKILL.md',
    requiredIn: [],
    optionalReason:
      'Fallback for standalone mentions in custom/minimal SKILL.md; the startup section normally consumes these.',
    match: /`scripts\/build_explorer\.py`/g,
    replacement: '`oil_ui_explorer`',
  },
  {
    id: 'tools.default-viewport',
    file: 'references/tools.md',
    requiredIn: ['lite', 'pro'],
    match: /默认 `390x844`|不写时是手机 390x844/g,
    replacement: '默认 `1440x900`',
  },
  {
    id: 'tools.intro',
    file: 'references/tools.md',
    requiredIn: ['lite', 'pro'],
    match: /^# 工具\r?\n\r?\n[\s\S]*?(?=\r?\n## 截图和录屏)/,
    replacement: '# 工具\n\n所有路径相对于当前工作目录解析。查看图片用 `read_image`，派发独立视觉评审用 `subagent`。',
  },
  {
    id: 'tools.native-commands',
    file: 'references/tools.md',
    requiredIn: ['lite', 'pro'],
    match: /### (?:常用命令|常用调用方式（`oil_ui_shoot`）)\r?\n\r?\n[\s\S]*?(?=\r?\n### 看结果)/,
    replacement: NATIVE_TOOL_COMMANDS_SECTION,
  },
  {
    id: 'tools.single-shot',
    file: 'references/tools.md',
    requiredIn: ['lite', 'pro'],
    match: /一条命令/g,
    replacement: '一次 `oil_ui_shoot` 调用',
  },
  {
    id: 'tools.evidence',
    file: 'references/tools.md',
    requiredIn: ['lite', 'pro'],
    match: /只在送评审之前、交付之前，/g,
    replacement: '只在送评审之前、交付之前，调用 `oil_ui_shoot`，',
  },
  {
    id: 'tools.evidence.legacy',
    file: 'references/tools.md',
    requiredIn: [],
    optionalReason: 'Compatibility with pre-0.28 evidence wording.',
    match: /用 `--evidence`(?= 一次取齐| 给选定画面生成)/g,
    replacement: '用 `oil_ui_shoot`（`evidence: true`）',
  },
  {
    id: 'tools.evidence-mask',
    file: 'references/tools.md',
    requiredIn: [],
    optionalReason: 'Compatibility with upstream versions that document single-state --mask evidence.',
    match: /单状态需要遮字图时加 `--mask`/g,
    replacement: '单状态需要遮字图时设 `mask: true`',
  },
  ...(['SKILL.md', 'references/tools.md'] as const).flatMap((file) =>
    ['frames', 'record', 'sheet', 'mask'].map((option): MarkdownRule => ({
      id: `${file === 'SKILL.md' ? 'skill' : 'tools'}.option.${option}`,
      file,
      requiredIn: [],
      optionalReason: 'Compatibility with inline options introduced in 0.28; older prose may omit them.',
      match: new RegExp('`--' + option + '`', 'g'),
      replacement: '`oil_ui_shoot` 的 `' + option + '` 参数',
    })),
  ),
  {
    id: 'tools.evidence-frames',
    file: 'references/tools.md',
    requiredIn: [],
    optionalReason: 'Compatibility with the frame-only evidence preset introduced in 0.28.',
    match: /`--evidence --frames <帧数>`/g,
    replacement: '`oil_ui_shoot`（`evidence: true, frames: <帧数>`）',
  },
  {
    id: 'tools.dom-hints',
    file: 'references/tools.md',
    requiredIn: ['lite', 'pro'],
    match: /命令输出里以“默认做法提示”列出/g,
    replacement: '`oil_ui_shoot` 返回的 `domHints` 与输出里以“默认做法提示”列出',
  },
  {
    id: 'tools.fallback-shoot',
    file: 'references/tools.md',
    requiredIn: [],
    optionalReason:
      'Fallback for inline CLI mentions outside the commands section; the section replacement normally consumes these.',
    match: /`node\s+[^\r\n`]*shoot\.mjs[^\r\n`]*`/g,
    replacement: '`oil_ui_shoot`',
  },
  {
    id: 'tools.fallback-media',
    file: 'references/tools.md',
    requiredIn: [],
    optionalReason:
      'Fallback for inline CLI mentions outside the commands section; the section replacement normally consumes these.',
    match: /`node\s+[^\r\n`]*curate-media\.mjs[^\r\n`]*`/g,
    replacement: '`oil_ui_media`',
  },
  {
    id: 'explorer.parameter-help',
    file: 'references/style-explorer.md',
    requiredIn: ['lite', 'pro'],
    match: /(?:每个字段的写法和限制见生成器的 `--help`。|其他字段写法见生成器的 `--help`。)/g,
    replacement: '字段与限制以 `oil_ui_explorer` 的参数说明及本页 manifest 示例为准。',
  },
  {
    id: 'explorer.generate',
    file: 'references/style-explorer.md',
    requiredIn: ['lite', 'pro'],
    match: /## 生成和打开\r?\n[\s\S]*?(?=\r?\n(?:有本机地址候选时|## |$))/,
    nativeSatisfied: (markdown) => /## 生成和打开\r?\n[\s\S]*?`oil_ui_explorer`/.test(markdown),
    replacement: `## 生成和打开

调用 \`oil_ui_explorer\` 生成对比页：

\`\`\`json
{
  "inputs": "explore",
  "out": "style-explorer.html"
}
\`\`\`

\`manifest\` 可传 JSON 对象、JSON 字符串或工作区内的清单文件路径；\`inputs\` 可传候选目录或多个 HTML 文件。目录内有 \`manifest.json\` 时会优先读取；没有时，目录中的 HTML 会组成候选。两者都不传时，工具会查找工作区中的 \`manifest.json\`、\`directions/manifest.json\`、\`explore/manifest.json\`，再尝试 \`a.html\`、\`b.html\`、\`c.html\`。对比页默认生成在工作区根目录的 \`style-explorer.html\`；再次调用会覆盖已有输出，改了候选后要重新调用生成。可用 \`out\` 指定输出路径，并从返回的 \`explorerUrl\` 打开预览。
`,
  },
  {
    id: 'explorer.shoot',
    file: 'references/style-explorer.md',
    requiredIn: ['lite', 'pro'],
    match: /`node <skill>\/scripts\/shoot\.mjs <manifest 所在目录> --size desktop --thumb --out shots\/explore`/g,
    replacement: '`oil_ui_shoot({ "target": "explore", "size": "desktop", "thumb": true, "out": "shots/explore" })`',
  },
  {
    id: 'media.sheet',
    file: 'references/media.md',
    requiredIn: ['lite', 'pro'],
    match: /`--sheet`/g,
    replacement: '`oil_ui_media` 的 `sheet: true`',
  },
  {
    id: 'media.direction-source',
    file: 'references/media.md',
    requiredIn: ['lite', 'pro'],
    match: /- \*\*没有就做出来。\*\*[\s\S]*?(?=\r?\n- \*\*需要随操作实时变形的实物)/,
    replacement:
      '- **先在方向阶段确定来源。** 每个方向列出首屏和关键区块需要的图，并逐张标注来源：检索、生成或代码绘制。`imageSource` 不是 `none` 时，若图要呈现特定产品、地点或场景本身而检索只能找到泛化替代品，用 `oil_ui_image` 生成；已有历史影像、材质、科学图版用 `oil_ui_media` 检索。',
  },
  {
    id: 'layout.compare',
    file: 'references/layout-and-viewport.md',
    requiredIn: ['lite', 'pro'],
    match: /截图工具的 `--compare`/g,
    replacement: '`oil_ui_shoot` 的 `compare` 参数',
  },
  {
    id: 'review.new-interface',
    file: 'references/visual-review.md',
    requiredIn: ['lite', 'pro'],
    match: /请读取 references\/reviewer-manual\.md，按照【全新界面与改版评审】标准/g,
    replacement: '按照你系统提示词中已内置的《视觉与交互评审手册》【全新界面与改版评审】标准',
  },
  {
    id: 'review.existing-interface',
    file: 'references/visual-review.md',
    requiredIn: ['lite', 'pro'],
    match: /请读取 references\/reviewer-manual\.md，按照【存量已有界面润色评审】标准/g,
    replacement: '按照你系统提示词中已内置的《视觉与交互评审手册》【存量已有界面润色评审】标准',
  },
  {
    id: 'review.dispatch',
    file: 'references/visual-review.md',
    requiredIn: ['lite', 'pro'],
    match: /模板里的路径换成本 Skill 目录下的绝对路径：子 Agent 的工作目录不是本目录。/g,
    replacement:
      '子 Agent 启动时已由插件自动将《视觉与交互评审手册》（`references/reviewer-manual.md`）注入其系统提示词，主 Agent 只需调用 `subagent` 传入下方交接清单与对应模式指令，无需附带手册路径，也无需让子 Agent 再次读取手册。',
  },
  {
    id: 'ux-review.paths',
    file: 'references/ux-review.md',
    requiredIn: [],
    optionalReason:
      'Lightweight UX walkthrough dispatch exists only in Skill versions that include references/ux-review.md.',
    match: /模板路径换成本 Skill 目录下的绝对路径。/g,
    replacement:
      '子 Agent 启动时系统提示词中已自动注入本目录（`references/`）的绝对路径，主 Agent 直接使用上述模板即可，子 Agent 可按该路径读取 `ux-reviewer.md`。',
  },
  {
    id: 'reviewer.legacy-thumbnail',
    file: 'references/reviewer-manual.md',
    requiredIn: [],
    optionalReason: 'Compatibility with previously compiled manuals that used a narrow viewport.',
    match:
      /能用 `oil_ui_shoot` 时，用它出缩略图（`size: "480x300"` 或 `"180x390"`）和遮字图（`mask: true`），并用 `read_image` 查看截图。/g,
    replacement:
      '能用 `oil_ui_shoot` 时，保持原始桌面或手机视口截图，再按原比例缩放到 480px 或 180px 宽；遮字图用 `mask: true`，并用 `read_image` 查看。',
  },
  {
    id: 'reviewer.thumbnail',
    file: 'references/reviewer-manual.md',
    requiredIn: ['lite', 'pro'],
    match: /能用截图工具时，用它出缩略图和遮字图。/g,
    replacement:
      '能用 `oil_ui_shoot` 时，用它出缩略图（保持桌面或手机的原始视口截图，再按原比例缩放到 480px 或 180px 宽，不能改成窄视口重新截图）和遮字图（`mask: true`），并用 `read_image` 查看截图。',
  },
  {
    id: 'reviewer.play-link',
    file: 'references/reviewer-manual.md',
    requiredIn: ['lite', 'pro'],
    match: /\[游玩\]\(play\.md\)/g,
    replacement: '[游玩](references/play.md)',
  },
];

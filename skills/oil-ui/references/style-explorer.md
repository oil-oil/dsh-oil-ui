# 风格对比页

把几个候选放在同一页里并排比较，由用户挑选。用户可以并排或单张查看、按实际尺寸看、选定并复制方向。对比页的外壳只负责比较和挑选，不带风格倾向，也不作为候选的参考。

几个候选的核心内容、主要动作和目标用户保持一致，变的是构图、信息怎么组织、字体的气质、色彩关系、疏密和用图的方式。放几个候选，看用户要几个、真正有差别的有几个；不复制整个产品来凑数。

## 准备输入

一轮只生成一个对比页。候选能跑就用真实页面：单独写的 HTML 小样直接嵌入，项目里的方案用本机地址，拿不到可运行的页面时才用截图。每个方案一个画面：存量项目选入口或差别最大的那一步，整站方案只放代表页。

把候选 HTML 放进一个目录后传目录，也可以直接传几个 HTML 文件。显示名取 `<title>`，没有标题时取文件名。同目录有 `manifest.json` 时会读取它补充方向信息；没有 manifest 也能生成。

最小的 `manifest.json`：

```json
{
  "candidates": [
    {"source": "a.html"},
    {"source": "b.html"}
  ]
}
```

| 特殊情况 | 在 manifest 里加 |
| --- | --- |
| 固定画布的界面 | 顶层或候选里加 `"nativeViewport": "宽x高"` |
| 自己写的可操作小样 | 候选加 `"interactive": true` |
| 需要启动服务才能看的页面 | 候选加 `"kind": "url"` 和本机 `url`；顶层可加 `serve` 启动说明 |
| 改动已有页面 | 把现状也放进来，并加 `"baseline": true` |
| 只有截图 | 候选加 `"kind": "image"`，`source` 指向截图 |

HTML 和图片候选只需填写 `source`；本机地址候选按上表填写 `url`。候选来自方向卡时，每个候选再填 `name`、`concept`（北极星那一句）、`typography`、`palette`（色值数组）和 `traits`，对比页把它们和画面一起展示，用户靠这些挑选；省略的项不显示。字段与限制以 `oil_ui_explorer` 的参数说明及本页 manifest 示例为准。

## 生成和打开

调用 `oil_ui_explorer` 生成对比页：

```json
{
  "inputs": "explore",
  "out": "style-explorer.html"
}
```

`manifest` 可传 JSON 对象、JSON 字符串或工作区内的清单文件路径；`inputs` 可传候选目录或多个 HTML 文件。目录内有 `manifest.json` 时会优先读取；没有时，目录中的 HTML 会组成候选。两者都不传时，工具会查找工作区中的 `manifest.json`、`directions/manifest.json`、`explore/manifest.json`，再尝试 `a.html`、`b.html`、`c.html`。对比页默认生成在工作区根目录的 `style-explorer.html`；再次调用会覆盖已有输出，改了候选后要重新调用生成。可用 `out` 指定输出路径，并从返回的 `explorerUrl` 打开预览。

有本机地址候选时，交付时让开发服务器开着。用户之后说“打开对比页”：读 manifest 里的 `serve`，在 `cwd` 里后台运行 `command`，等 `url` 能访问了再打开对比页。

## 记录选择

用户点“选择”会复制一句话，例如“<轮次>：选 03 <方向名>”。用户粘贴它或直接说出选择后，按轮次和编号对照当前 manifest，确认是这一轮的，把选择和备注更新到设计说明，再回到生成这个对比页的流程接着做。对比页不会写回任何文件，也不会自动给 Agent 发消息。

交付前对候选目录跑一次 `oil_ui_shoot({ "target": "explore", "size": "desktop", "thumb": true, "out": "shots/explore" })`（一次出齐各候选缩略图与并排总览图 `sheet.png`）核对候选：每张画面和 manifest 里写的页面、状态、视口一致，中文字体真实渲染出来了。判断文字大小和细节时用单张查看的“实际尺寸 100%”，适应窗口的缩小图不能当作可读性通过。对比页本身的功能由 Skill 自带的测试保证，任务里不验证、不读模板源码。

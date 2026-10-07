CLAUDE
----

这是一个快速通过http服务分享且美化markdown、mermaid文档的工具。 不需要浏览器安装任何插件即可看到markdown、mermaid渲染后的效果。
非常适合在团体、企业内部快速进行文档交流、方案讨论等场合使用，关键是使用时不要求连接互联网。

## my-exp MCP经验库
如果是编码、调试等工作遇到困难，可以连接my-exp经验库（MCP server），检查一下有没有相关经验。
在解决难点、难题等复杂问题的过程中，如果发现新的可以反复利用的经验、方法，记得总结下来，在经验库连着的前提下就保存下来，没有的话就先落盘本地并提示用户。
在每个计划结束的时刻，也是一个总结经验的好时机。

## TODO-List
1. 增加通过页面配置发布内容，现在只能通过config.json中配置。
2. ~~增加更多mermaid图表格式的渲染支持。~~ 已完成（v0.1）：内嵌 Mermaid 11 引擎，正文里的
   mermaid 围栏与整篇图表的 `.mermaid` 文件都会画成图，`stateDiagram` / `stateDiagram-v2`
   等引擎支持的全部版式；离线版按需内联引擎，实时版本地外链。详见 README「嵌入 Mermaid 图表」。
3. 用electronbun等打包工具打包。
4. 跨文档引用支持 Markdown 链接里的纯数字锚点（`[文字](docs/x.md#4.1)`），现在只支持
   `` `docs/x.md` §4.1 `` 与文首声明别名后的 `父文档 §4.1` 两种写法。
5. 图表观感已做「文档风」默认值（`mermaid.style: "doc"`：圆角状态胶囊、1.6px 描边与连线、
   不透明灰底标签、小三角箭头；`plain` 可退回 mermaid 原样）。剩下的差距在**布局**：
   mermaid 内置 dagre 的 `rankdir/ranker` 写死（`state` 段没有 nodeSpacing/rankSpacing），
   跨列回边与斜向主干改不了；要更接近 Graphviz 那种平铺效果只能调整图源结构
   （少一条跳级边、主干少串一级），或引入 elk 布局（只对 flowchart 生效，不划算）。

## 图表渲染的坑（改 `assets/md-app.js` 里 mg* 那一段前先看）
- mermaid 生成的主题 CSS 带 `#<图id>` 前缀、整段重写，**注入的样式必须加 `!important`**，
  否则被它压回去；注入位置是这张图自己的 `<style>` 末尾，导出 SVG 时会一起带走。
- **不要改边标签的 `font-size` / `padding` / `line-height`**：`foreignObject` 的宽高是引擎按
  自己的字号量出来的，改了就把标签切掉一半（看着像"少字"）。字号统一走 `themeVariables.fontSize`。
  要做留白就用 `mgPadLabels()` 从渲染尺寸反推，改 `width/height` 与 `<g class="label">` 的 transform。
- 状态图的边标签**没有** svg `rect`，底片其实是 `foreignObject` 里那个 div 的背景色；
  把那个 div 设成透明，连线会直接穿过文字。流程图两种都有。
- `test/mermaid-style-ui.mjs` 专门盯这些（29 项断言），改完必跑。

## ERROR
（跨文档引用误跳问题已修复：裸 `§4.3` 只指本文档，「父文档 §4.3」按文首声明跳到父文档；
目标里没有该编号时降级到目标文档顶部并标 missing。详见 README「跨文档章节引用」。）

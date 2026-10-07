测试与调试脚本
====

这些脚本都是**辅助工具**，不参与页面运行，删掉也不影响浏览文档。

## 纯 Node，不需要浏览器

| 脚本 | 作用 | 命令 |
| --- | --- | --- |
| `verify-render.mjs` | 渲染器回归。读 `assets/md-core.js`（页面外链的渲染器源码），渲染 `docs/` 与 `test/fixtures/` 下全部 markdown，与独立写的源码扫描器交叉验证，并对每个表格逐格比对 | `node test/verify-render.mjs` |
| `verify-mindmap.mjs` | 思维导图解析回归。读 `assets/mindmap-core.js`，对 `docs/**/*.mermaid` 与 `test/fixtures/mindmap/*.mermaid` 验证层级、形状、tab/CRLF/注释边界、Markdown 转义，并用独立写的缩进扫描器交叉验证节点数与层数；`.mermaid` 里写成 `stateDiagram-v2` 这类别的版式的文件会被识别出来、交给 Mermaid 那条路（不做导图断言） | `node test/verify-mindmap.mjs` |
| `verify-mermaid.mjs` | 嵌入 Mermaid 图表回归。读 `assets/mermaid-core.js` 与 `assets/md-core.js`：围栏识别（大小写、`~~~`、`{.mermaid}`、附加信息串、`mermaidfoo` 不认）、版式判定（先长后短、跳过注释/`%%{init}%%`/前置配置块）、块标记与工具栏开关、源码 HTML 转义后能逐字还原、`normalize` 的 BOM/CRLF/缩进处理、md-core 的接线（传与不传 `ctx.mermaid` 两条路）、`test/fixtures/mermaid/*.md` 逐条跑、以及产物里引擎是否按需内联 | `node test/verify-mermaid.mjs` |
| `check-snapshot.mjs` | 产物完整性：内置快照可解析、`</script>` 已转义、条目字段齐全（含 `kind`）、思维导图正文有 `mindmap` 声明（整篇图表的 `.mermaid` 例外）、索引不带正文且与快照一致、引擎块「内联 / `data-disabled` / `data-unused`」三种状态都合法、`assets/` 外链脚本存在 | `node test/check-snapshot.mjs` |
| `check-viewer.mjs` | 页面自检：`page.template.html` 标签配对与占位块是否为空、外链资源齐全、CSS 括号平衡与关键声明、离线产物里 JSON 可解析且引擎已内联（或按需留空块）、脚本语法（`assets/` 四段 + 内联引擎）、关键 JS 钩子 | `node test/check-viewer.mjs` |
| `check-realtime.mjs` | 实时版页面 `index.html`：四个引擎都是本地外链且块内无残留源码、内置快照已置空、**没有任何互联网资源引用**、引用的本地文件都真实存在、外壳与模板一致 | `node test/check-realtime.mjs` |
| `why-stale.mjs` | 诊断 `--check` 为什么说过期：逐条列出「新增 / 有变化 / 已删除」的文档 | `node test/why-stale.mjs [目录]` |
| `cli-args.mjs` | 命令行参数回归：`--docs` / 未知参数 / 多余目录 / 不存在的目录 / 坏端口 / 坏监听地址（`--host` 缺值、带端口、非法地址、重复、与 `--lan` 混用、没配 `--serve`）/ `--serve` 与 `--check` 混用都必须报错退出，而位置目录写法要真的生效（末尾会用默认 `docs/` 重建产物） | `node test/cli-args.mjs` |
| `serve-smoke.mjs` | 实时模式冒烟：`/` 重定向到实时版 `index.html`、实时版引擎外链且零外部资源、离线版仍可访问、全部本地资源可取、索引、每篇文档正文（`.md` → text/markdown，`.mermaid` → text/plain）、目录穿越拦截、404/204，并核对跑完以后文档目录的文件清单与 mtime 没变（只读保证） | `node test/serve-smoke.mjs [目录]` |
| `serve-host.mjs` | 监听地址回归：默认只绑 `127.0.0.1`（本机 IP 连不上、也不打印局域网地址）、`--lan` 真的绑到所有网卡（从本机 IP 回连成功并打印该地址）、`--host <本机IP>` 只绑这个地址、`--host <不存在的地址>` 立刻报错退出 | `node test/serve-host.mjs` |
| `serve-port.mjs` | 端口顺延回归：端口被占用（含 Windows 上被独占监听、即报 `EACCES` 的情况）必须顺延并在启动信息里印真实端口，**不许再把它说成「小于 1024 需要管理员权限」**；`--port 80` 这类特权端口要么明确报权限、要么真能绑，不许静默顺延；Windows 的系统预留端口段（`netsh excludedportrange`）顺延不动时须报「连续 N 个端口都绑不上」 | `node test/serve-port.mjs` |

以上十一个纯 Node 脚本就是 `npm test`（会先跑一次 `node build-docs.mjs` 保证产物是新的）。改动 `page.template.html`、`assets/` 下的样式或脚本、或文档之后先跑它们，几秒内能发现大部分低级错误。

`verify-render.mjs` 会产生 `test/.cache/`（复制一份 `md-core.cjs` 与 `md-app.js` 供排查），已加入 `.gitignore`。

## 需要能启动浏览器

| 脚本 | 作用 | 命令 |
| --- | --- | --- |
| `ui-verify.mjs` | 界面回归。用无头 Chrome + CDP 跑 40 项左右断言：默认状态、两侧栏开关与 `✕`、快捷键、状态记忆、窄屏抽屉与遮罩、实时模式、改 `config.json` 即时生效、配置写错时的降级提示、全程无 console 错误。**自己拉起 `--serve` 实例并自动收尾** | `node test/ui-verify.mjs` |
| `xref-ui.mjs` | 跨文档章节引用界面回归（21 项断言）：文首声明变成「引用目标」徽标、声明行不进正文也不污染左栏摘要、「父文档 §4.3」真的跳到父文档的 4.3 且落点闪烁、`` `docs/父文档.md` §1.1 `` 零声明写法、目标里没有该编号时降级到目标文档顶部并标 `missing`、裸 `§4.3` 仍指本文档。**自己搭临时文档目录起 `--serve`，跑完删临时目录并用默认 `docs/` 重建产物** | `node test/xref-ui.mjs` |
| `mindmap-ui.mjs` | 思维导图界面回归（40 项断言）：左栏「导图」标记、画布真的画出节点且中文不是实体、点节点折叠并同步到大纲、大纲三角折叠与文字跳转、全屏按钮（铺满窗口 / 盖住顶栏 / 锁滚动 / `Esc` 还原 / 换文档解锁）、导出 SVG/PNG 的 Blob 内容与类型、深色主题重新上色、关掉 `mindmap.enabled` 后退回普通文本。**自己拉起 `--serve` 实例、临时改 `config.json` 后一定会还原** | `node test/mindmap-ui.mjs` |
| `mermaid-ui.mjs` | 嵌入 Mermaid 图表界面回归（41 项断言）：图表块数与文档里的围栏数一致、每块都画出 SVG 且尺寸正常、中文标签不是实体、故意的语法错只影响那一块（错误框 + 自动摊开源码）、工具栏（源码展开收起 / 复制到剪贴板 / 导出 SVG 的 XML 头与底色 / 全屏铺满 + 锁滚动 + `Esc` 还原）、深色主题重画且底色跟着变、`.mermaid` 里写 `stateDiagram-v2` 按「图表」渲染（左栏标记与右栏标题同步）、原 mindmap 文档不受影响、关掉 `mermaid.enabled` 后围栏退回普通代码块。**自己拉起 `--serve` 实例、临时改 `config.json` 后一定会还原**；默认测离线版，加 `--realtime` 测引擎外链的实时版 | `node test/mermaid-ui.mjs [--realtime]` |
| `mermaid-style-ui.mjs` | Mermaid「文档风」样式回归（29 项断言，基准文档 `docs/示例/状态图版式对照.md`）：`style=doc` 时状态图圆角 10px / 节点描边 1.6px / 连线 1.6 / 标签底片不透明浅灰 / 箭头 marker 缩到 13×11、流程图也套同一套线宽；**标签不被截字**（`foreignObject` 装得下渲染出来的文字 —— 在注入 CSS 里改边标签 `font-size`/`padding` 就会踩这条）；`style=plain` 完全不注入样式段并退回 mermaid 原样；深色下底色跟着换而线宽不变；导出的 SVG 自带这套样式且 marker 引用仍有效；关掉 `mermaid.enabled` 后不再生成图表块。**自己拉起 `--serve` 实例、临时改 `config.json` 后一定会还原** | `node test/mermaid-style-ui.mjs` |
| `shot-anim.mjs` | 视觉/几何抽查（不做断言，只打印量化结果 + 截图）：侧栏收起是否逐帧渐变、有没有横向滚动条、右栏列表有没有被滚动条截断、滚动后侧栏是否仍粘在顶栏下、正文入场动画名 | `node test/shot-anim.mjs` |

浏览器路径默认取 Windows 上的 Chrome，可用环境变量覆盖：

```powershell
$env:CHROME = "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

截图输出到 `test/shots/`（已加入 `.gitignore`）。

> 注意：在受限沙箱里启动 Chrome 可能被拒绝（浏览器内部需要命名管道 IPC）。
> 这类环境请手工打开页面检查，或给脚本放宽权限后运行。

## 加新用例时

- 渲染器的坑（表格边界、缩进代码块、嵌套列表、转义）请加成 `test/fixtures/*.md`，
  而不是塞进断言字符串里 —— 这样它们同时会被逐格比对覆盖。
- 思维导图的坑（各种节点形状、tab 混用、注释、CRLF、空文件）请加成
  `test/fixtures/mindmap/*.mermaid`，`verify-mindmap.mjs` 会把该目录下的用例逐条跑一遍。
  注意该目录只收 `.mermaid`，不会被 markdown 的回归顺手扫到。
- 嵌入图表的坑（围栏变体、缩进/引用块里的围栏、未闭合围栏、源码里的尖括号与转义）请加成
  `test/fixtures/mermaid/*.md`，`verify-mermaid.mjs` 会逐条跑，`verify-render.mjs` 也会顺手扫到
  （它们同时是普通 markdown，不传 `ctx.mermaid` 时必须是普通代码块）。
- fixtures 里的文档路径统一是 `docs/fixtures/xxx.md`，因此 fixture 之间可以互相引用，
  用来验证 `§x.y` 章节引用与 `` `docs/xxx.md` `` 跨文档链接。
- 跨文档章节引用用 `fixtures/父文档.md` + `fixtures/子文档-引用父文档.md` 这一对：
  子文档里自带一个 4.3，专门用来证明「父文档 §4.3」不会再误跳到本文档。加新写法时请同时
  补 `verify-render.mjs` 的断言与 `xref-ui.mjs` 的浏览器断言（含"目标里没有该编号"的兜底分支）。

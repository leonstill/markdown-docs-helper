测试与调试脚本
====

这些脚本都是**辅助工具**，不参与页面运行，删掉也不影响浏览文档。

## 纯 Node，不需要浏览器

| 脚本 | 作用 | 命令 |
| --- | --- | --- |
| `verify-render.mjs` | 渲染器回归。读 `assets/md-core.js`（页面外链的渲染器源码），渲染 `docs/` 与 `test/fixtures/` 下全部 markdown，与独立写的源码扫描器交叉验证，并对每个表格逐格比对 | `node test/verify-render.mjs` |
| `verify-mindmap.mjs` | 思维导图解析回归。读 `assets/mindmap-core.js`，对 `docs/**/*.mermaid` 与 `test/fixtures/mindmap/*.mermaid` 验证层级、形状、tab/CRLF/注释边界、Markdown 转义，并用独立写的缩进扫描器交叉验证节点数与层数 | `node test/verify-mindmap.mjs` |
| `check-snapshot.mjs` | 产物完整性：内置快照可解析、`</script>` 已转义、条目字段齐全（含 `kind`）、思维导图正文有 `mindmap` 声明、索引不带正文且与快照一致、内联引擎块非空、`assets/` 外链脚本存在 | `node test/check-snapshot.mjs` |
| `check-viewer.mjs` | 页面自检：`page.template.html` 标签配对与占位块是否为空、外链资源齐全、CSS 括号平衡与关键声明、离线产物里 JSON 可解析且引擎已内联、脚本语法（`assets/` 三段 + 内联引擎）、关键 JS 钩子 | `node test/check-viewer.mjs` |
| `check-realtime.mjs` | 实时版页面 `index.html`：三个引擎都是本地外链且块内无残留源码、内置快照已置空、**没有任何互联网资源引用**、引用的本地文件都真实存在、外壳与模板一致 | `node test/check-realtime.mjs` |
| `why-stale.mjs` | 诊断 `--check` 为什么说过期：逐条列出「新增 / 有变化 / 已删除」的文档 | `node test/why-stale.mjs [目录]` |
| `cli-args.mjs` | 命令行参数回归：`--docs` / 未知参数 / 多余目录 / 不存在的目录 / 坏端口 / `--serve` 与 `--check` 混用都必须报错退出，而位置目录写法要真的生效（末尾会用默认 `docs/` 重建产物） | `node test/cli-args.mjs` |
| `serve-smoke.mjs` | 实时模式冒烟：`/` 重定向到实时版 `index.html`、实时版引擎外链且零外部资源、离线版仍可访问、全部本地资源可取、索引、每篇文档正文（`.md` → text/markdown，`.mermaid` → text/plain）、目录穿越拦截、404/204，并核对跑完以后文档目录的文件清单与 mtime 没变（只读保证） | `node test/serve-smoke.mjs [目录]` |

以上八合一就是 `npm test`（会先跑一次 `node build-docs.mjs` 保证产物是新的）。改动 `page.template.html`、`assets/` 下的样式或脚本、或文档之后先跑它们，几秒内能发现大部分低级错误。

`verify-render.mjs` 会产生 `test/.cache/`（复制一份 `md-core.cjs` 与 `md-app.js` 供排查），已加入 `.gitignore`。

## 需要能启动浏览器

| 脚本 | 作用 | 命令 |
| --- | --- | --- |
| `ui-verify.mjs` | 界面回归。用无头 Chrome + CDP 跑 40 项左右断言：默认状态、两侧栏开关与 `✕`、快捷键、状态记忆、窄屏抽屉与遮罩、实时模式、改 `config.json` 即时生效、配置写错时的降级提示、全程无 console 错误。**自己拉起 `--serve` 实例并自动收尾** | `node test/ui-verify.mjs` |
| `mindmap-ui.mjs` | 思维导图界面回归（40 项断言）：左栏「导图」标记、画布真的画出节点且中文不是实体、点节点折叠并同步到大纲、大纲三角折叠与文字跳转、全屏按钮（铺满窗口 / 盖住顶栏 / 锁滚动 / `Esc` 还原 / 换文档解锁）、导出 SVG/PNG 的 Blob 内容与类型、深色主题重新上色、关掉 `mindmap.enabled` 后退回普通文本。**自己拉起 `--serve` 实例、临时改 `config.json` 后一定会还原** | `node test/mindmap-ui.mjs` |
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
- fixtures 里的文档路径统一是 `docs/fixtures/xxx.md`，因此 fixture 之间可以互相引用，
  用来验证 `§x.y` 章节引用与 `` `docs/xxx.md` `` 跨文档链接。

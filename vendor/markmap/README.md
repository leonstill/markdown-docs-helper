# vendor/markmap —— 内置的思维导图渲染引擎

这里是 [markmap](https://github.com/markmap/markmap) 的浏览器构建产物，用于把 `.mermaid`
（`mindmap` 版式）渲染成可缩放、可折叠的思维导图。

**为什么要放进仓库**：本工具承诺「不联网也能用」，`file://` 页面又无法加载外部脚本。
所以构建时这两个限制要分开处理 —— `build-docs.mjs` 把这三个文件填进
`page.template.html` 的三个引擎占位块：

| 产物 | 填法 | 原因 |
| --- | --- | --- |
| `md-viewer.html`（离线版） | 整段内联源码 | `file://` 加载不了外部脚本，双击要能直接看 |
| `index.html`（实时版） | `<script src="vendor/markmap/*.js">` 本地外链 | 走 http，可缓存、可并行下载，页面只有几 KB |

两种填法都只读工程内的本地文件，运行时不发出任何网络请求（不改用 CDN，也不需要 `npm install`）。

| 文件 | 来源包 | 版本 | 说明 |
| --- | --- | --- | --- |
| `d3.min.js` | `d3` | 7.9.0 | 布局与缩放（`dist/d3.min.js`），挂到 `window.d3`。**必须在 markmap-view 之前加载** |
| `markmap-lib.iife.js` | `markmap-lib` | 0.18.12 | Markdown → 思维导图数据（`dist/browser/index.iife.js`），挂到 `window.markmap.Transformer` |
| `markmap-view.browser.js` | `markmap-view` | 0.18.12 | SVG 渲染与交互（`dist/browser/index.js`），挂到 `window.markmap.Markmap`；它是 `(this.markmap, d3)` 形式的 IIFE，**依赖全局 `d3`** |
| `LICENSE` / `LICENSE-d3` | markmap / d3 | — | 均为 MIT（markmap 版权归 Gerald，d3 版权归 Mike Bostock） |

`build-docs.mjs` 里的 `BUNDLES` 数组决定了顺序：**d3 在最前，markmap-view 在最后**，
顺序颠倒会直接抛 `d3 is not defined`。模板 `page.template.html` 里对应三个同 id 的空占位块，
加/减引擎时改 `BUNDLES` 与模板占位块即可（`test/check-snapshot.mjs`、`test/check-realtime.mjs`
都直接读 `BUNDLES`，不会各写一份清单）。

## 升级方式

```powershell
# 取包并解压（npm registry 直连，不需要 npm install）
$v = '0.18.12'
Invoke-WebRequest "https://registry.npmjs.org/markmap-lib/-/markmap-lib-$v.tgz"  -OutFile lib.tgz
Invoke-WebRequest "https://registry.npmjs.org/markmap-view/-/markmap-view-$v.tgz" -OutFile view.tgz
Invoke-WebRequest "https://registry.npmjs.org/d3/-/d3-7.9.0.tgz" -OutFile d3.tgz
tar -xzf lib.tgz;  Copy-Item package/dist/browser/index.iife.js vendor/markmap/markmap-lib.iife.js  -Force
tar -xzf view.tgz; Copy-Item package/dist/browser/index.js      vendor/markmap/markmap-view.browser.js -Force
tar -xzf d3.tgz;   Copy-Item package/dist/d3.min.js            vendor/markmap/d3.min.js -Force
node build-docs.mjs      # 重新填进 md-viewer.html（内联）
node build-docs.mjs --serve   # 顺带刷新实时版 index.html（外链），验证完 Ctrl+C
```

升级后请跑 `npm test`（含 `test/check-realtime.mjs`：外链文件是否存在、页面是否零外部资源），
并在浏览器里打开一篇 `.mermaid` 确认渲染正常（`node test/mindmap-ui.mjs` 会自动做这件事）。

## 关于「离线」

markmap 只在**用到了对应语法**时才去 CDN 取资源：数学公式（KaTeX）、代码高亮
（highlight.js / Prism）。本工具把 `.mermaid` 转成纯文本大纲，不含这些语法，
因此实际运行不会请求任何外部资源。若以后要支持公式，需要把这些资源也一并本地化，
否则离线打开会显示为纯文本。

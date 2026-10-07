# vendor/mermaid —— 内置的 Mermaid 图表引擎

这里是 [mermaid](https://github.com/mermaid-js/mermaid) 的浏览器构建产物（`dist/mermaid.min.js`，
UMD 版，挂到 `window.mermaid`），用于把 Markdown 正文里的 ` ```mermaid ` 围栏、
以及 `.mermaid` 文件里 mindmap 以外的版式（`stateDiagram-v2`、`flowchart`、`sequenceDiagram`…）
画成 SVG。

**为什么要放进仓库**：本工具承诺「不联网也能用」，`file://` 页面又加载不了外部脚本，
而 mermaid 官方推荐的 ESM 用法需要打包器。这个 UMD 单文件正好两头都满足：整段内联后
双击 `md-viewer.html` 就能画图，实时版则走本地外链，页面不背这 3 MB。

| 文件 | 来源包 | 版本 | 说明 |
| --- | --- | --- | --- |
| `mermaid.min.js` | `mermaid` | 11.15.0 | `dist/mermaid.min.js`，3.2 MB，挂到 `window.mermaid` |
| `LICENSE` | mermaid | — | MIT（版权归 Knut Sveidqvist 与贡献者） |

## 填法（构建脚本负责）

`build-docs.mjs` 的 `BUNDLES` 里最后一项是 `vendor-mermaid`，对应
`page.template.html` 里的 `<script id="vendor-mermaid"></script>`：

| 产物 | 填法 | 原因 |
| --- | --- | --- |
| `md-viewer.html`（离线版） | 整段内联源码 | `file://` 加载不了外部脚本，双击要能直接看 |
| `index.html`（实时版） | `<script src="vendor/mermaid/mermaid.min.js">` 本地外链 | 走 http，可缓存；页面只有几 KB |

两种填法都只读工程内的本地文件，运行时不发出任何网络请求（不改用 CDN，也不需要 `npm install`）。

**按需内联**：离线版只在「这次构建的文档里真的出现了 Mermaid 图表」时才内联这 3 MB
（判断规则来自 `assets/mermaid-core.js`：`.md` 看有没有 ` ```mermaid ` 围栏，
`.mermaid` 看整篇是不是 mindmap 以外的版式）。没用到时留一个空块并标 `data-unused="1"`，
`md-viewer.html` 仍是 1 MB 上下；页面侧靠「`window.mermaid` 在不在」自行降级，
所以不会白屏。`config.json` 里 `mermaid.enabled = false` 时留空块并标 `data-disabled="1"`，
围栏退回普通代码块。

## 升级方式

```powershell
# 从 npm registry 取包并解压（不需要 npm install）
$v = '11.15.0'
Invoke-WebRequest "https://registry.npmjs.org/mermaid/-/mermaid-$v.tgz" -OutFile mermaid.tgz
tar -xzf mermaid.tgz
Copy-Item package/dist/mermaid.min.js vendor/mermaid/mermaid.min.js -Force
Copy-Item package/LICENSE            vendor/mermaid/LICENSE            -Force
node build-docs.mjs            # 重新填进 md-viewer.html（内联）
node build-docs.mjs --serve    # 顺带刷新实时版 index.html（外链），验证完 Ctrl+C
```

没网时可从本机 npm 缓存里直接取（`_npx` / `_cacache` 下解出来的 node_modules 里就有
`node_modules/mermaid/dist/mermaid.min.js`），不必联网。

升级后请跑 `npm test`，再用 `node test/mermaid-ui.mjs`（含 `--realtime`）在真实浏览器里
过一遍状态图、其它版式、工具栏与导出。

## 检查清单（换版本时值得先确认）

1. `mermaid.min.js` 里**没有** `</script`（否则无法安全内联，构建会直接报错）；
2. 仍然暴露全局 `window.mermaid`，且有 `initialize` / `render`；
3. 支持 `initialize({ suppressErrorRendering: true })`（否则语法错时 mermaid 会自己往
   页面里塞一张错误图，我们的错误框会重复）；
4. `stateDiagram-v2` 渲染出的节点/转移 class 没变（`test/mermaid-ui.mjs` 会数节点和连线）。

## 关于「离线」与安全

- mermaid 只在图里用到**图标 / 表情 / 字体**时才可能去取外部资源；本工具的示例与常规用法
  不涉及，因此运行时零外部请求（`test/check-viewer.mjs` 会守住「页面里没有任何互联网 src/href」）。
- `config.json` 的 `mermaid.securityLevel` 默认 `strict`：图表标签里的 HTML 会被转义，
  与「正文不解析原始 HTML」的立场一致。标签里确实需要 `<br/>` 换行时，文档可信的前提下
  才改成 `loose`。

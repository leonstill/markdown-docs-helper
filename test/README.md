测试与调试脚本
====

这些脚本都是**辅助工具**，不参与页面运行，删掉也不影响浏览文档。

## 纯 Node，不需要浏览器

| 脚本 | 作用 | 命令 |
| --- | --- | --- |
| `verify-render.mjs` | 渲染器回归。把 `md-viewer.html` 里的 `md-core` 抽出来，渲染 `docs/` 与 `test/fixtures/` 下全部 markdown，与独立写的源码扫描器交叉验证，并对每个表格逐格比对 | `node test/verify-render.mjs` |
| `check-snapshot.mjs` | 产物完整性：内置快照可解析、`</script>` 已转义、条目字段齐全、索引不带正文且与快照一致 | `node test/check-snapshot.mjs` |
| `check-viewer.mjs` | 页面自检：标签配对、CSS 括号平衡与关键声明、两段 JSON 可解析、内联脚本语法、关键 JS 钩子 | `node test/check-viewer.mjs` |
| `why-stale.mjs` | 诊断 `--check` 为什么说过期：逐条列出「新增 / 有变化 / 已删除」的文档 | `node test/why-stale.mjs [目录]` |
| `cli-args.mjs` | 命令行参数回归：`--docs` / 未知参数 / 多余目录 / 不存在的目录 / 坏端口 / `--serve` 与 `--check` 混用都必须报错退出，而位置目录写法要真的生效（末尾会用默认 `docs/` 重建产物） | `node test/cli-args.mjs` |
| `serve-smoke.mjs` | 实时模式冒烟：重定向、页面、索引、每篇文档正文、目录穿越拦截、404/204，并核对跑完以后文档目录的文件清单与 mtime 没变（只读保证） | `node test/serve-smoke.mjs [目录]` |

以上六合一就是 `npm test`（会先跑一次 `node build-docs.mjs` 保证产物是新的）。改动 `md-viewer.html` 或文档之后先跑它们，几秒内能发现大部分低级错误。

`verify-render.mjs` 会产生 `test/.cache/`（抽出来的 `md-core.cjs` 与 `md-app.js`），已加入 `.gitignore`。

## 需要能启动浏览器

| 脚本 | 作用 | 命令 |
| --- | --- | --- |
| `ui-verify.mjs` | 界面回归。用无头 Chrome + CDP 跑 40 项左右断言：默认状态、两侧栏开关与 `✕`、快捷键、状态记忆、窄屏抽屉与遮罩、实时模式、改 `config.json` 即时生效、配置写错时的降级提示、全程无 console 错误。**自己拉起 `--serve` 实例并自动收尾** | `node test/ui-verify.mjs` |
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
- fixtures 里的文档路径统一是 `docs/fixtures/xxx.md`，因此 fixture 之间可以互相引用，
  用来验证 `§x.y` 章节引用与 `` `docs/xxx.md` `` 跨文档链接。

markdown-docs-helper
====

在浏览器里舒服地看一个目录下的 Markdown 与 Mermaid 思维导图文档，**不需要装任何 Markdown 插件**。

- **免安装、可离线**：不连 CDN、不用 `npm install`，双击 `md-viewer.html` 就能看。样式与应用逻辑在同目录的
  `assets/` 下，思维导图的渲染引擎（markmap + d3）已随仓库提供、由构建脚本内联进页面。
- **只读**：只读取文档目录，绝不修改、移动或删除任何 `.md` / `.mermaid` 文件（构建脚本的写入路径有代码级护栏，且明确禁止写进文档目录）。
- **按需显示**：首页内容与左侧目录栏显示哪些文档，都由 `config.json` 控制，不用改文档本身。
- **能看别人的目录**：把目录写在命令后面（`--serve <目录>`），页面里的路径前缀仍是 `docs/`，配置不用跟着改。
- **能分给同事看**：`node build-docs.mjs --serve --lan` 绑到本机所有网卡，启动时打印局域网地址，
  同一内网的同事打开即可（默认只绑 `127.0.0.1`，只有本机能开）。

支持的文档格式、思维导图与图表用法见 [`docs/指南/功能说明.md`](docs/指南/功能说明.md)；
界面、搜索、书签等操作见 [`docs/指南/界面与快捷键.md`](docs/指南/界面与快捷键.md)。

# 快速开始

**方式一：实时模式（默认，文档改动不用重建）**

```
node build-docs.mjs --serve
```

然后打开 http://127.0.0.1:8899/ 。
此模式下打开的是实时版 `index.html`，页面直接读取文档目录下的 `.md` 原文，
**改文档、改配置、甚至新增文档，刷新页面即生效**。停止服务按 `Ctrl+C`。

想让同一局域网里的同事直接打开看，加 `--lan`：

```
node build-docs.mjs --serve --lan
```

启动时会把可用的地址都印出来（例如 `局域网访问：http://192.168.1.20:8899/`），
把那一行发给同事即可。服务没有鉴权，只建议在可信内网里这么用。

**方式二：直接双击（离线单文件）**

双击 `md-viewer.html` 即可。页面用内置数据副本，零依赖、可离线（`assets/` 目录要跟页面放在一起）。
文档或配置改动后，跑一次 `node build-docs.mjs` 再刷新页面。

**方式三：看别的目录**

```
node build-docs.mjs --serve "D:\some\project\docs"
```

文档不用搬进本工程。切换目录后如果左栏是空的，检查一下 `config.json` 的 `sidebar.folders` ——
它写的是 `docs/xxx` 这种**虚拟前缀**，与你真实的目录名无关。

> 两个页面都不引用任何互联网资源，全部走工程内的本地文件（`assets/`、`vendor/`）。

# 命令

```
node build-docs.mjs                        # 扫描 ./docs，写出全部产物：md-viewer.html、docs-index.json、index.html（改完 config 或文档后跑这个）
node build-docs.mjs <目录>                  # 换一个文档目录（可配合 --check / --serve 使用）
node build-docs.mjs --check [目录]          # 只检查产物是否已过期（过期时退出码为 1），不写文件
node build-docs.mjs --serve [目录]          # 启动本地实时服务（默认 8899，端口被占用或绑不上会自动往后找端口），
                                           # 访问 / 即进实时版；不写任何文件，页面在内存里现生成
node build-docs.mjs --serve --port 9000 [目录]
node build-docs.mjs --serve --lan [目录]    # 绑定所有网卡（0.0.0.0），同一局域网内可访问
node build-docs.mjs --serve --host 192.168.1.20 [目录]   # 只绑定指定的本机地址
node build-docs.mjs --exclude a/b [--exclude xxx] [目录]   # 跳过文档目录下的子目录/单个文件，可写多次
node build-docs.mjs --exclude "a/b|xxx" [目录]             # 多个路径用 | 连在一个参数里
node build-docs.mjs --title "团队文档" --subtitle "内网" [目录]   # 临时覆盖 config.json 的 title / subtitle
node build-docs.mjs --help                 # 用法说明
```

目录是**位置参数**：写在参数前或参数后都可以，但最多只能写一个，不写就是工程自带的 `./docs`。
参数写错会直接报错退出，不会被静默忽略——未知参数、多写了一个目录、不存在的目录、
坏的端口号、坏的监听地址、`--serve` 与 `--check` 混用，都会当场拦下并提示正确写法。

`--exclude` 写的是**相对文档目录**的路径，按路径前缀排除（目录和单个文件都可以），
对构建、`--check`、`--serve` 三种模式都生效：

```
node build-docs.mjs --exclude xxx --exclude a/b --serve ./
# 跳过 ./xxx/、./a/b/ 下的全部文件；./a/ 下其它文件照常扫描
```

多个路径也可以只写一个参数、用 `|` 连起来（目录/文件名里不可能出现 `|`），
与写多次 `--exclude` 完全等价：

```
node build-docs.mjs --exclude "node_modules|dist" --serve ./
```

绝对路径、用 `..` 跳出文档目录的写法会被拒绝。注意它与 `config.json` 里 `sidebar.exclude`
不同：后者只是左栏不显示，文档仍会进索引和搜索；`--exclude` 则是根本不扫描。

`--title` / `--subtitle` 临时覆盖 `config.json` 的顶栏标题与副标题，**只对本次构建 / 服务生效，
不写回配置文件**。想临时清空副标题就写 `--subtitle ""`；`--check` 也按覆盖后的配置与产物比对：

```
node build-docs.mjs --serve --title "团队文档" --subtitle "内网"
```

## 监听地址（`--serve` 专用）

| 写法 | 绑定到 | 谁能打开 |
| --- | --- | --- |
| 不写（默认） | `127.0.0.1` | 只有本机 |
| `--lan` | `0.0.0.0`（所有网卡） | 本机 + 同一局域网/同一网络内的其它机器 |
| `--host <地址>` | 指定的 IP 或主机名（`0.0.0.0`、`::`、`192.168.1.20`、`localhost`…） | 能连到这个地址的人 |

`--host` 只写地址本身，端口用 `--port` 指定；`--lan` 就是 `--host 0.0.0.0` 的简写，
两个只能写一个。绑到 `0.0.0.0` / `::` 时启动信息会把本机各网卡的访问地址逐条印出来，
直接抄给同事即可：

```
  监听地址：0.0.0.0:8899（所有网卡，同一网络内的其它机器可以访问）
  本机访问：http://127.0.0.1:8899/       ← 实时版 index.html（引擎走本地外链）
  局域网访问：http://192.168.1.20:8899/
```

> 服务没有任何鉴权：绑定到 `0.0.0.0` 意味着同网络里知道地址的人都能读到这些文档。
> 只在可信内网里这么用；在公共 Wi-Fi 上请保持默认的 `127.0.0.1`。

用 `npm run` 也行：`npm run serve` / `npm run build` / `npm run check` / `npm test`。

# 工程结构

```
markdown-docs-helper/
├─ page.template.html   # 两个页面唯一的布局来源（改页面结构改这里；数据/引擎位置留空占位）
├─ help/                # 帮助对话框的正文：每页一个 .md，构建时整份导入（页签按文件名排序）
├─ md-viewer.html       # 离线单文件产物：内置文档数据 + 内联的导图/图表引擎，双击即可看
├─ index.html           # 实时版产物：引擎改成本地外链、快照置空，随构建命令一并生成（已在 .gitignore）
├─ assets/              # 页面的样式与应用逻辑（改动页面看这里，不用碰 html）
│  ├─ viewer.css        #   全部样式
│  ├─ mindmap-core.js   #   Mermaid mindmap 解析（纯函数，可单测）
│  ├─ mermaid-core.js   #   嵌入图表的围栏识别/版式判定/块标记（纯函数，可单测）
│  ├─ md-core.js        #   Markdown 渲染器
│  └─ md-app.js         #   应用逻辑（侧栏、路由、导图视图、图表渲染、导出…）
├─ build-docs.mjs       # 构建 / 本地服务脚本（把模板填成上面两个产物）
├─ config.json          # 配置文件（标题、首页说明、左栏显示范围、思维导图、图表…）—— 你主要改这个
├─ docs-index.json      # 生成的文档索引（实时模式用）
├─ vendor/markmap/      # 思维导图渲染引擎（markmap + d3，MIT），构建时内联或外链到页面
├─ vendor/mermaid/      # 嵌入图表的渲染引擎（mermaid，MIT），离线版按需内联、实时版本地外链
├─ docs/                # 默认被浏览的文档（示例内容与使用指南，可以整个换掉）
│  ├─ 指南/             #   使用指南（界面、配置、功能说明、常见问题…）
│  └─ 示例/             #   示例文档（Markdown、Mermaid 图表、思维导图）
└─ test/                # 回归与调试脚本，见 test/README.md
```

`docs/` 只是默认值：目录参数可以指向任何位置的目录，页面内部仍用 `docs/` 作为虚拟前缀。

# 页面操作与配置

页面上的按钮、键鼠操作、快捷键、全文搜索语法、正文与侧栏拖宽，以及实时版与离线快照版的差别，
见 [`docs/指南/界面与快捷键.md`](docs/指南/界面与快捷键.md)。

标题、首页说明、左栏显示范围、右栏层级、思维导图与图表等配置字段的默认值与示例，
见 [`docs/指南/配置说明.md`](docs/指南/配置说明.md)。（配置写在工程根的 `config.json`，
支持 `//` 注释与尾随逗号。）

# 更多文档

| 文档 | 内容 |
| --- | --- |
| [`docs/指南/功能说明.md`](docs/指南/功能说明.md) | 实时与离线快照、支持的 Markdown、正文 HTML、跨文档章节引用、思维导图、Mermaid 图表 |
| [`docs/指南/常见问题.md`](docs/指南/常见问题.md) | 常见问题排查 |
| [`docs/指南/测试与调试脚本.md`](docs/指南/测试与调试脚本.md) | 回归与调试脚本，详见 `test/README.md` |
| [`docs/指南/设计要点.md`](docs/指南/设计要点.md) | 架构与实现上的关键取舍 |

`docs/示例/` 下是可运行的示例文档，可直接在页面里打开查看。
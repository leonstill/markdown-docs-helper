/* =====================================================================
   mermaid-core：把 Markdown 里 ```mermaid 围栏的内容变成「能渲染的图表块」
   （纯函数，不依赖 DOM，可在 Node 里单独测试）

   分工：
     · 这里只做「识别 + 生成占位标记」——围栏信息串算不算 mermaid、
       这段源码是哪一类图（stateDiagram / stateDiagram-v2 / flowchart…）、
       以及输出块级 HTML（源码原样转义进 <code>，渲染结果由页面填进 .mg-host）
     · 真正的画图由 vendor/mermaid/mermaid.min.js 在页面里完成（assets/md-app.js 调用）
     · md-core 只在调用方传了 ctx.mermaid 时才走这套，否则围栏照旧当普通代码块，
       所以 Node 侧的老测试、以及关掉该功能的页面，行为与以前完全一致。

   为什么源码要留在页面里：渲染失败（语法错、引擎缺失）时用户还能看到、复制原文，
   这也让「源码」按钮和复制/导出有唯一可信来源。
   ===================================================================== */
var MermaidCore = (function () {
  'use strict';

  /* ---------- 围栏信息串 ----------
     认这些写法（大小写不敏感）：
       ```mermaid            ```mermaid title="x"      ```{.mermaid}      ~~~mermaid
     不认：```mermaidfoo、```javascript 等其它语言 */
  var RE_INFO = /^(?:mermaid\b|\{\s*\.?mermaid\s*\})/i;
  function isFence(info) {
    return RE_INFO.test(String(info == null ? '' : info).trim());
  }

  /* ---------- 图表类型 ----------
     以第一条有效行（跳过空行、%% 注释、%%{init:…}%% 指令、--- 前置配置块）为准。
     顺序有意义：先长后短（statediagram-v2 必须排在 statediagram 前面）。 */
  var KINDS = [
    { re: /^statediagram-v2\b/i, id: 'statediagram-v2', label: '状态图' },
    { re: /^statediagram\b/i, id: 'statediagram', label: '状态图' },
    { re: /^flowchart-v2\b/i, id: 'flowchart-v2', label: '流程图' },
    { re: /^flowchart\b/i, id: 'flowchart', label: '流程图' },
    { re: /^graph\b/i, id: 'graph', label: '流程图' },
    { re: /^sequencediagram\b/i, id: 'sequencediagram', label: '时序图' },
    { re: /^classdiagram-v2\b/i, id: 'classdiagram-v2', label: '类图' },
    { re: /^classdiagram\b/i, id: 'classdiagram', label: '类图' },
    { re: /^erdiagram\b/i, id: 'erdiagram', label: '实体关系图' },
    { re: /^journey\b/i, id: 'journey', label: '用户旅程图' },
    { re: /^gantt\b/i, id: 'gantt', label: '甘特图' },
    { re: /^pie\b/i, id: 'pie', label: '饼图' },
    { re: /^quadrantchart\b/i, id: 'quadrantchart', label: '象限图' },
    { re: /^requirementdiagram\b/i, id: 'requirementdiagram', label: '需求图' },
    { re: /^gitgraph\b/i, id: 'gitgraph', label: 'Git 分支图' },
    { re: /^mindmap\b/i, id: 'mindmap', label: '思维导图' },
    { re: /^timeline\b/i, id: 'timeline', label: '时间线' },
    { re: /^sankey-beta\b/i, id: 'sankey-beta', label: '桑基图' },
    { re: /^xychart-beta\b/i, id: 'xychart-beta', label: 'XY 图' },
    { re: /^block-beta\b/i, id: 'block-beta', label: '块图' },
    { re: /^packet-beta\b/i, id: 'packet-beta', label: '报文图' },
    { re: /^architecture-beta\b/i, id: 'architecture-beta', label: '架构图' },
    { re: /^c4\w*/i, id: 'c4', label: 'C4 图' },
    { re: /^zenuml\b/i, id: 'zenuml', label: 'ZenUML 时序图' },
  ];

  /* 源码归一：去掉 BOM、统一换行、去掉行尾空白与首尾空行。
     围栏里出现 tab 也保留（mermaid 自己认空白），这里不做缩进改写。 */
  function normalize(src) {
    return String(src == null ? '' : src)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
  }

  /* 第一条「有效行」：跳过空行、注释、初始化指令，以及 --- 包起来的前置配置块 */
  function firstLine(src) {
    var lines = normalize(src).split('\n');
    var i = 0, inFront = false;
    if (lines.length && lines[0].trim() === '---') { inFront = true; i = 1; }
    for (; i < lines.length; i++) {
      var t = lines[i].trim();
      if (inFront) { if (t === '---') inFront = false; continue; }
      if (!t) continue;
      if (t.indexOf('%%') === 0) continue;          // %% 注释、%%{init:…}%% 指令
      return t;
    }
    return '';
  }

  /* 判断是哪种图：返回 { id, keyword, label, name }；认不出来时给个兜底（仍交给 mermaid 试画） */
  function kind(src) {
    var line = firstLine(src);
    for (var i = 0; i < KINDS.length; i++) {
      if (KINDS[i].re.test(line)) {
        var kw = /^\S+/.exec(line)[0].replace(/[:{].*$/, '');
        return { id: KINDS[i].id, keyword: kw, label: KINDS[i].label, name: KINDS[i].label + ' · ' + kw };
      }
    }
    if (!line) {
      return { id: 'empty', keyword: '', label: '空图表', name: '空图表' };
    }
    var word = (/^\S+/.exec(line) || [''])[0];
    return { id: 'unknown', keyword: word, label: 'Mermaid 图表', name: 'Mermaid 图表' };
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function attr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }

  /* ---------- 块级标记 ----------
     opts（来自 config.json 的 mermaid 段，由调用方 MermaidCore.make(cfg) 绑好）：
       controls     是否显示图上的小工具栏（源码 / 复制 / SVG / 全屏）
       exportImage  工具栏里是否给「SVG」导出按钮
       fullscreen   工具栏里是否给「全屏」按钮
     结构固定为：.mg-block > .mg-bar + .mg-body(> .mg-host + pre.code)
     —— pre.code 里的源码是渲染的唯一来源，渲染成功后由页面隐藏（可再次展开）。 */
  function block(src, info, index, opts) {
    opts = opts || {};
    var text = normalize(src);
    var k = kind(text);
    var i = Number(index) || 0;
    var bar = '';
    if (opts.controls !== false) {
      var btns = '<button type="button" class="btn mg-btn" data-mg-act="src" aria-pressed="false"' +
        ' title="显示 / 隐藏这段 Mermaid 源码">源码</button>' +
        '<button type="button" class="btn mg-btn" data-mg-act="copy" title="复制这段 Mermaid 源码">复制</button>';
      if (opts.exportImage !== false) {
        btns += '<button type="button" class="btn mg-btn" data-mg-act="svg" title="把这幅图导出为 SVG">SVG</button>';
      }
      if (opts.fullscreen !== false) {
        btns += '<button type="button" class="btn mg-btn" data-mg-act="full" title="全屏查看（Esc 退出）">全屏</button>';
      }
      bar = '<div class="mg-bar no-print">' +
        '<span class="mg-kind">' + esc(k.name) + '</span>' +
        '<span class="mg-grow"></span>' + btns + '</div>';
    }
    return '<div class="mg-block" data-mg-kind="' + attr(k.id) + '" data-mg-keyword="' + attr(k.keyword) +
      '" data-mg-index="' + i + '" data-mg-state="pending">' +
      bar +
      '<div class="mg-body">' +
      '<div class="mg-host" role="img" aria-label="' + attr(k.name) + '"></div>' +
      '<pre class="code"><code>' + esc(text) + '</code></pre>' +
      '</div></div>';
  }

  /* 整篇 markdown 里有没有 ```mermaid 围栏（构建脚本据此决定离线版要不要内联引擎）。
     只认「开围栏」那一行，与 md-core 的围栏扫描规则一致。 */
  function usesFence(md) {
    var lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
    var fence = null;
    for (var i = 0; i < lines.length; i++) {
      var m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
      if (!m) continue;
      var ch = m[1].charAt(0);
      if (!fence) {
        fence = ch;
        if (isFence(m[2].trim())) return true;
      } else if (ch === fence && m[1].length >= 3) {
        fence = null;
      }
    }
    return false;
  }

  /* 整篇文档（.mermaid 文件）是不是一段「非思维导图」的 mermaid 图表：
     是就返回 kind（页面用它画成图），不是就返回 null（仍按思维导图那条路走，
     由 mindmap-core 给出更贴切的解析提示）。 */
  function diagramKind(text) {
    var k = kind(text);
    if (!k.keyword) return null;                       // 空文件
    if (k.id === 'mindmap' || k.id === 'unknown') return null;
    return k;
  }

  /* 绑定一份配置：md-app 里 ctx.mermaid = MermaidCore.make(cfg.mermaid) */
  function make(cfg) {
    var c = cfg || {};
    var opts = {
      controls: c.controls !== false,
      exportImage: c.exportImage !== false,
      fullscreen: c.fullscreen !== false,
    };
    return {
      isFence: isFence,
      block: function (src, info, index) { return block(src, info, index, opts); },
      kind: kind,
      normalize: normalize,
      options: opts,
    };
  }

  return {
    isFence: isFence,
    kind: kind,
    normalize: normalize,
    firstLine: firstLine,
    esc: esc,
    block: block,
    make: make,
    usesFence: usesFence,
    diagramKind: diagramKind,
    kinds: KINDS.map(function (k) { return k.id; }),
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = MermaidCore;
if (typeof window !== 'undefined') window.MermaidCore = MermaidCore;

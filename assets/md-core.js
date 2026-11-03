/* =====================================================================
   md-core：纯函数 Markdown 渲染器（不依赖 DOM，可在 Node 中单独测试）
   支持：ATX 标题、段落、围栏代码块、缩进代码块、引用、有序/无序列表
        （含嵌套与任务列表）、GFM 表格（含对齐）、水平线、
        行内 code/粗体/斜体/删除线/链接/图片/自动链接。
   正文里的 HTML 由 ctx.html 控制，三种模式（默认 escape = 不解析原始 HTML，
   避免文档注入脚本）：
     escape    —— 按纯文本转义显示
     innerhtml —— 原样输出给浏览器渲染（信任文档的选项）
     strip     —— 吃掉标签/注释、只保留被包裹的内容
                  （<br>→换行、<img>→图片、常见实体解码；代码块与行内代码不受影响）
   围栏里写 mermaid 时不算代码：调用方在 ctx 里传了 mermaid（MermaidCore.make(cfg)）
   就改输出图表块（见 assets/mermaid-core.js），没传就照旧当普通代码块。
   ===================================================================== */
var MarkdownCore = (function () {
  'use strict';

  var RE_ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
  var RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
  var RE_HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
  var RE_LIST = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
  var RE_BQ = /^ {0,3}>/;
  var RE_INDENT = /^ {4}/;
  var RE_DELIM_CELL = /^:?-+:?$/;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function attr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }

  /* ---------- 正文 HTML 模式 ---------- */
  function htmlMode(ctx) {
    var m = ctx && ctx.html;
    return m === 'innerhtml' || m === 'strip' ? m : 'escape';
  }
  /* 属性值来自已经过 esc() 的字符串，只需再防引号（& < > 已是实体形式） */
  function quote(v) { return String(v).replace(/"/g, '&quot;'); }
  function tagAttr(tag, name) {
    var re = new RegExp('(?:^|[\\s])' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s&]+))', 'i');
    var m = re.exec(tag);
    if (!m) return null;
    return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  }
  var ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', middot: '\u00b7', bull: '\u2022',
    mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', laquo: '\u00ab', raquo: '\u00bb',
    ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
    copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', times: '\u00d7',
    sect: '\u00a7', para: '\u00b6', dagger: '\u2020', permil: '\u2030',
    euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2'
  };
  /* 实体解码成字符：&#123; / &#x1F; 与常见命名实体；不认识的保持原样 */
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (m, name) {
      if (name.charAt(0) === '#') {
        var cp = (name.charAt(1) === 'x' || name.charAt(1) === 'X')
          ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return (cp >= 0 && cp <= 0x10FFFF) ? String.fromCodePoint(cp) : m;
      }
      var v = ENTITIES[name] !== undefined ? ENTITIES[name] : ENTITIES[name.toLowerCase()];
      return v !== undefined ? v : m;
    });
  }
  /* strip 模式用于 plain()（原始文本）：去掉注释与标签、解码实体，供目录/摘要/编号提取 */
  function stripMarkup(s) {
    return decodeEntities(String(s)
      .replace(/<!--[^]*?-->/g, '')
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^]*?)?\/?>/g, ''));
  }

  /* 去掉行内标记，用于生成 slug / 提取标题编号 */
  function plain(s, mode) {
    s = String(s);
    if (mode === 'strip') s = stripMarkup(s);
    return s
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|~~|\*|_/g, '')
      .trim();
  }
  function slugify(s, used, mode) {
    var base = plain(s, mode).toLowerCase()
      .replace(/[\s\u3000]+/g, '-')
      .replace(/[^\p{L}\p{N}\-_]/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!base) base = 'section';
    var id = base, n = 1;
    while (used && used[id]) { id = base + '-' + (n++); }
    if (used) used[id] = true;
    return id;
  }
  /* 标题前的编号，如 "5.3 内部需…" -> "5.3"，用于 §引用跳转 */
  function headingNumber(text, mode) {
    var m = /^\s*(\d+(?:\.\d+)*)/.exec(plain(text, mode));
    return m ? m[1] : null;
  }

  /* ---------- 文首「引用目标」声明 ----------
     用来把「父文档 §4.1」这类跨文档章节引用指到真正的地方。只认正文开始前的
     声明区（可以夹着空行与标题），两种写法等价：
       父文档指: `docs/方案/崩溃与掉电场景数据保障方案要点.md`
       <!-- 父文档: docs/方案/崩溃与掉电场景数据保障方案要点.md -->
     别名随便取、可以声明多条（父文档 / 总览 / 接口约定…）；声明行不再当正文渲染。
     这里只做「别名 -> 目标路径字符串」，路径解析交给调用方（浏览器里是 resolveDoc）。 */
  var RE_DECL = /^(?:<!--[ \t]*)?([\p{L}\p{N}_-]{1,12}?)[ \t]*(?:指)?[ \t]*[:：=][ \t]*`?([^`>\s]+)`?[ \t]*(?:-->)?$/u;
  var DECL_SCAN_LINES = 40;      // 声明区只在文件头部这些行里找，避免正文误触发

  function parseRefs(md) {
    var lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    var items = [], byAlias = {}, lineSet = {}, fence = null;
    for (var i = 0; i < lines.length && i < DECL_SCAN_LINES; i++) {
      var raw = lines[i], t = raw.trim();
      var fm = RE_FENCE.exec(raw);
      if (fm) {
        if (!fence) fence = fm[1].charAt(0);
        else if (fm[1].charAt(0) === fence) fence = null;
        continue;
      }
      if (fence) continue;
      if (!t) continue;                       // 声明区里允许空行
      if (RE_ATX.test(raw)) continue;         // 声明写在标题前或标题后都能认
      var m = RE_DECL.exec(t);
      if (!m) break;                          // 正文开始了，后面的行不再当声明
      var target = m[2].replace(/[ \t]+$/, '');
      if (!/\.md$/i.test(target)) break;      // 只认 markdown 目标
      var alias = m[1].replace(/指$/, '');    // 「父文档指:」这种写法去掉尾字
      lineSet[i] = true;                      // 认出来的声明行一律不当正文（含重复别名那行）
      if (!alias || byAlias[alias] !== undefined) continue;   // 同名以第一条为准
      items.push({ alias: alias, target: target, line: i });
      byAlias[alias] = target;
    }
    return { items: items, byAlias: byAlias, lineSet: lineSet };
  }
  /* 把声明行从正文里抹掉（保持行号不变，标题配对逻辑不受影响） */
  function dropLines(md, lineSet) {
    var lines = md.split('\n');
    for (var i = 0; i < lines.length; i++) if (lineSet[i]) lines[i] = '';
    return lines.join('\n');
  }
  function reEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  var RE_CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

  /* 扫描标题（跳过代码围栏），标题 id 与正文渲染时使用的 id 完全一致 */
  function scanHeadings(md, mode) {
    var lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    var out = [], used = {}, fence = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fm = RE_FENCE.exec(line);
      if (fm) {
        if (!fence) { fence = fm[1].charAt(0).repeat(fm[1].length); continue; }
        if (fm[1].charAt(0) === fence.charAt(0) && fm[1].length >= fence.length) { fence = null; continue; }
      }
      if (fence) continue;
      var m = RE_ATX.exec(line);
      if (!m) continue;
      out.push({
        level: m[1].length,
        text: m[2],
        id: slugify(m[2], used, mode),
        num: headingNumber(m[2], mode),
        line: i                      // 所在行号（0 基）：搜索命中行要知道自己落在哪个标题之下
      });
    }
    return out;
  }

  /* ---------- 全文搜索的查询解析 ----------
     text 模式（默认）：空格与 || 表示「或」，&& 表示「与」，! 表示「非」；
     优先级 ! > && > ||，不支持括号。反斜杠转义下一个字符（\& \| \! \\ \空格）。
     只有成对的 && / || 是运算符，单个 & | 按字面处理（R&D 不用转义）。
     regex 模式：整串就是一个 JS 正则，仍按行匹配（不跨行），不区分大小写。
     返回 { mode, raw, empty, error, clauses:[{pos,neg}], re }：
     clauses 是「或」连接的若干分支，每个分支内部全是「与」；
     error 是给人看的中文提示，非空时不要拿它去搜。 */
  function parseSearchQuery(raw, asRegex) {
    var s = String(raw == null ? '' : raw).trim();
    var out = {
      mode: asRegex ? 'regex' : 'text', raw: s, empty: !s,
      error: null, clauses: [], re: null
    };
    if (!s) return out;
    if (asRegex) {
      try { out.re = new RegExp(s, 'gi'); out.clauses = [{ pos: [s], neg: [] }]; }
      catch (e) { out.error = '正则表达式无效：' + ((e && e.message) || e); }
      return out;
    }

    var toks = [], buf = '', neg = false, i = 0;
    function flush() {
      if (!buf) return;
      toks.push({ t: 'term', text: buf, neg: neg });
      buf = ''; neg = false;
    }
    while (i < s.length) {
      var c = s.charAt(i);
      if (c === '\\') {
        if (i + 1 < s.length) { buf += s.charAt(i + 1); i += 2; }
        else { buf += '\\'; i++; }                 // 末尾孤立的 \ 就当字面反斜杠
        continue;
      }
      if (c === '&' && s.charAt(i + 1) === '&') { flush(); toks.push({ t: 'and' }); i += 2; continue; }
      if (c === '|' && s.charAt(i + 1) === '|') { flush(); toks.push({ t: 'or' }); i += 2; continue; }
      if (c === '!') { flush(); neg = !neg; i++; continue; }   // !!x 等价于 x
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { flush(); i++; continue; }
      buf += c; i++;
    }
    flush();
    if (neg) { out.error = '! 后面缺少要排除的关键词'; return out; }

    /* 相邻两个词之间省略了 ||：补一个「或」，但显式运算符两侧不补 */
    var seq = [];
    toks.forEach(function (t) {
      if (t.t === 'term' && seq.length && seq[seq.length - 1].t === 'term') seq.push({ t: 'or' });
      seq.push(t);
    });
    if (!seq.length) return out;
    if (seq[0].t !== 'term' || seq[seq.length - 1].t !== 'term') {
      out.error = '运算符 && 和 || 的前后都需要关键词';
      return out;
    }
    for (var k = 0; k + 1 < seq.length; k++) {
      if (seq[k].t !== 'term' && seq[k + 1].t !== 'term') {
        out.error = '运算符 && 和 || 之间缺少关键词';
        return out;
      }
    }

    var cur = { pos: [], neg: [] }, clauses = [];
    seq.forEach(function (t) {
      if (t.t === 'or') { clauses.push(cur); cur = { pos: [], neg: [] }; return; }
      if (t.t === 'and') return;
      (t.neg ? cur.neg : cur.pos).push(t.text);
    });
    clauses.push(cur);
    for (var ci = 0; ci < clauses.length; ci++) {
      if (!clauses[ci].pos.length) {
        out.error = '每个「或」分支都要有正向关键词；想表达「有 a 且没有 b」请写 a && !b';
        return out;
      }
    }
    out.clauses = clauses;
    return out;
  }

  /* 一行里所有命中（按位置合并重叠：同一位置取更长的那段）。
     spec 可以是 parseSearchQuery 的结果，也可以是 searchActiveTerms 筛过的 { mode, terms }。
     正则零长度命中（如 ^ 或 a*）没有可标注的文字，直接跳过。 */
  function searchScanLine(line, spec) {
    var s = String(line == null ? '' : line), hits = [];
    if (!spec || spec.error || spec.empty) return hits;
    if (spec.mode === 'regex') {
      if (!spec.re) return hits;
      spec.re.lastIndex = 0;
      var m;
      while ((m = spec.re.exec(s))) {
        if (!m[0].length) {
          spec.re.lastIndex = Math.min(s.length + 1, spec.re.lastIndex + 1);
          continue;
        }
        hits.push({ start: m.index, end: m.index + m[0].length });
        if (spec.re.lastIndex <= m.index) spec.re.lastIndex = m.index + 1;
      }
    } else {
      var low = s.toLowerCase();
      (spec.terms || []).forEach(function (t) {
        var lt = String(t).toLowerCase();
        if (!lt) return;
        var at = low.indexOf(lt);
        while (at >= 0) {
          hits.push({ start: at, end: at + lt.length });
          at = low.indexOf(lt, at + lt.length);
        }
      });
    }
    hits.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    var out = [], end = -1;
    hits.forEach(function (h) {
      if (h.start >= end) { out.push(h); end = h.end; }
    });
    return out;
  }

  /* 文档级判定：这篇文档满足哪些「或」分支，就把这些分支的正向词并起来。
     不满足（或错误 / 空查询）返回 null。AND 允许词分布在不同的行上。
     regex 模式返回 spec 本身，好让调用方继续用同一个正则扫描各行。 */
  function searchActiveTerms(spec, lines) {
    if (!spec || spec.error || spec.empty) return null;
    lines = lines || [];
    if (spec.mode === 'regex') {
      for (var i = 0; i < lines.length; i++) {
        if (searchScanLine(lines[i], spec).length) return spec;
      }
      return null;
    }
    var low = lines.join('\n').toLowerCase();
    var hit = false, terms = [];
    spec.clauses.forEach(function (c) {
      var ok = c.pos.every(function (t) { return low.indexOf(String(t).toLowerCase()) >= 0; }) &&
        c.neg.every(function (t) { return low.indexOf(String(t).toLowerCase()) < 0; });
      if (!ok) return;
      hit = true;
      c.pos.forEach(function (t) {
        var key = String(t).toLowerCase();
        if (!terms.some(function (x) { return x.toLowerCase() === key; })) terms.push(t);
      });
    });
    if (!hit) return null;
    return { mode: 'text', raw: spec.raw, terms: terms, empty: false, error: null };
  }

  /* ---------- 行内渲染 ---------- */
  function inline(src, ctx, depth) {
    depth = depth || 0;
    var mode = htmlMode(ctx);
    var stash = [];
    function put(html) { stash.push(html); return '\u0000' + (stash.length - 1) + '\u0000'; }
    /* 跨文档章节引用：拿目标文档的「编号 -> 锚点 id」表；目标里没有这个编号时
       退到该文档顶部，并给链接加 missing 标记（虚线 + 悬停说明），不静默失效。 */
    function xrefAnchor(label, path, num, cls, why) {
      var map = ctx && ctx.sectionsOf ? ctx.sectionsOf(path) : null;
      var id = (map && map[num]) || null;
      var href = ctx && ctx.docHref ? ctx.docHref(path, id) : '#';
      var title = (why || path) + ' §' + num +
        (id ? '' : '（' + path + ' 里没有 §' + num + '，只能跳到该文档顶部）');
      return '<a class="' + cls + (id ? '' : ' missing') + '" href="' + attr(href) +
        '" title="' + attr(title) + '">' + label + '</a>';
    }

    var s = esc(src);

    // 反斜杠转义
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!~|>])/g, function (m, c) { return put(c); });

    // 行内代码（可点击的跨文档引用在这里识别；紧跟其后的 §n.n 并成跨文档章节引用）
    s = s.replace(/(`+)([\s\S]*?)\1([ \t]*§[ \t]?(\d+(?:\.\d+)*))?/g, function (m, tick, code, tail, num) {
      code = code.replace(/\n/g, ' ');
      if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
      var ref = ctx && ctx.resolveDoc ? ctx.resolveDoc(code.trim()) : null;
      if (ref && num && ctx.sectionsOf) {
        return put(xrefAnchor('<code>' + code + '</code> §' + num, ref.path, num, 'docref xref', ref.path));
      }
      if (ref) {
        return put('<a class="docref" href="' + attr(ctx.docHref(ref.path, ref.section)) +
          '" title="打开 ' + attr(ref.path) + '"><code>' + code + '</code></a>') + (tail || '');
      }
      return put('<code>' + code + '</code>') + (tail || '');
    });

    // 「别名 §n.n」跨文档章节引用（别名来自文首声明；ctx.aliasRe 在 render 里预编译）
    if (ctx && ctx.aliasRe) {
      s = s.replace(ctx.aliasRe, function (m, alias, num) {
        return put(xrefAnchor(m, ctx.refs[alias], num, 'secref xref', alias));
      });
    }

    // §章节引用（默认只指本文档）
    if (ctx && ctx.sectionMap) {
      s = s.replace(/§[ \t]?(\d+(?:\.\d+)*)/g, function (m, num) {
        var id = ctx.sectionMap[num];
        if (!id) return m;
        return put('<a class="secref" href="' + attr(ctx.docHref(ctx.docPath, id)) +
          '" title="跳转到 ' + attr(num) + '">' + m + '</a>');
      });
    }

    // 图片
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g, function (m, alt, src2) {
      return put('<img src="' + attr(ctx && ctx.resolveAsset ? ctx.resolveAsset(src2) : src2) +
        '" alt="' + attr(alt) + '" loading="lazy">');
    });

    // 链接
    s = s.replace(/\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g, function (m, text, href) {
      var label = depth < 3 ? inline(text, ctx, depth + 1) : esc(text);
      if (/^#/.test(href)) {
        var sec = decodeURIComponent(href.slice(1));
        return put('<a href="' + attr(ctx.docHref(ctx.docPath, sec)) + '">' + label + '</a>');
      }
      var ref = ctx && ctx.resolveDoc ? ctx.resolveDoc(href) : null;
      if (ref) {
        return put('<a class="docref" href="' + attr(ctx.docHref(ref.path, ref.section)) + '">' + label + '</a>');
      }
      if (/^(https?:|mailto:)/i.test(href)) {
        return put('<a href="' + attr(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
      }
      return put('<a href="' + attr(ctx && ctx.resolveAsset ? ctx.resolveAsset(href) : href) + '">' + label + '</a>');
    });

    // 自动链接
    s = s.replace(/(^|[\s(（])((?:https?:\/\/|mailto:)[^\s<>()（）]+)/g, function (m, pre, url) {
      return pre + put('<a href="' + attr(url) + '" target="_blank" rel="noopener noreferrer">' + url + '</a>');
    });
    s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, function (m, url) {
      return put('<a href="' + attr(url) + '" target="_blank" rel="noopener noreferrer">' + url + '</a>');
    });

    // ---- strip：吃掉 HTML 标签/注释，只保留被包裹的内容 ----
    // 此时行内代码、链接等已进 stash（占位符不参与这里的替换），实体解码放在标签
    // 之后做，避免 &lt;script&gt; 这种"用实体转义出来的标签"被当成真标签吃掉。
    if (mode === 'strip') {
      s = s.replace(/&lt;!--[^]*?--&gt;/g, '');                        // 注释整条吃掉
      s = s.replace(/&lt;(script|style)\b[^]*?&gt;[^]*?&lt;\/\1\s*&gt;/gi, '');   // script/style 连内容整段移除
      s = s.replace(/&lt;img\b[^]*?&gt;/gi, function (m) {             // <img> → 图片，相对路径按当前文档解析
        var src2 = tagAttr(m, 'src');
        if (!src2) return '';
        var alt = tagAttr(m, 'alt') || '';
        var url = ctx && ctx.resolveAsset ? ctx.resolveAsset(src2) : src2;
        return put('<img src="' + quote(url) + '" alt="' + quote(alt) + '" loading="lazy">');
      });
      s = s.replace(/&lt;br\b[^]*?&gt;/gi, '  \n');                    // <br> → 换行（沿用行尾两空格的硬换行处理）
      s = s.replace(/&lt;\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^]*?)?\/?&gt;/g, '');   // 其余标签吃掉
      s = s.replace(/&amp;(?=[a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/g, '&');   // 实体解码
    }

    // 强调：先强后弱，避免 ** 被拆开
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?=$|[^\w])/g, '$1<strong>$2</strong>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    s = s.replace(/\*(?=\S)([^*\n]*?\S)\*/g, '<em>$1</em>');
    s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?=$|[^\w])/g, '$1<em>$2</em>');

    // 硬换行（行尾两个空格）优先于软换行折叠
    s = s.replace(/ {2,}\n/g, '<br>\n');
    s = s.replace(/\n/g, ' ');

    // ---- innerhtml：把"长得像标签/注释"的转义序列还原成原样输出，交给浏览器渲染 ----
    // 只放行形状像标签的（标签名 + 可选属性，或整条注释），`a < b`、<user@example.com>
    // 这类不规则的仍按纯文本转义显示；行内代码/链接等已进 stash，不会被还原。
    // 实体解码放在标签还原之后：文档里自己写 &lt;script&gt; 表示"显示这段文字"，
    // 还原前它不满足标签形状、不会被误放行成真标签。
    if (mode === 'innerhtml') {
      s = s.replace(/&lt;(\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^]*?)?\/?|!--[^]*?--)&gt;/g, '<$1>');
      s = s.replace(/&amp;(?=[a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/g, '&');
    }

    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return stash[+i]; });
  }

  /* 中文软换行折叠：两侧都是中日韩字符时不插空格，其余情况按英文习惯插空格 */
  function softJoin(buf) {
    var out = '';
    for (var i = 0; i < buf.length; i++) {
      var piece = buf[i].trim();
      if (!piece) continue;
      if (!out) { out = piece; continue; }
      var a = out.charAt(out.length - 1), b = piece.charAt(0);
      out += (RE_CJK.test(a) && RE_CJK.test(b)) ? piece : ' ' + piece;
    }
    return out;
  }

  function isDelimRow(line) {
    var t = line.trim();
    if (!t || !/\|/.test(t) && !/^:?-+:?$/.test(t)) return false;
    if (!/^[|\s:-]+$/.test(t) || !/-/.test(t)) return false;
    var cells = splitRow(t);
    if (!cells.length) return false;
    for (var i = 0; i < cells.length; i++) {
      if (!RE_DELIM_CELL.test(cells[i].trim())) return false;
    }
    return true;
  }
  /* 按未转义、且不在行内代码中的 | 拆分表格行 */
  function splitRow(line) {
    var t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    var cells = [], cur = '', tick = false;
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i);
      if (c === '\\' && t.charAt(i + 1) === '|') { cur += '|'; i++; continue; }
      if (c === '`') { tick = !tick; cur += c; continue; }
      if (c === '|' && !tick) { cells.push(cur); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur);
    return cells;
  }
  function alignOf(cell) {
    var t = cell.trim();
    var l = t.charAt(0) === ':', r = t.charAt(t.length - 1) === ':';
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  }

  function startsBlock(line, allowIndent) {
    var t = line.replace(/^ {0,3}/, '');
    if (allowIndent !== false && RE_INDENT.test(line)) return true;
    return RE_FENCE.test(line) || RE_ATX.test(line) || RE_BQ.test(line) ||
      RE_LIST.test(line) || RE_HR.test(t);
  }

  /* ---------- 列表 ---------- */
  function parseList(lines, start, ctx, base) {
    base = base || 0;
    var first = RE_LIST.exec(lines[start]);
    var ordered = /\d/.test(first[2]);
    var num = ordered ? parseInt(first[2], 10) : 1;
    var markerIndent = first[1].length;
    var items = [], itemLines = [], i = start, loose = false;

    while (i < lines.length) {
      var m = RE_LIST.exec(lines[i]);
      if (!m || m[1].length !== markerIndent || /\d/.test(m[2]) !== ordered) break;
      var itemLine = base + i;
      var contentIndent = m[1].length + m[2].length + m[3].length;
      var item = [m[4]];
      i++;
      while (i < lines.length) {
        var c = lines[i];
        if (!c.trim()) {
          // 空行：若其后仍属于本条目，则记为松列表
          var j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length) {
            var ind2 = leadingSpaces(lines[j]);
            var sib = RE_LIST.test(lines[j]) && ind2 <= markerIndent;
            if (!sib && (ind2 >= contentIndent || ind2 > markerIndent)) {
              item.push(''); loose = true; i++; continue;
            }
          }
          break;
        }
        var ind = leadingSpaces(c);
        if (RE_LIST.test(c) && ind <= markerIndent) break;   // 同级或外层条目
        if (ind >= contentIndent) { item.push(c.slice(contentIndent)); i++; continue; }
        if (ind > markerIndent) { item.push(c.slice(ind)); i++; continue; }
        item.push(c.trim()); i++;                             // 懒续行
      }
      items.push(item);
      itemLines.push(itemLine);
      // 条目之间有空行 -> 松列表
      var k = i;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k > i && k < lines.length && RE_LIST.test(lines[k]) && leadingSpaces(lines[k]) === markerIndent) loose = true;
    }

    var tag = ordered ? 'ol' : 'ul';
    var open = '<' + tag + (ordered && num !== 1 ? ' start="' + num + '"' : '') + (loose ? ' class="loose"' : '') + '>';
    var html = open;
    for (var n = 0; n < items.length; n++) {
      var it = items[n].slice();
      var task = null;
      var tm = /^\[([ xX])\][ \t]+([\s\S]*)$/.exec(it[0] || '');
      if (tm) { task = tm[1].toLowerCase() === 'x'; it[0] = tm[2]; }
      var rest = it.slice(1);
      var needsBlocks = loose || rest.some(function (l) { return !l.trim() || startsBlock(l); });
      var body = needsBlocks ? blocks(it, ctx, itemLines[n]) : inline(softJoin(it), ctx);
      var box = task === null ? '' : '<input type="checkbox" disabled' + (task ? ' checked' : '') + '> ';
      html += lineMark(itemLines[n]) + '<li>' + box + body.trim() + '</li>';
    }
    return { html: html + '</' + tag + '>', next: i };
  }
  function leadingSpaces(s) { var m = /^( *)/.exec(s); return m[1].length; }

  /* ---------- 块级渲染 ---------- */
  /* 行号锚点：块的开头留一个 HTML 注释，页面用它把源文件行号映射成滚动位置。
     注释不占布局、不影响样式，也不污染复制出来的正文。 */
  function lineMark(n) { return '<!--L' + n + '-->'; }
  function blocks(lines, ctx, base) {
    base = base || 0;
    var out = '', i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }
      var start = i;

      // 围栏代码块
      var fm = RE_FENCE.exec(line);
      if (fm) {
        var ch = fm[1].charAt(0), len = fm[1].length, buf = [];
        i++;
        while (i < lines.length) {
          var cm = RE_FENCE.exec(lines[i]);
          if (cm && cm[1].charAt(0) === ch && cm[1].length >= len && !cm[2].trim()) { i++; break; }
          buf.push(lines[i]); i++;
        }
        while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
        var info = fm[2].trim();
        // ```mermaid：交给调用方注入的渲染器（页面里是 MermaidCore）生成图表块
        if (ctx.mermaid && ctx.mermaid.isFence && ctx.mermaid.isFence(info)) {
          ctx.mermaidIndex = (ctx.mermaidIndex || 0) + 1;
          out += lineMark(base + start) + ctx.mermaid.block(buf.join('\n'), info, ctx.mermaidIndex);
          continue;
        }
        var cls = /^[\w+#.-]+$/.test(info) ? ' class="language-' + attr(info.toLowerCase()) + '"' : '';
        out += lineMark(base + start) + '<pre class="code"><code' + cls + '>' + esc(buf.join('\n')) + '\n</code></pre>';
        continue;
      }

      // 缩进代码块（4 空格）
      if (RE_INDENT.test(line)) {
        var cbuf = [];
        while (i < lines.length && (RE_INDENT.test(lines[i]) || !lines[i].trim())) {
          if (!lines[i].trim()) {
            // 代码块内的空行：仅当后面还有缩进行时保留
            var j = i;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && RE_INDENT.test(lines[j])) { cbuf.push(''); i++; continue; }
            break;
          }
          cbuf.push(lines[i].slice(4)); i++;
        }
        out += lineMark(base + start) + '<pre class="code"><code>' + esc(cbuf.join('\n')) + '\n</code></pre>';
        continue;
      }

      // 水平线
      if (RE_HR.test(line)) { out += lineMark(base + i) + '<hr>'; i++; continue; }

      // 标题
      var hm = RE_ATX.exec(line);
      if (hm) {
        var lvl = hm[1].length;
        var h = ctx.headings[ctx.hIndex];
        var id;
        if (h && plain(h.text, ctx.html) === plain(hm[2], ctx.html)) { id = h.id; ctx.hIndex++; }
        else { id = slugify(hm[2], ctx.usedSlugs, ctx.html); }
        out += lineMark(base + i) + '<h' + lvl + ' id="' + attr(id) + '">' +
          '<a class="anchor" href="' + attr(ctx.docHref(ctx.docPath, id)) + '" aria-hidden="true">#</a>' +
          inline(hm[2], ctx) + '</h' + lvl + '>';
        i++;
        continue;
      }

      // 引用
      if (RE_BQ.test(line)) {
        var qbuf = [];
        while (i < lines.length) {
          if (RE_BQ.test(lines[i])) { qbuf.push(lines[i].replace(/^ {0,3}>[ \t]?/, '')); i++; continue; }
          if (lines[i].trim() && !startsBlock(lines[i])) { qbuf.push(lines[i]); i++; continue; }
          break;
        }
        out += lineMark(base + start) + '<blockquote>' + blocks(qbuf, ctx, base + start) + '</blockquote>';
        continue;
      }

      // 表格
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isDelimRow(lines[i + 1])) {
        var head = splitRow(line), delims = splitRow(lines[i + 1]);
        var aligns = delims.map(alignOf);
        i += 2;
        var body = [];
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0 &&
               !startsBlock(lines[i], false) && !isDelimRow(lines[i])) {
          body.push(splitRow(lines[i])); i++;
        }
        var th = '<tr>';
        for (var c1 = 0; c1 < head.length; c1++) {
          th += '<th' + (aligns[c1] ? ' style="text-align:' + aligns[c1] + '"' : '') + '>' +
            inline(head[c1].trim(), ctx) + '</th>';
        }
        th += '</tr>';
        var tb = '';
        for (var r = 0; r < body.length; r++) {
          tb += '<tr>';
          for (var c2 = 0; c2 < head.length; c2++) {
            tb += '<td' + (aligns[c2] ? ' style="text-align:' + aligns[c2] + '"' : '') + '>' +
              inline((body[r][c2] || '').trim(), ctx) + '</td>';
          }
          tb += '</tr>';
        }
        out += lineMark(base + start) + '<div class="table-wrap"><table><thead>' + th + '</thead>' +
          (tb ? '<tbody>' + tb + '</tbody>' : '') + '</table></div>';
        continue;
      }

      // 列表
      if (RE_LIST.test(line)) {
        var res = parseList(lines, i, ctx, base);
        out += lineMark(base + start) + res.html; i = res.next;
        continue;
      }

      // 段落
      var pbuf = [line]; i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], false)) { pbuf.push(lines[i]); i++; }
      var pbody = inline(softJoin(pbuf), ctx);
      // strip 模式下只有 HTML 标签的行会被吃空：不再输出空段落
      if (pbody.trim() || ctx.html !== 'strip') out += lineMark(base + start) + '<p>' + pbody + '</p>';
    }
    return out;
  }

  function render(md, ctx) {
    ctx = Object.assign({ usedSlugs: {}, hIndex: 0 }, ctx || {});
    ctx.html = htmlMode(ctx);                       // 归一化：未知值按 escape
    var src = String(md).replace(/\r\n?/g, '\n');
    // 文首声明：调用方（浏览器）可以传入已经解析成真实路径的 refs，否则这里自己解一遍
    var lineSet = ctx.declLines || null;
    if (!lineSet) {
      var info = parseRefs(src);
      lineSet = info.lineSet;
      if (!ctx.refs) ctx.refs = info.byAlias;
    } else if (!ctx.refs) {
      ctx.refs = {};
    }
    src = dropLines(src, lineSet);
    // 预编译「别名 §n.n」正则：长别名优先，避免短别名抢先匹配
    var aliases = Object.keys(ctx.refs);
    if (aliases.length) {
      aliases.sort(function (a, b) { return b.length - a.length; });
      ctx.aliasRe = new RegExp('(' + aliases.map(reEsc).join('|') + ')[ \\t]*§[ \\t]?(\\d+(?:\\.\\d+)*)', 'g');
    }
    ctx.headings = scanHeadings(src, ctx.html);
    ctx.sectionMap = {};
    for (var i = 0; i < ctx.headings.length; i++) {
      var h = ctx.headings[i];
      if (h.num && !(h.num in ctx.sectionMap)) ctx.sectionMap[h.num] = h.id;
    }
    var html = blocks(src.replace(/\t/g, '    ').split('\n'), ctx);
    return { html: html, headings: ctx.headings, refs: ctx.refs, declLines: lineSet };
  }

  return {
    render: render,
    scanHeadings: scanHeadings,
    parseRefs: parseRefs,
    plain: plain,
    slugify: slugify,
    inline: inline,
    parseSearchQuery: parseSearchQuery,
    searchScanLine: searchScanLine,
    searchActiveTerms: searchActiveTerms
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = MarkdownCore;

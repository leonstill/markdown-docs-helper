/* ===================== 页面应用逻辑 ===================== */
(function () {
  'use strict';
  var Core = MarkdownCore;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function enc(s) { return encodeURIComponent(s); }
  function dirOf(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function baseOf(p) { var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  function normDir(p) { return String(p).replace(/\/+$/, ''); }
  function byPathZh(a, b) { return a.path.localeCompare(b.path, 'zh-Hans-CN'); }
  var NARROW = 860;

  /* ---------- 默认配置：config.json 缺失或缺字段时用它兜底 ---------- */
  var DEFAULTS = {
    title: 'Markdown 文档浏览器',
    subtitle: '',
    home: { title: '文档索引', intro: '', showCards: true },
    sidebar: {
      title: '文档目录', defaultOpen: false, remember: true, showSearch: true,
      showCounts: true, folders: [], exclude: [], order: [], docs: {}
    },
    toc: { title: '本篇目录', defaultOpen: true, remember: true, maxDepth: 4 },
    reading: { maxWidth: 920 },
    markdown: { html: 'escape' },
    mindmap: {
      enabled: true, extensions: ['.mermaid'], initialExpandLevel: 2,
      showOutline: true, exportImage: true
    },
    mermaid: {
      enabled: true, theme: 'auto', style: 'doc', securityLevel: 'strict',
      controls: true, exportImage: true, fullscreen: true
    }
  };

  var state = {
    docs: [], visible: [], byPath: {}, byBase: {},
    cfg: DEFAULTS, cfgError: null, cfgFileLoaded: false,
    mode: 'snapshot', generatedAt: null, skipped: 0,
    current: null, headings: [],
    leftOpen: false, rightOpen: true,
    /* 思维导图：当前导图、markmap 实例、大纲、折叠集合 */
    mindmap: null, mm: null, mmOutline: [], mmFolded: [],
    /* 图表文档（.mermaid 里写 stateDiagram-v2 之类）：只用来区分右栏标题 */
    diagram: null,
    /* 嵌入的 Mermaid 图表：渲染令牌（换文档后作废在飞的渲染）、自增 id、当前全屏的那张图 */
    mgToken: 0, mgSeq: 0, mgFull: null, mgPromise: null, mgError: null, mgExportError: null
  };

  /* ---------- JSONC：允许注释与尾随逗号，方便手写 config.json ---------- */
  function parseJsonc(text) {
    text = String(text).replace(/^\uFEFF/, '');
    var out = '', i = 0, inStr = false;
    while (i < text.length) {
      var c = text.charAt(i), n = text.charAt(i + 1);
      if (inStr) {
        out += c;
        if (c === '\\') { out += (n === undefined ? '' : n); i += 2; continue; }
        if (c === '"') inStr = false;
        i++; continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === '/' && n === '/') { while (i < text.length && text.charAt(i) !== '\n') i++; continue; }
      if (c === '/' && n === '*') {
        i += 2;
        while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) i++;
        i += 2; continue;
      }
      if (c === ',') {                       // 尾随逗号
        var j = i + 1;
        while (j < text.length && /\s/.test(text.charAt(j))) j++;
        if (text.charAt(j) === '}' || text.charAt(j) === ']') { i++; continue; }
      }
      out += c; i++;
    }
    return JSON.parse(out);
  }
  function deepMerge(base, over) {
    if (over === undefined || over === null) return base;
    if (typeof over !== 'object' || Array.isArray(over)) return over;
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in over) {
      if (!Object.prototype.hasOwnProperty.call(over, k)) continue;
      var b = base[k], o = over[k];
      out[k] = (b && o && typeof b === 'object' && !Array.isArray(b) && !Array.isArray(o))
        ? deepMerge(b, o) : o;
    }
    return out;
  }

  /* ---------- 主题 ---------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    // 深/浅两枚图标由 CSS 按 data-theme 切换，这里不往按钮里写文字
    try { localStorage.setItem('mdv-theme', t); } catch (e) {}
    // 思维导图的配色是画上去的，换主题要按新配色重画一遍
    if (state.mindmap && state.mm) renderMindmap({ keepView: false });
    // 嵌入的 Mermaid 图表同理：主题是画进 SVG 里的，换主题得重画
    else rerenderMermaid();
  }
  (function initTheme() {
    var t = null;
    try { t = localStorage.getItem('mdv-theme'); } catch (e) {}
    if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(t);
  })();

  /* ---------- 路径工具 ---------- */
  function docHref(path, section) {
    return '#p=' + enc(path) + (section ? '&h=' + enc(section) : '');
  }
  function parseHash() {
    var h = location.hash.replace(/^#/, ''), out = {};
    if (!h) return out;
    h.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i < 0) return;
      try { out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); }
      catch (e) { out[kv.slice(0, i)] = kv.slice(i + 1); }
    });
    return out;
  }
  function resolveAsset(p) {
    if (/^(https?:|mailto:|data:|#|\/)/i.test(p)) return p;
    var cur = state.current;
    var joined = (cur && dirOf(cur.path) ? dirOf(cur.path) + '/' : '') + p;
    var parts = [];
    joined.split('/').forEach(function (seg) {
      if (seg === '.' || seg === '') return;
      if (seg === '..') { parts.pop(); return; }
      parts.push(seg);
    });
    return parts.join('/');
  }
  function resolveDoc(ref) {
    if (!ref) return null;
    var section = null, hash = ref.indexOf('#');
    if (hash >= 0) { section = ref.slice(hash + 1); ref = ref.slice(0, hash); }
    ref = ref.trim().replace(/^\.\//, '').replace(/^\/+/, '');
    if (!/\.md$/i.test(ref) && !isMindmapPath(ref)) return null;
    if (state.byPath[ref]) return { path: ref, section: section };
    var b = baseOf(ref);
    if (state.byBase[b]) return { path: state.byBase[b].path, section: section };
    return null;
  }
  /* 正文里的 HTML 怎么处理：escape（转义显示，默认）/ innerhtml（原样输出）/ strip（吃掉标签只留内容）。
     认不出的值一律退回 escape，保证旧配置与写错的配置行为不变。 */
  function htmlMode() {
    var m = (state.cfg.markdown || {}).html;
    return m === 'innerhtml' || m === 'strip' ? m : 'escape';
  }
  function ctxFor(docPath) {
    return {
      docPath: docPath || '',
      docHref: docHref,
      resolveDoc: resolveDoc,
      resolveAsset: resolveAsset,
      sectionsOf: sectionsOf,
      headings: [],
      sectionMap: {},
      html: htmlMode(),
      /* ```mermaid 围栏交给 mermaid-core 生成图表块；功能关掉时不传，围栏照旧当代码块 */
      mermaid: mermaidEnabled() ? MermaidCore.make(state.cfg.mermaid) : null
    };
  }

  /* ---------- 跨文档章节引用 ----------
     目标文档的「标题编号 -> 锚点 id」按需扫描并缓存：正文都在内存里（实时模式逐篇
     fetch、快照模式整篇内嵌），所以「父文档 §4.1」能指到父文档真正的 4.1。 */
  var sectionCache = {};
  function sectionsOf(path) {
    if (!path) return null;
    if (Object.prototype.hasOwnProperty.call(sectionCache, path)) return sectionCache[path];
    var doc = state.byPath[path];
    if (!doc) return null;
    var map = {}, hs = Core.scanHeadings(String(doc.text || ''), htmlMode());
    for (var i = 0; i < hs.length; i++) {
      if (hs[i].num && !(hs[i].num in map)) map[hs[i].num] = hs[i].id;
    }
    sectionCache[path] = map;
    return map;
  }

  /* 文首「引用目标」声明（父文档 / 总览 / 接口约定…）：把别名解析成真实文档路径 */
  function docRefs(doc) {
    var info = Core.parseRefs(String((doc && doc.text) || ''));
    var map = {};
    info.items.forEach(function (it) {
      var r = resolveDoc(it.target);
      if (!r) {
        var joined = resolveAsset(it.target);              // 也认相对当前文档写的路径
        if (joined && joined !== it.target) r = resolveDoc(joined);
      }
      it.path = r ? r.path : null;
      it.title = r && state.byPath[r.path] ? state.byPath[r.path].title : null;
      if (r) map[it.alias] = r.path;
    });
    return { items: info.items, map: map, lineSet: info.lineSet };
  }
  function docRefsHtml(refs) {
    if (!refs.items.length) return '';
    var h = '<div class="docrefs"><span class="dl">引用目标</span>';
    refs.items.forEach(function (it) {
      h += it.path
        ? '<a class="dref" href="' + docHref(it.path) + '" title="打开 ' + esc(it.path) + '">' +
          esc(it.alias) + ' <span class="ar">→</span> ' + esc(it.title || it.path) + '</a>'
        : '<span class="dref broken" title="文档目录里找不到 ' + esc(it.target) + '">' +
          esc(it.alias) + ' <span class="ar">→</span> ' + esc(it.target) + '<em>找不到</em></span>';
    });
    return h + '</div>';
  }
  /* 跳过去之后闪一下（章节、结果分组都用）：最容易怀疑的是「是不是没跳对地方」 */
  function flashEl(el) {
    if (!el || !el.classList) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(function () { el.classList.remove('flash'); }, 1600);
  }

  /* ---------- 配置载入：http 下实时读 config.json，file:// 下用内置副本 ---------- */
  function readEmbeddedConfig() {
    var el = $('viewer-config');
    if (!el) return null;
    try { return parseJsonc(el.textContent); } catch (e) { return null; }
  }
  async function loadConfig() {
    var cfg = null, err = null;
    if (/^https?:/.test(location.protocol)) {
      try {
        var res = await fetch('config.json', { cache: 'no-store' });
        if (res.ok) {
          var text = await res.text();
          try { cfg = parseJsonc(text); state.cfgFileLoaded = true; }
          catch (e) { err = 'config.json 解析失败：' + e.message; }
        }
      } catch (e) { /* 回退内置副本 */ }
    }
    if (!cfg) cfg = readEmbeddedConfig();
    state.cfg = deepMerge(DEFAULTS, cfg || {});
    // 后缀统一成小写、带点的形式，config 里写 "mermaid" 或 ".MERMAID" 都能认
    var mm = state.cfg.mindmap || (state.cfg.mindmap = {});
    mm.extensions = (mm.extensions && mm.extensions.length ? mm.extensions : ['.mermaid'])
      .map(function (e) { return String(e).trim().toLowerCase(); })
      .filter(Boolean)
      .map(function (e) { return e.charAt(0) === '.' ? e : '.' + e; });
    state.cfgError = err;
  }
  function applyConfig() {
    var c = state.cfg;
    cwApply();
    $('brandTitle').textContent = c.title || '';
    $('brandSub').textContent = c.subtitle || '';
    $('sidebarTitle').textContent = c.sidebar.title || '';
    $('tocTitle').textContent = (state.mindmap ? '导图大纲' : state.diagram ? '图表' : c.toc.title) || '';
    $('searchWrap').style.display = c.sidebar.showSearch === false ? 'none' : '';
    document.title = (c.title || '文档') + (c.subtitle ? ' ' + c.subtitle : '');
  }

  /* ---------- 侧栏开关（默认值来自 config，可记住上次状态） ---------- */
  function saveLayout() {
    try {
      localStorage.setItem('mdv-panes', JSON.stringify({ left: state.leftOpen, right: state.rightOpen }));
    } catch (e) {}
  }
  function loadLayout() {
    var c = state.cfg;
    state.leftOpen = c.sidebar.defaultOpen === true;
    state.rightOpen = c.toc.defaultOpen !== false;
    try {
      var raw = localStorage.getItem('mdv-panes');
      if (raw) {
        var s = JSON.parse(raw);
        if (c.sidebar.remember !== false && typeof s.left === 'boolean') state.leftOpen = s.left;
        if (c.toc.remember !== false && typeof s.right === 'boolean') state.rightOpen = s.right;
      }
    } catch (e) {}
    // 窄屏下侧栏是抽屉，默认都收起，避免一打开就盖住正文
    if (window.innerWidth < NARROW) { state.leftOpen = false; state.rightOpen = false; }
    syncLayout();
  }
  function syncLayout() {
    document.body.classList.toggle('left-hidden', !state.leftOpen);
    document.body.classList.toggle('right-hidden', !state.rightOpen);
    document.body.classList.toggle('side-open', state.leftOpen || state.rightOpen);
    $('toggleLeft').setAttribute('aria-pressed', String(state.leftOpen));
    $('toggleRight').setAttribute('aria-pressed', String(state.rightOpen));
  }
  function setPane(which, open) {
    // 用户自己动手开合左栏就算接管了它，结果页的「借用」不再替他还原
    if (which === 'left') { srLeftBorrowed = false; state.leftOpen = open; }
    else state.rightOpen = open;
    syncLayout(); saveLayout();
  }
  /* 结果页的左栏导航：左栏本来关着就临时借过来用一下，离开结果页还回去。
     只改内存里的开关、不调 saveLayout，用户的记忆布局不受影响。 */
  var srLeftBorrowed = false;
  function borrowLeftPane() {
    if (state.leftOpen) return;
    srLeftBorrowed = true;
    state.leftOpen = true;
    syncLayout();
  }
  function returnLeftPane() {
    if (!srLeftBorrowed) return;
    srLeftBorrowed = false;
    state.leftOpen = false;
    syncLayout();
  }
  function togglePane(which) {
    setPane(which, which === 'left' ? !state.leftOpen : !state.rightOpen);
  }

  /* ---------- 正文宽度：抓正文左右边缘的感应条，向哪边拖都对称变宽变窄 ---------- */
  var W_MIN = 560;            // 再窄正文就要开始一行折两行了
  var cwUser = null;          // 用户拖出来的宽度；null = 跟 config.reading.maxWidth
  function cwDefault() { return Number(state.cfg.reading && state.cfg.reading.maxWidth) || 920; }
  function cwMain() { return document.querySelector('main'); }
  /* 上限不给固定数字，就是两侧栏之间当下剩多少：窗口缩放、侧栏开合都自动跟着收 */
  function cwClamp(w) {
    var max = cwMain().clientWidth || cwDefault();
    return Math.max(Math.min(W_MIN, max), Math.min(w, max));
  }
  function cwGet() { return cwClamp(cwUser === null ? cwDefault() : cwUser); }
  function cwApply() {
    document.documentElement.style.setProperty('--content-w', cwGet() + 'px');
  }
  function cwSave() {
    try {
      if (cwUser === null) localStorage.removeItem('mdv-content-w');
      else localStorage.setItem('mdv-content-w', String(Math.round(cwUser)));
    } catch (e) {}
  }
  function cwLoad() {
    try {
      var n = Number(localStorage.getItem('mdv-content-w'));
      cwUser = n >= W_MIN ? n : null;   // 没存过（NaN / 0）就回到 config 值
    } catch (e) {}
  }
  /* 中线两侧到中心的距离相等，所以「宽度 = 指针到中线距离 × 2」天然对称；
     感应条有 14px 宽，按下时指针未必正压在边缘上，先记下这段偏差再补回来。 */
  function cwFromPointer(x, grab) {
    var r = cwMain().getBoundingClientRect();
    return 2 * Math.abs(x - (r.left + r.width / 2)) + grab;
  }
  function initWidthEdges() {
    var main = cwMain();
    cwApply();                    // 侧栏开合已定，先按当下可用宽度裁一次，不等 RO 首回调
    [].forEach.call(main.querySelectorAll('.w-edge'), function (el) {
      var dragging = false, startW = 0, grab = 0;
      el.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        dragging = true;
        startW = cwGet();
        grab = startW - cwFromPointer(e.clientX, 0);
        el.setPointerCapture(e.pointerId);
        document.body.classList.add('w-dragging');
        e.preventDefault();               // 顺带掐掉拖动路上选中正文文字
      });
      el.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        cwUser = cwClamp(cwFromPointer(e.clientX, grab));   // 拖不动的就是上限，存也存裁过的
        cwApply();                        // 实时跟手：正文是居中块，改一个变量就够
      });
      function stop(e) {
        if (!dragging) return;
        dragging = false;
        try { el.releasePointerCapture(e.pointerId); } catch (err) {}
        document.body.classList.remove('w-dragging');
        cwSave();                         // 只在松手时落盘，拖一行代码存一次没必要
      }
      el.addEventListener('pointerup', stop);
      el.addEventListener('pointercancel', stop);
      el.addEventListener('dblclick', function () {
        cwUser = null; cwApply(); cwSave();   // 双击 = 回到 config 里那个默认宽度
      });
    });
    /* main 的宽度只由两侧栏决定，跟正文宽窄无关，所以观察它不会来回打架 */
    if (window.ResizeObserver) {
      new ResizeObserver(function () { cwApply(); }).observe(main);
    } else {
      window.addEventListener('resize', cwApply);
    }
  }

  /* ---------- 动效 ---------- */
  function popArticle() {                 // 换文档时正文淡入上浮
    var el = $('article');
    el.classList.remove('pop');
    void el.offsetWidth;                  // 强制回流，让动画可以重新触发
    el.classList.add('pop');
  }
  function enableMotion() {               // 首屏布局落定后再开动效，避免加载时侧栏“滑一下”
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { document.documentElement.classList.remove('preload'); });
    });
  }

  /* ---------- 文档载入 ---------- */
  function readSnapshot() {
    try { return JSON.parse($('docs-snapshot').textContent); }
    catch (e) { return { generatedAt: null, docs: [] }; }
  }
  function indexDocs(list) {
    state.byPath = {}; state.byBase = {};
    sectionCache = {};
    list.forEach(function (d) {
      state.byPath[d.path] = d;
      var b = baseOf(d.path);
      if (!state.byBase[b]) state.byBase[b] = d;
    });
  }
  async function loadDocs() {
    var snap = readSnapshot();
    state.skipped = snap.skipped || 0;
    if (/^https?:/.test(location.protocol)) {
      try {
        var res = await fetch('docs-index.json', { cache: 'no-store' });
        if (res.ok) {
          var idx = await res.json();
          var docs = await Promise.all((idx.docs || []).map(async function (meta) {
            try {
              var r = await fetch(meta.path, { cache: 'no-store' });
              if (!r.ok) return null;
              return Object.assign({}, meta, { text: await r.text() });
            } catch (e) { return null; }
          }));
          docs = docs.filter(Boolean);
          if (docs.length) {
            state.mode = 'live';
            state.generatedAt = idx.generatedAt;
            state.skipped = idx.skipped || 0;
            return docs;
          }
        }
      } catch (e) { /* 回退快照 */ }
    }
    state.mode = 'snapshot';
    state.generatedAt = snap.generatedAt;
    return (snap.docs || []).slice();
  }

  /* ---------- 按 config 决定左栏显示哪些文档 ---------- */
  function applyDocFilter() {
    var c = state.cfg.sidebar;
    var docs = state.docs.slice();
    var ex = c.exclude || [];
    if (ex.length) {
      docs = docs.filter(function (d) {
        return !ex.some(function (p) {
          p = normDir(p);
          return d.path === p || d.path.indexOf(p + '/') === 0;
        });
      });
    }
    var ov = c.docs || {};
    docs = docs.map(function (d) {
      var o = ov[d.path];
      if (!o) return d;
      if (o.hidden) return null;
      return (typeof o.title === 'string' && o.title) ? Object.assign({}, d, { title: o.title }) : d;
    }).filter(Boolean);

    var folders = c.folders || [];
    if (folders.length) {
      var allow = folders.map(function (f) { return normDir(typeof f === 'string' ? f : f.dir); });
      docs = docs.filter(function (d) {
        return allow.some(function (a) { return d.path.indexOf(a + '/') === 0; });
      });
    }

    var rank = {};
    (c.order || []).forEach(function (p, i) { rank[p] = i; });
    docs.sort(function (a, b) {
      var ra = (a.path in rank) ? rank[a.path] : Infinity;
      var rb = (b.path in rank) ? rank[b.path] : Infinity;
      if (ra !== rb) return ra - rb;
      return dirOf(a.path).localeCompare(dirOf(b.path), 'zh-Hans-CN') || byPathZh(a, b);
    });
    state.visible = docs;
  }

  /* ---------- 侧栏 ---------- */
  function summaryOf(doc) {
    if (isMindmapDoc(doc)) {
      try {
        var tree = MindmapCore.parse(doc.text || '');
        var stat = MindmapCore.summary(tree);
        if (!stat.count) return '思维导图（未解析出节点）';
        return '思维导图 · ' + stat.count + ' 个节点 · ' + (stat.depth + 1) + ' 层';
      } catch (e) { return '思维导图'; }
    }
    var lines = String(doc.text || '').split('\n');
    var decls = Core.parseRefs(String(doc.text || '')).lineSet;   // 文首声明行不算摘要
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l || decls[i]) continue;
      if (/^#{1,6}\s/.test(l) || /^\||^>|^```|^[-*+]\s|^\d+[.)]\s|^<|^-{3,}$/.test(l)) continue;
      var s = Core.plain(l, htmlMode()).replace(/\s+/g, ' ');
      return s.length > 88 ? s.slice(0, 88) + '…' : s;
    }
    return '';
  }
  function groupDocs(docs) {
    var folders = state.cfg.sidebar.folders || [];
    var labelOf = {}, rankOf = {};
    folders.forEach(function (f, i) {
      var dir = normDir(typeof f === 'string' ? f : f.dir);
      rankOf[dir] = i;
      if (f && typeof f === 'object' && f.label) labelOf[dir] = f.label;
    });
    var groups = [], map = {};
    docs.forEach(function (d) {
      var dir = dirOf(d.path) || '.';
      if (!map[dir]) {
        map[dir] = { dir: dir, label: labelOf[dir] || (dir === '.' ? '根目录' : dir), docs: [] };
        groups.push(map[dir]);
      }
      map[dir].docs.push(d);
    });
    groups.sort(function (a, b) {
      var ra = (a.dir in rankOf) ? rankOf[a.dir] : Infinity;
      var rb = (b.dir in rankOf) ? rankOf[b.dir] : Infinity;
      if (ra !== rb) return ra - rb;
      if (a.dir === '.') return -1;
      if (b.dir === '.') return 1;
      return a.dir.localeCompare(b.dir, 'zh-Hans-CN');
    });
    return groups;   // 组内顺序沿用 applyDocFilter 排好的顺序
  }
  function searchDocs(q) {
    q = q.trim().toLowerCase();
    if (!q) return null;
    var hits = [];
    state.visible.forEach(function (d) {
      var nameHit = (d.title + ' ' + d.path).toLowerCase().indexOf(q) >= 0;
      var count = 0, snippet = '', text = String(d.text || ''), low = text.toLowerCase();
      var idx = low.indexOf(q);
      while (idx >= 0 && count < 500) {
        count++;
        if (!snippet) {
          snippet = text.slice(Math.max(0, idx - 24), idx + q.length + 46).replace(/\s+/g, ' ').trim();
        }
        idx = low.indexOf(q, idx + q.length);
      }
      if (nameHit || count) hits.push({ doc: d, nameHit: nameHit, count: count, snippet: snippet });
    });
    hits.sort(function (a, b) { return (b.nameHit - a.nameHit) || (b.count - a.count); });
    return hits;
  }
  function renderSidebar() {
    var q = $('search').value;
    var tree = $('tree');
    // 结果页会把左栏借去做文件导航（顺带改标题），回到目录视图得还回来
    $('sidebarTitle').textContent = state.cfg.sidebar.title || '';
    var showCounts = state.cfg.sidebar.showCounts !== false;
    var hits = searchDocs(q);

    if (hits) {
      if (!hits.length) {
        tree.innerHTML = '<div class="empty">没有匹配「' + esc(q) + '」的文档</div>';
        return;
      }
      var h = '<div class="dir">搜索结果 <span class="n">' + hits.length + ' 篇</span></div>';
      hits.forEach(function (r) {
        h += '<a class="docitem' + (state.current && state.current.path === r.doc.path ? ' active' : '') +
          '" href="' + docHref(r.doc.path) + '">' +
          '<span class="t">' + esc(r.doc.title) +
          (r.count ? ' <span class="hit">' + r.count + ' 处</span>' : '') + '</span>' +
          '<span class="s">' + esc(r.snippet || r.doc.path) + '</span></a>';
      });
      tree.innerHTML = h;
      return;
    }

    var html = '';
    groupDocs(state.visible).forEach(function (g) {
      html += '<div class="dir">' + esc(g.label) +
        (showCounts ? ' <span class="n">' + g.docs.length + '</span>' : '') + '</div>';
      g.docs.forEach(function (d) {
        var active = state.current && state.current.path === d.path;
        html += '<a class="docitem' + (active ? ' active' : '') + '" href="' + docHref(d.path) +
          '" title="' + esc(d.path) + '">' +
          '<span class="t">' + esc(d.title) +
          (isMindmapDoc(d) ? ' <span class="chip-mm" title="' + esc(docKindLabel(d)) + '">' + esc(docKindLabel(d)) + '</span>' : '') + '</span>' +
          '<span class="s">' + esc(baseOf(d.path)) + '</span></a>';
      });
    });
    tree.innerHTML = html ||
      '<div class="empty">当前没有可显示的文档。<br>请检查 config.json 的 folders / exclude / docs 设置。</div>';
  }
  function renderFoot() {
    var total = state.docs.length, shown = state.visible.length;
    var chars = state.visible.reduce(function (n, d) { return n + String(d.text || '').length; }, 0);
    var lines = [];
    lines.push('目录共 <strong>' + total + '</strong> 篇' +
      (shown !== total ? ' · 当前显示 <strong>' + shown + '</strong> 篇' : '') +
      ' · 约 ' + (chars / 10000).toFixed(1) + ' 万字' +
      (state.skipped ? ' · 忽略 ' + state.skipped + ' 个非 md 文件' : ''));
    lines.push('数据来源：' + (state.mode === 'live' ? '实时读取 docs/'
      : '离线快照' + (state.generatedAt ? '（' + new Date(state.generatedAt).toLocaleString('zh-CN') + '）' : '')));
    lines.push('显示内容由 <code>config.json</code> 管理');
    lines.push('快捷键：<kbd>[/]</kbd> 左右栏 · <kbd>/</kbd> 搜索 · <kbd>Esc</kbd> 清除 · <kbd>Ctrl</kbd>+<kbd>P</kbd> 打印');
    if (state.cfgError) lines.push('<span class="warn">⚠ ' + esc(state.cfgError) + '</span>');
    $('foot').innerHTML = lines.join('<br>');
  }

  /* ==================================================================
     全文搜索（顶栏搜索条 → 正文区结果页）
     - 范围：启动时导入的全部文档原文（含 config 里 hidden 的），大小写不敏感
     - 结果按文档分组，每条给出「所在章节 + 命中行 ±1 行上下文 + 行号」
     - 点结果：#p=…&h=…&q=…&k=…，正文里所有命中处标 <mark>，滚到这一条那一处
     - 匹配按行做，所以跨行的短语不算命中（输入框本身就是单行）
     ================================================================== */
  var SR_MAX_PER_DOC = 40;    // 单篇最多列出多少处
  var SR_MAX_TOTAL = 400;     // 整页最多列出多少处
  var SR_CTX_CHARS = 150;     // 上下文每行截断长度
  var XHTML = 'http://www.w3.org/1999/xhtml';

  function searchHref(path, q, occ, section) {
    return '#p=' + enc(path) + (section ? '&h=' + enc(section) : '') +
      '&q=' + enc(q) + '&k=' + occ;
  }

  function searchAll(qraw) {
    var raw = String(qraw || '').trim();
    var q = raw.toLowerCase();
    if (!q) return null;
    var groups = [], all = 0, shown = 0;
    state.docs.forEach(function (doc, order) {
      var lines = String(doc.text || '').replace(/\r\n?/g, '\n').split('\n');
      var decls = docRefs(doc).lineSet;              // 文首声明行不进正文，搜它只会跳不到地方
      var heads = Core.scanHeadings(lines.join('\n'), htmlMode());
      var hits = [], hi = 0, sec = null, occ = 0;
      for (var i = 0; i < lines.length; i++) {
        while (hi < heads.length && heads[hi].line <= i) { sec = heads[hi]; hi++; }
        if (decls[i]) continue;
        var low = lines[i].toLowerCase(), at = low.indexOf(q);
        while (at >= 0) {
          all++;
          if (shown < SR_MAX_TOTAL && hits.length < SR_MAX_PER_DOC) {
            hits.push({
              line: i, col: at, occ: occ, sec: sec, text: lines[i],
              before: i > 0 && !decls[i - 1] ? lines[i - 1] : '',
              after: i + 1 < lines.length && !decls[i + 1] ? lines[i + 1] : ''
            });
            shown++;
          }
          occ++;
          at = low.indexOf(q, at + q.length);
        }
      }
      if (hits.length) groups.push({
        doc: doc, hits: hits, all: occ, order: order,
        graphic: isMindmapDoc(doc),   // 整篇画成图的文档（.mermaid）没法在正文里定位
        nameHit: String(doc.title || '').toLowerCase().indexOf(q) >= 0
      });
    });
    groups.sort(function (a, b) { return (b.nameHit - a.nameHit) || (a.order - b.order); });
    return { raw: raw, q: q, groups: groups, docs: groups.length, all: all, shown: shown };
  }

  /* 截断一行的显示宽度：命中位置太靠后时改成「以命中处为中心开窗」，别把命中截没了 */
  function srCut(s, at) {
    s = String(s == null ? '' : s).replace(/\t/g, '    ');
    if (s.length <= SR_CTX_CHARS) return s;
    if (typeof at === 'number' && at > SR_CTX_CHARS - 24) {
      var from = Math.max(0, Math.min(at - 20, s.length - SR_CTX_CHARS));
      return (from > 0 ? '…' : '') + s.slice(from, from + SR_CTX_CHARS) +
        (from + SR_CTX_CHARS < s.length ? '…' : '');
    }
    return s.slice(0, SR_CTX_CHARS) + '…';
  }
  /* 先按原文找到命中处，再逐段转义拼接：先转义会打乱偏移 */
  function srMark(s, q) {
    var low = String(s).toLowerCase(), at = low.indexOf(q), pos = 0, out = '';
    while (at >= 0) {
      out += esc(String(s).slice(pos, at)) + '<mark>' + esc(String(s).slice(at, at + q.length)) + '</mark>';
      pos = at + q.length; at = low.indexOf(q, pos);
    }
    return out + esc(String(s).slice(pos));
  }

  function renderSearchPage(qraw) {
    var q = String(qraw || '').trim();
    state.current = null;
    state.mindmap = null; state.diagram = null; state.headings = [];
    exitMindmapFullscreen();
    exitMermaidFullscreen();
    applyConfig();
    $('docPath').textContent = q ? '全文搜索：' + q : '全文搜索';
    $('tocList').innerHTML = '<li class="toc-empty">搜索结果页没有本篇目录</li>';
    $('prevBtn').disabled = true; $('nextBtn').disabled = true;
    document.title = (q ? q + ' · 搜索' : '搜索') + (state.cfg.subtitle ? ' ' + state.cfg.subtitle : '');

    var res = q ? searchAll(q) : null;
    var html = '<div class="search-page"><h1>搜索结果</h1>' +
      '<div class="meta">' +
      '<span>关键词 <code>' + esc(q || '（空）') + '</code></span>' +
      (res ? '<span>' + res.all + ' 处命中 · ' + res.docs + ' 篇文档</span>' : '') +
      '<span class="no-print">范围：启动时导入的 ' + state.docs.length + ' 篇文档</span>' +
      '<span class="no-print">点任意一条跳到正文里的命中处</span></div>';
    if (!res) {
      html += '<div class="empty">在上面的搜索条里输入内容，回车或点右侧的放大镜开始搜索。</div>';
    } else if (!res.groups.length) {
      html += '<div class="empty">没有匹配「' + esc(q) + '」的内容。<br>' +
        '搜索不区分大小写，但只在同一行内匹配，且只覆盖导入的 Markdown / 思维导图文档正文。</div>';
    } else {
      if (res.all > res.shown) {
        html += '<div class="notice">命中太多，只列出前 ' + res.shown + ' 处（共 ' + res.all +
          ' 处）。换个更长的关键词试试。</div>';
      }
      res.groups.forEach(function (g, gi) {
        html += '<section class="sr-group" id="sr-g-' + gi + '"><div class="sr-head">' +
          '<a class="sr-t" href="' + docHref(g.doc.path) + '">' + esc(g.doc.title) + '</a>' +
          '<span class="sr-p">' + esc(g.doc.path) + '</span>' +
          (g.graphic ? '<span class="sr-graph" title="整篇画成图，点开只能打开文档，定位不到命中处">图形文档 · 不定位</span>' : '') +
          '<span class="sr-n">' + g.all + ' 处</span></div>';
        g.hits.forEach(function (h) {
          var href = g.graphic ? docHref(g.doc.path) : searchHref(g.doc.path, q, h.occ, h.sec && h.sec.id);
          html += '<a class="sr-item" href="' + href + '">' +
            '<span class="sr-sec">' + esc(h.sec ? Core.plain(h.sec.text, htmlMode()) : '文档开头') +
            '<span class="sr-ln">第 ' + (h.line + 1) + ' 行</span></span>' +
            '<span class="sr-ctx">' +
            (h.before ? '<i>' + srMark(srCut(h.before), res.q) + '</i>' : '') +
            '<b>' + srMark(srCut(h.text, h.col), res.q) + '</b>' +
            (h.after ? '<i>' + srMark(srCut(h.after), res.q) + '</i>' : '') +
            '</span></a>';
        });
        if (g.all > g.hits.length) {
          html += '<span class="sr-more">这篇还有 ' + (g.all - g.hits.length) + ' 处没有列出</span>';
        }
        html += '</section>';
      });
    }
    $('article').innerHTML = html + '</div>';
    renderSearchNav(res);
    popArticle();
    window.scrollTo(0, 0);
  }

  /* 左栏的「结果文件导航」：点一条把视口移到正文里对应的那一组。
     用 <button> 而不是 <a href>：导航项不该改 hash，一改就把结果页顶掉了。
     离开结果页时 renderSidebar() 会把标题和目录树还原。 */
  function renderSearchNav(res) {
    var tree = $('tree');
    $('sidebarTitle').textContent = '搜索结果导航';
    if (!res) {
      tree.innerHTML = '<div class="empty">还没输入关键词。</div>';
    } else if (!res.groups.length) {
      tree.innerHTML = '<div class="empty">没有匹配的文档。</div>';
    } else {
      var h = '<div class="dir">命中文件<span class="n">' + res.groups.length + ' 篇 · ' + res.all + ' 处</span></div>';
      res.groups.forEach(function (g, gi) {
        h += '<button type="button" class="docitem sr-nav" data-g="sr-g-' + gi + '">' +
          '<span class="t">' + esc(g.doc.title) + ' <span class="hit">' + g.all + ' 处</span></span>' +
          '<span class="s">' + esc(g.doc.path) + '</span></button>';
      });
      tree.innerHTML = h;
      borrowLeftPane();          // 有东西可导航才把左栏借出来
    }
    $('sidebar').scrollTop = 0;
  }
  function searchNavJump(btn) {
    var g = document.getElementById(btn.getAttribute('data-g'));
    if (!g) return;
    var items = $('tree').querySelectorAll('.sr-nav');
    Array.prototype.forEach.call(items, function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    // 系统开了「减弱动效」就不滚，直接落位
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    g.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });     // 躲开顶栏与搜索条由 .sr-group 的 scroll-margin 负责
    flashEl(g);
    if (window.innerWidth < NARROW) setPane('left', false);
  }

  /* ---------- 页内命中高亮与跳转 ---------- */
  var HIT_SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1, HEAD: 1, MARK: 1 };
  function highlightHits(root, q) {
    var low = String(q || '').toLowerCase();
    if (!low) return [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || n.nodeValue.toLowerCase().indexOf(low) < 0) return NodeFilter.FILTER_REJECT;
        for (var p = n.parentElement; p && p !== root; p = p.parentElement) {
          if (p.namespaceURI !== XHTML) return NodeFilter.FILTER_REJECT;   // svg 里的文字包不出 mark
          if (HIT_SKIP[String(p.tagName).toUpperCase()]) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    var marks = [];
    nodes.forEach(function (tn) {
      var text = tn.nodeValue, lt = text.toLowerCase(), at = lt.indexOf(low), pos = 0;
      var frag = document.createDocumentFragment();
      while (at >= 0) {
        if (at > pos) frag.appendChild(document.createTextNode(text.slice(pos, at)));
        var mk = document.createElement('mark');
        mk.className = 'sr-hit';
        mk.textContent = text.slice(at, at + low.length);
        frag.appendChild(mk); marks.push(mk);
        pos = at + low.length; at = lt.indexOf(low, pos);
      }
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      if (tn.parentNode) tn.parentNode.replaceChild(frag, tn);
    });
    return marks;
  }
  function clearHits() {
    var art = $('article');
    var ms = art.querySelectorAll('mark.sr-hit');
    Array.prototype.forEach.call(ms, function (m) {
      var p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
    });
    if (ms.length && art.normalize) art.normalize();
    return ms.length;
  }
  /* 跳到第 occ 处命中。序号是「源码里的第几处」，正文里的顺序通常一致，
     但命中落在被图形替换掉的围栏里时会对不上 —— 所以知道章节就先按章节取第一处。 */
  function jumpToMatch(q, occ, section) {
    var marks = highlightHits($('article'), q);
    if (!marks.length) return false;
    // 命中可能落在被折叠起来的源码块里，滚过去也看不见：只在看得见的那些里挑
    var vis = marks.filter(function (m) { return m.offsetParent !== null; });
    var el = null;
    var anchor = section ? document.getElementById(section) : null;
    if (anchor) {
      for (var i = 0; i < vis.length; i++) {
        if (vis[i] === anchor ||
          (anchor.compareDocumentPosition(vis[i]) & Node.DOCUMENT_POSITION_FOLLOWING)) { el = vis[i]; break; }
      }
    }
    if (!el) el = vis[Math.max(0, Math.min(Number(occ) || 0, vis.length - 1))] || marks[0];
    el.className += ' sr-cur';
    if (el.offsetParent === null) return false;    // 一处都看不见：退回按章节定位
    el.scrollIntoView({ block: 'center' });
    // 图是异步画的，画完正文会上下位移，落点得按新位置再对一次
    if (state.mgPromise && state.mgPromise.then) {
      state.mgPromise.then(function () {
        if (document.body.contains(el)) el.scrollIntoView({ block: 'center' });
      }).catch(function () {});
    }
    return true;
  }

  /* ---------- 首页 ---------- */
  function renderOverview() {
    state.current = null;
    $('docPath').textContent = '';
    $('tocList').innerHTML = '<li class="toc-empty">打开一篇文档后显示目录</li>';
    applyConfig();
    var h = state.cfg.home || {};
    var total = state.docs.length, shown = state.visible.length;
    var html = '';
    if (h.title) html += '<h1>' + esc(h.title) + '</h1>';
    html += '<div class="meta">' +
      '<span>共 ' + total + ' 篇 Markdown 文档</span>' +
      (shown !== total ? '<span>当前显示 ' + shown + ' 篇（由 config.json 控制）</span>' : '') +
      '<span>' + (state.mode === 'live' ? '实时读取 docs/' : '离线快照模式') + '</span>' +
      '<span class="no-print">点击卡片开始阅读</span></div>';
    if (state.cfgError) html += '<div class="notice">⚠ ' + esc(state.cfgError) + '</div>';
    if (h.intro) {
      try { html += '<div class="intro">' + Core.render(String(h.intro), ctxFor('')).html + '</div>'; }
      catch (e) { html += '<div class="notice">⚠ 首页 intro 渲染失败：' + esc(e.message) + '</div>'; }
    }
    if (h.showCards !== false) {
      groupDocs(state.visible).forEach(function (g) {
        html += '<h2>' + esc(g.label) + '</h2><div class="cards">';
        g.docs.forEach(function (d) {
          html += '<a class="card" href="' + docHref(d.path) + '">' +
            '<div class="ct">' + esc(d.title) + '</div>' +
            '<div class="cp">' + esc(d.path) + '</div>' +
            '<div class="cs">' + esc(summaryOf(d)) + '</div>' +
            '<div class="cc">' + (d.size ? (d.size / 1024).toFixed(1) + ' KB · ' : '') +
            '约 ' + String(d.text || '').length + ' 字</div></a>';
        });
        html += '</div>';
      });
    }
    $('article').innerHTML = '<div class="overview">' + html + '</div>';
    exitMindmapFullscreen();
    popArticle();
    window.scrollTo(0, 0);
  }

  /* ---------- 正文 ---------- */
  function renderDoc(path, section, jump) {
    var doc = state.byPath[path];
    if (!doc) { renderOverview(); return; }
    state.current = doc;
    state.mindmap = null;                 // 离开导图：把画布拆掉，换回普通正文
    state.diagram = null;                 // 离开图表文档同理
    exitMindmapFullscreen();             // 上一页要是全屏看的导图，这里得把滚动锁解掉
    exitMermaidFullscreen();             // 同理：上一页全屏看的图表也要还原
    var out;
    var refs = docRefs(doc);
    try {
      var ctx = ctxFor(path);
      ctx.refs = refs.map;               // 别名 -> 真实文档路径（供「父文档 §4.1」使用）
      ctx.declLines = refs.lineSet;      // 文首声明行不参与正文渲染
      out = Core.render(doc.text || '', ctx);
    } catch (e) {
      $('article').innerHTML = '<h1>渲染失败</h1><pre class="code"><code>' +
        esc(String((e && e.stack) || e)) + '</code></pre>';
      return;
    }
    state.headings = out.headings;
    var chars = String(doc.text || '').length;
    $('article').innerHTML =
      '<div class="meta"><span>' + (doc.size ? (doc.size / 1024).toFixed(1) + ' KB' : '') + '</span>' +
      '<span>约 ' + chars + ' 字</span>' +
      '<span>' + out.headings.length + ' 个标题</span>' +
      '<span class="no-print">' + esc(doc.path) + '</span></div>' +
      docRefsHtml(refs) + out.html;
    $('docPath').textContent = doc.path;
    popArticle();
    document.title = doc.title + (state.cfg.subtitle ? ' ' + state.cfg.subtitle : '');
    mountMermaid();                      // 正文里的 ```mermaid 围栏在这里画成图

    var maxDepth = Number(state.cfg.toc.maxDepth) || 4;
    var toc = '';
    out.headings.forEach(function (h) {
      if (h.level < 2 || h.level > maxDepth) return;
      toc += '<li class="lv' + h.level + '"><a href="' + docHref(doc.path, h.id) +
        '" data-sec="' + esc(h.id) + '">' + esc(Core.plain(h.text, htmlMode())) + '</a></li>';
    });
    $('tocList').innerHTML = toc || '<li class="toc-empty">本文无二级标题</li>';

    renderSidebar();
    var idx = state.visible.indexOf(doc);
    $('prevBtn').disabled = idx <= 0;
    $('nextBtn').disabled = idx < 0 || idx >= state.visible.length - 1;

    requestAnimationFrame(function () {
      if (!(jump && jump.q && jumpToMatch(jump.q, jump.occ, section))) {
        var el = section ? document.getElementById(section) : null;
        if (el) { el.scrollIntoView({ block: 'start' }); flashEl(el); }
        else window.scrollTo(0, 0);
      }
      setupSpy();
    });
  }

  /* ---------- 目录高亮 ---------- */
  var spy = null;
  function setupSpy() {
    if (spy) spy.disconnect();
    var links = Array.prototype.slice.call($('tocList').querySelectorAll('a[data-sec]'));
    if (!links.length || !('IntersectionObserver' in window)) return;
    var map = {};
    links.forEach(function (a) { map[a.getAttribute('data-sec')] = a; });
    spy = new IntersectionObserver(function (entries) {
      var visible = entries.filter(function (e) { return e.isIntersecting; });
      if (!visible.length) return;
      visible.sort(function (a, b) { return a.boundingClientRect.top - b.boundingClientRect.top; });
      var id = visible[0].target.id;
      links.forEach(function (a) { a.classList.remove('active'); });
      if (map[id]) map[id].classList.add('active');
    }, { rootMargin: '-64px 0px -70% 0px', threshold: 0 });
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) spy.observe(el);
    });
  }

  /* ==================================================================
     思维导图视图（.mermaid → markmap）
     - 解析与 Markdown 转换在 mindmap-core 里（纯函数，可单测）
     - 这里只负责：探测后缀、挂载容器、调 markmap、同步右侧大纲、导出图片
     ================================================================== */  function mindmapEnabled() { return state.cfg.mindmap && state.cfg.mindmap.enabled !== false; }
  function isMindmapPath(p) {
    if (!mindmapEnabled()) return false;
    var lower = String(p || '').toLowerCase();
    return (state.cfg.mindmap.extensions || ['.mermaid']).some(function (ext) {
      return ext && lower.slice(-ext.length) === ext;
    });
  }
  /* 是不是导图文档：config 关掉后一律按普通文档处理（哪怕是 .mermaid）。
     不能只看 kind —— kind 是构建时按后缀定下的，config 关掉后它也应该失效。 */
  function isMindmapDoc(doc) {
    if (!doc || !mindmapEnabled()) return false;
    return doc.kind === 'mindmap' || isMindmapPath(doc.path);
  }
  /* .mermaid 文件里写的其实是别的版式（stateDiagram-v2 / flowchart…）时，交给 mermaid 画，
     不再硬按思维导图解析（那种文件在 mindmap 版式下只会报「解析失败」）。 */
  function diagramKindOf(doc) {
    if (!doc || !mermaidEnabled() || typeof MermaidCore === 'undefined' || !MermaidCore.diagramKind) return null;
    return MermaidCore.diagramKind(doc.text || '');
  }
  /* 左栏小标记：导图（mindmap 版式）/ 图表（.mermaid 里写的其它版式） */
  function docKindLabel(doc) {
    if (diagramKindOf(doc)) return '图表';
    return '导图';
  }

  /* 深色主题下给画布上的文字加白色描边，否则 markmap 内联样式带来的深色文字会看不清 */
  function mindmapInkColor() {
    var c = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim();
    return c || '#2c3138';
  }
  function mindmapDownloadName(doc, ext) {
    var base = String((doc && doc.title) || 'mindmap').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'mindmap';
    return base + '.' + ext;
  }
  function triggerDownload(blobOrUrl, filename) {
    var url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      document.body.removeChild(a);
      if (typeof blobOrUrl !== 'string') setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }
  }

  /* 思维导图占满阅读区：容器高度 = 视口 - 顶栏 - 底部信息条 */
  function mindmapHtml(doc) {
    var title = (doc && (doc.title || doc.name)) || '';
    var cfg = state.cfg.mindmap || {};
    var buttons = '<button class="btn" id="mmFit" title="缩放回合适大小">适应</button>' +
      '<button class="btn" id="mmFold" title="折叠到最后一级 / 展开全部">折叠</button>' +
      '<button class="btn" id="mmFull" title="全页面显示（充满整个浏览器窗口）" aria-pressed="false">全屏</button>';
    if (cfg.exportImage !== false) {
      buttons += '<button class="btn" id="mmSvg" title="把当前导图导出为 SVG">SVG</button>' +
        '<button class="btn" id="mmPng" title="把当前导图导出为 PNG">PNG</button>';
    }
    return '' +
      '<div class="mm" id="mmWrap">' +
        '<div class="mm-bar">' +
          '<span class="mm-title" title="' + esc(title) + '">' + esc(title) + '</span>' +
          '<span class="mm-stats" id="mmStats"></span>' +
          '<span class="grow"></span>' +
          buttons +
        '</div>' +
        '<div class="mm-stage">' +
          '<svg class="mm-canvas" id="mmSvgEl" role="img" aria-label="思维导图：' + esc(title) + '"></svg>' +
          '<div class="mm-fallback" id="mmFallback" hidden></div>' +
        '</div>' +
        '<div class="mm-hint">滚轮缩放 · 拖拽平移 · 点击节点折叠／展开</div>' +
      '</div>';
  }

  function mmFail(msg, detail) {
    var box = $('mmFallback');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<div class="notice">⚠ ' + esc(msg) + '</div>' +
      (detail ? '<pre class="code"><code>' + esc(detail) + '</code></pre>' : '');
    var canvas = $('mmSvgEl');
    if (canvas) canvas.style.display = 'none';
  }

  /* ---------- 全页面显示（充满整个浏览器窗口） ----------
     用 CSS 覆盖层（.mm-full）而不是 Fullscreen API：file:// 下不需要用户手势授权，
     退出也不受浏览器自身全屏状态（F11）影响；按钮再点一次或按 Esc 都能还原。 */
  function mmFullscreenOn() {
    var wrap = $('mmWrap');
    return !!(wrap && wrap.classList.contains('mm-full'));
  }
  /* 换文档时容器已被 innerHTML 换掉：只清根元素上的滚动锁和残留状态 */
  function exitMindmapFullscreen() {
    document.documentElement.classList.remove('mm-full-on');
    var wrap = $('mmWrap');
    if (wrap) wrap.classList.remove('mm-full');
  }
  /* 容器尺寸变了（进出全屏、窗口缩放）后把导图重新适应一次。
     fit() 读的是 svg 的 getBoundingClientRect，必须等布局落定后再调。 */
  function refitMindmap() {
    var fit = function () {
      var mm = state.mm;
      if (!mm) return;
      try { mm.fit(); } catch (e) {}
    };
    requestAnimationFrame(fit);
    setTimeout(fit, 260);            // 覆盖层切换后浏览器可能还在重排，补一次
  }
  function setMindmapFullscreen(on) {
    var wrap = $('mmWrap');
    if (!wrap) return;
    var want = (on === undefined) ? !mmFullscreenOn() : !!on;
    wrap.classList.toggle('mm-full', want);
    // 覆盖层是 fixed 定位：锁住底层页面滚动，退出时才不会"跳回顶部"
    document.documentElement.classList.toggle('mm-full-on', want);
    var btn = $('mmFull');
    if (btn) {
      btn.textContent = want ? '退出全屏' : '全屏';
      btn.title = want ? '退出全页面显示（Esc）' : '全页面显示（充满整个浏览器窗口）';
      btn.setAttribute('aria-pressed', want ? 'true' : 'false');
    }
    refitMindmap();
  }

  /* ---------- 大纲 ---------- */
  /* 折叠状态只有一个来源：节点自身的 ref.fold（markmap 读的就是它）。
     it.collapsed 只是渲染时的快照，由 markCollapsed() 统一从 ref.fold 同步。 */
  function flatOutline(list, parent, out) {
    out = out || [];
    (list || []).forEach(function (item) {
      item.parent = parent || null;
      out.push(item);
      flatOutline(item.children, item, out);
    });
    return out;
  }
  function markCollapsed(item) { item.collapsed = !!item.ref.fold; return item.collapsed; }
  function markCollapsedAll() {
    flatOutline(state.mmOutline, null, []).forEach(markCollapsed);
  }
  /* 按初始展开层级折叠：深度达到层级的节点整体收起，形成可点开的分支 */
  function applyInitialFold(list, level, depth) {
    (list || []).forEach(function (item) {
      var hasKids = item.children && item.children.length;
      if (hasKids && depth >= level) item.ref.fold = true;   // 折叠自身，子树在展开前不显示
      else if (hasKids) applyInitialFold(item.children, level, depth + 1);
    });
  }
  function setOutlineActive(el) {
    var list = $('tocList');
    if (!list) return;
    Array.prototype.forEach.call(list.querySelectorAll('.mm-o-item.active'), function (x) { x.classList.remove('active'); });
    if (el) el.classList.add('active');
  }
  function outlineElFor(item) {
    var list = $('tocList');
    if (!list) return null;
    var els = list.querySelectorAll('.mm-o-item');
    for (var i = 0; i < els.length; i++) {
      if (els[i].dataset.path === item.path) return els[i];
    }
    return null;
  }
  /* 把一项的折叠状态刷到 DOM，并沿父链更新（父节点可能因此从折叠变展开） */
  function syncOutlineItems() {
    markCollapsedAll();
    flatOutline(state.mmOutline, null, []).forEach(function (it) {
      var el = outlineElFor(it);
      if (!el) return;
      el.classList.toggle('collapsed', it.collapsed);
      var caret = el.querySelector('.mm-o-caret');
      if (caret && it.children.length) caret.textContent = it.collapsed ? '▸' : '▾';
    });
  }
  function renderMindmapOutline(expandTo) {
    var list = $('tocList');
    if (!list) return;
    if ((state.cfg.mindmap || {}).showOutline === false) {
      list.innerHTML = '<li class="toc-empty">已按 config.json 关闭导图大纲（mindmap.showOutline）</li>';
      return;
    }
    var o = state.mmOutline;
    if (!o.length) {
      list.innerHTML = '<li class="toc-empty">这份导图没有子节点</li>';
      return;
    }
    // 打开文档时按 config 的初始层级把上层分支摊开
    flatOutline(o, null, []).forEach(function (it) {
      if (expandTo && it.level < expandTo) it.ref.fold = false;
      markCollapsed(it);
    });
    var html = '';
    function walk(items) {
      items.forEach(function (it) {
        var kids = it.children && it.children.length;
        html += '<li class="mm-o lv' + Math.min(it.level + 1, 5) + '">' +
          '<div class="mm-o-item' + (it.collapsed ? ' collapsed' : '') +
          '" data-path="' + esc(it.path) + '" data-jump="' + esc(it.path) + '" tabindex="0" role="button"' +
          ' title="' + esc(it.text) + '">' +
          '<span class="mm-o-caret"' + (kids ? '' : ' data-leaf="1"') + '>' +
          (kids ? (it.collapsed ? '▸' : '▾') : '·') + '</span>' +
          '<span class="mm-o-t">' + esc(it.text) + '</span></div></li>';
        if (!it.collapsed) walk(it.children || []);
      });
    }
    walk(o);
    list.innerHTML = html;
  }
  function restoreFolds(list, folded, depth) {
    (list || []).forEach(function (it) {
      var kids = it.children && it.children.length;
      if (kids) {
        if (folded[it.path]) it.ref.fold = true;
        else { it.ref.fold = false; restoreFolds(it.children, folded, depth + 1); }
      }
    });
  }

  /* ---------- 渲染 ---------- */
  function renderMindmap(opts) {
    opts = opts || {};
    var doc = state.current, wrap = $('mmWrap');
    if (!doc || !wrap) return;
    var svgEl = $('mmSvgEl');
    $('mmFallback').hidden = true;
    svgEl.style.display = '';

    var tree;
    try {
      tree = MindmapCore.parse(doc.text || '');
    } catch (e) {
      mmFail('这份 .mermaid 解析失败', String(e && e.message || e));
      return;
    }
    if (!tree.root) {
      mmFail('没有从这份 .mermaid 里解析出节点', (tree.warnings || []).join('\n') ||
        '请确认文件里是 mindmap 版式，例如：\n\nmindmap\n  root((根))\n    分支');
      return;
    }
    var stat = MindmapCore.summary(tree);
    $('mmStats').textContent = stat.count + ' 个节点 · ' + (stat.depth + 1) + ' 层';
    state.mmOutline = MindmapCore.outline(tree);

    if (!opts.keepView) state.mmFolded = [];
    if (state.mmFolded.length) {
      var folded = {};
      state.mmFolded.forEach(function (p) { folded[p] = 1; });
      restoreFolds(state.mmOutline, folded, 1);
    } else if (!opts.keepView) {
      var level = state.cfg.mindmap.initialExpandLevel;
      level = (level === null || level === undefined || level === '') ? 2 : Number(level);
      if (isNaN(level)) level = 2;
      var flatAll = flatOutline(state.mmOutline, null, []);
      flatAll.forEach(function (it) { it.ref.fold = false; });
      if (level >= 0) applyInitialFold(state.mmOutline, level, 1);
    }
    markCollapsedAll();

    var Markmap = window.markmap && window.markmap.Markmap;
    var Transformer = window.markmap && window.markmap.Transformer;
    if (!Markmap || !Transformer) {
      mmFail('页面里没有找到思维导图引擎', '请运行 node build-docs.mjs 把 vendor/markmap 的引擎内联进 md-viewer.html。');
      return;
    }

    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var data;
    try {
      data = (new Transformer()).transform(MindmapCore.toMarkdown(tree)).root;
      if (!data) throw new Error('转换结果为空');
    } catch (e) {
      mmFail('思维导图转换失败', String(e && e.stack || e));
      return;
    }

    if (state.mm) { try { state.mm.destroy(); } catch (e) {} state.mm = null; }
    try {
      state.mm = Markmap.create(svgEl, {
        duration: 320,
        autoFit: false,
        initialExpandLevel: -1,       // 展开层级交给上面的折叠逻辑决定
        maxWidth: 320,
        spacingHorizontal: 96,
        spacingVertical: 14,          // 中文行高比英文高，10 会挤在一起
        paddingX: 12,
        nodeMinHeight: 20,
        fitRatio: 0.92,
        color: mmColor(dark),
        lineWidth: function (node) { return (node.state && node.state.depth === 0) ? 3 : 2; }
      }, data);
    } catch (e) {
      mmFail('思维导图渲染失败', String(e && e.stack || e));
      return;
    }
    var mm = state.mm;

    // 点节点折叠／展开，并把结果同步到右侧大纲。两件事要一起满足：
    //   1) markmap 自带的点击处理只挂在「有子节点」的 `circle` 上（带文字的节点是
    //      foreignObject，根本没有 circle），所以要在 svg 上做事件委托兜住节点本体的点击；
    //   2) markmap 渲染前会把数据深拷贝成自己的 INode 树，它写的 fold 落在那份拷贝上、
    //      回不到大纲树 —— 所以折叠后按结构把状态回写到大纲（反向也一样）。
    var origHandleClick = mm.handleClick;
    mm.handleClick = function (event, d) {
      var r = origHandleClick.call(mm, event, d);
      syncOutlineSoon();
      return r;
    };
    mm.svg.on('click', function (event) {
      var root = mm.svg.node();
      var el = event.target;
      while (el && el !== root && !(el.tagName === 'g' && el.classList && el.classList.contains('markmap-node'))) {
        el = el.parentNode;
      }
      if (!el || el === root) return;
      var d = el.__data__;
      if (!d) return;
      event.stopPropagation();
      mm.handleClick(event, d);
    });
    mm.svg.on('dblclick', function () { mm.fit(); });

    $('mmFit').onclick = function () { mm.fit(); };
    $('mmFold').onclick = function () {
      var flatAll = flatOutline(state.mmOutline, null, []);
      var anyOpen = flatAll.some(function (it) { return it.children.length && !it.ref.fold; });
      flatAll.forEach(function (it) { it.ref.fold = anyOpen && !!it.children.length; });
      state.mmFolded = foldedPaths();
      mm.setData(data).then(function () { mm.fit(); syncOutlineItems(); }).catch(function () {});
    };
    // 导出按钮是 config.mindmap.exportImage 控制的，关掉时按钮不存在，这里要判空
    if ($('mmSvg')) $('mmSvg').onclick = exportMindmapSvg;
    if ($('mmPng')) $('mmPng').onclick = exportMindmapPng;
    if ($('mmFull')) $('mmFull').onclick = function () { setMindmapFullscreen(); };
    renderMindmapOutline(opts.keepView ? 0 : initLevelForOutline());
    requestAnimationFrame(function () { mm.fit().catch(function () {}); });
  }
  /* 初始展开层级：给大纲渲染用的「摊开到第几层」 */
  function initLevelForOutline() {
    var level = state.cfg.mindmap.initialExpandLevel;
    level = (level === null || level === undefined || level === '') ? 2 : Number(level);
    if (isNaN(level) || level < 0) return 0;
    return level + 1;
  }

  function foldedPaths() {
    var out = [];
    flatOutline(state.mmOutline, null, []).forEach(function (it) {
      if (it.ref.fold) out.push(it.path);
    });
    return out;
  }
  /* markmap 切换折叠是异步重绘（带过渡动画），等它把 fold 写完再同步大纲 */
  function syncOutlineSoon(delay) {
    var token = (state.mmSyncToken = (state.mmSyncToken || 0) + 1);
    setTimeout(function () {
      if (token !== state.mmSyncToken) return;      // 期间又点了一次，作废
      pullFoldsFromMarkmap();
      state.mmFolded = foldedPaths();
      syncOutlineItems();
    }, delay === undefined ? 420 : delay);
  }
  /* 从 markmap 的 INode 反查大纲条目。
     刻意不做文字比对：markmap 的 content 是 HTML，中文还被转成数字实体（`&#x5206;`），
     比对容易被编码/转义细节坑。改用结构定位 —— markmap 的树和解析出的树形状完全一致
     （同一份 .mermaid、同序前序遍历，节点数相同，test/verify-mindmap.mjs 有交叉验证），
     所以「markmap 树里第 N 个节点」就是「大纲里的第 N 项」，与文字内容无关。 */
  function markmapNodeAt(order) {
    var data = state.mm && state.mm.state && state.mm.state.data;
    if (!data || order < 0) return null;
    var n = 0, stack = [data];
    while (stack.length) {                       // 前序：与 MindmapCore.outline 的顺序一致
      var cur = stack.pop();
      if (n === order) return cur;
      n++;
      var kids = cur.children || [];
      for (var i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return null;
  }
  function markmapOrderOf(node) {
    var data = state.mm && state.mm.state && state.mm.state.data;
    if (!data || !node) return -1;
    var n = 0, stack = [data];
    while (stack.length) {
      var cur = stack.pop();
      if (cur === node) return n;
      n++;
      var kids = cur.children || [];
      for (var i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return -1;
  }
  function mmItemForNode(node) {
    var order = markmapOrderOf(node);
    if (order <= 0) return null;                 // 0 是根节点，根不进大纲
    var item = flatOutline(state.mmOutline, null, [])[order - 1];
    if (item) return item;
    return mmItemForNodeByText(node);            // 结构对不上时（理论上不会）的兜底
  }
  /* 把 markmap 那份拷贝上的 fold 状态回写到大纲树（点击画布后的同步） */
  function pullFoldsFromMarkmap() {
    var flat = flatOutline(state.mmOutline, null, []);
    for (var n = 1; n <= flat.length; n++) {
      var node = markmapNodeAt(n);
      if (!node) continue;
      flat[n - 1].ref.fold = !!(node.payload && node.payload.fold);
    }
  }
  function markmapNodeForItem(item) {
    var flat = flatOutline(state.mmOutline, null, []);
    for (var i = 0; i < flat.length; i++) {
      if (flat[i] === item) return markmapNodeAt(i + 1);
    }
    return null;
  }
  /* 兜底用：解码 markmap 的 HTML 文本再比对（数字实体交给浏览器解） */
  var plainBox = null;
  function plainNodeText(html) {
    var s = String(html == null ? '' : html);
    if (!plainBox) plainBox = document.createElement('div');
    plainBox.innerHTML = s;
    return (plainBox.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function mmItemForNodeByText(node) {
    if (!node) return null;
    var depth = (node.state && node.state.depth) || 0;
    var text = plainNodeText(node.content);
    var hit = null;
    flatOutline(state.mmOutline, null, []).forEach(function (it) {
      if (hit) return;
      if (it.level === depth && plainNodeText(esc(it.text)) === text) hit = it;
    });
    return hit;
  }

  function mmColor(dark) {
    var light = ['#c1436d', '#3d7dca', '#d9822b', '#2f9e63', '#8257e5', '#0d9488'];
    var night = ['#f2a5c0', '#8ab8f0', '#f0b667', '#71d3a0', '#b9a2f5', '#4fd1c5'];
    var palette = dark ? night : light;
    return function (node) {
      var depth = (node.state && node.state.depth) || 0;
      if (depth === 0) return dark ? '#e8eaef' : '#2c3138';
      return palette[Math.min(depth, palette.length) - 1];
    };
  }

  /* ---------- 图片导出 ---------- */
  /* 导出的 SVG 是自包含的：克隆当前画布 + 把 markmap 的样式一起塞进去，
     这样存下来的文件单独打开也是对的（含深色主题的配色）。 */
  function buildStandaloneSvg(doc) {
    var live = $('mmSvgEl');
    var rect = state.mm && state.mm.state && state.mm.state.rect;
    var clone = live.cloneNode(true);
    var x, y, w, h;
    var margin = 24;
    if (rect && isFinite(rect.x1) && rect.x2 > rect.x1) {
      x = rect.x1 - margin; y = rect.y1 - margin;
      w = (rect.x2 - rect.x1) + margin * 2;
      h = (rect.y2 - rect.y1) + margin * 2;
    } else {
      var bbox = live.getBBox();
      x = bbox.x - margin; y = bbox.y - margin;
      w = bbox.width + margin * 2; h = bbox.height + margin * 2;
    }
    var style = state.mm ? state.mm.getStyleContent() : '';
    var css = style +
      '\n.markmap{font:300 16px/20px "Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
      'color:' + mindmapInkColor() + ';background:' +
      (document.documentElement.getAttribute('data-theme') === 'dark' ? '#1b1e24' : '#ffffff') + '}' +
      '\n.markmap .markmap-foreign{color:' + mindmapInkColor() + '}' +
      '\n.markmap .markmap-node>circle{fill:none;stroke:currentColor}' +
      '\n.markmap .markmap-node text{fill:currentColor}';
    clone.setAttribute('viewBox', [x, y, w, h].join(' '));
    clone.setAttribute('width', String(Math.round(w)));
    clone.setAttribute('height', String(Math.round(h)));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    var styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    styleEl.textContent = css;
    clone.insertBefore(styleEl, clone.firstChild);
    return { svg: clone, w: w, h: h };
  }
  function serializeSvg(svg) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      new XMLSerializer().serializeToString(svg) + '\n';
  }
  /* 导出失败时把原因说清楚，别只丢一句 "失败" —— 也方便 test 里定位 */
  function exportError(e) {
    return String((e && (e.stack || e.message)) || e);
  }
  function exportFail(what, e) {
    state.mmExportError = exportError(e);
    window.alert('导出 ' + what + ' 失败：' + (e && e.message ? e.message : e));
    return null;
  }
  /* 导出 SVG：返回 Blob（测试可直接断言内容），同时触发下载 */
  function exportMindmapSvg() {
    try {
      var built = buildStandaloneSvg(state.current);
      var blob = new Blob([serializeSvg(built.svg)], { type: 'image/svg+xml;charset=utf-8' });
      state.mmExportError = null;
      triggerDownload(blob, mindmapDownloadName(state.current, 'svg'));
      return blob;
    } catch (e) {
      return exportFail('SVG', e);
    }
  }
  /* 导出 PNG：要先画进 canvas，所以返回 Promise<Blob>（失败时为 null） */
  function exportMindmapPng() {
    return new Promise(function (resolve) {
      var built;
      try {
        built = buildStandaloneSvg(state.current);
      } catch (e) { resolve(exportFail('PNG', e)); return; }
      var scale = Math.min(2, Math.max(1, 2400 / Math.max(built.w, built.h)));
      var w = Math.round(built.w * scale), h = Math.round(built.h * scale);
      var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serializeSvg(built.svg));
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          var ctx = canvas.getContext('2d');
          var dark = document.documentElement.getAttribute('data-theme') === 'dark';
          ctx.fillStyle = dark ? '#1b1e24' : '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(function (blob) {
            if (!blob) { resolve(exportFail('PNG', new Error('canvas.toBlob 返回空'))); return; }
            state.mmExportError = null;
            triggerDownload(blob, mindmapDownloadName(state.current, 'png'));
            resolve(blob);
          }, 'image/png');
        } catch (e) { resolve(exportFail('PNG', e)); }
      };
      img.onerror = function () { resolve(exportFail('PNG', new Error('无法把 SVG 转成图片'))); };
      img.src = url;
    });
  }

  /* ---------- 导图文档：正文区交给思维导图 ---------- */
  function renderMindmapDoc(doc) {
    var mmCfg = state.cfg.mindmap || {};
    if (mmCfg.enabled === false) {
      // 功能被关掉时不当成导图，退回普通文本渲染，避免白屏
      state.mindmap = null;
      renderDoc(doc.path);
      return;
    }
    state.current = doc;
    state.mindmap = doc;
    state.diagram = null;
    state.headings = [];
    state.mmOutline = [];
    state.mmFolded = [];
    exitMindmapFullscreen();             // 切到另一篇导图时从普通视图重新开始

    /* .mermaid 文件里写的不是 mindmap（比如 stateDiagram-v2）：交给 mermaid 画成图 */
    var dk = diagramKindOf(doc);
    if (dk) { renderDiagramDoc(doc, dk); return; }

    var chars = String(doc.text || '').length;
    applyConfig();
    $('article').innerHTML =
      '<div class="meta"><span>' + (doc.size ? (doc.size / 1024).toFixed(1) + ' KB' : '') + '</span>' +
      '<span>约 ' + chars + ' 字</span>' +
      '<span>思维导图</span>' +
      '<span class="no-print">' + esc(doc.path) + '</span></div>' +
      mindmapHtml(doc);
    $('docPath').textContent = doc.path;
    popArticle();
    document.title = doc.title + (state.cfg.subtitle ? ' ' + state.cfg.subtitle : '');
    renderMindmap();
    // 关掉大纲时不再占用右栏（用户仍可用工具栏按钮手动打开）
    if (mmCfg.showOutline === false) setPane('right', false);
    renderSidebar();
    var idx = state.visible.indexOf(doc);
    $('prevBtn').disabled = idx <= 0;
    $('nextBtn').disabled = idx < 0 || idx >= state.visible.length - 1;
    window.scrollTo(0, 0);
  }

  /* ---------- 图表文档（.mermaid 文件里写的是 stateDiagram-v2 之类的整篇图表）----------
     和 Markdown 里的 ```mermaid 围栏走同一套渲染：整篇文件就是一块图，
     因此复用 mermaid-core 的块标记与工具栏，正文区只放这一块。 */
  function renderDiagramDoc(doc, dk) {
    state.mindmap = null;
    state.mm = null;
    state.diagram = doc;
    state.headings = [];
    state.mmOutline = [];
    exitMindmapFullscreen();
    exitMermaidFullscreen();
    var opts = state.cfg.mermaid || {};
    var chars = String(doc.text || '').length;
    var block = MermaidCore.block(doc.text || '', 'mermaid', 1, {
      controls: opts.controls !== false,
      exportImage: opts.exportImage !== false,
      fullscreen: opts.fullscreen !== false
    });
    applyConfig();
    $('article').innerHTML =
      '<div class="meta"><span>' + (doc.size ? (doc.size / 1024).toFixed(1) + ' KB' : '') + '</span>' +
      '<span>约 ' + chars + ' 字</span>' +
      '<span>' + esc(dk.name) + '</span>' +
      '<span class="no-print">' + esc(doc.path) + '</span></div>' +
      '<div class="mg-doc">' + block + '</div>';
    $('docPath').textContent = doc.path;
    popArticle();
    document.title = doc.title + (state.cfg.subtitle ? ' ' + state.cfg.subtitle : '');
    mountMermaid();
    $('tocList').innerHTML = '<li class="toc-empty">图表文档没有标题大纲</li>';
    renderSidebar();
    var i = state.visible.indexOf(doc);
    $('prevBtn').disabled = i <= 0;
    $('nextBtn').disabled = i < 0 || i >= state.visible.length - 1;
    window.scrollTo(0, 0);
  }

  /* ==================================================================
     嵌入的 Mermaid 图表（Markdown 里的 ```mermaid 围栏）
     - 识别与块标记在 mermaid-core（纯函数，可单测）
     - 这里只负责：初始化引擎、把每块源码画成 SVG、失败兜底、
       主题切换后重画、工具栏（源码 / 复制 / 导出 SVG / 全屏）
     - 引擎来自 vendor/mermaid/mermaid.min.js（离线版整段内联，实时版本地外链）；
       引擎缺失或功能被 config 关掉时，图表块不会生成 / 保持源码可见，不白屏
     ================================================================== */
  function mermaidCfg() { return state.cfg.mermaid || {}; }
  function mermaidEnabled() {
    return mermaidCfg().enabled !== false &&
      typeof MermaidCore !== 'undefined' && !!MermaidCore && !!window.mermaid;
  }
  function mermaidThemeName() {
    var t = String(mermaidCfg().theme || 'auto').toLowerCase();
    if (!t || t === 'auto') {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';
    }
    return t;
  }
  var mgInited = null;                 // 记住 initialize 用的主题，换主题才重新初始化

  /* ---------- 「文档风」配色方案 ----------
     目标：圆角浅紫胶囊 + 深紫描边 + 深灰连线 + 不透明浅灰标签底片，
     与 mermaid 自带 default 主题的中灰块相比更像工程文档里的插图。
     实现分两层，缺一不可：
       · 换主题变量（themeVariables）：能改的都从变量走，mermaid 自己算对比色；
       · 补一段 CSS 注入到这张图自己的 <style> 里：只补 mermaid 没暴露成变量的
         形状细节（圆角半径、线宽、标签底片不透明度）。
     注意：CSS 必须带 !important —— mermaid 生成的主题规则带 #id 前缀且会整段重写，
     不加会被它压回去（见 assets/mermaid-core.js 里块标记的说明）。
     边标签的 font-size / padding 一律不碰：foreignObject 的宽高是引擎按自己的字号
     量出来的，改了就截字。字号统一交给 mermaid.fontSize 变量。 */
  var MG_STYLE_DOC = {
    rx: 10,               // 状态节点圆角
    nodeW: 1.6,           // 状态节点描边
    edgeW: 1.6,           // 状态图连线
    markerStroke: 1.1,    // 箭头描边（原版是细长倒钩，加一点才读得成实心三角）
    light: {
      background: '#ffffff',
      mainBkg: '#E7E3FB', stateBkg: '#E7E3FB', primaryColor: '#E7E3FB',
      primaryBorderColor: '#7A6FE0', stateBorder: '#7A6FE0', nodeBorder: '#7A6FE0',
      primaryTextColor: '#1F2328', stateLabelColor: '#1F2328', textColor: '#1F2328',
      lineColor: '#33333A', transitionColor: '#33333A', transitionLabelColor: '#1F2328',
      labelBackgroundColor: '#F0F0F0', edgeLabelBackground: '#F0F0F0',
      fontSize: '15px',
      plate: '#F0F0F0',     // 标签底片（注入 CSS 用）
      marker: '#33333A'     // 箭头填充
    },
    dark: {
      background: '#0d1117',
      mainBkg: '#232338', stateBkg: '#232338', primaryColor: '#232338',
      primaryBorderColor: '#8B84E8', stateBorder: '#8B84E8', nodeBorder: '#8B84E8',
      primaryTextColor: '#e6edf3', stateLabelColor: '#e6edf3', textColor: '#e6edf3',
      lineColor: '#9aa4b2', transitionColor: '#9aa4b2', transitionLabelColor: '#e6edf3',
      labelBackgroundColor: '#1c2128', edgeLabelBackground: '#1c2128',
      fontSize: '15px',
      plate: '#1c2128',
      marker: '#9aa4b2'
    }
  };
  function mgStyleName() {
    var s = String(mermaidCfg().style == null ? 'doc' : mermaidCfg().style).toLowerCase();
    return (s === 'plain' || s === 'default' || s === 'none' || s === 'off') ? 'plain' : 'doc';
  }
  /* 当前这套图该用的主题变量：plain 时返回 null（完全走 mermaid 原样） */
  function mgThemeVariables() {
    if (mgStyleName() !== 'doc') return null;
    var preset = (mermaidThemeName() === 'dark') ? MG_STYLE_DOC.dark : MG_STYLE_DOC.light;
    var vars = { fontFamily: (getComputedStyle(document.body).fontFamily || 'sans-serif') };
    for (var k in preset) if (Object.prototype.hasOwnProperty.call(preset, k)) vars[k] = preset[k];
    return vars;
  }
  /* 渲染后往这张图自己的 <style> 里补规则（导出 SVG 时也会带上，单独打开同样好看） */
  function mgInjectTheme(svg) {
    if (!svg || mgStyleName() !== 'doc') return svg;
    var id = svg.getAttribute('id') || '';
    var sel = id ? '#' + id + ' ' : '';
    var preset = (mermaidThemeName() === 'dark') ? MG_STYLE_DOC.dark : MG_STYLE_DOC.light;
    var s = MG_STYLE_DOC;
    var css = [
      /* 状态图：节点形状与线宽 */
      sel + '.statediagram-state rect.basic{rx:' + s.rx + 'px !important;ry:' + s.rx + 'px !important;stroke-width:' + s.nodeW + 'px !important;}',
      sel + '.statediagram-state .title-state{rx:' + s.rx + 'px !important;ry:' + s.rx + 'px !important;}',
      sel + '.statediagram-cluster rect.outer{rx:' + s.rx + 'px !important;ry:' + s.rx + 'px !important;}',
      sel + '.transition{stroke-width:' + s.edgeW + ' !important;}',
      /* 标签底片：原版 opacity .5（线会透出来），这里做成不透明浅灰。
         注意状态图的边标签**没有** svg rect，底片是 foreignObject 里那个 div 的背景，
         所以必须给 div 上底色；把 div 设成透明会让连线直接穿过文字。 */
      sel + '.edgeLabel rect{fill:' + preset.plate + ' !important;opacity:1 !important;stroke:none !important;}',
      sel + '.edgeLabel > .label > foreignObject > div,' +
        sel + '.edgeLabel .labelBkg,' +
        sel + '.edgeLabel p,' +
        sel + '.edgeLabel span.edgeLabel{background:' + preset.plate + ' !important;background-color:' + preset.plate + ' !important;}' +
        sel + '.edgeLabel > .label > foreignObject{overflow:visible !important;}',
      /* 外层的 <g class="label"> 带 transform，盒模型撑不开它：标签底片的留白
         由 mgPadLabels() 从测量值直接算（往 transform 里补 offset）。 */
      /* 箭头：细长倒钩加一点描边，读起来更接近实心三角。
         选择器必须用 [id*=...]：引擎每个类型都会 emit 两个 id —— `...End` 与
         `...End-margin`（两者 markerUnits 不同），连线实际引用的是 `-margin` 那个，
         [id$=...] 一个都收不到。详见 mgTuneMarkers 的注释。 */
      sel + '[id*="stateDiagram-barbEnd"] path{stroke-linejoin:miter !important;stroke-width:' + s.markerStroke + ' !important;}',
      sel + '[id*="flowchart-v2-pointEnd"] path,' + sel + '[id*="flowchart-v2-pointStart"] path{stroke-width:' + s.markerStroke + ' !important;}',
      /* 流程图节点也统一成同一套观感 */
      sel + '.flowchart-link{stroke-width:' + s.edgeW + ' !important;}',
      sel + '.node rect,' + sel + '.node circle,' + sel + '.node ellipse,' + sel + '.node polygon,' + sel + '.node path{stroke-width:' + s.nodeW + 'px !important;}'
    ].join('\n');
    var style = svg.querySelector('style');
    if (!style) return svg;
    style.textContent += '\n/* markdown-docs-helper：图表样式 */\n' + css + '\n';
    return svg;
  }
  /* 箭头：把状态图的 barbEnd 缩成参考图那种紧实小三角（只动观感，不换 marker）。
     四个坑，缺一个这套微调就是白写（都是实测出来的，别照直觉改）：
       1. 选择器必须用 [id*=...]。引擎每个类型都 emit 两个 marker：`...End`（markerUnits=
          strokeWidth）和 `...End-margin`（markerUnits=userSpaceOnUse），**连线引用的永远是
          `-margin` 那个**（实测有标签、没标签的边都走它，`...End` 是死代码）。用 [id$=...]
          谁都收不到 —— 之前的微调就是这么失效的。
       2. 不能只在 <defs> 里找。引擎把 `...End` 塞进 `<g><defs>`，把真正被引用的
          `...End-margin` 挂在别处，所以要在整张 svg 里找（原来的代码只查 defs，
          于是把尺寸全改到了没人用的那个 marker 上）。
       3. marker 的视口（markerWidth/markerHeight）就是裁剪框，默认 overflow:hidden：
          barb 的路径画在 x=11..19，只把视口收到 13 会把尖头切掉（像素级实测：箭头顶不到
          线头，变成一个贴在线上、后面还露一截线的楔子）。所以缩的时候**路径连同 refX/refY
          一起缩**，并且把 overflow 打开 —— 这几个 marker 里就一个箭头，宁可让它画满。
       4. 描边宽度得走注入的 CSS（带 !important）：marker 的 stroke-width 会被 mermaid 自己的
          样式段压成 0（flowchart 的 pointEnd 就是 0），setAttribute 斗不过它。
     另外把两个变体的 markerUnits 统一成 userSpaceOnUse：箭头大小就不随连线粗细跑。 */
  var MG_ARROW_SCALE = 0.65;                    // 路径与 refX/refY 的等比缩放
  var MG_ARROW_W = 13, MG_ARROW_H = 11;         // 视口（缩完的路径是 5.2×9.1）
  function mgTuneMarkers(svg) {
    if (!svg || mgStyleName() !== 'doc') return svg;
    var preset = (mermaidThemeName() === 'dark') ? MG_STYLE_DOC.dark : MG_STYLE_DOC.light;
    var heads = svg.querySelectorAll('marker[id*="stateDiagram-barbEnd"],' +
      'marker[id*="flowchart-v2-pointEnd"],marker[id*="flowchart-v2-pointStart"]');
    var round2 = function (n) { return Math.round(n * 100) / 100; };
    for (var i = 0; i < heads.length; i++) {
      var mk = heads[i];
      var p = mk.querySelector('path');
      if (!p) continue;
      p.setAttribute('fill', preset.marker);      // 深色下跟连线一起变浅
      p.setAttribute('stroke', preset.marker);    // 没有描边颜色时，加宽 stroke-width 是白加
      p.setAttribute('stroke-linejoin', 'miter');
      /* 别让视口把描边切掉半个（flowchart 的箭头是实心三角，视口正好贴着它） */
      mk.setAttribute('overflow', 'visible');
      /* 流程图的 pointEnd 本来就是实心三角（自己带 viewBox），只补描边、不动几何 */
      if (mk.id.indexOf('stateDiagram-barbEnd') < 0) continue;
      p.setAttribute('d', String(p.getAttribute('d')).replace(/-?\d+(?:\.\d+)?/g, function (n) {
        return round2(parseFloat(n) * MG_ARROW_SCALE);
      }));
      var refX = parseFloat(mk.getAttribute('refX'));
      var refY = parseFloat(mk.getAttribute('refY'));
      if (isFinite(refX)) mk.setAttribute('refX', String(round2(refX * MG_ARROW_SCALE)));
      if (isFinite(refY)) mk.setAttribute('refY', String(round2(refY * MG_ARROW_SCALE)));
      mk.setAttribute('markerWidth', String(MG_ARROW_W));
      mk.setAttribute('markerHeight', String(MG_ARROW_H));
      mk.setAttribute('markerUnits', 'userSpaceOnUse');
    }
    return svg;
  }
  /* 标签底片的留白：mermaid 给的宽高基本贴着文字（左右各 1px），
     参考图那种灰底片要宽松一点。foreignObject 的宽高是引擎按自己字号量出来的，
     这里读回渲染尺寸后放大一圈，并把它在 <g class="label"> 的 transform 里居中
     （那个 <g> 带 transform，改宽高盒模型撑不开它，只能改 transform）。 */
  var MG_LABEL_PAD_X = 6, MG_LABEL_PAD_Y = 3;
  function mgPadLabels(svg) {
    var fos = svg.querySelectorAll('g.edgeLabel foreignObject');
    for (var i = 0; i < fos.length; i++) {
      var fo = fos[i];
      var w = Number(fo.getAttribute('width')) || 0;
      var h = Number(fo.getAttribute('height')) || 0;
      if (!w || !h) continue;                       // 空标签（宽高 0）不动
      var g = fo.parentNode;                        // <g class="label" transform="translate(x,y)">
      var tr = (g && g.getAttribute && g.getAttribute('transform')) || '';
      var m = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/.exec(tr);
      if (!m) continue;
      fo.setAttribute('width', String(Math.ceil(w + MG_LABEL_PAD_X * 2)));
      fo.setAttribute('height', String(Math.ceil(h + MG_LABEL_PAD_Y * 2)));
      g.setAttribute('transform', 'translate(' + (+m[1] - MG_LABEL_PAD_X) + ', ' + (+m[2] - MG_LABEL_PAD_Y) + ')');
    }
    return svg;
  }
  function mgDecorate(svg) {
    if (!svg || mgStyleName() !== 'doc') return svg;
    mgTuneMarkers(svg);
    mgInjectTheme(svg);
    mgPadLabels(svg);
    return svg;
  }
  function initMermaidEngine() {
    var api = window.mermaid;
    if (!api) return null;
    var theme = mermaidThemeName();
    if (mgInited === theme + '|' + mgStyleName()) return api;
    var opts = {
      startOnLoad: false,
      theme: theme,
      securityLevel: mermaidCfg().securityLevel || 'strict',
      // 用页面真实字体栈，CJK 标签的测量才准（'var(--font-sans)' 在 SVG 里不可靠）
      fontFamily: (getComputedStyle(document.body).fontFamily || 'sans-serif'),
      // 画不出来时不要往页面里塞 mermaid 自己的错误图，我们有自己的错误框
      suppressErrorRendering: true
    };
    // 「文档风」配色：能走变量的都走变量，剩下的形状细节在 mgDecorate 里注入 CSS
    var vars = mgThemeVariables();
    if (vars) opts.themeVariables = vars;
    api.initialize(opts);
    // 语法错时别往控制台喷红字：错误已经由下面的 Promise 分支接住了
    api.parseError = function (err) { state.mgError = String((err && err.message) || err); };
    mgInited = theme + '|' + mgStyleName();
    return api;
  }
  function mgBlocks() { return [].slice.call($('article').querySelectorAll('.mg-block')); }
  function mgSource(el) {
    var code = el.querySelector('.mg-body > pre.code > code');
    return code ? code.textContent : '';
  }
  function mgKind(el) {
    return { id: el.getAttribute('data-mg-kind') || '', name: ((el.querySelector('.mg-kind') || {}).textContent || '').trim() };
  }
  /* mermaid 渲染失败时会在 body 里留下临时节点（#d<id>），顺手清掉 */
  function mgJunk(id) {
    var el = document.getElementById('d' + id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  function mgShowError(el, msg) {
    var host = el.querySelector('.mg-host');
    if (!host) return;
    host.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'mg-error';
    box.innerHTML = '<strong>这张 Mermaid 图没能画出来</strong>' +
      '<span class="mg-error-msg">' + esc(msg) + '</span>' +
      '<span class="mg-error-hint">源码在下面，可以复制出来改；</span>';
    host.appendChild(box);
    el.setAttribute('data-mg-state', 'error');
    el.setAttribute('data-mg-error', String(msg).slice(0, 400));
    el.classList.add('mg-show-src');           // 失败时把源码摊开，方便直接改
    state.mgError = String(msg);
  }
  /* 画一块；token 变了（换文档了）就丢弃结果，避免旧图覆盖新页面 */
  function mgRenderOne(el, token) {
    var api = initMermaidEngine();
    var src = mgSource(el);
    if (!api) {
      el.setAttribute('data-mg-state', 'no-engine');
      el.classList.add('mg-show-src');
      return Promise.resolve();
    }
    if (!src.trim()) {
      el.setAttribute('data-mg-state', 'empty');
      el.classList.add('mg-show-src');
      return Promise.resolve();
    }
    var id = 'mg-' + (++state.mgSeq);
    el.setAttribute('data-mg-state', 'loading');
    return api.render(id, src).then(function (res) {
      if (token !== state.mgToken) return;
      var host = el.querySelector('.mg-host');
      if (host) host.innerHTML = res.svg;       // 成功：顺带清掉上一次的错误框
      if (res.bindFunctions) res.bindFunctions(host);
      if (host) mgDecorate(host.querySelector('svg'));   // 圆角 / 线宽 / 标签底片（文档风）
      el.setAttribute('data-mg-state', 'ok');
      el.removeAttribute('data-mg-error');
      el.classList.remove('mg-show-src');
      state.mgError = null;
    }, function (err) {
      mgJunk(id);
      if (token !== state.mgToken) return;
      mgShowError(el, (err && err.message) || String(err));
    });
  }
  /* 依次画：一张张来，顺序稳定、错误好定位（大图也不会同时铺开抢布局） */
  function mountMermaid() {
    var blocks = mgBlocks();
    var token = ++state.mgToken;
    if (!blocks.length) { state.mgPromise = Promise.resolve(); return state.mgPromise; }
    var chain = Promise.resolve();
    blocks.forEach(function (el) {
      el.setAttribute('data-mg-state', 'loading');      // 排队的也先显示「正在画图…」
      chain = chain.then(function () { return mgRenderOne(el, token); });
    });
    state.mgPromise = chain;
    return chain;
  }
  /* 主题换了要重画（mermaid 的主题是画进 SVG 里的），但保留「展开源码」的用户选择 */
  function rerenderMermaid() {
    var blocks = mgBlocks();
    if (!blocks.length) return state.mgPromise || Promise.resolve();
    blocks.forEach(function (el) {
      var host = el.querySelector('.mg-host');
      if (host) host.innerHTML = '';
      el.setAttribute('data-mg-state', 'pending');
      el.removeAttribute('data-mg-error');
    });
    return mountMermaid();
  }
  /* ---------- 工具栏：源码 / 复制 / 导出 SVG / 全屏 ---------- */
  function mgBtnFeedback(btn, text) {
    var old = btn.getAttribute('data-mg-label') || btn.textContent;
    btn.setAttribute('data-mg-label', old);
    btn.textContent = text;
    clearTimeout(btn._mgTimer);
    btn._mgTimer = setTimeout(function () {
      btn.textContent = btn.getAttribute('data-mg-label') || old;
    }, 1300);
  }
  function mgToggleSource(block, btn) {
    var on = block.classList.toggle('mg-show-src');
    if (btn) {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.textContent = on ? '隐藏源码' : '源码';
      btn.setAttribute('data-mg-label', btn.textContent);
    }
  }
  function mgCopy(block, btn) {
    var text = mgSource(block);
    var done = function (ok) { mgBtnFeedback(btn, ok ? '已复制' : '复制失败'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        block.appendChild(ta);
        ta.select();
        var ok = document.execCommand && document.execCommand('copy');
        block.removeChild(ta);
        done(!!ok);
      } catch (e) { done(false); }
    }
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function mgDownloadName(block, ext) {
    var base = String((state.current && state.current.title) || 'mermaid').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'mermaid';
    var i = Number(block.getAttribute('data-mg-index')) || 1;
    var kind = block.getAttribute('data-mg-kind') || 'mermaid';
    return base + '-' + kind + '-' + i + '.' + ext;
  }
  /* 渲染好的 SVG 直接克隆出来就是自包含的（mermaid 把主题 CSS 也塞在 svg 里了），
     只要补上明确的宽高/视图框，再垫一层当前主题的底色，单独打开也好看 */
  function mgStandaloneSvg(block) {
    var live = block.querySelector('.mg-host > svg');
    if (!live) return null;
    var clone = live.cloneNode(true);
    var box = null;
    try { box = live.getBBox(); } catch (e) { box = null; }
    var rect = live.getBoundingClientRect();
    var margin = 8;
    var w = Math.ceil((box && box.width) || rect.width || 800);
    var h = Math.ceil((box && box.height) || rect.height || 600);
    var x = box && isFinite(box.x) ? box.x - margin : 0;
    var y = box && isFinite(box.y) ? box.y - margin : 0;
    w += margin * 2; h += margin * 2;
    clone.setAttribute('xmlns', SVG_NS);
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    clone.setAttribute('viewBox', [x, y, w, h].join(' '));
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('x', String(x)); bg.setAttribute('y', String(y));
    bg.setAttribute('width', String(w)); bg.setAttribute('height', String(h));
    bg.setAttribute('fill', dark ? '#0d1117' : '#ffffff');
    clone.insertBefore(bg, clone.firstChild);
    return { svg: clone, w: w, h: h };
  }
  function exportMermaidSvg(block) {
    try {
      var built = mgStandaloneSvg(block);
      if (!built) { state.mgExportError = '这张图还没画出来（或者渲染失败），没有可导出的 SVG'; return null; }
      var blob = new Blob([serializeSvg(built.svg)], { type: 'image/svg+xml;charset=utf-8' });
      state.mgExportError = null;
      triggerDownload(blob, mgDownloadName(block, 'svg'));
      return blob;
    } catch (e) {
      state.mgExportError = exportError(e);
      window.alert('导出 SVG 失败：' + (e && e.message ? e.message : e));
      return null;
    }
  }
  function mgFullscreenOn() { return !!state.mgFull; }
  function setMermaidFullscreen(block, on) {
    var want = (on === undefined) ? !block.classList.contains('mg-full') : !!on;
    mgBlocks().forEach(function (el) { if (el !== block) el.classList.remove('mg-full'); });
    block.classList.toggle('mg-full', want);
    document.documentElement.classList.toggle('mg-full-on', want);
    state.mgFull = want ? block : null;
    var btn = block.querySelector('[data-mg-act="full"]');
    if (btn) {
      btn.textContent = want ? '退出全屏' : '全屏';
      btn.setAttribute('data-mg-label', btn.textContent);
      btn.setAttribute('aria-pressed', want ? 'true' : 'false');
    }
  }
  function exitMermaidFullscreen() {
    if (state.mgFull) setMermaidFullscreen(state.mgFull, false);
  }
  function mgAct(btn) {
    var block = btn.closest ? btn.closest('.mg-block') : null;
    if (!block) return;
    var act = btn.getAttribute('data-mg-act');
    if (act === 'src') mgToggleSource(block, btn);
    else if (act === 'copy') mgCopy(block, btn);
    else if (act === 'svg') exportMermaidSvg(block);
    else if (act === 'full') setMermaidFullscreen(block);
  }

  /* ---------- 路由 ---------- */
  function route() {
    var h = parseHash();
    syncBarWithEntry();               // 开合跟着历史条目走，分支里不再改它
    if (h.p && state.byPath[h.p]) {
      returnLeftPane();
      var jump = h.q ? { q: h.q, occ: Number(h.k) || 0 } : null;
      if (jump) fillSearchBar(jump.q);
      if (isMindmapDoc(state.byPath[h.p])) renderMindmapDoc(state.byPath[h.p]);
      else renderDoc(h.p, h.h || null, jump);
    } else if (h.s !== undefined) {
      fillSearchBar(h.s);
      renderSearchPage(h.s);
    } else {
      returnLeftPane();
      renderOverview();
    }
  }

  /* ---------- 事件 ---------- */
  $('themeBtn').onclick = function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  };
  $('printBtn').onclick = function () { window.print(); };
  /* ---------- 顶栏搜索条 ---------- */
  function searchBarOpen() { return document.body.classList.contains('search-open'); }
  /* 开合是「这一条历史记录」的状态，不是全局开关：记在 history.state 里，
     前进 / 后退回到哪一条就还原成那条当初的样子。 */
  function recordBar(open) {
    try { history.replaceState({ sb: open ? 1 : 0 }, ''); }
    catch (e) { }                     // 写不了的宿主（沙箱内嵌等）只是还原不了，跳转照常
  }
  function setSearchBar(open, focus) {
    document.body.classList.toggle('search-open', !!open);
    $('searchBtn').setAttribute('aria-expanded', String(!!open));
    if (open) {
      if (focus !== false) { $('topSearch').focus(); $('topSearch').select(); }
    } else $('topSearch').blur();
    recordBar(open);
  }
  function syncBarWithEntry() {       // route() 开头调用
    if (history.state && typeof history.state.sb === 'number') setSearchBar(!!history.state.sb, false);
    else recordBar(searchBarOpen());  // 点链接 / 改 hash 开出来的新条目：沿用屏上现状并补记
  }
  function fillSearchBar(q) {         // 从地址栏回填输入内容，不动开合
    $('topSearch').value = String(q || '');
  }
  $('searchBtn').onclick = function () { setSearchBar(!searchBarOpen()); };
  $('searchBar').onsubmit = function (e) {
    e.preventDefault();
    location.hash = '#s=' + enc($('topSearch').value.trim());
    setSearchBar(false);        // 同关键词重复提交不触发 hashchange，这里无条件收一次
  };
  $('topClear').onclick = function () {
    $('topSearch').value = '';
    clearHits();
    $('topSearch').focus();
  };
  $('topSearch').onkeydown = function (e) {
    if (e.key === 'Escape') { e.preventDefault(); setSearchBar(false); }
  };
  $('linkBtn').onclick = function () {
    var btn = this;
    var done = function () {
      btn.classList.add('copied');
      btn.setAttribute('title', '已复制');
      setTimeout(function () {
        btn.classList.remove('copied');
        btn.setAttribute('title', '复制当前文档链接');
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(location.href).then(done, function () { window.prompt('复制链接：', location.href); });
    } else { window.prompt('复制链接：', location.href); }
  };
  $('toggleLeft').onclick = function () { togglePane('left'); };
  $('toggleRight').onclick = function () { togglePane('right'); };
  $('closeLeft').onclick = function () { setPane('left', false); };
  $('closeRight').onclick = function () { setPane('right', false); };
  $('scrim').onclick = function () { setPane('left', false); setPane('right', false); };
  $('prevBtn').onclick = function () { step(-1); };
  $('nextBtn').onclick = function () { step(1); };
  function step(d) {
    if (!state.current) return;
    var i = state.visible.indexOf(state.current) + d;
    if (i < 0 || i >= state.visible.length) return;
    location.hash = docHref(state.visible[i].path);
  }
  $('search').oninput = renderSidebar;  $('search').onkeydown = function (e) {
    if (e.key === 'Escape') { this.value = ''; renderSidebar(); this.blur(); }
    if (e.key === 'Enter') {
      var first = $('tree').querySelector('a.docitem');
      if (first) {
        location.hash = first.getAttribute('href');
        if (window.innerWidth < NARROW) setPane('left', false);
      }
    }
  };
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var mgBtn = e.target.closest('.mg-btn');
    if (mgBtn) { mgAct(mgBtn); return; }
    var oitem = e.target.closest('.mm-o-item');
    if (oitem) { mindmapOutlineActivate(oitem, !e.target.closest('.mm-o-caret')); return; }
    var srnav = e.target.closest('.sr-nav');
    if (srnav) { searchNavJump(srnav); return; }
    if (e.target.closest('a.docitem') && window.innerWidth < NARROW) setPane('left', false);
  });
  $('tocList').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var oitem = e.target.closest && e.target.closest('.mm-o-item');
    if (!oitem) return;
    e.preventDefault();
    mindmapOutlineActivate(oitem, true);
  });

  /* 点大纲：默认跳到该节点（顺带把路径展开）；点前面的小三角只做折叠/展开。
     叶子节点没有可折的子节点，点哪儿都按跳转处理。 */
  function mindmapOutlineActivate(el, jump) {
    if (!state.mm) return;
    var path = el.dataset.path;
    var item = null;
    flatOutline(state.mmOutline, null, []).forEach(function (it) { if (it.path === path) item = it; });
    if (!item) return;
    var hasKids = !!(item.children && item.children.length);
    if (jump || !hasKids) {
      var chain = [], cur = item;
      while (cur) { chain.unshift(cur); cur = cur.parent; }
      chain.forEach(function (it) { if (!it.children.length) return; it.ref.fold = false; });
      state.mmFolded = foldedPaths();
      syncOutlineItems();
      var mm = state.mm;
      if (typeof mm.ensureVisible === 'function') {
        Promise.resolve(mm.ensureVisible(item.ref, { left: 80, right: 80, top: 80, bottom: 80 }))
          .catch(function () {})
          .then(function () { setOutlineActive(el); });
      } else {
        setOutlineActive(el);
      }
      return;
    }
    // 三角形：折叠／展开这个分支。
    // 大纲树是「主」，markmap 那份拷贝是「从」：两边都写，再让 markmap 重绘。
    var fold = !item.ref.fold;
    item.ref.fold = fold;
    var live = markmapNodeForItem(item);
    if (live) live.payload = Object.assign({}, live.payload, { fold: fold ? 1 : 0 });
    state.mmFolded = foldedPaths();
    setOutlineActive(el);
    Promise.resolve(state.mm.setData()).then(function () {
      syncOutlineItems();
    }).catch(function () {});
  }
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    // Esc 先管全屏：搜索框里的 Esc（清空搜索）在上面的 input 分支里已经返回了
    if (e.key === 'Escape') {
      if (mgFullscreenOn()) { e.preventDefault(); exitMermaidFullscreen(); return; }
      if (mmFullscreenOn()) { e.preventDefault(); setMindmapFullscreen(false); }
      return;
    }
    if (e.key === '/') { e.preventDefault(); if (state.cfg.sidebar.showSearch !== false) { $('search').focus(); $('search').select(); } return; }
    if (e.key === '[') { e.preventDefault(); togglePane('left'); return; }
    if (e.key === ']') { e.preventDefault(); togglePane('right'); }
  });
  window.addEventListener('hashchange', route);

  /* ---------- 调试出口 ----------
     都封在 IIFE 里，外部（浏览器控制台、test/*.mjs 的 CDP 断言）拿不到内部函数，
     这里挂一个只读入口方便排查。它不改变任何行为，删掉也不影响页面功能。 */
  window.__mdvDebug = {
    state: state,
    isMindmapDoc: isMindmapDoc,
    isMindmapPath: isMindmapPath,
    parseMindmap: function (text) { return MindmapCore.parse(text); },
    toMarkdown: function (text) { return MindmapCore.toMarkdown(MindmapCore.parse(text)); },
    outline: function () { return state.mmOutline; },
    outlinePaths: function () { return flatOutline(state.mmOutline, null, []).map(function (it) { return it.path; }); },
    folded: foldedPaths,
    fullscreen: mmFullscreenOn,
    setFullscreen: setMindmapFullscreen,
    /* 调试用：直接把第一个「分支节点」点掉，并报告有没有匹配上大纲项 */
    clickFirstBranch: function () {
      var mm = state.mm;
      if (!mm) return null;
      var g = [].slice.call(document.querySelectorAll('#mmSvgEl g.markmap-node'))
        .filter(function (x) { return !!x.querySelector('circle'); })[0];
      if (!g) return null;
      var d = g.__data__;
      var hit = mmItemForNode(d);
      var probe = {
        content: plainNodeText(d.content), depth: d.state && d.state.depth,
        sameLevel: flatOutline(state.mmOutline, null, []).filter(function (it) {
          return it.level === (d.state && d.state.depth);
        }).map(function (it) { return it.text + ' | ' + plainNodeText(esc(it.text)); }).slice(0, 8),
        matched: !!hit, path: hit && hit.path
      };
      mm.handleClick({ stopPropagation: function () {}, target: g }, d);
      return probe;
    },
    exportSvg: exportMindmapSvg,
    exportPng: exportMindmapPng,
    buildSvg: buildStandaloneSvg,
    downloadName: function (ext) { return mindmapDownloadName(state.current, ext); },
    exportError: function () { return state.mmExportError || null; },
    /* 嵌入的 Mermaid 图表（```mermaid）：给浏览器测试用的只读入口 + 两个动作 */
    mermaidEnabled: mermaidEnabled,
    mermaidEngine: function () { return !!window.mermaid; },
    mermaidReady: function () { return state.mgPromise || Promise.resolve(); },
    mermaidBlocks: function () {
      return mgBlocks().map(function (el) {
        var k = mgKind(el);
        return {
          index: Number(el.getAttribute('data-mg-index')) || 0,
          kind: k.id, label: k.name,
          state: el.getAttribute('data-mg-state') || '',
          error: el.getAttribute('data-mg-error') || null,
          source: mgSource(el),
          showSource: el.classList.contains('mg-show-src'),
          fullscreen: el.classList.contains('mg-full'),
          nodes: el.querySelectorAll('.mg-host svg .node, .mg-host svg g.statediagram-state, .mg-host svg g.stateGroup').length,
          edges: el.querySelectorAll('.mg-host svg path.flowchart-link, .mg-host svg path.transition, .mg-host svg .edgePath path').length,
          text: (el.querySelector('.mg-host svg') || {}).textContent || ''
        };
      });
    },
    rerenderMermaid: rerenderMermaid,
    /* 全文搜索：结果数、页内命中高亮、当前定位到的那一处、搜索条状态 */
    searchAll: searchAll,
    searchHits: function () { return $('article').querySelectorAll('mark.sr-hit').length; },
    currentHit: function () { var m = $('article').querySelector('mark.sr-cur'); return m ? m.textContent : null; },
    searchBarOpen: searchBarOpen,
    searchInput: function () { return $('topSearch').value; },
    searchNav: function () {
      var items = $('tree').querySelectorAll('.sr-nav');
      return {
        title: $('sidebarTitle').textContent,
        items: items.length,
        active: $('tree').querySelector('.sr-nav.active') ?
          $('tree').querySelector('.sr-nav.active').getAttribute('data-g') : null
      };
    },
    exportMermaidSvg: function (i) {
      var el = mgBlocks()[Number(i) || 0];
      return el ? exportMermaidSvg(el) : null;
    },
    mermaidFullscreen: mgFullscreenOn
  };

  /* ---------- 启动 ---------- */
  (async function main() {
    await loadConfig();
    cwLoad();
    applyConfig();
    loadLayout();
    initWidthEdges();
    enableMotion();
    state.docs = await loadDocs();
    indexDocs(state.docs);
    applyDocFilter();
    renderFoot();
    renderSidebar();
    route();
  })();
})();

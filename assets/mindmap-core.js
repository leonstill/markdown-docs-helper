/* =====================================================================
   mindmap-core：把 Mermaid mindmap（.mermaid 文件）转成思维导图数据
   —— 不依赖 DOM，可在 Node 中单独测试（test/verify-mindmap.mjs）。

   输入是 Mermaid 的 mindmap 版式：
       mindmap
         root((根节点))
           分支
             子节点
   匹配方式：缩进层级（空格数，tab 记 4 个空格），不要求固定步长。
   节点形状 `id((圆))`、`[方]`、`(圆角)`、`{{六边}}`、`))爆炸((`、`)云(` 只取其中的文字，
   额外的 id 会被丢掉——思维导图上只显示文字，与示例页一致。

   输出侧：nodes[] 是给右侧大纲用的层级结构；toMarkdown() 是交给 markmap 的
   Markdown 大纲（# 根、## 一级、- 二级…），这样 markmap 的行内排版就能直接用。
   ===================================================================== */
var MindmapCore = (function () {
  'use strict';

  /* 行首空白：tab 记 4 列。缩进比较用列数（indent），切字符串必须用字符数（chars）。
     混用 tab 时这两个值不相等，用错就会把正文开头的字吃掉。 */
  function leadingBlank(line) {
    var chars = 0, indent = 0;
    while (chars < line.length) {
      var c = line.charAt(chars);
      if (c === ' ') { indent += 1; chars += 1; }
      else if (c === '\t') { indent += 4; chars += 1; }
      else break;
    }
    return { chars: chars, indent: indent };
  }

  /* 一行节点：`((根))`、`id[方]`、`(圆角)`、`{{六边}}`、`))爆炸((`、`)云(`、纯文本。
     形状按「前后缀配对」判断，比一条大正则更好读，也不会被文字里的括号带偏。
     前半段的 id 是 Mermaid 允许的写法（`root((根))`、`id1[方]`、`A[方]`），
     只有当「剥掉 id 之后剩下的确实是一个完整形状」时才剥。
     id 必须严格限定为 ASCII 标识符：中文节点文字（如 `制表符分支`）不能被当成 id 吃掉。 */
  function parseNodeLine(s) {
    s = s.replace(/\s+$/, '');
    if (!s) return null;
    var token = '';
    while (true) {
      var shaped = shapeText(s);
      if (shaped) {
        shaped.id = token;
        return shaped;
      }
      var m = /^([A-Za-z][A-Za-z0-9_-]*)\s*([([{)\]][\s\S]*)$/.exec(s);
      if (!m) return { text: clean(s), shape: 'default', id: '' };
      token = m[1];
      s = m[2];
    }
  }

  /* 判断整行是否就是一个形状节点；是则返回 { text, shape }，否则 null */
  function shapeText(s) {
    if (pair(s, '((', '))')) return { text: clean(s.slice(2, -2)), shape: 'circle' };
    if (pair(s, '{{', '}}')) return { text: clean(s.slice(2, -2)), shape: 'hexagon' };
    if (pair(s, '))', '((')) return { text: clean(s.slice(2, -2)), shape: 'bang' };
    if (pair(s, '[', ']')) return { text: clean(s.slice(1, -1)), shape: 'square' };
    if (pair(s, '{', '}')) return { text: clean(s.slice(1, -1)), shape: 'hexagon' };
    if (pair(s, ')(', null)) return { text: clean(s.slice(1, -1)), shape: 'cloud' };
    if (pair(s, ')', '(')) return { text: clean(s.slice(1, -1)), shape: 'cloud' };
    if (pair(s, '(', ')')) return { text: clean(s.slice(1, -1)), shape: 'round' };
    return null;
  }

  /* 前后缀配对，且中间不能是空的（`()` 这种空节点不算形状） */
  function pair(s, prefix, suffix) {
    if (s.slice(0, prefix.length) !== prefix) return false;
    if (suffix === null) return s.length > prefix.length;
    if (s.length < prefix.length + suffix.length + 1) return false;
    return s.slice(-suffix.length) === suffix;
  }

  /* 去掉包裹文字的引号；Mermaid 里 "文字" 是合法的 */
  function clean(s) {
    s = String(s).trim();
    var m = /^"([\s\S]*)"$/.exec(s);
    return (m ? m[1] : s).trim();
  }

  /* ---------- 解析 ---------- */
  function parse(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var out = { root: null, nodes: [], warnings: [], sawHeader: false };

    // 先定位 `mindmap` 声明行；没有声明的宽松处理：第一行按根节点读
    var start = -1;
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t || /^%%/.test(t) || /^---\s*$/.test(t)) continue;
      if (/^mindmap\s*$/i.test(t)) { out.sawHeader = true; start = i + 1; }
      else start = i;
      break;
    }
    if (start < 0) {
      out.warnings.push('空文件：没有找到任何节点');
      return out;
    }
    if (!out.sawHeader) out.warnings.push('没有找到 "mindmap" 声明行，已按缩进直接解析');

    var flat = [];      // 扁平化结果，保留层级与顺序
    var stack = [];     // 缩进栈：{ indent, node }
    for (var j = start; j < lines.length; j++) {
      var raw = lines[j];
      if (/^\s*%%/.test(raw)) continue;                        // 注释与 init 指令
      if (!raw.trim()) continue;
      var stripped = raw.replace(/\s+$/, '');
      var lead = leadingBlank(stripped);
      var node = parseNodeLine(stripped.slice(lead.chars));
      if (!node) continue;

      var width = lead.indent;
      var entry = { id: node.id || '', text: node.text, shape: node.shape, depth: 0, children: [], parent: null, indent: width };
      while (stack.length && stack[stack.length - 1].indent >= width) stack.pop();
      if (!stack.length) {
        if (out.root) {           // 缩进回到 0 的第二棵树：作为根的兄弟，避免丢内容
          entry.parent = null;
          flat.push(entry);
          stack.push({ indent: width, node: entry });
          continue;
        }
        out.root = entry;
      } else {
        entry.parent = stack[stack.length - 1].node;
        entry.parent.children.push(entry);
      }
      entry.depth = entry.parent ? entry.parent.depth + 1 : 0;
      flat.push(entry);
      stack.push({ indent: width, node: entry });
    }

    if (!out.root) {
      out.warnings.push('没有解析出任何节点，请检查缩进');
      return out;
    }
    // 多棵树时：把多余的根挂到第一个根下，保证导图只有一棵树
    flat.filter(function (n) { return !n.parent && n !== out.root; }).forEach(function (n) {
      n.parent = out.root;
      n.depth = 1;
      out.root.children.push(n);
      (function fix(m) { m.depth = m.parent ? m.parent.depth + 1 : 0; m.children.forEach(fix); })(n);
    });
    out.nodes = flat;
    out.title = out.root.text;
    return out;
  }

  /* ---------- Markdown 转义 ----------
     markmap 用 Markdown 渲染节点，所以要挡掉会被当成语法的字符。
     只挡真正会破坏结构的：反斜杠、反引号、星号、下划线、方括号、竖线，
     以及行首的 # > - + 和「数字.」。中文标点与 #26 这种引用保持原样。 */
  function escapeInline(s) {
    return String(s)
      .replace(/[\\`*_\[\]|]/g, function (c) { return '\\' + c; })
      .replace(/\s+/g, ' ')
      .trim();
  }
  function mdText(s) {
    s = escapeInline(s);
    if (/^\d+[.)]\s/.test(s)) return s.replace(/^(\d+)([.)])/, '$1\\$2');
    return s.replace(/^([#>+\-])(?=\s|$)/, '\\$1');
  }

  /* 渲染成 markmap 用的 Markdown：# 根、## 一级分支、更深用列表 */
  function toMarkdown(tree) {
    var root = tree && (tree.root || tree);
    if (!root) return '';
    var lines = ['# ' + mdText(root.text)];
    (function walk(node, level) {
      node.children.forEach(function (child) {
        if (level === 1) lines.push('', '## ' + mdText(child.text));
        else lines.push(new Array(level - 2 + 1).join('  ') + '- ' + mdText(child.text));
        walk(child, level + 1);
      });
    })(root, 1);
    return lines.join('\n') + '\n';
  }

  /* ---------- 右侧大纲：树状结构，渲染时按层级缩进 ---------- */
  function outline(tree) {
    var root = tree && (tree.root || tree);
    if (!root) return [];
    function kids(node, depth, path) {
      return node.children.map(function (child, i) {
        var p = path + '/' + i;
        return {
          level: Math.min(depth, 4),
          text: child.text,
          ref: child,
          path: p,
          children: kids(child, depth + 1, p)
        };
      });
    }
    return kids(root, 1, '');
  }

  function summary(tree) {
    var n = tree && tree.nodes ? tree.nodes.length : 0;
    var maxDepth = 0;
    (tree && tree.nodes ? tree.nodes : []).forEach(function (x) { if (x.depth > maxDepth) maxDepth = x.depth; });
    return { count: n, depth: maxDepth };
  }

  return {
    parse: parse,
    toMarkdown: toMarkdown,
    outline: outline,
    summary: summary,
    mdText: mdText,
    escapeInline: escapeInline
  };
})();

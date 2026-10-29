/* =====================================================================
 * 搜索查询语法回归（纯 Node，不需要浏览器）
 *
 * 被测对象：assets/md-core.js 里的三个纯函数
 *   parseSearchQuery(raw, asRegex) —— 空格/|| 或、&& 与、! 非、反斜杠转义、正则模式
 *   searchScanLine(line, spec)     —— 单行命中（重叠合并、零长度正则跳过）
 *   searchActiveTerms(spec, lines) —— 文档级布尔判定（AND 可跨行，NOT 要求整篇没有）
 *
 * 用法：node test/verify-search.mjs      （失败退出码 1）
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE = path.join(HERE, '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const CORE = path.join(CACHE, 'md-core.cjs');
fs.writeFileSync(CORE, fs.readFileSync(path.join(ROOT, 'assets', 'md-core.js'), 'utf8'));
const require = createRequire(import.meta.url);
const Core = require(CORE);

let bad = 0, good = 0;
function check(name, cond, detail) {
  if (cond) { good++; console.log('  ok   ' + name); }
  else { bad++; console.log('  FAIL ' + name + (detail === undefined ? '' : '   <- ' + detail)); }
}
function same(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  check(name, a === b, a + ' != ' + b);
}
const clausesOf = (spec) => spec.clauses.map((c) => ({ pos: c.pos.slice(), neg: c.neg.slice() }));
const P = (q, re) => Core.parseSearchQuery(q, !!re);

console.log('[1] 普通模式：或 / 与 / 非');
same('单个词', clausesOf(P('mermaid')), [{ pos: ['mermaid'], neg: [] }]);
same('空格＝或', clausesOf(P('foo bar')), [{ pos: ['foo'], neg: [] }, { pos: ['bar'], neg: [] }]);
same('显式 ||', clausesOf(P('foo || bar')), [{ pos: ['foo'], neg: [] }, { pos: ['bar'], neg: [] }]);
same('&& 是一个分支里两个词', clausesOf(P('foo && bar')), [{ pos: ['foo', 'bar'], neg: [] }]);
same('! 归到「非」', clausesOf(P('foo && !bar')), [{ pos: ['foo'], neg: ['bar'] }]);
same('&& 比 || 优先', clausesOf(P('a && b || c')), [{ pos: ['a', 'b'], neg: [] }, { pos: ['c'], neg: [] }]);
same('不带空格也认运算符', clausesOf(P('a&&b||c')), [{ pos: ['a', 'b'], neg: [] }, { pos: ['c'], neg: [] }]);
same('!! 等于没有否定', clausesOf(P('!!foo')), [{ pos: ['foo'], neg: [] }]);
check('查询为空时 empty 且不报错', P('   ').empty === true && !P('   ').error);

console.log('\n[2] 转义与字面符号');
same('\\&\\& 是字面 &&', clausesOf(P('a\\&\\&b')), [{ pos: ['a&&b'], neg: [] }]);
same('\\! 是字面感叹号', clausesOf(P('\\!important')), [{ pos: ['!important'], neg: [] }]);
same('\\| 是字面竖线', clausesOf(P('a\\|b')), [{ pos: ['a|b'], neg: [] }]);
same('单个 & 不用转义', clausesOf(P('R&D')), [{ pos: ['R&D'], neg: [] }]);
same('单个 | 不用转义', clausesOf(P('a|b')), [{ pos: ['a|b'], neg: [] }]);
same('\\空格 可以搜带空格的短语', clausesOf(P('foo\\ bar')), [{ pos: ['foo bar'], neg: [] }]);
same('\\\\ 是字面反斜杠', clausesOf(P('a\\\\b')), [{ pos: ['a\\b'], neg: [] }]);

console.log('\n[3] 非法查询给中文提示');
['!foo', 'foo || !bar', '! foo', '&& foo', 'foo &&', 'foo && || bar', 'a!', 'foo && !'].forEach((q) => {
  const sp = P(q);
  check('拒绝 ' + JSON.stringify(q) + '：' + (sp.error || '（没有报错）'), !!sp.error);
});
check('错误提示里不含 undefined', !/undefined/.test(P('!foo').error));

console.log('\n[4] 正则模式');
const reSpec = P('a\\d+', true);
check('模式为 regex 且带 g/i 标志', reSpec.mode === 'regex' && reSpec.re && reSpec.re.flags.includes('g') && reSpec.re.flags.includes('i'));
check('正则语法错误会被捕获', /^正则表达式无效/.test(P('(', true).error || ''));
check('正则模式下 && 不再当语法', P('a&&b', true).clauses[0].pos[0] === 'a&&b');

console.log('\n[5] 单行命中');
const act = Core.searchActiveTerms(P('foo bar'), ['x foo x bar']);
same('两个词都标出来', Core.searchScanLine('x foo x bar', act), [{ start: 2, end: 5 }, { start: 8, end: 11 }]);
same('重叠只留最左一段', Core.searchScanLine('abc', { mode: 'text', terms: ['ab', 'bc'] }), [{ start: 0, end: 2 }]);
same('同位置取更长的那段', Core.searchScanLine('ab', { mode: 'text', terms: ['a', 'ab'] }), [{ start: 0, end: 2 }]);
same('大小写不敏感', Core.searchScanLine('FOO foo', { mode: 'text', terms: ['foo'] }), [{ start: 0, end: 3 }, { start: 4, end: 7 }]);
same('正则零长度命中跳过', Core.searchScanLine('ba', P('a*', true)), [{ start: 1, end: 2 }]);

console.log('\n[6] 文档级判定');
same('AND 允许跨行', Core.searchActiveTerms(P('foo && bar'), ['foo here', 'bar there']).terms, ['foo', 'bar']);
check('AND 缺一个词就不算命中', Core.searchActiveTerms(P('foo && bar'), ['foo here', 'nothing']) === null);
check('NOT 要求整篇都不出现', Core.searchActiveTerms(P('foo && !bar'), ['foo here', 'bar there']) === null);
same('NOT 通过后只列正向词', Core.searchActiveTerms(P('foo && !bar'), ['foo here', 'clean']).terms, ['foo']);
same('或的每个分支各自判定', Core.searchActiveTerms(P('a && b || c'), ['c only']).terms, ['c']);
same('多个分支都满足时并起来', Core.searchActiveTerms(P('a && b || c'), ['a b c']).terms, ['a', 'b', 'c']);
check('正则按行判定', Core.searchActiveTerms(P('mermaid|markmap', true), ['x mermaid y']) !== null);
check('正则没命中返回 null', Core.searchActiveTerms(P('mermaid|markmap', true), ['nothing']) === null);
check('只有零长度正则命中也算没命中', Core.searchActiveTerms(P('^', true), ['abc']) === null);

console.log(`\n===== ${good}/${good + bad} 通过 =====`);
if (bad) process.exit(1);

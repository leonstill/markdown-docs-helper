/* =====================================================================
 * 命令行参数回归：参数必须“严格”——写错就要报错退出，绝不能被静默忽略。
 *
 * 这组用例守的是那个踩过的坑：目录写成位置参数以外的形式（例如旧的 --docs、
 * 或者干脆多写一个），脚本却照常启动、拿默认 ./docs 顶包，使用者以为指过去了。
 *
 * 覆盖：
 *   · --docs 已取消 → 报错并给出新写法
 *   · 未知参数 / 多余的目录 / 不存在的目录 / 目录位置写了文件 → 报错
 *   · --port 缺值、非数字、超范围、重复、没配 --serve → 报错
 *   · --serve 与 --check 混用 → 报错
 *   · 位置目录 + --check / 默认构建 / --help → 正常退出码 0，
 *     并核对内置索引里确实出现了那个目录下的文档（证明参数真的生效）
 *
 * 子进程输出写进 test/.cache/ 下的文件而不是管道：受限沙箱里管道会 EPERM。
 * 注意：末尾会用默认 ./docs 重新构建一次，把产物恢复成工程自带的演示文档。
 *
 * 用法：node test/cli-args.mjs
 * ===================================================================== */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'test', '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const OUT = path.join(CACHE, 'cli-args.out');
const ERR = path.join(CACHE, 'cli-args.err');

let fail = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'v' : 'x'} ${label}${ok || detail === undefined ? '' : '   <- ' + detail}`);
  if (!ok) fail++;
};

function run(args) {
  const fdOut = fs.openSync(OUT, 'w');
  const fdErr = fs.openSync(ERR, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [path.join(ROOT, 'build-docs.mjs'), ...args], {
      cwd: ROOT,
      stdio: ['ignore', fdOut, fdErr],
    });
  } finally {
    fs.closeSync(fdOut);
    fs.closeSync(fdErr);
  }
  return { code: r.status, out: fs.readFileSync(OUT, 'utf8'), err: fs.readFileSync(ERR, 'utf8') };
}

/** 断言：退出码 1，且输出里有指定片段 */
function rejects(label, args, needle) {
  const r = run(args);
  const text = r.out + r.err;
  const first = text.trim().split('\n')[0] || '(没有任何输出)';
  check(r.code === 1 && text.includes(needle), label, `exit=${r.code}；首行：${first}`);
}

/** 断言：退出码 0，且输出里有指定片段 */
function accepts(label, args, needle) {
  const r = run(args);
  const text = r.out + r.err;
  const first = text.trim().split('\n')[0] || '(没有任何输出)';
  check(r.code === 0 && text.includes(needle), label, `exit=${r.code}；首行：${first}`);
}

/* 一个临时的外部文档目录：用它来证明「位置目录」确实被当成文档目录 */
const TMP_DOCS = path.join(CACHE, 'cli-docs');
fs.rmSync(TMP_DOCS, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP_DOCS, '子目录'), { recursive: true });
fs.writeFileSync(path.join(TMP_DOCS, '子目录', '示例文档.md'), '# 参数验证用的标题\n\n正文。\n', 'utf8');

console.log('\n--- 必须报错（严格检查）---');
rejects('--docs 已取消，并提示新写法', ['--docs', 'docs'], '--docs 已取消');
rejects('未知参数被拒绝', ['--nope'], '未知参数：--nope');
rejects('未知短参数被拒绝', ['-x'], '未知参数：-x');
rejects('多余的目录被拒绝', ['docs', 'test'], '只能指定一个文档目录');
rejects('不存在的目录被拒绝', [path.join(CACHE, '不存在的目录')], '文档目录不存在');
rejects('目录位置写了文件被拒绝', ['config.json'], '这不是一个目录');
rejects('--port 缺值被拒绝', ['--serve', '--port'], '--port 后面要跟端口号');
rejects('--port 非数字被拒绝', ['--serve', '--port', 'abc'], '只接受 1-65535');
rejects('--port 超范围被拒绝', ['--serve', '--port', '70000'], '只接受 1-65535');
rejects('--port 没有 --serve 被拒绝', ['--port', '9000'], '--port 只在 --serve 模式下有效');
rejects('--port 重复被拒绝', ['--serve', '--port', '9000', '--port', '9001'], '--port 写了两次');
rejects('--serve 与 --check 混用被拒绝', ['--serve', '--check'], '只能选一个');

console.log('\n--- 正确写法 ---');
accepts('--help 打印用法', ['--help'], 'node build-docs.mjs --serve [目录]');
// 此刻产物是按默认 ./docs 构建的，用外部目录做 --check 应当报过期
// （如果位置目录被忽略，这里会因为比对的是 ./docs 而误判为最新，用例就会失败）
rejects('外部目录 + --check 认得出这个目录（过期）', ['--check', TMP_DOCS], '已过期');
accepts('位置目录 + 构建', [TMP_DOCS], '（命令行指定）');
{
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs-index.json'), 'utf8'));
  const hit = idx.docs.find((d) => d.path === 'docs/子目录/示例文档.md');
  check(!!hit && hit.title === '参数验证用的标题',
    '内置索引里出现了外部目录的文档（参数真的生效）', JSON.stringify(idx.docs.map((d) => d.path)));
}
accepts('刚构建完，同一个目录 + --check 是最新的', ['--check', TMP_DOCS], '都是最新的');

console.log('\n--- 收尾：用默认 ./docs 重建产物 ---');
accepts('默认构建（恢复演示文档）', [], '已刷新文档快照与页面配置');
{
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs-index.json'), 'utf8'));
  check(idx.docs.some((d) => d.path === 'docs/指南/快速开始.md'), '产物已回到工程自带的 docs/');
}

fs.rmSync(TMP_DOCS, { recursive: true, force: true });
console.log(fail ? `\n===== 失败 ${fail} 项 =====` : '\n===== 全部通过 =====');
process.exit(fail ? 1 : 0);

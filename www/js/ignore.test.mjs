/* ============================================================
   Test — www/js/ignore.js, the one reader of a .gitignore.
   ------------------------------------------------------------
   The shared folder (SYNC_FOLDER_SHARE_MAX, js/daimond.js) sends a
   desktop's real folder to the account's other devices, and a real
   folder holds build output: `typst watch` rewrites a 1.7 MB PDF
   beside its source on every keystroke. Without a rule about that,
   every keystroke offloads a megabyte and wakes every device.

   TWO CALLERS MUST AGREE. The census decides what to send; the
   merge decides what an arriving path may be written to. A path
   one half ignores and the other does not is a file that travels
   one way and is deleted on the way back — so there is one parser,
   and this drives it without a browser.

   The fixture is the case that prompted it: a book folder whose
   .gitignore names an archive tree and whose .oreignore adds a
   line of its own, over the built-in default.

     node www/js/ignore.test.mjs
     node --test www/js/*.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

// The module is a browser IIFE that hangs itself on `window`; the pattern
// presence.test.mjs established is what gives it one.
const win = {};
new Function('window', 'with (window) {\n' + readFileSync(join(HERE, 'ignore.js'), 'utf8') + '\n}')(win);
const I = win.DaimondIgnore;

check('the module publishes itself', !!I && typeof I.matcher === 'function');

// ── The built-in floor ───────────────────────────────────────
console.log('\n— the default list, for a folder that states no rules of its own —');
{
	const m = I.matcher([{ base: '', lines: I.DEFAULTS }]);
	check('a compiled PDF is not carried', m.ignored('book/onthearche.pdf', false));
	check('nor the app\'s own preview', m.ignored('book/onthearche-preview.pdf', false));
	check('nor a log', m.ignored('run.log', false));
	check('a cargo target directory is ignored AS A DIRECTORY', m.ignored('crate/target', true));
	check('and so is everything under it, asked without a walk',
		m.ignored('crate/target/debug/app', false));
	check('node_modules likewise', m.ignored('web/node_modules/left-pad/index.js', false));
	check('the repository itself is not the work', m.ignored('.git/config', false));
	check('an Ore store likewise', m.ignored('.ore/log/0001', false));
	check('the source beside them IS carried', !m.ignored('book/onthearche.typ', false));
	check('and a file merely NAMED like a directory rule is not',
		!m.ignored('crate/target.txt', false), 'target/ is a directory rule');
}

// ── The folder's own rules ───────────────────────────────────
console.log('\n— .gitignore and .oreignore, at the folder they sit in —');
{
	const m = I.matcher([
		{ base: '', lines: I.DEFAULTS },
		{ base: 'TheOrder/Onthearche', lines: ['archive/', '*.zip', '!keep.zip', 'plan/draft*'] },
		{ base: 'TheOrder/Onthearche', lines: ['revision/'] },
	]);
	check('a directory rule anchors to the file that stated it',
		m.ignored('TheOrder/Onthearche/archive/old.typ', false));
	check('and does NOT reach a same-named directory elsewhere',
		!m.ignored('Elsewhere/archive/old.typ', false));
	check('a glob rule reaches any depth under that folder',
		m.ignored('TheOrder/Onthearche/assets/fonts/libertinus.zip', false));
	check('a `!` line takes one path back, because the last match wins',
		!m.ignored('TheOrder/Onthearche/assets/keep.zip', false));
	check('an interior slash anchors without a leading one',
		m.ignored('TheOrder/Onthearche/plan/draft3.md', false)
		&& !m.ignored('TheOrder/Onthearche/notes/plan/draft3.md', false));
	check('a second ignore file adds to the first rather than replacing it',
		m.ignored('TheOrder/Onthearche/revision/r1.typ', false)
		&& m.ignored('TheOrder/Onthearche/archive/old.typ', false));
	check('the chapters themselves survive all of it',
		!m.ignored('TheOrder/Onthearche/chap_practice.typ', false)
		&& !m.ignored('TheOrder/Onthearche/assets/svg/mark.svg', false));
}

// ── The fiddly half, which is why there is one parser ────────
console.log('\n— the rules people get wrong —');
{
	const m = I.matcher([{ base: '', lines: [
		'# a comment',
		'',
		'  ',
		'/rooted.txt',
		'deep/**/leaf.txt',
		'a?c.md',
		'[Bb]uild/',
		'\\#literal.txt',
	] }]);
	check('a comment states nothing', !m.ignored('# a comment', false));
	check('a leading slash anchors to the root and nowhere else',
		m.ignored('rooted.txt', false) && !m.ignored('sub/rooted.txt', false));
	check('`**` spans any number of segments, including none',
		m.ignored('deep/leaf.txt', false) && m.ignored('deep/x/y/leaf.txt', false));
	check('and does not escape its anchor', !m.ignored('other/deep/leaf.txt', false));
	check('`?` is one character and never a separator',
		m.ignored('abc.md', false) && !m.ignored('a/c.md', false));
	check('a bracket class is a class', m.ignored('Build/out', false) && m.ignored('build/out', false));
	check('an escaped hash is a filename', m.ignored('#literal.txt', false));
	check('a `*` never crosses a separator',
		!I.matcher([{ base: '', lines: ['assets/*.svg'] }]).ignored('assets/deep/x.svg', false));
}

// ── Nothing at all ───────────────────────────────────────────
console.log('\n— no rules —');
{
	const m = I.matcher([]);
	check('an empty rule set ignores nothing', !m.ignored('anything/at/all.pdf', false));
	check('and the root itself is never a match', !m.ignored('', false));
}

console.log(`\n${checks - failures} ok, ${failures} failed`);
if (failures) process.exit(1);

/* ============================================================
   Test -- the crystal starter page (K4, D-20261008-08) is built from the shipped page's own pieces.

   The starter is the page a daimon forks. It must speak exactly the channel DEFAULT_PAGE speaks (one
   head and policy, one library, one wire), never read a file itself, and its script must parse --
   and the split that made the sharing possible must leave DEFAULT_PAGE byte for byte as it was,
   since `adopt` matches stored copies of it.   `node www/js/crystalstarter.test.mjs`
   The page in the real app, in both looks and at both widths: dev/verify_crystalstarter.mjs.
   ============================================================ */
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { createHash } from 'node:crypto';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const win = makeWindow({});
loadScript(win, 'crystal.js');
const C = win.DaimondCrystal;
const S = C.STARTER_PAGE || '';
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

check('DEFAULT_PAGE is byte for byte the page before the split', sha(C.DEFAULT_PAGE) === '58a2613a31941258', sha(C.DEFAULT_PAGE));
check('there is a starter page, at the path the standing context names',
	S.length > 8000 && C.STARTER_PATH === '.daimond/starters/crystal.html', `${S.length} bytes, ${C.STARTER_PATH}`);
const cut = (p, a, b) => { const i = p.indexOf(a); return i < 0 ? '' : p.slice(i, p.indexOf(b, i) + b.length); };
check('it carries the shipped head and policy', !!S && S.startsWith(cut(C.DEFAULT_PAGE, '<!doctype html>', '<style>')));
const wire = cut(C.DEFAULT_PAGE, 'function measure(){', 'post({cmd:"ready"});');
check('it carries the shipped wire: height, the data message, links, ready', wire.length > 300 && S.includes(wire));
const lib = cut(C.DEFAULT_PAGE, 'var CORE=', 'el.textContent=":root{"+css+"}";}');
check('it carries the shipped library: escaping, markdown, theme', lib.length > 2000 && S.includes(lib));
check('it never reads a file and never fetches', !!S && !/cmd:"asset"|loadSelf\(|fetch\(|XMLHttpRequest/.test(S));
const js = S.slice(S.indexOf('<script>') + 8, S.lastIndexOf('<\/script>'));
let parses = false, why = '';
try { new Function(js); parses = true; } catch (e) { why = e.message; }
check('its script parses', parses, why);

// The parts, drawn in node with the page's own helpers stubbed to identity, over every shape.
const draw = (D) => {
	const H = { esc: (s) => String(s), md: (s) => '<p>' + s + '</p>', inl: (s) => String(s),
		has: (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length), anch: (h, t) => t };
	const src = js.slice(js.indexOf('var DRAW=') + 9, js.indexOf(';\nfunction render(){'));
	return (new Function('return ' + src)())(D, {}, H);
};
if (parses) {
	const o = draw({ title: 'T', stats: [{ label: 'a', value: 5 }], ranked: [{ label: 'x', value: 1 }, { label: 'y', value: 3 }],
		timeline: [{ when: '1', what: 'w' }], spectrum: { left: 'l', right: 'r', value: 0.2 }, cards: [{ title: 'c', body: 'b' }],
		mine: [{ label: 'n', value: 2 }], odd: { deep: { deeper: { deepest: [1, 2] } } } });
	check('every part draws and reports its key, a new key by its shape',
		['title', 'stats', 'ranked', 'timeline', 'spectrum', 'cards', 'mine', 'odd'].every((k) => o.keys.includes(k)), o.keys.join(','));
	check('ranked bars are largest first', o.html.indexOf('>y<') < o.html.indexOf('>x<'));
	check('nothing nested falls to a <pre> or a JSON run', !/<pre|\{"/.test(o.html));
}
console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);

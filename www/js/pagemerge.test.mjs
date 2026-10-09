/* ============================================================
   Test -- a forked page receives its template's fix (#12, D-20261006-22/-23).

   `DaimondVersions.merge3(base, mine, theirs)` brings the template's changes since
   `base` into the person's copy: a change on one side is taken, a change on both
   sides to different lines is a conflict that keeps the person's lines and lists
   the template's. Run against small texts and against the real Life log template's
   own history at full size (past the 2,000-line LCS cap).   `node www/js/pagemerge.test.mjs`
   The offer in the real app: dev/verify_crystalupdate.mjs.
   ============================================================ */
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TPL  = join(HERE, '..', 'capps', 'lifelog');

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const win = makeWindow({});
loadScript(win, 'versions.js');
const V = win.DaimondVersions;
check('versions.js exports merge3', !!V && typeof V.merge3 === 'function');
if (!V || typeof V.merge3 !== 'function') { console.log('\n' + failures + ' failed'); process.exit(1); }

const L = (...xs) => xs.join('\n');

// One side only.
{
	const base = L('a', 'b', 'c', 'd', 'e');
	const mine = L('a', 'B-mine', 'c', 'd', 'e');
	const theirs = L('a', 'b', 'c', 'd', 'E-fix');
	const m = V.merge3(base, mine, theirs);
	check('a fix far from the person\'s edit merges cleanly', m && m.conflicts.length === 0, JSON.stringify(m));
	check('and keeps both', m && m.text === L('a', 'B-mine', 'c', 'd', 'E-fix'), m && m.text);
}
// Insertions and deletions on each side.
{
	const base = L('h', '1', '2', '3', '4', 'f');
	const mine = L('h', '1', 'mine-added', '2', '3', '4', 'f');
	const theirs = L('h', '1', '2', '4', 'f', 'tpl-tail');
	const m = V.merge3(base, mine, theirs);
	check('inserts and deletes on different lines merge', m && m.conflicts.length === 0
		&& m.text === L('h', '1', 'mine-added', '2', '4', 'f', 'tpl-tail'), m && m.text);
}
// The same change on both sides is not a conflict.
{
	const m = V.merge3(L('a', 'b'), L('a', 'B'), L('a', 'B'));
	check('the same change on both sides is taken once', m && m.conflicts.length === 0 && m.text === L('a', 'B'));
}
// A conflict: shown, the person's lines kept.
{
	const base = L('top', 'title', 'mid', 'end');
	const mine = L('top', 'title: MINE', 'mid', 'end');
	const theirs = L('top', 'title: TEMPLATE', 'mid', 'end: fixed');
	const m = V.merge3(base, mine, theirs);
	check('both sides moving one line is ONE conflict', m && m.conflicts.length === 1, m && JSON.stringify(m.conflicts));
	const c = m && m.conflicts[0];
	check('it lists the person\'s lines and the template\'s', c && c.mine.join() === 'title: MINE'
		&& c.theirs.join() === 'title: TEMPLATE' && c.base.join() === 'title', JSON.stringify(c));
	check('the person\'s line stands in the text, the rest of the fix is in',
		m && m.text === L('top', 'title: MINE', 'mid', 'end: fixed'), m && m.text);
	check('its line number points at it', c && m.text.split('\n')[c.line - 1] === 'title: MINE', c && c.line);
}
// Nothing changed in the template: the person's page comes back as it is.
{
	const mine = L('x', 'y-mine', 'z', '');
	const m = V.merge3(L('x', 'y', 'z', ''), mine, L('x', 'y', 'z', ''));
	check('an unchanged template gives back the page byte for byte', m && m.text === mine);
}
// A pair too different to merge answers null rather than a guess.
{
	const big = (p) => Array.from({ length: 2500 }, (_, i) => p + i).join('\n');
	check('a page rewritten from top to bottom answers null', V.merge3(big('a'), big('b'), big('a')) === null);
}

// At full size, against the real template's history.
{
	const sha = (s) => createHash('sha256').update(s).digest('hex');
	const now = readFileSync(join(TPL, 'crystal.html'), 'utf8');
	let bases = [];
	try { bases = readdirSync(join(TPL, 'base')).filter((f) => /^[0-9a-f]{64}\.html$/.test(f)); } catch (e) { /* none */ }
	check('the bundle carries the template\'s past pages, by hash', bases.length >= 1, bases.length);
	let named = true;
	for (const f of bases) if (sha(readFileSync(join(TPL, 'base', f), 'utf8')) + '.html' !== f) named = false;
	check('each named for its own SHA-256', named);
	for (const f of bases) {
		const base = readFileSync(join(TPL, 'base', f), 'utf8');
		const lines = base.split('\n');
		// The person's daimon changed a line near the top that the template has not touched since.
		let at = lines.findIndex((l, i) => i > 3 && /<title>|<meta/.test(l) && now.split('\n').includes(l));
		if (at < 0) at = 1;
		const mine = lines.slice(0, at).concat(['<!-- the person\'s own line -->'], lines.slice(at)).join('\n');
		const t0 = Date.now();
		const m = V.merge3(base, mine, now);
		const ms = Date.now() - t0;
		check('base ' + f.slice(0, 12) + ' (' + lines.length + ' lines) merges into today\'s template in ' + ms + ' ms',
			!!m && m.conflicts.length === 0, m ? m.conflicts.length + ' conflicts' : 'null');
		const want = now.split('\n');
		const got = m ? m.text.split('\n') : [];
		check('  with the person\'s line and every line of today\'s template',
			!!m && got.includes('<!-- the person\'s own line -->') && got.length === want.length + 1
			&& got.filter((l) => l !== '<!-- the person\'s own line -->').join('\n') === now);
	}
}

console.log('\n' + (failures ? failures + ' failed' : 'all ok'));
process.exit(failures ? 1 : 0);

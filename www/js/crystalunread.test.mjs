/* ============================================================
   Test -- a crystal that cannot be READ is drawn broken, never editable-empty
   (r542 QA A, unproven suspicion 1, F3 of the r543 fixes).

   `renderCrystal` ran `try { text = await read_crystal_data(id) } catch { text = '' }`, and
   `crystalData('')` is `{}`: a store that refused the read drew an empty crystal whose bar
   offered Edit, and Save wrote `{}` over a `crystal.json` nobody had seen.

   The fix: the read goes through `readCrystalFor`, which answers `data: null` (no parsed
   copy) and a `broken` reason when the read throws, so the bar leaves Edit out, the face
   names the failure, and the memory panel offers no raw editor over text it never read.
   ============================================================ */
import { makeWindow, loadScript, sliceDaimond } from '../../dev/syncprobe.mjs';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

function el(tag) {
	return { tag, children: [], listeners: {}, attrs: {}, className: '', textContent: '',
		appendChild(c) { this.children.push(c); return c; },
		addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
		setAttribute(k, v) { this.attrs[k] = v; } };
}
const doc = { createElement: el, querySelectorAll: () => [], getElementById: () => null };
const win = makeWindow({ extra: { document: doc } });
loadScript(win, 'crystal.js');
let reader = async () => '{"title":"T"}';
const stubs = {
	t: (k) => k, tOr: (k, d) => d,
	askAboutPage() {}, showCrystalHistory() {}, showTagEditor() {}, editCrystal() {},
	friendlyError: (e) => String((e && e.message) || e),
	diamondApp: () => ({ read_crystal_data: (id) => reader(id) }),
};
let fns = null;
try {
	fns = sliceDaimond(win, ['readCrystalFor', 'crystalBar', 'crystalData', 'crystalBroken', 'crystalLib'], stubs).fns;
} catch (e) { check('readCrystalFor exists', false, e.message); }

if (fns) {
	reader = async () => { throw new Error('OPFS: NotReadableError'); };
	const r = await fns.readCrystalFor('d1');
	check('a read that throws gives no parsed copy', r.data === null, JSON.stringify(r));
	check('and names the failure as the reason it is broken', typeof r.broken === 'string' && /NotReadable/.test(r.broken),
		JSON.stringify(r));
	check('and is marked unread', r.unread === true);
	const bar = fns.crystalBar(r.data);
	check('the bar offers no Edit over a crystal it could not read',
		!bar.children.some((c) => c.textContent === 'files.edit'));

	reader = async () => '';
	const blank = await fns.readCrystalFor('d1');
	check('a blank crystal that WAS read is still an empty, editable one',
		blank.data && Object.keys(blank.data).length === 0 && blank.broken === null && !blank.unread, JSON.stringify(blank));
	reader = async () => '{"title":"T",}';
	const bad = await fns.readCrystalFor('d1');
	check('a read that gives broken JSON is broken as before, not unread',
		bad.data === null && bad.broken !== null && !bad.unread, JSON.stringify(bad));
}

const src = readFileSync(new URL('./daimond.js', import.meta.url), 'utf8');
const a = src.indexOf('\tasync function renderCrystal()');
const rc = src.slice(a, src.indexOf('\n\t}\n', a));
check('renderCrystal reads through readCrystalFor, not a catch that answers empty text',
	/readCrystalFor\(id\)/.test(rc) && !/read_crystal_data\(id\); \} catch \(e\) \{ text = ''; \}/.test(rc));
check('an unread crystal is told apart on the face', /crystal\.unreadable/.test(rc));
const p = src.indexOf('\tfunction crystalMemoryPanel(');
const panel = src.slice(p, src.indexOf('\n\t}\n', p));
check('the memory panel draws no raw editor (and so no Save) for a crystal it never read',
	/function crystalMemoryPanel\(id, rawText, data, broken, unread\)/.test(panel)
	&& /if \(unread\) return box;[\s\S]*var rawBtn/.test(panel));

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('crystalunread: all passed');

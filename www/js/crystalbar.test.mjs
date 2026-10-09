/* ============================================================
   Test -- the crystal bar's Edit cannot write `{}` over a broken crystal
   (r541 QA A2, F1; specs/daimond_r541_qa_A2_20261009.md).

   THE BUG. `renderCrystal` built `crystalBar(data || {})`. `data` is `null` for JSON that does
   not parse, so the bar's Edit opened `editCrystal({})`, and its Save wrote `{}` over the file.
   `{}` parses, so nothing -- no MUST FIX, no face note -- ever said the crystal was gone.

   THE FIX. `null` is the one answer for "there is no parsed copy to form-edit". The bar is
   handed `data` as it is and leaves Edit out for `null`, and `editCrystal` itself refuses
   `null`, so no other entry point can open the form over a broken file either.
   `node www/js/crystalbar.test.mjs`
   ============================================================ */

import { makeWindow, loadScript, sliceDaimond } from '../../dev/syncprobe.mjs';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

// A DOM just big enough for crystalBar and editCrystal.
function el(tag) {
	const e = { tag, children: [], listeners: {}, attrs: {}, className: '', textContent: '', hidden: false, disabled: false, value: '',
		appendChild(c) { this.children.push(c); return c; },
		addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
		setAttribute(k, v) { this.attrs[k] = v; },
		querySelector() { return null; },
		focus() {},
		set innerHTML(v) { this.children = []; },
		async click() { for (const f of this.listeners.click || []) await f({}); },
	};
	return e;
}
const doc = { createElement: el, querySelectorAll: () => [], getElementById: () => null };
const writes = [];
const notices = [];
const win = makeWindow({ extra: { document: doc } });
loadScript(win, 'crystal.js');
const body = el('div');
const stubs = {
	t: (k) => k, tOr: (k, d) => d,
	askAboutPage() {}, showCrystalHistory() {}, showTagEditor() {},
	clearCrystalBody() { body.children = []; },
	crystalBody: body,
	crystalForm: () => el('div'),
	noticeDialog(a, b) { notices.push([a, b]); }, friendlyError: (e) => String(e),
	refreshDiamondAfterChange: async () => {},
	renderCrystal() {},
	currentDiamond: { id: 'd1' },
	diamondApp: () => ({ write_crystal_data: async (id, text) => { writes.push([id, text]); } }),
};
const fns = sliceDaimond(win, ['crystalData', 'crystalBroken', 'crystalJson', 'crystalBar', 'editCrystal', 'crystalLib'], stubs).fns;
const editOf = (bar) => bar.children.find((c) => c.textContent === 'files.edit');
async function editThenSave(bar) {
	const btn = editOf(bar);
	if (!btn) return;
	await btn.click();
	const save = body.children[0] && body.children[0].children[0];
	if (save) await save.click();
}

// The call site, as the page writes it: the parsed copy handed over as it is.
const src = readFileSync(new URL('./daimond.js', import.meta.url), 'utf8');
check('renderCrystal hands the bar the parsed copy as it is, null included',
	/crystalBody\.appendChild\(crystalBar\(data\)\)/.test(src) && !/crystalBar\(data \|\| \{\}\)/.test(src));

// A broken crystal: no Edit, and Edit then Save writes nothing.
const broken = '{"title":"Ontheism","summary":"S",\n"sections":[{"heading":"H","body":"B"},]}';
check('the text is broken', fns.crystalBroken(broken) !== null);
const bar = fns.crystalBar(fns.crystalData(broken));
check('the crystal bar offers no Edit for a broken crystal', !editOf(bar), 'it does');
await editThenSave(bar);
check('Edit then Save writes nothing over the broken crystal', writes.length === 0, JSON.stringify(writes));

// editCrystal itself, from any entry point, refuses the copy a broken text gives.
writes.length = 0; body.children = [];
await fns.editCrystal(fns.crystalData(broken));
const save = body.children[0] && body.children[0].children[0];
if (save) await save.click();
check('editCrystal(null) opens no form and writes nothing', writes.length === 0 && body.children.length === 0,
	JSON.stringify(writes));
check('and says why', notices.length === 1, JSON.stringify(notices));

// A sound crystal: Edit then Save writes what is there, unchanged.
writes.length = 0; notices.length = 0;
const good = '{"title":"Ontheism","summary":"S"}';
const goodBar = fns.crystalBar(fns.crystalData(good));
check('a sound crystal still offers Edit', !!editOf(goodBar));
await editThenSave(goodBar);
check('and its Save writes the crystal back', writes.length === 1 && JSON.parse(writes[0][1]).title === 'Ontheism',
	JSON.stringify(writes));

// A blank crystal is an empty one, and an empty one is form-edited.
writes.length = 0;
check('a blank crystal still offers Edit', !!editOf(fns.crystalBar(fns.crystalData(''))));

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('crystalbar: all passed');

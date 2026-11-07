/* ============================================================
   Test -- a History record-change note starts with a capital in every locale (HIST-NOTE-CASE).

   The note opened with the engine's raw field id, so History read "tags: none → research"
   and "name: a → b". Each field now has a label of its own in every locale, and a key the
   build does not know is named inside a sentence that starts with a capital.
   ============================================================ */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const crystal = src('./page/crystal.js');
const at = crystal.indexOf('function histMetaRow(');
const end = crystal.indexOf('\n}\n', at);
check('History draws the record-change note', at >= 0 && end > at);
const histMetaRow = crystal.slice(at, end + 2);

function el() {
	return { className: '', textContent: '', kids: [], appendChild(c) { this.kids.push(c); return c; } };
}

const FIELDS = ['name', 'tags', 'builtin', 'no_progress_rounds', 'colour'];
for (const loc of ['en', 'de', 'fr', 'es', 'pt-BR', 'ja', 'ko', 'zh-Hans']) {
	let table = {};
	const win = { DaimondI18n: { register(code, tb) { table = tb; } } };
	vm.runInNewContext(src('../i18n/' + loc + '.js'), { window: win });
	const t = (k, v) => {
		const s = Object.prototype.hasOwnProperty.call(table, k) ? table[k] : k;
		return v ? s.replace(/\{(\w+)\}/g, (w, n) => (n in v ? String(v[n]) : w)) : s;
	};
	const ctx = { t, document: { createElement: el }, relTime: () => '', deviceNameFor: (d) => d };
	vm.runInNewContext(histMetaRow, ctx);
	for (const field of FIELDS) {
		const row = ctx.histMetaRow({ at: 1, dev: 'laptop-1', by: 'user', field, old: '', 'new': 'research' });
		const note = row.kids.find(k => k.className === 'hist-note').textContent;
		const known = field !== 'colour';
		check(loc + ' ' + field + ' note starts with a capital', !/^\p{Ll}/u.test(note), note);
		check(loc + ' ' + field + ' note names the field in words',
			known ? !note.includes(field) && !note.includes('versions.') : note.includes(field), note);
	}
}

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('all ok');

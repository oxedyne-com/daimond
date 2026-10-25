// www/js/seatlabels.test.mjs -- SEAT-LABELS (owner, 25 Oct ~18:2x, rulings §7 "Seat reasons are
// short"): "wtf is this ridiculously long explanation? I can't click argonaut". A seat reason is a
// 2-4 word label beside the seat, the full sentence only on hover or tap.
//
// THE GATE: every `seat.why_<k>` key has a `seat.label_<k>` in every locale, of at most four
// words (counted by Intl.Segmenter, so Japanese and Chinese are held to it too, a placeholder
// counting as one), naming the same placeholders it may use; and every seat reason the page
// draws goes through the one renderer, `seatReason`, so none can bypass its label.
//
//     node www/js/seatlabels.test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { source, lift } from './testlift.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const I18N = join(HERE, '..', 'i18n');
let checks = 0, failures = 0;
function check(name, ok, detail) {
	checks++;
	if (!ok) failures++;
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '  (' + detail + ')'));
}

/// The table a locale file installs, read in a sandbox the way i18n.js would take it.
function table(file) {
	const src = readFileSync(join(I18N, file), 'utf8');
	let got = null;
	const ctx = vm.createContext({});
	ctx.window = ctx;
	ctx.DaimondI18n = { register: (_l, t) => { got = t; }, add: (_l, t) => { got = t; } };
	vm.runInContext(src, ctx);
	if (!got) for (const k of Object.keys(ctx)) if (ctx[k] && typeof ctx[k] === 'object' && ctx[k]['seat.here']) got = ctx[k];
	if (!got) {
		const m = /\{[\s\S]*\}/.exec(src);
		got = m ? vm.runInNewContext('(' + m[0] + ')') : {};
	}
	return got;
}
const words = (loc, s) => [...new Intl.Segmenter(loc, { granularity: 'word' })
	.segment(String(s).replace(/\{[a-z_]+\}/g, 'X'))].filter((g) => g.isWordLike).length;
const holes = (s) => (String(s).match(/\{[a-z_]+\}/g) || []).sort();

const locales = readdirSync(I18N).filter((f) => /\.js$/.test(f));
const en = table('en.js');
const whys = Object.keys(en).filter((k) => k.startsWith('seat.why_'));
check('the English table names the seat reasons', whys.length >= 9, whys.join());
for (const f of locales) {
	const loc = f.replace(/\.js$/, ''), T = table(f);
	for (const k of whys) {
		const lk = 'seat.label_' + k.slice('seat.why_'.length), lab = T[lk];
		check(loc + ' ' + lk + ' exists', typeof lab === 'string' && lab.trim().length > 0, String(lab));
		if (typeof lab !== 'string') continue;
		const n = words(loc, lab);
		check(loc + ' ' + lk + ' is 1-4 words', n >= 1 && n <= 4, n + ': ' + lab);
		const extra = holes(lab).filter((h) => holes(en[k]).indexOf(h) < 0);
		check(loc + ' ' + lk + ' uses only its sentence\'s placeholders', !extra.length, extra.join());
	}
	const orphans = Object.keys(T).filter((k) => k.startsWith('seat.label_') && !T['seat.why_' + k.slice(11)]);
	check(loc + ' has no label without its reason', !orphans.length, orphans.join());
}

// THE ONE RENDERER: no `seat.why_` is read in daimond.js except inside `seatReason`.
const src = source('daimond.js');
const L = lift(src, ['seatReason', 'seatWhyKey', 'seatWhyText'], []);
check('the renderer and its key map are there', L.missing.length === 0, L.missing.join());
const reads = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /['"]seat\.(why|label)_/.test(l));
const body = /function seatReason\([^)]*\) \{[\s\S]*?\n\t\}/.exec(src);
const inside = (n) => body && src.slice(0, body.index).split('\n').length <= n
	&& n <= src.slice(0, body.index + body[0].length).split('\n').length;
const stray = reads.filter(([n]) => !inside(n));
check('no seat reason is read outside seatReason', !stray.length, stray.map(([n, l]) => n + ':' + l.trim()).join(' | '));
if (!L.missing.length) {
	const ctx = vm.createContext({ t: (k, o) => k + (o ? JSON.stringify(o) : ''),
		deviceLabelFor: (id) => (id === 'rn' ? 'argonaut' : ''),
		DaimondModels: { providerName: (id) => id.toUpperCase() } });
	ctx.window = ctx;
	const api = vm.runInContext(L.body + ';({seatReason, seatWhyKey, seatWhyText})', ctx);
	const r = api.seatReason(api.seatWhyKey({ why: 'runner-unchecked', runnerId: 'rn' }));
	check('a reason renders a label and its sentence', r && /^seat\.label_runner_unchecked/.test(r.label)
		&& /^seat\.why_runner_unchecked/.test(r.why) && r.label.indexOf('argonaut') > 0, JSON.stringify(r));
	for (const w of ['runner-source', 'runner-rekey', 'runner-engine', 'runner-credits-only', 'runner-silent',
		'runner-busy', 'runner-phone', 'runner-require', 'runner-nosource', 'runner-unchecked', 'page-old']) {
		const k = api.seatWhyKey({ why: w, runnerId: 'rn', source: 'an', reach: 'nokey' });
		check('switch reason ' + w + ' has a key with a label', !!k && !!en['seat.why_' + k.k] && whys.indexOf('seat.why_' + k.k) >= 0,
			JSON.stringify(k));
	}
	check('no reason, no render', api.seatReason(api.seatWhyKey({})) === null && api.seatReason(null) === null);
}

// NOTRUN-WHY: the "not run" tile names its cause through the same renderer, every cause keyed.
{
	const N = lift(src, ['seatReason', 'notRunWhyKey'], ['NOTRUN_KEYS']);
	check('the not-run cause map and its key are there', N.missing.length === 0, N.missing.join());
	if (!N.missing.length) {
		const ctx = vm.createContext({ t: (k, o) => k + (o ? JSON.stringify(o) : ''),
			deviceNameFor: (id) => (id === 'rn' ? 'argonaut' : '') });
		const api = vm.runInContext(N.body + ';({seatReason, notRunWhyKey, NOTRUN_KEYS})', ctx);
		for (const c of Object.keys(api.NOTRUN_KEYS)) {
			const k = api.notRunWhyKey({ cause: c, to: 'rn' });
			check('not-run cause ' + c + ' has a reason with a label', !!k && whys.indexOf('seat.why_' + k.k) >= 0, JSON.stringify(k));
		}
		const r = api.seatReason(api.notRunWhyKey({ cause: 'size', to: 'rn' }));
		check('size renders its label naming the runner', !!r && /^seat\.label_notrun_size/.test(r.label) && r.label.indexOf('argonaut') > 0, JSON.stringify(r));
		check('a row with no cause names none', api.notRunWhyKey({ why: 'x' }) === null && api.notRunWhyKey(null) === null);
	}
	const mi = /function markInterrupted\([\s\S]*?\n\t\}/.exec(src);
	check('the not-run tile draws its reason, not the bare words', !!mi && /drawNotRunReason\(label, m\.notRun\)/.test(mi[0])
		&& mi[0].indexOf("t('turn.not_run')") < 0);
}

console.log(checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);

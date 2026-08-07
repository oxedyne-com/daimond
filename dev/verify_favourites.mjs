// verify_favourites.mjs — the models you use are at the top, and they are the same
// models as the ones further down.
//
// A working setup reaches a dozen models across four providers, listed in the order
// they are BILLED, which is not the order anybody wants them in. The favourites
// group is a shortcut to a row that already exists — so the two things it has to
// get right are that the shortlist is genuinely the most-used, and that a shortcut
// says exactly what the row it stands for says. A shortcut that read differently
// from the real row would be worse than no shortcut, because the economy marking
// (whose money a turn spends) is the part that matters most in this pulldown.
//
// The list is built from USE, not from selection: a model chosen in a pulldown and
// never run is not one anybody uses. So the checks drive `noteUse`, which is what
// the three commit points in daimond.js call.
//
//   node dev/verify_favourites.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway and no model: the
// provider list is seeded directly, and no turn is run.
import fs from 'node:fs';
import { open, errors, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'favourites');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'favourites', profile: PROFILE, connect: false });
const { page } = s;

/// Seed enough providers and models that the list is genuinely long, then read the
/// pulldown back as a structure. Everything below is the real `fillSelect`.
const build = (uses) => page.evaluate(async (u) => {
	localStorage.setItem('daimond-models-v2', JSON.stringify({
		v: 2,
		def: { provider: 'alpha', model: 'alpha/one' },
		providers: {
			alpha: { name: 'Alpha', url: 'https://a/v1/chat/completions', key: 'k',
				models: ['alpha/one', 'alpha/two', 'alpha/three', 'alpha/four'] },
			beta:  { name: 'Beta',  url: 'https://b/v1/chat/completions', key: 'k',
				models: ['beta/one', 'beta/two', 'beta/three', 'beta/four'] },
			gamma: { name: 'Gamma', url: 'https://g/v1/chat/completions', key: 'k',
				models: ['gamma/one', 'gamma/two', 'gamma/three'] },
		},
	}));
	localStorage.removeItem('daimond-model-use');
	DaimondModels.init({});
	for (const [prov, model, times] of u) {
		for (let i = 0; i < times; i++) DaimondModels.noteUse(prov, model);
	}
	// Then push the timestamps APART, oldest for the most-used.
	//
	// Without this the fixture cannot tell the two orderings apart: the loop above
	// runs inside one millisecond, so every entry carries the same `t`, a
	// recency sort is stable, and it happens to return insertion order — which is
	// the order the counts would have given anyway. A break that ranked by recency
	// instead of by use passed against this file until the stamps were separated.
	// The most-used model is now the LEAST recent, so the two orderings disagree
	// and only the right one satisfies the check.
	const raw = JSON.parse(localStorage.getItem('daimond-model-use') || '{}');
	const byCount = Object.keys(raw).sort((a, b) => raw[b].n - raw[a].n);
	byCount.forEach((k, i) => { raw[k].t = 1000 + i * 1000; });
	localStorage.setItem('daimond-model-use', JSON.stringify(raw));
	const sel = document.createElement('select');
	DaimondModels.fillSelect(sel, '', '');
	const groups = Array.from(sel.children).map((g) => ({
		label: g.label || '',
		options: Array.from(g.children).map((o) => ({
			providerName: (g.label || '').split(' (')[0].split(' · ')[0],
			value: o.value, text: o.textContent, title: o.title,
			provider: o.dataset.provider || '', paid: o.dataset.paid || '',
			fav: o.dataset.fav || '', disabled: o.disabled, selected: o.selected,
		})),
	}));
	return { groups, total: sel.querySelectorAll('option').length,
		picked: DaimondModels.pick(sel) };
}, uses);

try {
	await page.waitForFunction(() => !!(window.DaimondModels && DaimondModels.fillSelect),
		null, { timeout: 20000 });
	await page.waitForTimeout(500);

	console.log('with nothing used yet');
	const cold = await build([]);
	check(cold.groups.length > 0 && !/favourite/i.test(cold.groups[0].label),
		'a new account gets no shortlist — there is nothing to shorten',
		JSON.stringify(cold.groups.map((g) => g.label)));

	console.log('once some models have been run');
	const uses = [['beta', 'beta/three', 5], ['alpha', 'alpha/two', 3], ['gamma', 'gamma/one', 1]];
	const warm = await build(uses);
	const first = warm.groups[0];
	check(/favourite|favorit|常用|자주|よく/i.test(first.label),
		'the shortlist is the FIRST group, so it needs no scrolling', first.label);
	check(first.options.map((o) => o.value).join(',') === 'beta/three,alpha/two,gamma/one',
		'ordered by how much each is used, most first — and NOT by recency, which the '
		+ 'fixture deliberately puts in the opposite order',
		first.options.map((o) => `${o.value}(${o.provider})`).join(', '));

	console.log('a shortcut says what the row says');
	const rows = {};
	warm.groups.slice(1).forEach((g) => g.options.forEach((o) => { rows[o.provider + ' ' + o.value] = o; }));
	let mismatched = [];
	for (const f of first.options) {
		const r = rows[f.provider + ' ' + f.value];
		if (!r) { mismatched.push(`${f.value}: no row below`); continue; }
		// The favourite carries the row's text PLUS the provider's name. Not an
		// inconsistency: a row's full meaning includes the group heading above it,
		// and under "Favourites" that heading is gone — so a shortcut that
		// reproduced only the row's own text would lose which provider it is, and
		// two providers offering the same model under the user's own key would
		// draw two identical shortcuts.
		const rowStem = r.text.replace(/\s+★$/, '');
		if (!f.text.startsWith(rowStem)) mismatched.push(`${f.value}: "${f.text}" does not begin with "${rowStem}"`);
		if (!f.text.includes(r.providerName || '') && r.providerName)
			mismatched.push(`${f.value}: does not name its provider`);
		if (r.title !== f.title) mismatched.push(`${f.value}: title differs`);
		if (r.paid !== f.paid)   mismatched.push(`${f.value}: economy marking differs`);
	}
	check(mismatched.length === 0,
		'every favourite is word-for-word the row it stands for, marking included',
		mismatched.join(' | '));
	check(first.options.every((o) => o.fav === '1'),
		'and each is marked as the shortcut rather than a second listing');
	check(first.options.every((o) => /·\s*(Alpha|Beta|Gamma)\b/.test(o.text)),
		'and names its provider, which the group heading no longer does',
		first.options.map((o) => o.text).join(' | '));

	console.log('and it is a shortcut, not a category');
	check(warm.total === cold.total + first.options.length,
		'nothing was MOVED out of its provider — the rows are all still there',
		`cold ${cold.total}, warm ${warm.total}, shortlist ${first.options.length}`);
	check(Object.keys(rows).length === cold.total,
		'so a model is still findable under who bills for it', String(Object.keys(rows).length));

	console.log('what pick() answers');
	check(warm.picked.model === 'alpha/one' && warm.picked.provider === 'alpha',
		'the starred default is still what an unasked pulldown points at',
		JSON.stringify(warm.picked));
	const asked = await page.evaluate(() => {
		const sel = document.createElement('select');
		DaimondModels.fillSelect(sel, 'beta', 'beta/three');
		const p = DaimondModels.pick(sel);
		const o = sel.selectedOptions[0];
		return { pick: p, fromFav: o.dataset.fav === '1' };
	});
	check(asked.pick.provider === 'beta' && asked.pick.model === 'beta/three',
		'asking for a model still selects that model, and pick() names its provider',
		JSON.stringify(asked.pick));
	check(asked.fromFav === true,
		'and the selected one is the shortcut copy, so it shows without scrolling');

	console.log('a shortlist of one is not a shortlist');
	const thin = await build([['beta', 'beta/three', 4]]);
	check(!/favourite|favorit|常用|자주|よく/i.test(thin.groups[0].label),
		'one used model draws no group', thin.groups[0].label);

	console.log('a model whose provider went away');
	const gone = await page.evaluate(() => {
		const store = JSON.parse(localStorage.getItem('daimond-models-v2'));
		delete store.providers.beta;
		localStorage.setItem('daimond-models-v2', JSON.stringify(store));
		DaimondModels.init({});
		const sel = document.createElement('select');
		DaimondModels.fillSelect(sel, '', '');
		return Array.from(sel.querySelectorAll('option')).map((o) => o.value);
	});
	check(!gone.some((v) => v === 'beta/three'),
		'is not still offered from the top of the list', JSON.stringify(gone.slice(0, 4)));

	const errs = errors(s).filter((e) => !/50[23]|Bad Gateway|Failed to load resource/i.test(e));
	check(errs.length === 0, 'no console errors beyond the offline gateway',
		JSON.stringify(errs.slice(0, 2)));
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} failed` : '\nall checks passed');
process.exit(bad ? 1 : 0);

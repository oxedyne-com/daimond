// filestile.test.mjs -- the Files tile a turn leaves is never a label that opens on nothing.
//
//	node --test www/js/filestile.test.mjs
//
// The owner's report: the "Files" tile header appears on gilgamesh and the phone and clicking it
// expands nothing. Two causes sat under it, and one rule answers both: a tile draws from the data
// the device has, is enriched when more arrives, and never offers an expander with nothing in it.
//
//  - The Steps switch (`.hide-tools`, a per-device choice) withheld the body of EVERY tool-type tile,
//    and the Files list wears the tool tile's shell. It is the turn's result, not a step.
//  - The rows were built only after the version store answered, so a device whose store had not got
//    the version (or that never answered) held a tile with no body.
//
// The functions are lifted from daimond.js by a brace-balanced scan (the tailwiring.test.mjs
// technique), so a regression in the source is what reddens this.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src  = fs.readFileSync(path.join(HERE, 'daimond.js'), 'utf8');
const css  = fs.readFileSync(path.join(HERE, '..', 'css', 'app.css'), 'utf8');

function extractFn(name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	assert.ok(start >= 0, 'function not found in daimond.js: ' + name);
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

// A just-enough element: children, a class list, listeners, parents, and the two lookups the code uses.
function makeEl(tag) {
	const el = {
		tagName: tag, className: '', textContent: '', title: '', type: '', hidden: false,
		children: [], parent: null, listeners: {}, attrs: {}, dataset: {},
		classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } },
		appendChild(c) { c.parent = el; el.children.push(c); return c; },
		insertBefore(c, ref) { c.parent = el; const i = el.children.indexOf(ref); el.children.splice(i < 0 ? el.children.length : i, 0, c); return c; },
		replaceChildren(...n) { el.children = []; n.forEach((c) => el.appendChild(c)); },
		addEventListener(t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); },
		setAttribute(k, v) { el.attrs[k] = v; },
		querySelector() { return null; },
		remove() { if (el.parent) { const i = el.parent.children.indexOf(el); if (i >= 0) el.parent.children.splice(i, 1); el.parent = null; } },
		closest(sel) {
			const cls = sel.replace(/^\./, '');
			for (let n = el; n; n = n.parent) if (String(n.className).split(' ').includes(cls)) return n;
			return null;
		},
		async press() { for (const fn of (el.listeners.click || [])) await fn({ stopPropagation() {} }); },
	};
	return el;
}
const walk = (el, f) => { f(el); (el.children || []).forEach((c) => walk(c, f)); };
const all  = (el, cls) => { const out = []; walk(el, (n) => { if (String(n.className).split(' ').includes(cls)) out.push(n); }); return out; };

const NOTE = '[Daimond: this turn changed 2 files (v26): diamonds/d1/lanes/gym.json, diamonds/d1/STATE.md. '
	+ 'The user can restore any of them from History, and file_revert does the same when they ask.]';

// One harness per scenario: `manifests` is what this device's version store answers.
function rig(manifests, opts) {
	opts = opts || {};
	const said = [], events = [], rated = [];
	const win = { DaimondAnswer: { note(host, text, isErr) { said.push({ host, text, isErr }); }, gate(el, why) { el.attrs.gated = why; } } };
	const body = 'var currentDiamond = { id: "d1" };\nvar _noStoreSaid = {};\n'
		+ [ 'var _TAIL_MORE = 6;', ...[ '_parseTailNote', '_tailNoteParts', '_tailNoteNames', '_tailNoteTable', '_filesNoStore',
			'_fillFilesTile', '_filesBox', 'openTurnFile', '_turnFileRow' ].map(extractFn) ].join('\n')
		+ '\nreturn { fill: _fillFilesTile, names: _tailNoteNames, table: _tailNoteTable, row: _turnFileRow };\n';
	const tn = (k, n) => k + ':' + n;
	const t  = (k) => k;
	const DaimondVersions = { manifests: manifests, diff: async () => null, body: async () => null, bodyPath: () => '' };
	const Files = { open: async () => { throw new Error('not here'); }, view: async () => { throw new Error('not here'); } };
	const document = { createElement: makeEl };
	const api = new Function('document', 'tn', 't', 'DaimondVersions', 'Files', 'mountFileRates', 'dsEvent', 'selfDeviceId', 'window', 'DaimondAnswer', 'console', body)(
		document, tn, t, DaimondVersions, Files, (b) => rated.push(b),
		(kind, p) => events.push({ kind, p }), () => 'devAAAA', win, win.DaimondAnswer, { warn() {} });
	const tile = makeEl('div');
	const bodyEl = makeEl('div'); bodyEl.className = 'ctile-body';
	tile.querySelector = () => bodyEl;
	if (opts.attach) opts.attach(bodyEl);
	return { api, tile, bodyEl, said, events, rated };
}
const rowsOf = (bodyEl) => all(bodyEl, 'turn-file-row');
const flush = () => new Promise((r) => setImmediate(r));

test('a device whose version store never answers still draws every file the note names, at once', () => {
	const r = rig(() => new Promise(() => {}));        // a store that never settles
	r.api.fill(r.tile, NOTE, { diamondId: 'd1' }, []);
	// No await: the names are drawn before the store is asked.
	assert.equal(rowsOf(r.bodyEl).length, 2, 'two rows, before any manifest arrives');
	const names = all(r.bodyEl, 'turn-file-name').map((n) => n.title);
	assert.deepEqual(names, ['diamonds/d1/lanes/gym.json', 'diamonds/d1/STATE.md']);
});

test('a viewer without the manifest keeps the names, shows no fake counts, and says so once per version', async () => {
	const r = rig(async () => []);                     // the Diamond has not arrived whole
	r.api.fill(r.tile, NOTE, { diamondId: 'd1' }, []);
	await flush(); await flush();
	const rows = rowsOf(r.bodyEl);
	assert.equal(rows.length, 2);
	for (const row of rows) {
		const de = all(row, 'turn-file-delta')[0];
		assert.equal(de.textContent, '·', 'no manifest: a dot, not a number');
		assert.equal(de.attrs.gated, 'chat.turn_file_nocount', 'the control carries its reason');
	}
	assert.equal(r.events.length, 1, 'one diag event');
	assert.equal(r.events[0].kind, 'files.nostore');
	assert.deepEqual(r.events[0].p, { id: 'd1', v: 26, held: 0, dev: 'devAAAA' });
	// The same version drawn again in one page says nothing more.
	const again = r.api.table(NOTE, { diamondId: 'd1' }, []);
	await again;
	assert.equal(r.events.length, 1, 'still one event');
});

test('a press on a row without counts, or on a file this device lacks, answers in the box', async () => {
	const r = rig(async () => []);
	r.api.fill(r.tile, NOTE, { diamondId: 'd1' }, []);
	await flush(); await flush();
	const row = rowsOf(r.bodyEl)[0];
	await all(row, 'turn-file-delta')[0].press();
	assert.equal(r.said.length, 1);
	assert.equal(r.said[0].text, 'chat.turn_file_nocount');
	assert.equal(r.said[0].isErr, true);
	assert.ok(String(r.said[0].host.className).includes('turn-files'), 'said in the Files box');
	await all(row, 'turn-file-name')[0].press();       // no live file, no hash: cannot open
	await flush();
	assert.equal(r.said[r.said.length - 1].text, 'chat.turn_file_nofile');
});

test('a viewer that holds the manifest gets the counts and no event; a pruned version is no fault', async () => {
	const held = [{ version: 26, files: [
		{ path: 'diamonds/d1/lanes/gym.json', hash: 'H1', was: 'H0', gone: false },
		{ path: 'diamonds/d1/STATE.md', hash: 'H2', gone: false } ] }];
	const r = rig(async () => held);
	r.api.fill(r.tile, NOTE, { diamondId: 'd1' }, []);
	await flush(); await flush();
	assert.equal(r.events.length, 0, 'held: nothing to report');
	const de = all(rowsOf(r.bodyEl)[0], 'turn-file-delta')[0];
	assert.equal(de.attrs.gated, undefined, 'a row with its manifest is a live control');
	const pruned = rig(async () => [{ version: 40, files: [] }]);
	pruned.api.fill(pruned.tile, NOTE, { diamondId: 'd1' }, []);
	await flush(); await flush();
	assert.equal(pruned.events.length, 0, 'newer versions held: this one was pruned, not missing');
	assert.equal(rowsOf(pruned.bodyEl).length, 2, 'and the names are still drawn');
});

test('a note that does not parse is shown as its own words, never as an empty body', () => {
	const r = rig(async () => []);
	r.api.fill(r.tile, '[Daimond: this turn changed some files in a new wording]', null, []);
	assert.equal(r.bodyEl.textContent, '[Daimond: this turn changed some files in a new wording]');
});

test('the Steps switch withholds steps, not the Files result: every hide-tools rule excludes .ctile-result', () => {
	const rules = css.split('\n').filter((l) => /\.hide-tools \.ctile\[data-t="tool"\]/.test(l));
	assert.ok(rules.length >= 6, 'the switch rules are found');
	for (const l of rules) assert.ok(l.includes(':not(.ctile-result)'), 'unexcluded: ' + l.trim());
});

test('both Files tile builders mark the tile a result', () => {
	const tail = extractFn('appendUserMessage');
	assert.match(tail.slice(0, tail.indexOf('var div = buildTile')), /buildTile\('tool', \{[^}]*result: true/);
	assert.match(extractFn('appendFilesLog'), /buildTile\('tool', \{[^}]*result: true/);
	assert.match(extractFn('buildTile'), /opts\.result \? ' ctile-result'/);
});

// #8: a turn that wrote more files than the note names (it names six, then "and N more") draws EVERY
// file, with its count, from the structured list the turn row carries -- never from the note's words.
const NINE = Array.from({ length: 9 }, (_, i) => 'diamonds/d1/f' + i + '.md');
const NOTE9 = '[Daimond: this turn changed 9 files (v31): ' + NINE.slice(0, 6).join(', ') + ' and 3 more. '
	+ 'The user can restore any of them from History, and file_revert does the same when they ask.]';
const shownCounts = (bodyEl) => rowsOf(bodyEl).map((row) => {
	const de = all(row, 'turn-file-delta')[0];
	return all(de, 'tf-add').map((n) => n.textContent).concat(all(de, 'tf-del').map((n) => n.textContent)).join(' ');
});

test('a turn that wrote 9 files shows all 9, with counts, from the row alone (#8)', async () => {
	const files = NINE.map((p, i) => ({ path: p, hash: 'H' + i, add: i + 1, del: i }));
	const r = rig(() => new Promise(() => {}));        // no version store on this device
	r.api.fill(r.tile, NOTE9, { diamondId: 'd1' }, [], files);
	const more = all(r.bodyEl, 'turn-file-more')[0];
	assert.ok(more, 'six rows, then a fold');
	await more.press();
	const names = all(r.bodyEl, 'turn-file-name').map((n) => n.title);
	assert.deepEqual(names, NINE, 'every file the turn wrote, in the manifest order');
	assert.deepEqual(shownCounts(r.bodyEl), NINE.map((_, i) => '+' + (i + 1) + ' −' + i), 'each with its +N −M');
});

test('a row from before the structured list draws all 9 from the manifest when the store holds it (#8)', async () => {
	const held = [{ version: 31, files: NINE.map((p, i) => ({ path: p, hash: 'H' + i, gone: false })) }];
	const r = rig(async () => held);
	r.api.fill(r.tile, NOTE9, { diamondId: 'd1' }, []);
	await flush(); await flush();
	const more = all(r.bodyEl, 'turn-file-more')[0];
	if (more) await more.press();
	assert.deepEqual(all(r.bodyEl, 'turn-file-name').map((n) => n.title), NINE);
});

test('the turn end writes the structured list: every manifest entry, counted, credited or not (#8)', async () => {
	const mv = { version: 31, files: NINE.map((p, i) => ({ path: p, hash: i === 8 ? '' : 'H' + i, was: i ? 'W' + i : '',
		gone: i === 8, by: i % 2 ? { role: 'daimon' } : undefined })) };
	const DaimondVersions = { manifests: async () => [mv],
		diff: async (s, was, now) => ({ add: Number(now.slice(1)) + 1, del: was ? 1 : 0 }) };
	const list = await new Function('window', 'DaimondVersions', extractFn('turnFileList') + '\nreturn turnFileList;')(
		{ DaimondVersions }, DaimondVersions)('d1', 31);
	assert.equal(list.length, 9, 'all nine, not only the credited');
	assert.deepEqual(list[0], { path: NINE[0], hash: 'H0', add: 1, del: 0 });
	assert.deepEqual(list[8], { path: NINE[8], hash: '', gone: true });
});

test('an old row whose other names this device cannot know shows their count as text, never a fold that unfolds nothing (#8)', async () => {
	const r = rig(async () => []);                     // no structured list, no manifest held
	r.api.fill(r.tile, NOTE9, { diamondId: 'd1' }, []);
	await flush(); await flush();
	assert.equal(rowsOf(r.bodyEl).length, 6, 'the six names the note carries');
	assert.equal(all(r.bodyEl, 'turn-file-more').length, 0, 'no button: there is nothing behind it');
	const rest = all(r.bodyEl, 'turn-file-rest');
	assert.equal(rest.length, 1, 'the count is said once');
	assert.notEqual(rest[0].tagName, 'button');
	assert.equal(rest[0].textContent, 'chat.turn_files_rest:3');
});

test('names held but folded keep the button, and the unknown rest stays text after it unfolds (#8)', async () => {
	// Seven names known (a fold of one) and two the note only counts.
	const seven = NINE.slice(0, 7);
	const note = '[Daimond: this turn changed 9 files (v31): ' + seven.join(', ') + ' and 2 more. '
		+ 'The user can restore any of them from History, and file_revert does the same when they ask.]';
	const r = rig(async () => []);
	r.api.fill(r.tile, note, { diamondId: 'd1' }, []);
	await flush(); await flush();
	const more = all(r.bodyEl, 'turn-file-more');
	assert.equal(more.length, 1, 'one name is behind the fold');
	await more[0].press();
	assert.equal(rowsOf(r.bodyEl).length, 7);
	assert.equal(all(r.bodyEl, 'turn-file-more').length, 0);
	assert.equal(all(r.bodyEl, 'turn-file-rest').map((n) => n.textContent).join(), 'chat.turn_files_rest:2');
});

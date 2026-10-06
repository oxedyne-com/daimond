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
		remove() {},
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

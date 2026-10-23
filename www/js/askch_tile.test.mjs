// ASKCH-F (QA PORT-G half B, F1): the runner's change ask, raised on the tab, shows the path and
// the act and the change, from its own kind `change`.  Red at 556a954c0: the ask came as a
// `consent` ask with no tool or host, and the tile read "An agent wants to reach " with no path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../..', import.meta.url).pathname;
let table = {};
const ctx = { window: { DaimondI18n: { register: (_c, tb) => { table = tb; } } } };
ctx.DaimondI18n = ctx.window.DaimondI18n;
vm.runInNewContext(readFileSync(root + 'www/i18n/en.js', 'utf8'), ctx);
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => (v && k in v) ? v[k] : '{' + k + '}');
const t = (k, v) => fill(table[k] ?? k, v);
const tOr = (k, d, v) => fill(table[k] ?? d, v);
const src = readFileSync(root + 'www/js/daimond.js', 'utf8');
const fn = (name) => {
	const at = src.indexOf('function ' + name + '(');
	assert.ok(at >= 0, name + ' is in daimond.js');
	return src.slice(at, src.indexOf('\n\t}\n', at) + 3);
};
const sandbox = { t, tOr, String, JSON, Array };
vm.runInNewContext(fn('changeTileText') + '\n' + fn('consentTileText') + '\nthis.consentTileText = consentTileText;', sandbox);
const consentTileText = sandbox.consentTileText;

// The ask as kimberlite/src/errands/consent.rs ask_js and run_ui::change_detail build it.
const raise = (detail, kind = 'change') => {
	const ask = { kind, tool: '', host: '', detail };
	return consentTileText(String(ask.tool || ''), String(ask.host || ''), String(ask.detail || ''),
		String(ask.kind || ''));
};
const ASK = (act, rows, more = 0) => JSON.stringify({ ask: 'change', digest: 'sha256:ab', keeper: 'dia-1',
	path: 'notes/biography.md', turn: 't1', act, to: '', add: 1, del: 1, more, text: true, wait: 600000, rows });

test('askchf: a delete ask names the path and the act, never a web reach', () => {
	const txt = raise(ASK('delete', []));
	const all = txt.head + '\n' + txt.body;
	assert.ok(all.includes('notes/biography.md'), 'the path is shown: ' + all);
	assert.ok(/delete/i.test(txt.head), 'the act is shown: ' + txt.head);
	assert.ok(!/reach/i.test(all), 'not the web-reach question: ' + all);
});

test('askchf: a write ask shows its diff rows and the count not shown', () => {
	const rows = [{ k: '~', n: 4 }, { k: ' ', t: 'kept' }, { k: '-', t: 'old line' }, { k: '+', t: 'new line' }];
	const txt = raise(ASK('change', rows, 7));
	assert.ok(txt.head.includes('change "notes/biography.md"'), txt.head);
	assert.ok(txt.body.includes('- old line') && txt.body.includes('+ new line'), txt.body);
	assert.ok(txt.body.includes('4 unchanged'), txt.body);
	assert.ok(txt.body.includes('7 more'), 'the rows not shown are counted: ' + txt.body);
});

test('askchf: a consent ask still draws the web question', () => {
	const txt = consentTileText('web_click', 'example.com', '', 'consent');
	assert.ok(txt.head.includes('example.com'), txt.head);
});

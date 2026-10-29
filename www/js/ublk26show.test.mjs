// UNBLOCK-26 remainder (his ruling 26 Oct, "Change it, show it, Undo"): a runner turn changes a
// file of his without asking, having kept it first (METER-KEEP), so the turn must show a clear
// "Changed your file <name>" with the change as his ask's diff, and the turn's away Undo.  The
// runner marks which rows were his (`his`, with `change`, kimberlite settle.rs `turn_rec`); the
// page never guesses.  Red at 03c79323238b: the carried Files row named both files alike and no
// line said his file was changed.
import { readPage } from '../../dev/pagesrc.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../..', import.meta.url).pathname;
const DAIMOND = readPage(root + 'www/js/daimond.js', 'utf8');
let table = {};
const ictx = { window: { DaimondI18n: { register: (_c, tb) => { table = tb; } } } };
ictx.DaimondI18n = ictx.window.DaimondI18n;
vm.runInNewContext(readPage(root + 'www/i18n/en.js', 'utf8'), ictx);
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => (v && k in v) ? v[k] : '{' + k + '}');
const t = (k, v) => fill(table[k] ?? k, v);
const tn = (k, n, v) => t(k + '.' + (n === 1 ? 'one' : 'other'), v);
const tOr = (k, d, v) => fill(table[k] ?? d, v);

function lift(name) {
	let a = DAIMOND.indexOf('\n\tfunction ' + name + '(');
	if (a < 0) a = DAIMOND.indexOf('\n\tasync function ' + name + '(');
	assert.ok(a >= 0, 'daimond.js holds ' + name);
	const b = DAIMOND.indexOf('\n\t}\n', a);
	return DAIMOND.slice(a + 1, b + 3);
}

// A carried turn that changed his biography (kept first, so `his`) and made the OCR document.
const CHANGE = { text: true, add: 1, del: 1, more: 0,
	rows: [{ k: '~', n: 12 }, { k: ' ', t: 'Born 1931.' }, { k: '-', t: 'He wrote two books.' }, { k: '+', t: 'He wrote three books.' }] };
const REC = { keeper: 'D1', run: 'e-R1', turnId: 'u1', on: 'RUN', onName: 'argonaut', ts: 42, since: 1700, until: 9e15,
	files: [
		{ path: '/w/bio/biography_ReitHoogland.typ', hash: 'h1', created: false, add: 1, del: 1, his: true, change: CHANGE },
		{ path: '/w/ocr/letters.typ', hash: 'h2', created: true, add: 40, del: 0 },
		{ path: '/w/media/out.mp3', hash: 'h3', created: false },
		{ path: '/w/media/big.wav', hash: 'h4', created: false, unsure: true },
	] };

test('A: the carried turn\'s row names his changed file, with its change and the turn\'s away', async () => {
	const NOTE = { role: 'user', content: '[Daimond: this turn changed 2 files (v3): /w/bio/biography_ReitHoogland.typ, /w/ocr/letters.typ.]' };
	const chat = { id: 'c1', diamondId: 'D1', messages: [{ mid: 'u1', role: 'user', content: 'make the OCR document', ts: 10 },
		{ mid: 'e-R1-end', role: 'end_log', content: '', ts: 45, iturn: 'u1' }] };
	const env = {
		DaimondVersions: {
			manifests: async () => [{ version: 3, ts: 33, files: [
				{ path: '/w/bio/biography_ReitHoogland.typ', hash: 'h1', by: { role: 'm-1' } },
				{ path: '/w/ocr/letters.typ', hash: 'h2', by: { role: 'm-1' } }] }],
			diff: async () => null,
		},
		DaimondProvenance: { h: { file: (s, v, p) => 'v1:file:' + s + ':' + v + ':' + p } },
	};
	const f = new Function('window', 'DaimondVersions', 'DaimondProvenance', [
		'function stampProd(p) { return p; } function selfDeviceId() { return "ASK"; }',
		'function carriedProdBase() { return null; }',
		lift('turnFileProds'), lift('turnFileList'), lift('carriedFilesRow'), 'return carriedFilesRow;'].join('\n'))(
		env, env.DaimondVersions, env.DaimondProvenance);
	const row = await f(chat, REC, { version: 3, note: NOTE });
	assert.ok(row && row.mid === 'e-R1-files', JSON.stringify(row));
	assert.deepEqual(row.yours, [{ path: '/w/bio/biography_ReitHoogland.typ', add: 1, del: 1, change: CHANGE },
		{ path: '/w/media/big.wav', unsure: true }],
		'his file, from the runner\'s mark, with its change; one it could not judge, never as his; never the Diamond\'s own');
	assert.deepEqual(row.away, { keeper: 'D1', on: 'RUN', onName: 'argonaut', run: 'e-R1', since: 1700, until: 9e15 });
});

/// Just enough DOM to draw a tile and read it back.
function el(tag) {
	return { tag, className: '', textContent: '', children: [], listeners: {},
		appendChild(c) { this.children.push(c); return c; },
		addEventListener(k, f) { this.listeners[k] = f; } };
}
function all(e) { return [e].concat(...e.children.map(all)); }

function draw(m) {
	const posted = [], undos = [];
	const f = new Function('document', 't', 'tn', 'tOr', 'buildTile', 'tilePeek', 'postToChat', 'pinBottom',
		'histAwayUndo', '_turnUndoRows', [lift('changeName'), lift('changeDiff'), lift('appendYoursTile'),
			'return appendYoursTile;'].join('\n'))(
		{ createElement: el }, t, tn, tOr,
		(kind, o) => { const d = el('div'); d.kind = kind; d.o = o; d._body = el('div'); d.children.push(d._body); return d; },
		() => {}, (d) => posted.push(d), () => {},
		(id, r, rows) => { undos.push({ id, r, rows }); const b = el('div'); b.className = 'hist-away'; return b; },
		'TURN-ROWS');
	const tile = f(m);
	return { tile, posted, undos, nodes: tile ? all(tile) : [] };
}

test('B: "Changed your file <name>", his ask\'s diff, and the turn\'s own away Undo', () => {
	const away = { keeper: 'D1', on: 'RUN', onName: 'argonaut', run: 'e-R1', since: 1700, until: 9e15 };
	const { posted, undos, nodes } = draw({ role: 'user', mid: 'e-R1-files', ts: 44,
		yours: [{ path: '/w/bio/biography_ReitHoogland.typ', add: 1, del: 1, change: CHANGE }], away });
	assert.equal(posted.length, 1, 'one tile in the turn');
	const head = nodes.filter((n) => /turn-yours-head/.test(n.className)).map((n) => n.textContent);
	assert.deepEqual(head, ['Changed your file biography_ReitHoogland.typ']);
	const lines = nodes.filter((n) => /hist-diff-line/.test(n.className));
	assert.deepEqual(lines.map((n) => n.className + '|' + n.textContent), [
		'hist-diff-line fold|12 unchanged lines', 'hist-diff-line| Born 1931.'.replace('| ', '|'),
		'hist-diff-line del|He wrote two books.', 'hist-diff-line add|He wrote three books.']);
	assert.equal(undos.length, 1, 'one Undo: the runner turn\'s own');
	assert.deepEqual(undos[0], { id: 'D1', r: { away, cause: 'turn' }, rows: 'TURN-ROWS' });
	assert.ok(nodes.some((n) => n.className === 'hist-away'), 'drawn in the tile');
});

test('B2: a change the record could not carry still says the file and its count', () => {
	const { nodes } = draw({ yours: [{ path: '/w/a.md', add: 2, del: 3 }], away: { keeper: 'D1', on: 'RUN', run: 'e-R2', since: 1 } });
	assert.ok(nodes.some((n) => n.textContent === 'Changed your file a.md'));
	assert.ok(nodes.some((n) => n.textContent === '5 more changed lines not shown'), nodes.map((n) => n.textContent).join('|'));
});

test('B4: a file whose authorship the runner could not judge says "Changed <name>", never "your file"', () => {
	const { nodes } = draw({ yours: [{ path: '/w/media/big.wav', unsure: true }, { path: '/w/a.md', add: 1, del: 0 }],
		away: { keeper: 'D1', on: 'RUN', run: 'e-R3', since: 1 } });
	const head = nodes.filter((n) => /turn-yours-head/.test(n.className)).map((n) => n.textContent);
	assert.deepEqual(head, ['Changed big.wav', 'Changed your file a.md']);
});

test('B3: a row with no file of his draws nothing', () => {
	assert.equal(draw({ role: 'user', content: 'x' }).tile, null);
});

test('C: wiring: a history row with `yours` draws the tile; the ask and the turn share one diff drawing', () => {
	assert.match(lift('drawHistoryMessage'), /if \(m\.yours\) appendYoursTile\(m\);/);
	assert.match(lift('changeTile'), /changeDiff\(box, c\);/);
	assert.match(lift('undoneFromRunner'), /_turnUndoRows/);
	for (const loc of ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans']) {
		const s = readPage(root + 'www/i18n/' + loc + '.js', 'utf8');
		assert.match(s, /'change\.yours':/, loc + ' has change.yours');
		assert.match(s, /'change\.file':/, loc + ' has change.file');
	}
});

// UNBLOCK-83 U83-TIDY (D-20261101-48, his "ok to Fred tidy up"): the chat ends with the answer
// and one collapsed Files line; the 7 Oct leftovers sit back in October as one quiet line each.
// provenance: owner Fred Hoogland, diamond 1a05794cb284 chat cmth5oiix-9-0cdza
// (dev/fixtures/runhere/his_chat_cmth5oiix.txt), and the B-roll turn's Files row as he saw it on
// 1 Nov: broll_sources.md made (166 lines) and STATE.md, kept on argonaut, beside it.
//   A  a 7 Oct turn's `not_run` end folded tonight goes under that turn, not below the newer turn;
//      two leftovers are two rows; the same end twice is one.
//   B  the turn's changed files are ONE Files tile, folded, its peek the quiet lines, no diff drawn.
// Red at 51f30d49459a (MM_SRC_REV=51f30d49459a node --test www/js/u83tidy.test.mjs), green on head.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { source, liftFn } from './testlift.mjs';
import { readPage } from '../../dev/pagesrc.mjs';

const root = new URL('../..', import.meta.url).pathname;
const SRC = source('daimond.js');
const need = (n) => { const f = liftFn(SRC, n); assert.ok(f, 'the page holds ' + n); return f; };

const his = JSON.parse(readFileSync(root + 'dev/fixtures/runhere/his_chat_cmth5oiix.txt', 'utf8')
	.split('\n').filter((l) => !/^(#|provenance:)/.test(l)).join('\n'));
const OCT7 = 'muxkksma-j-f1400', LATER = 'mvxm98ag-2-hg7fg';

// page/turnlog.js is a module of its own with no imports: read at the rev, its `export`s dropped.
function drawEnd() {
	const tl = source('page/turnlog.js').replace(/^export /gm, '');
	return new Function(tl + '\nreturn drawEnd;')();
}
const deps = { isTile: (m, t) => m.why === 'dispatched' && String(m.iturn) === String(t), join: (a, b) => Object.assign({}, a, b) };

test('A: a 7 Oct turn\'s end, folded tonight, sits in October, one quiet row a turn', () => {
	const de = drawEnd();
	const chat = JSON.parse(JSON.stringify(his));
	de(chat, { turn: OCT7, end: { status: 'not_run', tried: ['argonaut'] } }, deps);
	de(chat, { turn: 'u2', end: { status: 'not_run' } }, deps);
	const ids = chat.messages.map((m) => m.mid);
	const later = ids.indexOf(LATER);
	assert.ok(later > 0, 'the later turn is there');
	assert.ok(ids.indexOf(OCT7 + '-nr') >= 0 && ids.indexOf(OCT7 + '-nr') < later, 'the 7 Oct row is before the later turn: ' + ids.join());
	assert.ok(ids.indexOf('u2-nr') > ids.indexOf('a2') && ids.indexOf('u2-nr') < later, 'the second row is under its turn: ' + ids.join());
	assert.equal(ids.filter((x) => /-nr$/.test(x)).length, 2, 'two leftovers, two rows');
	de(chat, { turn: OCT7, end: { status: 'not_run' } }, deps);
	assert.equal(chat.messages.filter((m) => m.mid === OCT7 + '-nr').length, 1, 'the same end twice is one row');
	assert.equal(chat.messages[chat.messages.length - 1].mid, his.messages[his.messages.length - 1].mid, 'the chat still ends with its last turn');
});

// ── B: just enough DOM to draw the tiles and read them back. ──
let table = {};
const ictx = { window: { DaimondI18n: { register: (_c, tb) => { table = tb; } } } };
vm.runInNewContext(readPage(root + 'www/i18n/en.js', 'utf8'), ictx);
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => (v && k in v) ? v[k] : '{' + k + '}');
const t = (k, v) => fill(table[k] ?? k, v);
const tn = (k, n, v) => t(k + '.' + (n === 1 ? 'one' : 'other'), v);
const tOr = (k, d, v) => fill(table[k] ?? d, v);
function el(tag) {
	const e = { tag, className: '', textContent: '', children: [], listeners: {}, dataset: {},
		appendChild(c) { this.children.push(c); return c; },
		addEventListener(k, f) { this.listeners[k] = f; },
		after() {} };
	e.classList = { add: (c) => { if (!e.className.split(' ').includes(c)) e.className += ' ' + c; },
		contains: (c) => e.className.split(' ').includes(c) };
	return e;
}
const all = (e) => [e].concat(...e.children.map(all));

test('B: the turn\'s changed files are one folded Files tile, and its peek says the files quietly', () => {
	const posted = [];
	const buildTile = (kind, o) => {
		const d = el('div'); d.className = 'ctile' + (o.expanded ? '' : ' collapsed'); d.dataset.t = kind; d.o = o;
		d._body = el('div'); d.children.push(d._body); return d;
	};
	const tilePeek = (d, s) => { d.peek = s; };
	const post = (d) => posted.push(d);
	// The turn's own Files table, as appendFilesLog draws it from the row's records.
	const appendFilesLog = (m) => {
		const d = buildTile('tool', { who: 'Files', expanded: true, result: true, ts: m.ts });
		d._body.appendChild(el('div')); tilePeek(d, '2 files changed'); post(d); return d;
	};
	const names = ['document', 't', 'tn', 'tOr', 'buildTile', 'tilePeek', 'postToChat', 'pinBottom', 'histAwayUndo',
		'_turnUndoRows', 'appendFilesLog'];
	const draw = new Function(...names, [need('changeName'), need('changeDiff'), need('_yoursKey'), need('appendYoursTile'),
		'return function (m) { var ft = appendFilesLog(m); if (m.yours) appendYoursTile(m, ft); };'].join('\n'));
	const f = draw({ createElement: el }, t, tn, tOr, buildTile, tilePeek, post, () => {},
		() => { const b = el('div'); b.className = 'hist-away'; return b; }, 'ROWS', appendFilesLog);
	f({ role: 'files_log', mid: 'e-0492a1-files', ts: 1793000000600,
		away: { keeper: '1a05794cb284', on: 'RUN', onName: 'argonaut', run: 'e-0492a1', since: 1, until: 9e15 },
		yours: [
			{ path: '/w/fred/broll_sources.md', created: true, add: 166, del: 0,
				change: { text: true, rows: [{ k: '+', t: '# B-roll sources' }], more: 165 } },
			{ path: '/w/fred/STATE.md', created: true, change: { text: false } },
		] });
	assert.equal(posted.length, 1, 'one Files tile, not two');
	const tile = posted[0];
	assert.ok(tile.classList.contains('collapsed'), 'folded: ' + tile.className);
	assert.equal(tile.peek, 'Created broll_sources.md (166 lines) · STATE.md kept on argonaut');
	const nodes = all(tile);
	assert.equal(nodes.filter((n) => /hist-diff-line/.test(n.className)).length, 0, 'no diff drawn until pressed');
	assert.ok(!nodes.some((n) => n.textContent === t('versions.cannot_compare')), 'no "Cannot compare" for a file kept elsewhere');
	assert.ok(nodes.some((n) => n.className === 'hist-away'), 'the turn\'s Undo is still there');
	// The page's own wiring, read from drawHistoryMessage, must be the line the stand-in runs.
	assert.match(need('drawHistoryMessage'), /var ft = appendFilesLog\(m\); if \(m\.yours\) appendYoursTile\(m, ft\);/,
		'a files_log row hands its Files tile to the runner turn\'s lines');
});

// turnactions.test.mjs -- each tool call of a turn is one line: verb, what it touched, what it
// came to (lines or exit code) and how long it took, opening to its output (K1, D-20261107-01).
//
//	node --test www/js/turnactions.test.mjs
//
// The tile code (`renderToolCall`, `renderToolResult`, `markOutcome`, `buildTile` and the line's
// helpers) is lifted from the REAL page (www/js/page/turns.js, read through dev/pagesrc.mjs) and
// run over a stand-in DOM; a Kimberlite row reaches it through the REAL `viewMessages`. The engine's two
// readers are stood in for by `Wasm`: what they derive is held in Rust by
// `test_a_call_head_names_the_tool_its_key_and_its_lines` and
// `test_the_exit_code_is_read_from_outside_the_envelope`.
import { readPage } from '../../dev/pagesrc.mjs';
import { viewMessages } from './page/turnlog.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP  = readPage(process.env.DAIMOND_JS || join(HERE, 'daimond.js'), 'utf8');
// The real English table, so a label is the one the person reads.
let EN = {};
vm.runInNewContext(readFileSync(join(HERE, '..', 'i18n', 'en.js'), 'utf8'),
	{ window: { DaimondI18n: { register: (_c, tb) => { EN = tb; } } }, DaimondI18n: { register: (_c, tb) => { EN = tb; } } });

function extractFn(src, name) {
	const m = new RegExp('\\n\\t+(?:async )?function ' + name + '\\(').exec(src);
	if (!m) return '';
	const start = m.index + 1;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}

// A stand-in element: enough of the DOM for a tile to be built, labelled and opened.
class El {
	constructor(tag) {
		this.tagName = tag; this.className = ''; this.dataset = {}; this.style = {};
		this.childNodes = []; this.parentNode = null; this._text = ''; this._on = {}; this.attrs = {};
		const self = this;
		this.classList = {
			add: (...cs) => cs.forEach((c) => { if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); }),
			remove: (...cs) => cs.forEach((c) => { self.className = self.className.split(' ').filter((x) => x && x !== c).join(' '); }),
			toggle: (c, on) => { const want = on === undefined ? !self.classList.contains(c) : !!on; want ? self.classList.add(c) : self.classList.remove(c); return want; },
			contains: (c) => self.className.split(' ').includes(c),
		};
	}
	get textContent() { return this._text + this.childNodes.map((n) => n.textContent).join(''); }
	set textContent(v) { this._text = String(v); this.childNodes = []; }
	set innerHTML(v) {
		this.childNodes = []; this._text = '';
		const m = /^<div class="([\w-]+)"><\/div>$/.exec(String(v));
		if (m) { const d = new El('div'); d.className = m[1]; this.appendChild(d); }
	}
	get innerText() { return this.textContent; }
	setAttribute(k, v) { this.attrs[k] = String(v); }
	insertBefore(n, ref) {
		if (n.parentNode) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1);
		const at = ref ? this.childNodes.indexOf(ref) : -1;
		if (at < 0) this.childNodes.push(n); else this.childNodes.splice(at, 0, n);
		n.parentNode = this;
		return n;
	}
	appendChild(n) { return this.insertBefore(n, null); }
	addEventListener(ev, fn) { this._on[ev] = fn; }
	click() { this._on.click({ target: { closest: () => null } }); }
	walk(f) { for (const c of this.childNodes) { if (f(c)) return c; const r = c.walk(f); if (r) return r; } return null; }
	querySelector(sel) { const c = sel.replace(/^\./, ''); return this.walk((n) => n.classList.contains(c)); }
	querySelectorAll(sel) { const out = [], c = sel.replace(/^\./, ''); this.walk((n) => { if (n.classList.contains(c)) out.push(n); return false; }); return out; }
}

const HEADS = {
	'Edit':  { tool: 'file_edit', key: 'src/tools.rs', plus: 12, minus: 3 },
	'run':   null,
};
function world() {
	const names = ['buildTile', 'tilePeek', 'renderToolCall', 'renderToolResult', 'markOutcome',
		'callHead', 'callSpan', 'exitCodeOf', 'cutLine', 'resultCut', 'callSub'];
	const body = names.map((n) => extractFn(APP, n)).join('\n');
	const W = { posted: [] };
	W.api = new Function('W', 'El', 'HEADS', 'EN', `
		var document = { createElement: function (t) { return new El(t); } };
		var window = { getSelection: function () { return null; }, DaimondTime: {
			// The page zone stood in by UTC: the clock the line reads, as the app's own formatter gives it.
			fmtLocal: function (ts, shape) {
				var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
				return shape === 'hm' ? p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) : '';
			} } };
		var chatOutput = new El('div');
		var lastToolBlock = null, _saidJust = false, _askJust = false, _askCard = null;
		var TILE_DIR = { tool: 'local' }, COPY_SVG = '', TICK_SVG = '';
		var DaimondI18n = { locale: function () { return 'en'; } };
		var Wasm = {
			call_head: function (name, args) {
				var h = HEADS[name];
				if (!h) {
					var a = JSON.parse(args);
					h = { tool: 'run', key: a.argv.join(' '), plus: null, minus: null };
				}
				return JSON.stringify(h);
			},
			exit_code_of: function (r) { var m = /\\n\\[exit code: (-?\\d+)\\]/.exec(r); return m ? +m[1] : undefined; },
		};
		function t(k) { return k; }
		function tOr(k, fb, vars) {
			return String(EN[k] != null ? EN[k] : fb).replace(/\\{(\\w+)\\}/g, function (w, x) { return vars && vars[x] != null ? String(vars[x]) : w; });
		}
		function tileWho(type) { return type; }
		function tileTimeEl(ts) { var e = new El('span'); e.className = 'ctile-time'; e.textContent = '12:00'; return e; }
		function renderSaid() { return false; }
		function renderAsk() { return false; }
		function demoteToWorking() {}
		function tagTurn() {}
		function postToChat(b) { W.posted.push(b); }
		function pinBottom() {}
		function copyToClipboard() { return Promise.resolve(); }
		function toggleSelLeaf() {}
		function setTurnOpen() {}
		function isTurnOpen() { return false; }
		function friendlyError(s) { return s; }
		function stripAnsi(s) { return s; }
		function noNetLine() {}
		function ranWithoutNet() { return false; }
		function askClose() {}
		${body}
		return { call: renderToolCall, result: renderToolResult };
	`)(W, El, HEADS, EN);
	return W;
}

// The line a tile shows, as its label's parts in order, empty ones left out.
function line(tile) {
	const lbl = tile.querySelector('.ctile-lbl');
	return lbl.childNodes
		.filter((n) => /ctile-(who|peek|meta|dur)/.test(n.className))
		.map((n) => [n.className.replace(/^ctile-/, ''), n.textContent])
		.filter(([, v]) => v !== '');
}

const T0 = 1_000_000;
function turn() {
	const W = world();
	W.api.call('Edit', JSON.stringify({ path: 'src/tools.rs', old_string: 'a', new_string: 'b' }), 'c1', T0);
	W.api.result('Edit', 'Edited src/tools.rs', 'done', '', { ts: T0, done: T0 + 100 });
	W.api.call('run', JSON.stringify({ argv: ['cargo', 'test', '-p', 'daimond', 'abspaths'] }), 'c2', T0 + 200);
	W.api.result('run', 'test result: ok. 3 passed\n[exit code: 0]', 'done', '', { ts: T0 + 200, done: T0 + 41_200 });
	W.api.call('run', JSON.stringify({ argv: ['cargo', 'build'] }), 'c3', T0 + 50_000);
	// A Kimberlite row whose text was cut before the code: the row's own `exit` is the word.
	W.api.result('run', 'error[E0425]: cannot find value', 'done', '', { ts: T0 + 50_000, done: T0 + 50_400, exit: 101 });
	return W;
}

test('an edit reads: Edit, its path, its lines, its time', () => {
	const [edit] = turn().posted;
	assert.deepEqual(line(edit), [['who', 'Edit'], ['peek', 'src/tools.rs'], ['meta', '+12 −3'], ['dur', '0.1 s']]);
});

test('a passing command reads: Run, its words, exit 0, its time', () => {
	const run = turn().posted[1];
	assert.deepEqual(line(run), [['who', 'Run'], ['peek', 'cargo test -p daimond abspaths'], ['meta', 'exit 0'], ['dur', '41 s']]);
	assert.ok(!run.classList.contains('failed'));
});

test('a failing command says its exit code in the line, and is drawn failed', () => {
	const run = turn().posted[2];
	assert.deepEqual(line(run), [['who', 'Run'], ['peek', 'cargo build'], ['meta', 'exit 101'], ['dur', '0.4 s']]);
	assert.ok(run.classList.contains('failed'));
});

test('each line opens to its arguments and output', () => {
	const run = turn().posted[1];
	assert.ok(run.classList.contains('collapsed'), 'a line is folded until pressed');
	run.querySelector('.ctile-lbl').click();
	assert.ok(!run.classList.contains('collapsed'));
	assert.match(run.querySelector('.tool-args').textContent, /abspaths/);
	assert.match(run.querySelector('.tool-result').textContent, /3 passed/);
});

test('a call over a minute reads in minutes and seconds', () => {
	const W = world();
	W.api.call('run', JSON.stringify({ argv: ['make'] }), 'c1', T0);
	W.api.result('run', 'ok\n[exit code: 0]', 'done', '', { ts: T0, done: T0 + 125_000 });
	assert.deepEqual(line(W.posted[0]).pop(), ['dur', '2 min 5 s']);
});

// A Kimberlite tool row as the chat log's view folds it: the message's own fields ride in `meta`,
// and the row's `at` (the log's clock) becomes the message's `ts`.
function logged(meta, text) {
	const view = { turn: 't9', state: 'ended', rows: [{ mid: 'r-t3', role: 'tool_log', text: text, seq: 4,
		at: T0 + 5_000, member: 'm1', meta: Object.assign({ name: 'run', args: JSON.stringify({ argv: ['cargo', 'build'] }) }, meta) }] };
	return viewMessages(view)[0];
}
function drawn(m) {
	const W = world();
	W.api.call(m.name, m.args, m.callId || 'c1', m.ts);
	W.api.result(m.name, m.content, 'done', '', m);
	return W.posted[0];
}

test('a Kimberlite row carries its exit code and time on the log clock', () => {
	const m = logged({ ts: T0, exit: 101, done: T0 + 400, outcome: 'done' }, 'error[E0425]: cannot find value');
	assert.deepEqual([m.ts, m.done, m.exit], [T0 + 5_000, T0 + 5_400, 101]);
	const run = drawn(m);
	assert.deepEqual(line(run), [['who', 'Run'], ['peek', 'cargo build'], ['meta', 'exit 101'], ['dur', '0.4 s']]);
	assert.ok(run.classList.contains('failed'));
});

test('a row from a Kimberlite that sends no exit or done draws its line without them', () => {
	// Kimberlite rel3n3: the row carries neither field. The code still reads off its text where
	// the text states it; with no end time, no time is drawn; nothing is blank or refused.
	const said = drawn(logged({ ts: T0, outcome: 'done' }, 'ok\n[exit code: 0]'));
	assert.deepEqual(line(said), [['who', 'Run'], ['peek', 'cargo build'], ['meta', 'exit 0']]);
	const bare = drawn(logged({ ts: T0, outcome: 'done' }, 'Finished.'));
	assert.deepEqual(line(bare), [['who', 'Run'], ['peek', 'cargo build']]);
	for (const t of [said, bare]) {
		assert.ok(!t.classList.contains('failed') && !t.classList.contains('refused'));
		assert.equal(t.querySelector('.ctile-dur').textContent, '');
	}
});

// His pick C (D-20261108-04): at 480 px and under, a call's line wraps its whole command and
// "HH:MM · duration" stands small beneath it; above that the line is as it was.
const sub = (tile) => tile.querySelector('.ctile-sub').textContent;

test('a call carries its whole command, never a cut, and its time and duration beneath', () => {
	const argv = ['cargo', 'clippy', '-p', 'daimond', '--all-targets', '--features', 'a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z',
		'--', '-D', 'warnings', '-A', 'clippy::too_many_arguments', '-A', 'clippy::type_complexity', '-A', 'clippy::large_enum_variant'];
	const W = world();
	W.api.call('run', JSON.stringify({ argv }), 'c1', T0);
	W.api.result('run', 'Finished\n[exit code: 0]', 'done', '', { ts: T0, done: T0 + 1_800 });
	const t = W.posted[0];
	assert.ok(argv.join(' ').length > 140);
	assert.equal(t.querySelector('.ctile-peek').textContent, argv.join(' '));
	assert.equal(sub(t), '00:16 · 1.8 s');
	// The desktop line is unchanged: the sub-line is not one of its parts.
	assert.deepEqual(line(t).map(([k]) => k), ['who', 'peek', 'meta', 'dur']);
});

test('each call of a turn says its clock time and how long it took beneath its line', () => {
	assert.deepEqual(turn().posted.map(sub), ['00:16 · 0.1 s', '00:16 · 41 s', '00:17 · 0.4 s']);
});

test('a Kimberlite row with no done says its time alone beneath its line', () => {
	assert.equal(sub(drawn(logged({ ts: T0, outcome: 'done' }, 'Finished.'))), '00:16');
});

test('only a phone width shows the sub-line, and there it hides the line\'s own time and duration', () => {
	const css = readFileSync(join(HERE, '..', 'css', 'app.css'), 'utf8');
	assert.match(css, /\n\.ctile-sub \{ display: none; \}/);
	const at = css.indexOf('@media (max-width: 480px) {\n\t/* His pick C');
	assert.ok(at > 0, 'a 480 px block for the call line');
	const block = css.slice(at, css.indexOf('\n}', at));
	assert.match(block, /\.ctile\[data-t="tool"\] \.ctile-sub \{[^}]*display: block/);
	assert.match(block, /\.ctile\[data-t="tool"\] \.ctile-peek \{[^}]*white-space: normal/);
	assert.match(block, /:is\(\.ctile-time, \.ctile-dur, \.ctile-grow\) \{ display: none; \}/);
});

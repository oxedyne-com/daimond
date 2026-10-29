/* ============================================================
   Test: a handed-off turn's tiles keep the bottom of the last one in view while he
   follows the live end, on the asker and on a second device alike (UNBLOCK-45, his
   words: "tiles in which the transcript is filling do not seem to be scrolling so that
   the bottom of the last tile is always visible").

   Every device draws a turn run elsewhere through `applyProvisional`: a frame either
   grows a tile in place (`growProvisionalTiles`) or adds rows (`renderHistory`'s append).
   Growth in place moved no scroll, and the next append judged "at the end" from the
   geometry alone (`nearBottom`), which one grown answer had already put out of reach: the
   thread stopped following after the first frame. A reader who has scrolled up is never
   pulled down; the end button wears a mark (`has-news`) until he is back at the end.

   Lifts the REAL `nearBottom`, `setScrollTop`, `pinBottom`, `syncJumps`, `applyProvisional`
   (and, where the tree has them, `followsEnd` and `followActivity`) out of daimond.js, over
   a thread whose geometry is simulated. `renderHistory` is a stub that pins as the real
   one does: on `followsEnd()` where the tree has it, else on `nearBottom()`.

     FOLLOW  at the end: 12 frames, growth and new rows mixed, the last tile's bottom in
             view after each
     UP      scrolled up: the frames move nothing, the end button is marked; back at the
             end, the mark goes, and the frames are followed again
     OFF     a frame for a chat not on screen moves nothing

   Run:  node www/js/scrollfollow.test.mjs
   On 52151fa76's daimond.js: the first grown frame is not followed, FOLLOW and UP fail.
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

function extractFn(src, name) {
	let start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return null;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
		if (src[i] === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
		if (src[i] === "'" || src[i] === '"') {
			const q = src[i];
			for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
			continue;
		}
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}
const need = (src, n) => { const f = extractFn(src, n); if (!f) throw new Error('function not found: ' + n); return f; };

const src = readPage(process.env.DAIMOND_JS || join(HERE, 'daimond.js'), 'utf8');
const HAS = extractFn(src, 'followsEnd') !== null;

const lifted = new Function('env', [
	'var chatOutput = env.out, jumpBtn = env.jumpBtn, endBtn = env.endBtn, current = env.current, window = env.window;',
	'var DaimondPeer = env.window.DaimondPeer, DaimondAnswer = env.window.DaimondAnswer;',
	'var _renderingHistory = false, _wasAtEnd = true, _selfTop = -1, _lastScrollAt = 0, _endNews = false;',
	'var _abiRefused = {}, _finalMids = {}, _finalRun = {}, _renderedSigs = null, ARRIVE_FRESH_MS = 60000;',
	'function userDivs() { return []; } function finalFrameChat() { return env.chat; } function ownsChat() { return true; }',
	'function noteArrive() {} function touchChat() {} function persistChats() {} function adoptFinalFrame() {} function sigsOf() { return []; }',
	'function growProvisionalTiles() { env.out.scrollHeight += env.grow; }',
	// The real renderHistory pins at its end on the same follow test the tree uses.
	'function renderHistory() { var down = (typeof followsEnd === "function") ? followsEnd() : nearBottom(); env.out.scrollHeight += env.grow; if (down) setScrollTop(env.out.scrollHeight); }',
	need(src, 'nearBottom'),
	need(src, 'setScrollTop'),
	need(src, 'pinBottom'),
	need(src, 'syncJumps'),
	HAS ? need(src, 'followsEnd') : '',
	HAS ? need(src, 'followActivity') : '',
	need(src, 'applyProvisional'),
	// The thread's own scroll listener, as daimond.js registers it.
	'function userScroll(v) { chatOutput.scrollTop = v; _wasAtEnd = nearBottom(); syncJumps(); if (chatOutput.scrollTop === _selfTop) return; _lastScrollAt = 1; }',
	'return { applyProvisional: applyProvisional, userScroll: userScroll, pinBottom: pinBottom };',
].join('\n'));

function thread(off) {
	const out = { clientHeight: 600, scrollHeight: 2000, _t: 0 };
	Object.defineProperty(out, 'scrollTop', {
		get() { return this._t; },
		set(v) { this._t = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
	});
	const btn = () => ({ hidden: true, cls: {}, classList: { toggle(c, on) { btn.last = on; this.o[c] = !!on; }, o: {} } });
	const endBtn = btn(), jumpBtn = btn();
	const chat = { id: 'c1', messages: [{ mid: 'u1', role: 'user' }] };
	const env = {
		out, endBtn, jumpBtn, chat, grow: 0, current: off ? { id: 'other' } : chat,
		window: {
			DaimondAnswer: {
				show(el, on) { el.hidden = !on; },
				shown: { jump_back: () => false, jump_end: (s) => s.height - s.top - s.view >= 48 },
			},
			DaimondPeer: {
				// A frame of `env.next`: grow in place (same rows), or add one.
				foldProvisional(ms) { return env.add ? ms.concat([{ mid: 'r' + ms.length, provisional: 1, iturn: 'u1' }]) : ms.slice(); },
				frameWhole: () => false, frameRun: () => '',
			},
		},
	};
	Object.assign(env, lifted(env));
	env.frame = (grow, add) => { env.grow = grow; env.add = add; env.applyProvisional('u1', [{ mid: 'x' }], false); };
	env.gap = () => out.scrollHeight - out.scrollTop - out.clientHeight;
	env.news = () => !!endBtn.classList.o['has-news'];
	env.pinBottom();
	return env;
}

console.log('\nFOLLOW: at the end, every frame keeps the last tile\'s bottom in view\n');
{
	const w = thread();
	check('[ctl] starts at the end', w.gap() === 0, String(w.gap()));
	w.frame(300, false);
	check('a tile grown in place: still at the end', w.gap() < 48, 'gap ' + w.gap());
	w.frame(200, true);
	check('then a new row: still at the end', w.gap() < 48, 'gap ' + w.gap());
	let worst = 0;
	for (let i = 0; i < 10; i++) { w.frame(120 + 37 * i, i % 3 === 0); worst = Math.max(worst, w.gap()); }
	check('12 frames, growth and rows mixed: the bottom in view after each', worst < 48, 'worst gap ' + worst);
	check('no mark while he follows', !w.news());
}

console.log('\nUP: scrolled up, nothing moves; the end button is marked\n');
{
	const w = thread();
	w.frame(300, false);
	w.userScroll(100);
	const top = w.out.scrollTop;
	w.frame(250, false);
	w.frame(200, true);
	check('his place is kept', w.out.scrollTop === top, w.out.scrollTop + ' vs ' + top);
	check('the end button is shown and marked', !w.endBtn.hidden && w.news());
	w.userScroll(w.out.scrollHeight);
	check('back at the end: the mark goes', !w.news());
	w.frame(400, false);
	check('and the frames are followed again', w.gap() < 48, 'gap ' + w.gap());
}

console.log('\nOFF: a frame for a chat not on screen moves nothing\n');
{
	const w = thread(true);
	const before = w.out.scrollTop;
	w.frame(0, true);
	check('[ctl] the off-screen frame neither moves the thread nor marks it', w.out.scrollTop === before && !w.news());
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PASS');
process.exit(failures ? 1 : 0);

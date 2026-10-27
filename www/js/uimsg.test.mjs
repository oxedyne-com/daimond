/* ============================================================
   Test — every message the page puts in front of the person reaches the lens
   (LENS-UI, UNBLOCK-41).
   ------------------------------------------------------------
   The owner's Email panel said "This unlock covers 3 mailboxes. Remove one to
   add another." and the lens held no event with those words. `debugshare.js`
   now watches the page for its message elements -- panel error lines, toasts,
   dialog refusals, banners, live notes -- through ONE choke point, and emits
   each sentence once, as it appears, as `ev ui.msg {where, kind, text, i18n}`.

   Drives the REAL www/js/debugshare.js in a fake tab with a small DOM tree and
   a hand-cranked MutationObserver. Proves:

     (a) a panel error line yields exactly one `ui.msg`, with the sentence and
         the panel it sits in, and a re-render of the same line adds none;
     (b) a toast yields exactly one `ui.msg` of kind `toast`;
     (c) an i18n-marked line carries its key;
     (d) with sharing off, nothing is emitted;
     (e) a transcript error drawn as history when a chat opens says nothing,
         and one made now in that chat says itself once (NANCY).

   Run:  node www/js/uimsg.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name); failures++; }
}

// ── A small DOM: a tree, class tokens, attributes, closest, a whole-tree query ──
function makeNode(tag) {
	const node = {
		tagName: String(tag).toUpperCase(), className: '', id: '', title: '', style: {},
		_attrs: {}, _parent: null, children: [], _text: '',
		get parentNode() { return this._parent; },
		get parentElement() { return this._parent; },
		get firstChild() { return this.children[0] || null; },
		get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
		set textContent(v) { this._text = String(v); this.children = []; },
		get innerHTML() { return ''; },
		set innerHTML(v) { this._text = ''; this.children = []; },
		setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); },
		getAttribute(k) {
			if (k === 'id') return this.id || null;
			if (k === 'class') return this.className || null;
			return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
		},
		hasAttribute(k) { return this.getAttribute(k) != null; },
		removeAttribute(k) { delete this._attrs[k]; },
		addEventListener() {},
		appendChild(c) { c._parent = this; this.children.push(c); mutated(); return c; },
		insertBefore(c, ref) {
			c._parent = this;
			const i = ref ? this.children.indexOf(ref) : -1;
			if (i >= 0) this.children.splice(i, 0, c); else this.children.unshift(c);
			mutated();
			return c;
		},
		removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c._parent = null; mutated(); return c; },
		remove() { if (this._parent) this._parent.removeChild(this); },
		getClientRects() { return attached(this) && !this.style.hidden ? [{}] : []; },
		closest(sel) {
			for (let n = this; n; n = n._parent) if (matches(n, sel)) return n;
			return null;
		},
		querySelector() { return null; },
		querySelectorAll() { const out = []; walk(this, n => out.push(n)); return out; },
	};
	return node;
}
function walk(n, fn) { for (const c of n.children) { fn(c); walk(c, fn); } }
// Only the selector shapes `closest` is asked for: `[attr]`, `#id`-less `[id]`,
// a tag name, and comma lists of those.
function matches(n, sel) {
	return String(sel).split(',').some((s) => {
		s = s.trim();
		const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(s);
		if (m) return m[2] == null ? n.getAttribute(m[1]) != null : n.getAttribute(m[1]) === m[2];
		return n.tagName === s.toUpperCase();
	});
}
let BODY = null;
function attached(n) { for (let p = n; p; p = p._parent) if (p === BODY) return true; return false; }

// The hand-cranked observer: a mutation only marks it dirty; `crank()` delivers.
const observers = [];
let dirty = false;
function mutated() { dirty = true; }
function MutationObserverShim(cb) { this.cb = cb; this.on = false; observers.push(this); }
MutationObserverShim.prototype.observe = function () { this.on = true; };
MutationObserverShim.prototype.disconnect = function () { this.on = false; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function crank() {
	if (dirty) { dirty = false; observers.forEach(o => { if (o.on) o.cb([{ type: 'childList' }]); }); }
	await sleep(400);		// the module coalesces a burst of mutations into one scan
}

function makeEnv() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => { store.set(k, String(v)); },
		removeItem: (k) => store.delete(k),
	};
	const head = makeNode('head');
	const body = makeNode('body');
	BODY = body;
	const topActions = makeNode('div');
	topActions.className = 'top-actions';
	body.appendChild(topActions);
	const consoleShim = {};
	['log', 'info', 'debug', 'warn', 'error'].forEach((l) => { consoleShim[l] = function () {}; });
	const document = {
		readyState: 'complete', visibilityState: 'visible', head, body, documentElement: body,
		addEventListener() {},
		createElement: (tag) => makeNode(tag),
		getElementById: () => null,
		querySelector(sel) { return sel === '.top-actions' ? topActions : null; },
		querySelectorAll: (sel) => body.querySelectorAll(sel),
	};
	const win = { DaimondGateway: { clientApi: () => 3 }, addEventListener() {}, dispatchEvent() { return true; } };
	win.DaimondSync = { nudge() {} };
	win.MutationObserver = MutationObserverShim;
	const fetchImpl = () => new Promise(() => {});		// nothing lands; the outbox holds every row
	function CustomEventShim(type, init) { this.type = type; this.detail = init && init.detail; }
	const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
	const atob = (s) => Buffer.from(s, 'base64').toString('binary');
	function loadScript(rel) {
		const text = readFileSync(join(HERE, rel), 'utf8');
		const fn = new Function(
			'window', 'document', 'localStorage', 'fetch', 'btoa', 'atob',
			'TextEncoder', 'TextDecoder', 'CustomEvent', 'MutationObserver',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console',
			'with (window) {\n' + text + '\n}');
		fn(win, document, localStorage, fetchImpl, btoa, atob,
			TextEncoder, TextDecoder, CustomEventShim, MutationObserverShim,
			setTimeout, clearTimeout, () => 1, () => {}, consoleShim);
	}
	loadScript('stamp.js');
	loadScript('scrub.js');
	loadScript('debugshare.js');
	return { win, document, body };
}

const uiRows = (DS) => DS._outbox()
	.filter(r => r.tag === 'ev ui.msg')
	.map(r => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));

const env = makeEnv();
const DS  = env.win.DEBUG_SHARE;
const CAP = 'This unlock covers 3 mailboxes. Remove one to add another.';

// (d) first: off, so a message on the page says nothing.
{
	const panel = makeNode('div');
	panel.setAttribute('data-panel', 'mail');
	env.body.appendChild(panel);
	const e = makeNode('div'); e.className = 'mail-err'; e.textContent = 'Off and unseen.';
	panel.appendChild(e);
	await crank();
	check('(d) sharing off: no ui.msg', uiRows(DS).length === 0);
	panel.remove();
	await crank();
}

DS.setEnabled(true);
await crank();

// (a) a panel error line, then the same line re-rendered.
const mailPanel = makeNode('div');
mailPanel.setAttribute('data-panel', 'mail');
env.body.appendChild(mailPanel);
function renderMail(err) {
	mailPanel.innerHTML = '';
	const st = makeNode('div'); st.className = 'mail-state';
	mailPanel.appendChild(st);
	if (err) { const e = makeNode('div'); e.className = 'mail-err'; e.textContent = err; st.appendChild(e); }
}
renderMail(CAP);
await crank();
let rows = uiRows(DS);
check('(a) a panel error gives exactly one ui.msg', rows.length === 1);
check('(a) it carries the exact sentence', rows[0] && rows[0].text === CAP);
check('(a) kind error, where the panel', rows[0] && rows[0].kind === 'error' && rows[0].where === 'mail');
renderMail(CAP);
await crank();
renderMail(CAP);
await crank();
check('(a) re-rendering the same line adds none', uiRows(DS).length === 1);

// (b) a toast, the shape daimond.js `toast()` builds.
const toast = makeNode('div');
toast.className = 'daimond-toast err';
toast.textContent = 'Backup restore failed.';
env.body.appendChild(toast);
await crank();
rows = uiRows(DS).filter(r => r.text === 'Backup restore failed.');
check('(b) a toast gives exactly one ui.msg', rows.length === 1);
check('(b) kind toast', rows[0] && rows[0].kind === 'toast');
toast.remove();
await crank();

// (c) a dialog refusal marked by i18n carries its key.
const dlg = makeNode('div');
dlg.setAttribute('role', 'dialog');
dlg.setAttribute('data-dlg', 'mail-add');
const de = makeNode('div');
de.className = 'dlg-err';
de.setAttribute('data-i18n', 'mail.err.unlock_first');
de.textContent = 'Unlock first.';
dlg.appendChild(de);
env.body.appendChild(dlg);
await crank();
rows = uiRows(DS).filter(r => r.text === 'Unlock first.');
check('(c) a dialog error gives one ui.msg with its i18n key', rows.length === 1 && rows[0].i18n === 'mail.err.unlock_first');
check('(c) where names the dialog', rows[0] && rows[0].where === 'dialog');

// The same sentence coming back after it went away IS a new message.
renderMail('');
await crank();
renderMail(CAP);
await crank();
check('(a) the line shown again after it cleared is one more', uiRows(DS).filter(r => r.text === CAP).length === 2);

// (e) A chat opens: its transcript draws a 25 Oct error row (`appendError`, its own time on
// `data-made`). History, not news: nothing. Then a turn fails now in it: one.
const OLD = 'The runner could not finish this turn.';
const out = makeNode('div');
out.setAttribute('id', 'chat-output');
env.body.appendChild(out);
const errRow = (text, made) => {
	const d = makeNode('div'); d.className = 'chat-msg chat-msg-error'; d.setAttribute('data-made', String(made));
	const c = makeNode('div'); c.className = 'chat-msg-content'; c.textContent = text; d.appendChild(c);
	return d;
};
out.appendChild(errRow(OLD, Date.UTC(2026, 9, 25, 13, 2, 44)));
await crank();
check('(e) an old error drawn as history when a chat opens gives no ui.msg', uiRows(DS).filter(r => r.text === OLD).length === 0);
const NEW = 'This turn was stopped.';
out.appendChild(errRow(NEW, Date.now()));
await crank();
rows = uiRows(DS).filter(r => r.text === NEW);
check('(e) an error made now in the open chat gives exactly one', rows.length === 1 && rows[0].kind === 'error' && rows[0].where === 'chat-output');
out.appendChild(makeNode('div'));
await crank();
check('(e) [ctl] and the history row is still not said on a later scan', uiRows(DS).filter(r => r.text === OLD).length === 0);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

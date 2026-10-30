/* ============================================================
   Test — the home screen's row actions (Stack A1, D-20261029-01).
   ------------------------------------------------------------
   On a phone the rail is the home page, and a row's cog and Delete are no
   longer drawn on every row: a swipe left, or a long press, reveals them
   (`www/js/page/phone_swipe.js`, on gesture.js's one recogniser). This drives
   the REAL modules, gesture.js through its own window shim and the swipe
   module as imported, against stub rows (Node has no DOM):

     (a) a swipe past the threshold opens the row: its cog and Delete show;
     (b) a short drag does not, and the row stays shut;
     (c) a long press on a finger opens the same pair, and the click that
         follows the release does not also open the chat;
     (d) one row open at a time, and a tap on the open row's body shuts it;
     (e) a mostly vertical drag is the list scrolling, never a swipe;
     (f) off the phone nothing is claimed, so the desktop rail is unchanged.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// gesture.js with a clock and frames this test turns by hand.
const timers = [];
const frames = [];
const win = {};
new Function('window', 'requestAnimationFrame', 'setTimeout', 'clearTimeout',
	fs.readFileSync(path.join(HERE, 'gesture.js'), 'utf8'))(
	win,
	(fn) => { frames.push(fn); return frames.length; },
	(fn, ms) => { timers.push({ fn, ms, dead: false }); return timers.length; },
	(h) => { if (timers[h - 1]) timers[h - 1].dead = true; });
const runFrames = () => frames.splice(0).forEach((fn) => fn());
const runTimers = () => timers.splice(0).forEach((t) => { if (!t.dead) t.fn(); });

const { bindSwipe } = await import('./page/phone_swipe.js');

// A stub element: classes, dataset, a style that takes custom properties,
// listeners, and `closest` over its parent chain.
function el(cls, parent) {
	const e = {
		cls: new Set(cls.split(' ').filter(Boolean)), dataset: {}, parent: parent || null, kids: [],
		listeners: {}, props: {},
		style: { setProperty(k, v) { e.props[k] = v; }, removeProperty(k) { delete e.props[k]; } },
		classList: { contains: (c) => e.cls.has(c) },
		matches(sel) { return sel.split(',').some((s) => s.trim().split('.').filter(Boolean).every((c) => e.cls.has(c))); },
		closest(sel) { for (let n = e; n; n = n.parent) if (n.matches(sel)) return n; return null; },
		querySelectorAll(sel) {
			const out = [];
			const walk = (n) => n.kids.forEach((k) => { if (k.matches(sel)) out.push(k); walk(k); });
			walk(e);
			return out;
		},
		addEventListener(t, fn) { (e.listeners[t] || (e.listeners[t] = [])).push(fn); },
		removeEventListener(t, fn) { e.listeners[t] = (e.listeners[t] || []).filter((f) => f !== fn); },
		setPointerCapture() {}, releasePointerCapture() {},
	};
	if (parent) parent.kids.push(e);
	return e;
}

function rig(phone = true) {
	const list = el('session-list');
	const rows = [0, 1].map(() => {
		const row = el('session-box chat-box', list);
		const header = el('session-box-header', row);
		const label = el('tile-label', header);
		el('tile-cog', header);
		el('tile-x', header);
		return { row, label };
	});
	bindSwipe(list, '.session-box', { gesture: win.DaimondGesture, isOn: () => phone });
	const send = (type, target, x, y, extra = {}) => {
		const ev = {
			type, target, pointerId: 1, pointerType: 'touch', button: 0, clientX: x, clientY: y,
			defaulted: false, stopped: false,
			preventDefault() { this.defaulted = true; }, stopPropagation() { this.stopped = true; }, ...extra,
		};
		(list.listeners[type] || []).forEach((fn) => fn(ev));
		return ev;
	};
	const drag = (target, dx, dy = 0) => {
		send('pointerdown', target, 300, 100);
		send('pointermove', target, 300 + dx / 2, 100 + dy / 2);
		runFrames();
		send('pointermove', target, 300 + dx, 100 + dy);
		runFrames();
		send('pointerup', target, 300 + dx, 100 + dy);
	};
	return { list, rows, send, drag };
}

const isOpen = (row) => row.dataset.swipe === 'open';

test('(a) a swipe past the threshold reveals the cog and Delete', () => {
	const { rows, drag } = rig();
	drag(rows[0].label, -120);
	assert.ok(isOpen(rows[0].row), 'the row is open');
	assert.equal(rows[0].row.props['--swipe-dx'], '-144px', 'an open row rests at the tray, not at the finger');
	assert.equal(rows[0].row.querySelectorAll('.tile-cog, .tile-x').length, 2, 'cog and Delete are the tray');
});

test('(b) a short drag leaves the row shut', () => {
	const { rows, drag } = rig();
	drag(rows[0].label, -20);
	assert.ok(!isOpen(rows[0].row));
});

test('(c) a long press opens the pair, and its click does not open the chat', () => {
	const { rows, send } = rig();
	send('pointerdown', rows[1].label, 200, 100);
	runTimers();
	assert.ok(isOpen(rows[1].row), 'held, the row opens');
	send('pointerup', rows[1].label, 200, 100);
	const click = send('click', rows[1].label, 200, 100);
	assert.ok(click.defaulted && click.stopped, 'the release click is swallowed');
	const next = send('click', rows[1].label, 200, 100);
	assert.ok(!next.stopped, 'only that one click');
});

test('(d) one row open at a time; a tap on the open row shuts it', () => {
	const { rows, drag, send } = rig();
	drag(rows[0].label, -120);
	drag(rows[1].label, -120);
	assert.ok(!isOpen(rows[0].row) && isOpen(rows[1].row));
	send('pointerdown', rows[1].label, 100, 100);
	send('pointerup', rows[1].label, 100, 100);
	const click = send('click', rows[1].label, 100, 100);
	assert.ok(!isOpen(rows[1].row), 'the tap shuts it');
	assert.ok(click.stopped, 'and does not open the chat as well');
});

test('(e) a vertical drag is a scroll, not a swipe', () => {
	const { rows, drag } = rig();
	drag(rows[0].label, -30, 120);
	assert.ok(!isOpen(rows[0].row));
});

test('(f) off the phone nothing is claimed', () => {
	const { rows, drag, send } = rig(false);
	drag(rows[0].label, -120);
	send('pointerdown', rows[0].label, 200, 100);
	runTimers();
	assert.ok(!isOpen(rows[0].row));
});

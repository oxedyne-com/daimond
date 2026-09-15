// gesture.test.mjs — the press-and-drag recogniser, driven with no browser.
//
//	node --test www/js/gesture.test.mjs
//
// The state machine in `www/js/gesture.js` is what two surfaces agree about how
// a hand behaves: how far a press travels before it is a drag, how long a finger
// rests before it is one, what a release means when neither has happened.  It
// touches nothing but its own state and the callbacks it was given, so it is
// driven here against a stand-in element and a stand-in frame clock — which
// means the rules can be asserted rather than looked at in a browser.
//
// Zero dependencies, the pattern `dev/listing.test.mjs` established.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = path.join(HERE, 'gesture.js');

/// One stand-in element and one stand-in frame clock, loaded fresh per test so
/// no two tests share a recogniser's state.
function load() {
	const frames = [];
	const timers = [];
	const win = { };
	const rafShim = (fn) => { frames.push(fn); return frames.length; };
	const setShim = (fn, ms) => { timers.push({ fn, ms, dead: false }); return timers.length; };
	const clearShim = (h) => { if (timers[h - 1]) timers[h - 1].dead = true; };
	// eslint-disable-next-line no-new-func
	new Function('window', 'requestAnimationFrame', 'setTimeout', 'clearTimeout',
		fs.readFileSync(SRC, 'utf8'))(win, rafShim, setShim, clearShim);
	const listeners = {};
	const captured = [];
	const el = {
		addEventListener: (t, fn) => { (listeners[t] || (listeners[t] = [])).push(fn); },
		removeEventListener: (t, fn) => {
			listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
		},
		setPointerCapture: (id) => captured.push(['set', id]),
		releasePointerCapture: (id) => captured.push(['release', id]),
	};
	const send = (type, ev) => (listeners[type] || []).forEach((fn) => fn(ev));
	const ev = (x, y, extra = {}) => ({
		pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y,
		preventDefault() { this.defaulted = true; }, ...extra,
	});
	const runFrames = () => { const f = frames.splice(0); f.forEach((fn) => fn()); };
	/// Run every timer that has been armed and not cancelled, the way the clock
	/// would once its milliseconds had passed.
	const runTimers = () => {
		const t = timers.splice(0);
		t.forEach((x) => { if (!x.dead) x.fn(); });
		return t;
	};
	return { G: win.DaimondGesture, el, send, ev, runFrames, runTimers, timers, captured, win };
}

/// A recogniser wired to a log, so what happened is a list rather than a guess.
function recorder(t, el, opts = {}) {
	const log = [];
	const g = t.drag(el, {
		match: (e) => (e.button === 0 ? { tag: 'ctx' } : null),
		start: (e, c) => log.push(['start', c.tag]),
		lift:  (e, c) => { log.push(['lift', c.tag]); return opts.refuse ? false : undefined; },
		move:  (p, c) => log.push(['move', p.clientX, p.clientY]),
		drop:  (e, c, lifted) => log.push(['drop', lifted]),
		cancel: (c, lifted) => log.push(['cancel', lifted]),
		onHold: opts.onHold,
		threshold: opts.threshold,
		hold: opts.hold,
	});
	return { log, g };
}

test('a press that does not travel is a press, not a drag', () => {
	const { G, el, send, ev, runFrames } = load();
	const { log } = recorder(G, el);
	send('pointerdown', ev(100, 100));
	send('pointermove', ev(102, 101));
	runFrames();
	send('pointerup', ev(102, 101));
	assert.deepEqual(log, [['start', 'ctx'], ['drop', false]]);
});

test('and four pixels of travel makes it one', () => {
	const { G, el, send, ev, runFrames, captured } = load();
	const { log } = recorder(G, el);
	send('pointerdown', ev(100, 100));
	send('pointermove', ev(104, 100));
	runFrames();
	send('pointerup', ev(104, 100));
	assert.deepEqual(log, [['start', 'ctx'], ['lift', 'ctx'], ['move', 104, 100], ['drop', true]]);
	// The pointer is captured at the lift and let go at the drop, so the gesture
	// survives the pointer leaving the element it began on.
	assert.deepEqual(captured, [['set', 1], ['release', 1]]);
});

test('moves are coalesced to one a frame, and it is the LAST one', () => {
	const { G, el, send, ev, runFrames } = load();
	const { log } = recorder(G, el);
	send('pointerdown', ev(0, 0));
	send('pointermove', ev(40, 0));
	send('pointermove', ev(60, 0));
	send('pointermove', ev(90, 7));
	assert.deepEqual(log.filter((r) => r[0] === 'move'), [], 'nothing before the frame');
	runFrames();
	assert.deepEqual(log.filter((r) => r[0] === 'move'), [['move', 90, 7]]);
});

test('a move that arrives after the release is never delivered', () => {
	const { G, el, send, ev, runFrames } = load();
	const { log } = recorder(G, el);
	send('pointerdown', ev(0, 0));
	send('pointermove', ev(50, 0));
	send('pointerup', ev(50, 0));
	runFrames();
	assert.deepEqual(log.filter((r) => r[0] === 'move'), [],
		'a frame owed to a gesture that has ended must not be paid');
});

test('a press nobody claims is left entirely alone', () => {
	const { G, el, send, ev, runFrames } = load();
	const { log } = recorder(G, el);
	send('pointerdown', ev(10, 10, { button: 2 }));
	send('pointermove', ev(90, 10, { button: 2 }));
	runFrames();
	send('pointerup', ev(90, 10, { button: 2 }));
	assert.deepEqual(log, []);
});

test('a claimed press is defended, and a passive one is not', () => {
	{
		const { G, el, send, ev } = load();
		recorder(G, el);
		const e = ev(10, 10);
		send('pointerdown', e);
		assert.equal(e.defaulted, true);
	}
	{
		const { G, el, send, ev } = load();
		const e = ev(10, 10);
		G.drag(el, { match: () => ({}), passive: true });
		send('pointerdown', e);
		assert.equal(e.defaulted, undefined);
	}
});

test('a lift that is refused cancels rather than half-starting', () => {
	const { G, el, send, ev, runFrames } = load();
	const { log } = recorder(G, el, { refuse: true });
	send('pointerdown', ev(0, 0));
	send('pointermove', ev(20, 0));
	runFrames();
	assert.deepEqual(log, [['start', 'ctx'], ['lift', 'ctx'], ['cancel', false]]);
	// And nothing is left running for the release to find.
	send('pointerup', ev(20, 0));
	assert.deepEqual(log.filter((r) => r[0] === 'drop'), []);
});

test('pointercancel ends the gesture as a cancel, never as a drop', () => {
	const { G, el, send, ev, runFrames } = load();
	const { log } = recorder(G, el);
	send('pointerdown', ev(0, 0));
	send('pointermove', ev(30, 0));
	runFrames();
	send('pointercancel', ev(30, 0));
	assert.deepEqual(log[log.length - 1], ['cancel', true]);
});

test('the caller can cancel it from outside — which is what Escape is', () => {
	const { G, el, send, ev, runFrames } = load();
	const { log, g } = recorder(G, el);
	send('pointerdown', ev(0, 0));
	send('pointermove', ev(30, 0));
	runFrames();
	assert.equal(g.active(), true);
	assert.equal(g.lifted(), true);
	assert.equal(g.cancel(), true);
	assert.equal(g.active(), false);
	assert.deepEqual(log[log.length - 1], ['cancel', true]);
	assert.equal(g.cancel(), false, 'cancelling nothing is not a cancellation');
});

test('a second pointer does not steer the gesture the first one started', () => {
	const { G, el, send, ev, runFrames } = load();
	const { log } = recorder(G, el);
	send('pointerdown', ev(0, 0));
	send('pointermove', ev(40, 0, { pointerId: 2 }));
	runFrames();
	assert.deepEqual(log, [['start', 'ctx']], 'the other finger is not this gesture');
	send('pointerup', ev(40, 0, { pointerId: 2 }));
	assert.deepEqual(log, [['start', 'ctx']]);
});

test('a rest on a finger lifts, and on a mouse there is no rest to keep', () => {
	{
		const { G, el, send, ev, runTimers, timers } = load();
		const { log } = recorder(G, el);
		send('pointerdown', ev(0, 0, { pointerType: 'touch' }));
		assert.equal(timers.length, 1, 'a finger has no hover, so a rest is armed');
		assert.equal(timers[0].ms, 350);
		runTimers();
		assert.deepEqual(log, [['start', 'ctx'], ['lift', 'ctx']],
			'the rest lifted it without the pointer having travelled at all');
	}
	{
		const { G, el, send, ev, timers } = load();
		recorder(G, el);
		send('pointerdown', ev(0, 0, { pointerType: 'mouse' }));
		assert.equal(timers.length, 0, 'a mouse hovers; it needs no rest');
	}
});

test('a finger that was travelling is not resting', () => {
	const { G, el, send, ev, runTimers, runFrames } = load();
	const { log } = recorder(G, el, { threshold: 40 });
	send('pointerdown', ev(0, 0, { pointerType: 'touch' }));
	send('pointermove', ev(20, 0, { pointerType: 'touch' }));   // short of the threshold
	runFrames();
	runTimers();
	assert.deepEqual(log, [['start', 'ctx']],
		'twenty pixels of travel is a swipe in progress, not a press held still');
});

test('a caller may say a rest means something OTHER than a drag', () => {
	// The Graph raises a tile's anchors under a resting finger rather than
	// carrying the tile off, which is the case this option exists for.
	const { G, el, send, ev, runTimers } = load();
	const { log } = recorder(G, el, { onHold: () => 'cancel' });
	send('pointerdown', ev(0, 0, { pointerType: 'touch' }));
	runTimers();
	assert.deepEqual(log, [['start', 'ctx'], ['cancel', false]]);
	send('pointerup', ev(0, 0, { pointerType: 'touch' }));
	assert.deepEqual(log.filter((r) => r[0] === 'drop'), [], 'and the release finds nothing');
});

test('travelling past the threshold disarms the rest', () => {
	const { G, el, send, ev, runFrames, timers } = load();
	const { log } = recorder(G, el);
	send('pointerdown', ev(0, 0, { pointerType: 'touch' }));
	send('pointermove', ev(30, 0, { pointerType: 'touch' }));
	runFrames();
	assert.ok(timers[0].dead, 'the rest was cancelled by the lift it was racing');
	assert.deepEqual(log.filter((r) => r[0] === 'lift').length, 1, 'and it lifted exactly once');
});

test('coarse and past are the two rules, stated once', () => {
	const { G } = load();
	assert.equal(G.coarse({ pointerType: 'touch' }), true);
	assert.equal(G.coarse({ pointerType: 'pen' }), true);
	assert.equal(G.coarse({ pointerType: 'mouse' }), false);
	assert.equal(G.past({ x: 0, y: 0 }, { x: 3, y: 3 }, 4), false);
	assert.equal(G.past({ x: 0, y: 0 }, { x: 4, y: 0 }, 4), true);
	assert.equal(G.past({ x: 0, y: 0 }, { x: 0, y: -4 }, 4), true);
	assert.equal(G.THRESHOLD, 4);
	assert.equal(G.HOLD, 350);
	assert.ok(G.HOLD_SLOP > G.THRESHOLD, 'a finger on glass is never quite still');
});

test('unbinding leaves nothing listening', () => {
	const { G, el, send, ev, runFrames } = load();
	const { log, g } = recorder(G, el);
	g.off();
	send('pointerdown', ev(0, 0));
	send('pointermove', ev(40, 0));
	runFrames();
	assert.deepEqual(log, []);
});

test('a gesture may take the pointer at the press rather than at the lift', () => {
	// A pan begun near an edge: the first move is already outside the element, so
	// a capture taken at the lift is a capture never taken at all.
	const { G, el, send, ev, runFrames, captured } = load();
	const log = [];
	G.drag(el, {
		capture: 'press', threshold: 0,
		match: () => ({}),
		move: (p) => log.push(p.clientX),
		drop: () => log.push('drop'),
	});
	send('pointerdown', ev(10, 10));
	assert.deepEqual(captured, [['set', 1]], 'held from the press');
	send('pointermove', ev(-90, 10));
	runFrames();
	send('pointerup', ev(-90, 10));
	assert.deepEqual(log, [-90, 'drop']);
	assert.deepEqual(captured, [['set', 1], ['release', 1]]);
});

test('and a press that never lifts still lets the pointer go', () => {
	const { G, el, send, ev, captured } = load();
	G.drag(el, { capture: 'press', match: () => ({}) });
	send('pointerdown', ev(0, 0));
	send('pointerup', ev(0, 0));
	assert.deepEqual(captured, [['set', 1], ['release', 1]],
		'a capture nothing releases is a pointer no other surface can have');
});

test('the default takes nothing until the press has become a drag', () => {
	const { G, el, send, ev, captured } = load();
	G.drag(el, { match: () => ({}) });
	send('pointerdown', ev(0, 0));
	assert.deepEqual(captured, [], 'a press that may yet be a click retargets no click');
	send('pointerup', ev(0, 0));
	assert.deepEqual(captured, []);
});

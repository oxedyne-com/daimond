/* ============================================================
   Test -- THE ONE LOCK PER DIAMOND (www/js/daimond.js, `holdDiamond`), round F of 5.3.2, R1 and L7.
   ------------------------------------------------------------
   A note press and the pull that imports the same Diamond both read its files and lay them down whole, so they take
   one lock. The REAL `holdDiamond` is lifted from the file's own text and run as written, twice over: against a
   `navigator.locks` stand-in (a lock manager with the Web Locks rules: one exclusive holder per name, granted in the order
   asked, a queued request aborted by its signal, shared mode for the break) and against no `navigator.locks` at all (the
   fallback, a line in the page). What is proved is the primitive: one holder at a time per Diamond, in the order asked;
   other Diamonds not held up; a holder that throws frees the line; a caller that waits is answered when its turn comes, or
   with an error if it waited too long, and then never runs; a nested ask for the Diamond the holder has is refused. Two
   pages sharing a lock manager (two tabs of one device) are held off from each other; without one they are not (the limit).
   `diamondconflict.test.mjs` (Case 6) drives it under the real `applyDiamonds` and `Notes`; `verify_diamondconflict` (G5d)
   drives it between two real tabs.

   Run:   node www/js/diamondlock.test.mjs
          node www/js/diamondlock.test.mjs --break <name>      (nolock, norelease, nowait, nofallback; each must go red)
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, bad = null;
const ok = (cond, detail) => { if (!cond && !bad) bad = detail || 'assertion'; };
const eq = (got, want, what) => { const a = JSON.stringify(got), b = JSON.stringify(want); if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b; };
async function kase(name, fn) {
	bad = null;
	try { await Promise.race([fn(), new Promise((_, no) => setTimeout(() => no(new Error('hung for 3 s')), 3000))]); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); } else { console.log('  ok   ' + name); }
}
const KNOWN = ['nolock', 'norelease', 'nowait', 'nofallback'];
const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
if (BREAK && !KNOWN.includes(BREAK)) { console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', ')); process.exit(2); }

// A lock manager with the Web Locks rules `holdDiamond` leans on: per name an exclusive holder, or any number of shared ones,
// granted in the order asked (a request waits behind every earlier one that it conflicts with); `signal` aborts a request that
// is still queued and does nothing to one already granted; the answer is the callback's, and a throw frees the name.
function lockManager(o) {
	o = o || {};
	const by = new Map(), seen = [];
	const st = (n) => { let x = by.get(n); if (!x) by.set(n, x = { held: [], queue: [] }); return x; };
	const pump = (n) => {
		const x = st(n);
		while (x.queue.length) {
			const r = x.queue[0];
			const free = r.mode === 'shared' ? x.held.every((h) => h.mode === 'shared') : x.held.length === 0;
			if (!free) break;
			x.queue.shift(); x.held.push(r); r.granted = true;
			Promise.resolve().then(() => r.cb({ name: n, mode: r.mode })).then(
				(v) => { x.held.splice(x.held.indexOf(r), 1); r.resolve(v); pump(n); },
				(e) => { x.held.splice(x.held.indexOf(r), 1); r.reject(e); pump(n); });
		}
	};
	return {
		seen,
		request(name, opts, cb) {
			if (typeof opts === 'function') { cb = opts; opts = {}; }
			seen.push({ name, mode: (opts && opts.mode) || 'exclusive' });
			if (o.refuse) return Promise.reject(new DOMException('The document\'s origin is opaque', 'SecurityError'));
			return new Promise((resolve, reject) => {
				const sig = opts && opts.signal;
				if (sig && sig.aborted) return reject(sig.reason || new DOMException('aborted', 'AbortError'));
				const r = { cb, resolve, reject, mode: (opts && opts.mode) || 'exclusive', granted: false };
				st(name).queue.push(r);
				if (sig) sig.addEventListener('abort', () => {
					if (r.granted) return;
					const q = st(name).queue, i = q.indexOf(r);
					if (i < 0) return;
					q.splice(i, 1); reject(sig.reason || new DOMException('aborted', 'AbortError')); pump(name);
				});
				pump(name);
			});
		},
	};
}

const SRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
// One page: the lock code as written, with `navigator` as the page would see it. `nav` is undefined for a browser with no Web Locks.
function lift(nav) {
	const a = SRC.indexOf('\tvar DIAMOND_LOCKS = {};');
	if (a < 0) throw new Error('DIAMOND_LOCKS not found in daimond.js');
	let src = SRC.slice(a, SRC.indexOf('\n\t}\n', SRC.indexOf('\tfunction holdDiamond(', a)) + 3);
	const swap = (needle, to) => {
		const n = src.split(needle).length - 1;
		if (n !== 1) { console.error('break ' + BREAK + ': target matched ' + n + ' times, not once: ' + needle); process.exit(2); }
		src = src.replace(needle, to);
	};
	if (BREAK === 'nolock')     { swap('var prior = q.tail,', 'var prior = Promise.resolve(),'); swap("{ mode: 'exclusive', signal: ctl.signal }", "{ mode: 'shared', signal: ctl.signal }"); }
	if (BREAK === 'norelease')  { swap('run.then(resolve, reject).then(free);', 'run.then(resolve, reject);'); swap('return new Promise(function (r) { r(fn()); });', 'return new Promise(function (r) { r(fn()); }).then(function () { return new Promise(function () {}); });'); }
	if (BREAK === 'nowait')     { swap('if (late) { free(); return; }', 'if (late) { free(); }'); swap('late = true; ctl.abort();', 'late = true;'); }
	if (BREAK === 'nofallback') swap('return inPage();', 'throw e;');
	// eslint-disable-next-line no-new-func
	return new Function('navigator', src + '\nreturn { hold: holdDiamond, locks: DIAMOND_LOCKS };')(nav);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const within = (p, ms) => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

// Each case runs against the Web Locks stand-in ('locks') and against a browser with none ('page').
for (const mode of ['locks', 'page']) {
	const page = (mgr) => lift(mode === 'locks' ? { locks: mgr || lockManager() } : undefined);
	const tag = (n) => n + '  [' + mode + ']';

	await kase(tag('one holder at a time per Diamond, in the order asked'), async () => {
		const { hold } = page(), log = [], live = { n: 0, max: 0 };
		const job = (name, ms) => hold('D1', async () => { live.n++; live.max = Math.max(live.max, live.n); log.push('in ' + name); await sleep(ms); log.push('out ' + name); live.n--; });
		await Promise.all([job('a', 25), job('b', 1), job('c', 10), job('d', 1)]);
		eq(live.max, 1, 'holders at once');
		eq(log, ['in a', 'out a', 'in b', 'out b', 'in c', 'out c', 'in d', 'out d'], 'order');
	});

	await kase(tag('another Diamond is not held up'), async () => {
		const { hold } = page(), g = gate(), done = [];
		const slow = hold('D1', async () => { await g.p; done.push('D1'); });
		await hold('D2', async () => { done.push('D2'); });
		eq(done, ['D2'], 'D2 ran while D1 was held');
		g.open(); await slow;
		eq(done, ['D2', 'D1'], 'then D1');
	});

	await kase(tag('what fn returns is the answer, and what it throws'), async () => {
		const { hold } = page();
		eq(await hold('D1', async () => 7), 7, 'async value');
		eq(await hold('D1', () => 'plain'), 'plain', 'plain value');
		let e1 = null, e2 = null;
		try { await hold('D1', async () => { throw new Error('boom'); }); } catch (e) { e1 = e.message; }
		try { await hold('D1', () => { throw new Error('sync boom'); }); } catch (e) { e2 = e.message; }
		eq([e1, e2], ['boom', 'sync boom'], 'errors');
	});

	await kase(tag('a holder that throws frees the line'), async () => {
		const { hold } = page();
		hold('D1', async () => { throw new Error('boom'); }).catch(() => {});
		hold('D1', () => { throw new Error('sync'); }).catch(() => {});
		ok(await within(hold('D1', async () => 1), 500), 'the third holder ran');
	});

	await kase(tag('a press that waits is answered when its turn comes (the lock is never left held)'), async () => {
		const { hold, locks } = page(), g = gate(), got = [];
		const apply = hold('X', async () => { await g.p; got.push('apply'); });
		const press = hold('X', async () => { got.push('press'); return 'kept'; });
		await sleep(20);
		eq(got, [], 'the press waits behind the apply');
		g.open();
		eq(await press, 'kept', 'the press answered'); await apply;
		eq(got, ['apply', 'press'], 'after it, not under it');
		await sleep(5);
		eq(Object.keys(locks), [], 'the table is empty once nobody holds or waits');
	});

	await kase(tag('a caller that waits too long is answered with an error, never runs, and the line goes on'), async () => {
		const { hold } = page(), g = gate(), ran = [];
		const long = hold('X', async () => { await g.p; ran.push('long'); });
		let err = null;
		const impatient = hold('X', async () => { ran.push('impatient'); }, 30).catch((e) => { err = e.message; });
		const patient = hold('X', async () => { ran.push('patient'); });
		ok(await within(impatient, 400), 'the impatient caller was answered while the holder still held');
		ok(/waited too long/.test(err || ''), 'with the reason: ' + err);
		g.open(); await long; await patient;
		eq(ran, ['long', 'patient'], 'the one that gave up never ran; the one behind it did');
	});

	await kase(tag('the bound on a wait does not touch a caller that was granted in time'), async () => {
		const { hold } = page();
		eq(await hold('X', async () => { await sleep(80); return 'fine'; }, 30), 'fine', 'a holder longer than its own wait bound');
	});

	await kase(tag('a holder that asks for its own Diamond again waits for itself (so the import calls the held form of the join)'), async () => {
		const { hold, locks } = page();
		let inner = 'none';
		const outer = hold('X', async () => { inner = await hold('X', async () => 'inside', 40).then(() => 'ran', (e) => 'refused'); return 'done'; });
		eq(await outer, 'done', 'the outer holder finishes');
		eq(inner, 'refused', 'the nested ask was not served while the outer held');
		await sleep(5);
		eq(Object.keys(locks), [], 'and the table is empty again');
	});
}

// Tabs of one device.
await kase('two pages sharing a lock manager are held off from each other, Diamond by Diamond, in the order asked  [locks]', async () => {
	const mgr = lockManager(), p1 = lift({ locks: mgr }), p2 = lift({ locks: mgr }), g = gate(), log = [];
	const one = p1.hold('D1', async () => { log.push('1 in'); await g.p; log.push('1 out'); });
	await sleep(10);
	const two = p2.hold('D1', async () => { log.push('2 in'); await sleep(5); log.push('2 out'); });
	const other = p2.hold('D2', async () => { log.push('2 on D2'); });
	await other; await sleep(30);
	eq(log, ['1 in', '2 on D2'], 'tab 2 waits for tab 1 on D1 and not on D2');
	g.open(); await one; await two;
	eq(log, ['1 in', '2 on D2', '1 out', '2 in', '2 out'], 'then tab 2 runs');
	eq(mgr.seen.map((x) => x.name).sort(), ['daimond-diamond:D1', 'daimond-diamond:D1', 'daimond-diamond:D2'], 'one lock name per Diamond');
});

await kase('a tab that throws frees the Diamond for the other tab  [locks]', async () => {
	const mgr = lockManager(), p1 = lift({ locks: mgr }), p2 = lift({ locks: mgr });
	p1.hold('D1', async () => { await sleep(10); throw new Error('boom'); }).catch(() => {});
	ok(await within(p2.hold('D1', async () => 1), 500), 'the other tab ran');
});

await kase('a tab that waits too long on another tab is answered with an error and never runs  [locks]', async () => {
	const mgr = lockManager(), p1 = lift({ locks: mgr }), p2 = lift({ locks: mgr }), g = gate(), ran = [];
	const long = p1.hold('D1', async () => { await g.p; });
	let err = null;
	await p2.hold('D1', async () => { ran.push('late'); }, 30).catch((e) => { err = e.message; });
	ok(/waited too long/.test(err || ''), 'with the reason: ' + err);
	g.open(); await long; await sleep(20);
	eq(ran, [], 'the one that gave up never ran');
	ok(await within(p2.hold('D1', async () => 1), 500), 'and the Diamond is free again');
});

await kase('without Web Locks two pages are not held off (the fallback is one page\'s line, L7)  [page]', async () => {
	const p1 = lift(undefined), p2 = lift(undefined), g = gate(), log = [];
	const one = p1.hold('D1', async () => { log.push('1 in'); await g.p; });
	await sleep(5);
	await p2.hold('D1', async () => { log.push('2 in'); });
	eq(log, ['1 in', '2 in'], 'tab 2 ran under tab 1');
	g.open(); await one;
});

await kase('a lock manager that will not take the name falls back to the page\'s line, in the order asked  [locks]', async () => {
	const { hold } = lift({ locks: lockManager({ refuse: true }) }), g = gate(), log = [];
	const a = hold('D1', async () => { log.push('a in'); await g.p; log.push('a out'); });
	const b = hold('D1', async () => { log.push('b'); return 'b done'; });
	a.catch(() => {}); b.catch(() => {});	// a refusal is the assertion's to report, not the process's
	await sleep(30);
	eq(log, ['a in'], 'b waits for a on the page\'s line');
	g.open();
	await a; eq(await b, 'b done', 'b answered');
	eq(log, ['a in', 'a out', 'b'], 'order');
});

console.log(failures ? '\n' + failures + ' failure(s).' : '\nAll lock cases pass.');
if (BREAK) { console.log(failures ? 'EXPECTED: ' + failures + ' failure(s) under --break ' + BREAK + '. The guard works.' : 'BREAK ' + BREAK + ' DID NOT REDDEN ANYTHING'); process.exit(failures ? 0 : 1); }
process.exit(failures ? 1 : 0);

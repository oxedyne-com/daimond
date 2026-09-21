/* ============================================================
   Test — the "Something went wrong" stranger-support loop (D-20260920-02).
   ------------------------------------------------------------
   Drives the REAL www/js/support.js in a simulated tab: a Map-backed
   localStorage, a minimal fake DOM, fake `DaimondTrail`/`DaimondDiag`/
   `DaimondIdentity`/`DaimondSync` seams, and a `fetch` that captures every
   POST. No browser, no gateway -- the module's own assemble/consent/post/
   arm path is the code under test, the same harness shape debugshare.test.mjs
   uses for the sibling module this one rides beside.

   The properties the brief asked to prove, each with a reverting check:

     (a) A report is NON-EMPTY and carries the build id, the trail rows and
         the diag rows -- and, reverted (both rings absent), carries only its
         own header, so the assembly is provably reading the rings and not
         fabricating content.
     (b) A report POSTS to the existing `/api/debug-trace` gate, in the wire
         shape the gateway handler already accepts (`{v, device, rows}`).
     (c) Consent is asked ONCE PER ACCOUNT: the first call opens the sheet and
         sends nothing; agreeing sends AND is remembered, so a second call
         posts straight away with no sheet -- reverted by an account that
         adopts a FRESHER "no" from another device, which must win.
     (d) `arm()` auto-arms the diag ring after a simulated `error.thrown` and
         disarms it again once its window elapses -- reverted by a ring the
         PERSON had already turned on by hand, which must never be switched
         off by this file, and (strengthened) never even has its storage
         markers written.
     (e) a user-armed ring survives error -> reload -> the auto-arm window's
         own would-be expiry: `resumeArm()` adopts nothing without a
         persisted ownership marker of its own (finding #1's reload half).
     (f) a tab closed mid-window and reopened AFTER the window elapsed finds
         Diagnostics disarmed immediately on boot, not stuck on (finding #2).
     (g) `scrub()` masks an API key, a Bearer token and a Diamond-relative
         path down to its basename, and a live `reportRows()` row carrying
         them comes out masked (finding #3).
     (h) a full ring's report is trimmed to fit the gateway's 256 KiB body
         cap, header and newest rows first, before `post()` ever sends it
         (finding #7).
     (i) `appendError()` -- the REAL function, lifted from daimond.js -- arms
         the ring and adds a "Report this" affordance that posts through
         `DaimondSupport.report`, so a failed turn has a one-tap route that
         is not a hunt for the Settings button (finding #4).

   Run:  node www/js/support.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond) {
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name); failures++; }
}

// ── A minimal fake DOM, only as much as support.js touches ──────
function makeNode(tag) {
	const node = {
		tagName: tag, className: '', id: '', textContent: '', title: '',
		type: '', disabled: false, hidden: false,
		_listeners: {}, _parent: null, children: [], style: {},
		setAttribute() {},
		addEventListener(type, fn) { (node._listeners[type] = node._listeners[type] || []).push(fn); },
		appendChild(c) { c._parent = node; node.children.push(c); return c; },
		removeChild(c) {
			const i = node.children.indexOf(c);
			if (i >= 0) node.children.splice(i, 1);
			return c;
		},
		get parentNode() { return node._parent; },
		querySelector() { return null; },
		focus() {},
	};
	return node;
}
function fire(node, type) { (node._listeners[type] || []).forEach((fn) => fn({})); }
function findById(root, id) {
	for (const c of root.children) {
		if (c.id === id) return c;
		const deep = findById(c, id);
		if (deep) return deep;
	}
	return null;
}
function findByClass(root, cls) {
	for (const c of root.children) {
		if ((c.className || '').indexOf(cls) !== -1) return c;
		const deep = findByClass(c, cls);
		if (deep) return deep;
	}
	return null;
}
function countById(root, id) {
	let n = 0;
	for (const c of root.children) {
		if (c.id === id) n++;
		n += countById(c, id);
	}
	return n;
}

function makeEnv(cfg) {
	cfg = cfg || {};
	const store = cfg.store || new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const body = makeNode('body');
	const document = {
		createElement: (tag) => makeNode(tag),
		body,
	};

	const win = {};
	// Trail: a fixed, non-empty ring, so a report's trail section is provably
	// non-empty unless the seam itself is removed (the (a) revert below).
	win.DaimondTrail = cfg.noTrail ? null : {
		lastBuild: () => 'bld_f00d1234',
		rows: () => [
			{ t: 1000, a: 500,  w: 'boot',       d: 'standalone' },
			{ t: 2000, a: 1500, w: 'page error', d: 'TypeError: x is undefined @ app.js:12' },
		],
	};
	// Diag: mutable on/off, a call log for `set`, and a fixed ring.
	let diagOn = !!cfg.diagOnAtStart;
	const setCalls = [];
	win.DaimondDiag = cfg.noDiag ? null : {
		on:  () => diagOn,
		set: (v, why) => { diagOn = !!v; setCalls.push({ v: !!v, why }); },
		rows: () => cfg.diagRows || [
			{ ts: 3000, tag: 'apply chat NEW', data: 'a n=3' },
		],
	};
	win.DaimondIdentity = { deviceId: () => 'dev-ABC123' };
	let nudges = 0;
	win.DaimondSync = { nudge: () => { nudges += 1; } };

	const posts = [];
	const fetchImpl = (url, opts) => {
		const rec = { url, body: null };
		try { rec.body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { rec.body = null; }
		posts.push(rec);
		const status = cfg.respondStatus || 200;
		return Promise.resolve({ ok: status >= 200 && status < 300, status });
	};

	// `fastTimers`: the module's own delay is recorded (so the 10-minute arm
	// window is provably what was requested) but the callback fires almost at
	// once, so the test does not wait ten real minutes to see it disarm.
	const timerDelays = [];
	const setTimeoutImpl = (fn, ms) => { timerDelays.push(ms); return setTimeout(fn, 1); };

	function loadScript(rel) {
		const bodyText = readFileSync(join(HERE, rel), 'utf8');
		const fn = new Function(
			'window', 'document', 'localStorage', 'fetch',
			'setTimeout', 'clearTimeout', 'console',
			'with (window) {\n' + bodyText + '\n}');
		fn(win, document, localStorage, fetchImpl, setTimeoutImpl, clearTimeout, console);
	}
	loadScript('support.js');

	return {
		win, document, localStorage, posts, body, store,
		diagOn: () => diagOn, setCalls, nudges: () => nudges, timerDelays,
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	console.log('(a) a report carries the build id, the trail and the diag ring');
	{
		const env = makeEnv();
		const rows = env.win.DaimondSupport.reportRows('error.thrown');
		check('the report is non-empty', env.win.DaimondSupport.nonEmpty(rows));
		check('the header row carries the build id',
			rows[0].tag === 'report' && rows[0].data.indexOf('bld_f00d1234') !== -1);
		check('the header row carries the reason',
			rows[0].data.indexOf('reason=error.thrown') !== -1);
		check('a trail row rode along',
			rows.some((r) => r.tag === 'trail page error' && r.data.indexOf('TypeError') !== -1));
		check('a diag row rode along',
			rows.some((r) => r.tag === 'diag apply chat NEW' && r.data === 'a n=3'));

		console.log('    revert: neither ring exists -> only the header row travels');
		const bare = makeEnv({ noTrail: true, noDiag: true });
		const bareRows = bare.win.DaimondSupport.reportRows('x');
		check('a report with no rings is NOT reported as non-empty',
			bareRows.length === 1 && !bare.win.DaimondSupport.nonEmpty(bareRows));
	}

	console.log('(b) a report POSTS to the existing /api/debug-trace gate');
	{
		const env = makeEnv();
		const r = await env.win.DaimondSupport.post('turn.fail');
		check('post() answers ok', r.ok === true);
		check('exactly one POST left', env.posts.length === 1);
		check('to the existing endpoint, no new transport',
			env.posts[0].url === '/api/debug-trace');
		check('carrying the device id and the wire shape the handler accepts',
			env.posts[0].body.v === 1
			&& env.posts[0].body.device === 'dev-ABC123'
			&& Array.isArray(env.posts[0].body.rows)
			&& env.posts[0].body.rows.length === r.rows);
		check('the rows on the wire are the same ones reportRows() built',
			env.posts[0].body.rows.some((row) => row.tag === 'trail page error'));

		console.log('    revert: the gateway declines -> post() says so and does not lie');
		const bad = makeEnv({ respondStatus: 429 });
		const rBad = await bad.win.DaimondSupport.post('x');
		check('a declined post answers ok:false with a reason', rBad.ok === false && !!rBad.why);
	}

	console.log('(c) consent is asked ONCE PER ACCOUNT, then remembered and synced');
	{
		const env = makeEnv();
		check('never asked yet: syncSnapshot() has nothing to say', env.win.DaimondSupport.syncSnapshot() === null);

		const said = [];
		env.win.DaimondSupport.report('error.thrown', (s) => said.push(s));
		const sheet = findById(env.body, 'support-sheet');
		check('the FIRST call opens the consent sheet', !!sheet);
		check('and sends NOTHING before consent is given', env.posts.length === 0);

		const sendBtn = findByClass(sheet, 'report-send');
		check('the sheet has a send button', !!sendBtn);
		fire(sendBtn, 'click');
		await sleep(5);
		check('agreeing sends the report', env.posts.length === 1);
		check('and the caller was told', said.some((s) => /sent/i.test(s)));
		check('agreeing nudges the sync engine, so it reaches the fleet',
			env.nudges() >= 1);
		const snap = env.win.DaimondSupport.syncSnapshot();
		check('syncSnapshot() now carries the decision', !!snap && snap.on === true && snap.at > 0);

		// The first sheet stays on screen with its "Close" button (report.js's own
		// convention: a sent status is shown, never yanked out from under the
		// reader) -- so the property to prove is that a SECOND, already-consented
		// report opens no ADDITIONAL sheet, not that the first one vanished.
		const sheetsBefore = countById(env.body, 'support-sheet');
		env.win.DaimondSupport.report('turn.fail', () => {});
		await sleep(5);
		check('a SECOND report, same account, sends straight away with no new sheet',
			env.posts.length === 2 && countById(env.body, 'support-sheet') === sheetsBefore);

		console.log('    revert: a FRESHER "no" from another device must win');
		env.win.DaimondSupport.adoptSync({ on: false, at: snap.at + 1000 });
		check('the fresher decision overwrote consent', env.win.DaimondSupport.consented() === false);
		console.log('    revert: an OLDER "yes" from another device must NOT win');
		env.win.DaimondSupport.adoptSync({ on: true, at: snap.at - 1000 });
		check('the stale decision changed nothing', env.win.DaimondSupport.consented() === false);
	}

	console.log('(d) arm() auto-arms the diag ring after a simulated error.thrown, and lets go again');
	{
		const env = makeEnv({ diagOnAtStart: false });
		check('diagnostics start off', env.diagOn() === false);
		env.win.DaimondSupport.arm('error.thrown');
		check('arm() turns diagnostics ON', env.diagOn() === true);
		check('the requested window is ten minutes',
			env.timerDelays.some((ms) => ms === 10 * 60 * 1000 + 250));
		await sleep(20);
		check('and switches it back OFF once the window elapses', env.diagOn() === false);
		check('the off was recorded as an auto-arm expiry, not a person’s choice',
			env.setCalls.some((c) => c.v === false && /expired/.test(c.why || '')));

		console.log('    revert: a ring the PERSON armed by hand must never be switched off by this file');
		const kept = makeEnv({ diagOnAtStart: true });
		kept.win.DaimondSupport.arm('turn.fail');
		check('arm() leaves an already-on ring alone', kept.setCalls.length === 0);
		// The STORAGE side-effect, not just the ring: finding #1's bug was that
		// `arm()` wrote `armed-until` (and, this fix adds, `armed-by-us`) even
		// on this branch -- outside the `!on()` guard -- so a later reload's
		// `resumeArm()` read that marker back as "I own this" and wiped a ring
		// the person armed by hand. Neither key may exist after this call.
		check('and it writes NO armed-until marker for a ring it does not own',
			!kept.store.has('daimond-support-armed-until'));
		check('nor an armed-by-us marker',
			!kept.store.has('daimond-support-armed-by-us') || kept.store.get('daimond-support-armed-by-us') !== '1');
		await sleep(20);
		check('and the window elapsing never turns OFF a ring this file did not arm',
			kept.diagOn() === true);
	}

	console.log('(e) a user-armed ring survives error -> reload -> its own would-be expiry (finding #1)');
	{
		// One shared `store`, across two module loads, simulates a page reload:
		// diag.js's own ring state (here, `diagOnAtStart`) persists exactly as
		// it does in the browser; support.js's markers are whatever this file
		// itself wrote to that same store.
		const store = new Map();
		const env1 = makeEnv({ store, diagOnAtStart: true });
		env1.win.DaimondSupport.arm('error.thrown');
		check('arm() does not claim a ring it found already on', env1.setCalls.length === 0);
		check('and leaves the store untouched', !store.has('daimond-support-armed-until') && !store.has('daimond-support-armed-by-us'));

		const env2 = makeEnv({ store, diagOnAtStart: true });
		check('reload: resumeArm() does not adopt a ring it never armed (no ownership marker on disk)',
			env2.setCalls.length === 0);
		await sleep(20);      // long enough that a WRONGLY-adopted 10-minute window's timer would have fired
		check('the ring is still on well after its own window would have expired',
			env2.diagOn() === true);
	}

	console.log('(f) diagnostics does not stay stuck on after a tab closed mid-window and reopened later (finding #2)');
	{
		const store = new Map();
		const env1 = makeEnv({ store, diagOnAtStart: false });
		env1.win.DaimondSupport.arm('error.thrown');
		check('arm() switched the ring on and took ownership',
			env1.diagOn() === true && env1.setCalls.some((c) => c.v === true));
		// The tab closes here -- no timer ever runs. Back-date the persisted
		// deadline to simulate the window having elapsed while it was shut.
		store.set('daimond-support-armed-until', String(Date.now() - 1000));

		const env2 = makeEnv({ store, diagOnAtStart: true });   // the ring, as diag.js persisted it: still on
		check('reopening after the window elapsed disarms IMMEDIATELY on boot, not stuck on',
			env2.diagOn() === false);
		check('the opt-in promise holds: the off is recorded as an auto-arm expiry',
			env2.setCalls.some((c) => c.v === false && /expired/.test(c.why || '')));
	}

	console.log('(g) a report is redacted before it leaves the device (finding #3)');
	{
		const env = makeEnv({
			diagRows: [{
				ts:   3000,
				tag:  'llm error',
				data: 'provider said: "invalid key sk-abcdEFGH12345678, Authorization: '
					+ 'Bearer abc.def.ghi" while writing diamonds/d_9f8e7/notes/plan.md',
			}],
		});
		check('scrub() masks a bare API key',
			env.win.DaimondSupport.scrub('sk-abcdEFGH12345678').indexOf('sk-abcdEFGH12345678') === -1);
		check('scrub() masks a Bearer token',
			env.win.DaimondSupport.scrub('Bearer abc.def.ghi').indexOf('abc.def.ghi') === -1);
		check('scrub() reduces a Diamond-relative path to its basename',
			env.win.DaimondSupport.scrub('diamonds/d_9f8e7/notes/plan.md') === 'plan.md');

		const rows = env.win.DaimondSupport.reportRows('error.thrown');
		const diagRow = rows.find((r) => r.tag.indexOf('diag') === 0);
		check('a real report row carrying a key and a path comes out masked',
			!!diagRow
			&& diagRow.data.indexOf('sk-abcdEFGH12345678') === -1
			&& diagRow.data.indexOf('abc.def.ghi') === -1
			&& diagRow.data.indexOf('diamonds/d_9f8e7') === -1
			&& diagRow.data.indexOf('plan.md') !== -1);
	}

	console.log('(h) a full report is trimmed to fit the gateway\'s body cap (finding #7)');
	{
		const env = makeEnv({
			diagRows: (() => {
				// A fullest-plausible ring: 500 rows near diag.js's own MAX, each
				// carrying data near its own 300-byte cap -- big enough on its own
				// to clear the 256 KiB gateway limit (debug_trace.rs::MAX_BODY).
				const rows = [];
				for (let i = 0; i < 500; i++) {
					rows.push({ ts: i, tag: 'apply chat NEW', data: 'x'.repeat(600) + ' n=' + i });
				}
				return rows;
			})(),
		});
		const full = env.win.DaimondSupport.reportRows('error.thrown');
		const fullBytes = Buffer.byteLength(JSON.stringify({ v: 1, device: 'dev-ABC123', rows: full }), 'utf8');
		check('the untrimmed report would exceed the gateway\'s 256 KiB cap (the case this fix trims)',
			fullBytes > 256 * 1024);

		const trimmed = env.win.DaimondSupport.fitBudget(full);
		const trimmedBytes = Buffer.byteLength(JSON.stringify({ v: 1, device: 'dev-ABC123', rows: trimmed }), 'utf8');
		check('fitBudget() brings it under the gateway\'s cap', trimmedBytes <= 256 * 1024);
		check('the header row survives the trim', trimmed[0] === full[0]);
		check('the NEWEST rows survive over the oldest (oldest dropped first)',
			trimmed[trimmed.length - 1].data === full[full.length - 1].data);
		check('something was actually dropped', trimmed.length < full.length);

		console.log('    revert: post() must apply the same trim before it builds the request body');
		const r = await env.win.DaimondSupport.post('error.thrown');
		check('post() itself never sends an over-budget body',
			r.rows <= trimmed.length + 1 && r.rows < full.length);
	}

	console.log('(i) turn.fail\'s only route -- the chat error line -- carries a one-tap report (finding #4)');
	{
		// The REAL daimond.js source, lifted with a brace-balanced scan (the same
		// technique tailwiring.test.mjs uses) -- not retyped, so a regression in
		// the actual wired function is what reddens this, not a copy of it.
		const daimondSrc = readFileSync(join(HERE, 'daimond.js'), 'utf8');
		function extractFn(src, name) {
			const start = src.indexOf('\n\tfunction ' + name + '(');
			if (start < 0) throw new Error('function not found in daimond.js: ' + name);
			const brace = src.indexOf('{', start);
			let depth = 0, i = brace;
			for (; i < src.length; i++) {
				if (src[i] === '{') depth++;
				else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
			}
			return src.slice(start + 1, i);
		}
		const appendErrorSrc = extractFn(daimondSrc, 'appendError');

		// A minimal DOM stub covering exactly what `appendError` touches:
		// `innerHTML` assigning the one child it ever assigns, `querySelector`
		// finding it back by class, and plain child tracking otherwise.
		function node(tag) {
			const n = {
				tagName: tag, className: '', type: '', disabled: false, textContent: '',
				children: [], _listeners: {},
				set innerHTML(html) {
					this.children = /chat-msg-content/.test(html) ? [node('div')] : [];
					if (this.children[0]) this.children[0].className = 'chat-msg-content';
				},
				get innerHTML() { return ''; },
				querySelector(sel) {
					const cls = sel.replace('.', '');
					return this.children.find((c) => (c.className || '').indexOf(cls) !== -1) || null;
				},
				appendChild(c) { this.children.push(c); return c; },
				addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
			};
			return n;
		}
		const doc = { createElement: (tag) => node(tag) };

		const armed = [], reported = [], tagged = [], posted = [];
		let pins = 0;
		const win = {
			DaimondSupport: {
				arm:    (reason) => armed.push(reason),
				report: (reason, say) => { reported.push(reason); say('Sent — thank you.'); },
			},
		};
		const fn = new Function('window', 'document', 'tOr', 'friendlyError', 'tagTurn', 'postToChat', 'pinBottom',
			'with (window) {\n' + appendErrorSrc + '\nreturn appendError;\n}\n');
		const appendError = fn(win, doc,
			(k, fallback) => fallback,
			(m) => String(m),
			(d) => tagged.push(d),
			(d) => posted.push(d),
			() => { pins++; });

		appendError('the turn failed');
		check('appendError arms the diag ring, so the tap has something to send',
			armed.indexOf('chat.error') !== -1);
		check('appendError posted exactly one message to the chat', posted.length === 1);
		const btn = posted[0] && posted[0].children.find((c) => (c.className || '').indexOf('chat-err-report') !== -1);
		check('a "Report this" affordance rides on the error line itself', !!btn && btn.textContent === 'Report this');

		btn._listeners.click[0]();
		check('tapping it reports through the SAME DaimondSupport route as the toast',
			reported.length === 1 && reported[0] === 'chat.error');

		console.log('    revert: this fails if appendError() stops adding a report affordance, or DaimondSupport.arm/report is dropped from it');
	}

	console.log('(j) the error toast\'s "Report this" result reaches a LIVE element, and a failed send can be retried (S-UI #1)');
	{
		// The REAL daimond.js `errorToastWithReport`, lifted the same way (i) lifts
		// `appendError`: a brace-balanced scan, not a retyped copy.
		const daimondSrc = readFileSync(join(HERE, 'daimond.js'), 'utf8');
		function extractFn(src, name) {
			const start = src.indexOf('\n\tfunction ' + name + '(');
			if (start < 0) throw new Error('function not found in daimond.js: ' + name);
			const brace = src.indexOf('{', start);
			let depth = 0, i = brace;
			for (; i < src.length; i++) {
				if (src[i] === '{') depth++;
				else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
			}
			return src.slice(start + 1, i);
		}
		const toastSrc = extractFn(daimondSrc, 'errorToastWithReport');

		// setTimeout/clearTimeout never actually fire here -- the test drives the
		// toast's own dismiss clock by hand, so it can prove a tap cancels the
		// PENDING auto-removal rather than waiting 8.6 real seconds to find out.
		const scheduled = [];
		const cleared = [];
		const timers = new Map();
		let nextTimerId = 1;
		const fakeSetTimeout = (fn, ms) => {
			const id = nextTimerId++;
			scheduled.push({ id, ms });
			timers.set(id, fn);
			return id;
		};
		const fakeClearTimeout = (id) => { cleared.push(id); timers.delete(id); };
		const fire = (id) => { const fn = timers.get(id); timers.delete(id); if (fn) fn(); };

		const bodyEl = makeNode('body');
		const doc = { createElement: (tag) => makeNode(tag), body: bodyEl };

		const reported = [];
		let consented = true;
		let sayCb = null;
		const win = {
			DaimondSupport: {
				consented: () => consented,
				report: (reason, say) => { reported.push(reason); sayCb = say; },	// answers later -- simulates the real network round trip
			},
		};

		const fn = new Function('window', 'document', 'tOr', 'toast', 'setTimeout', 'clearTimeout',
			'with (window) {\n' + toastSrc + '\nreturn errorToastWithReport;\n}\n');
		const errorToastWithReport = fn(win, doc,
			(k, fallback) => fallback,
			() => { throw new Error('toast() fallback must not run for a text/reason that never throws'); },
			fakeSetTimeout, fakeClearTimeout);

		errorToastWithReport('Something went wrong.', 'error.thrown');
		const box = bodyEl.children[0];
		const btn = box.children.find((c) => c.tagName === 'button');
		check('the toast opens with its own auto-dismiss already scheduled',
			scheduled.length === 2 && scheduled[0].ms === 8000 && scheduled[1].ms === 8600);

		btn._listeners.click[0]();
		check('tapping "Report this" cancels the toast\'s pending auto-removal',
			cleared.indexOf(scheduled[0].id) !== -1 && cleared.indexOf(scheduled[1].id) !== -1);
		check('the tap disables the button while the send is in flight', btn.disabled === true);

		console.log('    revert: firing the (now-cancelled) 8.6s removal must be a no-op -- the pre-fix box would already be gone here');
		fire(scheduled[1].id);
		check('the box is still attached once the old 8.6s mark passes', bodyEl.children.indexOf(box) !== -1);

		sayCb('Could not send: the server declined (429).');
		check('a failed send\'s result is written into the STILL-LIVE button', btn.textContent === 'Could not send: the server declined (429).');
		check('a failed send does not leave the button permanently disabled', btn.disabled === false);
		check('the toast re-arms its own dismiss clock once the result is shown',
			scheduled.length === 4 && scheduled[2].ms === 3600 && scheduled[3].ms === 4200);

		btn._listeners.click[0]();
		check('the re-enabled button genuinely retries -- a second report is sent', reported.length === 2);

		console.log('    revert: the not-yet-consented path (first-ever tap, opens the consent sheet) must be untouched');
		consented = false;
		reported.length = 0;
		scheduled.length = 0;
		errorToastWithReport('Something else went wrong.', 'error.thrown');
		const box2 = bodyEl.children[bodyEl.children.length - 1];
		const btn2 = box2.children.find((c) => c.tagName === 'button');
		btn2._listeners.click[0]();
		check('the first-ever tap still calls DaimondSupport.report', reported.length === 1);
		check('an unconsented tap leaves the toast\'s own auto-dismiss running (the consent sheet owns its own timing)',
			cleared.indexOf(scheduled[0].id) === -1 && cleared.indexOf(scheduled[1].id) === -1);
	}

	console.log('\n' + (failures ? 'FAIL' : 'PASS') + ' — support.js (D-20260920-02)');
	process.exit(failures ? 1 : 0);
}

main();

// verify_webwatch.mjs — a slow human's approval still lands in the panel.
//
// Opening an unapproved site puts a question to a person, and the panel stops
// waiting at 45s so the model is not left hanging on a spinner. The EXTENSION
// does not stop: the grant window is still on screen, and when the user finally
// clicks Allow the tab really opens and really is driven. The reply that comes
// back after our wait used to be dropped, so the user watched Daimond drive a
// page the panel said was never approved.
//
// This drives the real DaimondWeb through a FAKE extension bridge: a stubbed
// chrome.runtime that holds every `open` message until the test answers it, so
// "the human answered late" is an ordinary function call. Five cases:
//
//	A  a late approval adopts the page and says so;
//	B  a late refusal replaces the stale note with the real reason;
//	C  a page opened in the meantime is never stomped by a late answer;
//	D  a retry while the question is up sends no SECOND open (which would be a
//	   second grant window), and collects the answer as its own tool result;
//	E  after the late window there is no watcher left: the reply changes nothing.
//
// Needs dev/serve.mjs on :8777. No gateway, no model, no extension.
//
//   node dev/verify_webwatch.mjs            # all cases
//   WEBWATCH_CASES=AB node dev/verify_webwatch.mjs
import { open, shot, errors } from './harness.mjs';

const CASES = (process.env.WEBWATCH_CASES || 'ABCDE').toUpperCase();
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'webwatch' });
const page = s.page;

// ── The fake hands ──────────────────────────────────────────────────
// Everything but `open` answers at once; `open` is held, and the test decides
// when — and whether — the human said yes.
const installed = await page.evaluate(() => {
	try {
		if (!window.chrome) window.chrome = {};
		window.__ext = { sent: [], pend: [] };
		window.chrome.runtime = {
			id: 'mockhands',
			lastError: undefined,
			sendMessage: function (id, msg, cb) {
				window.__ext.sent.push(msg);
				if (msg.cmd === 'open') { window.__ext.pend.push({ msg: msg, cb: cb }); return; }
				// status is polled by the mirror once a page is adopted; answering
				// with nothing to say leaves the panel's own state alone.
				setTimeout(function () { cb({ ok: true, mode: 'agent' }); }, 0);
			},
		};
		document.documentElement.dataset.daimondHands = 'mockhands';
		window.dispatchEvent(new CustomEvent('daimond-hands', { detail: { id: 'mockhands' } }));
		return true;
	} catch (e) { return String(e); }
});
check('the fake extension bridge installs', installed === true, String(installed));
await page.waitForTimeout(300);
check('the panel adopts it as its driver', await page.evaluate(() => window.DaimondWeb.hasHands()));

// The rule is minutes long by design; a test cannot spend minutes proving it.
// Without the hook (an unfixed build) the real waits are used, which is slow but
// still measures the right thing.
const hook = await page.evaluate(() => !!window.DaimondWeb._setWaitsForTest);
console.log(hook ? '  (timing hook present)' : '  (NO timing hook — using the real 45s/4min waits)');
const OPENW = hook ? 1200 : 45000;
const LATEW = hook ? 20000 : 240000;
if (hook) await page.evaluate((w) => window.DaimondWeb._setWaitsForTest(w), { open: OPENW, late: LATEW });

const clear    = () => page.evaluate(() => { window.__ext.sent = []; window.__ext.pend = []; });
const noteText = () => page.evaluate(() => (document.getElementById('web-note') || {}).innerText || '');
const status   = () => page.evaluate(() => window.DaimondWeb.status());
const opens    = () => page.evaluate(() => window.__ext.sent.filter((m) => m.cmd === 'open').map((m) => m.url));
/// Answer a held `open` as the extension would. `match` picks which one, when
/// more than one question is outstanding; the oldest otherwise.
const answer = (v, match) => page.evaluate(({ r, m }) => {
	const i = m ? window.__ext.pend.findIndex((p) => String(p.msg.url).includes(m)) : 0;
	if (i < 0 || !window.__ext.pend[i]) return false;
	window.__ext.pend.splice(i, 1)[0].cb(r);
	return true;
}, { r: v, m: match || '' });

/// Start an open the way a tool call does — without awaiting it, because it
/// blocks until a human answers. What it finally settles to is stashed for us.
const ask = (url, tag) => page.evaluate(({ url, tag }) => {
	window.__res = window.__res || {};
	window.__res[tag] = { done: false };
	window.DaimondWeb.open(url).then(
		(r) => { window.__res[tag] = { done: true, ok: true, r: r }; },
		(e) => { window.__res[tag] = { done: true, ok: false, err: String((e && e.message) || e) }; });
}, { url, tag });

const result = (tag) => page.evaluate((t) => (window.__res || {})[t] || { done: false }, tag);

/// Wait for a tool call to settle — the panel's own wait plus slack, never a
/// bare sleep, so a loaded machine does not read as a failure.
async function settled(tag, extra = 6000) {
	const until = Date.now() + OPENW + extra;
	for (;;) {
		const r = await result(tag);
		if (r.done) return r;
		if (Date.now() > until) return r;
		await page.waitForTimeout(150);
	}
}

// ── A: a late approval adopts the page ──────────────────────────────
if (CASES.includes('A')) {
	console.log('\nA — the user approves after the panel has given up');
	await clear();
	await ask('https://slow.example/one', 'A');
	const timedOut = await settled('A');
	check('the wait ends, and the model is told to try again',
		timedOut.done && !timedOut.ok && /try web_open|approve this site/i.test(timedOut.err || ''), timedOut.err);
	const before = await noteText();
	check('the panel says the site was not approved', /was not approved/i.test(before), before.replace(/\n/g, ' / '));

	check('the answer arrives late', await answer({ ok: true, url: 'https://slow.example/one', title: 'Slow', mode: 'agent' }));
	await page.waitForTimeout(900);
	const st = await status();
	const after = await noteText();
	check('a late approval adopts the page', st.driver === 'ext' && /slow\.example/.test(st.url) && st.mode === 'agent',
		JSON.stringify(st));
	check('the panel says the site was approved after all', /was approved/i.test(after), after.replace(/\n/g, ' / '));
	check('and it no longer claims the site was refused', !/was not approved/i.test(after), after.replace(/\n/g, ' / '));
	check('the driving note is there too', /driving/i.test(after), after.replace(/\n/g, ' / '));
	// Adoption is not just words: the panel starts mirroring the tab, which is
	// the one behaviour a discarded reply cannot fake.
	const polls = await page.evaluate(() => window.__ext.sent.filter((m) => m.cmd === 'status').length);
	check('the panel starts following the adopted tab', polls > 0, polls + ' status polls');
	await shot(s, 'webwatch-late-approved');
}

// ── B: a late refusal replaces the stale note ───────────────────────
if (CASES.includes('B')) {
	console.log('\nB — the user refuses after the panel has given up');
	await page.evaluate(() => window.DaimondWeb.close());
	await clear();
	await ask('https://nope.example/two', 'B');
	const timedOut = await settled('B');
	check('the wait ends first', timedOut.done && !timedOut.ok, JSON.stringify(timedOut));
	const before = await noteText();

	check('the refusal arrives late', await answer({ ok: false,
		error: 'The user declined: Daimond may not operate nope.example. Do not ask for it again.' }));
	await page.waitForTimeout(700);
	const after = await noteText();
	check('a late refusal rewrites the stale note', after !== before,
		'before: ' + before.replace(/\n/g, ' / '));
	check('it says the answer came after the wait', /after Daimond had/i.test(after), after.replace(/\n/g, ' / '));
	check('it still says the site was not approved', /was not approved/i.test(after), '');
	check('and nothing was adopted', !/driving/i.test(after), after.replace(/\n/g, ' / '));
}

// ── C: a page opened since must win ─────────────────────────────────
if (CASES.includes('C')) {
	console.log('\nC — a page opened in the meantime is not stomped');
	await page.evaluate(() => window.DaimondWeb.close());
	await clear();
	await ask('https://stomp.example/three', 'C');
	const timedOut = await settled('C');
	check('the wait ends first', timedOut.done && !timedOut.ok, JSON.stringify(timedOut));

	// The user asks for somewhere else, and that site is already approved, so it
	// opens at once. This is now the page the panel is showing.
	await ask('https://fresh.example/', 'C2');
	await page.waitForTimeout(200);
	await answer({ ok: true, url: 'https://fresh.example/', title: 'Fresh', mode: 'agent' }, 'fresh.example');
	const fresh = await settled('C2', 2000);
	check('a new page opens while the old question is still out', fresh.done && fresh.ok === true, JSON.stringify(fresh));

	check('the old approval arrives late', await answer({ ok: true, url: 'https://stomp.example/three', title: 'Stomp', mode: 'agent' }, 'stomp.example'));
	await page.waitForTimeout(900);
	const st = await status();
	check('the late answer does not stomp the newer page', /fresh\.example/.test(st.url) && !/stomp/.test(st.url),
		JSON.stringify(st));
	const after = await noteText();
	check('and the panel still names the newer page', /fresh\.example/.test(after) && !/stomp\.example/.test(after),
		after.replace(/\n/g, ' / '));
}

// ── D: the retry path ───────────────────────────────────────────────
if (CASES.includes('D')) {
	console.log('\nD — the model retries while the question is still on screen');
	await page.evaluate(() => window.DaimondWeb.close());
	await clear();
	await ask('https://retry.example/four', 'D1');
	const first = await settled('D1');
	check('the first call gives up', first.done && !first.ok, JSON.stringify(first));

	await ask('https://retry.example/four', 'D2');
	await page.waitForTimeout(600);
	const sent = await opens();
	check('the retry sends no second open — no second grant window', sent.length === 1, JSON.stringify(sent));

	check('the approval arrives late', await answer({ ok: true, url: 'https://retry.example/four', title: 'Retry', mode: 'agent' }));
	const second = await settled('D2', 2000);
	check('the retry collects the answer as its own result', second.done && second.ok === true, JSON.stringify(second));
	const st = await status();
	check('and the panel is driving the page', st.driver === 'ext' && /retry\.example/.test(st.url), JSON.stringify(st));
}

// ── E: the late window really does close ────────────────────────────
if (CASES.includes('E')) {
	if (!hook) {
		console.log('\nE — skipped: without the timing hook this case waits out the whole late window');
	} else {
		console.log('\nE — after the late window, nothing is listening');
		await page.evaluate(() => window.DaimondWeb.close());
		await page.evaluate((w) => window.DaimondWeb._setWaitsForTest(w), { open: 600, late: 1200 });
		await clear();
		await ask('https://gone.example/five', 'E');
		for (let i = 0; i < 40; i++) { if ((await result('E')).done) break; await page.waitForTimeout(150); }
		const before = await noteText();
		await page.waitForTimeout(2600);          // past 600 + 1200, with slack
		check('a reply after the late window is still delivered by the browser',
			await answer({ ok: true, url: 'https://gone.example/five', title: 'Gone', mode: 'agent' }));
		await page.waitForTimeout(700);
		const after = await noteText();
		check('it adopts nothing', !/was approved/i.test(after) && !/driving/i.test(after), after.replace(/\n/g, ' / '));
		check('and the panel still says what it said', /was not approved/i.test(after), after.replace(/\n/g, ' / '));
	}
}

await page.evaluate(() => window.DaimondWeb.close()).catch(() => {});
await shot(s, 'webwatch-end');

const errs = errors(s).filter((e) => !/Failed to load resource.*\b(401|402|404|502|503)\b/.test(e));
check('the app logged no console errors', errs.length === 0, errs.join(' | '));

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
await s.close();
process.exit(bad.length ? 1 : 0);

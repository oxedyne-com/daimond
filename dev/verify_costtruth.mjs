// verify_costtruth.mjs — what a turn cost, said by the only party that knows.
//
// Daimond priced every turn from a table it carries: tokens times a surveyed rate. That is the
// right answer when nobody better has spoken, and the WRONG answer the moment a provider states
// its own figure — which routers do, on every reply, in `usage.cost`, alongthe count of prompt
// tokens they served from cache rather than charged for. A 10k-token prompt that was 90% cache
// hits costs a fraction of what a table says it costs, and the app was billing the table.
//
// Three claims, and the first is the one the whole feature rests on:
//
//   1. A REPORTED cost is recorded verbatim. Not approximated, not re-derived, not blended with
//      the table -- the ledger entry carries the provider's own number and is marked as reported,
//      so a total containing it is not dressed up with an "≈".
//   2. The account balance in the rail is fresh. Almost every credit-spending gateway reply
//      states the resulting balance; the app used to throw those away, so the header sat at
//      whatever the last explicit /api/balance call had said. Spending money must move the
//      number, with no reload and no panel opened.
//   3. Bytes written by the PAGE (a compiled PDF, a saved message, an upload) go through the
//      wasm write, which is what applies the per-account namespace. The page used to walk the
//      origin OPFS root itself, so a secondary account's files landed in the primary account's
//      workspace -- one account's PDFs readable by another person at the same browser.
//
// The gateway is fetch-stubbed (as verify_credits does) rather than run: check 2 needs a reply
// that STATES a lower balance, which is a two-line stub and a provisioned account plus a real
// spend otherwise.
import { open, signInAs, connectMock, chat, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// The figures the mock will report. Chosen so no table could arrive at them by accident:
// COST is not tokens-times-any-plausible-rate, and CACHED is 90% of the prompt, which is the
// case a table cannot express at all.
const IN     = 10240;
const OUT    = 128;
const COST   = 0.0021;
const CACHED = 9216;

// The stubbed gateway's balance, in minor units, before and after the spend.
const BAL_BEFORE = 840;     // $8.40
const BAL_AFTER  = 500;     // $5.00

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (body, status = 200) => ({
	status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
});

const ACCOUNT_NS = 'd~costtruth';       // a stand-in for a secondary account's namespace

let bal = BAL_BEFORE;

/// The gateway's four boot calls, the balance, and the one endpoint that spends.
///
/// Installed BEFORE the identity is unlocked, so the app's own `afterUnlock()` runs bootstrap
/// against a gateway that answers -- which is what paints the account row in the rail in the
/// first place. Stubbing after sign-in would leave the row reading "unreachable" from boot, and
/// a check against it would be measuring the harness rather than the app.
async function stubGateway(page) {
	await page.route('**/api/account',        r => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-ct', challenge_id: 'cid-ct' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: bal, currency: 'usd', entries: [] })));
	// Not Pro: nothing here tests a Pro surface, and a Pro account starts sync pushing at
	// endpoints this stub does not answer.
	await page.route('**/api/licence',        r => r.fulfill(json({ ok: true, pro: false })));
	// The credit-spending action. Reading a page costs credits, and the reply states what is
	// left -- which is the shape nearly every spending endpoint has.
	await page.route('**/api/web/fetch', r => {
		bal = BAL_AFTER;
		return r.fulfill(json({ ok: true, credits_minor: bal, currency: 'usd',
			url: 'https://example.test/', title: 'Example', text: 'A page the agent read.' }));
	});
}

const s = await open({ name: 'costtruth', signIn: false });
const p = s.page;
await stubGateway(p);
await signInAs(s, 'costtruth');
await connectMock(s);
await p.waitForTimeout(800);

// ── 1. A reported cost is what is recorded ──────────────────────────────

await p.evaluate(() => { try { localStorage.removeItem('daimond-ledger'); } catch (e) {} });
await chat(s, `@usage ${IN} ${OUT} ${COST} ${CACHED}`);
await p.waitForTimeout(600);

const led = await p.evaluate(() => {
	var raw = [];
	try { raw = JSON.parse(localStorage.getItem('daimond-ledger') || '[]'); } catch (e) {}
	return { n: raw.length, last: raw[raw.length - 1] || null };
});
const e = led.last || {};
check('the turn reaches the ledger at all', led.n >= 1, led.n + ' entries');
check("the ledger holds the PROVIDER's figure, exactly",
	e.u === COST, `u = ${e.u} (wanted ${COST})`);
check('and marks it as reported, so no total dresses it as an estimate',
	e.r === 1 && !e.e, `r = ${e.r}, e = ${e.e}`);
check('the cached prompt tokens are carried, not dropped',
	e.ca === CACHED, `ca = ${e.ca} (wanted ${CACHED})`);
check('and the provider is named, so a per-key breakdown can find it',
	typeof e.pv === 'string' && e.pv.length > 0, `pv = ${JSON.stringify(e.pv)}`);
// The token counts must still be the turn's DELTA, not the session cumulative: the reported
// cost rides the same accounting, and a bug that double-counted one would double-count both.
check('the token counts are the turn, not the session total',
	e.p === IN && e.c === OUT, `p = ${e.p}, c = ${e.c}`);

// A second turn on the same chat: the deltas must not compound. This is where a cumulative
// read masquerading as a delta shows itself -- the second entry would carry 2×IN.
await chat(s, `@usage ${IN} ${OUT} ${COST} ${CACHED}`);
await p.waitForTimeout(600);
const led2 = await p.evaluate(() => {
	var raw = [];
	try { raw = JSON.parse(localStorage.getItem('daimond-ledger') || '[]'); } catch (e) {}
	return raw[raw.length - 1] || null;
});
check("a second turn's cost is its own, not the session's running total",
	led2 && led2.u === COST && led2.p === IN && led2.ca === CACHED,
	led2 ? `u = ${led2.u}, p = ${led2.p}, ca = ${led2.ca}` : '(no entry)');

// ── 2. Spending money moves the number in the rail ──────────────────────
//
// No reload, no panel opened: the row has to repaint because the gateway reply said what was
// left and something was listening for it.
//
// The spend is `DaimondWeb.fetch`, which is the exact function the agent's `web_fetch` tool
// reaches through the wasm -- and deliberately NOT a whole agent turn, because a turn ends by
// repainting most of the app anyway. Driving it through a turn would go green on the end-of-turn
// repaint and prove nothing about whether a spend is heard.

const railBefore = await p.evaluate(() =>
	(document.getElementById('astat-account') || {}).textContent || '');
check('the rail shows the balance before the spend',
	/8\.40/.test(railBefore), railBefore.trim());

const spent = await p.evaluate(async () => {
	try { await window.DaimondWeb.fetch('https://example.test/'); return ''; }
	catch (e) { return String(e && e.message ? e.message : e); }
});
await p.waitForTimeout(700);
const railAfter = await p.evaluate(() =>
	(document.getElementById('astat-account') || {}).textContent || '');
check('the spend went through', spent === '', spent);
check('spending credits refreshes the balance in the rail, with no reload and no panel opened',
	railAfter !== railBefore && /5\.00/.test(railAfter),
	`before "${railBefore.trim()}" → after "${railAfter.trim()}"`);

// ── 3. The page's own writes go through the wasm, and the namespace ─────
//
// A secondary account resolves the workspace inside its own OPFS subdirectory. The wasm write
// applies that; a hand-rolled `navigator.storage.getDirectory()` walk in the page cannot. So
// the namespace is set and a file is written the way a USER writes one -- the Workspace panel's
// upload, which shares `writeWorkspaceBytes` with the Typst compile and with saved mail -- and
// the question is which root the bytes landed in.
//
// A real second account is not created: what is under test is which root the write resolves
// against, and setting the namespace is the whole of what a second account does to it.

await p.evaluate(() => {
	// The panel must be open for its upload control to exist.
	try { if (window.DaimondPanels) DaimondPanels.show('work'); } catch (e) {}
});
await p.waitForTimeout(600);
await p.evaluate(async (ns) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	mod.set_account_ns(ns);
}, ACCOUNT_NS);

const NAME = 'ns-probe.txt';
const chooser = p.waitForEvent('filechooser', { timeout: 8000 });
await p.click('[data-act="upload"]', { force: true });
await (await chooser).setFiles({
	name: NAME, mimeType: 'text/plain', buffer: Buffer.from('written under a namespace'),
});
await p.waitForTimeout(1200);

const landed = await p.evaluate(async ({ ns, name }) => {
	const root = await navigator.storage.getDirectory();
	const at = async (d, n) => { try { await d.getFileHandle(n); return true; } catch (e) { return false; } };
	let sub = null;
	try { sub = await root.getDirectoryHandle(ns); } catch (e) { sub = null; }
	return {
		inNamespace: sub ? await at(sub, name) : false,
		atRoot:      await at(root, name),
		nsExists:    !!sub,
	};
}, { ns: ACCOUNT_NS, name: NAME });

check("a page write lands in the account's own namespace",
	landed.inNamespace === true, `in ${ACCOUNT_NS}/: ${landed.inNamespace}, namespace present: ${landed.nsExists}`);
check("and NOT in the primary account's workspace",
	landed.atRoot === false, `at the OPFS root: ${landed.atRoot}`);

// Put the namespace back, so nothing after this point is reading a stranger's root.
await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	mod.set_account_ns('');
});

await shot(s, 'costtruth');
const errs = s.errs.filter(x => !/favicon|404|401|net::ERR/.test(x));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);

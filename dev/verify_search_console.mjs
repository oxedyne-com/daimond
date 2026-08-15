// verify_search_console.mjs -- the operator console's Providers card, and what
// the console shows of what search costs.
//
// One card holds the two outside services this gateway spends at: the model
// host that mints inference keys, and the search engine a Daimond-credits
// search runs on. It is a card that handles credentials, so most of what is
// checked here is what it must NOT do.
//
// The second half is the other question an operator with a paid key asks: how
// much is it costing, and on which engine. Every search a user paid for was
// invisible here until 2026-08-10 -- `search:brave` matched no arm of
// `LedgerEntry::category`, so it was categorised `other`, and the daily chart
// drew four categories out of the six the gateway could name. Inference spend
// went the same way from 17 July and storage spend from 21 July: charged,
// counted in the headline total, drawn nowhere. So the checks below are less
// about search than about the class: a category the gateway names and the
// console does not draw must be impossible to lose silently.
//
// The properties, and why each is worth a check rather than a comment:
//
//   * NO VALUE IS EVER READ BACK. `gateway/src/secrets.rs` states this as the
//     reason the module exists apart from `settings`: a knob is a price a
//     viewer may read, a credential is a secret nobody may read back. The
//     console half of that is asserted by planting a `value` field the real
//     gateway does not send and proving no part of the page renders it -- a
//     console that merely happens not to receive one is not the same as a
//     console that cannot show one.
//   * A WRONG PASTE IS REFUSED BEFORE IT TRAVELS, and the refusal names the
//     key that was expected and the start of what was pasted. "Invalid" sends
//     the operator back to the vendor's dashboard to find out what for.
//   * `serper` IS NOT IN THE CREDITS PULLDOWN. §3 of dev/SEARCH_CONTRACT.md:
//     it resells Google's results, so its business rests on an arbitrage that
//     can end without notice. A user may take that risk with their own key;
//     this gateway may not take it on their behalf while billing for it.
//   * SETTING A KEY NEEDS NO RESTART. That is the whole point of the secrets
//     module, and a card whose help text implies otherwise has undone it.
//   * EVERY CATEGORY THE GATEWAY NAMES IS DRAWN, and anything it counted that
//     the page cannot name is drawn as a remainder rather than subtracted. The
//     day's `total` is what that is measured against, which is why the gateway
//     sends one.
//   * SEARCH SPEND IS BROKEN DOWN BY ENGINE. A cap set at a vendor is set on
//     one engine, in queries, so a category total cannot answer the question
//     the cap raises.
//   * A FIGURE THAT DID NOT ARRIVE IS NOT DRAWN AS ZERO, and a genuine zero
//     still reads as zero. `Store::scan_prefix` walks the whole key space, and
//     on a 952 MB store with 3,467 accounts the ten views this console fires at
//     once queue on one bot per zone and three of them time out every round.
//     The gateway answers that with `503 {ok:false, error, unread, …every
//     figure that WAS read}` and deliberately OMITS what it could not read
//     rather than zeroing it -- see `Unread` in gateway/src/handlers/admin.rs.
//     That is only worth doing if the console draws the gap as a gap: "0 B
//     stored" over a store that never answered is wrong and looks right, and an
//     operator acts on it. So the two states are asserted apart, in both
//     directions, on the same card.
//   * A PARTIAL ANSWER IS DRAWN, NOT DISCARDED, and the reason reaches the
//     screen. The rule `refreshAll` argues for panels applies one level down to
//     figures: a card showing five of its six readings and naming the sixth
//     beats one showing none. And the reply names WHICH figure and WHY, so a
//     console that reports "something failed" has thrown away what it was sent.
//
// Two legs, because neither alone reaches both halves. The first drives the
// page against a stubbed `/api/admin`, which is the only way to plant a
// hostile response and see what the page does with it. The second drives the
// REAL gateway with a real owner session, because "the registry answers with
// no value" is a claim about the gateway, and a stub of my own writing cannot
// testify to it.
//
//   node dev/verify_search_console.mjs
//   node dev/verify_search_console.mjs --break value    # the row renders s.value
//   node dev/verify_search_console.mjs --break prefix   # the paste check is skipped
//   node dev/verify_search_console.mjs --break serper   # serper back in the pulldown
//   node dev/verify_search_console.mjs --break restart  # "restart the gateway"
//   node dev/verify_search_console.mjs --break viewer   # a viewer fetches the keys
//   node dev/verify_search_console.mjs --break twice    # both cards draw the engine
//   node dev/verify_search_console.mjs --break searchcat # search folded into Other
//   node dev/verify_search_console.mjs --break engines  # no per-engine breakdown
//   node dev/verify_search_console.mjs --break rest     # a lost category is subtracted
//   node dev/verify_search_console.mjs --break zero     # an absent figure formatted as 0
//   node dev/verify_search_console.mjs --break swallow  # adminFetch drops the partial body
//   node dev/verify_search_console.mjs --break silent   # the reason never leaves part()
//   node dev/verify_search_console.mjs --break nocap    # an unread ceiling reads "no cap is set"
//
// Each --break is a defect one of the checks below is supposed to catch. A
// break that runs green means the check for it is worthless.
//
// Needs a dev server for the page, which it starts itself if one is not
// already answering, and for the second leg a free :9002 and a gateway built
// from current source -- see dev/gwbin.mjs, which refuses to measure a stale
// one rather than reporting numbers about a build nobody is shipping.
//
// The second leg's checks on `brave_key` and its three companions fail until
// lane `gateway` registers them. That is reported rather than skipped: an
// operator whose Search group has nothing in it is looking at the same absence.

import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireFreshGateway, GWCWD } from './gwbin.mjs';
import { signInFresh } from './session.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(HERE, '..');
const GWDIR = path.join(ROOT, 'gateway');
const GW_URL = 'http://127.0.0.1:9002';
const APP = process.env.DAIMOND_APP || `http://localhost:${process.env.DAIMOND_PORT || 8777}`;

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || 'value') : null;
})();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ahead of anything spawned, and ahead of the stub leg too: a stale binary
// makes the second leg measure a gateway three days older than the code, and
// there is no point running half a suite that is going to refuse anyway.
requireFreshGateway();

// ── What the console is told ────────────────────────────────
//
// A value the gateway never sends, planted in every row. Any part of the page
// that shows it has found a way to disclose a credential, and the point of the
// plant is that it costs the console nothing to be blind to it.
// allowlist secret -- a fixture, and the whole point is that it is never real.
const PLANTED = 'sk-or-v1-PLANTEDSECRET000000000000';

/// The registry as the console sees it. The prefixes here are the stub's own:
/// nothing below asserts what a real one IS -- only that the console honours
/// whichever it was handed. The live leg reads the real ones.
///
/// The SHAPE is not the stub's own, and must not drift: three search
/// credentials and deliberately no `serper_key`, because credits cannot buy a
/// Serper search (§3 of dev/SEARCH_CONTRACT.md) and a key nothing could spend
/// is a key nobody should be asked for. A stub that grew a fourth would be
/// proving the console right against a registry the gateway does not have.
function stubSecrets(overrides) {
	const rows = [
		{ route: '/api/inference-key', key: 'openrouter_key',
		  label: 'OpenRouter management key', prefix: 'sk-or-v1-',
		  help: 'Mints the spend-capped keys that account credits buy inference with.',
		  set: true, hint: '…cdef', overridden: true, configured: false,
		  set_by: 'acct_owner', set_at: 1754800000 },
		{ route: '/api/web/search', key: 'brave_key', label: 'Brave Search key',
		  prefix: 'BSA', help: 'Its own crawler.', set: false, hint: '',
		  overridden: false, configured: false, set_by: '', set_at: 0 },
		{ route: '/api/web/search', key: 'exa_key', label: 'Exa key',
		  prefix: '', help: 'Neural retrieval.', set: false, hint: '',
		  overridden: false, configured: false, set_by: '', set_at: 0 },
		{ route: '/api/web/search', key: 'tavily_key', label: 'Tavily key',
		  prefix: 'tvly-', help: '', set: false, hint: '',
		  overridden: false, configured: false, set_by: '', set_at: 0 },
	];
	return rows.map(r => Object.assign({ value: PLANTED }, r, (overrides || {})[r.key] || {}));
}

/// The knob catalogue, with the engine among ordinary priced knobs so that
/// "the Settings card stopped drawing it" is a statement about one knob and
/// not about an empty response.
///
/// Its companion is `search_byok_minor`, which is a knob the real registry
/// actually has. It used to be `search_min_charge_minor`, a floor that was
/// deleted when searches started accumulating in millionths; a fabricated
/// response cannot fail against a gateway, so nothing caught that it had come
/// to describe a knob nobody could set. The label is the registry's own, and it
/// belongs to no other group, so the check that reads for it is a statement
/// about THIS group surviving rather than about the page having any knobs left.
function stubSettings(engine) {
	return {
		ok: true, currency: 'usd',
		groups: [
			{ route: '/api/web/search', title: 'Web search',
			  help: 'Searching through the gateway.',
			  knobs: [
				{ key: 'search_engine', label: 'Engine for credit searches',
				  help: 'Which engine a search bought with Daimond credits runs on.',
				  kind: 'text', unit: '', value: engine, default: 'brave',
				  overridden: engine !== 'brave', set_by: 'acct_owner', set_at: 1754800000 },
				{ key: 'search_byok_minor', label: 'Charge to relay a search',
				  help: 'What it costs to relay a search the user\'s own key pays for.',
				  kind: 'money', unit: 'minor units', value: '1', default: '1',
				  overridden: false, set_by: '', set_at: 0 },
			  ] },
			{ route: '/api/web/fetch', title: 'Web fetch', help: 'Reading a page.',
			  knobs: [
				{ key: 'min_charge_minor', label: 'Minimum charge', help: '',
				  kind: 'money', unit: 'minor units', value: '1', default: '1',
				  overridden: false, set_by: '', set_at: 0 },
			  ] },
		],
	};
}

/// Every category the gateway names a spend by -- SPEND_CATEGORIES in
/// gateway/src/schema.rs. Written out here rather than derived, because the two
/// halves drifting apart IS the defect these checks are about, and a fixture
/// that reads its expectations off the thing under test proves nothing.
const CONSUME_KEYS = ['web', 'search', 'mail', 'sync', 'storage', 'infer', 'other'];

/// The consumption view as the gateway answers it: one field per category on
/// every day, spent or not, the day's own `total`, and the window's search
/// spend split by the engine that answered.
///
/// `o.lastTotal` overrides the last day's total so it exceeds its named parts,
/// which is what a gateway that has learned a category this page has not looks
/// like. `o.empty` is a gateway with nothing to report.
function stubConsumption(o) {
	o = o || {};
	const day = (ts, vals, totalOver) => {
		const d = { ts };
		let sum = 0;
		for (const k of CONSUME_KEYS) { d[k] = (vals || {})[k] || 0; sum += d[k]; }
		d.total = totalOver == null ? sum : totalOver;
		return d;
	};
	if (o.empty) return { ok: true, days: 30, points: [], engines: [] };
	const t0 = Date.UTC(2026, 7, 8), DAY = 86400000;
	return {
		ok: true, days: 30,
		points: [
			day(t0,           { web: 400, mail: 120 }),
			day(t0 + DAY,     { web: 250, search: 300, storage: 90, infer: 700 }),
			day(t0 + 2 * DAY, { search: 180, sync: 40, other: 20 }, o.lastTotal),
		],
		// 400 + 80 = 480 = the search category over the same window, because a
		// breakdown is a partition of it and not a second helping.
		engines: o.engines || [
			{ engine: 'brave', total: 400, searches: 40 },
			{ engine: 'exa',   total:  80, searches:  4 },
		],
	};
}

// ── A store that stopped answering ──────────────────────────
//
// What the gateway actually said, quoted from its log on 2026-08-10: a prefix
// scan waiting on the two zone bots. Written out rather than invented, because
// what the console does with the reason is one of the things asserted, and a
// made-up sentence proves nothing about the one an operator will see.
const TIMED_OUT = 'Expecting 2 messages via responder, received 0 when timed out after 6s.';
/// Once a read has failed the rest are named but NOT attempted -- they queue on
/// the bot that has just timed out. `Unread::take` gives the reasoning.
const NOT_ASKED = 'not asked for: the store had already stopped answering';

/// The `error` sentence the gateway builds from its own gaps, so the fixture
/// cannot say one thing in `unread` and another in `error`.
const unreadSentence = u => u.map(x => `${x.what} could not be read: ${x.why}`).join(' ');

/// `capacity` when every read lands.
///
/// A complete answer is half of what these checks need: an absent figure only
/// means something beside a present one. `{ empty: true }` is the other half --
/// a gateway holding nothing at all, whose GENUINE ZEROES must keep reading as
/// zeroes and must not be mistaken for figures the store would not give.
function stubCapacity(o) {
	o = o || {};
	const z = !!o.empty;
	return {
		ok: true,
		storage: {
			bytes:           z ? 0 : 3221225472,		// 3 GiB
			free_tier_bytes: z ? 0 : 2147483648,
			paid_bytes:      z ? 0 : 1073741824,
			accounts:        z ? 0 : 12,
			cap_bytes:       z ? 0 : 10737418240,		// 10 GiB, or none set
			host_disk_bytes: z ? 0 : 107374182400,
		},
		egress: {
			month:       '2026-08',
			bytes:       z ? 0 : 536870912,
			plan_bytes:  z ? 0 : 21474836480,
			alert_bytes: z ? 0 : 17179869184,
		},
		overage: { per_gb_minor: z ? 0 : 12, currency: 'aud' },
	};
}

/// `capacity` when the store stopped answering part way through it.
///
/// The order is the gateway's own (`capacity` in gateway/src/handlers/
/// admin.rs): what the store holds lands, the month's egress times out, and the
/// six knobs behind it are named but not attempted. So `storage.bytes` is a
/// real reading while `egress.bytes` is absent -- and `cap_bytes`, which comes
/// from the knobs, is absent though the figure it sits beside is not.
///
/// That last pairing is the one worth planting. A console that fills a missing
/// ceiling with `0` reports "no cap is set" over a gateway that is refusing
/// uploads at one, which is the same wrong sentence the gateway stopped
/// answering with, arriving through the door nobody was watching.
function stubCapacityPartial() {
	const unread = [
		{ what: "This month's metered egress",                why: TIMED_OUT },
		{ what: 'The ceiling, the plan and the overage rate',  why: NOT_ASKED },
	];
	return {
		ok: false, error: unreadSentence(unread), unread,
		storage: { bytes: 3221225472, free_tier_bytes: 2147483648,
		           paid_bytes: 1073741824, accounts: 12 },
		egress:  { month: '2026-08' },
		overage: {},
	};
}

/// `summary` when the account list landed and the ledger walk did not.
///
/// The account totals are real readings and the four money-and-count tiles
/// beside them are gone, which is the shape an operator meets: a dashboard that
/// can still tell him how many accounts there are while it cannot tell him what
/// they owe.
function stubSummaryPartial() {
	const unread = [
		{ what: 'Credits outstanding, revenue and consumption',
		  why: `41 of 3467 account ledgers were read before the store stopped answering: ${TIMED_OUT}` },
		{ what: 'The Pro licence count', why: NOT_ASKED },
		{ what: 'The entitlement count', why: NOT_ASKED },
		{ what: 'Sync storage',          why: NOT_ASKED },
		{ what: 'The mailbox count',     why: NOT_ASKED },
	];
	return {
		ok: false, error: unreadSentence(unread), unread,
		accounts: 3467, new_24h: 12, new_7d: 61, new_30d: 240,
		health: { store_ok: true, api: 1 },
	};
}

/// A view that failed OUTRIGHT, naming itself. Every view now does: `app_main`
/// used to answer eleven of them with one `api handler error` that named none.
const GEO_FAILED = `The 'geo' view failed: ${TIMED_OUT}`;

/// `views` replaces whole answers, which is how a hostile one is planted.
///
/// `summary` is written out complete, zero by zero, rather than left short:
/// `ok: true` is the gateway promising every figure was read, and a stub that
/// omits half of them while claiming it would have the console marking gaps
/// that the thing under test never had.
function stubFor(role, engine, secretOverrides, consume, views) {
	return Object.assign({
		whoami:      { ok: true, account_id: 'acct_test', client_fp: '0000 0000 0000 0000',
		               role, can_grant: role === 'owner' },
		summary:     { ok: true, health: { store_ok: true, api: 1 },
		               accounts: 0, new_24h: 0, new_7d: 0, new_30d: 0,
		               credits_minor: 0, revenue: [], consumption: [],
		               pro_licences: 0, entitlements: 0,
		               sync_parcels: 0, sync_bytes: 0, mailboxes: 0 },
		revenue:     { ok: true, days: [] },
		consumption: stubConsumption(consume),
		geo:         { ok: true, rows: [] },
		accounts:    { ok: true, rows: [], page: 0, pages: 1, total: 0 },
		ledger:      { ok: true, rows: [], page: 0, pages: 1, total: 0 },
		releases:    { ok: true, declared: [], planned: null, builds: [] },
		operators:   { ok: true, rows: [] },
		capacity:    stubCapacity(),
		settings:    stubSettings(engine || 'brave'),
		secrets:     { ok: true, secrets: stubSecrets(secretOverrides) },
	}, views || {});
}

// ── Driving the page ────────────────────────────────────────

/// Every admin call the page made, read AND write.
///
/// Both directions are recorded because both are asserted: "the key never left
/// the browser" is about what was posted, and "a viewer never asks for the
/// keys" is about what was fetched. A refusal that still posts has refused
/// nothing, and a viewer whose console asks anyway is relying on the gateway to
/// say no.
function openStub(browser, opts) {
	const o = opts || {};
	const calls = [];
	return (async () => {
		const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
		const stub = stubFor(o.role || 'owner', o.engine, o.secrets, o.consume, o.views);
		await page.route('**/api/admin*', async route => {
			const req = route.request();
			const view = new URL(req.url()).searchParams.get('view');
			if (req.method() === 'POST') {
				let body = null;
				try { body = JSON.parse(req.postData() || 'null'); } catch (e) {}
				calls.push({ method: 'POST', view, body });
				const answer = o.onPost ? o.onPost(view, body, stub) : { ok: true };
				await route.fulfill({ status: answer.status || 200,
					contentType: 'application/json', body: JSON.stringify(answer.json || answer) });
				return;
			}
			calls.push({ method: 'GET', view, body: null });
			// The status is taken FROM the body, so the stub cannot drift from
			// the gateway's own rule: `200 {ok:true, …}` where every figure was
			// read, `503 {ok:false, error, unread, …the ones that were}` where
			// they were not. 503 and not 500 -- a scan that timed out because
			// the store was busy is a condition that passes.
			const answer = stub[view] || { ok: true };
			await route.fulfill({ status: answer.ok === false ? 503 : 200,
				contentType: 'application/json', body: JSON.stringify(answer) });
		});
		if (BREAK) await page.addInitScript(mode => { window.__provBreak = mode; }, BREAK);
		await page.goto(APP + '/console/', { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('#admin-app:not([hidden])', { timeout: 15000 });
		// The card is filled by the settings and secrets fetches, which land
		// after the dashboard un-hides. Wait for the card to have CONTENT, not
		// for a guessed interval, or the first read counts an empty card.
		await page.waitForFunction(
			() => (document.getElementById('admin-prov-groups') || {}).childElementCount > 0,
			{ timeout: 15000 }).catch(() => {});
		return { page, calls };
	})();
}

/// The writes among them, which is what "nothing was sent" is about.
function sent(calls) { return calls.filter(c => c.method === 'POST'); }

/// Show the Settings section and prove it is really showing.
///
/// Every view but Overview starts `hidden`, and a check that only READS the
/// DOM passes against a hidden element -- it is the first line that has to TYPE
/// that fails, with "element is not visible", somewhere far from the cause. So
/// the rail item is clicked and visibility is asserted before anything is
/// touched. `offsetParent` is the honest test: it is null for anything inside a
/// hidden ancestor, which a `hidden` attribute on the panel is.
async function showProviders(page, label) {
	await page.click('#admin-nav .admin-nav-item[data-view="settings"]', { force: true });
	await sleep(150);
	const vis = await page.evaluate(() => {
		const card = document.getElementById('admin-prov-card');
		if (!card) return { ok: false, why: 'no Providers card in the page' };
		const r = card.getBoundingClientRect();
		return { ok: card.offsetParent !== null && r.width > 8 && r.height > 8,
			why: `offsetParent ${card.offsetParent ? 'set' : 'null'}, box ${Math.round(r.width)}x${Math.round(r.height)}` };
	});
	check(`${label}: the Providers card is visible once Settings is chosen`, vis.ok, vis.why);
	return vis.ok;
}

/// What the card is showing, as things worth asserting about.
function readCard(page) {
	return page.evaluate(planted => {
		const card = document.getElementById('admin-prov-card');
		const set  = document.getElementById('admin-set-card');
		const groups = Array.from(card.querySelectorAll('.admin-set-group')).map(g => ({
			head: (g.querySelector('h3') || {}).textContent || '',
			route: (g.querySelector('.admin-set-route') || {}).textContent || '',
			keys: Array.from(g.querySelectorAll('.admin-prov-key')).map(r => r.dataset.key),
		}));
		const sel = document.getElementById('admin-prov-engine');
		const opts = sel ? Array.from(sel.options).map(o => ({
			value: o.value, text: o.textContent, disabled: o.disabled })) : null;
		// Everything a value could hide in: rendered text, every input's live
		// value, and every value attribute in the markup.
		const inputs = Array.from(card.querySelectorAll('input')).map(i => ({
			type: i.type, value: i.value, attr: i.getAttribute('value') }));
		return {
			text:      card.textContent || '',
			setText:   set ? (set.textContent || '') : '',
			html:      card.innerHTML,
			hint:      (document.getElementById('admin-prov-hint') || {}).textContent || '',
			note:      (document.getElementById('admin-prov-note') || {}).textContent || '',
			noteShown: !!(document.getElementById('admin-prov-note')
				&& !document.getElementById('admin-prov-note').hidden),
			groups, opts, inputs,
			planted:   (card.innerHTML || '').includes(planted),
			// Where the two cards sit relative to each other, as the document
			// order a reader meets them in.
			provFirst: !!(card && set
				&& (card.compareDocumentPosition(set) & Node.DOCUMENT_POSITION_FOLLOWING)),
			engineValue: sel ? sel.value : null,
			said: Array.from(card.querySelectorAll('.admin-prov-said')).map(n => n.textContent),
			rowMsgs: Array.from(card.querySelectorAll('.admin-set-msg'))
				.map(n => n.textContent).filter(Boolean),
		};
	}, PLANTED);
}

/// Show the Overview section and prove it is really showing.
///
/// Overview is the section the console opens on, so this looks redundant --
/// until a rail click earlier in the run has left another panel up, and every
/// read below quietly answers about a `hidden` ancestor. Same rule as
/// showProviders: click the rail item, then assert the chart has a box.
async function showOverview(page, label) {
	await page.click('#admin-nav .admin-nav-item[data-view="overview"]', { force: true });
	await sleep(150);
	const vis = await page.evaluate(() => {
		const host = document.getElementById('admin-consumption');
		if (!host) return { ok: false, why: 'no consumption chart in the page' };
		const r = host.getBoundingClientRect();
		return { ok: host.offsetParent !== null && r.width > 8 && r.height > 8,
			why: `offsetParent ${host.offsetParent ? 'set' : 'null'}, box ${Math.round(r.width)}x${Math.round(r.height)}` };
	});
	check(`${label}: the consumption chart is visible on Overview`, vis.ok, vis.why);
	return vis.ok;
}

/// What the consumption card is showing, as things worth asserting about.
function readConsumption(page) {
	return page.evaluate(() => {
		const host = document.getElementById('admin-consumption');
		const lg   = document.getElementById('admin-consumption-legend');
		const eng  = document.getElementById('admin-search-engines');
		const card = host ? host.closest('.admin-card') : null;
		return {
			// Which categories the stack actually drew, as the classes the CSS
			// colours them by.
			segs: Array.from(host ? host.querySelectorAll('rect.admin-bar') : [])
				.map(r => (r.getAttribute('class') || '').replace('admin-bar', '').trim())
				.filter(Boolean),
			// The hover text, which is where a reader learns what a segment is.
			titles: Array.from(host ? host.querySelectorAll('title') : [])
				.map(t => t.textContent),
			empty:  !!(host && host.querySelector('.admin-chart-empty')),
			legend: lg ? (lg.textContent || '') : '',
			swatches: Array.from(lg ? lg.querySelectorAll('.sw') : [])
				.map(s => (s.className || '').replace('sw', '').trim()),
			engPresent: !!eng,
			engText: eng ? (eng.textContent || '') : '',
			engRows: Array.from(eng ? eng.querySelectorAll('tbody tr') : []).map(tr => ({
				engine: tr.getAttribute('data-engine'),
				cells:  Array.from(tr.querySelectorAll('td')).map(td => td.textContent),
			})),
			// The breakdown has to be beside the chart it breaks down: a number
			// in another panel is a number an operator has to go and find.
			inSameCard: !!(eng && card && card.contains(eng)),
		};
	});
}

/// Show the Capacity section and prove it is really showing.
///
/// Same rule as showProviders: the panel starts `hidden`, and a check that only
/// READS the DOM passes against a hidden element. The card is also filled last
/// of everything `refreshAll` does -- after the accounts and ledger tables --
/// so the wait is for the card to have a BLOCK in it rather than for an
/// interval somebody guessed.
async function showCapacity(page, label) {
	await page.click('#admin-nav .admin-nav-item[data-view="capacity"]', { force: true });
	await page.waitForFunction(
		() => document.querySelectorAll('#admin-cap-card .admin-cap').length >= 2,
		{ timeout: 15000 }).catch(() => {});
	const vis = await page.evaluate(() => {
		const card = document.getElementById('admin-cap-card');
		if (!card) return { ok: false, why: 'no Capacity card in the page' };
		const r = card.getBoundingClientRect();
		return { ok: card.offsetParent !== null && r.width > 8 && r.height > 8,
			why: `offsetParent ${card.offsetParent ? 'set' : 'null'}, box ${Math.round(r.width)}x${Math.round(r.height)}` };
	});
	check(`${label}: the Capacity card is visible once Capacity is chosen`, vis.ok, vis.why);
	return vis.ok;
}

/// The KPI tiles and the strip above them, as things worth asserting about.
///
/// The strip is read only when it is SHOWING: `#admin-status` keeps its last
/// text after being hidden, and a check that read it regardless would pass on
/// a message nobody can see.
function readKpis(page) {
	return page.evaluate(() => {
		const strip = document.getElementById('admin-status');
		return {
			tiles: Array.from(document.querySelectorAll('#admin-kpis .admin-kpi')).map(t => ({
				label:  (t.querySelector('.admin-kpi-lbl') || {}).textContent || '',
				val:    (t.querySelector('.admin-kpi-val') || {}).textContent || '',
				sub:    (t.querySelector('.admin-kpi-sub') || {}).textContent || '',
				marked: t.classList.contains('absent'),
			})),
			strip: strip && !strip.hidden ? (strip.textContent || '') : '',
		};
	});
}
/// One tile by the label a reader sees.
const tile = (k, label) =>
	k.tiles.find(t => t.label === label) || { label, val: '', sub: '', marked: null };

/// The capacity card, one object per block.
///
/// `rail` is the three states the bar can be in and they are not
/// interchangeable: a proportion, a limit nobody set, and a reading the store
/// would not give. The last two are both empty bars, which is exactly why the
/// class is read rather than the pixels.
function readCapacity(page) {
	return page.evaluate(() => {
		const block = id => {
			const host = document.getElementById(id);
			const b = host ? host.querySelector('.admin-cap') : null;
			const m = b ? b.querySelector('.admin-meter') : null;
			const txt = (sel) => (b && b.querySelector(sel) || {}).textContent || '';
			return {
				head:   txt('.admin-cap-headline'),
				legend: txt('.admin-cap-legend'),
				detail: txt('.admin-cap-detail'),
				words:  txt('.admin-cap-words'),
				marked: !!(b && b.classList.contains('absent')),
				rail:   !m ? 'none'
					: m.classList.contains('unread')  ? 'unread'
					: m.classList.contains('nolimit') ? 'nolimit' : 'proportion',
			};
		};
		const err = document.getElementById('admin-cap-err');
		return {
			storage: block('admin-cap-storage'),
			egress:  block('admin-cap-egress'),
			hint: (document.getElementById('admin-cap-hint') || {}).textContent || '',
			err:  err ? (err.textContent || '') : '',
			// A view that answered in part is not a failure and must not be
			// dressed as one: the card's line takes the status strip's register
			// rather than the red kept for a view that failed outright.
			errCalm: !!(err && err.classList.contains('admin-partial')),
		};
	});
}

/// Type into one credential's field and press its Save.
async function pasteKey(page, key, value) {
	const row = `.admin-prov-key[data-key="${key}"]`;
	await page.fill(`${row} input.admin-set-input`, value);
	await page.click(`${row} button.admin-btn`, { force: true });
	await sleep(300);
}

// ── The processes the second leg needs ──────────────────────
const procs = [];
function launch(cmd, args, opts) { const p = spawn(cmd, args, opts); procs.push(p); return p; }
async function waitFor(fn, ms = 20000, gap = 300) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}
function cleanup() { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } }

let gw = null;
async function startGateway(ownerAccount) {
	if (gw) { try { gw.kill('SIGKILL'); } catch (e) {} await sleep(1500); }
	gw = launch(path.join(GWDIR, 'target/release/daimond_gateway'), [], {
		cwd: GWCWD,
		env: { ...process.env, APP_MODE: 'sandbox',
			...(ownerAccount ? { DAIMOND_OWNER_ACCOUNTS: ownerAccount } : {}) },
		stdio: ['ignore', 'ignore', 'ignore'],
	});
	return await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok);
}

/// An admin call from a page, carrying that page's own session.
async function api(page, view, body) {
	return await page.evaluate(async a => {
		const opts = { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } };
		if (a.body !== null) {
			opts.method = 'POST';
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(a.body);
		}
		const r = await fetch('/api/admin?view=' + a.view, opts);
		let j = null; try { j = await r.json(); } catch (e) {}
		return { status: r.status, j };
	}, { view, body: body === undefined ? null : body });
}

// ── Run ─────────────────────────────────────────────────────

// The dev server serves /console/, so BOTH legs need it -- the stub leg
// intercepts the API and still has to load the page from somewhere. Started
// here rather than inside the second leg, where it was serving the first one by
// accident of whatever was already running.
{
	let already = false;
	try { already = (await fetch(`${APP}/console/`)).ok; } catch (e) {}
	if (!already) launch('node', ['dev/serve.mjs'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
	const up = await waitFor(async () => (await fetch(`${APP}/console/`)).ok, 15000);
	check('the dev server serves the console', up, APP + '/console/');
	if (!up) {
		cleanup();
		console.log(`\npassed ${ok.length}, failed ${bad.length}`);
		process.exit(1);
	}
}

const { chromium } = await import(pathToFileURL(PW).href);
// Launched as dev/harness.mjs launches: no mode on this host produces animation
// frames, so Playwright's stability check never settles and every click is
// forced. Where that matters -- a control that might be covered -- the reach is
// asserted separately, as showProviders does.
const browser = await chromium.launch({ executablePath: CHROME, headless: false,
	args: ['--no-sandbox', '--disable-dev-shm-usage', '--headless=new'] });

try {
	// ── Leg one: the page, against a stub ───────────────────
	{
		const { page, calls } = await openStub(browser, { role: 'owner' });
		const shown = await showProviders(page, 'owner');

		if (shown) {
			const c = await readCard(page);

			// Where it sits, and what it holds.
			check('Providers comes before Settings in the section', c.provFirst,
				'the two cards are the other way round, or one is missing');
			const heads = c.groups.map(g => g.head);
			check('the card groups Inference and Search, in that order',
				heads.indexOf('Inference') === 0 && heads.indexOf('Search') === 1,
				'groups: ' + JSON.stringify(heads));
			const searchGroup = c.groups.find(g => g.head === 'Search') || { keys: [] };
			const infGroup = c.groups.find(g => g.head === 'Inference') || { keys: [] };
			check('the inference key is in the Inference group',
				infGroup.keys.includes('openrouter_key'), JSON.stringify(infGroup.keys));
			// THREE, not four. An operator serper key was registered by the
			// contract and removed on purpose: the credits tier may never spend
			// serper, and a BYOK key is never stored -- so the row would be a live
			// third-party credential at rest that no code path can reach. Given
			// what the write path was nearly doing with credentials nobody had
			// thought hard about, a dead one is the wrong thing to leave lying
			// about. Asserted as an absence below, so it cannot creep back.
			for (const k of ['brave_key', 'exa_key', 'tavily_key']) {
				check(`${k} has a row in the Search group`, searchGroup.keys.includes(k),
					'Search holds ' + JSON.stringify(searchGroup.keys));
			}
			// And the absence, asserted rather than merely not asserted: a key
			// nothing can spend is a credential kept for no reason, and the day
			// somebody wires it up they break the rule that the credits tier
			// never buys resold results.
			check('no operator serper key is registered, because nothing could spend it',
				!searchGroup.keys.includes('serper_key'),
				'Search holds ' + JSON.stringify(searchGroup.keys));

			// No value, by any route.
			check('the planted value appears nowhere in the card', !c.planted,
				'a credential the gateway never sent was rendered');
			check('no field in the card holds a value',
				c.inputs.every(i => i.value === '' && !i.attr),
				JSON.stringify(c.inputs.filter(i => i.value || i.attr)));
			check('every credential field is a password field',
				c.inputs.length > 0 && c.inputs.every(i => i.type === 'password'),
				JSON.stringify(c.inputs.map(i => i.type)));
			check('presence is shown as the masked tail the gateway sent',
				/…cdef/.test(c.text) && !/sk-or-v1-\w/.test(c.text),
				'the value column did not read as a hint');
			check('a key that is not set says so rather than showing nothing',
				/not set/.test(c.text));
			check('provenance is named for the key that is set',
				/set by acct_owner/.test(c.text), 'no provenance line found');

			// The engine pulldown.
			check('there is an engine pulldown', !!c.opts, 'no #admin-prov-engine');
			if (c.opts) {
				const choosable = c.opts.filter(o => !o.disabled).map(o => o.value);
				check('serper is not an option at all',
					!c.opts.some(o => o.value === 'serper'),
					'options: ' + JSON.stringify(c.opts.map(o => o.value)));
				check('the choosable engines are exactly brave, exa and tavily',
					JSON.stringify(choosable.slice().sort()) === JSON.stringify(['brave', 'exa', 'tavily']),
					'choosable: ' + JSON.stringify(choosable));
				check('the configured engine is the one selected',
					c.engineValue === 'brave', 'selected ' + JSON.stringify(c.engineValue));
			}
			check('the Settings card no longer draws the engine as well',
				!/Engine for credit searches/.test(c.setText),
				'the same knob has two editors, which disagree the moment either saves');
			check('the Settings card still draws its other knobs',
				/Charge to relay a search/.test(c.setText),
				'the promotion took the whole group with it');

			// Nothing has been written yet, so nothing may have been posted.
			check('drawing the card sends no POST', sent(calls).length === 0,
				JSON.stringify(sent(calls)));

			// ── The wrong paste ─────────────────────────────
			// The commonest one: an inference key where a search key goes.
			// allowlist secret -- a fixture shaped like the mistake it stands for.
			const WRONG = 'sk-ant-api03-not-a-brave-key';
			await pasteKey(page, 'brave_key', WRONG);
			const afterWrong = await readCard(page);
			const said = afterWrong.rowMsgs.join(' | ');
			check('a wrong prefix is refused before the key leaves the browser',
				sent(calls).length === 0, 'posted: ' + JSON.stringify(sent(calls)));
			check('the refusal names the key that was expected',
				/Brave Search key/.test(said), said);
			check('the refusal names the prefix it wanted',
				/BSA/.test(said), said);
			check('the refusal shows the start of what was pasted',
				/sk-ant/.test(said), said);
			check('the refusal does not echo the whole paste',
				!/not-a-brave-key/.test(said), said);
			check('the refusal says nothing was sent',
				/nothing has been sent/i.test(said), said);
			const kept = await page.inputValue('.admin-prov-key[data-key="brave_key"] input.admin-set-input');
			check('the refused paste is left in the field to be corrected',
				kept === WRONG, JSON.stringify(kept));

			// A key with no declared prefix accepts anything shaped like a key,
			// which is the other half of honouring the registry.
			await pasteKey(page, 'exa_key', 'anything-goes-here');
			check('a credential with no declared prefix is not refused for its prefix',
				sent(calls).some(p => p.view === 'secrets' && p.body && p.body.key === 'exa_key'),
				'posted: ' + JSON.stringify(sent(calls).map(p => p.body && p.body.key)));

			// Interior whitespace, which secrets.rs refuses and says why.
			await pasteKey(page, 'tavily_key', 'tvly-abc def');
			const afterSpace = (await readCard(page)).rowMsgs.join(' | ');
			check('a key broken by a space is refused, and the message says which mistake',
				/spaces or line breaks/.test(afterSpace), afterSpace);

			await page.close();
		} else {
			check('leg one ran', false, 'the Providers card never became visible');
		}
	}

	// ── Saving, and what the confirmation may claim ─────────
	{
		// A gateway that stored the key and said nothing about a provider: the
		// search case, where only the shape was ever checked.
		const { page, calls } = await openStub(browser, {
			role: 'owner',
			onPost: (view, body) => ({ ok: true, secrets: stubSecrets({
				brave_key: { set: true, hint: '…dead', overridden: true,
					set_by: 'acct_test', set_at: 1754899000 } }) }),
		});
		if (await showProviders(page, 'saving')) {
			await pasteKey(page, 'brave_key', 'BSA-a-well-formed-key');
			const c = await readCard(page);
			const said = c.said.join(' | ');
			check('the key was sent once the shape was right',
				sent(calls).some(p => p.body && p.body.key === 'brave_key'
					&& p.body.value === 'BSA-a-well-formed-key'),
				JSON.stringify(sent(calls)));
			check('the confirmation says the key is in use',
				/in use/i.test(said), said);
			check('the confirmation says no restart is needed',
				/no restart/i.test(said) && !/restart the gateway/i.test(said), said);
			check('the confirmation does not claim a provider accepted it',
				!/accepted by the provider/i.test(said), said);
			check('the confirmation says the shape is all that was checked',
				/shape/i.test(said), said);
			check('the row now reads as set, at the new tail',
				/…dead/.test(c.text), 'the listing was not redrawn from the reply');
			const emptied = await page.inputValue('.admin-prov-key[data-key="brave_key"] input.admin-set-input');
			check('the field is cleared and holds no copy of the key', emptied === '',
				JSON.stringify(emptied));
			check('the planted value is still nowhere after a save', !c.planted);
			await page.close();
		}
	}
	{
		// And the inference case, where the gateway DID ask the host: the reply
		// carries a pool balance, and only then may the wording claim a check.
		const { page } = await openStub(browser, {
			role: 'owner',
			onPost: () => ({ ok: true, pool_minor: 796, secrets: stubSecrets({
				openrouter_key: { set: true, hint: '…9999', overridden: true,
					set_by: 'acct_test', set_at: 1754899000 } }) }),
		});
		if (await showProviders(page, 'a checked key')) {
			await pasteKey(page, 'openrouter_key', 'sk-or-v1-0123456789abcdef');
			const said = (await readCard(page)).said.join(' | ');
			check('a reply carrying a pool balance is reported as the provider accepting it',
				/accepted by the provider/i.test(said), said);
			check('the balance the check found is stated',
				/7\.96/.test(said), said);
			check('and that confirmation also says no restart',
				/no restart/i.test(said) && !/restart the gateway/i.test(said), said);
			await page.close();
		}
	}

	// ── An engine the pulldown may not offer ────────────────
	{
		const { page } = await openStub(browser, { role: 'owner', engine: 'serper' });
		if (await showProviders(page, 'serper configured')) {
			const c = await readCard(page);
			check('serper in configuration still puts no serper in the pulldown',
				c.opts && !c.opts.some(o => o.value === 'serper'),
				JSON.stringify(c.opts && c.opts.map(o => o.value)));
			check('serper in configuration is not silently replaced by the first option',
				c.engineValue === '', 'the pulldown selected ' + JSON.stringify(c.engineValue));
			check('the card names the engine that is running',
				/serper/.test(c.text), 'an unofferable engine was hidden rather than named');
			check('and says why it may not be chosen',
				/resells Google/.test(c.text) && /own key/.test(c.text),
				'the refusal gave no reason');
			await page.close();
		}
	}

	// ── A viewer ────────────────────────────────────────────
	{
		const { page, calls } = await openStub(browser, { role: 'viewer' });
		if (await showProviders(page, 'viewer')) {
			const c = await readCard(page);
			const keys = c.groups.reduce((a, g) => a.concat(g.keys), []);
			check('a viewer is shown no credential at all', keys.length === 0,
				'saw ' + JSON.stringify(keys));
			check('a viewer is told the keys are an owner\'s, not that there are none',
				c.noteShown && /owner/i.test(c.note), JSON.stringify(c.note));
			check('a viewer still sees which engine credits searches run on',
				/Brave/.test(c.text), 'the engine was hidden with the keys');
			check('a viewer gets no control over the engine',
				!c.opts, 'a viewer was given the pulldown');
			check('the planted value reaches a viewer by no route', !c.planted);
			check('a viewer\'s console never asks for the keys',
				!calls.some(c => c.view === 'secrets'),
				'asked for ' + JSON.stringify(calls.map(c => c.view)));
			await page.close();
		}
	}

	// ── What search costs, and on which engine ──────────────
	//
	// The Providers card above is where a key is set. This is where an operator
	// finds out what it is costing him, which is the other half of "can I manage
	// this and keep an eye on it" and was the half that did not exist.
	{
		const { page } = await openStub(browser, { role: 'owner' });
		if (await showOverview(page, 'consumption')) {
			const c = await readConsumption(page);

			// Every category the gateway names has a segment of its own. Search
			// is the one that prompted this; storage and infer are the same
			// defect, three weeks older, and they are checked by name so that
			// fixing one and not the others reads as a failure.
			for (const k of CONSUME_KEYS) {
				check(`${k} spend is drawn as a category of its own`,
					c.segs.includes(k), 'the stack drew ' + JSON.stringify(c.segs));
			}
			check('the legend names search, stored files and inference',
				/Search/.test(c.legend) && /Stored files/.test(c.legend)
					&& /Inference/.test(c.legend), JSON.stringify(c.legend));
			check('every legend swatch is keyed to the category it stands for',
				CONSUME_KEYS.every(k => c.swatches.includes(k)),
				JSON.stringify(c.swatches));
			// The value, not just the segment: a search day is 300 minor units
			// in the fixture, and it has to read as search money.
			check('a search segment says what it cost',
				c.titles.some(t => /Search: [^0-9]*3\.00/.test(t)),
				JSON.stringify(c.titles.filter(t => /Search/.test(t))));
			check('paid search is no longer drawn as Other',
				!c.titles.some(t => /Other: [^0-9]*3\.00/.test(t)),
				JSON.stringify(c.titles.filter(t => /Other/.test(t))));
			// Nothing was lost on the way: with both halves current, there is
			// nothing left over to draw.
			check('nothing in the window is unaccounted for',
				!c.segs.includes('unlisted') && !/Not accounted for/.test(c.legend),
				'the page cannot name a category the gateway counted');

			// The breakdown by engine, which is what a vendor cap is set on.
			check('the search spend is broken down by engine', c.engPresent,
				'no #admin-search-engines under the chart');
			check('the breakdown sits in the same card as the chart it splits',
				c.inSameCard, 'it was drawn somewhere else, or nowhere');
			check('the engines are listed biggest spender first',
				JSON.stringify(c.engRows.map(r => r.engine)) === JSON.stringify(['brave', 'exa']),
				JSON.stringify(c.engRows.map(r => r.engine)));
			const brave = c.engRows.find(r => r.engine === 'brave') || { cells: [] };
			check('the engine row counts queries, which is what a vendor cap counts',
				/^40 searches$/.test((brave.cells[1] || '').trim()),
				JSON.stringify(brave.cells));
			check('the engine row says what that engine cost',
				/4\.00/.test(brave.cells[2] || ''), JSON.stringify(brave.cells));
			check('the engine row says what share of search it is',
				/83%/.test(brave.cells[3] || ''), JSON.stringify(brave.cells));
			check('the breakdown totals the window in queries and in money',
				/44 searches/.test(c.engText) && /4\.80/.test(c.engText),
				JSON.stringify(c.engText));
			await page.close();
		}
	}
	{
		// A gateway that counted more in a day than the page can name: the shape
		// of the original defect, arriving from the other direction. The
		// remainder must be DRAWN, not subtracted -- a short bar is a chart that
		// lies quietly, which is how three weeks went by.
		const { page } = await openStub(browser, { role: 'owner',
			consume: { lastTotal: 340 } });          // named parts sum to 240
		if (await showOverview(page, 'a category this page cannot name')) {
			const c = await readConsumption(page);
			check('spend in a category the page cannot name is still drawn',
				c.segs.includes('unlisted'), 'the stack drew ' + JSON.stringify(c.segs));
			check('and it is named as unaccounted for rather than as Other',
				/Not accounted for/.test(c.legend), JSON.stringify(c.legend));
			check('the remainder is the gateway\'s total less what was drawn',
				c.titles.some(t => /Not accounted for: [^0-9]*1\.00/.test(t)),
				JSON.stringify(c.titles.filter(t => /accounted/.test(t))));
			await page.close();
		}
	}
	{
		// An operator who has just set a paid key and had no searches yet. The
		// breakdown must say so: "nobody has searched" and "this panel is
		// broken" look identical if it draws nothing at all.
		const { page } = await openStub(browser, { role: 'owner',
			consume: { empty: true } });
		if (await showOverview(page, 'no spend yet')) {
			const c = await readConsumption(page);
			check('an empty window still draws the breakdown, with its heading',
				c.engPresent && /Search by engine/.test(c.engText),
				JSON.stringify(c.engText));
			check('an empty window says there was no search spend',
				/No search spend in the last 30 days/.test(c.engText),
				JSON.stringify(c.engText));
			check('and no engine row is invented for it',
				c.engRows.length === 0, JSON.stringify(c.engRows));
			await page.close();
		}
	}

	// ── A busy store, and the difference between nothing and zero ──
	//
	// The gateway answers a view it could only partly read with the figures it
	// GOT and the names of the ones it did not, deliberately omitting the rest
	// rather than sending zeroes. Everything below is the console's half of
	// that bargain, and the two halves cancel out if either is got wrong: a
	// gateway that omits a figure the console renders as `0` has bought
	// nothing, and a console that discards the reply keeps the reason and loses
	// the readings.
	{
		// Complete answers first, so the absences below are read against
		// something. Same store, same card, everything arriving.
		const { page } = await openStub(browser, { role: 'owner' });
		if (await showCapacity(page, 'every figure read')) {
			const c = await readCapacity(page);
			check('a reading that arrived is drawn as a proportion of its ceiling',
				/3 GiB of 10 GiB/.test(c.storage.head) && c.storage.rail === 'proportion',
				JSON.stringify([c.storage.head, c.storage.rail]));
			check('a complete answer marks nothing as missing',
				!c.storage.marked && !c.egress.marked && c.err === '',
				JSON.stringify([c.storage.marked, c.egress.marked, c.err]));
			check('and the card says how many accounts are storing data',
				/12 accounts storing data/.test(c.hint), JSON.stringify(c.hint));
			await page.close();
		}
	}
	{
		// A gateway holding nothing at all. Every figure here is a real reading
		// whose value happens to be zero, and it has to keep reading as zero:
		// the whole change is worthless if it makes an idle gateway look like a
		// broken one.
		const { page } = await openStub(browser, { role: 'owner',
			views: { capacity: stubCapacity({ empty: true }) } });
		if (await showCapacity(page, 'a gateway holding nothing')) {
			const c = await readCapacity(page);
			check('a genuine zero still reads as zero, not as an absence',
				/0 B stored/.test(c.storage.head) && !c.storage.head.includes('—'),
				JSON.stringify(c.storage.head));
			check('a genuine zero is not marked as unread',
				!c.storage.marked && !c.egress.marked && c.storage.rail === 'nolimit',
				JSON.stringify([c.storage.marked, c.egress.marked, c.storage.rail]));
			check('a ceiling that is genuinely unset still says so',
				/No cap is set/.test(c.storage.words), c.storage.words.slice(0, 90));
			check('an idle month reads as no traffic rather than as no answer',
				/0 B sent/.test(c.egress.head), JSON.stringify(c.egress.head));
			const k = await readKpis(page);
			check('a zero account count reads as 0 and is not marked',
				tile(k, 'Accounts').val === '0' && tile(k, 'Accounts').marked === false,
				JSON.stringify(tile(k, 'Accounts')));
			await page.close();
		}
	}
	{
		// And the store that stopped answering part way through: `capacity` and
		// `summary` in part, `geo` outright.
		const { page } = await openStub(browser, { role: 'owner', views: {
			capacity: stubCapacityPartial(),
			summary:  stubSummaryPartial(),
			geo:      { ok: false, error: GEO_FAILED },
		} });
		if (await showCapacity(page, 'a store that stopped answering')) {
			const c = await readCapacity(page);

			// Drawn, not discarded. This is the whole point: the figure the
			// store DID give is on the screen beside the one it did not.
			check('a figure that arrived is still drawn when its neighbour did not',
				/3 GiB stored/.test(c.storage.head), JSON.stringify(c.storage.head));
			check('a figure that did not arrive is not drawn as zero',
				!/0 B/.test(c.egress.head) && c.egress.head.includes('—'),
				JSON.stringify(c.egress.head));
			// The dangerous one. An unread ceiling rendered as `0` is the
			// console announcing there is no limit while uploads are being
			// refused at one.
			check('a ceiling that could not be read is not reported as no ceiling',
				!/No cap is set/.test(c.storage.words)
					&& /ceiling could not be read/.test(c.storage.words),
				c.storage.words.slice(0, 110));
			check('an allowance that could not be read is not reported as no allowance',
				!/No plan allowance is recorded/.test(c.egress.words)
					&& /allowance could not be read/.test(c.egress.words),
				c.egress.words.slice(0, 110));
			// An empty rail means one of two opposite things, so the two are
			// drawn apart -- an operator sets a limit, or goes and looks at the
			// store, and he chooses by looking at this.
			check('an unfillable bar says which silence it is',
				c.storage.rail === 'unread' && c.egress.rail === 'unread',
				JSON.stringify([c.storage.rail, c.egress.rail]));
			check('the blocks with a gap in them are visibly marked',
				c.storage.marked && c.egress.marked,
				JSON.stringify([c.storage.marked, c.egress.marked]));
			// Which figure, and why -- not "something failed".
			check('the card names the figure it could not read',
				/metered egress/.test(c.err), JSON.stringify(c.err));
			check('and gives the store\'s own reason for it',
				/timed out after 6s/.test(c.err), JSON.stringify(c.err));
			check('a partial answer is stated calmly, not as an outright failure',
				c.errCalm, 'the card\'s line is in the register kept for a dead view');
			check('the reading that DID arrive still fills the hint',
				/12 accounts storing data/.test(c.hint), JSON.stringify(c.hint));
		}
		if (await showOverview(page, 'a store that stopped answering')) {
			const k = await readKpis(page);
			const acct = tile(k, 'Accounts');
			check('a tile whose figure arrived is drawn in full',
				acct.val === '3,467' && /\+12 in 24h/.test(acct.sub) && !acct.marked,
				JSON.stringify(acct));
			for (const lbl of ['Credits outstanding', 'Active Pro', 'Sync storage']) {
				const t = tile(k, lbl);
				check(`${lbl}: an unread figure reads as absent, not as zero`,
					t.val === '—' && t.marked === true, JSON.stringify(t));
			}
			check('no unread tile shows a currency amount it never received',
				!k.tiles.some(t => t.marked && /[0-9]/.test(t.val)),
				JSON.stringify(k.tiles.filter(t => t.marked).map(t => t.label + '=' + t.val)));
			// The strip: which view, which figure, and why. A console that
			// summarised this to "could not load" would be showing an operator
			// less than the reply it was holding.
			check('the strip names the view that answered in part',
				/Read in part:/.test(k.strip) && /summary/.test(k.strip),
				JSON.stringify(k.strip));
			check('the strip names which figure went missing',
				/Credits outstanding, revenue and consumption could not be read/.test(k.strip),
				JSON.stringify(k.strip));
			check('the strip carries the store\'s own reason, in full',
				/41 of 3467 account ledgers were read/.test(k.strip)
					&& /timed out after 6s/.test(k.strip), JSON.stringify(k.strip));
			check('a view that failed outright is quoted, not merely named',
				/The 'geo' view failed/.test(k.strip), JSON.stringify(k.strip));
			check('and the strip still says the rest is current',
				/The rest is current/.test(k.strip), JSON.stringify(k.strip));
		}
		await page.close();
	}

	// ── Leg two: the real registry ──────────────────────────
	//
	// Everything above is the console's own behaviour. Whether a credential can
	// be read back is the GATEWAY's property, and a stub of my own writing
	// cannot testify to it.
	{
		let stray = false;
		try { stray = (await fetch(`${GW_URL}/api/health`)).ok; } catch (e) {}
		if (stray) {
			check('no gateway is already running on :9002', false,
				'stop it first (pkill -f release/daimond_gateway); this leg pins an owner');
		} else {
			check('the gateway starts', await startGateway(null));

			const ownerCtx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
			const otherCtx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
			const ownerPage = await ownerCtx.newPage();
			const otherPage = await otherCtx.newPage();
			const owner = await signInFresh(ownerPage, APP);
			const other = await signInFresh(otherPage, APP);
			check('two accounts sign in', !!owner && !!other && owner !== other);
			check('the gateway restarts with one of them as owner', await startGateway(owner));

			const listing = await api(ownerPage, 'secrets');
			const rows = (listing.j && listing.j.secrets) || [];
			check('the owner may read the registry', listing.status === 200 && rows.length > 0,
				'status ' + listing.status);

			// The registry half of the contract, §6. A FAIL here is lane
			// gateway's half not having landed, not a console defect -- and it
			// is reported rather than skipped, because a Search group with no
			// rows in it is exactly what an operator would be looking at.
			// THREE, not four. An operator serper key was registered by the
			// contract and removed on purpose: the credits tier may never spend
			// serper, and a BYOK key is never stored -- so the row would be a live
			// third-party credential at rest that no code path can reach. Given
			// what the write path was nearly doing with credentials nobody had
			// thought hard about, a dead one is the wrong thing to leave lying
			// about. Asserted as an absence below, so it cannot creep back.
			for (const k of ['brave_key', 'exa_key', 'tavily_key']) {
				check(`the gateway registers ${k} on /api/web/search`,
					rows.some(r => r.key === k && r.route === '/api/web/search'),
					'registered: ' + JSON.stringify(rows.map(r => r.route + ':' + r.key)));
			}

			// No value, from the gateway's own mouth. Asserted over the field
			// NAMES rather than over one expected shape: a value added later
			// under any name at all fails this.
			const allowed = ['route', 'key', 'label', 'help', 'prefix', 'set', 'hint',
				'overridden', 'configured', 'set_by', 'set_at'];
			const extra = [];
			rows.forEach(r => Object.keys(r).forEach(f => {
				if (!allowed.includes(f)) extra.push(r.key + '.' + f);
			}));
			check('the registry answers with presence and provenance and nothing else',
				extra.length === 0,
				'fields nobody here expected, each needing the same question asked of it '
				+ '-- does this carry any part of a value? ' + JSON.stringify(extra));
			check('no hint is long enough to be a key',
				rows.every(r => !r.hint || (r.hint.length <= 8 && r.hint.indexOf('…') === 0)),
				JSON.stringify(rows.map(r => r.hint)));

			// The wrong paste, refused BEFORE it is stored. Run against every
			// credential that declares a prefix, so the search keys are covered
			// the moment they declare one, and the inference key covers the
			// mechanism meanwhile. A wrong prefix is caught by `shaped_like`
			// ahead of any call to the provider, so nothing here reaches a
			// network.
			const prefixed = rows.filter(r => r.prefix);
			check('at least one credential declares a prefix to be checked against',
				prefixed.length > 0,
				'no registered credential declares one, so nothing tests the refusal');
			for (const r of prefixed) {
				const wrong = 'zz-wrong-' + r.key;
				const res = await api(ownerPage, 'secrets',
					{ route: r.route, key: r.key, value: wrong });
				const msg = (res.j && res.j.error) || '';
				check(`${r.key}: a wrong prefix is refused`, res.status === 400,
					'status ' + res.status + ' ' + msg);
				check(`${r.key}: the refusal names the prefix it wanted`,
					msg.includes(r.prefix), msg);
				const after = await api(ownerPage, 'secrets');
				const now = ((after.j && after.j.secrets) || []).find(x => x.key === r.key) || {};
				check(`${r.key}: the refused value was not stored`,
					now.overridden === false, JSON.stringify(now));
			}

			// The other half of "a viewer cannot read a value back": a viewer
			// cannot reach the view at all, so there is no value to redact.
			check('the owner may grant viewer',
				(await api(ownerPage, 'operators',
					{ account_id: other, role: 'viewer' })).status === 200);
			const asViewer = await api(otherPage, 'secrets');
			check('a viewer is refused the credentials view outright',
				asViewer.status === 403, 'status ' + asViewer.status);
			check('a viewer may still read the knobs',
				(await api(otherPage, 'settings')).status === 200);

			await ownerCtx.close();
			await otherCtx.close();
		}
	}
} catch (e) {
	check('the run completed without throwing', false, e.message);
} finally {
	await browser.close();
	cleanup();
}

console.log('');
console.log(`passed ${ok.length}, failed ${bad.length}` + (BREAK ? `   [--break ${BREAK}]` : ''));
if (bad.length) { console.log('failures:'); bad.forEach(b => console.log('  - ' + b)); }
process.exit(bad.length ? 1 : 0);

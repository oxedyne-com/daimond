// verify_credits.mjs — credits buy inference: a balance is a provider row, and its key is minted.
//
// Daimond had two halves that did not touch. BYOK inference ran in the browser against a key the
// user pasted; credits paid for web fetches, mail, sync and tools through the gateway. A user with
// $10 in their account and no key of their own could do everything the app does EXCEPT think, and
// the model picker told them so: "no model connected". This is the seam.
//
// The shape of the fix is the thing to keep honest, so it is what is checked hardest:
//
//   * The gateway MINTS a provider key; it does not proxy the request. The browser still calls the
//     provider directly, which is the entire product. A test that let a relay creep in would be
//     testing a different application.
//   * That minted key is a bearer credential for money and has NO at-rest story: it must not reach
//     localStorage, sealed or otherwise. Asserted by dumping storage and grepping for the key —
//     and, first, by proving the key was really there to leak, so the grep cannot pass vacuously.
//   * Two economies now share one picker. Some rows spend the user's Daimond balance; the rest are
//     billed by a provider the user holds their own account with. A user must be able to see which
//     BEFORE they pick, because the same model sits on both.
//
// The gateway is not running locally (/api/* is a 502 from dev/serve.mjs), so its four calls and
// the provider behind the minted key are FETCH-stubbed — the store is never touched, and every
// assertion below is against the real wasm, the real models.js and the real DOM.
import { open, signInAs, connectMock, shot, errors, mockLog, clearMockLog, MOCK } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// A key shaped like the real thing and unmistakable in a haystack: the storage check greps for it.
const keyN = (n) => `sk-or-v1-MINT${n}-zqxwmarker0000000000000000000000000000000000`;
// What the gateway actually hands back is a BASE url -- its `DEFAULT_INFERENCE_URL`, which is what
// its operator configures and what the host documents -- and NOT the endpoint a turn is posted to.
// The client has to make the second out of the first. Stubbing the endpoint here instead would
// have tested a contract nobody implements, and passed while every real turn 404'd.
const OR_BASE = 'https://openrouter.ai/api/v1';
const OR_URL  = `${OR_BASE}/chat/completions`;
// The gateway caps a minted key at min(float, balance), and its float is $2.00 -- so a key is
// routinely spent while the account still holds credits. That gap is the whole reason a refusal
// mid-session is answered with a fresh key rather than reported as a bad key.
const FLOAT  = 200;
const CORS   = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json   = (body, status = 200) => ({
	status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
});

// What OpenRouter answers /models with, in miniature but in its real shape: vendor-prefixed ids,
// the frontier models a credits user is buying access to, and — deliberately — `z-ai/glm-5p2`,
// which the BYOK mock provider also serves as `accounts/fireworks/models/glm-5p2`. One model, two
// hosts, two prefixes, one bare name. That collision is the case the picker must not fudge.
const CATALOGUE = [
	'anthropic/claude-opus-4.5',
	'openai/gpt-5.2',
	'deepseek/deepseek-v3',
	'meta-llama/llama-3.3-70b-instruct',
	'qwen/qwen3-235b-a22b',
	'z-ai/glm-5p2',
];

// The gateway's answers, and the levers a test pulls on them.
const gw = {
	bal:      840,          // minor units: $8.40
	mints:    0,            // POSTs to /api/inference-key
	refuse:   false,        // the account has run dry: every mint is refused
	chatHits: 0,            // POSTs the browser made to the provider, direct
	spent:    [],           // keys the provider now refuses, as a minted key's cap is reached
	// Which requests a spent key is refused for. A conductor's turn and the workers it dispatches
	// run on the SAME key, and the conductor must survive to dispatch them at all -- so the worker
	// test spends the key only for the workers. A worker's system prompt says "You are a worker
	// agent dispatched...", which is the request identifying itself and needs no bookkeeping here.
	onlyFor:  null,
};
/// The marker in a worker's system prompt (src/wasm/diamond.rs: WORKER_PROMPT).
const WORKER_SAYS = /You are a worker agent dispatched/;

async function stubGateway(page) {
	// bootstrap(): register the device key, prove possession, take a session.
	await page.route('**/api/account',        r => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-zqxw', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: gw.bal, currency: 'usd', entries: [] })));

	// The contract under test: session-authed, empty body, a key capped at the balance.
	await page.route('**/api/inference-key', r => {
		gw.mints++;
		gw.mintHead = r.request().headers();
		// "Your tab is too old to serve." Only reachable because the client names its version.
		if (gw.stale426) return r.fulfill(json({ ok: false, error: 'Client too old.', min_api: 99, api: 99 }, 426));
		// A dry account is `402 Payment Required` with the gateway's own copy, not a 200 with a
		// flag: the client has to read the status and the body, as the real one sends both.
		if (gw.refuse) return r.fulfill(json({
			ok: false, credits_minor: 0,
			error: 'The account has no credits, so Daimond cannot buy inference for it. '
				+ 'Add credits, or bring your own model key.',
		}, 402));
		return r.fulfill(json({
			ok: true, key: keyN(gw.mints), url: OR_BASE,
			limit_minor: Math.min(FLOAT, gw.bal), credits_minor: gw.bal, currency: 'usd',
		}));
	});

	// The provider, which the BROWSER talks to and the gateway never sees.
	await page.route('https://openrouter.ai/api/v1/models',
		r => r.fulfill(json({ data: CATALOGUE.map(id => ({ id })) })));

	// A minted key is capped at the balance behind it, so the provider refuses it the moment that
	// cap is spent — indistinguishable, from out here, from a bad key. Otherwise the request is
	// handed to the mock LLM, so a turn really completes and the retry can be seen to have worked.
	await page.route(OR_URL, async (r) => {
		gw.chatHits++;
		const auth = r.request().headers()['authorization'] || '';
		const sent = r.request().postData() || '';
		const spent = gw.spent.some(k => auth.includes(k));
		if (spent && (!gw.onlyFor || gw.onlyFor.test(sent))) {
			return r.fulfill(json({ error: { message: 'Key limit exceeded' } }, 401));
		}
		const res  = await fetch(MOCK, {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: r.request().postData(),
		});
		const body = await res.text();
		return r.fulfill({
			status: res.status, headers: CORS,
			contentType: res.headers.get('content-type') || 'application/json',
			body,
		});
	});
}

// ── A session that has credits and no key of its own ──────────────────
const s = await open({ name: 'credits', signIn: false, connect: false });
const { page } = s;
await stubGateway(page);
await signInAs(s, 'credits');
await page.waitForTimeout(2500);        // unlock → bootstrap → mint → list the catalogue

check('unlocking mints a key (the balance is asked for models, not just shown)', gw.mints === 1, `${gw.mints} mint(s)`);

// ── The contract version rides on the mint, and is not a second copy ──
// The gateway only refuses a client that NAMES a version it knows is too old, so a mint that sent
// no version could never be refused -- the 426 branch would be unreachable code that reads as
// though it works.
const clientApi = await page.evaluate(() => window.DaimondGateway.clientApi());
check('the mint sends x-daimond-api', (gw.mintHead || {})['x-daimond-api'] === String(clientApi),
	`sent ${JSON.stringify((gw.mintHead || {})['x-daimond-api'])}, gateway.js says ${clientApi}`);
const modelsSrc = await (await fetch('http://localhost:8777/js/models.js')).text();
check('...read from gateway.js rather than copied — one copy of that number exists in the client',
	/DaimondGateway\.clientApi\(\)/.test(modelsSrc) && !/CLIENT_API\s*=/.test(modelsSrc),
	'models.js reads the version and declares none of its own');

// The 426 itself is exercised further down, once the assertions about the FIRST minted key are
// out of the way -- proving it mints a fresh key, which would renumber them.

const row = () => page.evaluate(() => {
	const M = window.DaimondModels;
	return (M.providers() || []).find(p => p.id === 'credits') || null;
});

const p0 = await row();
check('a credits provider row exists', !!p0, p0 ? p0.id : 'absent');
check('hasKey() counts a live in-memory key (the bug: a minted key reported hasKey:false)',
	!!p0 && p0.hasKey === true, `hasKey=${p0 && p0.hasKey}`);
check('the row is ready, so the picker will not disable it', !!p0 && p0.ready === true, `ready=${p0 && p0.ready}`);
check('a minted key is never "sealed" — there is nothing stored to seal', !!p0 && p0.sealed === false);
check('the catalogue behind the key is listed', !!p0 && p0.count === CATALOGUE.length, `${p0 && p0.count} models`);
check('the frontier models a credits user is buying are in it',
	!!p0 && p0.models.includes('anthropic/claude-opus-4.5') && p0.models.includes('openai/gpt-5.2'));

// ── The key must have no at-rest story at all ─────────────────────────
// First prove it is really there, or the grep below passes for the wrong reason.
const live = await page.evaluate(() => window.DaimondModels.keyFor('credits'));
check('the minted key IS live in memory (so the storage check cannot pass vacuously)',
	live === keyN(1), live ? live.slice(0, 18) + '…' : '(empty)');

const dump = await page.evaluate(() => {
	let all = '';
	for (let i = 0; i < localStorage.length; i++) all += localStorage.key(i) + '=' + localStorage.getItem(localStorage.key(i)) + '\n';
	for (let i = 0; i < sessionStorage.length; i++) all += sessionStorage.key(i) + '=' + sessionStorage.getItem(sessionStorage.key(i)) + '\n';
	return all;
});
check('THE MINTED KEY IS NOWHERE IN localStorage OR sessionStorage', !dump.includes(keyN(1)),
	dump.includes(keyN(1)) ? 'LEAKED' : `${dump.length} bytes of storage searched`);
check('nothing key-shaped from the mint leaked under another name', !dump.includes('zqxwmarker'));

const stored = await page.evaluate(() => {
	const st = JSON.parse(localStorage.getItem('daimond-models-v2') || '{}');
	const c  = (st.providers || {}).credits;
	return c ? { has: true, key: c.key, keyEnc: c.keyEnc, url: c.url, models: (c.models || []).length } : { has: false };
});
check('the row IS stored (its name, host and models are not secrets)', stored.has === true);
check('...with an empty `key` AND an empty `keyEnc` — not sealed, absent',
	stored.key === '' && stored.keyEnc === '', `key=${JSON.stringify(stored.key)} keyEnc=${JSON.stringify(stored.keyEnc)}`);
check('the gateway\'s BASE url is turned into the endpoint a turn is actually posted to',
	stored.url === OR_URL, `${OR_BASE} → ${stored.url}`);
check('...and it is the gateway\'s host, not one hardcoded in the client', stored.url.startsWith(OR_BASE));
check('the key\'s cap is NOT the balance: a key can be spent while credits remain',
	(await page.evaluate(() => window.DaimondModels.creditsState())).limit === FLOAT,
	`limit=${(await page.evaluate(() => window.DaimondModels.creditsState())).limit} of ${gw.bal} balance`);

// ── The row, on screen ────────────────────────────────────────────────
await page.click('#astat-model', { force: true });
await page.waitForTimeout(600);
const head = await page.$eval('.models-prov.paid .models-prov-head', e => ({
	name: e.querySelector('.models-nm').textContent.trim(),
	bal:  (e.querySelector('.models-bal') || {}).textContent || '',
	via:  (e.querySelector('.models-via') || {}).textContent || '',
	count:(e.querySelector('.models-prov-count') || {}).textContent || '',
	all:  e.textContent,
}));
check('the row is named for what the user BOUGHT, not for the vendor', head.name === 'Daimond credits', JSON.stringify(head.name));
check('the vendor is NOT the headline', !head.name.includes('OpenRouter'), JSON.stringify(head.name));
check('the balance is inline on the row', head.bal === '$8.40 left', JSON.stringify(head.bal));
check('the host is named anyway — honesty about whose machine it lands on', head.via === 'via OpenRouter', JSON.stringify(head.via));
check('...read from the gateway\'s URL, so it is whoever was actually minted against',
	head.all.includes('OpenRouter') && stored.url.includes('openrouter.ai'));
check('the row counts its models', head.count.trim() === `${CATALOGUE.length} models`, head.count);

// "via" must be secondary, not a second headline: smaller and dimmer than the name it sits beside.
const rank = await page.$eval('.models-prov.paid .models-prov-head', (e) => {
	const px = (el) => parseFloat(getComputedStyle(el).fontSize);
	const nm = e.querySelector('.models-nm'), via = e.querySelector('.models-via'), bal = e.querySelector('.models-bal');
	// Each of the three must sit whole on one line: a break through any of them is the bug.
	const lines = (el) => el.getClientRects().length;
	return {
		name: px(nm), via: px(via), bal: px(bal),
		viaCol: getComputedStyle(via).color, nameCol: getComputedStyle(nm).color,
		wrapped: [nm, bal, via].filter(el => lines(el) > 1).length,
	};
});
check('in a 220px rail, name / balance / host each stay whole — the break falls BETWEEN facts',
	rank.wrapped === 0, `${rank.wrapped} of 3 broken across lines`);
check('"via OpenRouter" is SUBDUED: smaller than the name…', rank.via < rank.name, `${rank.via}px vs ${rank.name}px`);
check('…and dimmer than it', rank.viaCol !== rank.nameCol, `${rank.viaCol} vs ${rank.nameCol}`);
check('the balance is legible, not fine print', rank.bal >= rank.via, `${rank.bal}px vs ${rank.via}px`);
await shot(s, 'credits-row');

// ── The second economy: a key of the user's own ───────────────────────
await connectMock(s);
await page.waitForTimeout(800);
await page.click('#astat-model', { force: true });
await page.waitForTimeout(600);
const rows = await page.$$eval('.models-prov', els => els.map(e => ({
	name: e.querySelector('.models-prov-name').firstChild.textContent.trim(),
	paid: e.classList.contains('paid'),
})));
check('both economies are in the one list', rows.length === 2, JSON.stringify(rows.map(r => r.name)));
check('exactly one row is marked as spending the Daimond balance',
	rows.filter(r => r.paid).length === 1, JSON.stringify(rows));
check('the BYOK row is NOT marked — so a row that costs no credits is visibly not this',
	rows.some(r => !r.paid && r.name !== 'Daimond credits'));

// The rows are told apart by more than a class: the tint must actually differ.
const tint = await page.$$eval('.models-prov .models-prov-head',
	els => els.map(e => getComputedStyle(e).backgroundColor));
check('the paid row is visibly tinted, not just semantically flagged',
	new Set(tint).size === 2, JSON.stringify(tint));

// The tint is theme variables, not a hardcoded brown: which economy a row belongs to is not a
// fact about the dark theme, and a user in the light one is owed the same warning.
for (const theme of ['light', 'lollypop']) {
	await page.evaluate((t) => window.DaimondTheme.set(t), theme);
	await page.waitForTimeout(500);
	const t = await page.$$eval('.models-prov .models-prov-head', els => els.map(e => getComputedStyle(e).backgroundColor));
	check(`the paid row is still told apart in the ${theme} theme`, new Set(t).size === 2, JSON.stringify(t));
	const c = await page.$eval('.models-prov.paid .models-nm', e => ({
		fg: getComputedStyle(e).color,
		bg: getComputedStyle(e.closest('.models-prov-head')).backgroundColor,
	}));
	check(`...and its name is legible against that tint`, c.fg !== c.bg, JSON.stringify(c));
	await shot(s, `credits-${theme}`);
}
await page.evaluate(() => window.DaimondTheme.set('dark'));
await page.waitForTimeout(400);

// ── The picker: where the two economies actually collide ──────────────
await page.evaluate(() => {
	const sel = document.createElement('select');
	sel.id = 'zz-probe';
	document.body.appendChild(sel);
	window.DaimondModels.fillSelect(sel, '', '');
});
const opts = await page.$$eval('#zz-probe option', els => els.map(o => ({
	text: o.textContent, value: o.value, provider: o.dataset.provider,
	paid: o.dataset.paid, group: o.parentElement.label || '', disabled: o.disabled,
})));
const groups = [...new Set(opts.map(o => o.group))];
check('the picker groups by provider', groups.length === 2, JSON.stringify(groups));
check('the credits group names the balance and the host in its heading',
	groups.some(g => g.includes('Daimond credits') && g.includes('$8.40 left') && g.includes('via OpenRouter')),
	JSON.stringify(groups));
// The BYOK group keeps the label it has always had. The mark has to be the exception to read as
// one: relabel every group and the credits row stops standing out from the list it sits in.
check('the BYOK group is left alone — only the paid row is relabelled',
	groups.some(g => g === 'Custom provider'), JSON.stringify(groups));

const credOpts = opts.filter(o => o.provider === 'credits');
check('every credits model is offered', credOpts.length === CATALOGUE.length, `${credOpts.length}`);
check('EVERY credits option is marked on the option itself, not only in the group heading',
	credOpts.every(o => o.text.includes('· credits')),
	JSON.stringify(credOpts.slice(0, 2).map(o => o.text)));
check('a credits option is not disabled', credOpts.every(o => !o.disabled));
check('the option carries the economy for a reader that is not a human',
	credOpts.every(o => o.paid === '1'));

// The collision: one model, two rows, two economies.
const twins = opts.filter(o => o.value.toLowerCase().endsWith('glm-5p2'));
check('the same model on two providers appears TWICE — never silently deduped',
	twins.length === 2, JSON.stringify(twins.map(t => t.value)));
check('...on different providers, so the key sent with it differs',
	new Set(twins.map(t => t.provider)).size === 2, JSON.stringify(twins.map(t => t.provider)));
check('...and the two are distinguishable by their text alone',
	twins.length === 2 && twins[0].text !== twins[1].text, JSON.stringify(twins.map(t => t.text)));
check('the credits twin says "credits"', twins.some(t => t.provider === 'credits' && t.text.includes('· credits')));
check('the BYOK twin says "your key" — the pair is marked on BOTH sides',
	twins.some(t => t.provider !== 'credits' && t.text.includes('· your key')),
	JSON.stringify(twins.map(t => t.text)));

// A BYOK model NOT served by the credits row stays unmarked: the mark means something.
const lone = opts.find(o => o.value === 'mock/thinker');
check('a BYOK model with no twin carries no mark — an unmarked row reads as "not credits"',
	!!lone && !lone.text.includes('·'), lone && JSON.stringify(lone.text));
await page.evaluate(() => document.getElementById('zz-probe').remove());

/// Open the credits row's body, whatever it was showing before. The panel remembers which rows are
/// expanded, so a blind click is as likely to shut it as to open it.
async function expandCredits() {
	if (await page.$('.models-prov.paid .models-prov-body')) return;
	await page.click('.models-prov.paid .models-prov-head', { force: true });
	await page.waitForSelector('.models-prov.paid .models-prov-body', { timeout: 5000 });
	await page.waitForTimeout(300);
}

// ── A turn: the browser calls the provider, and Daimond is not in the path ──
await page.click('#astat-model', { force: true });
await page.waitForTimeout(500);
await expandCredits();
await page.$$eval('.models-prov.paid .models-model', (els) => {
	for (const e of els) if (e.textContent.includes('mock')) { e.click(); return; }
	els[0].click();                                   // the catalogue is stubbed; any of it will do
});
await page.waitForTimeout(500);
const def = await page.evaluate(() => window.DaimondModels.getDefault());
check('a credits model can be starred as the default', def.provider === 'credits', JSON.stringify(def));

const mintsBefore = gw.mints;
gw.spent = [keyN(1)];                    // the key minted at unlock has now spent its cap
gw.chatHits = 0;
clearMockLog();                          // so the retry's request can be read back off the wire

await page.click('#new-session-btn', { force: true });
await page.waitForTimeout(600);
const start = page.locator('button:has-text("Start")').first();
if (await start.count()) await start.click({ force: true });
await page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 });
await page.fill('#chat-input', '@text Hello from a credits chat.');
await page.click('#chat-send', { force: true });
await page.waitForTimeout(6000);

const t1 = await page.evaluate(() => (document.getElementById('chat-output') || {}).innerText || '');
check('a 401 mid-session re-mints EXACTLY ONCE', gw.mints === mintsBefore + 1, `${gw.mints - mintsBefore} re-mint(s)`);
check('the turn was retried on the fresh key and completed', gw.chatHits === 2, `${gw.chatHits} provider call(s)`);
check('the answer is on screen', /hello|mock/i.test(t1), JSON.stringify(t1.slice(-120)));
check('the recovered 401 was never written into the conversation',
	!/401|rejected|refused/i.test(t1), JSON.stringify(t1.slice(-160)));

// The retried turn is a REBUILT agent, seeded from the persisted history — which by then already
// holds the message being sent, because runTurn persists before a token comes back. Read what the
// model was actually asked: seeding it AND passing it to run_turn would ask the same question
// twice, and that is invisible from the transcript, which shows the user's own bubble either way.
const sent = mockLog();
const asked = sent.length
	? sent[sent.length - 1].messages.filter(m => m.role === 'user' && /Hello from a credits chat/.test(m.content || ''))
	: [];
check('the mock was reached on the fresh key (so the next check can mean something)', sent.length === 1, `${sent.length} request(s)`);
check('the retry asked the model the question ONCE, not twice (it is excluded from the restore)',
	asked.length === 1, `${asked.length} copies of the user message on the wire`);
check('the retried request carried the NEW key, not the spent one',
	gw.chatHits === 2 && !gw.spent.includes(keyN(2)));
await shot(s, 'credits-turn');

// ── Out of credits: a thing to do, not an HTTP error to read ──────────
gw.spent  = [keyN(1), keyN(2), keyN(3)];      // every key is refused…
gw.refuse = true;                             // …and the account cannot mint another
gw.bal    = 0;
const mintsBefore2 = gw.mints;
await page.fill('#chat-input', '@text And again.');
await page.click('#chat-send', { force: true });
await page.waitForTimeout(6000);
const t2 = await page.evaluate(() => (document.getElementById('chat-output') || {}).innerText || '');
check('a dry account is still only ONE re-mint attempt, not a retry storm',
	gw.mints === mintsBefore2 + 1, `${gw.mints - mintsBefore2} attempt(s)`);
check('the user is told to TOP UP, not shown a raw HTTP error',
	/run out|top up/i.test(t2) && !/\b401\b/.test(t2), JSON.stringify(t2.slice(-200)));
check('...and is offered the other way out: their own key',
	/provider key of your own/i.test(t2), JSON.stringify(t2.slice(-140)));

// The row must now say so itself, rather than offering models it cannot run.
await page.click('#astat-model', { force: true });
await page.waitForTimeout(600);
await expandCredits();
const dry = await page.$eval('.models-prov.paid', e => ({
	key: (e.querySelector('.models-prov-key') || {}).textContent || '',
	bal: (e.querySelector('.models-bal') || {}).textContent || '',
	why: (e.querySelector('.models-why') || {}).textContent || '',
}));
check('the row says "no credits" once the balance is gone', dry.key.includes('no credits'), JSON.stringify(dry.key));
check('a stale balance is not left on screen', dry.bal === '', JSON.stringify(dry.bal));
check('the GATEWAY\'s own words reach the user, not a flattened one-word state',
	dry.why.includes('bring your own model key'), JSON.stringify(dry.why.slice(0, 60)));
const dryRow = await row();
check('a dry credits row is not ready, so its models are disabled in the picker', dryRow.ready === false);
check('the row is NOT removed — a user who has just run out must see what happened', !!dryRow);
await expandCredits();
const topup = await page.$$eval('.models-prov.paid .models-refetch', els => els.map(e => e.textContent));
check('and it offers the fix, which is the only thing here a button can fix',
	topup.some(t => /top up/i.test(t)), JSON.stringify(topup));
check('a credits row offers no "Remove" — a balance is not the user\'s to delete from a panel',
	(await page.$$eval('.models-prov.paid .models-remove', els => els.length)) === 0);
await shot(s, 'credits-dry');

// ── Locking forgets it, because that is the whole of forgetting it ────
gw.refuse = false; gw.bal = 840; gw.spent = [];
await page.evaluate(() => window.DaimondModels.lock());
await page.waitForTimeout(300);
const afterLock = await page.evaluate(() => ({
	key:  window.DaimondModels.keyFor('credits'),
	row:  (window.DaimondModels.providers() || []).find(p => p.id === 'credits'),
	st:   window.DaimondModels.creditsState(),
}));
check('locking forgets the minted key outright', !afterLock.key, JSON.stringify(afterLock.key));
check('a locked credits row cannot run', afterLock.row.ready === false && afterLock.row.hasKey === false);
check('a locked row shows no balance', afterLock.st.credits === 0 && afterLock.row.balance === '');

// ── Dispatched agents survive a spent key, and do NOT storm the mint ──
//
// A worker's key is frozen when its agent is built, exactly as a chat's is, and it spends the same
// minted key. Daimond's claim is a team rather than a chat, so a credits user whose chat heals
// while their agents die on that same exhausted key has the worst of both halves.
//
// The dangerous part is the healing, not the failing. The gateway keeps at most ONE live key per
// account -- minting revokes the last -- so N agents that hit a spent key together must produce
// ONE mint. N mints would each revoke the one before, and the agents would chase each other round
// spending real money per lap. That is what is measured here: not "did it recover" but "how many
// keys did it buy to recover".
gw.refuse = false; gw.bal = 840; gw.spent = [];

// ── A 426 on the mint: the tab is too old to serve ────────────────────
// Reachable only because the client names its version, which is the point of sending it. It must
// reach the updater -- the one thing that can fix a tab that is behind the gateway.
//
// `daimond:stale` is a real force-reload, so the loop guard is pre-set to this build (as
// verify_version.mjs does): otherwise the proof reloads the page out from under the test. That the
// event turns INTO a reload is verify_updates.mjs's subject; that the mint fires it is this one's.
await page.evaluate(() => {
	var b = window.DaimondUpdater && window.DaimondUpdater.booted();
	try { if (b) sessionStorage.setItem('daimond-forced-from', b); } catch (e) {}
});
gw.stale426 = true;
const stale = await page.evaluate(() => new Promise(resolve => {
	window.addEventListener('daimond:stale', () => resolve(true), { once: true });
	setTimeout(() => resolve(false), 3000);
	window.DaimondModels.remint().catch(() => {});
}));
gw.stale426 = false;
check('a 426 on the mint tells the updater this tab is out of date', stale === true);

await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'credits');
await page.waitForTimeout(2500);

const liveKey = await page.evaluate(() => window.DaimondModels.keyFor('credits'));
const genBefore = await page.evaluate(() => window.DaimondModels.creditsGen());
check('the session is back on a live minted key', !!liveKey && liveKey === keyN(gw.mints));

// Star a credits model as the default: a worker runs on whatever the default is.
await page.evaluate(() => window.DaimondModels.setDefault('credits', 'anthropic/claude-opus-4.5'));
await page.waitForTimeout(400);

// A Diamond, whose conductor dispatches three agents in one turn -- the concurrent case.
await page.click('#new-diamond-btn', { force: true });
await page.waitForSelector('.dlg-input', { timeout: 10000 });
await page.fill('.dlg-input', 'Credits worker test');
await page.click('.dlg-ok', { force: true });
await page.waitForTimeout(900);
await page.$$eval('.diamond-box', els => els[0].click());
await page.waitForTimeout(600);

// The key is spent for WORKERS only: the conductor's own turn runs on the same key, and if it
// cannot finish it never dispatches anything and the case under test never happens.
gw.spent = [liveKey];
gw.onlyFor = WORKER_SAYS;
const mintsBefore4 = gw.mints;
clearMockLog();
await page.fill('#steer-input',
	'@tools spawn_agent {"name":"w1","task":"@text one"} ;; spawn_agent {"name":"w2","task":"@text two"} ;; spawn_agent {"name":"w3","task":"@text three"}');
await page.keyboard.press('Enter');
await page.waitForTimeout(14000);

// One worker = one `.acard`, whose class carries its status (running/done/error).
const agents = () => page.$$eval('#agents-list .acard', els => els.map(e => ({
	text: e.innerText || '', cls: e.className || '',
})));
let runs = await agents();
// Vacuously-true checks are worse than no checks: every assertion below is about agents, so
// nothing below may pass on a pane that has none.
check('the conductor dispatched three agents (nothing below is true of an empty pane)',
	runs.length === 3, `${runs.length} agent tile(s)`);
// The measurement that matters. Not "did it recover" -- "how many keys did it buy to recover".
//
// Each worker now holds its OWN slot key (6da5d0b, 2026-07-18): a shared key is
// exactly what let concurrent workers race the host's stale cap check into an
// overspend, so three workers refused on their three keys legitimately mint
// three. "No storm" is therefore ONE mint per worker, not one between them --
// a fourth mint would be the retry ring this check exists to catch.
check('THREE refused agents mint ONE key EACH — a slot apiece, and no retry ring',
	gw.mints === mintsBefore4 + 3, `${gw.mints - mintsBefore4} mint(s) for 3 agents`);
// Slot 0 is the chat's own key. A worker's refusal must not disturb it, or a
// fan-out would re-key the conversation that dispatched it.
check('the chat’s own key is untouched by a worker’s re-mint',
	(await page.evaluate(() => window.DaimondModels.creditsGen())) === genBefore,
	`slot 0 generation ${await page.evaluate(() => window.DaimondModels.creditsGen())}, was ${genBefore}`);
check('every agent recovered on the fresh key rather than dying on the spent one',
	runs.length === 3 && runs.every(r => !/401|rejected|error/i.test(r.text)),
	JSON.stringify(runs.map(r => r.text.slice(0, 40))));
check('every agent finished its task',
	runs.length === 3 && runs.filter(r => /one|two|three/i.test(r.text)).length === 3,
	JSON.stringify(runs.map(r => r.text.slice(0, 60))));
// The workers really did meet the spent key: otherwise this proves nothing about healing.
const workerReqs = mockLog().filter(m => (m.messages || []).some(x => WORKER_SAYS.test(x.content || '')));
check('the workers did reach the model on the new key (they were really refused first)',
	workerReqs.length === 3, `${workerReqs.length} worker request(s) landed`);
await shot(s, 'credits-workers');

// A worker that genuinely cannot heal says "top up", not 401.
gw.spent = [keyN(gw.mints)]; gw.refuse = true; gw.bal = 0;
const mintsBefore5 = gw.mints;
await page.fill('#steer-input', '@tool spawn_agent {"name":"w4","task":"@text four"}');
await page.keyboard.press('Enter');
await page.waitForTimeout(12000);
runs = await agents();
check('a worker that cannot heal tries ONE mint, not a retry storm',
	gw.mints === mintsBefore5 + 1, `${gw.mints - mintsBefore5} attempt(s)`);
check('the failed agent is marked failed, not quietly done',
	runs.some(r => /\berror\b/.test(r.cls) && /w4/.test(r.text)), JSON.stringify(runs.map(r => r.cls)));

// A worker's message lives behind its own "Read", which is the only way a user sees it -- so it
// is the way the message is read here too, rather than reaching into the object behind the tile.
const w4text = await page.evaluate(async () => {
	const cards = [...document.querySelectorAll('#agents-list .acard')];
	const card = cards.find(c => /w4/.test(c.innerText));
	if (!card) return '(no w4 tile)';
	const read = [...card.querySelectorAll('.abtn')].find(b => b.textContent === 'Read');
	if (!read) return '(no Read button)';
	read.click();
	await new Promise(r => setTimeout(r, 400));
	const dlg = document.querySelector('.dlg-body, .dlg-text, .dlg');
	return dlg ? dlg.innerText : '(no dialog)';
});
// The words are the GATEWAY's, not a phrase of the client's own -- the same rule
// the credits row is held to above ("the GATEWAY's own words reach the user").
// What is asserted is therefore the SUBSTANCE the user must be given: that there
// are no credits, and the two ways out. Not a raw status code, and not a wording
// the client would have to keep in step with the host.
check('...and fails by saying there are no credits, not by showing a raw 401',
	/credit/i.test(w4text) && !/\b401\b/.test(w4text), JSON.stringify(w4text.slice(-220)));
check('...and names both ways out: add credits, or bring a key of your own',
	/add credits/i.test(w4text) && /own (model|provider) key|key of your own/i.test(w4text),
	JSON.stringify(w4text.slice(-120)));
await shot(s, 'credits-workers-dry');
gw.refuse = false; gw.bal = 840; gw.spent = []; gw.onlyFor = null;

// ── A reload holds no key, and mints a new one ────────────────────────
const mintsBefore3 = gw.mints;
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'credits');
await page.waitForTimeout(2500);
const after = await page.evaluate(() => ({
	key: window.DaimondModels.keyFor('credits'),
	row: (window.DaimondModels.providers() || []).find(p => p.id === 'credits'),
}));
check('a reload re-mints rather than reloading a key from disk', gw.mints === mintsBefore3 + 1, `${gw.mints - mintsBefore3}`);
check('the key after a reload is a NEW one, not the old one back', after.key === keyN(gw.mints) && after.key !== keyN(1),
	after.key ? after.key.slice(0, 18) + '…' : '(empty)');
check('the models survive the reload (the row is stored; only the key is not)', after.row.count === CATALOGUE.length);

// The 502s are the gateway this test deliberately does not run. The 401, 402 and 426 are this
// test's own injections -- a spent key, a dry account, and a tab too old. Everything else is a
// real complaint.
const errs = errors(s).filter(e => !/502 \(Bad Gateway\)/.test(e) && !/401 \(Unauthorized\)/.test(e)
	&& !/402 \(Payment Required\)/.test(e) && !/426 \(Upgrade Required\)/.test(e));
check('no console errors beyond the offline gateway and the injected 401/402/426',
	errs.length === 0, JSON.stringify(errs.slice(0, 3)));
await s.close();

// ── A user with no credits gets no row at all ─────────────────────────
// The panel of somebody who only ever wanted their own key must not grow a row advertising models
// they cannot run — and `providers().length` decides whether a first run opens the add-a-key form.
gw.bal = 0; gw.refuse = true; gw.mints = 0;
const b = await open({ name: 'creditsB', signIn: false, connect: false });
await stubGateway(b.page);
await signInAs(b, 'creditsB');
await b.page.waitForTimeout(2000);
const none = await b.page.evaluate(() => window.DaimondModels.providers().map(p => p.id));
check('a zero balance mints nothing at all', gw.mints === 0, `${gw.mints} mint(s)`);
check('and adds no row: a BYOK-only user sees no credits row they never asked for',
	none.length === 0, JSON.stringify(none));
await b.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { console.log('FAILED:\n  - ' + bad.join('\n  - ')); process.exit(1); }

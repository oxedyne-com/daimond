// verify_toolspanel.mjs — the Tools panel presents CAPABILITIES, and the shelf is real.
//
// The panel used to be a manifest: twenty-two rows, each the wire name of a function in
// the Rust registry. The unit is now the CAPABILITY — one thing Daimond does, said in
// those terms — and the functions live behind a disclosure on the capability that grants
// them. Six properties are worth a verifier and the rest is decoration:
//
//   1. THE ROW IS A CAPABILITY AND THE FUNCTION IS BEHIND IT. Asserted by MEANING and
//      never by arity: the row named "Using a website" is the one that opens to reveal
//      `web_click`, and `web_click` is NOT ON SCREEN until it is opened. Measured with
//      `checkVisibility()`, so "hidden" is what the browser says rather than what the
//      markup implies.
//
//   2. NOTHING THE REGISTRY OFFERS GOES MISSING. Every function `builtin_tools()`
//      reports appears under exactly one capability — not one it has been told about,
//      the whole list, so a tool added to Rust tomorrow is either placed or loud. The
//      panel's `other` bucket catches the unplaced, and it must be EMPTY: a bucket that
//      is allowed to fill is a bucket nobody reads.
//
//   3. A PACK THE GATEWAY DOES NOT SELL IS NOT DRAWN AS LOCKED. Typesetting carries a
//      pack key in Rust, and a gateway answering an empty catalogue — an operator who has
//      not switched the price on, or one who has taken it off again — leaves it included,
//      and the panel says so. Nothing free may be drawn as buyable, and this is the check
//      that holds that line.
//
//   4. A PACK THE GATEWAY DOES SELL MOVES TO THE SHELF, SAYS WHY IT IS LOCKED, AND STILL
//      OPENS TO ITS FUNCTIONS. Same account, same build, one field of the gateway's
//      answer different. Both directions are asked, because "it can lock" and "it does
//      not lock what it should not" are different failures.
//
//   5. THE BUY BUTTON BUYS THE THING IT IS UNDER. Counted AT THE NETWORK — the request
//      that leaves the page must carry that pack's key — so a button wired to the wrong
//      row, or to nothing at all, is caught. A control drawn without a caller is this
//      app's most expensive recurring defect.
//
//   6. THE LOCK REACHES THE ENGINE. `/api/tools` is the only thing that knows what was
//      bought and the wasm is the only thing that can refuse a tool; the panel is the
//      wire between them. Read back through `tool_locked('typst_compile')`, which is the
//      very call `www/js/typst.js` makes before building the compiler — so this asserts
//      the gate the person meets, not a variable the panel set. THIS WIRE DID NOT EXIST
//      BEFORE THIS WORK: `set_locked_packs` had no production caller at all, and the
//      whole typesetting gate was unreachable.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a deliberately
// damaged copy of a source file to the real page (through `page.route`, so the browser
// loads it as it loads any other script) and the run is expected to FAIL. A break that
// does not apply cleanly aborts rather than passing quietly: a check proved against code
// that was never broken is not proved at all.
//
//   node dev/verify_toolspanel.mjs --break manifest   # 1 fails: functions on show, no lid
//   node dev/verify_toolspanel.mjs --break drop       # 2 fails: a function placed nowhere
//   node dev/verify_toolspanel.mjs --break presume    # 3 fails: locked on the pack key alone
//   node dev/verify_toolspanel.mjs --break nowhy      # 4 fails: locked with no reason given
//   node dev/verify_toolspanel.mjs --break misbuy     # 5 fails: the button buys the wrong pack
//   node dev/verify_toolspanel.mjs --break nopush     # 6 fails: the engine is never told
//   node dev/verify_toolspanel.mjs --break lid        # 1 fails: the lid draws and does nothing
//   node dev/verify_toolspanel.mjs                    # and then, clean
//
//   eval "$(bash dev/world.sh 5 --up)"
//   node dev/verify_toolspanel.mjs
//
// Needs dev/serve.mjs only. No gateway on :9002: every gateway route is stubbed here, and
// everything below the stub — the panel, the registry in the wasm, the lock the engine
// enforces — is the real code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'toolspanel' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The tool `Tool::TypstCompile` names, and the pack it is sold in. The KEY is read back
// out of the build (below, once the registry answers) rather than written down here,
// because it is the pack's name and not the tool's -- `drop01` today, whatever the drop
// after it is keyed tomorrow -- and a literal here would go stale the day it changed and
// take checks 3-6 quietly with it. Nothing is proved by construction that way: the key is
// the INPUT to the experiment, and what is asserted is what the panel does with it.
// `dev/verify_typstpack.mjs` is where the key is checked against the gateway's catalogue.
//
// The NAME and the PRICE below are the stubbed gateway's own, and are deliberately NOT the
// shipped catalogue's: a check that reads back a figure this file also supplied would pass
// on any number, so the number is one the real catalogue does not carry, and the name is
// one no catalogue would ever ship. The display name is the operator's to change without a
// rebuild, so a stub borrowing whatever it says today would start agreeing with it by
// accident tomorrow -- which is the same trap the price avoids.
const FN   = 'typst_compile';
const PRICE = 2500;
const PACKNAME = 'Fixture Pack';
let PACK = '';

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it. `find` must appear exactly
// once: a break that silently matched nothing would leave the suite green against
// working code and prove the opposite of what it claims.
const BREAKS = {
	// The old panel, in one line: every function drawn as its own row, at the top
	// level, with no capability over it and no lid on it. This is the shape the
	// redesign replaced, and check 1 is what says it is gone.
	manifest: [{
		file: 'js/tools.js',
		find: '\t\tif (!row.fns.length) return card;',
		with: '\t\tif (true) { row.fns.forEach(function (f) {\n'
			+ '\t\t\tvar l = el(\'div\', \'cap-fn\'); l.setAttribute(\'data-fn\', f.name);\n'
			+ '\t\t\tl.appendChild(el(\'code\', \'cap-fn-name\', f.name));\n'
			+ '\t\t\tcard.appendChild(l); }); return card; }',
	}],
	// A function the map does not place and the fallback does not catch: it is simply
	// dropped on the floor. This is the silent-disappearance failure, and check 2 is
	// what makes it loud.
	drop: [{
		file: 'js/tools.js',
		find: '\t\t\tvar id = capOf(fn.tool);\n',
		with: '\t\t\tvar id = capOf(fn.tool);\n\t\t\tif (fn.tool === \'web_click\') return;\n',
	}],
	// Locked on the pack key the build carries, without asking the gateway whether the
	// pack is on sale. This is the exact way a free capability gets drawn as buyable:
	// the browser presuming a sale the till knows nothing about.
	presume: [{
		file: 'js/tools.js',
		find: '\t\tif (!pack) return null;\n',
		with: '\t\tif (!pack) return null;\n\t\treturn { tool: pack, name: pack, blurb: \'\','
			+ ' price_minor: 999, unlocked: false, currency: \'usd\' };\n',
	}],
	// Locked, priced, and mute about it. The row shows a price and never says the
	// account has not bought the pack, which tells the reader the cost and not the
	// position they are in.
	nowhy: [{
		file: 'js/tools.js',
		find: '\t\tif (row.sale && !row.owned) {\n\t\t\ttxt.appendChild(el(\'div\', \'cap-why\',',
		with: '\t\tif (false) {\n\t\t\ttxt.appendChild(el(\'div\', \'cap-why\',',
	}],
	// The button is drawn on the right row and buys something else. It looks perfect.
	misbuy: [{
		file: 'js/tools.js',
		find: '\t\t\tb.addEventListener(\'click\', function () { unlock(row.sale.tool); });',
		with: '\t\t\tb.addEventListener(\'click\', function () { unlock(\'something_else\'); });',
	}],
	// The gateway is asked, the panel draws the answer, and the engine is never told —
	// which is precisely the state this file found the app in. Every visible check
	// still passes; only 6 goes red.
	nopush: [{
		file: 'js/tools.js',
		find: '\t\t\tvar mod = await import(PKG);\n\t\t\tmod.set_locked_packs(locked);',
		with: '\t\t\tvar mod = await import(PKG);\n\t\t\tif (mod) { /* told nothing */ }',
	}],
	// The lid draws, the button counts, the label toggles — and nothing moves, because
	// `display: flex` on the block outranks the browser's own `[hidden] { display: none }`.
	// This is not hypothetical: the panel shipped its first draft that way, and a check
	// that asked the CLASS or the attribute instead of the browser would have called it
	// green. It is here so that check 1 is known to be measuring the reader's screen.
	lid: [{
		file: 'css/tools.css',
		find: '.cap-fns[hidden] { display: none; }',
		with: '.cap-fns[hidden] { opacity: 0.99; }',
	}],
};

/// What a browser should be told a served file is. A stylesheet delivered as JavaScript
/// is dropped without a word, and the break would then prove nothing.
const mime = (file) => /\.css$/.test(file) ? 'text/css' : 'application/javascript';

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop. Nothing is served that was not verified to differ
/// from the file on disk.
function damaged(spec) {
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

// ── The stubbed gateway ──────────────────────────────────────────────

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (body, status = 200) => ({
	status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
});

// What `/api/tools` is answering right now. Swapped between phases, which is the whole
// experiment: one build, one account, one field of the gateway's answer different.
let catalogue = [];

// Every pack checkout that LEFT the page, in order. A button wired to nothing shows as a
// list that did not grow; one wired to the wrong row shows as the wrong key in it.
const buys = [];

async function stub(page) {
	if (BREAK) {
		for (const spec of BREAKS[BREAK]) {
			const body = damaged(spec);
			await page.route('**/' + spec.file, r => r.fulfill({
				status: 200, contentType: mime(spec.file), body,
			}));
		}
	}

	await page.route('**/api/account',        r => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-tp', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: 5000, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(json({ ok: true, licence: true, held: true, currency: 'usd' })));

	await page.route('**/api/tools', r => r.fulfill(json({
		ok: true, credits_minor: 5000, tools: catalogue,
	})));

	await page.route('**/api/checkout/pack', r => {
		let b = {};
		try { b = JSON.parse(r.request().postData() || '{}'); } catch (e) { b = {}; }
		buys.push(b.pack == null ? '' : String(b.pack));
		// No `url`, so the panel reports a failure and does NOT navigate away. What is
		// under test is which key left the page, not Stripe.
		return r.fulfill(json({ ok: false, error: 'stubbed' }));
	});
}

// ── Reading the panel ────────────────────────────────────────────────

/// The panel as a reader meets it: one entry per capability card on screen, in order,
/// carrying only what is VISIBLE.
///
/// `checkVisibility()` and not a class test: the question is whether the function is on
/// the reader's screen, and a `hidden` block, a `display:none` ancestor and a zero-height
/// container are all the same answer to that. Asked of the browser rather than inferred.
const readPanel = (page) => page.evaluate(() => {
	const vis = (n) => !!(n && (n.checkVisibility ? n.checkVisibility() : n.offsetParent !== null));
	const secs = [...document.querySelectorAll('#tools-body > .tools-sec')].map(n => n.textContent.trim());
	return {
		sections: secs,
		none:     [...document.querySelectorAll('#tools-body .tools-none')].map(n => n.textContent.trim()),
		cards: [...document.querySelectorAll('#tools-body .cap')].map(c => ({
			id:      c.getAttribute('data-cap'),
			state:   c.getAttribute('data-state'),
			name:    (c.querySelector('.cap-name') || {}).textContent || '',
			blurb:   (c.querySelector('.cap-blurb') || {}).textContent || '',
			why:     (c.querySelector('.cap-why') || {}).textContent || '',
			chip:    (c.querySelector('.cap-chip') || {}).textContent || '',
			buy:     (c.querySelector('[data-buy]') || {}).textContent || '',
			buyKey:  c.querySelector('[data-buy]') ? c.querySelector('[data-buy]').getAttribute('data-buy') : '',
			more:    (c.querySelector('.cap-more') || {}).textContent || '',
			// Every function this card grants, and whether the reader can see it now.
			fns:     [...c.querySelectorAll('.cap-fn')].map(f => ({
				name: f.getAttribute('data-fn'),
				shown: vis(f),
			})),
		})),
	};
});

/// Open the capability whose NAME is this, and hand back the panel afterwards.
///
/// By name, never by index: the order is the panel's to choose and a test that indexed
/// would pass or fail on a reordering rather than on the code.
const openCap = async (page, name) => {
	const did = await page.evaluate((want) => {
		for (const c of document.querySelectorAll('#tools-body .cap')) {
			const n = c.querySelector('.cap-name');
			if (n && n.textContent.trim() === want) {
				const b = c.querySelector('.cap-more');
				if (!b) return 'no-lid';
				b.click();
				return 'ok';
			}
		}
		return 'no-card';
	}, name);
	await page.waitForTimeout(150);
	return did;
};

/// Which capability card holds a function, by the function's own name.
const cardWith = (panel, fn) =>
	panel.cards.filter(c => c.fns.some(f => f.name === fn));

/// Whether the reader can see a function right now, anywhere on the panel.
const fnShown = (panel, fn) =>
	panel.cards.some(c => c.fns.some(f => f.name === fn && f.shown));

/// The functions the Rust registry actually hands the agent, straight from the wasm.
/// The oracle for check 2: the panel is measured against the registry, not against a
/// list this file keeps.
const registry = (page) => page.evaluate(async () => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	return JSON.parse(mod.builtin_tools()).map(t => ({ tool: t.tool, pack: t.pack }));
});

/// What the ENGINE believes, asked the way `www/js/typst.js` asks it.
const engine = (page) => page.evaluate(async (fn) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	return { locked: mod.locked_packs(), tool: mod.tool_locked(fn) };
}, FN);

// ── Driving ──────────────────────────────────────────────────────────

const s = await open({ name: 'toolspanel', profile: PROFILE, signIn: false, connect: false });
const { page } = s;
await stub(page);

// The stub only takes effect on a load that comes after it, and sign-in reloads nothing —
// so the page is reopened with the routes in place.
await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
const { signInAs } = await import('./harness.mjs');
await signInAs(s, 'toolspanel');
await page.waitForTimeout(2500);

try {
	// ── The instrument, before anything is measured with it ──────
	//
	// Everything below reads the panel through `readPanel` and the engine through
	// `engine`. If either is lying — a selector that matches nothing, a visibility test
	// that always answers the same — every assertion beneath is vacuous. So both are
	// proved on a state whose answer is already known before they are trusted.

	await page.evaluate(() => { window.DaimondPanels.show('tools'); window.DaimondTools.reload(); });
	await page.waitForTimeout(1200);

	const reg = await registry(page);
	check('the instrument can read the registry, and it is not empty',
		Array.isArray(reg) && reg.length > 5 && reg.every(t => typeof t.tool === 'string'),
		`${reg.length} function(s)`);
	if (!reg.length) throw new Error('the wasm registry answered nothing; nothing below can be measured');

	// The pack key this build sells the tool under, from the belt itself. It is the input to
	// every phase below, so it is read once, here, and asserted to be a pack rather than a
	// tool -- a build that named the tool would make the shelf checks meaningless.
	PACK = (reg.find(t => t.tool === FN) || {}).pack || '';
	check('the registry says which PACK the sold tool belongs to, not which tool',
		PACK.length > 0 && PACK !== FN,
		PACK ? `"${FN}" is sold in "${PACK}"` : `"${FN}" carries no pack key`);
	if (!PACK) throw new Error('the build sells nothing, so the shelf below cannot be measured');

	let panel = await readPanel(page);
	check('the instrument can see the panel, and it has capability cards',
		panel.cards.length > 0 && panel.cards.every(c => c.name.length > 0),
		`${panel.cards.length} card(s): ` + panel.cards.map(c => c.name).join(', '));
	if (!panel.cards.length) throw new Error('the panel drew no cards; nothing below can be measured');

	// ── 1. The row is a capability; the function is behind it ────
	//
	// Named rather than counted. `web_click` is a function nobody would put on a panel
	// for a person, and "Using a website" is the capability it belongs to — so if the
	// panel is still a manifest, the card named for the capability does not exist and
	// `web_click` is on screen without anyone opening anything.

	const USE_WEB = panel.cards.find(c => c.fns.some(f => f.name === 'web_click'));
	check('a capability, not a function, is what a row is named for',
		!!USE_WEB && USE_WEB.name !== 'web_click' && !/^[a-z_]+$/.test(USE_WEB.name),
		USE_WEB ? `the row granting web_click is called "${USE_WEB.name}"` : 'no row grants web_click');
	check('and it is described in what Daimond does, not in what it is called',
		!!USE_WEB && USE_WEB.blurb.length > 30 && !USE_WEB.blurb.includes('web_click'),
		USE_WEB ? USE_WEB.blurb.slice(0, 90) : '');

	check('a function is NOT on screen until its capability is opened',
		!fnShown(panel, 'web_click') && !fnShown(panel, 'file_glob'),
		`web_click shown: ${fnShown(panel, 'web_click')}, file_glob shown: ${fnShown(panel, 'file_glob')}`);

	const opened = await openCap(page, USE_WEB ? USE_WEB.name : '(none)');
	panel = await readPanel(page);
	check('opening that capability reveals the functions it grants',
		opened === 'ok' && fnShown(panel, 'web_click') && fnShown(panel, 'web_type'),
		`${opened}; web_click shown: ${fnShown(panel, 'web_click')}`);
	// And only that one: opening a lid is not opening every lid, which is what makes
	// the check above a disclosure rather than a redraw.
	check('and only that one — the other capabilities stay shut',
		!fnShown(panel, 'file_glob'), `file_glob shown: ${fnShown(panel, 'file_glob')}`);

	await openCap(page, USE_WEB ? USE_WEB.name : '(none)');
	panel = await readPanel(page);
	check('and it shuts again', !fnShown(panel, 'web_click'));

	// ── 2. Nothing the registry offers goes missing ──────────────
	//
	// The whole registry, walked. Not a list of names this file keeps: the point is
	// that a function added to Rust tomorrow, which nobody has told this map about,
	// still reaches the panel.

	const placed  = reg.filter(t => cardWith(panel, t.tool).length === 1);
	const missing = reg.filter(t => cardWith(panel, t.tool).length === 0);
	const twice   = reg.filter(t => cardWith(panel, t.tool).length > 1);
	check('every function the registry offers appears under exactly one capability',
		placed.length === reg.length,
		missing.length ? 'missing: ' + missing.map(t => t.tool).join(', ')
			: twice.length ? 'twice: ' + twice.map(t => t.tool).join(', ') : `all ${reg.length}`);

	const orphan = panel.cards.find(c => c.id === 'other');
	check('and none of them fell into the unplaced bucket',
		!orphan, orphan ? orphan.fns.map(f => f.name).join(', ') : 'the bucket is empty');

	// ── 3. A pack nobody is selling is not drawn as locked ───────
	//
	// The catalogue is empty in this phase — the state of any gateway whose operator has
	// not priced the pack. `typst_compile` carries a pack key in Rust all the same, so
	// this is where a browser that presumed from the key would put a price on something
	// that is free.

	const typsetNow = cardWith(panel, FN)[0];
	check('typesetting is included while the gateway sells no pack for it',
		!!typsetNow && typsetNow.state === 'included' && !typsetNow.buyKey,
		typsetNow ? `state=${typsetNow.state} buy=${typsetNow.buyKey || 'none'}` : 'no card grants ' + FN);
	check('so nothing on the panel is for sale, and the shelf says so plainly',
		panel.cards.every(c => c.state !== 'locked') && panel.none.length === 1
			&& panel.none[0].length > 10,
		panel.none.join(' | ') || 'no empty-shelf line');
	// The shelf is a section whether or not anything is on it, so the first pack has
	// somewhere to land without a change here.
	check('and the shelf is a section on the panel even while it is empty',
		panel.sections.length >= 2, panel.sections.join(' | '));

	const eng0 = await engine(page);
	check('and the engine holds nothing locked, so the tool runs',
		eng0.tool === false && eng0.locked === '', JSON.stringify(eng0));

	// ── 4-6. The same account, once the gateway is selling it ────
	//
	// One field of the gateway's answer changes. Nothing else does: same build, same
	// profile, same registry.

	catalogue = [{
		tool: PACK, name: PACKNAME, blurb: 'Typeset a document into a PDF.',
		price_minor: PRICE, unlocked: false, currency: 'usd',
	}];
	await page.evaluate(() => window.DaimondTools.reload());
	await page.waitForTimeout(900);
	panel = await readPanel(page);

	const sold = cardWith(panel, FN)[0];
	check('a pack the gateway IS selling moves that capability onto the shelf, locked',
		!!sold && sold.state === 'locked',
		sold ? `state=${sold.state}` : 'no card grants ' + FN);
	check('and it says WHY it is locked, naming the pack',
		!!sold && sold.why.length > 20 && sold.why.includes(PACKNAME),
		sold ? sold.why : '');
	check('and it is still named for the capability, not for the function',
		!!sold && !sold.name.includes(FN), sold ? sold.name : '');
	check('and it still opens to the function it grants',
		!!sold && sold.fns.some(f => f.name === FN), sold ? sold.fns.map(f => f.name).join(',') : '');
	check('and the price on the button is the catalogue\'s',
		!!sold && /25\.00/.test(sold.buy), sold ? sold.buy : '');
	// The rest of the panel did not move: a change to one pack is a change to one row.
	const stillFree = cardWith(panel, 'web_click')[0];
	check('and nothing else changed state — one pack, one row',
		!!stillFree && stillFree.state === 'included',
		stillFree ? stillFree.state : 'no card grants web_click');

	// ── 6. The lock reaches the engine ───────────────────────────
	const eng1 = await engine(page);
	check('the engine was told, so the tool the model calls is now refused',
		eng1.tool === true && eng1.locked.split(',').indexOf(PACK) >= 0,
		JSON.stringify(eng1));

	// ── 5. The button buys the thing it is under ─────────────────
	const before = buys.length;
	await page.evaluate((fn) => {
		for (const c of document.querySelectorAll('#tools-body .cap')) {
			if ([...c.querySelectorAll('.cap-fn')].some(f => f.getAttribute('data-fn') === fn)) {
				const b = c.querySelector('[data-buy]');
				if (b) b.click();
				return;
			}
		}
	}, FN);
	await page.waitForTimeout(900);
	check('pressing Unlock asks the gateway to sell THAT pack',
		buys.length === before + 1 && buys[buys.length - 1] === PACK,
		`${buys.length - before} request(s): ${buys.slice(before).join(', ') || 'none'}`);

	// ── 4, the other direction ───────────────────────────────────
	//
	// Bought. Without this the locked checks above prove only that the panel can draw a
	// price — a panel that locked everything unconditionally would pass every one of them.

	catalogue = [{
		tool: PACK, name: PACKNAME, blurb: 'Typeset a document into a PDF.',
		price_minor: PRICE, unlocked: true, currency: 'usd',
	}];
	await page.evaluate(() => window.DaimondTools.reload());
	await page.waitForTimeout(900);
	panel = await readPanel(page);

	const bought = cardWith(panel, FN)[0];
	check('an account that HAS bought the pack is not sold it again',
		!!bought && bought.state === 'owned' && !bought.buyKey && bought.chip.length > 0,
		bought ? `state=${bought.state} chip="${bought.chip}" buy=${bought.buyKey || 'none'}` : '');
	check('and it carries no reason to be locked, because it is not',
		!!bought && bought.why === '', bought ? bought.why : '');

	const eng2 = await engine(page);
	check('and the engine lets the tool run again',
		eng2.tool === false, JSON.stringify(eng2));

	// ── The count the rail shows ─────────────────────────────────
	//
	// The rail row and this panel answer the same question, so they must count the same
	// unit. A rail counting functions beside a panel listing capabilities is two answers.
	const c1 = await page.evaluate(() => window.DaimondTools.counts());
	check('the count is in capabilities, matching what the panel drew',
		c1.all === panel.cards.length && c1.have === panel.cards.filter(
			x => x.state !== 'locked').length,
		`${c1.have} of ${c1.all}, panel drew ${panel.cards.length} card(s)`);

	// A locked pack is something not yet had, so the two figures must part.
	//
	// The second entry is fictitious and its key must not be one the build knows, or the
	// row would fold into the first and the count would not move. `inbox` was chosen to
	// stay clear of the real pack; now that real keys are drop-numbered (`drop01`, and
	// whatever follows) a themed key like this one cannot collide with a shipped pack at
	// all, which is one more thing the drop-shaped key buys.
	catalogue = [
		{ tool: PACK, name: PACKNAME, blurb: 'b', price_minor: PRICE, unlocked: false, currency: 'usd' },
		{ tool: 'inbox', name: 'Inbox', blurb: 'Daimond works your mail for you.', price_minor: 4500, unlocked: false, currency: 'usd' },
	];
	await page.evaluate(() => window.DaimondTools.reload());
	await page.waitForTimeout(900);
	panel = await readPanel(page);
	const c2 = await page.evaluate(() => window.DaimondTools.counts());
	check('and two locked packs put the count two behind the total',
		c2.all === c1.all + 1 && c2.have === c1.have - 1,
		`was ${c1.have} of ${c1.all}, now ${c2.have} of ${c2.all}`);

	// A pack that names no function this build has — the shape a drop arrives in when its
	// tools are not in this build yet — reaches the shelf on the catalogue alone, with no
	// code here for it.
	const later = panel.cards.find(c => c.name === 'Inbox');
	check('a pack naming no function this build has still reaches the shelf',
		!!later && later.state === 'locked' && later.buyKey === 'inbox'
			&& later.fns.length === 0,
		later ? `state=${later.state} buy=${later.buyKey} fns=${later.fns.length}` : 'no Inbox row');

	// ── An unreachable gateway is not an empty account ───────────
	await page.unroute('**/api/tools');
	await page.route('**/api/tools', r => r.fulfill({ status: 500, contentType: 'application/json',
		headers: CORS, body: '{"ok":false,"error":"down"}' }));
	const engBefore = await engine(page);
	await page.evaluate(() => window.DaimondTools.reload());
	await page.waitForTimeout(900);
	panel = await readPanel(page);
	check('a gateway that cannot be reached still shows what Daimond includes',
		cardWith(panel, 'web_click').length === 1 && cardWith(panel, 'file_glob').length === 1,
		`${panel.cards.length} card(s)`);
	const engAfter = await engine(page);
	check('and does not hand over a pack the account had not bought',
		engAfter.locked === engBefore.locked,
		`was "${engBefore.locked}", now "${engAfter.locked}"`);

	// A refusal is a decision, not a fault: a panel that logs an error every time the
	// gateway is unreachable has taught its user to ignore the console.
	const errs = errors(s).filter(e =>
		!/Failed to load resource/.test(e) && !/500/.test(e));
	check('nothing was drawn by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | '));

	await shot(s, 'toolspanel' + (BREAK ? '-' + BREAK : ''));
} finally {
	await s.close();
}

console.log(`\npack checkouts seen: ${buys.length}${buys.length ? ' (' + buys.join(', ') + ')' : ''}`);
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);

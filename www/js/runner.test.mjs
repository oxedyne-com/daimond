/* ============================================================
   Test — the runner posture (www/js/runner.js).
   ------------------------------------------------------------
   Drives the REAL module in a simulated tab: a Map-backed
   localStorage, a fake document and window, a clock the test
   owns, and stand-ins for the three things the posture reaches
   for -- the counted wake lock (`DaimondWake`), the app's
   confirm box (`DaimondCore.confirm`) and the errand long-poll
   (`DaimondPost.parkStart`). No browser.

   The properties under test are the ones the posture can get
   wrong:

     (a) a device that is NOT the nominee is never asked and
         never armed;
     (b) the nominee is asked exactly ONCE -- a no is remembered,
         so the tick does not ask again every fifteen seconds;
     (c) a yes arms the posture, takes exactly one wake-lock
         count, and starts parking;
     (d) un-nominating, or nominating another machine, clears the
         posture AND forgets the asking, so re-nominating asks
         again rather than silently re-arming;
     (e) the lock is re-asked on every return to visible, because
         the browser takes it back on hidden and hands it to
         nobody;
     (f) parking at boot needs the identity UNLOCKED -- a locked
         tab cannot read an errand it parks for;
     (g) a blank device id (the identity still coming up) changes
         nothing: it must not read as "not the nominee" and clear
         a posture that is correct;
     (h) neither key is in the sync parcel's named field set.

   Each check is proven able to fail: the --break modes damage
   the shipped module the four ways it could plausibly be got
   wrong, and the checks that guard each defect go red.

     node www/js/runner.test.mjs --break askalways  # (b) asks for ever
     node www/js/runner.test.mjs --break keeparmed  # (d) un-nominating leaves it armed
     node www/js/runner.test.mjs --break doublehold # (c) two counts, one release
     node www/js/runner.test.mjs --break parklocked # (f) parks while locked
     node www/js/runner.test.mjs                    # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || '') : '';
})();
const KNOWN = ['askalways', 'keeparmed', 'doublehold', 'parklocked'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

const drain = () => new Promise((r) => setImmediate(r));
async function settle(n = 8) { for (let i = 0; i < n; i++) await drain(); }

const NOM  = 'daimond-nominated';
const DEV  = 'daimond-device-id';
const KEY  = 'daimond-runner-posture';
const ASK  = 'daimond-runner-asked';

/// One simulated tab. `cfg.self` is this device's id, `cfg.nominee` the account's
/// nomination, `cfg.answer` what the confirm box resolves, `cfg.unlocked` whether
/// the identity is open. `cfg.store` reuses a previous tab's localStorage Map,
/// which is what surviving a reload means.
function makeTab(cfg) {
	cfg = cfg || {};
	const local = cfg.store || new Map();
	if (cfg.self !== undefined) local.set(DEV, cfg.self);
	if (cfg.nominee !== undefined) {
		if (cfg.nominee === null) local.delete(NOM);
		else local.set(NOM, JSON.stringify({ id: cfg.nominee, at: 1 }));
	}

	const timers = new Map();
	let seq = 0;
	const clock = {
		setInterval(fn, ms) { const id = ++seq; timers.set(id, { fn, every: ms }); return id; },
		clearInterval(id) { timers.delete(id); },
		setTimeout(fn) { const id = ++seq; timers.set(id, { fn, every: 0 }); return id; },
		clearTimeout(id) { timers.delete(id); },
		async ticks(n = 1) {
			for (let i = 0; i < n; i++) {
				for (const t of [...timers.values()]) { try { t.fn(); } catch (e) { /* noted below */ } }
				await settle();
			}
		},
		pending() { return timers.size; },
	};

	const wake = { held: 0, asks: 0, regains: 0 };
	const park = { starts: 0 };
	const asked = { n: 0, msgs: [] };

	const docOn = {}, winOn = {};
	const document = {
		readyState: 'complete',
		visibilityState: cfg.hidden ? 'hidden' : 'visible',
		addEventListener(k, fn) { (docOn[k] = docOn[k] || []).push(fn); },
	};
	const win = {
		addEventListener(k, fn) { (winOn[k] = winOn[k] || []).push(fn); },
		localStorage: {
			getItem: (k) => (local.has(k) ? local.get(k) : null),
			setItem: (k, v) => local.set(k, String(v)),
			removeItem: (k) => local.delete(k),
		},
		DaimondWake: {
			hold()    { wake.held++; wake.asks++; },
			release() { wake.held = wake.held > 0 ? wake.held - 1 : 0; },
			regain()  { wake.regains++; },
		},
		DaimondCore: {
			confirm(msg) { asked.n++; asked.msgs.push(msg); return Promise.resolve(!!cfg.answer); },
		},
		DaimondIdentity: { isUnlocked: () => !!cfg.unlocked },
		DaimondPost: { parkStart() { park.starts++; return true; } },
	};
	win.window = win;

	let src = readFileSync(join(HERE, 'runner.js'), 'utf8');
	if (BREAK === 'askalways') {
		// The asking is no longer remembered, so a no is asked again on every tick.
		src = src.replace("if (asked === me) return { act: 'hold', why: 'declined' };", '');
	}
	if (BREAK === 'keeparmed') {
		// Un-nominating no longer clears: the machine stays armed for ever.
		src = src.replace("if (d.act === 'clear') { drop(RUNNER_KEY); drop(ASK_KEY); syncWake(); }",
			"if (d.act === 'clear') { syncWake(); }");
	}
	if (BREAK === 'doublehold') {
		// The count is taken every pass, so it never reaches zero again.
		src = src.replace('if (want && !_held)', 'if (want)');
	}
	if (BREAK === 'parklocked') {
		// Parking no longer waits for the identity.
		src = src.replace('return !!(st && st.posture && st.unlocked);', 'return !!(st && st.posture);');
	}

	// `with (window)` is the one construct that puts an object in the scope chain,
	// so the module's bare `localStorage` and `document` resolve to this tab's. The
	// timer functions are deliberately NOT on the fake window, so they fall through
	// to the named parameters and land on the fake clock.
	const fn = new Function('window', 'document', 'setInterval', 'clearInterval',
		'setTimeout', 'clearTimeout',
		'with (window) {\n' + src + '\n}');
	fn(win, document, clock.setInterval, clock.clearInterval, clock.setTimeout, clock.clearTimeout);

	return {
		win, document, local, clock, wake, park, asked,
		R: () => win.DaimondRunner,
		posture: () => local.get(KEY) === '1',
		askedKey: () => local.get(ASK) || '',
		nominate: (id) => { if (id) local.set(NOM, JSON.stringify({ id, at: 2 })); else local.delete(NOM); },
		visible: async () => {
			document.visibilityState = 'visible';
			(docOn.visibilitychange || []).forEach((f) => f({}));
			await settle();
		},
		hide: () => { document.visibilityState = 'hidden'; (docOn.visibilitychange || []).forEach((f) => f({})); },
		unlock: async () => { cfg.unlocked = true; (winOn['daimond:unlock'] || []).forEach((f) => f({})); await settle(); },
	};
}

async function boot(cfg) { const tab = makeTab(cfg); await settle(); return tab; }

async function main() {
	console.log('runner: a device that is not the nominee is left alone');
	{
		const tab = await boot({ self: 'd-aaa', nominee: 'd-bbb', answer: true, unlocked: true });
		check('it was never asked', tab.asked.n === 0);
		check('the posture is off', tab.posture() === false);
		check('no wake lock was taken', tab.wake.held === 0);
		check('nothing started parking', tab.park.starts === 0);
		await tab.clock.ticks(5);
		check('five ticks later it is still not asked', tab.asked.n === 0);
	}

	console.log('\nrunner: the nominee is asked, and a YES arms it');
	{
		const tab = await boot({ self: 'd-aaa', nominee: 'd-aaa', answer: true, unlocked: true });
		check('it was asked exactly once', tab.asked.n === 1);
		check('the question names what it costs',
			/awake/i.test(tab.asked.msgs[0] || '') && /background/i.test(tab.asked.msgs[0] || ''));
		check('the posture is on', tab.posture() === true);
		check('exactly one wake-lock count is held', tab.wake.held === 1);
		check('parking started', tab.park.starts >= 1);
		await tab.clock.ticks(4);
		check('it is not asked again while armed', tab.asked.n === 1);
		check('still exactly one count after four ticks', tab.wake.held === 1,
			'held=' + tab.wake.held);
		check('the lock is re-asked on the tick', tab.wake.regains >= 4);
	}

	console.log('\nrunner: a NO is remembered');
	{
		const tab = await boot({ self: 'd-aaa', nominee: 'd-aaa', answer: false, unlocked: true });
		check('it was asked once', tab.asked.n === 1);
		check('the posture stayed off', tab.posture() === false);
		check('the refusal was written down', tab.askedKey() === 'd-aaa');
		await tab.clock.ticks(6);
		check('six ticks later it has not asked again', tab.asked.n === 1, 'asks=' + tab.asked.n);
		check('no wake lock was taken', tab.wake.held === 0);
	}

	console.log('\nrunner: un-nominating clears the posture and forgets the asking');
	{
		const tab = await boot({ self: 'd-aaa', nominee: 'd-aaa', answer: true, unlocked: true });
		check('armed to begin with', tab.posture() === true && tab.wake.held === 1);
		tab.nominate('');
		await tab.clock.ticks(1);
		check('the posture is cleared', tab.posture() === false);
		check('the wake lock is given back', tab.wake.held === 0, 'held=' + tab.wake.held);
		check('the asking is forgotten', tab.askedKey() === '');
		// Re-nominating must ASK again rather than silently re-arm.
		tab.nominate('d-aaa');
		await tab.clock.ticks(1);
		check('re-nominating asks again', tab.asked.n === 2, 'asks=' + tab.asked.n);
		check('and arms again on the second yes', tab.posture() === true);
	}

	console.log('\nrunner: the nomination moving to another machine clears this one');
	{
		const tab = await boot({ self: 'd-aaa', nominee: 'd-aaa', answer: true, unlocked: true });
		check('armed to begin with', tab.posture() === true);
		tab.nominate('d-ccc');
		await tab.clock.ticks(1);
		check('the posture is cleared', tab.posture() === false);
		check('the lock is released', tab.wake.held === 0);
	}

	console.log('\nrunner: the lock is re-asked on every return to visible');
	{
		const tab = await boot({ self: 'd-aaa', nominee: 'd-aaa', answer: true, unlocked: true });
		const before = tab.wake.regains;
		tab.hide();
		await tab.visible();
		check('hidden then visible re-asks for the lock', tab.wake.regains > before,
			before + ' -> ' + tab.wake.regains);
		check('it is still exactly one count', tab.wake.held === 1, 'held=' + tab.wake.held);
	}

	console.log('\nrunner: parking at boot waits for the identity');
	{
		const tab = await boot({ self: 'd-aaa', nominee: 'd-aaa', answer: true, unlocked: false });
		check('the posture is on', tab.posture() === true);
		check('nothing parked while locked', tab.park.starts === 0, 'starts=' + tab.park.starts);
		await tab.unlock();
		check('unlocking starts parking', tab.park.starts >= 1, 'starts=' + tab.park.starts);
	}

	console.log('\nrunner: an armed machine parks on the NEXT boot without anyone opening a panel');
	{
		const first = await boot({ self: 'd-aaa', nominee: 'd-aaa', answer: true, unlocked: true });
		check('armed on the first boot', first.posture() === true);
		// The same localStorage, which is what surviving a reload means.
		const second = await boot({ store: first.local, answer: true, unlocked: true });
		check('the posture survived the reload', second.posture() === true);
		check('it was not asked again', second.asked.n === 0);
		check('it parked straight away', second.park.starts >= 1, 'starts=' + second.park.starts);
		check('and it holds the lock again', second.wake.held === 1);
	}

	console.log('\nrunner: a blank device id changes nothing');
	{
		const first = await boot({ self: 'd-aaa', nominee: 'd-aaa', answer: true, unlocked: true });
		check('armed to begin with', first.posture() === true);
		first.local.delete(DEV);		// the identity is still coming up
		await first.clock.ticks(2);
		check('the posture is untouched', first.posture() === true);
		check('the decision says so', first.R().decide({ self: '', nominee: 'd-aaa', posture: true }).act === 'wait');
	}

	console.log('\nrunner: the pure decisions');
	{
		const R = (await boot({ self: 'd-aaa', nominee: null, answer: false })).R();
		check('no id -> wait', R.decide({ self: '', nominee: 'x' }).act === 'wait');
		check('not the nominee, nothing held -> hold',
			R.decide({ self: 'a', nominee: 'b' }).act === 'hold');
		check('not the nominee but armed -> clear',
			R.decide({ self: 'a', nominee: 'b', posture: true }).act === 'clear');
		check('un-nominated and armed -> clear',
			R.decide({ self: 'a', nominee: '', posture: true }).why === 'un-nominated');
		check('the nominee, unasked -> ask',
			R.decide({ self: 'a', nominee: 'a' }).act === 'ask');
		check('the nominee, asked and refused -> hold',
			R.decide({ self: 'a', nominee: 'a', asked: 'a' }).why === 'declined');
		check('the nominee, armed -> hold',
			R.decide({ self: 'a', nominee: 'a', posture: true }).why === 'armed');
		check('the wake lock follows the posture alone',
			R.wantsWake({ posture: true }) === true && R.wantsWake({ posture: false }) === false);
		check('parking needs the posture AND the identity',
			R.wantsPark({ posture: true, unlocked: true }) === true
			&& R.wantsPark({ posture: true, unlocked: false }) === false
			&& R.wantsPark({ posture: false, unlocked: true }) === false);
	}

	console.log('\nrunner: neither key rides the sync parcel');
	{
		const core = readFileSync(join(HERE, 'daimond.js'), 'utf8');
		const collect = (() => {
			const i = core.indexOf('function collectSync');
			return i < 0 ? '' : core.slice(i, i + 12000);
		})();
		check('collectSync exists to be checked', collect.length > 0);
		check('the posture key is not in collectSync', !collect.includes(KEY));
		check('the asking key is not in collectSync', !collect.includes(ASK));
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

await main();

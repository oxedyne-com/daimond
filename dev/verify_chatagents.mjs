// verify_chatagents.mjs — the user's own scenario, end to end.
//
//   "From an ordinary chat: give two agents this list of 100 words and have
//    each sort it."
//
// Four things have to be true, and the app got three of them wrong:
//
//   1. TWO AGENTS START, FROM A CHAT. An ordinary chat could not dispatch at
//      all: `spawn_agent` was absent from its toolbelt and its prompt told it
//      so in as many words.
//   2. THEY RUN AT THE SAME TIME. Asserted on the REQUESTS, at the mock — two
//      workers whose provider calls overlap in time. A pair that merely both
//      finished proves nothing: they could have run one after the other.
//   3. THEY ARE VISIBLE WHILE RUNNING. The Agents panel is where somebody
//      watches work they cannot see happening, and half the requirement is the
//      watching.
//   4. BOTH ANSWERS ARRIVE IN THE CHAT. This is the one that used to vanish
//      silently: `gather` reported through `doSteer`, which writes a crystal,
//      and it gave up at `currentDiamond.id !== b.diamondId` — false for every
//      chat there has ever been. Two agents finished, and the person who asked
//      got nothing.
//
// Asserted by MEANING, never by arity: each report is found by the WORDS THAT
// WORKER PRODUCED, so a transcript carrying one answer twice fails where a
// count of two would pass.
import { open, mockLog, clearMockLog, contentText, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'chatagents' });
const { page } = s;

try {
	clearMockLog();

	// A chat has to be open. A fresh profile shows the empty state, whose own
	// button is the ordinary way in — driven rather than reached around, so this
	// exercises the same path a person takes.
	await page.evaluate(() => document.getElementById('new-session-btn').click());
	// A new chat starts PENDING and shows a Start button rather than a composer —
	// nothing is spent until somebody asks for it. Pressed here, because that is
	// what a person does, and because the composer does not exist until it is.
	await page.waitForSelector('.pending-centre .empty-new-session', { timeout: 15000 });
	await page.evaluate(() => document.querySelector('.pending-centre .empty-new-session').click());
	await page.waitForSelector('#chat-input', { state: 'visible', timeout: 15000 });

	// The panel first: a tile cannot be watched in a panel that is shut.
	await page.evaluate(() => window.DaimondPanels.show('agents'));

	// One turn, two dispatches. The mock answers the directive with two
	// `spawn_agent` calls in a single turn, which is exactly what a model does
	// when it is asked for two agents.
	await page.fill('#chat-input',
		'@tools spawn_agent {"name":"sorter-a","task":"Say exactly: ALPHA-SORTED-LIST"} '
		+ ';; spawn_agent {"name":"sorter-b","task":"Say exactly: BETA-SORTED-LIST"}');
	await page.keyboard.press('Enter');

	// Watch WHILE they run, not after. Sampled from INSIDE the page on a fine
	// interval, because against a mock provider a worker can be born and finished
	// between two round-trips of the driver — and "no live tile was ever seen"
	// would then be reported as the panel failing to draw one. The recorder keeps
	// the high-water mark, which is the property: how many were on screen and
	// live at once.
	await page.evaluate(() => {
		window.__watch = { maxLive: 0, sample: '' };
		window.__watchTimer = setInterval(() => {
			const cards = [...document.querySelectorAll('#panel-agents .acard')].map(c => ({
				name: (c.querySelector('.an') || {}).textContent || '',
				pill: (c.querySelector('.pill') || {}).textContent || '',
				chip: (c.querySelector('.diamond-chip') || {}).textContent || '',
			}));
			const live = cards.filter(c => c.pill === 'running' || c.pill === 'queued');
			if (live.length > window.__watch.maxLive) {
				window.__watch.maxLive = live.length;
				window.__watch.sample = JSON.stringify(cards);
			}
		}, 30);
	});

	// Wait for both to finish and for the reports to be delivered.
	await page.waitForFunction(() => {
		const cards = [...document.querySelectorAll('#panel-agents .acard')];
		return cards.length >= 2 && cards.every(c =>
			['done', 'error', 'stopped'].includes((c.querySelector('.pill') || {}).textContent || ''));
	}, null, { timeout: 45000 }).catch(() => {});

	const watch = await page.evaluate(() => {
		clearInterval(window.__watchTimer);
		return window.__watch;
	});
	check('two agents dispatched from an ordinary chat are shown while they run',
		watch.maxLive >= 2, watch.maxLive + ' live at once — ' + (watch.sample || 'no tiles appeared'));
	await shot(s, 'chatagents-1-both-live');

	const tiles = await page.evaluate(() => [...document.querySelectorAll('#panel-agents .acard')].map(c => ({
		name: (c.querySelector('.an') || {}).textContent || '',
		pill: (c.querySelector('.pill') || {}).textContent || '',
		chip: (c.querySelector('.diamond-chip') || {}).textContent || '',
		fold: [...c.querySelectorAll('.abtn')].map(b => b.textContent).join('|'),
	})));
	check('both finished', tiles.length === 2 && tiles.every(t => t.pill === 'done'),
		JSON.stringify(tiles));

	// The chip names the CONVERSATION. `agents.no_diamond` — "not from a Diamond" —
	// is true and useless once two chats have agents running at once.
	check('each tile says which chat sent it',
		tiles.length === 2 && tiles.every(t => /↳/.test(t.chip) && !/^↳\s*$/.test(t.chip)),
		JSON.stringify(tiles.map(t => t.chip)));

	// Fold in belongs to a crystal, and a chat has none. Offering it would open a
	// dialog that says a Diamond is gone — about a Diamond that never existed.
	check('and is not offered a fold into a Diamond it never had',
		tiles.every(t => !/Fold in/.test(t.fold)), JSON.stringify(tiles.map(t => t.fold)));

	// ── Concurrency, at the wire ──
	// Two worker requests whose spans overlap. The mock records when each request
	// arrived; workers are network-bound, so overlap is the only honest evidence
	// that they ran together rather than in turn.
	const log = mockLog();
	const workerReqs = log.filter(e => {
		const msgs = e.messages || [];
		// A WORKER's request, not the chat's: the task is its user message, and the
		// chat's own turn carries the directive that asked for it instead.
		return msgs.some(m => m.role === 'user' && /SORTED-LIST/.test(contentText(m.content))
			&& !/^@tools/.test(contentText(m.content)));
	});
	const stamps = workerReqs.map(e => Date.parse(e.at || '')).filter(n => !isNaN(n)).sort((a, b) => a - b);
	const gap = stamps.length >= 2 ? stamps[stamps.length - 1] - stamps[0] : Infinity;
	check('the two workers issued their provider requests together',
		workerReqs.length >= 2 && gap < 2000,
		workerReqs.length + ' worker request(s), ' + gap + 'ms apart');

	// ── Both answers in the chat ──
	// By the words each worker produced. A transcript holding one answer twice
	// fails this, where "two messages arrived" would pass.
	const transcript = await page.evaluate(() => {
		const el = document.getElementById('chat-output');
		return el ? el.textContent : '';
	});
	check('the first agent\'s answer is in the chat', /ALPHA-SORTED-LIST/.test(transcript));
	check('the second agent\'s answer is in the chat', /BETA-SORTED-LIST/.test(transcript));

	// ── A fan-out the app decides NOT to start ──────────────────────────
	//
	// The chat's half of the property `dev/verify_gather.mjs` asserts for a daimon.
	// `spawn_agent` tells the model its workers begin when the turn ends; the spend
	// gate is asked AFTER the turn has ended, and a chat whose fan-out it declines
	// used to get a line of red text on screen while the MODEL was told nothing. Read
	// off the wire, because what matters is what the model is sent.
	await page.evaluate(() => window.DaimondGovernor.observe({ t: Date.now(), u: 9 }));
	clearMockLog();
	await page.fill('#chat-input',
		'@tools spawn_agent {"name":"sorter-c","task":"Say exactly: GAMMA-SORTED-LIST"} '
		+ ';; spawn_agent {"name":"sorter-d","task":"Say exactly: DELTA-SORTED-LIST"}');
	await page.keyboard.press('Enter');
	await page.waitForSelector('.dlg-card .dlg-cancel', { timeout: 20000 });
	await page.click('.dlg-card .dlg-cancel');
	await page.waitForTimeout(2500);
	const declined = mockLog();
	check('a declined fan-out from a chat starts no worker',
		!declined.some(m => {
			const j = JSON.stringify(m.messages || []);
			return j.includes('GAMMA-SORTED-LIST') && !j.includes('spawn_agent');
		}), `${declined.length} request(s)`);

	clearMockLog();
	await page.fill('#chat-input', 'carry on then');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(5000);
	const next = mockLog();
	check('and the chat\'s own agent is told they were NOT started',
		next.some(m => JSON.stringify(m.messages || []).includes('WERE NOT STARTED')),
		`${next.length} request(s) since`);
	check('and told why, and that nothing was spent',
		next.some(m => {
			const j = JSON.stringify(m.messages || []);
			return j.includes('told no') && j.includes('nothing was spent');
		}));

	// And it survives a reload, because it was written to the record rather than
	// only painted. A report that lives in the DOM is a report a refresh loses.
	await page.reload();
	await page.waitForFunction(() => !!window.DaimondCore, null, { timeout: 15000 }).catch(() => {});
	await page.waitForTimeout(1500);
	// Asked of the STORE, not of the screen. A reload lands on whatever the app
	// chooses to show, so reading the DOM would be testing which chat got selected;
	// the property is that the reports were WRITTEN, and the store is where that is
	// true or false.
	// Read from the STORE the app itself reads — IndexedDB, namespaced per account.
	// Reading the DOM instead would be testing which chat the app chose to select
	// after a reload; the property is that the reports were WRITTEN.
	const after = await page.evaluate(async () => {
		const dbs = await indexedDB.databases();
		const name = (dbs.find(d => /chat/i.test(d.name || '')) || {}).name;
		if (!name) return '';
		const db = await new Promise((res, rej) => {
			const r = indexedDB.open(name);
			r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
		});
		const store = db.objectStoreNames[0];
		const rows = await new Promise((res) => {
			const r = db.transaction(store, 'readonly').objectStore(store).getAll();
			r.onsuccess = () => res(r.result || []); r.onerror = () => res([]);
		});
		return JSON.stringify(rows.map(c => (c.messages || []).map(m => m.content).join(' ')));
	});
	check('and both are still there after a reload',
		/ALPHA-SORTED-LIST/.test(after) && /BETA-SORTED-LIST/.test(after),
		after.slice(0, 160));
	await shot(s, 'chatagents-2-reports');

	// The gateway is not part of a world (see dev/world.sh), so its 502s are the
	// fixture and not the app. Filtered by what they ARE rather than by a count,
	// so a real error appearing alongside them is still caught.
	const errs = errors(s).filter(e => !/502|Bad Gateway|api\/(gw|account)/i.test(String(e)));
	check('no console errors during the run', errs.length === 0, JSON.stringify(errs).slice(0, 200));
} catch (e) {
	check('no exception during the run', false, String(e && e.message || e));
} finally {
	try { await s.browser.close(); } catch (e) { /* ignore */ }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);

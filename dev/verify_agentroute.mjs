// verify_agentroute.mjs — where agents are dispatched from, and whether two of
// them really run at once.
//
// Written against a real session. In an ORDINARY CHAT the user asked for two
// agents to be given the same list and each to sort it, saying afterwards
// *"this is a test of our ability to start and watch agents and have them
// complete their task"*. The chat did the sorting itself and then said:
//
//   "There aren't two independent agents in this session to hand the list to;
//    there's only me."
//   "There's no way to spawn two independent agents in parallel, hand each the
//    list, and watch their outputs come back concurrently."
//
// The first sentence is true of a chat. The second is false of the app, and it
// is the one the user reads. A Diamond's daimon holds `spawn_agent`, several
// calls in one turn become several workers, and the workers run at the same
// time — so the model reasoned from the one toolbelt it could see and reported
// the app as incapable.
//
// Four properties, and the first two are measured ON THE WIRE, in the request
// the provider actually received, because a claim about what an agent was
// offered cannot be read off the screen:
//
//   1. THE TOOLBELTS ARE WHAT THE CODE SAYS. A chat's request offers no
//      `spawn_agent`; a daimon's request does. This pair is asserted together
//      on purpose: `Tool::browser()` (src/tools.rs) is also the list the Tools
//      panel shows a PERSON, and `runTurn` in www/js/daimond.js has no arm that
//      turns a `spawn_agent` call into a worker — so a build that offered a chat
//      the tool without wiring the dispatch would have it announce
//      "Dispatched agent 'alpha'" (src/tools.rs, Tool::spawn_agent) with nothing
//      whatsoever dispatched. That is a worse lie than the one being fixed.
//
//   2. THE CHAT KNOWS WHERE IT IS DONE. Its system prompt names the tool it
//      lacks, names the Diamond as the surface that has it, says the workers run
//      at the same time, and rules out the sentence above. Read from the wire
//      rather than from the Rust constant, because what the model is told is the
//      COMPOSED prompt and a user may have rewritten the body.
//
//   3. TWO DISPATCHED IN ONE TURN RUN AT THE SAME TIME. Not "two tiles exist" —
//      the highest number of workers observed simultaneously in `running`, polled
//      while the batch is in flight. `verify_agents.mjs` counts three cards and
//      would pass just as happily against a pool that ran them one after another.
//
//   4. EACH REPORTS, AND REPORTS ITS OWN. The two tasks are `@long 21` and
//      `@long 34`, so each worker's report ends at a different chunk: a report
//      read off the wrong tile, or one tile read twice, is caught. Asserting
//      "two non-empty reports" would not catch either.
//
//   node dev/verify_agentroute.mjs
//   node dev/verify_agentroute.mjs --break oldprompt  # the chat's paragraph removed
//   node dev/verify_agentroute.mjs --break serial     # the worker pool narrowed to one
//
// The two break modes are how this file earns its keep. `oldprompt` puts the
// chat back on the text it shipped with before this was written, so check 2 must
// fail. `serial` sets `Workers.MAX` to 1, which makes the pump start the second
// worker only once the first has finished, so check 3 must fail while 4 still
// passes — a run that reports "concurrent" under `--break serial` is measuring
// nothing, and the number it prints is the proof either way.
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import { open, connectMock, steerDiamond, scratch, shot, chat,
	mockLog, clearMockLog, contentText, errors } from './harness.mjs';

const BI  = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.split('=')[1] : (BI >= 0 ? (process.argv[BI + 1] || '') : '');

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

/// The last request the mock received, or null.
const lastRequest = () => {
	const rows = mockLog();
	return rows.length ? rows[rows.length - 1] : null;
};

/// The system prompt out of a logged request.
const systemOf = (row) => {
	const m = (row && row.messages || []).find(x => x && x.role === 'system');
	return m ? contentText(m.content) : '';
};

/// Make a Diamond through its own dialog, the way a person does.
async function create(p, name) {
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')]
			.filter(c => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	await p.waitForTimeout(1200);
}

const s = await open({ name: 'agentroute', profile: scratch('pw', 'agentroute-' + process.pid) });
const { page: p } = s;
try {
	await connectMock(s);
	if (BREAK) console.log(`  ..   running with --break ${BREAK}`);

	// ══ The chat: what it holds, and what it has been told ════════════
	//
	// `oldprompt` is applied through the ordinary override, which is the same
	// path a user's `prompts/chat.md` takes — so the break exercises the real
	// mechanism rather than a hook that exists for this test. The text is the
	// shipped default with the new paragraph cut off, i.e. exactly what the chat
	// in the reported session was running on.
	if (BREAK === 'oldprompt') {
		await p.evaluate(() => {
			const full = window.DaimondPrompts.defaultFor('chat') || '';
			const cut  = full.indexOf('You can dispatch workers');
			window.DaimondPrompts.md.chat = cut > 0 ? full.slice(0, cut).trim() : full;
		});
	}

	clearMockLog();
	await chat(s, '@text right');
	const chatReq = lastRequest();
	check(!!chatReq, 'the chat turn reached the provider',
		chatReq ? String((chatReq.tools || []).length) + ' tools offered' : 'no request logged');

	// A CHAT CAN NOW DISPATCH, and these three checks assert the reverse of what
	// they first did. That is a decision, not a regression: an ordinary chat was
	// refused the tool and told in its own prompt that dispatching "belongs to a
	// Diamond", so a user who asked for two agents in a chat was told the app
	// could not do it — on a surface where it now can. `Tool::browser` still omits
	// `spawn_agent`, because a WORKER is built from that same list and a worker
	// that could dispatch workers is a fan-out with no bottom; the chat is granted
	// it afterwards, by the one caller that builds a chat.
	const chatTools = (chatReq && chatReq.tools) || [];
	check(chatTools.includes('spawn_agent'),
		'a chat is offered spawn_agent',
		chatTools.length ? chatTools.join(', ') : '(none)');
	const wired = await p.evaluate(() => typeof window.DaimondWorkers === 'object');
	check(wired, 'and the dispatch machinery it reaches is present in the page');

	const sys = systemOf(chatReq);
	check(/spawn_agent/.test(sys),
		'the chat is told which tool it has', sys ? 'system prompt read' : 'no system prompt');
	check(/several times in the SAME turn|at once/.test(sys),
		'and that calling it twice in one turn runs two agents at once');
	check(/in parallel/.test(sys),
		'and is told not to say the app cannot run agents in parallel');

	// ══ The Diamond: two agents in one turn ═══════════════════════════
	await create(p, 'Dispatch');

	// The pool narrowed to one worker: the pump then starts the second only when
	// the first has finished, which is what "no parallelism" would look like.
	if (BREAK === 'serial') {
		await p.evaluate(() => { window.DaimondWorkers.MAX = 1; });
	}

	clearMockLog();
	// Two `spawn_agent` calls in ONE turn — the shape the daimon's own prompt
	// describes. Different chunk counts so each report is traceable to its task.
	await steerDiamond(s, '@tools spawn_agent {"name":"alpha","task":"@long 21"}'
		+ ' ;; spawn_agent {"name":"beta","task":"@long 34"}');
	await p.waitForTimeout(1500);

	// The DAIMON's request, found by the directive it was sent — not the last row
	// in the log. By the time the steer returns, the workers it started have
	// already sent requests of their own, and a worker holds `Tool::browser()`
	// just as a chat does: reading the last row reports the chat's 22 tools and
	// calls it the daimon's belt.
	const daimonRow = mockLog().find((row) => (row.messages || [])
		.some(m => m && m.role === 'user' && /@tools spawn_agent/.test(contentText(m.content))));
	const daimonTools = (daimonRow || {}).tools || [];
	check(daimonTools.includes('spawn_agent'),
		'a daimon IS offered spawn_agent, and a chat is the only surface without it',
		daimonTools.join(', ') || '(the daimon request was not found)');

	// Watched while it happens, which is what the user asked for. `running` is
	// set in Workers.start and cleared when the turn ends, so the highest count
	// seen is the number that were genuinely in flight together.
	let peak = 0, saw = [];
	const t0 = Date.now();
	while (Date.now() - t0 < 40000) {
		const now = await p.evaluate(() => (window.DaimondWorkers.runs || [])
			.map(r => ({ name: r.name, status: r.status })));
		const running = now.filter(r => r.status === 'running').length;
		if (running > peak) peak = running;
		saw = now;
		const terminal = now.filter(r => ['done', 'error', 'stopped'].includes(r.status)).length;
		if (now.length >= 2 && terminal >= 2) break;
		await p.waitForTimeout(100);
	}
	await shot(s, 'agentroute-dispatched');

	check(saw.length === 2, 'two workers were started', saw.map(r => r.name).join(', ') || '(none)');
	check(peak >= 2, 'and both were running at the same moment',
		'peak concurrent = ' + peak);

	// The same claim again, from OUTSIDE the app, because the poll above reads a
	// status the page sets before it has sent anything: a build that marked both
	// `running` and then queued the requests behind one another would satisfy it.
	//
	// `@long 21` streams 21 words at 120ms each, so the mock cannot have finished
	// answering alpha until at least 2520ms after alpha's request arrived. If
	// beta's request arrived inside that window, the two were on the wire together.
	// Only arrival times are recorded, and that is enough for this direction.
	const arrivals = {};
	for (const row of mockLog()) {
		const us = (row.messages || []).filter(m => m && m.role === 'user');
		const last = us.length ? contentText(us[us.length - 1].content).trim() : '';
		if (/^@long 21\b/.test(last) && !arrivals.alpha) arrivals.alpha = Date.parse(row.at);
		if (/^@long 34\b/.test(last) && !arrivals.beta)  arrivals.beta  = Date.parse(row.at);
	}
	const gap = (arrivals.alpha && arrivals.beta)
		? Math.abs(arrivals.beta - arrivals.alpha) : null;
	check(gap !== null && gap < 21 * 120,
		'and the provider had both requests in hand at once',
		gap === null ? 'one of the two never reached the mock' : gap + 'ms apart, alpha needs 2520ms');

	const reports = await p.evaluate(() => (window.DaimondWorkers.runs || [])
		.map(r => ({ name: r.name, status: r.status, text: r.text || '' })));
	const alpha = reports.find(r => r.name === 'alpha');
	const beta  = reports.find(r => r.name === 'beta');
	check(!!alpha && alpha.status === 'done', 'alpha finished', alpha ? alpha.status : 'absent');
	check(!!beta && beta.status === 'done', 'beta finished', beta ? beta.status : 'absent');
	// Each report has to be the one its OWN task produced. Two reports that are
	// merely non-empty would pass with both tiles showing the same worker's words.
	check(!!alpha && /chunk-21\b/.test(alpha.text) && !/chunk-34\b/.test(alpha.text),
		'alpha reported its own task and only its own',
		alpha ? alpha.text.slice(-24).trim() : 'absent');
	// `chunk-22` is the discriminator: only the 34-chunk task ever emits one, so a
	// beta tile carrying alpha's words cannot satisfy this.
	check(!!beta && /chunk-34\b/.test(beta.text) && /chunk-22\b/.test(beta.text),
		'beta reported its own task, which ran longer',
		beta ? beta.text.slice(-24).trim() : 'absent');

	// A world is the dev server and the mock, and deliberately NOT the gateway --
	// it holds one account store and one :9002 binding, so the browser-only tiers
	// run without it and the page's account poll answers 502. That is the world
	// being a world, not this flow going wrong, so it is named and skipped rather
	// than left to fail every run and train the eye past the line.
	const thrown = errors(s).filter(e => !/502 \(Bad Gateway\)/.test(e));
	check(thrown.length === 0, 'and nothing threw on the way',
		thrown.slice(0, 2).join(' | ') || 'clean (gateway 502s aside: no gateway in a world)');

} catch (e) {
	check(false, 'the run finished', String(e && e.message || e));
	try { await shot(s, 'agentroute-threw'); } catch {}
} finally {
	await s.close();
}

console.log(failures === 0
	? `\nverify_agentroute: all checks pass.`
	: `\nverify_agentroute: ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);

// gateway: none
// verify_turnfacts.mjs — every turn's ledger entry carries what the turn was like (MC1).
//
// Plan §7 MC1 (D-20261009-01). The ledger used to know what a turn cost and nothing about how
// it went. The entry now carries, written on the device that ran the turn:
//
//   ft  ms from send to the first model event      tc  tool calls
//   te  those the ENGINE says failed               sg  stalls inside one provider call
//   ro  the role that ran it: c chat, d daimon, w worker
//
// and ZERO IS ABSENT: a quiet turn adds only `ft` and `ro`, so the ledger does not grow a
// column of zeros per turn on every device it syncs to.
//
// Each of the three paths that run a model -- an ordinary chat, a Diamond's daimon, a worker
// the daimon dispatched -- has its own event sink and its own call site, and is checked on its
// own, with the same three turns:
//
//   slow  `@slow 800`: ft lands within ±150 ms of the mock's delay, and nothing else is written.
//   tool  `@tool file_read` on a path that is not there: tc 1, te 1 (the outcome is `failed`).
//   long  `@long 6` at 120 ms a chunk, with `window.__daimondStallMs` lowered to 100: sg >= 1.
//
// And two joins: the daimon's entry is keyed on the answer's `prod.t` (the steer's own
// message), and a worker's on its run id, which its relayed report's handle names.
//
// RED first: `--break pre` serves the tree's ledger.js and daimond.js as they were before MC1
// (ed595e3f), and each fact has a break of its own that removes it from one place.
//
//   node dev/verify_turnfacts.mjs --break pre        # nearly every check fails
//   node dev/verify_turnfacts.mjs --break noft       # the ft checks fail
//   node dev/verify_turnfacts.mjs --break note       # the te checks fail
//   node dev/verify_turnfacts.mjs --break nostall    # the sg checks fail
//   node dev/verify_turnfacts.mjs --break zeros      # the zero-is-absent checks fail
//   node dev/verify_turnfacts.mjs --break dmid       # the daimon join fails
//   node dev/verify_turnfacts.mjs --break norid      # the worker join fails
//   node dev/verify_turnfacts.mjs                    # clean
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, chat, newChat, shot } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WWW  = path.join(ROOT, 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const J = (x) => JSON.stringify(x);

const SLOW   = 800;			// the mock's delay before its first word
const BAND   = 150;			// ft must land within this of SLOW, never widened
const STALL  = 100;			// the lowered stall threshold; `@long` paces 120 ms a chunk
const BEFORE = 'ed595e3f';		// the tree before MC1

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Each break is a list of edits to served files; `pre` replaces two files whole.
const BREAKS = {
	noft:    [{ file: 'js/ledger.js', find: 'if (ft === undefined) ft = Math.max(0, now - t0);', with: '' }],
	note:    [{ file: 'js/ledger.js', find: "if (ev.outcome === 'failed') te++;", with: '' }],
	nostall: [{ file: 'js/ledger.js', find: 'if (last !== null && now - last >= stallMs) sg++;', with: '' }],
	zeros:   [{ file: 'js/ledger.js', find: 'isFinite(v) && v >= 0.5) entry[k] = Math.round(v);',
		with: 'isFinite(v) && v >= 0) entry[k] = Math.round(v);' }],
	dmid:    [{ file: 'js/daimond.js', find: 'recordTurnOutcome(dsPair.model, dsPair.provider, dumid,',
		with: 'recordTurnOutcome(dsPair.model, dsPair.provider, dmid,' },
		{ file: 'js/daimond.js', find: 'meterDiamondTurn(fa, diamondId, dumid);',
		with: 'meterDiamondTurn(fa, diamondId, dmid);' }],
	norid:   [{ file: 'js/daimond.js', find: "(run.prov && run.prov.rid) || '', wmeter ? wmeter.facts('w') : null);",
		with: "'', wmeter ? wmeter.facts('w') : null);" }],
};

/// The served bodies a break asks for, by file, checked so a break that matched nothing
/// stops the run instead of passing as though it had broken something.
function served() {
	if (!BREAK) return {};
	if (BREAK === 'pre') {
		const old = (f) => execFileSync('git', ['show', `${BEFORE}:www/${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
		return { 'js/ledger.js': old('js/ledger.js'), 'js/daimond.js': old('js/daimond.js') };
	}
	const spec = BREAKS[BREAK];
	if (!spec) {
		console.error(`no such break: ${BREAK}; known: pre ${Object.keys(BREAKS).join(' ')}`);
		process.exit(2);
	}
	const out = {};
	for (const e of spec) {
		const src = out[e.file] || fs.readFileSync(path.join(WWW, e.file), 'utf8');
		const n = src.split(e.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': the anchor appears ${n} times in ${e.file}, so nothing was broken`);
			process.exit(2);
		}
		out[e.file] = src.replace(e.find, e.with);
	}
	return out;
}

const ledger = (page) => page.evaluate(() => {
	try { return JSON.parse(localStorage.getItem('daimond-ledger') || '[]'); } catch (e) { return []; }
});
const until = async (page, fn, arg, ms, step = 250) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await page.evaluate(fn, arg).catch(() => false)) return true;
		await page.waitForTimeout(step);
	}
	return false;
};

/// The checks every path shares, on its three entries.
function checkPath(tag, role, slow, tool, long) {
	check(`${tag}: each turn reached the ledger`, !!slow && !!tool && !!long,
		J({ slow: !!slow, tool: !!tool, long: !!long }));
	const ro = [slow, tool, long].map((e) => e && e.ro);
	check(`${tag}: ro is ${role} on every entry`, ro.every((r) => r === role), J(ro));
	const ft = slow && slow.ft;
	check(`${tag}: ft is the wait for the first word, ${SLOW} ± ${BAND} ms`,
		typeof ft === 'number' && Math.abs(ft - SLOW) <= BAND, `ft = ${ft}`);
	check(`${tag}: a quiet turn writes no tc, te, sg or im (zero is absent)`,
		!!slow && !('tc' in slow) && !('te' in slow) && !('sg' in slow) && !('im' in slow),
		slow ? J(slow) : '(no entry)');
	check(`${tag}: a failed file_read counts one call, one failed`,
		!!tool && tool.tc === 1 && tool.te === 1, tool ? `tc = ${tool.tc}, te = ${tool.te}` : '(no entry)');
	check(`${tag}: and that turn, which never stalled, writes no sg`,
		!!tool && !('sg' in tool), tool ? `sg = ${tool.sg}` : '(no entry)');
	check(`${tag}: a stream paced past the stall threshold counts its stalls`,
		!!long && long.sg >= 1, long ? `sg = ${long.sg}` : '(no entry)');
	check(`${tag}: and, having run no tool, writes no tc or te`,
		!!long && !('tc' in long) && !('te' in long), long ? J(long) : '(no entry)');
}

const s = await open({ name: 'turnfacts', signIn: false, connect: false });
const { page } = s;
const bodies = served();
for (const [file, body] of Object.entries(bodies)) {
	await page.route('**/' + file, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
}
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);
await page.addInitScript((ms) => { window.__daimondStallMs = ms; }, STALL);
await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
await signInAs(s, 'turnfacts');
await connectMock(s);
await page.waitForTimeout(1200);

const MISSING = 'turnfacts-nope/' + Date.now().toString(36) + '.md';
const TOOL = '@tool file_read ' + J({ path: MISSING });

try {
	// ══ C. An ordinary chat ═══════════════════════════════════════════════
	await page.evaluate(() => { try { localStorage.removeItem('daimond-ledger'); } catch (e) {} });
	const chatTurn = async (text) => {
		const n = (await ledger(page)).length;
		await chat(s, text);
		await page.waitForTimeout(500);
		const after = await ledger(page);
		return after.length > n ? after[after.length - 1] : null;
	};
	// A first turn to stand the engine up, so `slow` measures a turn and not a cold start.
	await chatTurn('@text warm');
	const cSlow = await chatTurn(`@slow ${SLOW} hello`);
	const cTool = await chatTurn(TOOL);
	const cLong = await chatTurn('@long 6');
	console.log('  chat entries:', J([cSlow, cTool, cLong]));
	// `te` counts the engine's `failed` only, never `refused`, so te 1 is that outcome.
	checkPath('C', 'c', cSlow, cTool, cLong);

	// ══ D. A Diamond's daimon, and W. the workers it dispatches ═══════════
	await page.click('#new-diamond-btn');
	await page.waitForSelector('.dlg-input', { timeout: 8000 });
	await page.fill('.dlg-input', 'Turn facts ' + Date.now().toString(36));
	await page.click('.dlg-ok');
	await page.waitForTimeout(1500);
	const D = await page.evaluate(() => { const d = window.DaimondDiamond.current(); return d ? d.id : ''; });
	check('D: a Diamond is made and on screen', !!D, D);

	const daimonTurn = async (text, ms = 90000) => {
		const n = (await ledger(page)).length;
		await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
		await page.waitForTimeout(400);
		await page.fill('#chat-input', text);
		await page.click('#chat-send', { force: true });
		await until(page, (D) => { try { return window.DaimondCore.diamondBusy(D); } catch (e) { return false; } }, D, 8000);
		await until(page, (D) => { try { return !window.DaimondCore.diamondBusy(D); } catch (e) { return true; } }, D, ms, 500);
		await page.waitForTimeout(1000);
		const rec = await page.evaluate((D) => {
			const r = window.DaimondDiamond.conversation(D);
			return r ? JSON.parse(JSON.stringify(r.messages || [])) : [];
		}, D);
		const ui = rec.map((m) => m.role === 'user' && m.content === text).lastIndexOf(true);
		const after = ui >= 0 ? rec.slice(ui + 1) : [];
		const ans = after.find((m) => m.role === 'assistant' && Array.isArray(m.prod) && m.prod.length) || null;
		const led = (await ledger(page)).slice(n);
		return { user: ui >= 0 ? rec[ui] : null, ans, after, led, all: rec };
	};
	const daimonOf = (t) => t.led.filter((e) => e.ro === 'd').pop()
		|| t.led.filter((e) => !e.ro).pop() || null;

	await daimonTurn('@text warm');
	const dSlow = await daimonTurn(`@slow ${SLOW} hello`);
	const dTool = await daimonTurn(TOOL);
	const dLong = await daimonTurn('@long 6');
	console.log('  daimon entries:', J([daimonOf(dSlow), daimonOf(dTool), daimonOf(dLong)]));
	checkPath('D', 'd', daimonOf(dSlow), daimonOf(dTool), daimonOf(dLong));
	const pt = dSlow.ans ? dSlow.ans.prod[0].t : '';
	const de = daimonOf(dSlow);
	check("D: the daimon's entry is keyed on its answer's prod.t",
		!!pt && !!de && de.tid === pt, `tid = ${de && de.tid}, prod.t = ${pt}`);
	check('D: which is the steer’s own message',
		!!pt && !!dSlow.user && pt === String(dSlow.user.mid), `prod.t = ${pt}, user mid = ${dSlow.user && dSlow.user.mid}`);

	// Three workers in one steer, one per turn shape, gathered before the steer ends.
	const steer = '@tools '
		+ [['wslow', `@slow ${SLOW} hello`], ['wtool', TOOL], ['wlong', '@long 6']]
			.map(([name, task]) => 'spawn_agent ' + J({ name, task })).join(' ;; ')
		+ ' ;; gather ' + J({ names: ['wslow', 'wtool', 'wlong'], timeout_s: 60 });
	const w = await daimonTurn(steer, 120000);
	const wl = w.led.filter((e) => e.ro === 'w' || (e.tid && /^w-/.test(e.tid)));
	console.log('  worker entries:', J(wl));
	// Which entry is which, by the run's own facts: the tool one ran a tool, the long one stalled.
	const wTool = wl.find((e) => e.tc >= 1) || null;
	const wLong = wl.find((e) => e !== wTool && e.sg >= 1) || null;
	const wSlow = wl.find((e) => e !== wTool && e !== wLong) || null;
	check('W: three workers, three entries', wl.length === 3, `${wl.length} worker entries`);
	checkPath('W', 'w', wSlow, wTool, wLong);

	// ══ R. The worker join: an entry under the run id its report's handle names ══
	// A report the daimon gathers in-turn is folded into its answer and carries no record of
	// its own, so the join is read where a report DOES carry one: a chat's worker, relayed as
	// a message because nobody was looking when it finished (as verify_provenance R).
	const rc = await newChat(s);
	const n0 = (await ledger(page)).length;
	await chat(s, '@tool spawn_agent ' + J({ name: 'tfrelay', task: '@slow 4000 hello' }), { timeout: 45000 });
	await newChat(s);
	let relay = null;
	for (const t0 = Date.now(); !relay && Date.now() - t0 < 60000; await page.waitForTimeout(400)) {
		const ms = await page.evaluate(async (cid) => {
			try { const g = await window.DaimondCore.chatStore().loadMessages(cid); return (g && g.messages) || []; }
			catch (e) { return []; }
		}, rc).catch(() => []);
		relay = ms.find((m) => m.role === 'assistant' && Array.isArray(m.prod) && m.prod.some((p) => p && p.k === 'worker')) || null;
	}
	const wh = relay ? String(relay.prod[0].h || '') : '';
	const re = (await ledger(page)).slice(n0).filter((e) => e.ro === 'w');
	check('R: the report was relayed with its worker record', /^p1:worker:w-/.test(wh), wh || 'no relay');
	check("R: the worker's entry is keyed on the run id that handle names",
		re.length === 1 && wh === 'p1:worker:' + re[0].tid, `tid ${J(re.map((e) => e.tid))} vs ${wh}`);
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).slice(0, 400));
}

await shot(s, 'turnfacts');
const errs = s.errs.filter((x) => !/favicon|404|401|net::ERR/.test(x));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);

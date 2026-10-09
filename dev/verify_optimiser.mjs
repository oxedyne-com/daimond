// gateway: live
// verify_optimiser.mjs — the Daimond Optimiser, end to end, from a real signal to
// a tile you can answer.
//
// The Optimiser was DESIGNED complete and never once worked. Every link existed:
// the signal index counted, the digest was written, the grant was made, the timer
// was seeded. The chain broke in three places at once, and each break was
// invisible from either side of it -- the timer could only fire while the
// Optimiser was the Diamond on screen and nobody sits looking at the Optimiser;
// `Pending.add` refused every kind but `consent`, so a finding had nowhere to
// land; and the instruction never said what shape to answer in, so even a firing
// would have produced prose with no headline. In the app's whole life it ran
// once, by hand, and put nothing in front of anybody.
//
// So this file drives the WHOLE chain and asserts at every link, because a chain
// with one link missing looks exactly like a chain that is simply quiet -- which
// is the failure it took a lens query over 59 turns to see at all.
//
//   1. THE SEED. The action ships stopped, with its pause leaf held, and says in
//      its instruction what shape to answer in and what not to do.
//   2. THE SIGNAL. A synthetic tool failure reaches the digest as a FINDING with
//      its number, names no mood, and says that it never actions anything.
//   3. THE FIRING, OFF SCREEN. Armed, with another Diamond in front of the user,
//      the timer runs a turn for the Optimiser: the model is sent the digest, the
//      reply lands in the Optimiser's own conversation, and THE SCREEN DOES NOT
//      MOVE.
//   4. THE TILE. A two-line answer becomes one `proposal` in Pending, headline
//      and evidence in the reader's own words; a one-line "nothing stands out"
//      becomes nothing; a turn under the autonomous posture becomes nothing.
//   5. THE ANSWERS. The tick sends "Do it: …" back to the Optimiser's own chat;
//      the cross empties the panel.
//   6. WHAT IT MAY NOT DO. It may not publish and it may not dispatch a worker,
//      and no other Diamond is touched by either withholding.
//
//   node dev/verify_optimiser.mjs
//   node dev/verify_optimiser.mjs --breaks   # every break still matches; no browser
//   node dev/verify_optimiser.mjs --only OP1,OP4   # V3 (5.3.2): just those proposal sections (no section named with --proposals: all five)
//   node dev/verify_optimiser.mjs --break nofloor   # the trust floor removed: red in OP1 only
//   node dev/verify_optimiser.mjs --break nodedupe  # a dismissal forgotten at once: red in OP4 only
//   (a default run is the 29 checks and then OP1 to OP5; OP4's second device is a paired phone-and-desktop account, so the gateway is `live`.
//    Run from a 5.3.1 tree, where nothing is ever proposed, every OP section is red on its positive claim.)
//
// Every break below replaces a piece of the CODE UNDER TEST with the way it
// behaved before this work, or with the plausible wrong way to write it, and
// every check is red under at least one. A check nobody can turn red is not a
// check. The break is served to the real page through `page.route`, so the run
// is the product's own file with one thing wrong in it.
//
//   --break unpaused       the action ships armed
//   --break twoswitches    `+` writes `on: false` beside the held leaf, as it did
//   --break oldwords       the instruction as it was: no shape, no refusals
//   --break seedoff        seeded without leave to run off screen
//   --break nofinding      the index reports nothing, whatever it counted
//   --break moodword       the digest names the reader's state of mind
//   --break nodigestnote   the digest no longer says it never actions anything
//   --break onscreenonly   the old blanket refusal to steer an off-screen Diamond
//   --break switchto       the cheap rule: move the screen to the Diamond instead
//   --break wrongthread    the turn writes into the conversation ON SCREEN
//   --break kindrefused    `Pending.add` refuses every kind but consent
//   --break alwaysraise    "nothing stands out" raises a tile too
//   --break posturecapture the producer captures a turn run under the posture
//   --break offall         every activity action may run off screen
//   --break socialbelt     a daimon may publish in the user's name again
//   --break workersok      no Diamond's worker cap is withheld
//
// Which break reddens which, so a reader can see that nothing here is decorative
// and that no check is left without one:
//
//   1  ships stopped .................... unpaused
//   1b the light alone starts it ........ twoswitches
//   2  a title line, then the evidence ... oldwords
//   3  the one-line refusal offered ...... oldwords
//   4  names the reaction and the fan-out  oldwords
//   5  leave to run off screen ........... seedoff
//   6  the digest carries the finding .... nofinding
//   7  the digest names no mood .......... moodword
//   8  the digest never actions anything . nodigestnote
//   9  the model was sent the digest ..... onscreenonly, seedoff, nofinding
//   10 the screen did not move ........... switchto
//   11 into the Optimiser's conversation . wrongthread, onscreenonly, seedoff
//   12 one proposal .................. ┐
//   13 the headline .................. │
//   14 the evidence .................. ├ kindrefused, onscreenonly, seedoff
//   15 no mood on the tile ........... │
//   16 the tile names its Diamond .... ┘
//   17 "nothing stands out" raises nothing  alwaysraise
//   18 the posture raises nothing ........ posturecapture
//   19 the tick sends "Do it: …" ..... ┐ kindrefused, seedoff
//   20 and lands in that chat ........ ┘
//   21 the cross empties the panel ....... kindrefused, seedoff
//   22 withheld from every daimon ........ socialbelt
//   23 the egress door denies ............ socialbelt, seedoff
//   24 the Social panel is told why ...... socialbelt, seedoff
//   25 the worker cap is zero ............ workersok
//   26 an action that did not ask ........ offall
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { open, connectMock, signInAs, scratch, shot, mockLog } from './harness.mjs';
import { pair } from './handoffpair.mjs';
import { GW_URL } from './ports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const OUT  = path.join(os.homedir(), '.cache/daimond/optimiser-shots');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};
const die = (why) => { console.log('  FAIL  ' + why); process.exit(1); };

const BI  = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.split('=')[1] : (BI >= 0 ? (process.argv[BI + 1] || '') : '');

// ── The breaks ────────────────────────────────────────────────────────
//
// `file` is which source is damaged, `from`/`to` the exact swap. Each one is
// asserted to still match before the browser opens: a break that silently stops
// matching is a break that proves nothing, and a green run under it would read as
// a check that cannot fail rather than as a stale string.
const BREAKS = {
	unpaused: { file: 'js/daimond.js',
		what: 'the seeded action arrives armed: its leaf is never seeded held',
		from: "\t\t\t\t\ttry { DaimondPause.seedPaused(DaimondTriggers.node(id, ta.id)); }",
		to:   "\t\t\t\t\ttry { /* UNPAUSED: the leaf is left playing */ }" },
	// The old pair, restored at the `+` handler: a record switched off beside a
	// held leaf. `ready` honours the record -- a hand-edited file may switch an
	// action off -- so the light releasing the leaf throws one switch of two, and
	// the action reads ▶ while `allowed` goes on refusing. Every action `+` made
	// was born this way, and so was the Optimiser's, until 2026-09-15.
	twoswitches: { file: 'js/daimond.js',
		what: 'a new action is written `on: false` as well as held, so play throws one switch of two',
		from: "\t\t\t\tawait Triggers.set(opts.id, ta);",
		to:   "\t\t\t\tta.on = false;\n\t\t\t\tawait Triggers.set(opts.id, ta);" },
	oldwords: { file: 'js/daimond.js',
		what: 'the instruction as it was, with no answer shape and neither refusal',
		from: "instruction: 'Read system/usage/digest.md. State ONE finding as a title '\n"
			+ "\t\t\t\t\t+ 'line, then the evidence, citing the digest\\'s number; or say in one '\n"
			+ "\t\t\t\t\t+ 'line that nothing stands out. Name the defect, never the reaction. '\n"
			+ "\t\t\t\t\t+ 'Do not dispatch workers.',",
		to:   "instruction: 'Read system/usage/digest.md. Say, briefly, the one thing '\n"
			+ "\t\t\t\t\t+ 'that would make the work go better, and cite the number you got it '\n"
			+ "\t\t\t\t\t+ 'from. A quiet week needs no findings.'," },
	seedoff: { file: 'js/daimond.js',
		what: 'seeded without leave to run while nobody is looking',
		from: "kind: 'activity', minutes: 30, offScreen: true,",
		to:   "kind: 'activity', minutes: 30," },
	nofinding: { file: 'js/signals.js',
		what: 'the index reports nothing, whatever it counted',
		from: "\tfunction findings(diamonds, now) {\n\t\tvar ix = load();",
		to:   "\tfunction findings(diamonds, now) {\n\t\tif (1) return [];\n\t\tvar ix = load();" },
	moodword: { file: 'js/signals.js',
		what: 'the digest names the reader’s state of mind',
		from: "\t\tL.push('## What stands out');\n\t\tL.push('');",
		to:   "\t\tL.push('## What stands out');\n\t\tL.push('');\n\t\tL.push('You seem frustrated.');" },
	nodigestnote: { file: 'js/signals.js',
		what: 'the digest no longer says it never actions anything',
		from: "\t\tL.push('It never actions anything either.",
		to:   "\t\tif (0) L.push('It never actions anything either." },
	onscreenonly: { file: 'js/daimond.js',
		what: 'the old blanket refusal to steer a Diamond that is not on screen',
		from: "\t\t\tif (!offScreenSteerAllowed(ta)) return no;",
		to:   "\t\t\treturn no;" },
	switchto: { file: 'js/daimond.js',
		what: 'the cheap rule: move the screen to the Diamond and steer it there',
		from: "\t\t\treturn { went: true, reply: await runSteer(f, text) };",
		to:   "\t\t\tawait selectDiamond(f);\n\t\t\treturn { went: true, reply: await doSteer(text) };" },
	wrongthread: { file: 'js/daimond.js',
		what: 'the turn writes into the conversation that is ON SCREEN',
		// `runSteer` has taken the thread from a detached run since d723c9d9; with none,
		// which is a triggered turn, it is still `daimonChat(f)`, and that is the half broken.
		from: "\t\tvar rec = detached ? detached.chat : daimonChat(f);\n\t\tvar onScreen = function () { return daimonOnScreen(rec); };",
		to:   "\t\tvar rec = detached ? detached.chat : daimonChat(currentDiamond || f);\n\t\tvar onScreen = function () { return daimonOnScreen(rec); };" },
	kindrefused: { file: 'js/daimond.js',
		what: '`Pending.add` refuses every kind but consent, as it did until 2026-09-15',
		// Re-anchored when `notice` joined the kinds (2026-09-24); the break is unchanged.
		from: "\t\t\tif (kind !== 'consent' && kind !== 'proposal' && kind !== 'notice') return null;",
		to:   "\t\t\tif (item.kind && item.kind !== 'consent') return null;" },
	alwaysraise: { file: 'js/daimond.js',
		what: '"nothing stands out" raises a tile like anything else',
		from: "\t\t\tif (!text || nothingStandsOut(text)) return;",
		to:   "\t\t\tif (!text) return;" },
	posturecapture: { file: 'js/daimond.js',
		what: 'the producer captures a turn run under the autonomous posture',
		from: "\t\t\tif (autonomousPosture()) return;",
		to:   "\t\t\tif (false) return;" },
	offall: { file: 'js/daimond.js',
		what: 'every activity action may run off screen, asked for or not',
		from: "\t\tif (!ta || ta.kind !== 'activity' || ta.offScreen !== true) return false;",
		to:   "\t\tif (!ta || ta.kind !== 'activity') return false;" },
	// WIDENED 2026-09-15 with the rule it breaks: publishing was withheld from the Optimiser
	// alone, by a clause in `WITHHELD`; it is now withheld from every Diamond's daimon by
	// `diamondMayPublish` itself, so the break is the sentence that used to stand there.
	socialbelt: { file: 'js/daimond.js',
		what: 'a daimon may publish in the user’s name again',
		from: "\t\treturn false;\n\t}\n\n\t/// How many workers may this Diamond's daimon dispatch at once?",
		to:   "\t\treturn true;\n\t}\n\n\t/// How many workers may this Diamond's daimon dispatch at once?" },
	workersok: { file: 'js/daimond.js',
		what: 'no Diamond’s worker cap is withheld',
		from: "\t\treturn (w && typeof w.workers === 'number') ? w.workers : Infinity;",
		to:   "\t\treturn Infinity;" },
};
// V3 (5.3.2): the proposals, OP1 to OP5, below. `--only OP1,OP3` or `--proposals` runs those alone (all five when none is named); a
// default run is the 29 checks above and then all five. Their breaks are under OP_BREAKS, and each edit must match exactly once.
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 && process.argv[i + 1] ? process.argv[i + 1].split(',') : []; })();
const OP_BREAKS = {
	// The trust floor is removed: every cell with any weight counts as trusted. Red in OP1 only.
	nofloor:  { red: 'OP1', file: 'js/ratingroll.js', edits: [
		{ from: "a.ok = a.eff >= a.floor;", to: "a.ok = a.eff > 0;" } ] },
	// A dismissed (or retired) proposal is forgotten at once: no note and no switch is held by one. Red in OP4 only.
	nodedupe: { red: 'OP4', file: 'js/steering.js', edits: [
		{ from: "return e.level === p.level && e.scope === p.scope && cooling(e, cell) > 0;", to: "return false;" },
		{ from: "e.to === x.c.key && cooling(e, cur) > 0; })) return;", to: "e.to === x.c.key && false; })) return;" } ] },
};
const OP_ONLY = process.argv.includes('--proposals') || ONLY.length > 0 || !!OP_BREAKS[BREAK];
let OP_PATCH = null;
for (const [name, b] of Object.entries(OP_BREAKS)) {
	// A 5.3.1 tree has no ratingroll.js or steering.js: its breaks cannot be checked there, and only a break asked for (or --breaks) is refused for it.
	let src = null;
	try { src = fs.readFileSync(path.join(WWW, b.file), 'utf8'); }
	catch (e) { if (name === BREAK || process.argv.includes('--breaks')) { console.error(`break '${name}': www/${b.file} is not in this tree`); process.exit(2); } continue; }
	for (const e of b.edits) {
		const n = src.split(e.from).length - 1;
		if (n !== 1) { console.error(`break '${name}': anchor matched ${n} times, not once, in www/${b.file}: ${JSON.stringify(e.from)}`); process.exit(2); }
		src = src.replace(e.from, () => e.to);
	}
	if (name === BREAK) { OP_PATCH = [{ file: b.file, src }]; console.log(`\n*** BREAK ${BREAK}: only ${b.red} may go red ***\n`); }
}
if (BREAK && !BREAKS[BREAK] && !OP_BREAKS[BREAK]) die(`no break called "${BREAK}" — see the header`);

// EVERY break is matched against the source on EVERY run, not just the one that
// was asked for. A break whose string has drifted does not fail loudly when
// nobody selects it: it sits there reading like a check that cannot fail, and the
// first anybody knows of it is a green run under a break that damaged nothing.
// Fifteen string counts, so it costs nothing to keep them all honest.
{
	const stale = [];
	for (const [name, b] of Object.entries(BREAKS)) {
		const src = fs.readFileSync(path.join(WWW, b.file), 'utf8');
		const n = src.split(b.from).length - 1;
		if (n !== 1) stale.push(`${name} matches www/${b.file} ${n} time(s), not once`);
	}
	if (stale.length) die('break(s) no longer match the source:\n         ' + stale.join('\n         '));
	if (process.argv.includes('--breaks')) {
		console.log(`  ok   all ${Object.keys(BREAKS).length + Object.keys(OP_BREAKS).length} breaks still match the source`);
		process.exit(0);
	}
}

let ROUTE = null;
if (BREAK && BREAKS[BREAK]) {
	const b = BREAKS[BREAK];
	const src = fs.readFileSync(path.join(WWW, b.file), 'utf8');
	const broken = src.replace(b.from, b.to);
	console.log(`\n*** BREAK ${BREAK}: ${b.what} — failures below are the point ***\n`);
	ROUTE = async (page) => {
		await page.route('**/' + b.file, (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: broken,
		}));
	};
}

// The mood words `www/js/signals.js` exists to keep off every surface, and the
// list is verify_signals' own so the two files cannot come to disagree about what
// the rule forbids.
const MOOD = /frustrat|angry|upset|annoy|mood|swear|swore|profan|temper|emotion|stressed|irritat/i;
// What the synthetic signal must produce, word for word, because it is the
// sentence that has to travel the whole chain: index → digest → model → tile.
const FINDING = 'web_fetch refused 6 of 8 calls';

// ══ V3 (5.3.2, U7): the proposals, OP1 to OP5 ══════════════════════════════════
// The page, not a model, turns trusted rating cells into Pending tiles (steering.js `proposals`, daimond.js `steerRaise`). Seeded rated chats go
// into the real ChatStore; a digest write raises the tiles; the presses are real clicks; the note file is read back through the wasm store.
//   OP1 no proposal below the floor: a cell one rating short (`more` = 1) raises nothing, one rating more raises it   [J5]
//   OP2 on input chosen to provoke it (strong language, mood tags, a signal index full of it), no tile, evidence or note names the reaction   [J9]
//   OP3 Add writes exactly the line the tile showed, and Edit then Add the line as edited (the file's bytes are compared)   [J8]
//   OP4 Dismiss is not re-raised: not on this device (a digest, a reload), not for 19 more answers and again at 20, not on a second
//       device of the account; the dismissal Switch Back writes keeps that switch away for 20 answers too
//   OP5 Switch changes the Diamond's model through setDiamondModel (the one writer of its model record), and the Diamond cog shows it
// The positive claim of each section is a tile that must appear, so each is red on 5.3.1 (where nothing is ever proposed).
const OPN = { n: 0 }, OPBAD = {}, OPOK = {};
const opcheck = (sec, cond, msg, detail) => { OPBAD[sec] = OPBAD[sec] || 0; OPOK[sec] = OPOK[sec] || 0; cond ? OPOK[sec]++ : OPBAD[sec]++; check(cond, sec + '  ' + msg, detail); };
const HELP = '0da1000000e1', OPTD = '0da1000000f2', STEER_FILE = '.daimond/steering.md';
const LONGLINE = 'Keep answers under about 200 words unless asked for detail.';
const OP_BASE = 1790000000000;
const opwait = (ms) => new Promise((r) => setTimeout(r, ms));
const opuntil = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { let v = false; try { v = await fn(); } catch (e) { v = false; } if (v || Date.now() - t0 > ms) return v; await opwait(150); } };

/// Seed rated answers into the real ChatStore: { model, d, up, down, tagged, extra, note, pv }; `tagged` of the down-rates carry `long`, `extra` tags go on every down-rate.
async function rated(page, g) {
	const base = OP_BASE + (OPN.n += 1) * 100000000;
	return page.evaluate(async (a) => {
		const R = window.DaimondRatings, st = DaimondCore.chatStore(), id = DaimondPricing.identify(a.g.model);
		const cid = 'opchat' + a.n, msgs = [], list = st.stored();
		const stamp = (i) => ({ h: 'p1:answer:' + cid + '/a-' + i, k: 'answer', m: a.g.model, pv: a.g.pv || 'custom', cm: id.cm, fam: id.fam, fi: !!id.fi, cls: id.cls,
			role: 'chat', sp: 'sp1:3f9a0c12', d: a.g.d || '', c: cid, t: 'm' + i, dev: 'd-4f2a', at: a.base, hash: '', run: '', via: '' });
		const total = a.g.up + a.g.down;
		for (let i = 0; i < total; i++) {
			const up = i < a.g.up, ts = a.base + (i + 1) * 2000, prod = stamp(i);
			msgs.push({ role: 'assistant', mid: 'a-' + i, ts: ts, content: 'an answer ' + i, prod: [prod] });
			const tags = up ? [] : ((i - a.g.up) < (a.g.tagged || 0) ? ['long'] : []).concat(a.g.extra || []);
			const rid = R.newId(ts + 1000, 'q' + String(i).padStart(4, '0'));
			msgs.push(R.message(R.build({ prod: prod, s: up ? 1 : -1, clear: false, tags: tags, dims: {}, note: a.g.note || '', src: 'tap', sup: '', burst: '', tools: '', len: 300 }), rid, ts + 1000));
		}
		list.push({ id: cid, name: 'op ' + a.n, model: a.g.model, updatedAt: a.base + (total + 2) * 2000, messages: msgs, session: null });
		await st.save(list);
		try { await st.settled(); } catch (e) { /* the alarm is up; the read is what there is */ }
		return cid;
	}, { g: g, base: base, n: OPN.n });
}
/// The cell the page's own roll holds for a model at a level: { n, eff, floor, ok, more, claim }.
const cellOf = (page, lv, sc, cm) => page.evaluate(async (a) => {
	const st = DaimondCore.chatStore(), parts = [];
	for (const c of st.stored()) { const g = await st.loadMessages(c.id); parts.push(DaimondRatingRoll.chatPart(g.messages || [])); }
	const c = DaimondRatingRoll.cell(DaimondRatingRoll.cells(parts, { sides: null }), a.lv, a.sc, 'cm', a.cm);
	return c ? { n: c.n, eff: c.eff, floor: c.floor, ok: c.ok, more: c.more, claim: c.claim } : null;
}, { lv, sc, cm }).catch((e) => ({ err: String(e.message || e) }));
/// The steer tiles on the page, with the proposal behind each.
const tiles = (page) => page.evaluate(() => DaimondPendingView.items().filter((x) => x.kind === 'steer' && x.steer).map((x) => ({
	id: x.id, kind: x.steer.kind, level: x.steer.level, scope: x.steer.scope, line: x.steer.line, to: x.steer.to, key: x.steer.key, tag: x.steer.tag,
	at: x.steer.at, head: x.headline, detail: x.detail, ev: x.steer.evidence }))).catch(() => []);
const raise = async (page) => {
	await page.evaluate(() => DaimondDiamond.usageDigest()).catch(() => {});
	await page.evaluate(() => (window.DaimondPendingView && DaimondPendingView.steer) ? DaimondPendingView.steer() : null).catch(() => {});
	await opwait(300);
	return tiles(page);
};
const has = (ts, kind, level, scope, key, to) => ts.find((t) => t.kind === kind && t.level === level && t.scope === scope && (!key || t.key === key) && (!to || t.to === to));
/// Press `label` on the tile `id` in the Pending panel, as a person does (opened first; the DOM click is the fallback where another tile covers it).
async function press(page, id, label) {
	await page.evaluate(() => DaimondPanels.show('pending'));
	await page.evaluate((id) => { const l = document.querySelector(`#pending-list .pend-card[data-id="${id}"] .pend-line[aria-expanded="false"]`); if (l) l.click(); }, id);
	await opwait(250);
	const b = page.locator(`#pending-list .pend-card[data-id="${id}"] .pend-act`, { hasText: new RegExp('^' + label + '$') }).first();
	await b.waitFor({ state: 'visible', timeout: 8000 });
	await b.scrollIntoViewIfNeeded();
	await b.click({ timeout: 4000 }).catch(async () => { await b.evaluate((el) => el.click()); });
	await opwait(900);
}
const fileOf = (page, d) => page.evaluate(async (p) => { const W = await import('/pkg/oxedyne_daimond.js'); try { return String(await W.store_read(p)); } catch (e) { return ''; } }, 'diamonds/' + d + '/' + STEER_FILE);
const modelOf = (page, d) => page.evaluate((id) => {
	for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i);
		if (k && /daimond-diamond-models$/.test(k)) { try { const m = JSON.parse(localStorage.getItem(k) || '{}')[id]; return m ? { provider: m.provider, model: m.model } : null; } catch (e) { return null; } } }
	return null; }, d);
const opBreakRoute = () => (OP_PATCH ? async (page) => { await page.route((u) => OP_PATCH.some((p) => u.pathname.endsWith('/' + p.file)), (r) => {
	const f = OP_PATCH.find((p) => new URL(r.request().url()).pathname.endsWith('/' + p.file)); r.fulfill({ status: 200, contentType: 'application/javascript', body: f.src }); }); } : null);
const OPCTX = [];
/// A fresh device: signed in under its own name, the mock connected, the two default Diamonds up.
async function opctx(name) {
	const s = await open({ name: name, signIn: false, connect: false, route: opBreakRoute(), profile: scratch('pw', name + '-' + process.pid) });
	OPCTX.push(s);
	await signInAs(s, name);
	await connectMock(s);
	const page = s.page;
	await page.waitForFunction(() => !!(window.DaimondDiamond && DaimondDiamond.usageDigest && window.DaimondPendingView), null, { timeout: 40000 });		// not DaimondRatingRoll: 5.3.1 has none, and its sections are to fail on their claims
	await page.evaluate(() => DaimondDiamond.seedDefaults());
	await page.waitForFunction(() => [...document.querySelectorAll('#diamond-list .diamond-box')].length >= 2, null, { timeout: 30000 }).catch(() => {});
	return { s, page };
}
/// The data every section but OP1 starts from: Help (running mock/fast) rates fast 4 up 26 down (12 'long'), mock/thinker 15 up 1 down.
const standard = async (page, o = {}) => {
	await rated(page, { model: 'mock/fast', d: HELP, up: 4, down: 26, tagged: 12, note: o.note, extra: o.extra });
	await rated(page, { model: 'mock/thinker', d: HELP, up: 15, down: 1, tagged: 0, note: o.note });
};

const OPS = {
	OP1: async () => {
		const { page } = await opctx('op1a');
		const pre = await page.evaluate(() => !!(window.DaimondNotes && DaimondNotes.add && DaimondNotes.list && window.DaimondSteering && DaimondSteering.proposals && DaimondPendingView.steer)).catch(() => false);
		opcheck('OP1', pre, 'PRE: DaimondNotes, DaimondSteering.proposals and DaimondPendingView.steer are on the page');
		// A Diamond note: the Diamond floor is 6 effective ratings, and fading makes 7 the smallest count that reaches it.
		await rated(page, { model: 'mock/fast', d: HELP, up: 0, down: 6, tagged: 3 });
		let c = await cellOf(page, 2, HELP, 'fast');
		opcheck('OP1', !!c && c.ok === false && c.more === 1 && c.floor === 6, 'control: Help\'s mock/fast cell is one rating short of its floor (more = 1)', JSON.stringify(c));
		let ts = await raise(page);
		opcheck('OP1', !has(ts, 'note', 2, HELP) && !has(ts, 'switch', 2, HELP), 'no note and no switch is proposed from the cell one rating short', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		await rated(page, { model: 'mock/fast', d: HELP, up: 0, down: 1, tagged: 1 });
		c = await cellOf(page, 2, HELP, 'fast');
		ts = await raise(page);
		opcheck('OP1', !!c && c.ok === true && c.claim === 'bad' && !!has(ts, 'note', 2, HELP, 'fast'), 'one rating more: the cell holds its floor and the note is proposed (the silence above was the floor)', JSON.stringify(c) + ' ' + JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		// A switch needs both sides trusted: Help's fast is now bad and trusted; thinker 6 up is one short, 7 is not.
		await rated(page, { model: 'mock/thinker', d: HELP, up: 6, down: 0, tagged: 0 });
		c = await cellOf(page, 2, HELP, 'thinker');
		ts = await raise(page);
		opcheck('OP1', !!c && c.ok === false && c.more === 1 && !has(ts, 'switch', 2, HELP), 'no switch while the good side is one rating short', JSON.stringify(c));
		await rated(page, { model: 'mock/thinker', d: HELP, up: 1, down: 0, tagged: 0 });
		ts = await raise(page);
		opcheck('OP1', !!has(ts, 'switch', 2, HELP, 'fast', 'thinker'), 'one rating more on the good side: the switch is proposed', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		// ... and the bad side, in the other Diamond: fast 6 down (one short), thinker 7 up.
		await rated(page, { model: 'mock/fast', d: OPTD, up: 0, down: 6, tagged: 0 });
		await rated(page, { model: 'mock/thinker', d: OPTD, up: 7, down: 0, tagged: 0 });
		ts = await raise(page);
		opcheck('OP1', !has(ts, 'switch', 2, OPTD), 'no switch while the bad side is one rating short', JSON.stringify(await cellOf(page, 2, OPTD, 'fast')));
		await rated(page, { model: 'mock/fast', d: OPTD, up: 0, down: 1, tagged: 0 });
		ts = await raise(page);
		opcheck('OP1', !!has(ts, 'switch', 2, OPTD, 'fast', 'thinker'), 'one rating more on the bad side: the switch is proposed', JSON.stringify(ts.map((t) => t.kind + ':' + t.level + ':' + t.scope.slice(-2))));
		// The account: the floor is 10 effective ratings (11 reach it); ratings outside every Diamond.
		const B = await opctx('op1b');
		await rated(B.page, { model: 'mock/thinker', d: '', up: 0, down: 10, tagged: 4 });
		c = await cellOf(B.page, 3, '', 'thinker');
		ts = await raise(B.page);
		opcheck('OP1', !!c && c.ok === false && c.more === 1 && c.floor === 10 && !has(ts, 'note', 3, ''), 'an account cell one rating short (floor 10) proposes no note', JSON.stringify(c));
		await rated(B.page, { model: 'mock/thinker', d: '', up: 0, down: 1, tagged: 1 });
		ts = await raise(B.page);
		opcheck('OP1', !!has(ts, 'note', 3, '', 'thinker'), 'one rating more: the account note is proposed', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
	},

	OP2: async () => {
		const { page } = await opctx('op2');
		const NOTE = 'QUOKKAWRATH I am FRUSTRATED and ANGRY, I swore at it, bloody useless crap, damn it, I am upset and stressed and irritated';
		const TAGS = ['frustrated', 'angrybloodyhell', 'swearing'];
		const POISON = ['QUOKKAWRATH', 'frustrated', 'angrybloodyhell', 'swearing', 'bloody', 'useless', 'crap', 'damn', 'swore', 'fuck', 'WHAT?!'];
		await standard(page, { note: NOTE, extra: TAGS });
		// The signal index is fed the most provocative input it can be given, for the same Diamond.
		await page.evaluate((id) => { if (window.DaimondSignals) for (let i = 0; i < 12; i++) DaimondSignals.noteUserMessage({ diamondId: id, text: 'WHAT?! fuck this, that is wrong AGAIN, as i already told you', prevModel: 'mock/fast' }); }, HELP);
		// The provocation is really there: the ratings hold the note and the tags, and the signal index counted the swearing.
		const fed = await page.evaluate(async () => { const st = DaimondCore.chatStore(); let all = '';
			for (const c of st.stored()) { const g = await st.loadMessages(c.id); all += JSON.stringify(g.messages || []); }
			let missed = -1; try { missed = DaimondSignals.snapshot().diamonds['0da1000000e1'].missed; } catch (e) { /* none */ }
			return { note: all.includes('QUOKKAWRATH'), tag: all.includes('angrybloodyhell'), missed }; });
		opcheck('OP2', fed.note && fed.tag && fed.missed >= 12, 'control: the provoking input is in the seeded ratings (a note, a mood tag) and in the signal index', JSON.stringify(fed));
		const ts = await raise(page);
		opcheck('OP2', !!has(ts, 'note', 2, HELP) && !!has(ts, 'switch', 2, HELP) && !!has(ts, 'note', 3, ''), 'control: the provoking ratings raise a Diamond note, a switch and an account note', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		await page.evaluate(() => DaimondPanels.show('pending'));
		await opwait(500);
		const dom = await page.evaluate(() => (document.querySelector('#pending-list') || {}).innerText || '');
		const text = JSON.stringify(ts) + '\n' + dom;
		const hit = (s) => [...(s.match(MOOD) || []), ...POISON.filter((w) => s.toLowerCase().includes(w.toLowerCase()))];
		opcheck('OP2', ts.length > 0 && dom.length > 20 && hit(text).length === 0, 'no tile (head, why, line, evidence, drawn text) names the reaction or quotes a note, a tag or a message', hit(text).join(' ') || ('clean, ' + text.length + ' bytes'));
		const sw = has(ts, 'switch', 2, HELP), n2 = has(ts, 'note', 2, HELP);
		if (n2) await press(page, n2.id, 'Add');
		const f = await fileOf(page, HELP);
		opcheck('OP2', f.includes(LONGLINE) && hit(f).length === 0, 'and the note Add writes holds the fixed sentence and none of it', hit(f).join(' ') || JSON.stringify(f.slice(0, 120)));
		if (sw) await press(page, sw.id, 'Dismiss');
		const g = await fileOf(page, HELP);
		opcheck('OP2', g.includes(' · dismissed · ') && hit(g).length === 0, 'nor does the dismissal entry', hit(g).join(' ') || JSON.stringify(g.slice(-120)));
	},

	OP3: async () => {
		const { page } = await opctx('op3');
		await standard(page);
		let ts = await raise(page);
		const n2 = has(ts, 'note', 2, HELP), n3 = has(ts, 'note', 3, '');
		opcheck('OP3', !!n2 && !!n3 && n2.line === LONGLINE, 'control: a Diamond note and an account note are proposed, with the fixed sentence', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		if (!n2 || !n3) return;
		// The line as drawn on the tile, not the record's.
		await page.evaluate(() => DaimondPanels.show('pending'));
		await page.evaluate((id) => { const l = document.querySelector(`#pending-list .pend-card[data-id="${id}"] .pend-line[aria-expanded="false"]`); if (l) l.click(); }, n2.id);
		await opwait(300);
		const shown = await page.evaluate((id) => (document.querySelector(`#pending-list .pend-card[data-id="${id}"] .pend-steer-line`) || {}).textContent || '', n2.id);
		opcheck('OP3', shown === n2.line, 'the tile draws the line it will write', JSON.stringify(shown));
		await press(page, n2.id, 'Add');
		const f = await fileOf(page, HELP), m = /^## (\S+) · active · diamond · fast · long (\d+) of (\d+)\n/.exec(f);
		const want = m ? `## ${m[1]} · active · diamond · fast · long ${n2.at.t} of ${n2.at.n}\n${shown}\n` : '';
		opcheck('OP3', !!m && f === want && new TextEncoder().encode(f).length === new TextEncoder().encode(want).length, 'Add wrote the file whole: one header and the shown line, byte for byte, with the counts the tile showed', JSON.stringify(f.slice(0, 240)));
		// Edit then Add: the line as edited, non-ASCII included.
		const EDITED = 'Open with the answer, then give the reason in one short paragraph (naïve café 日本語).';
		await press(page, n3.id, 'Edit');
		await page.waitForSelector('.dlg textarea.dlg-area', { timeout: 6000 }).catch(() => {});
		const open0 = await page.evaluate(() => { const a = document.querySelector('.dlg textarea.dlg-area'); return a ? a.value : null; });
		opcheck('OP3', open0 === LONGLINE, 'Edit opens with the line the tile showed', JSON.stringify(open0));
		await page.fill('.dlg textarea.dlg-area', EDITED);
		await opwait(300);
		await page.locator('.dlg button', { hasText: /^Add$/ }).first().click({ timeout: 4000 }).catch(() => {});
		await opuntil(async () => (await fileOf(page, OPTD)).includes(EDITED), 8000);
		const fo = await fileOf(page, OPTD), mo = /^## (\S+) · active · account · fast · long (\d+) of (\d+)\n/.exec(fo);
		const wo = mo ? `## ${mo[1]} · active · account · fast · long ${n3.at.t} of ${n3.at.n}\n${EDITED}\n` : '';
		opcheck('OP3', !!mo && fo === wo, 'Edit then Add wrote the edited line exactly, in the Optimiser\'s file, byte for byte', JSON.stringify(fo.slice(0, 240)));
	},

	OP4: async () => {
		const { page } = await opctx('op4');
		await standard(page);
		let ts = await raise(page);
		const n2 = has(ts, 'note', 2, HELP), sw = has(ts, 'switch', 2, HELP, 'fast', 'thinker');
		opcheck('OP4', !!n2 && !!sw, 'control: a Diamond note and a switch are proposed', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		if (!n2 || !sw) return;
		await press(page, n2.id, 'Dismiss');
		await press(page, sw.id, 'Dismiss');
		const f = await fileOf(page, HELP);
		opcheck('OP4', / · dismissed · diamond · fast · long \d+ of 30\n/.test(f) && / · dismissed · diamond · fast · switch /.test(f), 'Dismiss wrote a dismissed entry for each, with the cell\'s count', JSON.stringify(f.slice(0, 260)));
		ts = await raise(page);
		opcheck('OP4', !has(ts, 'note', 2, HELP) && !has(ts, 'switch', 2, HELP), 'a digest write on this device raises neither again', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		await page.reload();
		await page.waitForFunction(() => !!(window.DaimondDiamond && DaimondDiamond.usageDigest && window.DaimondPendingView && window.DaimondNotes), null, { timeout: 40000 });
		await page.waitForFunction(() => [...document.querySelectorAll('#diamond-list .diamond-box')].length >= 2, null, { timeout: 30000 }).catch(() => {});
		await opwait(800);
		ts = await raise(page);
		opcheck('OP4', !has(ts, 'note', 2, HELP) && !has(ts, 'switch', 2, HELP), 'nor after a reload (the dismissal is in the Diamond\'s file, not the page)', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		// 19 more rated answers of the key: still held; the 20th frees it (the window is 20 answers, not for ever).
		await rated(page, { model: 'mock/fast', d: HELP, up: 0, down: 19, tagged: 19 });
		ts = await raise(page);
		opcheck('OP4', !has(ts, 'note', 2, HELP) && !has(ts, 'switch', 2, HELP), 'nor after 19 more rated answers', JSON.stringify(await cellOf(page, 2, HELP, 'fast')));
		await rated(page, { model: 'mock/fast', d: HELP, up: 0, down: 1, tagged: 1 });
		ts = await raise(page);
		opcheck('OP4', !!has(ts, 'note', 2, HELP) && !!has(ts, 'switch', 2, HELP), 'the 20th frees both (so the silence was the dismissal)', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));

		// Switch Back writes its own dismissal: Switch, 20 good answers on the model it went to, Switch Back, and that switch stays away.
		const C = await opctx('op4c');
		await standard(C.page);
		ts = await raise(C.page);
		const sw2 = has(ts, 'switch', 2, HELP, 'fast', 'thinker');
		if (!sw2) { opcheck('OP4', false, 'Switch Back: the switch tile to press was not raised', JSON.stringify(ts.map((t) => t.kind + ':' + t.level))); return; }
		await press(C.page, sw2.id, 'Switch');
		await rated(C.page, { model: 'mock/thinker', d: HELP, up: 20, down: 0, tagged: 0 });
		ts = await raise(C.page);
		const back = has(ts, 'back', 2, HELP);
		opcheck('OP4', !!back, 'Switch Back: 20 answers on the new model raise the review (Keep, Switch Back)', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		if (!back) return;
		await press(C.page, back.id, 'Switch Back');
		const mb = await modelOf(C.page, HELP), fb = await fileOf(C.page, HELP);
		opcheck('OP4', !!mb && /fast$/.test(mb.model) && / · dismissed · diamond · fast · switch /.test(fb), 'Switch Back returned the Diamond to mock/fast and wrote the dismissed entry', JSON.stringify(mb) + ' ' + JSON.stringify(fb.slice(-200)));
		ts = await raise(C.page);
		opcheck('OP4', !has(ts, 'switch', 2, HELP), 'that switch is not proposed again at once', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		await rated(C.page, { model: 'mock/fast', d: HELP, up: 0, down: 19, tagged: 0 });
		ts = await raise(C.page);
		opcheck('OP4', !has(ts, 'switch', 2, HELP), 'nor after 19 more rated answers on the model it came back to', JSON.stringify(await cellOf(C.page, 2, HELP, 'fast')));
		await rated(C.page, { model: 'mock/fast', d: HELP, up: 0, down: 1, tagged: 0 });
		ts = await raise(C.page);
		opcheck('OP4', !!has(ts, 'switch', 2, HELP, 'fast', 'thinker'), 'the 20th frees it', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));

		// A second device of the account: ratings and the Diamond's note file travel by sync.
		let pr = null;
		try {
			const gw = await fetch(GW_URL + '/api/health', { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
			if (!gw) { opcheck('OP4', false, 'the second device needs the live gateway (' + GW_URL + ' does not answer)'); return; }
			const mk = (what, pass, detail) => opcheck('OP4', pass, 'pair: ' + what, detail);
			pr = await pair(mk, 'oplead', 'opmate', { route: opBreakRoute() });
			OPCTX.push(pr.a, pr.b);
			const A = pr.a, Bd = pr.b;
			const sync = async (X, Y, k) => { for (let i = 0; i < k; i++) for (const [P, Q] of [[X, Y], [Y, X]]) {
				await P.page.evaluate(async () => { try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older */ } return window.DaimondSync.flush ? DaimondSync.flush() : DaimondSync.push(); }).catch(() => {});
				await opwait(500);
				await Q.page.evaluate(async () => { try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older */ } return DaimondSync.pull(); }).catch(() => {});
				await opwait(500); } };
			for (const X of [A, Bd]) { await X.page.evaluate(() => DaimondDiamond.seedDefaults()); }
			await standard(A.page);
			await sync(A, Bd, 3);
			const haveB = await opuntil(async () => (await Bd.page.evaluate(() => DaimondCore.chatStore().stored().filter((c) => /^opchat/.test(c.id)).length)) >= 2, 20000);
			const tb = await raise(Bd.page), ta = await raise(A.page);
			opcheck('OP4', haveB && !!has(tb, 'note', 2, HELP) && !!has(ta, 'note', 2, HELP), 'control: both devices hold the ratings and each raises the Diamond note', JSON.stringify([ta, tb].map((x) => x.map((t) => t.kind + ':' + t.level))));
			const an = has(ta, 'note', 2, HELP);
			if (an) await press(A.page, an.id, 'Dismiss');
			await sync(A, Bd, 3);
			await Bd.page.evaluate(() => (window.DaimondNotes && DaimondNotes.reload) ? DaimondNotes.reload(true) : null).catch(() => {});
			const fB = await fileOf(Bd.page, HELP), tb2 = await raise(Bd.page);
			opcheck('OP4', / · dismissed · diamond · fast · long /.test(fB), 'the dismissal reached the second device in the Diamond\'s file', JSON.stringify(fB.slice(0, 200)));
			opcheck('OP4', !has(tb2, 'note', 2, HELP), 'and the second device\'s tile is taken down and not raised again', JSON.stringify(tb2.map((t) => t.kind + ':' + t.level)));
		} catch (e) { opcheck('OP4', false, 'the second device ran to its end', String((e && e.message) || e)); }
	},

	OP5: async () => {
		const { page } = await opctx('op5');
		await standard(page);
		const before = await modelOf(page, HELP);
		// Count the writes to the Diamonds' model record (the page may shim localStorage per account: patch the object that owns setItem).
		await page.evaluate(() => { window.__sdm = []; const L = window.localStorage, own = Object.prototype.hasOwnProperty.call(L, 'setItem'), T = own ? L : Storage.prototype, o = T.setItem;
			T.setItem = function (k, v) { if (/daimond-diamond-models$/.test(String(k))) window.__sdm.push(String(v)); return o.apply(this, arguments); }; });
		const ts = await raise(page);
		const sw = has(ts, 'switch', 2, HELP, 'fast', 'thinker');
		opcheck('OP5', !!sw, 'control: a switch for Help from mock/fast to mock/thinker is proposed', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		if (!sw) return;
		await press(page, sw.id, 'Switch');
		const after = await modelOf(page, HELP), writes = await page.evaluate(() => window.__sdm.map((v) => { try { return JSON.parse(v); } catch (e) { return null; } }));
		opcheck('OP5', !!after && /thinker$/.test(after.model) && (!before || before.model !== after.model), 'Switch changed Help\'s model record from ' + JSON.stringify(before) + ' to mock/thinker', JSON.stringify(after));
		const last = writes.length ? writes[writes.length - 1] : null;
		opcheck('OP5', !!last && !!last[HELP] && /thinker$/.test(last[HELP].model) && Object.keys(last[HELP]).sort().join() === 'model,provider,visionModel,visionProvider,workerModel,workerProvider', 'through setDiamondModel: the record\'s one writer, with its whole shape', writes.length + ' write(s) seen; ' + JSON.stringify(last && last[HELP]));
		const f = await fileOf(page, HELP);
		opcheck('OP5', / · switched · diamond · fast /.test(f), 'the switch is on file for its review', JSON.stringify(f.slice(0, 200)));
		// The Diamond cog shows the model.
		await page.evaluate((id) => { const cog = document.querySelector(`#diamond-list .diamond-box[data-id="${id}"] .tile-cog`); if (cog) cog.click(); }, HELP);
		await page.waitForSelector('.tile-dlg-card select.tile-model', { state: 'attached', timeout: 8000 }).catch(() => {});
		const shown = await page.evaluate(() => { const s = document.querySelector('.tile-dlg-card select.tile-model'); const o = s && s.selectedOptions[0]; return o ? { text: o.textContent, value: o.value } : null; });
		opcheck('OP5', !!shown && /thinker/.test(shown.text + ' ' + shown.value), 'the Diamond cog\'s pulldown shows mock/thinker', JSON.stringify(shown));
	},
};

/// Run the sections asked for (`--only OP1,OP3`, else all); each opens its own devices and they are all closed at the end.
async function runProposals() {
	const want = ONLY.length ? ONLY : Object.keys(OPS);
	for (const k of want) {
		if (!OPS[k]) { check(false, 'no section called ' + k); continue; }
		try { await OPS[k](); }
		catch (e) { opcheck(k, false, 'the section ran to its end', String((e && e.message) || e)); }
		while (OPCTX.length) { const x = OPCTX.pop(); try { await x.close(); } catch (e) { /* closed */ } }
	}
	console.log('\n  OP tally: ' + Object.keys(OPBAD).map((k) => `${k} ${OPOK[k]} ok ${OPBAD[k]} bad`).join(', '));
}

if (OP_ONLY) {
	await runProposals();
	console.log(failures === 0 ? '\nverify_optimiser: all checks pass.' : `\nverify_optimiser: ${failures} check(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
}

const s = await open({ name: 'optimiser' + (BREAK ? '-' + BREAK : ''),
	signIn: false, connect: false, route: ROUTE,
	profile: scratch('pw', 'optimiser-' + process.pid) });
const { page: p } = s;

try {
	await signInAs(s, 'optimiser');
	await connectMock(s);
	await p.evaluate(() => DaimondDiamond.seedDefaults());
	await p.waitForFunction(() =>
		[...document.querySelectorAll('#diamond-list .session-box-name')]
			.some(n => /Daimond Optimiser/.test(n.textContent)), null, { timeout: 20000 })
		.catch(() => {});

	const ids = await p.evaluate(() => {
		const of = (re) => {
			const b = [...document.querySelectorAll('#diamond-list .diamond-box')]
				.find(x => re.test(x.textContent));
			return b ? b.dataset.id : '';
		};
		return { opt: of(/Daimond Optimiser/), help: of(/Daimond Help/) };
	});
	if (!ids.opt || !ids.help) die('this world did not seed the two default Diamonds');

	// ══ 1. The seed ═══════════════════════════════════════════════════
	const seed = await p.evaluate((id) => {
		const list = window.DaimondTriggersOf(id) || [];
		const ta = list[0] || null;
		return {
			n:    list.length,
			ta:   ta,
			held: ta ? !!DaimondPause.isPaused(DaimondTriggers.node(id, ta.id)) : null,
		};
	}, ids.opt);
	if (!seed.ta) die('the Optimiser was seeded with no triggered action at all');

	// The one thing notes2 asks for by name, and the one thing an owner must be
	// able to rely on: a Diamond that spends on a schedule does not start spending
	// until somebody says so. Stopped ON THE PAUSE TREE, which is the switch the
	// light throws -- and NOT in the record as well. `ready` honours a hand-edited
	// `on: false`, so a seed that wrote one beside the held leaf made two switches
	// of which the light could reach one: press play, the leaf is released, the
	// pulldown says ▶, and `allowed` refuses on the record for ever. That was the
	// Optimiser from the day it was made, and it is why check 1b exists.
	check(seed.ta.on !== false && seed.held === true,
		'the action ships STOPPED on the pause tree, and the record carries no second switch',
		'on=' + seed.ta.on + ' held=' + seed.held);

	// THE SHAPE IS THE INSTRUCTION'S, and this is why. The first line of the reply
	// becomes a headline on a tile and the rest becomes the evidence under it, so a
	// turn told only "say what would help" produces prose that has to be guessed
	// at. Asserted as three separate demands rather than as one string, so a
	// rewording that keeps the demands stays green.
	const ins = String(seed.ta.instruction || '');
	check(/title line/i.test(ins) && /evidence/i.test(ins) && /number/i.test(ins),
		'it asks for ONE finding as a title line, then the evidence, citing the number',
		ins.slice(0, 90) + '…');
	check(/nothing stands out/i.test(ins),
		'and offers the one-line refusal, because a quiet week needs no findings');
	check(/never the reaction/i.test(ins) && /not dispatch workers/i.test(ins),
		'and names the two things it gets wrong untold: the reaction, and a fan-out');

	// Leave to run off screen is asked for per ACTION. Without it this Diamond can
	// only ever fire while somebody is looking at it, which is never.
	check(seed.ta.offScreen === true,
		'the action has leave to run while nobody is looking at the Diamond',
		'offScreen=' + seed.ta.offScreen);

	// ══ 1b. One press of play is enough ═══════════════════════════════
	//
	// From the app's own controls: `+` in the Optimiser's settings makes an
	// action, ▶ on the light beside the pulldown starts it, and `allowed` -- the
	// whole of the decision, `ready(t) && !paused(leaf)` -- must then say yes.
	// The action is given an instruction first, through the record door, because
	// `ready` refuses one with nothing to say and that refusal is not the one
	// under test; with words in it the light is a real light rather than the red
	// of "nothing set up". Under `twoswitches` the leaf is released, the light
	// goes green, and the record still says no.
	//
	// The pulldown's own option text is NOT read here: it is drawn by `draw()`
	// and nothing redraws an open dialog on a pause event, so it says what the
	// action was when the dialog opened. That is a staleness of the dialog's,
	// not of the switch, and it is not what this cell is about.
	await p.evaluate((id) => {
		document.querySelector(`#diamond-list .diamond-box[data-id="${id}"] .tile-cog`).click();
	}, ids.opt);
	// BEHIND THE DISCLOSURE SINCE CRY-15: the triggered actions moved into the
	// dialog's Advanced fold, which ships closed, so the controls are attached
	// and not VISIBLE -- and `waitForSelector` waits for visible. Opened the way
	// a reader opens it, rather than waited for with `state: 'attached'`, which
	// would go on passing after the fold stopped opening.
	await p.evaluate(() => {
		const d = document.querySelector('.tile-dlg-card details.tile-dlg-adv');
		if (d) d.open = true;
	});
	await p.waitForSelector('.tile-dlg-card .trig-add select', { timeout: 8000 });
	const born = await p.evaluate(async (id) => {
		const T = window.DaimondTriggers;
		const of = () => window.DaimondTriggersOf(id) || [];
		const before = of().map(t => t.id);
		document.querySelector('.tile-dlg-card .trig-add select').value = 'activity';
		document.querySelector('.tile-dlg-card .trig-add button').click();
		for (let i = 0; i < 40 && of().length === before.length; i++) {
			await new Promise(r => setTimeout(r, 100));
		}
		let ta = of().find(t => before.indexOf(t.id) === -1);
		if (!ta) return { made: false };
		// Words, so `ready` has nothing to refuse but the switch.
		ta.instruction = 'SOMETHING TO SAY';
		await DaimondCore.triggerSet(id, ta);
		ta = of().find(t => t.id === ta.id);
		const light = () => (document.querySelector('.tile-dlg-card .trig-pick .pptw') || {}).dataset.state;
		const held = { light: light(), allowed: T.allowed(id, ta), on: ta.on };
		// THE PRESS, on the button the user sees.
		const play = document.querySelector('.tile-dlg-card .trig-pick .pptw .pptw-play');
		if (play) play.click();
		await new Promise(r => setTimeout(r, 200));
		ta = of().find(t => t.id === ta.id);
		const started = { light: light(), allowed: T.allowed(id, ta), on: ta.on };
		// Tidy: the ✕ beside the pulldown, which asks about an action with words in
		// it, and the confirm's own OK -- not the tile dialog's Delete, which is a
		// `.dlg-ok` too.
		const x = [...document.querySelectorAll('.tile-dlg-card .trig-pick .trig-btn')].pop();
		if (x) x.click();
		await new Promise(r => setTimeout(r, 300));
		const ok = [...document.querySelectorAll('.modal.dlg:not(.tile-dlg) .dlg-ok')].pop();
		if (ok) ok.click();
		for (let i = 0; i < 20 && of().some(t => t.id === ta.id); i++) {
			await new Promise(r => setTimeout(r, 100));
		}
		return { made: true, held, started, gone: !of().some(t => t.id === ta.id), n: of().length };
	}, ids.opt);
	await p.evaluate(() => { const d = document.querySelector('.tile-dlg-done'); if (d) d.click(); });
	await p.waitForTimeout(300);
	if (!born.made) die('`+` in the Optimiser\'s settings made no action');
	check(born.held.light === 'pause' && born.held.allowed === false,
		'an action made with `+` arrives held: red light, and refused even with words to say',
		'light=' + born.held.light + ' allowed=' + born.held.allowed + ' on=' + born.held.on);
	check(born.started.light === 'play' && born.started.allowed === true,
		'and one press of ▶ on its light is the whole of starting it — green, and `allowed` says yes',
		'light=' + born.started.light + ' allowed=' + born.started.allowed + ' on=' + born.started.on);
	check(born.gone && born.n === 1,
		'and ✕ takes it away again, leaving the Optimiser its one timer',
		'gone=' + born.gone + ' actions=' + born.n);

	// ══ 2. The signal reaches the digest ══════════════════════════════
	//
	// Six refusals in eight calls is over the 25% floor `findings` draws the line
	// at, and five calls is its other floor -- so this is the smallest honest
	// signal that must produce a finding. The message text is the most provocative
	// input the module takes, because check 2b is about what the digest does NOT
	// say when it has every excuse.
	const digest = await p.evaluate(async (id) => {
		DaimondSignals.reset();
		for (let i = 0; i < 8; i++) DaimondSignals.noteTool('web_fetch', i >= 6);
		for (let i = 0; i < 6; i++) {
			DaimondSignals.noteTurn({ ts: Date.now(), diamondId: id, model: 'mock/fast', usd: 0.01 });
			DaimondSignals.noteUserMessage({ diamondId: id,
				text: 'WHAT?! that is wrong AGAIN, as i already told you',
				prevModel: 'mock/fast', prevTools: ['web_fetch'] });
		}
		await DaimondDiamond.usageDigest();
		const W = await import('/pkg/oxedyne_daimond.js');
		try { return await W.store_read('system/usage/digest.md'); } catch (e) { return ''; }
	}, ids.opt);
	check(digest.indexOf(FINDING) >= 0,
		'the digest carries the finding the signal produced, with its number in it',
		(digest.split('\n').find(l => /web_fetch refused/.test(l)) || '(absent)').trim());
	check(!MOOD.test(digest),
		'and never names the reader’s state of mind, however it was provoked',
		(digest.match(MOOD) || ['clean'])[0]);
	check(/never actions anything/i.test(digest),
		'and says out loud that it never acts on any of this — the reader does');

	// ══ 3. The firing, with the user somewhere else ═══════════════════
	//
	// Help is put on screen first, so every assertion below is about a Diamond the
	// user is NOT looking at. That is the case the whole feature turns on.
	await p.evaluate((id) => {
		document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`).click();
	}, ids.help);
	await p.waitForTimeout(700);

	/// Arm the Optimiser's action with one instruction and run the clock past it.
	///
	/// The instruction is what the mock provider reads, so it is also how this file
	/// dictates what the Optimiser "finds". Returns where the mock's log stood
	/// BEFORE the firing, so every question about what was sent is asked of this
	/// firing rather than of the world's whole history.
	const fire = async (says) => {
		const seen = mockLog().length;
		await p.evaluate(async (a) => {
			const T = window.DaimondTriggers;
			const ta = (window.DaimondTriggersOf(a.id) || [])[0];
			// The instruction is written and the two leaves are released, and that
			// is all: the release is what the light does, and since 2026-09-15 it
			// is enough. This used to write `ta.on = true` as well, standing in for
			// a control the app had not got -- see check 1b, which now presses the
			// control.
			ta.instruction = a.says;
			await DaimondCore.triggerSet(a.id, ta);
			DaimondPause.set(T.node(a.id, ta.id), true);
			DaimondPause.set(DaimondPause.id('root', 'diamonds', a.id, 'self'), true);
		}, { id: ids.opt, says });
		// Thirty-one minutes of ACTIVITY, a minute at a time. The tick is awaited,
		// so this returns only once the turn it started has finished -- there is
		// nothing to poll for and nothing to race.
		await p.evaluate(async () => {
			for (let m = 0; m < 31; m++) {
				window.DaimondTriggers.noteActivity();
				await window.DaimondTriggerTick();
			}
		});
		await p.waitForTimeout(400);
		return seen;
	};

	// The daimon READS THE DIGEST OFF DISK, through the read-only grant on
	// `system/usage`, and what it read comes back to the model on the next
	// request. Nothing here puts the digest in front of the model by hand: that
	// would test this file rather than the grant.
	let from = await fire('@tool file_read {"path":"system/usage/digest.md"}');
	const sent = mockLog().slice(from);
	const carried = sent.filter(r => JSON.stringify(r).includes(FINDING)).length;
	check(carried === 1,
		'the timer ran a turn off screen and the model was sent the digest, once',
		carried + ' of ' + sent.length + ' request(s) carried the finding');

	const after = await p.evaluate(() => (DaimondDiamond.current() || {}).id || '');
	check(after === ids.help,
		'and the screen did not move — the user is still where they were',
		after === ids.help ? 'still on Daimond Help' : 'moved to ' + after);

	const landed = await p.evaluate((a) => {
		const rec = DaimondDiamond.conversation(a.opt) || { messages: [] };
		const other = DaimondDiamond.conversation(a.help) || { messages: [] };
		return { mine: rec.messages.length, theirs: other.messages.length };
	}, ids);
	check(landed.mine > 0 && landed.theirs === 0,
		'and the turn is written into the OPTIMISER’s conversation, not the one on screen',
		landed.mine + ' message(s) there, ' + landed.theirs + ' in Help’s');

	// That firing's own answer was 'Tool done.', which is a finding as far as this
	// side can tell -- one line, and it does not say nothing stands out. Cleared,
	// so the counts below are about the answer this file dictates.
	await p.evaluate(() => DaimondPendingView.items().forEach(i => DaimondPendingView.drop(i.id)));

	// ══ 4. The tile ═══════════════════════════════════════════════════
	const HEAD = 'web_fetch is being asked for pages it cannot fetch';
	const BODY = 'The digest shows ' + FINDING + ', which is 75% of them.';
	from = await fire('@text ' + HEAD + '\n' + BODY);
	const tiles = await p.evaluate(() => DaimondPendingView.items());
	const props = tiles.filter(x => x.kind === 'proposal');
	check(props.length === 1,
		'a two-line answer becomes ONE proposal on the Pending panel',
		props.length + ' proposal(s), ' + tiles.length + ' tile(s) in all');
	const tile = props[0] || {};
	check(tile.headline === HEAD,
		'its headline is the answer’s title line, whole and unedited', tile.headline || '(none)');
	check(String(tile.detail || '').indexOf(FINDING) >= 0,
		'and the evidence beneath it still carries the digest’s number',
		String(tile.detail || '').slice(0, 80) || '(none)');
	check(!!tile.headline && !MOOD.test(String(tile.headline) + String(tile.detail)),
		'and nothing on it names anybody’s state of mind',
		(String(tile.headline + ' ' + tile.detail).match(MOOD) || ['clean'])[0]);
	check(tile.diamondId === ids.opt && /Optimiser/.test(String(tile.diamondName || '')),
		'and the tile says which Diamond found it', tile.diamondName || '(unnamed)');
	await shot(s, 'proposal-tile');

	// A QUIET WEEK NEEDS NO FINDINGS. The instruction offers a one-line refusal
	// and the producer has to honour it, or the panel fills up with the Optimiser
	// reporting that it has nothing to report.
	await p.evaluate(() => DaimondPendingView.items().forEach(i => DaimondPendingView.drop(i.id)));
	await fire('@text Nothing stands out this week.');
	const quiet = await p.evaluate(() => DaimondPendingView.items().length);
	check(quiet === 0,
		'a one-line “nothing stands out” raises nothing at all', quiet + ' tile(s)');

	// UNDER THE AUTONOMOUS POSTURE nobody watched the turn, so nothing it said is
	// a proposal put to anybody. It is also the posture under which a publication
	// would go out with no dialog, which is the next section.
	await p.evaluate(() => { localStorage.setItem('daimond-autonomous-posture', '1'); });
	await fire('@text Something else entirely\nWith evidence under it.');
	const unattended = await p.evaluate(() => DaimondPendingView.items().length);
	check(unattended === 0,
		'and a turn run under the autonomous posture raises nothing either',
		unattended + ' tile(s)');
	await p.evaluate(() => { localStorage.removeItem('daimond-autonomous-posture'); });

	// ══ 5. The three answers ══════════════════════════════════════════
	// The panel is emptied first, so the tile answered below is the one this arm
	// raised rather than whatever a previous arm happened to leave standing.
	await p.evaluate(() => DaimondPendingView.items().forEach(i => DaimondPendingView.drop(i.id)));
	from = await fire('@text ' + HEAD + '\n' + BODY);
	const got = await p.evaluate(() => (DaimondPendingView.items()
		.filter(x => x.kind === 'proposal')[0] || {}).id || '');
	// NO `die` HERE, and that is deliberate: a break that stops the tile being
	// raised at all must redden the two checks below rather than take the run off
	// the air before they are reached. A check that is never reported is a check
	// nobody can see go red.
	let back = [], where = '';
	if (got) {
		const before = mockLog().length;
		await p.evaluate((id) => {
			const box = [...document.querySelectorAll('#pending-list .pend-card')]
				.find(b => b.dataset.id === id);
			box.querySelector('.pend-go').click();
		}, got);
		await p.waitForFunction(() => !window.DaimondPendingView.items().length, null, { timeout: 30000 })
			.catch(() => {});
		await p.waitForTimeout(1500);
		back = mockLog().slice(before);
		where = await p.evaluate(() => (DaimondDiamond.current() || {}).id || '');
	}
	check(got && back.some(r => JSON.stringify(r).includes('Do it: ' + HEAD)),
		'the tick sends the finding back to its Diamond as an instruction to carry out',
		got ? back.length + ' request(s) after the tick' : 'no tile was raised to answer');
	check(got && where === ids.opt,
		'and it lands in that Diamond’s own chat, which is where its evidence is',
		got ? (where === ids.opt ? 'the Optimiser' : where) : 'no tile was raised to answer');

	await p.evaluate(() => { DaimondPanels.show('pending'); });
	await p.evaluate(() => DaimondPendingView.items().forEach(i => DaimondPendingView.drop(i.id)));
	from = await fire('@text ' + HEAD + '\n' + BODY);
	const dropId = await p.evaluate(() => (DaimondPendingView.items()
		.filter(x => x.kind === 'proposal')[0] || {}).id || '');
	if (dropId) {
		await p.evaluate((id) => {
			const box = [...document.querySelectorAll('#pending-list .pend-card')]
				.find(b => b.dataset.id === id);
			box.querySelector('.pend-no').click();
		}, dropId);
		await p.waitForTimeout(500);
	}
	const left = await p.evaluate(() => DaimondPendingView.items().length);
	check(!!dropId && left === 0, 'and the cross takes it off the panel and does nothing else',
		dropId ? left + ' tile(s) left' : 'no tile was raised to drop');

	// ══ 6. What this Diamond may not do ═══════════════════════════════
	//
	// The belt is per ROLE: the engine is never told which Diamond is steering, so
	// no tool can be taken out of one Diamond's schema from this side. What IS
	// per Diamond is the door each act leaves through, and that is where the
	// withholding sits -- so this asks the doors, which is the only honest place
	// to ask. `publishWithheld` reads the turns in flight, so the question has to
	// be put WHILE the Optimiser is mid-turn: that is what a timer produces and it
	// is the only state in which the withholding means anything.
	const pub = await p.evaluate(async (a) => {
		const out = {};
		out.optQuiet = DaimondDiamond.mayPublish(a.opt);
		out.helpQuiet = DaimondDiamond.mayPublish(a.help);
		// Mid-turn, and the posture ON -- the one combination that used to publish
		// in somebody's name with nothing drawn on any screen.
		localStorage.setItem('daimond-autonomous-posture', '1');
		const ta = (window.DaimondTriggersOf(a.opt) || [])[0];
		ta.on = true;
		ta.instruction = '@slow 4000 PUBLISH-WINDOW';
		await DaimondCore.triggerSet(a.opt, ta);
		DaimondPause.set(DaimondTriggers.node(a.opt, ta.id), true);
		const running = (async () => {
			for (let m = 0; m < 31; m++) {
				window.DaimondTriggers.noteActivity();
				await window.DaimondTriggerTick();
			}
		})();
		// Ask while it is in flight. The turn is a four-second one, so this lands
		// inside it; `_busy` is the app's own word for "a turn is running here".
		let asked = null, guard = '';
		for (let i = 0; i < 60 && asked === null; i++) {
			await new Promise(r => setTimeout(r, 100));
			const rec = DaimondDiamond.conversation(a.opt);
			if (!rec || !rec._generating) continue;
			guard = String(window.DaimondPublishGuard() || '');
			asked = await window.__daimondEgressAllowed(
				JSON.stringify({ tool: 'social_send', url: 'A NEW PROPOSAL', alone: true }));
		}
		await running;
		localStorage.removeItem('daimond-autonomous-posture');
		out.verdict = asked;
		out.guard = guard;
		out.afterwards = String(window.DaimondPublishGuard() || '');
		return out;
	}, ids);
	// WIDENED 2026-09-15, and the sentence is the finding: this was withheld from the Optimiser
	// alone, on the ground that the Optimiser is the Diamond nobody is watching. Then the
	// owner's own Daimond-dev daimon -- a Diamond he was talking to -- called `social_send` with
	// a comment on the forge in his name, and the dialog sat on a tab he was not looking at. No
	// daimon publishes now; see `diamondMayPublish` in www/js/daimond.js.
	check(pub.optQuiet === false && pub.helpQuiet === false,
		'publishing is withheld from every Diamond\'s daimon, this one included',
		'optimiser=' + pub.optQuiet + ' help=' + pub.helpQuiet);
	check(pub.verdict === 'deny',
		'and the egress door denies its publication even under the autonomous posture',
		String(pub.verdict));
	check(/does not publish in the user's name/i.test(pub.guard)
			&& /I would post/i.test(pub.guard) && pub.afterwards === '',
		'the Social panel is told why AND what to do instead, and only while a daimon runs',
		JSON.stringify(pub.guard.slice(0, 60)) + ' / after: ' + JSON.stringify(pub.afterwards));

	const caps = await p.evaluate((a) => ({
		opt:  DaimondDiamond.workerCap(a.opt),
		help: DaimondDiamond.workerCap(a.help),
	}), ids);
	check(caps.opt === 0 && caps.help === Infinity,
		'and its worker cap is zero, where every other Diamond’s is what it always was',
		'optimiser=' + caps.opt + ' help=' + caps.help);

	// ══ 7. Every other action is refused exactly as before ════════════
	//
	// `verify_triggers` check 8 turns on this: a timer that is refused keeps the
	// minutes it accrued. The refusal has to still HAPPEN for an action that has
	// not asked to run off screen, or that check is measuring nothing -- so it is
	// asserted here too, where the change was made.
	const plain = await p.evaluate(async (a) => {
		const T = window.DaimondTriggers;
		const ta = T.blank('activity');
		ta.id = 'plain-' + Date.now().toString(36);
		ta.minutes = 3;
		ta.instruction = '@text PLAIN-ACTION-SHOULD-NOT-FIRE';
		await DaimondCore.triggerSet(a.help, ta);
		DaimondPause.set(T.node(a.help, ta.id), true);
		return { id: ta.id, offScreen: ta.offScreen };
	}, ids);
	// Someone else on screen, so Help is the one that is not being looked at.
	await p.evaluate((id) => {
		document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`).click();
	}, ids.opt);
	await p.waitForTimeout(700);
	const watch = mockLog().length;
	const kept = await p.evaluate(async (a) => {
		for (let m = 0; m < 6; m++) {
			window.DaimondTriggers.noteActivity();
			await window.DaimondTriggerTick();
		}
		return window.DaimondTriggers.activityMinutes(a.help, a.ta);
	}, { help: ids.help, ta: plain.id });
	const spoke = mockLog().slice(watch)
		.some(r => JSON.stringify(r).includes('PLAIN-ACTION-SHOULD-NOT-FIRE'));
	check(!spoke && kept >= 3,
		'an action that did NOT ask is still refused off screen, and keeps its minutes',
		(spoke ? 'it fired anyway' : 'refused') + ', ' + kept.toFixed(1) + ' minutes held');
} catch (e) {
	check(false, 'the run finished without throwing', String((e && e.message) || e));
	try { await shot(s, 'threw'); } catch (x) { /* the shot is a nicety */ }
} finally {
	await s.close();
}
await runProposals();

console.log(failures === 0
	? '\nverify_optimiser: all checks pass.'
	: `\nverify_optimiser: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

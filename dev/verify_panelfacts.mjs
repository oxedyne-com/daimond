// verify_panelfacts.mjs — a panel that states a fact must state the true one.
//
// Three defects of one shape, found by the reachability audit of 2026-08-12. In
// each, a panel keeps drawing something that stopped being true, and nothing on
// screen says so:
//
//   1. THE RAIL'S TOOLS COUNT FROZE. `DaimondAdmin.status()` returned early when
//      the money rows drew — `if (!locked && moneyRows(st, arow)) return;` — and
//      `proRow()`, `tools()` and `storage()` all sit after that return. So any
//      account the money rows could draw for, which is every account with a
//      balance or a provider key, saw a Tools count, a Pro row and a storage
//      figure frozen at whatever they were the first time the panel drew.
//      Asserted as: the rail's number FOLLOWS what the panel is asked. Not "the
//      number is 6" — a frozen number can be 6.
//
//   2. AGENT HISTORY CAPPED AT TWELVE, SILENTLY. `runs.slice(0, 12)`, with the
//      newest first, so the thirteenth-oldest run vanished on every reload with
//      no count and no note, in the panel whose whole job is to say what ran.
//      Asserted by NAME: the thirteenth-newest run is still there afterwards.
//
//   3. THE TILE'S CONTROLS WERE HARDCODED ENGLISH. `'Pause'`, `'Stop'`,
//      `'Resume'`, the run/paused/queued tally and the status word, all written
//      raw. `dev/i18ncheck.mjs` cannot see this class at all: it compares key
//      SETS between locale files, so a string that was never given a key is
//      invisible to it by construction. Asserted by SWITCHING LANGUAGE and
//      watching the controls move — a check that read the English would pass
//      against the hardcoded build, which is the whole trap.
//
//   node dev/verify_panelfacts.mjs --break staleafter  # 1 fails: the early return
//   node dev/verify_panelfacts.mjs --break cap12       # 2 fails: twelve runs kept
//   node dev/verify_panelfacts.mjs --break silentcut   # 2's note fails: the cut
//                                                      # happens and nothing says so
//   node dev/verify_panelfacts.mjs --break hardeng     # 3 fails: English controls
//   node dev/verify_panelfacts.mjs                     # and then, clean
//
//   eval "$(bash dev/world.sh 5 --up)"
//   node dev/verify_panelfacts.mjs
//
// Needs dev/serve.mjs and dev/mockllm.mjs. No gateway, no IMAP.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch, shot, chat } from './harness.mjs';

const WWW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const BREAKS = {
	// The early return, verbatim as it stood.
	staleafter: [{
		file: 'js/daimond.js',
		find: '\t\t\tif (!locked && moneyRows(st, arow)) { proRow(); tools(); storage(); return; }',
		with: '\t\t\tif (!locked && moneyRows(st, arow)) return;',
	}],
	// Twelve runs, as before.
	cap12: [{ file: 'js/daimond.js', find: '\t\tKEEP: 200,', with: '\t\tKEEP: 12,' }],
	// The cut still happens; the panel simply does not mention it.
	silentcut: [{
		file: 'js/daimond.js',
		find: '\t\t\tif (this.dropped > 0) {',
		with: '\t\t\tif (false) {',
	}],
	// The tile's controls as they were written: English literals, whatever the
	// app is set to.
	hardeng: [{
		file: 'js/daimond.js',
		find: '\t\t\t\tacts.appendChild(actBtn(\'pause\', t(\'agents.act_pause\'), t(\'agents.act_pause_help\'),\n'
			+ '\t\t\t\t\tfunction () { self.pause(run); }));\n'
			+ '\t\t\t\tacts.appendChild(actBtn(\'cross\', t(\'agents.act_stop\'), t(\'agents.act_stop_help\'),\n'
			+ '\t\t\t\t\tfunction () { self.stop(run); }));',
		with: '\t\t\t\tacts.appendChild(actBtn(\'pause\', \'Pause\', \'Hang up this agent, keeping its work so far; resume it later.\', function () { self.pause(run); }));\n'
			+ '\t\t\t\tacts.appendChild(actBtn(\'cross\', \'Stop\', \'Stop this agent for good. It keeps whatever it managed to do.\', function () { self.stop(run); }));',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

function damaged(spec) {
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}.`);
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

const routeBreaks = async (pg) => {
	if (!BREAK) return;
	for (const spec of BREAKS[BREAK]) {
		const body = damaged(spec);
		await pg.route('**/' + spec.file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PROFILE = scratch('pw', 'panelfacts' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

// `connect: true` puts a provider on the account, which is what makes the money
// rows draw and therefore what arms defect 1. Without it the early return is
// never taken and check 1 would pass against the broken build.
const s = await open({ name: 'panelfacts', profile: PROFILE, signIn: true, connect: true,
	route: routeBreaks });
const p = s.page;
await p.waitForFunction(() => !!window.DaimondAdmin && !!window.DaimondWorkers,
	null, { timeout: 20000 }).catch(() => {});
await sleep(1200);

try {
	// ══ 0. Arm the state the defect needs ═════════════════════════════
	//
	// The money rows draw only when there is something TRUE to say about a pot,
	// and a fresh account with no gateway and no spend has nothing. So one real
	// turn is run through the mock provider: that puts spend against a key in the
	// ledger, which is the commonest BYOK case there is and exactly the account
	// the audit describes. Without it the early return is never taken and check 1
	// below would pass against the broken build — which it did, measured, before
	// this section existed.
	await chat(s, 'hello').catch(() => {});
	await sleep(1200);

	// ══ 1. The rail's Tools count follows what it is told ══════════════
	//
	// `DaimondTools.counts()` is the source of truth and is replaced here for the
	// length of the check. That is the right thing to fake: the property is that
	// the rail ASKS AGAIN and repaints, so the oracle has to be something that
	// can change.
	const rail = await p.evaluate(async () => {
		const out = { drew: '', first: '', second: '' };
		const real = window.DaimondTools.counts;
		const readRow = () => (document.getElementById('astat-tools') || {}).textContent || '';
		try {
			window.DaimondTools.counts = () => ({ have: 3, all: 9 });
			window.DaimondAdmin.status();
			await new Promise((r) => setTimeout(r, 400));
			out.first = readRow();
			window.DaimondTools.counts = () => ({ have: 7, all: 9 });
			window.DaimondAdmin.status();
			await new Promise((r) => setTimeout(r, 400));
			out.second = readRow();
		} finally { window.DaimondTools.counts = real; }
		// The precondition, measured rather than assumed: the money rows drew, so
		// the early return was actually reached. A row still offering the account
		// fallbacks means they did not.
		const acct = (document.getElementById('astat-account') || {}).textContent || '';
		out.drew = acct;
		// The account row's FALLBACK wordings, which are what it says when the
		// money rows drew nothing. Any of them means the early return was never
		// reached, and every check below it would be vacuous.
		out.moneyDrew = !/no account|offline|unavailable|unreachable|locked|not signed/i.test(acct)
			&& acct.trim().length > 0;
		return out;
	});
	check('the money rows draw for this account, so the return that skipped the rest is reached',
		rail.moneyDrew, 'account row reads: ' + rail.drew.trim().slice(0, 70));
	check('the rail\'s Tools count follows what the panel is asked, rather than freezing',
		/\b3\b/.test(rail.first) && /\b7\b/.test(rail.second),
		'first "' + rail.first.trim() + '", then "' + rail.second.trim() + '"');

	// ══ 2. Agent history is not silently cut ═══════════════════════════
	//
	// Two hundred and sixty runs, named, so what survives can be asked about by
	// NAME. `w13` is the thirteenth-newest and is exactly what the old cap threw
	// away.
	const kept = await p.evaluate(async () => {
		const W = window.DaimondWorkers;
		W.runs = [];
		for (let i = 1; i <= 260; i++) {
			W.runs.push({ id: 'w' + i, name: 'agent-' + i, task: 'task ' + i,
				diamondId: '', diamondName: '', chatId: '', chatName: '',
				model: 'mock/fast', provider: 'mock', status: 'done', text: '', tools: [],
				sees: false, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0 });
		}
		W.persist();
		let raw = null;
		try { raw = JSON.parse(localStorage.getItem('daimond-workers')); } catch (e) { raw = null; }
		const list = Array.isArray(raw) ? raw : ((raw && raw.runs) || []);
		return {
			n: list.length,
			has13: list.some((r) => r.id === 'w13'),
			has200: list.some((r) => r.id === 'w200'),
			dropped: (raw && !Array.isArray(raw)) ? raw.dropped : null,
			live: W.dropped,
		};
	});
	check('the thirteenth-newest run survives a write, where it used to be thrown away',
		kept.has13, kept.has13 ? kept.n + ' runs kept' : 'w13 is gone; ' + kept.n + ' kept');
	check('and the two-hundredth does too', kept.has200, kept.n + ' runs kept');
	check('what did not fit is counted rather than forgotten',
		kept.dropped === 60 && kept.live === 60,
		'stored dropped=' + kept.dropped + ', in memory=' + kept.live);

	const note = await p.evaluate(async () => {
		window.DaimondPanels.show('agents');
		window.DaimondWorkers.render();
		await new Promise((r) => setTimeout(r, 400));
		const el = document.querySelector('#agents-list .agents-dropped');
		return { text: el ? (el.textContent || '') : '',
			says: el ? window.DaimondI18n.tn('agents.dropped', 60) : '' };
	});
	check('and the panel says what it is not showing, in words and with the number',
		!!note.text && /60/.test(note.text) && note.text === note.says,
		note.text ? note.text : 'no line at the foot of the list');

	// ══ 3. The tile's controls are in the reader's language ════════════
	//
	// Asserted by MOVEMENT. Reading the English and comparing it to the English
	// catalogue would pass against a hardcoded build, since the two agree by
	// construction; what a hardcoded string cannot do is change when the language
	// does.
	const readTile = () => p.evaluate(() => {
		const btns = [...document.querySelectorAll('#agents-list .acard .aacts .abtn')];
		return {
			labels: btns.map((b) => b.textContent.trim()),
			titles: btns.map((b) => b.title),
			pill:   (document.querySelector('#agents-list .acard .pill') || {}).textContent || '',
			tally:  (document.getElementById('agents-stat') || {}).textContent || '',
			live:   (document.getElementById('agents-count') || {}).textContent || '',
			says:   {
				stop:  window.DaimondI18n.t('agents.act_stop'),
				help:  window.DaimondI18n.t('agents.act_pause_help'),
				run:   window.DaimondI18n.t('agents.status_running'),
				tally: window.DaimondI18n.t('agents.tally_running', { n: 1 }),
			},
		};
	});
	await p.evaluate(async () => {
		const W = window.DaimondWorkers;
		W.runs = [{ id: 'wx1', name: 'agent-live', task: 'a running task',
			diamondId: '', diamondName: '', chatId: '', chatName: '',
			model: 'mock/fast', provider: 'mock', status: 'running', text: '', tools: [],
			sees: false, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0 }];
		W.dropped = 0;
		W.render();
		await new Promise((r) => setTimeout(r, 300));
	});
	const en = await readTile();
	check('a running agent has its two controls on screen', en.labels.length === 2,
		JSON.stringify(en.labels));

	const loaded = await p.evaluate((c) => window.DaimondI18n.setLocale(c), 'de');
	await p.evaluate(async () => {
		window.DaimondWorkers.render();
		await new Promise((r) => setTimeout(r, 300));
	});
	const de = await readTile();
	await p.evaluate((c) => window.DaimondI18n.setLocale(c), 'en');
	check('German loads', loaded === true, String(loaded));
	check('the tile\'s Stop control follows the catalogue when the language changes',
		de.labels.some((l) => l.indexOf(de.says.stop) >= 0) && de.says.stop !== en.says.stop
			&& !de.labels.some((l) => /Stop$/.test(l)),
		'English ' + JSON.stringify(en.labels) + ' → German ' + JSON.stringify(de.labels));
	check('and so does the help a reader hovers for',
		de.titles.some((x) => x === de.says.help) && de.says.help !== en.says.help,
		JSON.stringify(de.titles).slice(0, 110));
	check('and the state word on the tile, which is the one label everybody reads',
		de.pill === de.says.run && de.says.run !== en.says.run,
		'"' + en.pill + '" → "' + de.pill + '"');
	check('and the running/paused/queued tally above the list',
		de.tally === de.says.tally && de.says.tally !== en.says.tally,
		'"' + en.tally + '" → "' + de.tally + '"');
	check('and the live count in the panel\'s heading',
		de.live !== en.live && de.live.length > 0,
		'"' + en.live + '" → "' + de.live + '"');

	await shot(s, 'panelfacts');
} catch (e) {
	check('the run finished', false, String(e && e.message || e));
} finally {
	await s.close();
}

console.log(bad.length === 0
	? `\nverify_panelfacts: all ${ok.length} checks pass.`
	: `\nverify_panelfacts: ${bad.length} of ${ok.length + bad.length} failed:\n  ` + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);

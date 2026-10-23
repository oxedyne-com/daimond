// gateway: live
// verify_runnersaid.mjs — a handed-off turn that ends on the wanting question tells the
// sender, through the transcript, which device it needs (UNBLOCK-32 F4b, QA_F4 MED-3).
//
// A (WebKit, an iPhone at 390x845) hands a turn to B (Chromium desktop, the runner). B has no
// machine hand, so `run` is offered only as its stub; the mock makes the model call it, and the
// engine ends the turn Blocked on its one question. Before F4b that sentence said "this device",
// which on A named the wrong one. Now:
//
//   (1) A's transcript carries the sentence soon after the send;
//   (2) the sentence names B ("on <B's name>"), never "this device".
//
// The transcript is the delivery: a lease blocker would be released before A's next pull.
// Where B cannot reach the Diamond's folder at all, the switch no longer offers B (F4c, HT2).
// `--break nolabel` serves daimond.js without the runner's name, as 5c59dde21 shipped: (2) must
// go red.
//
//   node dev/verify_runnersaid.mjs
//   node dev/verify_runnersaid.mjs --break nolabel
import { checker, pair, send, until, freshChat } from './handoffpair.mjs';
import { mockLog, shot } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	// RUNSAID_BREAK for a run under `dk arms`, which passes no arguments.
	return i > 0 ? String(process.argv[i + 1] || '') : String(process.env.RUNSAID_BREAK || '');
})();
const BREAKS = {
	// The engine is never told the runner's name, so the sentence cannot name it.
	nolabel: [{
		file: 'js/daimond.js',
		find: "\t\t\t\t\t\tWasm.set_device_label(deviceNameFor(selfDeviceId()));\n",
		with: '',
	}],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}
function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		let src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		const n = src.split(spec.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': anchor appears ${n} times in ${spec.file}; fix the anchor`);
			process.exit(2);
		}
		src = src.replace(spec.find, () => spec.with);
		byFile.set(spec.file, src);
	}
	return byFile;
}
const route = BREAK ? async (page) => {
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body }));
	}
} : null;

const { ok, bad, check, finish } = checker();
let a, b;
try {
	({ a, b } = await pair(check, 'runsaid_' + Date.now().toString(36), 'runsaidmate', {
		route,
		openA: { browser: 'webkit', ua: IPHONE, touch: true },
		openB: { browser: 'chromium' },
	}));
	await b.page.setViewportSize({ width: 1500, height: 950 });
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
	await freshChat(a);
	await send(a.page, '@tools run {"argv":["ls"]}');
	await a.page.setViewportSize({ width: 390, height: 845 });

	// The sentence as A's transcript draws it.
	const seen = { label: '', at: 0 };
	const t0 = Date.now();
	const saidOn = (pg) => pg.evaluate(() => Array.from(document.querySelectorAll('#chat-output .ctile'))
		.map((e) => e.innerText).filter((s) => /needs a command run on/i.test(s)).pop() || '').catch(() => '');
	const got = await until(a.page, () => Array.from(document.querySelectorAll('#chat-output .ctile'))
		.some((e) => /needs a command run on/i.test(e.innerText)), null, 90000, 250);
	if (got) Object.assign(seen, { label: (await saidOn(a.page)).replace(/\s+/g, ' '), at: Date.now() - t0 });
	// B's name as B beats it: what the engine on B was told and what its other devices
	// read off presence. (A's own view may hold the harness's alias for B.)
	const nameB = await b.page.evaluate((id) => (window.DaimondPresence && DaimondPresence.name
		&& DaimondPresence.name(id)) || '', idB).catch(() => '');
	const bSaid = await saidOn(b.page);
	console.log('A said: ' + JSON.stringify(seen) + '\nB by its own name: ' + nameB
		+ '\nB said: ' + bSaid.replace(/\s+/g, ' ').slice(0, 300));

	if (!seen.label || process.env.RUNSAID_DEBUG) {
		const tail = async (pg) => pg.evaluate(() => {
			const o = document.getElementById('chat-output');
			return o ? o.innerText.replace(/\s+/g, ' ').slice(-700) : '(no chat-output)';
		}).catch((e) => 'err ' + e);
		console.log('DEBUG A chat: ' + await tail(a.page));
		console.log('DEBUG B chat: ' + await tail(b.page));
		const ml = mockLog();
		console.log('DEBUG mock requests: ' + ml.length + ', last tools: '
			+ JSON.stringify(ml.slice(-3).map((r) => ((r.body || r.req || {}).tools || []).map((t) => (t.function || t).name))).slice(0, 600));
		await shot(a, 'runsaid_A');
		await shot(b, 'runsaid_B');
	}
	check('(1) A\'s transcript carries the runner\'s sentence',
		!!seen.label, seen.at ? 'drawn on A after ' + seen.at + ' ms' : 'never drawn on A');
	check('(2) the sentence names the runner, never "this device"',
		!!seen.label && !/this device|this computer|this one/i.test(seen.label)
		&& !!nameB && seen.label.includes('run on ' + nameB),
		'name=' + JSON.stringify(nameB) + ' label=' + JSON.stringify(seen.label.slice(0, 200)));
} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
} finally {
	if (b) await b.close().catch(() => {});
	if (a) await a.close().catch(() => {});
}
if (BREAK) console.log('(break ' + BREAK + ')');
finish('A is told which device the turn needs');

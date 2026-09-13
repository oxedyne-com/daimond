// verify_askdrawn.mjs — the honesty of the ask ack: an `ask` the page never
// painted must answer drawn:false, and one it did must still end the turn.
//
// Turn 47: an accepted ask made from the crystal face acked "on the user's
// screen" while `renderToolCall` -- gated on `onScreen()` -- had painted
// nothing, and the turn ended as Done on a question nobody could see. The fix
// answers `drawn` from the paint; this verifier holds both ends:
//
//   1. THE TURN-47 STATE, directly: a drawable payload, no card painted, no
//      runner -- `DaimondAsk.put` must answer drawn:false. Against the
//      shape-answering code this check fails, which is the break that
//      proved it.
//   2. THE CHAT FACE, end to end: a real ask paints the card and the
//      engine's own `put` answers drawn:true -- the turn ends on the
//      question, exactly as probe_askdaimon asserts. A fix that broke the
//      honest-true arm would show here as a refusal and a second round.
//
// The runner arm (a lease blocker in place of a paint) is NOT driven here: it
// needs a second device. Its predicate is the broadcast's own, so the two
// cannot disagree; see the comment at `DaimondAsk.put`.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break paintlie` serves
// the defect as it shipped: the ack answered from the payload's shape, so an
// unpainted ask still claimed the screen. The break restores that line, the
// run must redden, and a break that fails nothing is refused as evidence.
//
//   node dev/verify_askdrawn.mjs                     # clean: all checks pass
//   node dev/verify_askdrawn.mjs --break paintlie    # the defect as it shipped
import { open, connectMock, mockLog, clearMockLog } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Each break is a real edit to a real file, served in place of it, exactly as
// verify_render.mjs does it. `find` must appear exactly once in the file.
const BREAKS = {
	// THE DEFECT AS IT SHIPPED, restored exactly: the ack answered from the
	// shape, so the turn-47 ask claimed a screen that had nothing on it.
	paintlie: [{
		file: 'js/daimond.js',
		find: "\t\t\tvar handed = !!(o && askDrawable(o) && activeRunnerTurn());\n"
			+ "\t\t\treturn Promise.resolve(JSON.stringify({\n"
			+ "\t\t\t\tdrawn: handed || (_askJust && !!_askCard),\n"
			+ "\t\t\t}));",
		with: "\t\t\treturn Promise.resolve(JSON.stringify({ drawn: !!(o && askDrawable(o)) }));",
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

// A break hands the page a DAMAGED COPY of a real file through route
// interception — the working tree is never touched, and the copy is read from
// the tree (WWW) so a stale anchor fails loudly rather than proving nothing.
function damaged(src, spec) {
	{
		const n = src.split(spec.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, expected 1 — the break is stale, fix the anchor`);
			process.exit(2);
		}
		// A FUNCTION REPLACER, not a string: String.replace interprets `$` patterns
		// in a string replacement, so a `with` that carries them would be corrupted.
		src = src.replace(spec.find, () => spec.with);
	}
	return src;
}

// The damaged files, ONE BODY PER FILE. Playwright hands a request to the LAST
// route registered for its URL, so two routes on one file ship only the second
// edit — and a two-edit break then goes red for half the reason it claims.
function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, damaged(src, spec));
	}
	return byFile;
}

async function serveBreaks(page) {
	if (!BREAK) return;
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, r => r.fulfill({ status: 200, contentType: 'text/javascript', body }));
	}
}

const Q = {
	question: 'Where should the parcel be signed?',
	options: [
		{ label: 'On the device',  means: 'The key never leaves this laptop.' },
		{ label: 'In the gateway', means: 'Any device can sign.' },
	],
	recommend: 'On the device',
	why: 'The whole point is that Oxedyne cannot speak for you.',
	if_silent: 'I will keep signing on the device.',
	n: 1, of: 2,
};

let bad = [];
const ok = (c, why, d) => { console.log((c ? '  ok   ' : '  FAIL ') + why + (d != null ? ' — ' + d : '')); if (!c) bad.push(why); };

const s = await open({ name: 'askdrawn', defaults: false, route: BREAK ? serveBreaks : null });
const { page: p } = s;
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0, 200)));
await connectMock(s);

// A Diamond, opened on its chat face, which is where the owner types.
await p.evaluate(() => document.getElementById('new-diamond-btn').click());
await p.waitForSelector('.dlg-card', { timeout: 8000 });
await p.evaluate(() => {
	const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
	const inp = card.querySelector('input.dlg-input');
	inp.value = 'Askdrawn';
	inp.dispatchEvent(new Event('input', { bubbles: true }));
	card.querySelector('.dlg-ok').click();
});
await p.waitForTimeout(1200);
await p.click('#dview-chat');
await p.waitForTimeout(700);
const say = async (text, ms = 5000) => {
	await p.fill('#chat-input', text);
	await p.click('#chat-send');
	await p.waitForTimeout(ms);
};

// ══ 1. The turn-47 state: drawable, nothing painted, no runner ════
const pre = await p.evaluate(
	q => window.DaimondAsk.put(q).then(r => {
		try { return JSON.parse(r); } catch { return { drawn: null, raw: String(r).slice(0, 120) } }
	}),
	JSON.stringify(Q));
ok(pre.drawn === false,
	'a drawable payload with no card painted answers drawn:false', JSON.stringify(pre));

// ══ 2. The chat face, end to end: paint, and the engine's own put ══
clearMockLog();
await say('@tool ask ' + JSON.stringify(Q), 6000);
const card = await p.evaluate(() => !!document.querySelector('#chat-output .ask-card'));
ok(card, 'the chat face still paints the card');
ok(mockLog().length === 1,
	'and the engine\'s own put answered drawn:true — the turn ended on the question',
	mockLog().length + ' request(s)');

ok(errs.length === 0, 'nothing was thrown', errs.join(' | '));
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length ? `\nverify_askdrawn: ${bad.length} failed.` : '\nverify_askdrawn: all checks passed');
await s.close();
process.exit(bad.length ? 1 : 0);

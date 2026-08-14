// A steer turn that answers in words (no crystal edit, no dispatch) must SHOW those
// words, not silently bill and vanish.
//
// The words are a nonce minted here, and they are looked for in `#crystal-reply`
// alone. That element is written by `setCrystalReply` and by nothing else (see
// www/js/daimond.js), so a hit there is the model's answer and cannot be the
// user's own typed line coming back -- which is the way this check would
// otherwise pass on an app that showed nothing at all.
//
// PROVED AGAINST BROKEN CODE FIRST. `--break silent` serves a copy of
// www/js/daimond.js in which `setCrystalReply` builds the reply and then leaves
// it hidden -- the defect this file is named for -- and the run is expected to
// FAIL. An anchor that does not appear exactly once aborts the run rather than
// passing quietly.
//
//   node dev/verify_steer.mjs --break silent   # expected to FAIL
//   node dev/verify_steer.mjs                  # and then, clean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const SRC  = 'js/daimond.js';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// The last three lines of `setCrystalReply`: it appends the dismiss control and
// the rendered body, and then reveals the panel. The break appends both and
// reveals nothing, so a reply that exists is never seen.
const SHOWN = "\t\tr.appendChild(x);\n\t\tr.appendChild(body);\n\t\tr.style.display = '';";
const HIDDEN = "\t\tr.appendChild(x);\n\t\tr.appendChild(body);\n\t\tr.style.display = 'none';";
const BREAKS = { silent: [{ file: SRC, find: SHOWN, with: HIDDEN }] };

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; known: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// Serve the damaged file to the page, before anything navigates.
async function breakInto(page) {
	const bodies = {};
	for (const spec of BREAKS[BREAK]) {
		const src = bodies[spec.file] || fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		const n = src.split(spec.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
				+ 'so nothing was broken and the run below would prove nothing.');
			process.exit(2);
		}
		bodies[spec.file] = src.replace(spec.find, spec.with);
	}
	for (const file of Object.keys(bodies)) {
		await page.route('**/' + file, (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: bodies[file],
		}));
	}
}

const s = await open({ name: 'steer', route: BREAK ? breakInto : null });
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

// Create a Diamond via the real button + prompt dialog.
await s.page.click('#new-diamond-btn');
await s.page.waitForSelector('.dlg-input', { timeout: 8000 });
await s.page.fill('.dlg-input', 'Test Diamond');
await s.page.click('.dlg-ok');
await s.page.waitForTimeout(1200);
await shot(s, 'steer-0-after-newfocus');

const state = await s.page.evaluate(() => ({
	steer: !!document.getElementById('chat-input'),
	reply: !!document.getElementById('crystal-reply'),
}));
// This used to be an `if`, and a run that never reached the composer printed a
// line about the screenshot and exited 0 -- the whole file skipped, green.
check('a new Diamond leaves a steer composer to type in', state.steer, '#chat-input');
check('and a reply panel for the answer to land in', state.reply, '#crystal-reply');

// A nonce, so a hit in the reply panel is this turn's answer and not a fixture
// word that could have come from anywhere.
const NONCE = 'steer-' + Math.random().toString(36).slice(2, 8);
let r = { shown: false, text: '' };
if (state.steer) {
	await s.page.fill('#chat-input', `@text I need one clarification (${NONCE}): which platform first?`);
	await s.page.keyboard.press('Enter');
	await s.page.waitForTimeout(4000);
	r = await s.page.evaluate(() => {
		const el = document.getElementById('crystal-reply');
		const body = el && el.querySelector('.crystal-reply-body');
		return {
			shown: !!(el && el.style.display !== 'none' && el.getClientRects().length),
			text:  body ? body.textContent : (el ? el.textContent : ''),
		};
	});
	await shot(s, 'steer-1-reply');
}
check('A TEXT-ONLY STEER IS SHOWN, not silently billed and dropped',
	r.shown, r.shown ? 'the reply panel is on screen' : 'the reply panel is hidden or absent');
check('and what it shows is this turn\'s answer',
	r.text.includes(NONCE), `looking for ${NONCE} in ${JSON.stringify((r.text || '').slice(0, 80))}`);

// 502 is this world with no gateway behind it.
const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }

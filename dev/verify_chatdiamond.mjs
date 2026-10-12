// gateway: none
// verify_chatdiamond.mjs — a synced chat naming a Diamond by a non-id is refused.
//
// WHY THIS FILE EXISTS. A synced chat's `diamondId` reached `wire_system` and
// `set_diamond_scope` as a path segment unchecked: `applyChats` and the store merge
// checked only the chat's own `id` (HIST-SAFE U2, live exposure, spec
// `specs/daimond_histsafe_u2_live_exposure_20261012.md`). A `diamondId` of `..` or
// `X/../Y` opened the OPFS root's or another Diamond's prompt in the Wire panel.
//
// Driven through `DaimondSync.parcel()`/`apply()`, the two functions the wire uses.
// Asserted on the STORED record, with a well-formed control beside each bad one so
// a refusal of everything cannot pass.
//
//   node dev/verify_chatdiamond.mjs              # GREEN: bad ids refused, good ones land
//   node dev/verify_chatdiamond.mjs --break off  # RED: the check reads every id as good

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch, storedChats } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const CHECK = '\tfunction chatDiamondOk(c) {\n';
const BREAKS = {
	off: { file: 'js/daimond.js', find: CHECK, with: CHECK + '\t\treturn true;\n' },
};
if (BREAK && !BREAKS[BREAK]) {
	console.error('unknown --break ' + BREAK + '; known: ' + Object.keys(BREAKS).join(', '));
	process.exit(2);
}

async function breakInto(page) {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	if (src.indexOf(spec.find) < 0) {
		console.error('--break ' + BREAK + ': anchor not found in ' + spec.file);
		process.exit(2);
	}
	await page.route('**/' + spec.file, (r) => r.fulfill({
		status: 200, contentType: 'application/javascript', body: src.replace(spec.find, spec.with),
	}));
}

const CASES = [
	{ id: 'c9001', diamondId: '..',              good: false },
	{ id: 'c9002', diamondId: '1a12d6f0feb6/../x', good: false },
	{ id: 'c9003', diamondId: 'diamonds',        good: false },
	{ id: 'c9004', diamondId: '1a12d6f0feb6',    good: true },
	{ id: 'c9005', diamondId: '',                good: true },
	{ id: 'c9006',                               good: true },
];

const PROFILE = scratch('pw', 'chatdiamond' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({ name: 'chatdiamond', profile: PROFILE, defaults: false, route: breakInto });

try {
	const got = await s.page.evaluate(async (cases) => {
		const p = await window.DaimondSync.parcel();
		const now = Date.now();
		p.chats = (p.chats || []).concat(cases.map((c) => {
			const o = { id: c.id, name: 'probe ' + c.id, messages: [], created: now, updated: now };
			if ('diamondId' in c) o.diamondId = c.diamondId;
			return o;
		}));
		await window.DaimondSync.apply(p);
		return true;
	}, CASES);
	check('the parcel applied', got === true);
	await s.page.waitForTimeout(1500);
	const ids = new Set((await storedChats(s)).map((c) => c.id));
	for (const c of CASES) {
		const what = c.id + ' diamondId=' + JSON.stringify(c.diamondId);
		check((c.good ? 'lands: ' : 'refused: ') + what, ids.has(c.id) === c.good,
			'stored=' + ids.has(c.id));
	}
} catch (e) {
	check('PROBE threw', false, String(e && e.stack || e).slice(0, 600));
} finally {
	console.log(`\n${ok.length} ok, ${bad.length} FAIL`);
	await s.browser.close().catch(() => {});
}
process.exit(bad.length ? 1 : 0);

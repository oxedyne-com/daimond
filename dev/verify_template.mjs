// verify_template.mjs — a Diamond saved as a template, and one opened.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// `DaimondApp.export_template` and `import_template` landed with no caller: the
// engine could take a Diamond's SHAPE and open one, and nothing in the app
// reached either. A module with no production caller is not done, and this tree
// has shipped that failure before.
//
// ── WHAT IT ASSERTS, AND WHY THE CONSENT CHECK IS THE ONE THAT MATTERS ───────
//
// A Diamond carrying a crystal page is carrying a PROGRAM somebody else wrote,
// and `js/share.js`'s standing rule is that data travels freely and code travels
// only by consent. `import_template` writes UNCONDITIONALLY — there is no
// `withCode` on that door and no half-landing behind it — so the question has to
// be asked before the call, in the app's own chrome, and DECLINING MUST WRITE
// NOTHING. A naive button skips exactly that step and every other check here
// would still be green.
//
// The other property with teeth is that opening one **mints a new Diamond**. The
// id inside a template says where it was MADE, so a door that took it literally
// would destroy the Log Life of the person most likely to open a Log Life
// template. That is why `import_diamond` and `import_template` are two doors.
//
//   node dev/verify_template.mjs
//   node dev/verify_template.mjs --break noconsent  # the page is written unasked
//   node dev/verify_template.mjs --break blindcode  # nothing counts as code
//
// A `--break` run EXPECTS to fail: exit 0 when something reddened, 1 when
// nothing did, because a break that changes nothing is itself a failing run.
//
// Needs dev/serve.mjs (:8777). No model is consulted, so no mock and no gateway.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The breaks ───────────────────────────────────────────────────────────────
//
// `noconsent` is the naive button: the page is written without the question,
// which is the whole failure this file exists to catch. `blindcode` leaves the
// question in and blinds the judgement behind it, which is the subtler half —
// an ask that never fires because nothing is ever called code is an ask that is
// not there.
const BREAK  = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	noconsent: [{
		file: 'js/share.js',
		find: "		if (desc.code.length) {\n			var yes = await askAboutTemplate(desc);",
		with: "		if (false) {   /* --break noconsent */\n			var yes = await askAboutTemplate(desc);",
	}],
	blindcode: [{
		file: 'js/share.js',
		find: "	function isCodePath(path) {\n		var lower = String(path || '').toLowerCase();",
		with: "	function isCodePath(path) {\n		return false;   /* --break blindcode */\n		var lower = String(path || '').toLowerCase();",
	}],
};

function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.get(spec.file) || fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		if (!src.includes(spec.find)) {
			console.error(`--break ${BREAK}: anchor not found in ${spec.file}. The break is stale.`);
			process.exit(1);
		}
		byFile.set(spec.file, src.replace(spec.find, spec.with));
	}
	return byFile;
}

async function serveBreaks(page) {
	if (!BREAK) return;
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

// `connect: false` — nothing here talks to a model, and it drops the requirement
// for a mock this run owns.
const s = await open({ name: 'template', route: serveBreaks, connect: false });
const p = s.page;

/// Every Diamond the STORE holds, asked of the engine rather than of the rail: a
/// rail is a drawing and the question here is what was written.
const stored = () => p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	try { return JSON.parse(await app.list_diamonds()).map(d => ({ id: d.id, name: d.name })); }
	catch (e) { return []; }
});

// ── 0. A Diamond worth taking the shape of ──────────────────────────────────
//
// A page (which is CODE), a capp's own folder beside it (which is shape and must
// travel), a trigger, an entry and a memory (none of which may). Written through
// the engine's own doors, which is where the app writes them from.
const src = await p.evaluate(async () => {
	const id = document.querySelector('#diamond-list [data-id]').dataset.id;
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_crystal_page(id, '<h1>Log Life</h1><script>window.LOGLIFE = 1;<\/script>');
	await m.store_write('diamonds/' + id + '/recipes/seed.json', '{"kind":"log"}');
	await m.store_write('diamonds/' + id + '/log/monday.md', 'what I did on Monday');
	return { id, name: (document.querySelector('#diamond-list [data-id] .session-name') || {}).textContent || '' };
});
// The trigger through the app's own setter, so what is armed is what the product
// arms — and it is the one thing a template must be proved to leave behind.
await p.evaluate(async (id) => {
	await window.DaimondCore.triggerSet(id, { id: 'ta1', kind: 'timer', every: 3600, say: 'go' });
}, src.id);
const before = await stored();
check('0 the fixture Diamond is on the store, with a page in it',
	!!src.id && before.some(d => d.id === src.id), src.id || '(none)');

// ── 1. What a template carries, and what it deliberately does not ───────────
const shape = await p.evaluate(async (id) => {
	const pack = await window.DaimondDiamond.template(id, false);
	const full = await window.DaimondDiamond.template(id, true);
	return {
		pack:  window.DaimondShare.readTemplate(pack),
		full:  window.DaimondShare.readTemplate(full),
		bytes: pack,
	};
}, src.id);
check('1a a template carries the page it draws through and a capp’s own folder',
	shape.pack.files.includes('crystal.html') && shape.pack.files.includes('recipes/seed.json'),
	JSON.stringify(shape.pack.files));
check('1b AND NOT THE TRIGGER, the memory, the entries, the log or the history',
	!shape.pack.files.some(f => f === 'triggers.json' || f === 'crystal.json'
		|| f.startsWith('log/') || f.startsWith('.daimond/') || f.startsWith('versions/')),
	JSON.stringify(shape.pack.files));
check('1c the page is NAMED as code, so the question can say which file',
	shape.pack.code.length === 1 && shape.pack.code[0] === 'crystal.html',
	JSON.stringify(shape.pack.code));
check('1d it says it is a template, which is what keeps it off the overwrite door',
	shape.pack.kind === 'template', shape.pack.kind);
check('1e "include what it recorded" is the door back to a complete copy',
	shape.full.files.includes('crystal.json') && shape.full.files.includes('log/monday.md')
		&& shape.full.kind === 'template',
	JSON.stringify(shape.full.files));

// ── 2. Where the control lives: behind the Diamond's cog ────────────────────
//
// Everything about ONE Diamond is behind its cog, which is where a person looks.
await p.evaluate((id) => {
	const tile = document.querySelector('#diamond-list [data-id="' + id + '"]');
	// NOT page.click: force-clicking a tile is silently inert headless.
	tile.querySelector('.tile-cog').click();
}, src.id);
await p.waitForSelector('.tile-dlg-card', { timeout: 10000 });
const cog = await p.evaluate(() => {
	const card = document.querySelector('.tile-dlg-card');
	const btn = card.querySelector('.tile-dlg-tmpl-save');
	return {
		save: btn ? (btn.textContent || '') : '',
		conv: !!card.querySelector('.tile-dlg-tmpl .tile-dlg-check'),
		text: (card.textContent || ''),
	};
});
check('2a the Diamond’s cog offers to save it as a template', !!cog.save, cog.save || '(no button)');
check('2b with the door back to a complete copy beside it', cog.conv);
const cogSays = /new Diamond/i.test(cog.text) && /trigger/i.test(cog.text);
check('2c and it says the two things nobody can guess: a NEW Diamond, and no triggers',
	cogSays, cogSays ? '' : 'one of the two sentences is missing from the dialog');
await shot(s, 'template-1-cog');

// ── 3. Pressing it hands over a file ────────────────────────────────────────
//
// The same handover every other file in Daimond takes: one Blob, one object URL,
// a synthetic `<a download>`, the URL revoked straight after.
const wait = p.waitForEvent('download', { timeout: 15000 }).catch(() => null);
await p.evaluate(() => document.querySelector('.tile-dlg-tmpl-save').click());
const dl = await wait;
check('3 saving hands over a .dtemplate file, named after the Diamond',
	!!dl && /\.dtemplate$/.test(dl.suggestedFilename()),
	dl ? dl.suggestedFilename() : '(no download)');
await p.evaluate(() => {
	const x = document.querySelector('.tile-dlg-x');
	if (x) x.click();
});
await sleep(300);

// ── 4. THE CONSENT STEP ─────────────────────────────────────────────────────
//
// Asked BEFORE the call, because there is nothing after it to undo. The promise
// is parked on the window and the dialog is answered the way a person answers
// it, so what is driven is the app's own box rather than a stub.
async function offer(answer) {
	await p.evaluate((json) => {
		window.__tmpl = { done: false, result: null, error: '' };
		window.DaimondShare.takeTemplate(json).then(
			r => { window.__tmpl.result = r; window.__tmpl.done = true; },
			e => { window.__tmpl.error = (e && e.message) || String(e); window.__tmpl.done = true; });
	}, shape.bytes);
	// The dialog, if one is drawn at all. Its absence is the finding when it is.
	const asked = await p.waitForSelector('.dlg-card .dlg-ok', { timeout: 6000 })
		.then(() => true).catch(() => false);
	if (asked) {
		const words = await p.evaluate(() => (document.querySelector('.dlg-card') || {}).textContent || '');
		await p.evaluate((yes) => {
			const card = document.querySelector('.dlg-card');
			(yes ? card.querySelector('.dlg-ok') : card.querySelector('.dlg-cancel')).click();
		}, answer);
		await p.waitForFunction(() => window.__tmpl.done, null, { timeout: 20000 }).catch(() => {});
		return { asked: true, words, ...(await p.evaluate(() => window.__tmpl)) };
	}
	await p.waitForFunction(() => window.__tmpl.done, null, { timeout: 20000 }).catch(() => {});
	return { asked: false, words: '', ...(await p.evaluate(() => window.__tmpl)) };
}

const declined = await offer(false);
const afterNo = await stored();
check('4a A TEMPLATE CARRYING A PAGE IS ASKED ABOUT BEFORE IT IS WRITTEN',
	declined.asked, declined.asked ? '' : 'no question was drawn: it imported unasked');
const named = declined.asked && /crystal\.html/.test(declined.words);
check('4b and the question NAMES the file it would add', named,
	named ? '' : (declined.words ? 'the question drew without naming the path' : 'no question drew'));
const twoFacts = declined.asked && /new Diamond/i.test(declined.words);
check('4c and it says the two facts: a NEW Diamond, and declining writes nothing',
	twoFacts, twoFacts ? '' : (declined.asked ? 'the question drew without them' : 'no question drew'));
check('4d DECLINING WRITES NOTHING AT ALL',
	afterNo.length === before.length && !declined.result?.ok,
	`${before.length} Diamond(s) before, ${afterNo.length} after`);
await shot(s, 'template-2-declined');

// ── 5. Accepting opens it as a NEW Diamond, and never over an existing one ──
const taken = await offer(true);
const afterYes = await stored();
check('5a accepting opens it', !!(taken.result && taken.result.ok),
	taken.error || JSON.stringify(taken.result));
check('5b AS A NEW DIAMOND, not over the one it was made from',
	afterYes.length === before.length + 1
		&& taken.result && taken.result.id && taken.result.id !== src.id,
	`made from ${src.id}, opened as ${(taken.result || {}).id || '(none)'}; `
		+ `${before.length} → ${afterYes.length} Diamond(s)`);
check('5c and the Diamond it was made from is untouched',
	afterYes.some(d => d.id === src.id), src.id);

const landed = await p.evaluate(async (id) => {
	const files = (await window.DaimondDiamond.files(id)).map(f => f.path);
	return files;
}, (taken.result || {}).id || '');
check('5d the page arrived', landed.includes('crystal.html'), JSON.stringify(landed));
check('5e AND THE TRIGGER DID NOT: a trigger fires with nobody pressing anything',
	!landed.includes('triggers.json'), JSON.stringify(landed));
check('5f nor did what the Diamond had recorded',
	!landed.includes('log/monday.md'), JSON.stringify(landed));
await shot(s, 'template-3-opened');

// ── 6. And a person can reach it ────────────────────────────────────────────
//
// In the Share view of the Social panel: the one place in Daimond where
// something arrives AS A FILE and is asked about before it is written.
await p.evaluate(() => {
	window.DaimondPanels.show('social');
	document.querySelector('.imp-chip[data-view="share"]').click();
});
await sleep(600);
const panel = await p.evaluate(() => {
	const host = document.getElementById('social-share-list');
	const btn = host ? host.querySelector('.shr-tmpl') : null;
	return { btn: btn ? (btn.textContent || '') : '', text: host ? (host.textContent || '') : '' };
});
check('6a the Share view offers to open a template', !!panel.btn, panel.btn || '(no control)');
const panelSays = /new Diamond/i.test(panel.text) && /trigger/i.test(panel.text);
check('6b and says the two facts before anything is pressed', panelSays,
	panelSays ? '' : 'one of the two sentences is missing from the block');
await shot(s, 'template-4-panel');

const errs = errors(s).filter(e => !/502|Account service|429/.test(e));
check('7 none of it raised anything in the console', errs.length === 0,
	errs.slice(0, 2).join(' | '));

await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length ? `--break ${BREAK}: reddened ${bad.length} check(s), as it must`
		: `--break ${BREAK}: CHANGED NOTHING — the check it names is not testing what it says`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);

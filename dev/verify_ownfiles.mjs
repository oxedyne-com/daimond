// gateway: none
// verify_ownfiles.mjs — the Workspace panel conceals nothing, and is still tidy.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// The tree dropped every dotfile on the floor. The owner opened his own
// workspace, saw `mail/`, `prompts/` and `test.md`, and could not see -- let
// alone edit -- the `.daimond` directory holding his own rules and skills. Nor
// `.env`, nor `.gitignore`, nor anything else he had put there: a file the panel
// silently drops is a file he cannot see he has.
//
// The filter was there for clutter, and clutter is a design problem. So the
// answer is a switch: the head ⋯'s Show hidden files (Workspace round 2 P4; it
// was a shut row with a count at the foot of the tree until then), off on first
// paint, which draws everything the panel used to withhold below his own files
// -- and his own files exactly where they were, at the top.
//
// ── WHAT IT ASSERTS, WHICH IS THE PROPERTY AND NOT THE FIX ───────────────────
//
// Not "the switch exists". Three properties, and each can hold while another
// breaks:
//
//   * NOTHING IS CONCEALED. Every dotfile at a level is reachable from that
//     level, and a file inside one opens and reads like any other.
//   * HIS OWN FILES ARE NOT MOVED. The tidying is not paid for by burying his
//     work one click deeper.
//   * SHOWING THEM COSTS NOTHING. A `.git` of three hundred objects is ONE row
//     here, not three hundred -- the tree lists one directory at a time and
//     the switch lists nothing at all.
//
//   node dev/verify_ownfiles.mjs
//   node dev/verify_ownfiles.mjs --break nogroup       # the defect, restored
//   node dev/verify_ownfiles.mjs --break openbydefault # tidy claim, untidy panel
//   node dev/verify_ownfiles.mjs --break nopersist     # shut again on every reload
//
// A `--break` run EXPECTS to fail: exit 0 when something reddened, 1 when
// nothing did, because a break that changes nothing is itself a failing run.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no model.

import { readPage } from './pagesrc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, shot, errors, workMenu, workMenuItems } from './harness.mjs';
import { guardRan } from './verdict.mjs';

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
// Each is scoped to survive every check but the ones it proves. `nogroup` puts
// the original blanket filter back, which is the defect exactly. The other three
// leave the row in place and damage one claim it makes about itself.
const BREAK  = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	nogroup: [{
		file: 'js/daimond.js',
		find: "\t\t\t\tif (e.name.charAt(0) === '.' || (atRoot && e.dir && APP_DIRS[e.name])) { rest.push(e); return; }",
		with: "\t\t\t\tif (e.name.charAt(0) === '.') return;   // --break nogroup",
	}],
	openbydefault: [{
		file: 'js/daimond.js',
		find: "\t\t\ttry { return localStorage.getItem(LS_RESTGROUP) === '1'; }",
		with: "\t\t\ttry { return true; }   // --break openbydefault",
	}],
	nopersist: [{
		file: 'js/daimond.js',
		find: "\t\t\ttry { localStorage.setItem(LS_RESTGROUP, restShown ? '1' : '0'); }",
		with: "\t\t\ttry { /* --break nopersist */ }",
	}],
};

function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = readPage(path.join(WWW, spec.file), 'utf8');
		if (!src.includes(spec.find)) {
			// A break whose anchor is not there patches nothing and launders a
			// plain run as proof. Loud, and fatal.
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

const s = await open({ name: 'ownfiles', route: serveBreaks, connect: false });
const p = s.page;

// ── The fixture ──────────────────────────────────────────────────────────────
//
// Written through the engine's own door, not through a chat: `write_file` is not
// fenced because it is not a turn, and a chat could not put a byte outside
// `chats/<id>/work` anyway (see the header of dev/harness.mjs).
//
// `.git` is deliberately FAT. Three hundred loose objects is what makes the
// laziness question answerable rather than assumed: if the panel walks what it
// shows, the row's count and the rows under it would be in the hundreds.
const GIT_OBJECTS = 300;
const seeded = await p.evaluate(async (n) => {
	const M = await import('/pkg/oxedyne_daimond.js');
	const w = (path, body) => M.write_file(path, body);
	// His own.
	await w('notes.md', '# Notes\n');
	await w('myproject/plan.md', '# Plan\n');
	// Daimond's own working directories, at the root among his files.
	await w('prompts/chat.md', 'You are helpful.\n');
	await w('mail/a@b.example/INBOX/index.md', '# INBOX\n');
	// His, and previously invisible.
	await w('.daimond/skills/mine.md', '# my own skill\nthe body of it\n');
	await w('.gitignore', 'target/\n');
	await w('.env', 'NOTHING=here\n');
	// And a repository, at the size a real one is.
	await w('.git/HEAD', 'ref: refs/heads/main\n');
	await w('.git/config', '[core]\n');
	for (let i = 0; i < n; i++) {
		await w('.git/objects/ab/' + String(i).padStart(4, '0'), 'x');
	}
	return true;
}, GIT_OBJECTS);
check('0 the fixture is written', seeded === true);

async function openWorkspace() {
	await p.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
	await sleep(500);
	await workMenu(p, 'head', 'refresh');   // the page's own click: a forced page.click is inert headless
	await sleep(1200);
}

/// Everything the tree is currently saying, at whatever level it is showing.
const tree = () => p.evaluate(() => {
	const t = document.querySelector('#panel-work .files-tree');
	if (!t) return null;
	const clean = el => ((el.querySelector('.files-name') || {}).textContent || '')
		.replace(/^[^A-Za-z0-9._-]+/, '').trim();
	// Laid out, not merely in the DOM: a row that is there but styled away would
	// pass a query and still not be on the screen.
	const rows = [...t.children].filter(c => c.classList.contains('files-row') && !!c.offsetParent).map(clean);
	const hid = (n) => n.charAt(0) === '.' || ['mail', 'prompts', 'chats', 'system'].includes(n);
	const first = rows.findIndex(hid);
	return {
		rows,
		mine:   rows.filter(n => !hid(n)),
		hidden: rows.filter(hid),
		// Are the hidden rows LAST, under his own files rather than among them?
		last:   first < 0 || rows.slice(first).every(hid),
	};
});

/// The head ⋯'s Show hidden files: on screen, and whether it is ticked.
const switchState = async () => {
	const has = (await workMenuItems(p, 'head')).includes('hidden');
	const on = await p.evaluate(() => {
		const b = document.querySelector('#panel-work [data-act="ws-more"]');
		if (!b) return null;
		b.click();
		const it = document.querySelector('.railhead-menu[data-menu="head"] [data-act="hidden"]');
		const v = it ? it.getAttribute('aria-checked') : null;
		if (document.querySelector('.railhead-menu[data-menu="head"]')) b.click();
		return v;
	});
	return { has, on };
};

/// Press the head ⋯'s Show hidden files.
async function toggleRest() {
	await workMenu(p, 'head', 'hidden');
	await sleep(500);
}

/// Click a row by the name it shows, wherever in the tree it is.
async function clickRow(name) {
	return await p.evaluate((want) => {
		const rows = [...document.querySelectorAll('#panel-work .files-tree .files-row')];
		const hit = rows.find(r => ((r.querySelector('.files-name') || {}).textContent || '')
			.replace(/^[^A-Za-z0-9._-]+/, '').trim() === want);
		if (!hit) return false;
		hit.click();
		return true;
	}, name);
}

await openWorkspace();

// ── 1. The switch is there, and off on first paint ───────────────────────────
const t0 = await tree();
const sw0 = await switchState();
check('1a the head ⋯ offers Show hidden files', sw0.has === true);
check('1b AND IT IS OFF ON FIRST PAINT',
	sw0.on === 'false' && !!t0 && t0.hidden.length === 0,
	`aria-checked=${sw0.on} hidden rows ${t0 ? JSON.stringify(t0.hidden) : 'no tree'}`);
await shot(s, 'ownfiles-shut');

// ── 2. His own files did not move ────────────────────────────────────────────
//
// The whole tidying is worthless if it was paid for by burying his work.
check('2a HIS OWN FILES ARE AT THE TOP LEVEL',
	!!t0 && t0.mine.includes('notes.md') && t0.mine.includes('myproject'),
	t0 ? JSON.stringify(t0.rows) : '');
check('2b while the switch is off, nothing of the rest is on the screen',
	!!t0 && !t0.rows.includes('.daimond') && !t0.rows.includes('.git') && !t0.rows.includes('mail'),
	t0 ? JSON.stringify(t0.rows) : '');

// ── 3. Showing them costs nothing ────────────────────────────────────────────
//
// Timed, because "it does not walk" is a claim about cost and the honest way to
// make it is with a clock. The hidden rows are built from the SAME listing the
// tree was drawn from -- one `file_list` of the current directory, which
// happened before the switch was pressed -- so pressing it lays out what is
// already held and asks the engine for nothing.
const pressed = Date.now();
await toggleRest();
const tookMs = Date.now() - pressed - 500;   // less the settle `toggleRest` sleeps
const t1 = await tree();
check('3a a fat .git is ONE row, not its contents',
	!!t1 && t1.hidden.includes('.git') && t1.hidden.length < 20,
	t1 ? `${t1.hidden.length} hidden rows for a .git of ${GIT_OBJECTS} objects` : '');
check('3b and showing them lists nothing: no directory is walked to fill them',
	tookMs < 150, `${tookMs} ms to show over a .git of ${GIT_OBJECTS} objects`);

// ── 4. Nothing is concealed ──────────────────────────────────────────────────
check('4a `.daimond` IS THERE, WHICH IS THE WHOLE REQUEST',
	!!t1 && t1.hidden.includes('.daimond'), t1 ? JSON.stringify(t1.rows) : '');
check('4b and so is every other dotfile the panel used to drop',
	!!t1 && ['.git', '.gitignore', '.env'].every(n => t1.hidden.includes(n)),
	t1 ? JSON.stringify(t1.rows) : '');
check('4c and Daimond’s own working folders are shown with them',
	!!t1 && t1.hidden.includes('mail') && t1.hidden.includes('prompts'),
	t1 ? JSON.stringify(t1.rows) : '');
check('4d they follow his own files, which did not move',
	!!t1 && t1.last === true && t1.mine.includes('notes.md') && t1.mine.includes('myproject'),
	t1 ? JSON.stringify(t1.rows) : '');
check('4e and the switch says it is on', (await switchState()).on === 'true');
await shot(s, 'ownfiles-open');

// ── 5. Once open it is an ordinary tree ──────────────────────────────────────
check('5a `.daimond` can be walked into', await clickRow('.daimond'));
await sleep(900);
const t2 = await tree();
check('5b and it lists like any other folder',
	!!t2 && t2.rows.includes('skills'), t2 ? JSON.stringify(t2.rows) : '');
check('5c a folder walked into is listed one level at a time',
	!!t2 && t2.rows.length <= 4, t2 ? `${t2.rows.length} rows` : '');
check('5d and its contents can be walked in turn', await clickRow('skills'));
await sleep(900);
check('5e A FILE INSIDE IT OPENS', await clickRow('mine.md'));
await sleep(1200);
const shown = await p.evaluate(() => {
	const pre = document.querySelector('#doc-view .files-view-body');
	return pre ? pre.textContent : null;
});
check('5f and its text is the file’s own',
	!!shown && shown.indexOf('the body of it') !== -1,
	shown === null ? 'nothing in the Doc panel' : JSON.stringify(shown.slice(0, 40)));
await shot(s, 'ownfiles-file');

/// Reload, and come back signed in.
///
/// A RELOAD IS A LOCK: `boot()` finds the stored identity and returns before
/// `renderAll`, so a wait on `__DAIMOND_READY` alone is a wait on the lock
/// screen. See dev/verify_reopen.mjs, which documents this.
///
/// The lock class is asked for REPEATEDLY rather than once. A warm second boot
/// can raise `__DAIMOND_READY` a beat before it paints the gate, and a single
/// glance at that instant sees an unlocked page, skips the sign-in, and then
/// waits thirty seconds for a lock that will never lift. That is a THROW, which
/// takes the process and every check after it -- so this answers false instead,
/// and the caller reddens one check with a fact somebody can act on.
async function reboot() {
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForFunction(() => window.__DAIMOND_READY === true, null, { timeout: 30000 })
		.catch(() => {});
	const locked = () => p.evaluate(() => document.body.classList.contains('locked'));
	const until = Date.now() + 20000;
	while (Date.now() < until) {
		if (await locked()) {
			try { await signInAs(s, 'ownfiles'); } catch (e) { return false; }
			break;
		}
		await sleep(300);
	}
	const done = Date.now() + 20000;
	while (Date.now() < done) {
		if (!await locked()) { await sleep(1200); return true; }
		await sleep(300);
	}
	return false;
}

// ── 6. It is remembered ──────────────────────────────────────────────────────
//
// The preference is a preference in both directions, so both are reloaded.
const saved = await p.evaluate(() => {
	try { return localStorage.getItem('daimond-files-rest'); } catch (e) { return null; }
});
check('6a the switch is written down where the panel’s other state is',
	saved === '1', JSON.stringify(saved));

check('6b the session came back from a reload', await reboot());
await openWorkspace();
const t3 = await tree();
check('6c THE HIDDEN FILES ARE STILL SHOWN AFTER A RELOAD',
	!!t3 && t3.hidden.includes('.daimond'), t3 ? JSON.stringify(t3.rows) : 'no tree');
check('6d and his own files are still at the top level where he left them',
	!!t3 && t3.mine.includes('notes.md'), t3 ? JSON.stringify(t3.rows) : '');

// Off again, and that is remembered too — the preference is a preference in
// both directions, not a one-way door.
await toggleRest();
check('6e the session came back from the second reload', await reboot());
await openWorkspace();
const t4 = await tree();
check('6f and turning it off again is remembered as well',
	!!t4 && t4.hidden.length === 0 && t4.mine.includes('notes.md'),
	t4 ? JSON.stringify(t4.rows) : 'no tree');

// ── 7. The console ───────────────────────────────────────────────────────────
const errs = errors(s).filter(e => !/favicon|404|401|402|502|Bad Gateway|Account service|net::ERR/.test(e));
check('7 nothing throws while all this happens', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();

guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	// A break that reddened nothing proves nothing about the check it names.
	console.log(bad.length ? `--break ${BREAK}: reddened ${bad.length} check(s), as it must`
		: `--break ${BREAK}: CHANGED NOTHING — the check it names is not testing what it says`);
	process.exit(bad.length ? 0 : 1);
}
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);

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
// answer is one shut row at the foot of the tree, carrying a count, with
// everything the panel used to withhold inside it -- and his own files exactly
// where they were, at the top.
//
// ── WHAT IT ASSERTS, WHICH IS THE PROPERTY AND NOT THE FIX ───────────────────
//
// Not "the row exists". Three properties, and each can hold while another
// breaks:
//
//   * NOTHING IS CONCEALED. Every dotfile at a level is reachable from that
//     level, and a file inside one opens and reads like any other.
//   * HIS OWN FILES ARE NOT MOVED. The tidying is not paid for by burying his
//     work one click deeper.
//   * THE ROW IS HONEST ABOUT ITS SIZE. The count says what opening it costs,
//     and a `.git` of three hundred objects is ONE row here, not three hundred
//     -- the tree lists one directory at a time and opening the row lists
//     nothing at all.
//
//   node dev/verify_ownfiles.mjs
//   node dev/verify_ownfiles.mjs --break nogroup       # the defect, restored
//   node dev/verify_ownfiles.mjs --break openbydefault # tidy claim, untidy panel
//   node dev/verify_ownfiles.mjs --break nocount       # a triangle with no size on it
//   node dev/verify_ownfiles.mjs --break nopersist     # shut again on every reload
//
// A `--break` run EXPECTS to fail: exit 0 when something reddened, 1 when
// nothing did, because a break that changes nothing is itself a failing run.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no model.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, shot, errors } from './harness.mjs';

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
	nocount: [{
		file: 'js/daimond.js',
		find: "\t\t\tn.textContent = tn('files.rest_count', rest.length);",
		with: "\t\t\tn.textContent = '';   // --break nocount",
	}],
	nopersist: [{
		file: 'js/daimond.js',
		find: "\t\t\t\ttry { localStorage.setItem(LS_RESTGROUP, restOpen ? '1' : '0'); }",
		with: "\t\t\t\ttry { /* --break nopersist */ }",
	}],
};

function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
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
	await p.evaluate(() => {
		const b = document.querySelector('#panel-work [data-act="refresh"]');
		if (b) b.click();          // NOT page.click: a forced click is inert headless
	});
	await sleep(1200);
}

/// Everything the tree is currently saying, at whatever level it is showing.
const tree = () => p.evaluate(() => {
	const t = document.querySelector('#panel-work .files-tree');
	if (!t) return null;
	const clean = el => ((el.querySelector('.files-name') || {}).textContent || '')
		.replace(/^[^A-Za-z0-9._-]+/, '').trim();
	const head = t.querySelector('.files-rest-head');
	const body = t.querySelector('.files-rest-body');
	const countEl = t.querySelector('.files-rest-count');
	return {
		row:      !!head,
		label:    head ? (head.querySelector('.files-rest-label') || {}).textContent : '',
		count:    countEl ? countEl.textContent : '',
		expanded: head ? head.getAttribute('aria-expanded') : null,
		// `hidden` AND laid out: a body that is `hidden` but styled visible would
		// pass the attribute and still be on the screen.
		shown:    body ? !!body.offsetParent : null,
		// Direct children of the tree are the top level; the row's own wrapper is
		// a sibling of them, so its contents cannot leak into this list.
		top:      [...t.children].filter(c => c.classList.contains('files-row')).map(clean),
		inside:   body ? [...body.querySelectorAll('.files-row')].map(clean) : [],
		// Is the row LAST, under his own files rather than over them?
		last:     !!head && t.lastElementChild === head.parentElement,
	};
});

/// Press the row's head, from inside the page.
async function toggleRest() {
	await p.evaluate(() => {
		const h = document.querySelector('#panel-work .files-rest-head');
		if (h) h.click();
	});
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

// ── 1. The row is there, shut, and under his own files ───────────────────────
const t0 = await tree();
check('1a the tree carries the row', !!t0 && t0.row === true);
check('1b AND IT IS SHUT ON FIRST PAINT',
	!!t0 && t0.expanded === 'false' && t0.shown === false,
	t0 ? `aria-expanded=${t0.expanded} laid out=${t0.shown}` : 'no tree');
check('1c and it sits at the foot of the tree, under his own files',
	!!t0 && t0.last === true);
await shot(s, 'ownfiles-shut');

// ── 2. His own files did not move ────────────────────────────────────────────
//
// The whole tidying is worthless if it was paid for by burying his work.
check('2a HIS OWN FILES ARE AT THE TOP LEVEL',
	!!t0 && t0.top.includes('notes.md') && t0.top.includes('myproject'),
	t0 ? JSON.stringify(t0.top) : '');
check('2b and none of them was swept into the row',
	!!t0 && !t0.inside.includes('notes.md') && !t0.inside.includes('myproject'),
	t0 ? JSON.stringify(t0.inside) : '');
check('2c while it is shut, nothing of the rest is on the screen',
	!!t0 && !t0.top.includes('.daimond') && !t0.top.includes('.git') && t0.shown === false);

// ── 3. The count, which is what says whether opening it costs anything ───────
//
// Read BEFORE the row is opened: it is a promise about what is inside, and a
// count computed after the fact would be no promise at all.
const promised = t0 && /(\d+)/.test(t0.count) ? parseInt(t0.count.match(/(\d+)/)[1], 10) : -1;
check('3a the row says how many entries it holds', promised > 0, t0 ? JSON.stringify(t0.count) : '');

// Timed, because "it does not walk" is a claim about cost and the honest way to
// make it is with a clock. The rows inside the row were built from the SAME
// listing the tree was drawn from -- one `file_list` of the current directory,
// which happened before the row existed -- so pressing it lays out what is
// already in the DOM and asks the engine for nothing.
const pressed = Date.now();
await toggleRest();
const tookMs = Date.now() - pressed - 500;   // less the settle `toggleRest` sleeps
const t1 = await tree();
check('3b OPENING IT REVEALS EXACTLY WHAT IT PROMISED',
	!!t1 && t1.inside.length === promised,
	t1 ? `promised ${promised}, showed ${t1.inside.length}` : '');
check('3c and a fat .git is ONE entry in it, not its contents',
	!!t1 && t1.inside.includes('.git') && t1.inside.length < 20,
	t1 ? `${t1.inside.length} rows for a .git of ${GIT_OBJECTS} objects` : '');
check('3d and opening it lists nothing: no directory is walked to fill it',
	tookMs < 150, `${tookMs} ms to open over a .git of ${GIT_OBJECTS} objects`);

// ── 4. Nothing is concealed ──────────────────────────────────────────────────
check('4a `.daimond` IS THERE, WHICH IS THE WHOLE REQUEST',
	!!t1 && t1.inside.includes('.daimond'), t1 ? JSON.stringify(t1.inside) : '');
check('4b and so is every other dotfile the panel used to drop',
	!!t1 && ['.git', '.gitignore', '.env'].every(n => t1.inside.includes(n)),
	t1 ? JSON.stringify(t1.inside) : '');
check('4c and Daimond’s own working folders are in it too, not among his files',
	!!t1 && t1.inside.includes('mail') && t1.inside.includes('prompts')
		&& !t1.top.includes('mail') && !t1.top.includes('prompts'),
	t1 ? `inside ${JSON.stringify(t1.inside)} / top ${JSON.stringify(t1.top)}` : '');
check('4d the row is open and laid out', !!t1 && t1.expanded === 'true' && t1.shown === true);
await shot(s, 'ownfiles-open');

// ── 5. Once open it is an ordinary tree ──────────────────────────────────────
check('5a `.daimond` can be walked into', await clickRow('.daimond'));
await sleep(900);
const t2 = await tree();
check('5b and it lists like any other folder',
	!!t2 && t2.top.includes('skills'), t2 ? JSON.stringify(t2.top) : '');
check('5c a folder walked into is listed one level at a time',
	!!t2 && t2.top.length <= 4, t2 ? `${t2.top.length} rows` : '');
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
check('6a the open state is written down where the panel’s other state is',
	saved === '1', JSON.stringify(saved));

check('6b the session came back from a reload', await reboot());
await openWorkspace();
const t3 = await tree();
check('6c IT COMES BACK OPEN AFTER A RELOAD',
	!!t3 && t3.expanded === 'true' && t3.shown === true,
	t3 ? `aria-expanded=${t3.expanded} laid out=${t3.shown}` : 'no tree');
check('6d and his own files are still at the top level where he left them',
	!!t3 && t3.top.includes('notes.md'), t3 ? JSON.stringify(t3.top) : '');

// Shut it again, and that is remembered too — the preference is a preference in
// both directions, not a one-way door.
await toggleRest();
check('6e the session came back from the second reload', await reboot());
await openWorkspace();
const t4 = await tree();
check('6f and shutting it again is remembered as well',
	!!t4 && t4.expanded === 'false' && t4.shown === false,
	t4 ? `aria-expanded=${t4.expanded}` : 'no tree');

// ── 7. The console ───────────────────────────────────────────────────────────
const errs = errors(s).filter(e => !/favicon|404|401|402|502|Bad Gateway|Account service|net::ERR/.test(e));
check('7 nothing throws while all this happens', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	// A break that reddened nothing proves nothing about the check it names.
	console.log(bad.length ? `--break ${BREAK}: reddened ${bad.length} check(s), as it must`
		: `--break ${BREAK}: CHANGED NOTHING — the check it names is not testing what it says`);
	process.exit(bad.length ? 0 : 1);
}
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);

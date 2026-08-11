// verify_attachroot.mjs — an attachment remembers which workspace it was made in.
//
// THE DEFECT THIS PINS. An attachment was recorded as a bare path. A folder
// attached while the MACHINE workspace was open therefore came back as
// `books/elearnity/CheapThinking` with nothing saying where that was, and when the
// Diamond was next opened against the BROWSER sandbox the path went into the
// scope anyway: `diamond_bounds` allowed it, the tool door let the daimon reach
// for it, and the store answered `NotFoundError`. Allowed and absent. The daimon
// reported an empty book-shaped container and offered to write that into the
// crystal, which is what a person reads as "my Diamond is broken" — when in fact
// the Diamond was fine and the link had come loose from its root.
//
// FOUR PROPERTIES, and the fourth is the one that protects the user's existing work:
//
//   1. An attachment RECORDS the workspace it was made in.
//   2. One recorded against the other workspace is NOT in the scope handed to the
//      engine — no phantom permission to somewhere that is not there.
//   3. It is SHOWN as being elsewhere, not silently dropped. It is the user's own
//      attachment; they may simply have the other workspace closed.
//   4. An attachment written BEFORE roots were recorded still works — in scope,
//      and still detachable by the button that now writes a root. Refusing those
//      would empty the workspace of every Diamond that predates this.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// damaged copy of daimond.js to the real page through `page.route`; the run is
// then expected to FAIL. A break whose anchor does not match aborts rather than
// passing quietly — a check proved against code that was never broken is not
// proved at all.
//
//   node dev/verify_attachroot.mjs --break rootless   # 1 fails: no root recorded
//   node dev/verify_attachroot.mjs --break noscope    # 2 fails: elsewhere is in scope
//   node dev/verify_attachroot.mjs --break silent     # 3 fails: says nothing about where
//   node dev/verify_attachroot.mjs --break strict     # 4 fails: legacy links dropped
//   node dev/verify_attachroot.mjs                    # and then, clean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const BREAKS = {
	// The old behaviour: a path with no workspace on it.
	rootless: {
		file: 'js/daimond.js',
		find: `	function rootedRef(kind, path) {
		var r = currentRoot();
		return kind + ':[' + (r.kind === 'machine' ? 'machine:' + r.name : 'browser')
			+ ']' + path;
	}`,
		with: `	function rootedRef(kind, path) {
		return kind + ':' + path;
	}`,
	},
	// The scope stops filtering, so a path from the other workspace is granted.
	noscope: {
		file: 'js/daimond.js',
		find: `				var here = list.filter(function (a) { return a.here !== false; });`,
		with: `				var here = list;`,
	},
	// The tile stops saying where an unreachable attachment lives.
	silent: {
		file: 'js/daimond.js',
		find: `			openBtn.title = away
				? t('dws.not_here', { where: refWhere(l.other) })`,
		with: `			openBtn.title = away
				? (l.rel || '')`,
	},
	// Legacy rootless links treated as unreachable, which empties old Diamonds.
	strict: {
		file: 'js/daimond.js',
		find: `		if (!p.root) return true;                 // written before roots were recorded`,
		with: `		if (!p.root) return false;`,
	},
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

let ok = 0, bad = 0;
const check = (name, pass, detail) => {
	if (pass) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const s = await open({ name: 'attachroot', signIn: false, connect: false });
const { page } = s;

if (BREAK) {
	const spec = BREAKS[BREAK];
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	const body = src.replace(spec.find, spec.with);
	await page.route('**/' + spec.file, r => r.fulfill({
		status: 200, contentType: 'application/javascript', body,
	}));
}

// The stub has to be in place before the page loads it.
await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
const { signInAs, connectMock } = await import('./harness.mjs');
await signInAs(s, 'attachroot');
await connectMock(s);
await page.waitForTimeout(1500);

// A Diamond, made the way a person makes one so the rail knows about it.
await page.click('#new-diamond-btn', { force: true });
await page.waitForSelector('.dlg-input', { timeout: 10000 });
await page.fill('.dlg-input', 'Roots');
await page.click('.dlg-ok', { force: true });
await page.waitForTimeout(2000);
await page.$$eval('.diamond-box', els => els[0] && els[0].click());
await page.waitForTimeout(1200);

const id = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'Roots');
	return d ? d.id : '';
});
check('a Diamond to attach things to', !!id, id);

// ── 1. Attaching records the workspace ───────────────────────────────
// Through the app's own control, not by writing a link: what is under test is
// what the BUTTON records.
await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool('file_write', JSON.stringify({ path: 'papers/one.md', content: '# one\n' }));
});
await page.evaluate(() => DaimondPanels.show('work'));
await page.waitForTimeout(700);
// The tree is listed when the panel opens, so a file written behind its back is
// not in it. Press the panel's own refresh rather than filtering: the filter
// surfaces the FILE, and a file row carries no attach control — which is the gap
// notes4 asks to close and is not what this verifier is about.
await page.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
await page.waitForTimeout(1200);
let attachedIt = false;
for (const row of await page.$$('#panel-work .files-row')) {
	const nm = await row.$eval('.files-name', e => e.textContent).catch(() => '');
	// The row's name carries a folder glyph before the name — matched on the
	// name, not on the decoration.
	if (nm.replace(/^[^A-Za-z0-9._-]+/, '').trim() === 'papers') {
		const hold = await row.$('.files-hold');
		if (hold) { await hold.click({ force: true }); attachedIt = true; }
		break;
	}
}
check('the folder could be attached through its own control', attachedIt,
	attachedIt ? '' : 'no papers row with an attach control');
await page.waitForTimeout(1200);

const refs = await page.evaluate(async (did) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return JSON.parse(await app.links_touching('diamond:' + did) || '[]').map(l => l.other);
}, id);
const made = refs.find(r => /papers/.test(r)) || '';
check('THE ATTACHMENT RECORDS THE WORKSPACE IT WAS MADE IN',
	/^dir:\[browser\]papers/.test(made), made || 'nothing was attached');

// ── 2 and 3. An attachment from the OTHER workspace ──────────────────
// Written directly, because the only other way to make one is to open a real
// folder, and a native directory picker cannot be driven from a test.
await page.evaluate(async (did) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.add_link(did, 'diamond:' + did, 'dir:[machine:usr]books/elearnity/CheapThinking',
		'holds', '', 'user');
	// And one written before roots existed at all, which must keep working.
	await app.add_link(did, 'diamond:' + did, 'dir:legacy/notes', 'holds', '', 'user');
}, id);
await page.waitForTimeout(900);

const scope = await page.evaluate(async (did) => await window.DaimondDiamond.bounds(did), id);
check('THE OTHER WORKSPACE IS NOT IN THE SCOPE HANDED TO THE ENGINE',
	!scope.attached.some(p => /CheapThinking/.test(p)),
	JSON.stringify(scope.attached));
check('and what IS here still is',
	scope.attached.some(p => /^papers/.test(p)),
	JSON.stringify(scope.attached));
check('A LINK WRITTEN BEFORE ROOTS WERE RECORDED IS STILL IN SCOPE',
	scope.attached.some(p => p === 'legacy/notes'),
	JSON.stringify(scope.attached));

// It is shown, and it says where it lives.
await page.evaluate(() => {
	const strip = document.getElementById('arte-strip');
	if (strip) { strip.dataset.open = '1'; }
});
await page.evaluate(() => window.DaimondArtefacts && DaimondArtefacts.render());
await page.waitForTimeout(900);
const tiles = await page.$$eval('.arte-open', els => els.map(e => ({
	text: e.textContent.trim(), title: e.getAttribute('title') || '',
	away: e.classList.contains('away'),
})));
const stray = tiles.find(x => /CheapThinking/.test(x.text)) || {};
check('THE UNREACHABLE ONE IS SHOWN, NOT SILENTLY DROPPED',
	!!stray.text, JSON.stringify(tiles.map(t => t.text)));
check('and it says WHERE it lives rather than reading as empty',
	/machine|folder/i.test(stray.title || ''), JSON.stringify(stray.title));
check('and it is marked as being elsewhere', stray.away === true, JSON.stringify(stray));
const mine = tiles.find(x => /papers/.test(x.text)) || {};
check('while an attachment in THIS workspace is not marked away',
	mine.away === false, JSON.stringify(mine));

// ── 4. The toggle still finds a legacy link ──────────────────────────
const before = await page.evaluate(async (did) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return JSON.parse(await app.links_touching('diamond:' + did) || '[]').length;
}, id);
await page.evaluate(async () => {
	// The same path the old link names, offered to the control that now writes a root.
	const rows = [...document.querySelectorAll('.arte-row')];
	const row = rows.find(r => /legacy\/notes/.test(r.textContent));
	const drop = row && row.querySelector('.arte-drop');
	if (drop) drop.click();
});
await page.waitForTimeout(1000);
const after = await page.evaluate(async (did) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const ls = JSON.parse(await app.links_touching('diamond:' + did) || '[]');
	return { n: ls.length, refs: ls.map(l => l.other) };
}, id);
check('A LEGACY ATTACHMENT CAN STILL BE TAKEN OFF',
	after.n === before - 1 && !after.refs.some(r => /legacy\/notes/.test(r)),
	`${before} → ${after.n}: ${JSON.stringify(after.refs)}`);

await shot(s, 'attachroot');
console.log(`\n${ok} ok, ${bad} failed`);
await s.browser.close();
process.exit(bad ? 1 : 0);

// The Diamond's workspace: the set of files and folders its daimon may open.
//
// It is a VIEW, not a container. The files live in the one workspace and the
// Diamond points at them, so the same folder attached to two Diamonds is one
// folder — and taking it out of a Diamond takes nothing off disk. That last
// point is the one this file exists to hold: a folder tree makes "detach" look
// like "delete" in a way a strip of chips never did, so the tree must offer no
// delete on a row it does not own, and a detach must leave the bytes alone.
//
// What is pinned here:
//   * the scope switch is offered only while a Diamond is open, and persists;
//   * the Diamond tree is exactly its own directory plus what is attached;
//   * a directory can be attached and detached, and detaching is not deleting;
//   * two attachments sharing a basename are told apart;
//   * the strip above the steer box counts the workspace.
//
// Run with dev/serve.mjs up. No gateway needed.
import { open, shot, signInAs, newChat } from './harness.mjs';

const s = await open({ name: 'dworkspace' });
const { page } = s;
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; };

// Every expected string is asked of the running app, never spelled here: this
// app ships eight languages, and a test that hard-codes English is a test that
// only passes in one of them.
const T  = (k, v) => page.evaluate(([k, v]) => DaimondI18n.t(k, v || undefined), [k, v || null]);
const TN = (k, n) => page.evaluate(([k, n]) => DaimondI18n.tn(k, n), [k, n]);

/// Everything the store holds about this Diamond's links.
const linksOf = () => page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const rows = JSON.parse(await app.list_diamonds());
	const links = JSON.parse(await app.links_touching('diamond:' + rows[0].id) || '[]');
	return links.map(l => ({ other: l.other, rel: l.rel, by: l.by }));
});

/// The tree as the user sees it.
const rows = () => page.$$eval('.files-tree .files-row', els => els.map(e => ({
	name:      (e.querySelector('.files-name') || {}).textContent || '',
	path:      e.dataset.path || '',
	attached:  e.dataset.attached || '',
	elsewhere: (e.querySelector('.files-elsewhere') || {}).title || '',
	readonly:  (e.querySelector('.files-badge.files-ro') || {}).textContent || '',
	canDelete: !!e.querySelector('.files-del'),
	detach:    (e.querySelector('.files-hold') || {}).title || '',
})));

const scopeRow = () => page.evaluate(() => {
	const el = document.querySelector('.files-scope');
	if (!el) return { present: false };
	return {
		present: true,
		shown:   el.style.display !== 'none' && !!el.offsetParent,
		chips:   Array.from(el.querySelectorAll('.files-scope-chip')).map(c => ({
			scope: c.dataset.scope, text: c.textContent, active: c.classList.contains('active'),
			pressed: c.getAttribute('aria-pressed'),
		})),
	};
});

const openPanel = async () => {
	await page.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
	await page.waitForTimeout(600);
	// Selecting a Diamond restores its arrangement, which can take the panel with
	// it; showing it again does not necessarily re-list. The refresh button is
	// what a user reaches for, and it is the only thing that always re-lists.
	await page.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
	await page.waitForTimeout(700);
};
const setScope = async (which) => {
	await page.click(`.files-scope-chip[data-scope="${which}"]`, { force: true });
	await page.waitForTimeout(900);
};

// ── Files to point at ──────────────────────────────────────────────────
// Written through the real tool, so they exist the way the user's own do.
await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const seed = [
		['a/notes/one.md',  '# one\n'],
		['b/notes/two.md',  '# two\n'],
		['docs/spec.md',    '# spec\n'],
		['loose/other.md',  '# other\n'],
		['loose/ref.md',    '# reference\n'],
	];
	for (const [p, c] of seed) await app.run_tool('file_write', JSON.stringify({ path: p, content: c }));
});
await page.waitForTimeout(400);

// ── With no Diamond open there is one tree, so no switch ───────────────
await openPanel();
let sc = await scopeRow();
check(sc.present && !sc.shown, `no Diamond open: the scope row is not offered (${JSON.stringify(sc)})`);

// ── A Diamond, which is what makes the second tree exist ───────────────
await page.click('#new-diamond-btn', { force: true });
await page.waitForSelector('.dlg-input', { timeout: 10000 });
await page.fill('.dlg-input', 'Ship a CSV parser');
await page.click('.dlg-ok', { force: true });
await page.waitForTimeout(900);
await openPanel();

sc = await scopeRow();
const [wordAll, wordOne] = [await T('dws.mode_all'), await T('dws.mode_diamond')];
check(sc.shown, 'a Diamond is open: the scope row appears');
check(sc.chips.length === 2, `it offers two trees (${JSON.stringify(sc.chips)})`);
check(sc.chips[0] && sc.chips[0].text.includes(wordAll), `one is "${wordAll}"`);
check(sc.chips[1] && sc.chips[1].text.includes(wordOne), `the other is "${wordOne}"`);
check(sc.chips[0] && sc.chips[0].active, 'and nothing has changed under the user: Everything is still showing');

const everything = (await rows()).map(r => r.path);
check(everything.includes('docs') && everything.includes('loose'),
	`the whole workspace is what it shows (${everything.join(', ')})`);

// ── This Diamond: its own directory, and nothing it has not been given ─
await setScope('diamond');
sc = await scopeRow();
check(sc.chips[1] && sc.chips[1].active && sc.chips[1].pressed === 'true',
	'the switch reports which tree is showing');
check(await page.$eval('.files-path', e => e.textContent) === await T('dws.title'),
	'the path line names the Diamond’s workspace rather than claiming to be a directory');

let r = await rows();
let paths = r.map(x => x.path);
const id = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return JSON.parse(await app.list_diamonds())[0].id;
});
check(paths.includes(`diamonds/${id}/crystal.json`),
	`the Diamond’s own directory is there, as real contents (${paths.join(', ')})`);
check(!paths.some(p => /^(docs|loose|a|b)$/.test(p)),
	'and nothing else in the workspace is');
check(await page.$$eval('.files-dws-hint', els => els.length) === 1,
	'an empty workspace says what a workspace is for');
check((await page.$eval('.files-dws-hint', e => e.textContent)) === await T('dws.empty'),
	'in the app’s own words');

// ── Attaching a directory ──────────────────────────────────────────────
// The paperclip superseded the ◈ here on 2026-08-11 (ATTACH_CONTRACT.md §4):
// one control, one hover text, regardless of what it is about to do.
await setScope('all');
await page.waitForTimeout(300);
const dirBtnTitle = await page.$eval('.files-row[data-path="docs"] [data-act="attach"]', b => b.title);
check(dirBtnTitle === await T('attach.to_focus'),
	`a folder offers to attach to the open focus: ${JSON.stringify(dirBtnTitle)}`);
await page.click('.files-row[data-path="docs"] [data-act="attach"]', { force: true });
await page.waitForTimeout(900);

let links = await linksOf();
// A reference now carries the workspace it was recorded in
// (`dir:[browser]docs`), because a path without its root was allowed and absent
// -- see dev/verify_attachroot.mjs. These checks are about WHAT IS ATTACHED, so
// they compare the thing named and ignore the workspace; an assertion pinned to
// the old spelling reports "no link was written" for a change of format, which
// is the opposite of what happened.
const names = (ref) => String(ref).replace(/^(file|dir):(\[[^\]]*\])?/, '');
const isDir = (ref) => String(ref).indexOf('dir:') === 0;
const namesDir = (ref, path) => isDir(ref) && names(ref) === path;

const dirLink = links.filter(l => namesDir(l.other, 'docs'));
check(dirLink.length === 1, `one link was written for the folder (${JSON.stringify(links)})`);
check(dirLink[0] && dirLink[0].rel === 'holds', `it says "holds" (${JSON.stringify(dirLink[0])})`);
check(dirLink[0] && dirLink[0].by === 'user', 'and that the user did it, not a fold');
check(await page.$eval('.files-row[data-path="docs"] [data-act="attach"]',
	b => b.classList.contains('on') && b.getAttribute('aria-pressed') === 'true'),
	'the control reports the state it just reached');
check(await page.$eval('.files-row[data-path="docs"] [data-act="attach"]', b => b.title)
	=== await T('attach.to_focus'),
	'and the same hover text takes it back out -- the control, not the label, says which');

// Two folders with the same basename: the case that makes a basename useless.
for (const parent of ['a', 'b']) {
	await page.click(`.files-row[data-path="${parent}"] .files-name`, { force: true });
	await page.waitForTimeout(700);
	await page.click(`.files-row[data-path="${parent}/notes"] [data-act="attach"]`, { force: true });
	await page.waitForTimeout(700);
	await page.click('[data-act="up"]', { force: true });
	await page.waitForTimeout(700);
}
links = await linksOf();
check(links.some(l => namesDir(l.other, 'a/notes')) && links.some(l => namesDir(l.other, 'b/notes')),
	`both same-named folders are attached (${links.map(l => l.other).join(', ')})`);

// A file joins the way it always did: the paperclip on the open file.
await page.fill('.files-filter-input', 'other');
await page.waitForTimeout(900);
for (const row of await page.$$('.files-row')) {
	const nm = await row.$eval('.files-name', e => e.textContent).catch(() => '');
	if (nm.includes('other.md')) { await row.click({ force: true }); break; }
}
await page.waitForSelector('[data-act="attach"]', { timeout: 8000 });
await page.waitForTimeout(400);
await page.click('[data-act="attach"]', { force: true });
await page.waitForTimeout(800);
await page.click('[data-act="back"]', { force: true });
await page.waitForTimeout(400);
await page.fill('.files-filter-input', '');
await page.waitForTimeout(800);

// One attached to be consulted rather than worked on, which is what the tool
// door calls read-only.
await page.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.add_link(id, 'diamond:' + id, 'file:loose/ref.md', 'consulted', '', 'user');
	document.dispatchEvent(new CustomEvent('daimond-links-changed'));
}, id);
await page.waitForTimeout(900);

// ── The tree in Diamond mode: exactly what is in the workspace ─────────
await setScope('diamond');
r = await rows();
paths = r.map(x => x.path).sort();
// A Diamond's own directory is now three things: the memory, the page that draws
// it, and the snapshots. The page is there from the first time the Diamond is
// opened -- one whose page is missing is given the shipped default AND it is
// written, so a default can be diffed against the edit that broke it.
const want = [
	`diamonds/${id}/crystal.json`, `diamonds/${id}/crystal.html`, `diamonds/${id}/versions`,
	'a/notes', 'b/notes', 'docs', 'loose/other.md', 'loose/ref.md',
].sort();
check(JSON.stringify(paths) === JSON.stringify(want),
	`the tree is its own directory plus what is attached, and nothing else\n        got:  ${paths.join(', ')}\n        want: ${want.join(', ')}`);

const att = r.filter(x => x.attached);
check(att.length === 5, `five things are attached (${att.length})`);
const elsewhereWord = await T('dws.elsewhere');
check(att.every(x => x.elsewhere.startsWith(elsewhereWord)),
	`each says it lives elsewhere in the workspace (${JSON.stringify(att.map(x => x.elsewhere))})`);
check(att.every(x => x.elsewhere.includes(x.path)),
	'and where, exactly — a basename alone would not say');
check(att.every(x => !x.canDelete),
	'no attached row offers to delete the file it points at');
check(r.filter(x => !x.attached).every(x => x.canDelete),
	'while the Diamond’s own files are managed as usual');

const notes = att.filter(x => /notes$/.test(x.path)).map(x => x.name.replace(/^\S+\s/, ''));
check(notes.length === 2 && notes[0] !== notes[1],
	`two folders called "notes" are told apart: ${JSON.stringify(notes)}`);
check(notes.every(n => n.includes('/')),
	'by as much of the path as it takes, not by a number');
check(att.filter(x => x.path === 'docs')[0].name.replace(/^\S+\s/, '') === 'docs',
	'while an unambiguous one keeps its plain name');

// Inside an attached folder the same rule holds: these are the workspace's
// files, borrowed. The Diamond may work on them; it may not destroy them from
// the view that only points at them.
await page.click('.files-row[data-path="a/notes"] .files-name', { force: true });
await page.waitForTimeout(800);
let inside = await rows();
check(inside.length === 1 && inside[0].path === 'a/notes/one.md',
	`an attached folder can be opened (${JSON.stringify(inside.map(x => x.path))})`);
check(inside.every(x => !x.canDelete),
	'and what is inside it offers no delete either');
await page.click('[data-act="up"]', { force: true });
await page.waitForTimeout(800);
check((await page.$eval('.files-path', e => e.textContent)) === await T('dws.title'),
	'going up from an attached folder lands back in the workspace, not above it');

// The same folder in the Everything tree is the user's own to manage.
await setScope('all');
await page.click('.files-row[data-path="a"] .files-name', { force: true });
await page.waitForTimeout(800);
inside = await rows();
check(inside.length === 1 && inside[0].canDelete,
	`the same files are managed as usual in the whole workspace (${JSON.stringify(inside)})`);
await page.click('[data-act="up"]', { force: true });
await page.waitForTimeout(700);
await setScope('diamond');
r = await rows();
att.length = 0;
Array.prototype.push.apply(att, r.filter(x => x.attached));

const roWord = await T('dws.readonly');
const ro = att.filter(x => x.path === 'loose/ref.md')[0];
check(ro && ro.readonly === roWord, `one attached to be consulted is marked read only (${JSON.stringify(ro && ro.readonly)})`);
check(att.filter(x => x.path === 'loose/other.md')[0].readonly === '',
	'and one attached to be worked on is not');

// ── The strip above the steer box counts the workspace ─────────────────
const strip = await page.$eval('#arte-strip', e => ({ shown: e.style.display !== 'none', text: e.textContent, title: e.title }));
check(strip.shown, 'the strip above the steer box is showing');
check(strip.text === '◈ ' + await TN('dws.count', 5),
	`it counts what is in this Diamond’s workspace: ${JSON.stringify(strip.text)}`);
check(strip.title === await T('dws.title'), `and calls it that: ${JSON.stringify(strip.title)}`);

await shot(s, 'dworkspace-tree');

// ── Detach is not delete ───────────────────────────────────────────────
const detachTitle = await page.$eval('.files-row[data-path="docs"] .files-hold', b => b.title);
check(detachTitle === await T('dws.detach_dir', { name: 'Ship a CSV parser' }),
	`the only control on an attached folder is the one that takes it out: ${JSON.stringify(detachTitle)}`);
await page.click('.files-row[data-path="docs"] .files-hold', { force: true });
await page.waitForTimeout(1000);

links = await linksOf();
check(!links.some(l => namesDir(l.other, 'docs')), 'detaching drops the link');
const survived = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const list = await app.run_tool('file_list', JSON.stringify({ path: 'docs' }));
	const read = await app.run_tool('file_read', JSON.stringify({ path: 'docs/spec.md' }));
	return { list: String(list), read: String(read) };
});
check(/spec\.md/.test(survived.list), `the folder is still on disk (${JSON.stringify(survived.list)})`);
check(/# spec/.test(survived.read), 'and so is the file in it, unchanged');
// The probe above is the whole safety claim, so prove it can tell a file that is
// there from one that is not: a read that answers "fine" for a deleted file
// would make the check above meaningless.
const oracle = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool('file_write', JSON.stringify({ path: 'docs/proof.md', content: '# spec\n' }));
	const there = String(await app.run_tool('file_read', JSON.stringify({ path: 'docs/proof.md' })));
	await app.run_tool('file_delete', JSON.stringify({ path: 'docs/proof.md' }));
	const gone = String(await app.run_tool('file_read', JSON.stringify({ path: 'docs/proof.md' })));
	return { there, gone };
});
check(/# spec/.test(oracle.there) && !/# spec/.test(oracle.gone),
	`and the probe knows the difference: a deleted file reads back as gone (${JSON.stringify(oracle.gone.slice(0, 60))})`);
paths = (await rows()).map(x => x.path);
check(!paths.includes('docs'), 'and it has left this Diamond’s workspace');

// Detaching a FILE from the tree does the same.
await page.click('.files-row[data-path="loose/other.md"] .files-hold', { force: true });
await page.waitForTimeout(1000);
links = await linksOf();
check(!links.some(l => l.other === 'file:loose/other.md'), 'a file detaches from the tree too');
const fileLives = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return String(await app.run_tool('file_read', JSON.stringify({ path: 'loose/other.md' })));
});
check(/# other/.test(fileLives), 'and is still on disk afterwards');
check((await page.$eval('#arte-strip', e => e.textContent)) === '◈ ' + await TN('dws.count', 3),
	'the strip counts down with it');

// ── Closing the Diamond closes the second tree ─────────────────────────
// A chat is not a Diamond, so going to one closes the Diamond — and with it the
// tree that was about the Diamond. The panel must not be left showing a
// workspace nobody is in.
await newChat(s);
await page.waitForTimeout(800);
await openPanel();
sc = await scopeRow();
check(!sc.shown, `closing the Diamond withdraws the switch (${JSON.stringify(sc)})`);
paths = (await rows()).map(x => x.path);
check(paths.includes('docs') && paths.includes('loose'),
	`and the tree is the whole workspace again (${paths.join(', ')})`);

// ── The choice is the device's, and survives a reload ──────────────────
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'dworkspace');
await page.waitForTimeout(3000);
await page.evaluate(() => {
	const row = Array.from(document.querySelectorAll('#diamond-list .diamond-box'))
		.find(e => /Ship a CSV parser/.test(e.textContent));
	if (row) row.click();
});
await page.waitForTimeout(1200);
await openPanel();
sc = await scopeRow();
check(sc.shown && sc.chips[1] && sc.chips[1].active,
	`the tree the user chose is the tree they get back (${JSON.stringify(sc.chips)})`);
paths = (await rows()).map(x => x.path);
check(paths.includes(`diamonds/${id}/crystal.json`) && !paths.includes('docs'),
	`and it is that Diamond’s workspace (${paths.join(', ')})`);

// ── Eight languages, and the row is on screen in all of them ───────────
// The scope chips never rebuild on their own: they sit in the panel for as long
// as it is open, which is the shape of every hardcoded-English defect this app
// has had. So the words must change under a locale change, without a reload.
const before = (await scopeRow()).chips.map(c => c.text);
await page.evaluate(async () => { await DaimondI18n.setLocale('fr'); });
await page.waitForTimeout(1200);
const after = (await scopeRow()).chips.map(c => c.text);
check(after[0] === await T('dws.mode_all') && after[1].includes(await T('dws.mode_diamond')),
	`a language change reaches the scope row: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
check(JSON.stringify(before) !== JSON.stringify(after),
	'and it really did change, so the check is not passing on English twice');
await page.evaluate(async () => { await DaimondI18n.setLocale('en'); });
await page.waitForTimeout(900);

// A dev server with no gateway behind it answers 502 to the account polls; that
// is the environment, not the page. Anything the PAGE itself threw still counts.
const errs = (s.errs || []).filter(e =>
	!/favicon/i.test(e) && !/502|Bad Gateway|Failed to load resource/i.test(e));
check(errs.length === 0, `nothing threw along the way (${errs.slice(0, 3).join(' | ')})`);

await shot(s, 'dworkspace-reload');
console.log(bad ? `\n${bad} FAILED` : `\nALL PASS`);
await s.close();
process.exit(bad ? 1 : 0);

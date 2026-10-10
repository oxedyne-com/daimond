#!/usr/bin/env node
// gateway: none
// #17 -- the fold shows its stages as a transcript tile, not an opaque spinner.
// D-20261010-01 items 3, 5, 6 -- every exit settles the tile and keeps a row in the
// source chat; the label names where the chat is going; a whole fold of an ordinary
// chat trashes it, and Undo takes the fold's one version back and the chat out.
// Pure Node: it reads source structure and lifts the stage helpers to run them
// against stubs. Print in the verify-verb format ('  ok   '/'  FAIL ').
//
// `--root=<dir>` reads www/js/daimond.js and www/i18n/ under <dir> instead of the
// tree, so a check can be seen RED on an older tree.
//
// Declared breaks: notiles, leak, dotkeys
// `--break notiles` drops the foldStage* wiring from foldChatInto -- the opaque spinner as it shipped.
// `--break leak` leaves the fold tile unsettled on the commit throw path.
// `--break dotkeys` restores the dotted i18n keys the code does not read.
'use strict';
const { readFileSync } = await import('node:fs');
const { join } = await import('node:path');

const ROOT = process.argv.find(a => a.startsWith('--root='))?.slice(7) || '.';
const JS = join(ROOT, 'www/js/daimond.js');
const CATS = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];
const BREAKS = {
	notiles: 'drop the foldStage* wiring from foldChatInto (restores the opaque spinner)',
	leak: 'leave the fold tile unsettled on the commit throw path',
	dotkeys: 'restore the dotted i18n keys the code does not read',
};
const BREAK = process.argv.find(a => a.startsWith('--break='))?.slice(8)
	|| (process.argv[2] === '--break' ? process.argv[3] : null);
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}' -- this verifier declares notiles, leak, dotkeys`);
	process.exit(2);
}

let pass = 0, fail = 0;
function ok(name) { console.log('  ok   ' + name); pass++; }
function bad(name) { console.log('  FAIL ' + name); fail++; }
function check(cond, name) { (cond ? ok : bad)(name); }
// The text of a function, from its `function name(` to the next blank line at its indent.
function fnText(s, name) {
	const i = s.indexOf('function ' + name + '(');
	if (i < 0) return '';
	const j = s.indexOf('\n\t}\n', i);
	return s.slice(i, j < 0 ? undefined : j + 3);
}

let src = readFileSync(JS, 'utf-8');
if (BREAK === 'notiles')
	src = src.replace(/foldStageSay\(frun, 'read'\);[\s\S]*?foldStageSay\(frun, 'propose'\);/, '')
		.replace(/foldStageSay\(frun, 'commit'\);/, '')
		.replace(/foldStageFail\(frun, e\);/g, '')
		.replace(/foldSettle\(frun, 'done'/, 'void (frun, \'done\'');
if (BREAK === 'leak')
	src = src.replace(/(setCrystalStatus\(friendlyError\(e\)\);\n\t*)foldStageFail\(frun, e\);/, '$1');

// 1. the helpers exist and the fold path says all three stages
check(/function foldStageTile\(/.test(src), 'foldStageTile exists');
check(/function foldStageSay\(/.test(src), 'foldStageSay exists');
check(/function foldSettle\(/.test(src), 'foldSettle exists');
check(/function foldStageFail\(/.test(src), 'foldStageFail exists');
const foldFn = src.slice(src.indexOf('async function foldChatInto('),
	src.indexOf('async function undoFold'));
check(/foldStageSay\(frun, 'read'\)/.test(foldFn)
	&& /foldStageSay\(frun, 'propose'\)/.test(foldFn)
	&& /foldStageSay\(frun, 'commit'\)/.test(foldFn),
	'fold says read, propose and commit');
check(/foldSettle\(frun, 'done'/.test(foldFn), 'fold settles the tile on the done path');

// 2. item 3: every exit settles
const commitAt = foldFn.indexOf('commitFold(diamondId, st)');
const commitCatch = foldFn.slice(commitAt, foldFn.indexOf('return;', commitAt));
check(/foldStageFail\(frun, e\)/.test(commitCatch), 'item 3: the commit throw path settles the tile');
const proposeAt = foldFn.indexOf('fa.fold_propose(');
check(/foldStageFail\(frun, e\)/.test(foldFn.slice(proposeAt, foldFn.indexOf('return;', proposeAt))),
	'item 3: the propose throw path settles the tile');
check(/foldSettle\(frun, 'unchanged'/.test(foldFn) && /t\('fold\.stage_unchanged'\)/.test(foldFn),
	'item 3: a fold that changed nothing says so');
check(/foldSettle\(frun, 'empty'/.test(foldFn), 'item 3: a fold of empty turns settles the tile');
const tileFn = fnText(src, 'foldStageTile');
check(tileFn && !/return null/.test(tileFn) && /_chat\s*=/.test(tileFn),
	'item 3: the tile is made on every face, not only the daimon face');
check(/_foldRun/.test(fnText(src, 'foldFailed')) && /foldStageFail\(_foldRun/.test(fnText(src, 'foldFailed')),
	'item 3: foldFailed settles the running fold');

// 3. the helpers behave: lifts with stubs
const t = (k, v) => ({ 'fold.stage_read': 'reading', 'fold.stage_propose': 'reducing',
	'fold.stage_commit': 'writing', 'fold.stage_failed': 'Fold failed', 'fold.stage_done': 'Folded',
	'fold.stage_unchanged': 'Nothing changed' }[k] || k);
const friendlyError = (e) => String(e && e.message || e);
const mkRun = (chat) => {
	const r = { removed: 0, body: '', peek: '', _chat: chat, _diamondId: 'd1', _t0: 0 };
	r.classList = { remove: () => { r.removed++; } };
	r._body = { set textContent(v) { r.body = v; } };
	return r;
};
const sayFn = fnText(src, 'foldStageSay');
const say = new Function('t', 'run', 'key', sayFn + '\nreturn foldStageSay(run, key);');
const r0 = mkRun(null);
say(t, r0, 'read');
check(r0.body === 'reading', 'stage key is said onto the tile body');
r0.body = '';
say(t, r0, 'nope');
check(r0.body === '', 'unknown stage key leaves the tile alone');

const settleSrc = fnText(src, 'foldSettle');
const failSrc = fnText(src, 'foldStageFail');
const lift = new Function('t', 'friendlyError', 'tilePeek', 'newMid', 'touchChat', 'persistChats',
	'appendError', 'appendNote', 'daimonOnScreen', 'foldLens', 'noticeDialog', 'current',
	(settleSrc || 'function foldSettle() {}') + '\n' + failSrc
	+ '\nreturn { settle: typeof foldSettle === "function" ? foldSettle : null, fail: foldStageFail };');
const dialogs = [];
const env = lift(t, friendlyError, (tile, text) => { tile.peek = String(text); }, () => 'm',
	() => {}, () => {}, () => {}, () => {}, () => false, () => {},
	(title, body) => dialogs.push([title, body]), null);
const chatA = { id: 'c1', messages: [] };
const r1 = mkRun(chatA);
env.fail(r1, new Error('boom'));
check(r1.removed === 1 && /boom/.test(r1.peek), 'fail settles the tile and says the error');
check(chatA.messages.length === 1 && chatA.messages[0].role === 'error_log'
	&& /boom/.test(chatA.messages[0].content),
	'item 3: a failed fold leaves an error row in the source chat');
check(dialogs.length === 1 && /boom/.test(dialogs[0][1]), 'item 3: a failed fold holds a dialog until read');
env.fail(r1, new Error('again'));
check(r1.removed === 1 && chatA.messages.length === 1, 'item 3: a tile settles once');
if (env.settle) {
	const chatB = { id: 'c2', messages: [] };
	const r2 = mkRun(chatB);
	env.settle(r2, 'done', 'Folded into X.');
	check(r2.removed === 1 && chatB.messages.length === 1 && chatB.messages[0].role === 'note_log',
		'item 3: a landed fold leaves a note row in the source chat');
} else bad('item 3: a landed fold leaves a note row in the source chat');

// 4. item 5: the label names the Diamond, in every catalogue, and the dead keys are gone
check(/t\('fold\.proposing', \{ diamond:/.test(foldFn), 'item 5: the fold label is given the Diamond name');
const DEAD = ['fold.proposed_toast', 'fold.proposed_elsewhere', 'fold.pending_badge', 'diff.proposed',
	'diff.proposed_into', 'fold.keys_lost', 'fold.committed_fresh'];
let allKeys = true, named = true, dead = true, raw = true;
for (const c of CATS) {
	let cat = readFileSync(join(ROOT, 'www/i18n', c + '.js'), 'utf-8');
	if (BREAK === 'dotkeys')
		cat = cat.replace(/'fold\.stage_(read|propose|commit|failed)'/g, "'fold.stage.$1'");
	for (const k of ['fold.stage_read', 'fold.stage_propose', 'fold.stage_commit',
		'fold.tile_title', 'fold.stage_failed', 'fold.stage_done', 'fold.stage_unchanged',
		'fold.unchanged_body'])
		if (!cat.includes("'" + k + "'")) { allKeys = false; console.log('  missing ' + k + ' in ' + c); }
	if (/'fold\.stage\./.test(cat)) allKeys = false;
	const p = cat.match(/'fold\.proposing':\s*'([^']*)'/);
	if (!p || !p[1].includes('{diamond}')) { named = false; console.log('  fold.proposing unnamed in ' + c); }
	for (const k of DEAD) if (cat.includes("'" + k + "'")) { dead = false; console.log('  dead ' + k + ' in ' + c); }
	const f = cat.match(/'fold\.stage_failed':\s*'([^']*)'/);
	if (f && /\{err\}/.test(f[1])) { raw = false; console.log('  raw {err} in ' + c); }
}
check(allKeys, 'all eight catalogues carry the stage keys, no dotted leftovers');
check(named, 'item 5: fold.proposing names {diamond} in all eight catalogues');
check(dead, 'item 5: the review-era fold keys are gone from every catalogue');
check(raw, 'item 5: no catalogue renders a literal {err} on a failed fold');

// 5. item 6: a whole fold of an ordinary chat goes to the Trash, and Undo takes it all back
check(/var trashed = !turns && !chat\.diamondId;/.test(foldFn) && /if \(trashed\) removeChat\(chat\);/.test(foldFn),
	'item 6: a whole fold of an ordinary chat moves it to the Trash');
check(/undoFold\(chat, diamondId, parentV, landed\.version, landed\.files,/.test(foldFn),
	'item 6: Undo is handed the fold\'s own version');
const undoFn = src.slice(src.indexOf('async function undoFold('),
	src.indexOf('\n\t}\n', src.indexOf('async function undoFold(')));
check(/DaimondVersions\.undoVersion\(diamondId, foldV, files\)/.test(undoFn)
	&& /if \(!back\) \{\s*noticeDialog\([^;]*fold\.undo_files_failed[^;]*;\s*return;/.test(undoFn),
	'item 6: Undo puts the fold\'s recorded files back through the version undo, and a failure stops it, said');
check(/await trashRestore\(chat\.id\)/.test(undoFn) && /reselectChat\(chat\.id\)/.test(undoFn),
	'item 6: Undo takes the chat out of the Trash and back on screen');

console.log(fail ? '\n' + fail + ' FAIL' : '\nall ' + pass + ' checks passed');
process.exit(fail ? 1 : 0);

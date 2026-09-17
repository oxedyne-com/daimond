#!/usr/bin/env node
// #17 -- the fold shows its stages as a transcript tile, not an opaque spinner.
// Pure Node: it reads source structure and lifts the stage helpers to run them
// against stubs. Print in the verify-verb format ('  ok   '/'  FAIL ').
//
// Declared breaks: notiles, leak, dotkeys
// `--break notiles` drops the foldStage* wiring from foldChatInto -- the opaque spinner as it shipped.
// `--break leak` leaves the fold tile unsettled on the throw path.
// `--break dotkeys` restores the dotted i18n keys the code does not read.
'use strict';
const { readFileSync } = await import('node:fs');

const JS = 'www/js/daimond.js';
const CATS = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];
const BREAKS = {
	notiles: 'drop the foldStage* wiring from foldChatInto (restores the opaque spinner)',
	leak: 'leave the fold tile unsettled on the throw path',
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

let src = readFileSync(JS, 'utf-8');
if (BREAK === 'notiles')
	src = src.replace(/foldStageSay\(frun, 'read'\);[\s\S]*?foldStageSay\(frun, 'propose'\);/, '')
		.replace(/foldStageSay\(frun, 'commit'\);/, '')
		.replace(/foldStageFail\(frun, e\);/, '')
		.replace(/foldStageDone\(frun\);/, '');
if (BREAK === 'leak') src = src.replace(/foldStageFail\(frun, e\);\n(\t\t\t)?meterDiamondTurn/, 'meterDiamondTurn');

// 1. the helpers exist and the fold path says all three stages
check(/function foldStageTile\(/.test(src), 'foldStageTile exists');
check(/function foldStageSay\(/.test(src), 'foldStageSay exists');
check(/function foldStageDone\(/.test(src), 'foldStageDone exists');
check(/function foldStageFail\(/.test(src), 'foldStageFail exists');
const foldFn = src.slice(src.indexOf('async function foldChatInto('),
	src.indexOf('async function undoFold'));
check(/foldStageSay\(frun, 'read'\)/.test(foldFn)
	&& /foldStageSay\(frun, 'propose'\)/.test(foldFn)
	&& /foldStageSay\(frun, 'commit'\)/.test(foldFn),
	'fold says read, propose and commit');
check(/foldStageDone\(frun\)/.test(foldFn), 'fold settles the tile on the done path');
check(/foldStageFail\(frun, e\)/.test(foldFn), 'fold settles the tile on the throw path');

// 2. the helpers behave: a lift with stubs
const liftSrc = src.slice(src.indexOf('function foldStageSay('), src.indexOf('/// Take the `running`'));
const t = (k) => ({ 'fold.stage_read': 'reading', 'fold.stage_propose': 'reducing',
	'fold.stage_commit': 'writing' }[k] || k);
const friendlyError = (e) => String(e && e.message || e);
let body = '', removed = false;
const run = { classList: { remove: () => { removed = true; } }, _body: { set textContent(v) { body = v; } } };
const say = new Function('t', 'friendlyError', 'run', 'key',
	liftSrc + '\nreturn foldStageSay(run, key);');
let said;
said = say(t, friendlyError, run, 'read');
check(body === 'reading', 'stage key is said onto the tile body');
body = '';
said = say(t, friendlyError, run, 'nope');
check(body === '', 'unknown stage key leaves the tile alone');
const doneFn = new Function('run', src.slice(src.indexOf('function foldStageDone('),
	src.indexOf('/// Settle a fold tile')) + '\nfoldStageDone(run);');
doneFn(run);
check(removed, 'done takes the running mark off');
removed = false; body = '';
let peeked = '';
const run2 = { classList: { remove: () => { removed = true; } }, _body: { set textContent(v) { body = v; } }, _peek: (x) => { peeked = String(x); } };
const failFn = new Function('run', 'friendlyError', 't',
	src.slice(src.indexOf('function foldStageFail('),
		src.indexOf('\n\n', src.indexOf('function foldStageFail(')))
	+ '\nfoldStageFail(run, new Error("boom"));');
failFn(run2, friendlyError, t);
check(removed && /boom/.test(peeked), 'fail settles the tile and says the error');

// 3. every catalogue carries the five keys, and none carries a dotted one
let allKeys = true;
for (const c of CATS) {
	let cat = readFileSync('www/i18n/' + c + '.js', 'utf-8');
	if (BREAK === 'dotkeys')
		cat = cat.replace(/'fold\.stage_(read|propose|commit|failed)'/g, "'fold.stage.$1'");
	for (const k of ['fold.stage_read', 'fold.stage_propose', 'fold.stage_commit',
		'fold.tile_title', 'fold.stage_failed'])
		if (!cat.includes("'" + k + "'")) { allKeys = false; console.log('  missing ' + k + ' in ' + c); }
	if (/'fold\.stage\./.test(cat)) allKeys = false;
}
check(allKeys, 'all eight catalogues carry the five stage keys, no dotted leftovers');

console.log(fail ? '\n' + fail + ' FAIL' : '\nall ' + pass + ' checks passed');
process.exit(fail ? 1 : 0);

/* Test -- the reader tells the dead-writer detector which turns it has read ended (P2.3c1).
   ENDED  a turn whose end this device folded stays known ended across a reload (the device's
          log place, never the parcel), so the detector writes no `interrupted` end for it
   PRUNE  an ended turn the lease view no longer holds is forgotten: the place stays bounded
   WIRED  handoff's install hands the check to the writer (`readerEnded(chatLogEnded)`)
   node www/js/logended.test.mjs */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}
const { liftSource } = await import('../../dev/syncprobe.mjs');
const TL = await import(join(HERE, 'page', 'turnlog.js'));

const store = {};
const localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
const leases = { T1: { holder: 'd2' }, T2: { holder: 'd2' } };
const window = { DaimondLease: { record: (t) => leases[t] || null } };
const pg = { chats: [] };
let F = null;
try {
	F = new Function('localStorage', 'window', 'pg', 'logCursor', 'turnEnded', [
		'var LOG_PLACE_KEY = "daimond.chatlog.place";',
		liftSource(['saveLogPlace', 'loadLogPlace', 'chatLogEnded'], ['localStorage', 'window', 'pg', 'logCursor', 'turnEnded', 'LOG_PLACE_KEY']).src,
		'return { saveLogPlace, loadLogPlace, chatLogEnded };',
	].join('\n'))(localStorage, window, pg, TL.logCursor, TL.turnEnded);
} catch (e) { console.log(e.message); F = null; }
check('ENDED chatLogEnded exists', !!F);
if (F) {
	const chat = { id: 'c1', messages: [], logSeq: 7, logViews: {}, logEnds: { T1: 'done', T3: 'interrupted' } };
	pg.chats.push(chat);
	F.saveLogPlace(chat);
	check('ENDED known ended', F.chatLogEnded('c1', 'T1') === true);
	check('ENDED open turn not', F.chatLogEnded('c1', 'T2') === false);
	pg.chats.length = 0;	// a reload: the chat is not resident, its place is
	check('ENDED survives a reload', F.chatLogEnded('c1', 'T1') === true);
	const again = { id: 'c1', messages: [] };
	F.loadLogPlace(again);
	check('ENDED loaded with the place, status kept', !!(again.logEnds && again.logEnds.T1 === 'done'));
	// One map for the detector and the tile (P2.3d): a turn the lease view dropped keeps its end,
	// since the tile's settled check reads it with no lease left to read.
	check('KEEP a turn the lease view dropped stays ended', !!(again.logEnds && again.logEnds.T3 === 'interrupted'), JSON.stringify(again.logEnds));
	check('ENDED an unknown chat is not', F.chatLogEnded('c9', 'T1') === false);
}
const ho = readFileSync(join(HERE, 'page', 'handoff.js'), 'utf8');
const inst = ho.slice(ho.indexOf('export function install()'));
check('WIRED install hands the check to the writer', /readerEnded\(chatLogEnded\)/.test(inst.slice(0, inst.indexOf('page-split: end install'))));
console.log(failures ? failures + ' failed' : 'logended: all passed');
process.exit(failures ? 1 : 0);

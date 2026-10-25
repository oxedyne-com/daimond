/* ============================================================
   reporttaint.test.mjs — the report carries the chat's taint home (NF3 TRIP-MARK, check 5)

   WHAT IS CHECKED. A runner that tripped a chat's latch (it read outside content) stamps the
   chat as tainted, and its report carries the stamp as `taintedAt`. The asker must take it:
   its own record of the chat is marked, saved, and the engine it holds for the chat is told,
   so the asker's next turn cannot start the conversation clean. Three arms, on the REAL code
   (peer.js loaded as the page loads it; daimond.js lifted by `dev/syncprobe.mjs` `sliceDaimond`):

     (a) wire    — `makeReport` carries `taintedAt` only when it is a number >= 1, so an older
                   asker and a clean run see the report they knew.
     (b) take    — `takeReportTaint` marks the record by `chatId`, saves it, tells the engine;
                   one-way (an earlier stamp stands, a later one changes nothing); a report with
                   no stamp, or for a chat this device does not hold, touches nothing.
     (c) wiring  — `DaimondPeer.onReport`'s handler hands every report to `takeReportTaint`.

   RED before NF3's www half: (a) the field is dropped, (b) and (c) the function is absent.

   Run:  node www/js/reporttaint.test.mjs
   ============================================================ */
const { makeWindow, sliceDaimond, loadScript, TREE } = await import('../../dev/syncprobe.mjs');
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync(join(TREE, 'www', 'js', 'daimond.js'), 'utf8');
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}
const NOW = 1_000_000_000;
/// A stand-in engine that records what it was told.
const engine = () => {
	const e = { told: 0, tainted: false };
	e.set_tainted = () => { e.told++; e.tainted = true; };
	e.is_tainted = () => e.tainted;
	return e;
};

console.log('\n(a) wire: makeReport carries taintedAt only when it is a number >= 1\n');
{
	const w = makeWindow({ now: NOW });
	try { loadScript(w, 'peer.js'); } catch (e) { /* the builders are defined before any boot step */ }
	const P = w.DaimondPeer;
	check('peer.js publishes makeReport', !!(P && typeof P.makeReport === 'function'));
	if (P && P.makeReport) {
		const rep = (ta) => P.makeReport({ eid: 'e', turnId: 't', chatId: 'c', status: 'done', taintedAt: ta });
		check('a stamped report carries the stamp', rep(NOW - 5).taintedAt === NOW - 5, rep(NOW - 5).taintedAt);
		check('the stamp survives the JSON the relay carries',
			JSON.parse(JSON.stringify(rep(1234))).taintedAt === 1234);
		for (const bad of [undefined, null, 0, -3, 0.5, '1234', NaN, true, {}]) {
			check('no taintedAt key for ' + JSON.stringify(bad === undefined ? 'undefined' : bad), !('taintedAt' in rep(bad)));
		}
	}
}

console.log('\n(b) take: the asker marks, saves and tells the engine\n');
{
	const page = (recs) => {
		const w = makeWindow({ now: NOW });
		const saved = { n: 0 };
		let F = null;
		try {
			F = sliceDaimond(w, ['takeReportTaint'], { chats: recs, persistChats: () => { saved.n++; } }).fns;
		} catch (e) { check('the tree has takeReportTaint', false, String(e && e.message || e)); }
		return { F, saved };
	};
	{
		const e = engine();
		const rec = { id: 'c1', updatedAt: 1, app: e };
		const { F, saved } = page([{ id: 'c0', updatedAt: 1 }, rec]);
		if (F) {
			F.takeReportTaint({ chatId: 'c1', status: 'done', taintedAt: NOW - 100 });
			check('the record named by chatId is marked at the report\'s stamp', rec.taintedAt === NOW - 100, rec.taintedAt);
			check('the record is saved', saved.n === 1, saved.n);
			check('the engine held for the chat is told', e.told === 1 && e.tainted, e.told);
			F.takeReportTaint({ chatId: 'c1', status: 'done', taintedAt: NOW });
			check('a later stamp leaves the earlier one', rec.taintedAt === NOW - 100, rec.taintedAt);
			check('an unchanged record is not saved again', saved.n === 1, saved.n);
			F.takeReportTaint({ chatId: 'c1', status: 'done', taintedAt: NOW - 500 });
			check('an earlier stamp moves it earlier', rec.taintedAt === NOW - 500, rec.taintedAt);
		}
	}
	{
		const other = { id: 'c0', updatedAt: 1 };
		const { F, saved } = page([other]);
		if (F) {
			let threw = '';
			try {
				F.takeReportTaint({ chatId: 'c0', status: 'done' });
				F.takeReportTaint({ chatId: 'gone', status: 'done', taintedAt: NOW });
				F.takeReportTaint({ chatId: '', status: 'done', taintedAt: NOW });
				F.takeReportTaint(null);
			} catch (e) { threw = String(e && e.message || e); }
			check('an unstamped, unknown or empty report does not throw', threw === '', threw);
			check('an unstamped report leaves the record clean', !('taintedAt' in other));
			check('nothing is saved', saved.n === 0, saved.n);
		}
	}
	{
		const rec = { id: 'c2', updatedAt: 1 };
		const { F, saved } = page([rec]);
		if (F) {
			F.takeReportTaint({ chatId: 'c2', status: 'done', taintedAt: NOW });
			check('a record with no engine yet is marked and saved', rec.taintedAt === NOW && saved.n === 1);
		}
	}
}

console.log('\n(c) wiring: onReport hands every report to takeReportTaint\n');
{
	const at = APP.indexOf('DaimondPeer.onReport(async function (report) {');
	// The whole handler, to its closing `});` at the opening's indent, not a fixed window: the
	// OWNKEY refused-ABI branch at its top pushed the call past the old 1200 characters.
	const end = at >= 0 ? APP.indexOf('\n\t\t});', at) : -1;
	const head = at >= 0 ? APP.slice(at, end > at ? end : APP.length) : '';
	check('the onReport handler calls takeReportTaint(report)', /\n\t+takeReportTaint\(report\);/.test(head));
}

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures ? 1 : 0);

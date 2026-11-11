/* ============================================================
   Test -- a carried turn that was not recorded says so (12 Nov 2026).

   Neil's Diamond had a turn's file bodies in `versions/`, no manifest, `claims.json` `[]` and
   `crystal_version` 0: `versions_record_carried` had answered `{}` for a record it could use no
   row of, and the page's own `catch` threw the reason away, so nothing reached sync and the
   turn never appeared on his phone.

   `recordCarried` now warns, tells the Pending panel, and lets a later attempt try again; an
   engine that legitimately answers `{}` is still not a complaint.
   ============================================================ */
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); failures++; }
}

const NOW = 1761300000000;
const rec = () => ({ keeper: 'd1', run: 'e-9', turnId: 't9', on: 'ARGO', onName: 'argonaut',
	since: NOW - 6e7, until: NOW + 6e8, files: [{ path: 'crystal.json', hash: 'a'.repeat(64) }] });

/// One page over `versions.js` as written, with an engine that answers as told.
function page(answer) {
	const calls = { carried: 0, warns: [], debugs: [], notes: [] };
	const eng = {
		versions_list() { return '[]'; },
		versions_record_carried(id, json) {
			calls.carried++;
			calls.json = JSON.parse(json);
			return answer(calls.carried);
		},
	};
	const win = makeWindow({ ls: {}, now: NOW, extra: {
		DaimondCore: { diamondApp: () => eng },
		DaimondSync: { flush: async () => {} },
		DaimondAlerts: { note: (d, key, head, text) => { calls.notes.push([d, key, head, text]); return {}; } },
		console: {
			warn:  (s) => calls.warns.push(String(s)),
			debug: (s) => calls.debugs.push(String(s)),
			log:   () => {},
		},
	} });
	win.document = { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, dataset: {} }) };
	loadScript(win, 'versions.js');
	return { win, calls, V: win.DaimondVersions };
}

// ── The fault: the engine raises, and the reason reaches somewhere it can be read ─────────────

{
	const p = page(() => { throw new Error('The carried turn named 1 file(s) and none could be '
		+ 'be recorded: row 1: "crystal.json" is relative.'); });
	const got = await p.V.recordCarried(rec());
	check('the failure is still null to the caller', got === null, JSON.stringify(got));
	check('the reason is warned, with the run', p.calls.warns.length === 1
		&& p.calls.warns[0].indexOf('e-9') >= 0 && p.calls.warns[0].indexOf('relative') >= 0,
		JSON.stringify(p.calls.warns));
	check('and raised on the Pending panel under turn-failed', p.calls.notes.length === 1
		&& p.calls.notes[0][1] === 'turn-failed' && p.calls.notes[0][3].indexOf('relative') >= 0,
		JSON.stringify(p.calls.notes));
	// The run is let go, so a later report of it is tried again rather than believed done.
	const again = await p.V.recordCarried(rec());
	check('a later attempt asks the engine again', p.calls.carried === 2 && again === null,
		String(p.calls.carried));
}

// ── A turn that genuinely left nothing: no complaint ──────────────────────────────────────────

{
	const p = page(() => '{}');
	const got = await p.V.recordCarried(rec());
	check('an empty answer is not a fault', got && typeof got === 'object'
		&& Object.keys(got).length === 0, JSON.stringify(got));
	check('nothing is warned and nothing is raised', p.calls.warns.length === 0
		&& p.calls.notes.length === 0, JSON.stringify(p.calls.warns) + JSON.stringify(p.calls.notes));
	check('but it is left in the trace', p.calls.debugs.length === 1
		&& p.calls.debugs[0].indexOf('e-9') >= 0, JSON.stringify(p.calls.debugs));
}

// ── And the ordinary case is unchanged ───────────────────────────────────────────────────────

{
	const p = page(() => '{"version":3,"files":["/d/crystal.json"]}');
	const got = await p.V.recordCarried(rec());
	check('a recorded turn answers what the engine said', got && got.version === 3
		&& Array.isArray(got.files) && got.files[0] === '/d/crystal.json', JSON.stringify(got));
	check('with no complaint of any kind', p.calls.warns.length === 0 && p.calls.notes.length === 0
		&& p.calls.debugs.length === 0);
	check('once per run on this page', (await p.V.recordCarried(rec())) === null
		&& p.calls.carried === 1, String(p.calls.carried));
	check('under the keeper the record names', p.calls.json && p.calls.json.keeper === 'd1');
}

if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
console.log('carriedsaid: all ok');
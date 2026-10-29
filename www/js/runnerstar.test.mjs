/* ============================================================
   Test — a paired runner can be starred (STARFIX, UNBLOCK-36).
   ------------------------------------------------------------
   The owner paired Kimberlite on argonaut (device `kdu5d0t4wuaax7f6`) and
   pressed the hollow star on its row in Settings → Devices. Nothing happened.

   A runner's device id is minted by the GATEWAY (runner_pair.rs:
   `util::gen_token(DEVICE_ID_LEN)`): sixteen characters of util.rs's
   TOKEN_CHARSET, which is not hex. daimond.js held one device-id contract,
   `DEVICE_ID_RE`, that admitted hex 16 and hex 32 alone, so `nominateDevice`
   returned null for the runner without a word, `saveNominee` redrew the same
   hollow star, and the roster, the merge and the name memory each dropped the
   runner's lines the same way.

   This pins ONE contract to the gateway's own minting (read from its source,
   so the two cannot drift), and drives the real functions over it: the star
   takes, the nomination snapshots and merges, the roster keeps the runner's
   line, a refused star is said, and the other files that key by device id
   (cloud.js `PEER_RE`, markshere.js `REF_DEVICES_RE`) agree.

   Run:  node www/js/runnerstar.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DSRC = readPage(join(HERE, 'daimond.js'), 'utf8');
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}

/// A function's source by name, at any indent: from its line to the closing
/// brace at that same indent.
function fn(name) {
	const m = new RegExp('\\n(\\t+)function ' + name + '\\(').exec(DSRC);
	if (!m) throw new Error('not found in daimond.js: ' + name);
	const end = DSRC.indexOf('\n' + m[1] + '}', m.index + 1);
	return DSRC.slice(m.index + 1, end + m[1].length + 2);
}
function v(name, src) {
	const m = new RegExp('\\n\\t+var ' + name + '\\s*=[^\\n]*;').exec(src || DSRC);
	if (!m) throw new Error('var not found: ' + name);
	return m[0].trim();
}

// ── The gateway's minting, read from its source ──────────────────────
const UTIL = readPage(join(ROOT, 'gateway', 'src', 'util.rs'), 'utf8');
const PAIR = readPage(join(ROOT, 'gateway', 'src', 'handlers', 'runner_pair.rs'), 'utf8');
const CHARSET = /const TOKEN_CHARSET: &str = "([^"]+)";/.exec(UTIL)[1];
const LEN = Number(/const DEVICE_ID_LEN: usize = (\d+);/.exec(PAIR)[1]);
check('runner_pair mints its device id with gen_token(DEVICE_ID_LEN)',
	/device:\s*util::gen_token\(DEVICE_ID_LEN\)/.test(PAIR));
function mint() {
	let s = '';
	for (let i = 0; i < LEN; i++) s += CHARSET[Math.floor(Math.random() * CHARSET.length)];
	return s;
}
const RUNNER = 'kdu5d0t4wuaax7f6';			// the owner's argonaut runner
const HEX32  = '96a1474270a784f8d7ba6f1bf9dc434d';
const HEX16  = '00112233445566aa';

console.log('\n(a) one device-id contract admits every id the account can hold');
const RE = new Function(v('DEVICE_ID_RE') + '; return DEVICE_ID_RE;')();
check('the argonaut runner id', RE.test(RUNNER));
check('a browser id (32 hex)', RE.test(HEX32));
check('a legacy browser id (16 hex)', RE.test(HEX16));
let all = true, bad = '';
for (let i = 0; i < 2000; i++) { const id = mint(); if (!RE.test(id)) { all = false; bad = id; break; } }
check('every id the gateway can mint (2000 drawn)', all, bad);
check('every character of TOKEN_CHARSET', RE.test(CHARSET.slice(0, LEN)) && RE.test(CHARSET.slice(-LEN)));
check('not an empty id', !RE.test(''));
check('not a key with a dot in it', !RE.test('kdu5d0t4.uaax7f6'));
check('not an upper-case id', !RE.test(RUNNER.toUpperCase()));
check('not a wrong length', !RE.test(RUNNER.slice(1)) && !RE.test(RUNNER + 'a'));
check('the runner id is not read as a legacy shadow',
	!new Function(v('LEGACY_ID_RE') + '; return LEGACY_ID_RE;')().test(RUNNER));

// ── A tab's worth of store, enough for the nomination and the roster ──
function makeStore() {
	const map = new Map();
	return {
		map,
		get: (k, d) => (map.has(k) ? JSON.parse(map.get(k)) : d),
		put: (k, val) => { map.set(k, JSON.stringify(val)); return true; },
		putMerged: (k, val) => { map.set(k, JSON.stringify(val)); return true; },
	};
}
const Stamp = {
	next: (prev) => Math.max(Date.now(), (prev || 0) + 1),
	beats: (at, b, at2, a, rank) => at > at2 || (at === at2 && rank(b) > rank(a)),
};

function lift(store, extra) {
	return new Function('DaimondStore', 'DaimondStamp', 'toast', 't', 'window', [
		v('NOMINATED_KEY'), v('DEVICE_ID_RE'),
		fn('ms'), fn('nominationSnapshot'), fn('nominatedDeviceId'), fn('nominateDevice'),
		fn('adoptNomination'), fn('fresherNomination'), fn('nominationRank'),
		'function renderSeatSwitch() {}',
		extra || '',
		'return { nominateDevice, nominationSnapshot, nominatedDeviceId, adoptNomination,'
			+ (extra ? ' saveNominee,' : '') + ' };',
	].join('\n'));
}

console.log('\n(b) the star takes a runner, and the choice snapshots and merges');
{
	const S = makeStore();
	const L = lift(S)(S, Stamp, () => {}, (k) => k, {});
	const rec = L.nominateDevice(RUNNER);
	check('nominateDevice takes the runner id', !!rec && rec.id === RUNNER, JSON.stringify(rec));
	check('the nominee reads back (the star fills)', L.nominatedDeviceId() === RUNNER, L.nominatedDeviceId());
	check('the parcel carries it', (L.nominationSnapshot() || {}).id === RUNNER);
	// Another device receives that parcel.
	const S2 = makeStore();
	const L2 = lift(S2)(S2, Stamp, () => {}, (k) => k, {});
	L2.nominateDevice(HEX32);
	L2.adoptNomination({ id: RUNNER, at: (rec ? rec.at : Date.now()) + 1000 });
	check('another device adopts the runner nomination on merge', L2.nominatedDeviceId() === RUNNER, L2.nominatedDeviceId());
}

console.log('\n(c) a refused star is said, never silent');
{
	const S = makeStore(), said = [];
	const save = fn('saveNominee').replace(/renderHome\(\);/, '/* redraw */');
	const L = lift(S, save)(S, Stamp, (msg, err) => said.push([msg, err]), (k) => k, {});
	L.saveNominee('not a device id!');
	check('an id the contract refuses puts up an error toast', said.length === 1 && said[0][1] === true, JSON.stringify(said));
	said.length = 0;
	L.saveNominee(RUNNER);
	check('the runner id is taken without one', said.length === 0 && L.nominatedDeviceId() === RUNNER, JSON.stringify(said));
}

console.log('\n(d) the roster keeps the runner\'s line through a merge');
{
	const L = new Function('DaimondStore', [
		v('DEVICE_ID_RE'), v('DEVICE_NAME_MAX'), v('DEVICE_ROSTER_MAX'),
		fn('ms'), fn('deviceEntry'), fn('rosterRecord'), fn('mergeRosters'), fn('mergeDeviceLine'),
		'function deviceId() { return "' + HEX32 + '"; }',
		'return { mergeRosters };',
	].join('\n'))(makeStore());
	const out = L.mergeRosters({ [HEX32]: { name: 'iPhone', seen: 1, created: 1 } },
		{ [RUNNER]: { name: 'argonaut', seen: 2, created: 2 } });
	check('the runner line survives mergeRosters', !!out[RUNNER], Object.keys(out).join());
}

console.log('\n(e) the other files that key by device id agree');
{
	const CLOUD = readPage(join(HERE, 'cloud.js'), 'utf8');
	const PEER_RE = new Function(v('PEER_RE', CLOUD) + '; return PEER_RE;')();
	const m = PEER_RE.exec('chat-abc.peer.' + RUNNER);
	check('cloud.js PEER_RE reads a runner peer slot', !!m && m[1] === RUNNER, String(m && m[1]));
	check('cloud.js PEER_RE still reads a 32-hex slot', (PEER_RE.exec('x.peer.' + HEX32) || [])[1] === HEX32);
	const MARKS = readPage(join(HERE, 'markshere.js'), 'utf8');
	const REF = new Function(v('REF_DEVICES_RE', MARKS) + '; return REF_DEVICES_RE;')();
	const r = REF.exec('usr@' + HEX32 + ',' + RUNNER);
	check('markshere.js reads a reference made on a runner', !!r && r[1] === HEX32 + ',' + RUNNER, String(r && r[1]));
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall ok');
process.exit(failures ? 1 : 0);

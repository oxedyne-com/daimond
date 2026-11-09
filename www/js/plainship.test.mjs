/* ============================================================
   Test -- A PLAIN SHIP'S STATE ON THE PENDING PANEL (PLAIN-SHIPPER PS4, UNBLOCK-160)
   (www/js/page/pending.js, "A plain ship's state"; design plain_shipper_design_20261109 rev 4,
   §2b and §5: Kimberlite's desk posts each state as a relay entry of kind `ship`.)
   Harness as plainpending.test.mjs, with the page's clock set to a day in November.

   Each check is proven able to fail (each break must fail at least one case):

     node www/js/plainship.test.mjs --break relay     # ship entries never read by their nonce
     node www/js/plainship.test.mjs --break phone     # a device with no runner of its own settles nothing
     node www/js/plainship.test.mjs --break noat      # no order rule: every read raises
     node www/js/plainship.test.mjs --break atstamp   # raised with the shipper's time as the stamp
     node www/js/plainship.test.mjs --break key       # keyed by commit, not by submission id
     node www/js/plainship.test.mjs --break check     # the body's id not checked
     node www/js/plainship.test.mjs --break ctl       # control characters kept in the text
     node www/js/plainship.test.mjs --break nocap     # the detail not fitted to the record
     node www/js/plainship.test.mjs --break asof      # a state the relay no longer lists not marked
     node www/js/plainship.test.mjs --break door      # plainship not a page key: the door lets a daimon write it
     node www/js/plainship.test.mjs --break count     # the chip counts quiet items of the alerts record
     node www/js/plainship.test.mjs --break fold      # the ship drawn as its own tile beside its card
     node www/js/plainship.test.mjs --break sig       # the signature not checked, only the signer's listing
     node www/js/plainship.test.mjs --break trust     # every entry the relay serves kept (the gateway trusted)
     node www/js/plainship.test.mjs --break active    # a pending runner's key trusted as an approved one's
     node www/js/plainship.test.mjs --break removed   # a removed runner's items still drawn
     node www/js/plainship.test.mjs --break nokeys    # items drawn before his runners' keys are read
     node www/js/plainship.test.mjs --break drop      # entries dropped, not held, while the keys are unknown
     node www/js/plainship.test.mjs --break bytes     # the detail fitted in code points, not bytes
     node www/js/plainship.test.mjs --break alert     # the body's alert ignored
     node www/js/plainship.test.mjs --break nostall   # a stuck state left to lapse
     node www/js/plainship.test.mjs --break tag       # the purpose tag 'ship_state' (the ship_v1 vector)
     node www/js/plainship.test.mjs --break install   # the install left out of the signed string
     node www/js/plainship.test.mjs --break window    # a post outside the relay's window kept
     node www/js/plainship.test.mjs --break oneside   # only an old post judged, not one ahead of the gateway
     node www/js/plainship.test.mjs --break devclock  # the window judged on the device's clock, not the gateway's
     node www/js/plainship.test.mjs --break postat    # one id's entries of one state time not ordered by post time
     node www/js/plainship.test.mjs --break nostallsecs # an entry with no stall_secs stalls after a default
     node www/js/plainship.test.mjs --break early     # Stalled before the entry's stall_secs
     node www/js/plainship.test.mjs --break fold2     # the fold judged by the listing alone, not the card's drawn tile
     node www/js/plainship.test.mjs --break unverified # an entry settled that shipRead did not verify
     node www/js/plainship.test.mjs --break keepkeys  # his runners' keys kept when the identity locks
     node www/js/plainship.test.mjs --break keepgone  # kept when the session is over (401, 410)
     node www/js/plainship.test.mjs --break dropnet   # dropped on a network failure or a 5xx too
     node www/js/plainship.test.mjs --break future    # a body dated past its own post time kept
     node www/js/plainship.test.mjs --break alldev    # entries read whoever the listing names as signer
     node www/js/plainship.test.mjs --break noredraw  # no redraw when his runners' keys arrive
     node www/js/plainship.test.mjs --break law       # the merge law's dismissed-over rule gone: the later stamp wins
     node www/js/plainship.test.mjs --break lawsubmit # no law for a card: its ✕ is not final
     node www/js/plainship.test.mjs --break forever   # a ship ✕ final for every state, not for the one it took down
     node www/js/plainship.test.mjs --break shed      # a Stalled item shed by age
     node www/js/plainship.test.mjs --break stallserved # Stalled for served (and served with an alert) too
     node www/js/plainship.test.mjs --break norestamp # a Stalled item not raised again while it stays Stalled
     node www/js/plainship.test.mjs                   # and then, clean
   ============================================================ */
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { homedir } from 'node:os';
import { makeWindow, liftSource, js } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OLD = process.argv.includes('--old');	// child mode: the tree under TREE is t31b's (the old cached page)
const PV1 = JSON.parse(readFileSync(join(HERE, '../../verify/runner_compat/plain_v1/vectors.json'), 'utf8'));
const BASE = '533a69ac3';			// release/t31b, the page before this change

let failures = 0, cases = 0, bad = null;
function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
async function kase(name, fn) {
	cases++; bad = null;
	try { await fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); } else { console.log('  ok   ' + name); }
}

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
const KNOWN = ['relay', 'phone', 'noat', 'atstamp', 'key', 'check', 'ctl', 'nocap', 'asof', 'door', 'count', 'fold',
	'sig', 'trust', 'active', 'removed', 'nokeys', 'drop', 'bytes', 'alert', 'nostall',
	'tag', 'install', 'window', 'oneside', 'devclock', 'postat', 'nostallsecs', 'early', 'fold2', 'unverified',
	'keepkeys', 'keepgone', 'dropnet', 'future', 'alldev', 'noredraw', 'law', 'lawsubmit', 'forever', 'shed',
	'stallserved', 'norestamp'];
if (BREAK && !KNOWN.includes(BREAK)) { console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', ')); process.exit(2); }

function swapper(src, list) {
	for (const [needle, to] of list) {
		const n = src.split(needle).length - 1;
		if (n !== 1) { console.error('break ' + BREAK + ': target matched ' + n + ' times, not once: ' + needle); process.exit(2); }
		src = src.replace(needle, to);
	}
	return src;
}
function patchPage(src) {
	const B = {
		relay:   [["if (e && e.kind === 'ship') return shipRead(e, inst, j);", '']],
		phone:   [['submitTake(inst, list);\n\t\t\tshipSettle(inst, list);', 'submitTake(inst, list);']],	// the lifted source is a tab deeper
		noat:    [['\t\tif (p && p.at >= s.at) return;\n', '']],
		atstamp: [['\t\tif (p && p.at >= s.at) return;\n', ''], ["SHIP_NEEDS[s.state] || (s.state === 'served' && s.alert));", "SHIP_NEEDS[s.state] || (s.state === 'served' && s.alert), s.at);"]],
		key:     [['key = SHIP_KEY + id,', 'key = SHIP_KEY + s.commit,']],
		check:   [["if (!SHIP_ID_RE.test(String(b.id || '')) || ", 'if (']],
		ctl:     [[".replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')", '']],
		nocap:   [['\twhile (over > 0) {', '\twhile (false) {']],
		asof:    [['p.stale = !SHIP_ENDED[p.state]', 'p.stale = false && !SHIP_ENDED[p.state]']],
		count:   [['!(Pending.fromAlerts(it) && it.needs === false)', "!(it.kind === 'alert' && !it.needs)"]],
		fold:    [['if (!p || (p.card && submitShown(p.card))) return null;', 'if (!p) return null;']],
		fold2:   [['if (!p || (p.card && submitShown(p.card))) return null;', 'if (!p || (p.card && _submitLive[p.card])) return null;']],
		sig:     [['return C.edVerify(pub, sig, msg) === true;', 'return true;']],
		trust:   [['|| !shipSigned(inst, e.nonce, one)) return null;', ') return null;']],
		active:  [["if (!r || r.state !== 'active') return;\n\t\t\tvar sh = runnerPairShape(r), k", "if (!r) return;\n\t\t\tvar sh = runnerPairShape(r), k"]],
		removed: [['if (!_shipKeys || !_shipKeys[p.device]) return null;', 'if (!_shipKeys) return null;']],
		nokeys:  [['if (!_shipKeys || !_shipKeys[p.device]) return null;', 'if (_shipKeys && !_shipKeys[p.device]) return null;']],
		drop:    [['if (!_shipKeys) return e;', 'if (!_shipKeys) return null;']],
		bytes:   [['\tvar size = function (x) { return new TextEncoder().encode(x).length; };', '\tvar size = function (x) { return Array.from(x).length; };']],
		alert:   [['alert: b.alert === true,', 'alert: false,']],
		nostall: [['if (shipStall()) { Pending.fresh(); Pending.render(); }', '']],
		tag:     [["'ship-state\\0', 'kimberlite-ship:v1:'", "'ship_state\\0', 'kimberlite-ship:v1:'"]],
		install: [["dev + ':' + inst + ':' + nonce", "dev + ':' + nonce"]],
		window:  [['return Math.abs(gw / 1000 - at) <= rep + skew;', 'return true;']],
		oneside: [['return Math.abs(gw / 1000 - at) <= rep + skew;', 'return gw / 1000 - at <= rep + skew;']],
		devclock: [['var gw = (P && P.relayNow) ? P.relayNow() : null;', 'var gw = Date.now();']],
		postat:  [[' || (s.at === b.at && s.postAt > b.postAt)', '']],
		nostallsecs: [['b.stall_secs > 0 ? b.stall_secs : 0,', 'b.stall_secs > 0 ? b.stall_secs : 3600,']],
		early:   [['now >= p.at + p.stallSecs * 1000 && ', '']],
		unverified: [['var s = _shipOk.has(e) ? shipBody(e) : null;', 'var s = shipBody(e);']],
		keepkeys: [['DaimondIdentity.isUnlocked()) { shipKeysSet(null); return false; } }', 'DaimondIdentity.isUnlocked()) { return false; } }']],
		keepgone: [['if (r && (r.status === 401 || r.status === 410)) shipKeysSet(null);', '']],
		dropnet: [['if (r && (r.status === 401 || r.status === 410)) shipKeysSet(null);', 'if (!r || !r.ok) shipKeysSet(null);']],
		future:  [['if (at > ((Number(e.postAt) || 0) + (Number(e.skewSecs) || 0) + 1) * 1000) return null;', '']],
		alldev:  [['\tif (!_shipKeys[dev]) return null;\n', '']],
		noredraw: [['_shipKeyIds = ids;\n\t\tPending.fresh(); Pending.render();', '_shipKeyIds = ids;']],	// lifted source is one tab deeper
		stallserved: [['&& SHIP_OWED[p.state] &&', '&& !SHIP_ENDED[p.state] &&']],
		norestamp: [['&& SHIP_OWED[p.state] &&', '&& SHIP_OWED[p.state] && !p.stall &&']],
	};
	return B[BREAK] ? swapper(src, B[BREAK]) : src;
}
function patchAlerts(src) {
	const B = {
		door:      [["'submit': 1, 'plainship': 1 };", "'submit': 1 };"]],
		law:       [["if ((b.state === 'dismissed') !== (a.state === 'dismissed')) return b.state === 'dismissed';", '']],
		lawsubmit: [["'submit':    { gen: function () { return 0; } },", '']],
		forever:   [["'plainship': { gen: detailT, keep: true },", "'plainship': { gen: function () { return 0; }, keep: true },"]],
		shed:      [["if (L && L.keep && it.state === 'up' && it.needs) return;", '']],
	};
	return B[BREAK] ? swapper(src, B[BREAK]) : src;
}

const ALERTS_SRC = patchAlerts(readFileSync(js('alerts.js'), 'utf8'));
const LOAD_NOBLE = new Function('window', readFileSync(js('vendor/noble-curves.min.js'), 'utf8') + '\n;window.DaimondNoble = DaimondNoble;');
const LOAD_CURVE = new Function('window', readFileSync(js('curvefallback.js'), 'utf8'));
const LOAD_ALERTS = new Function('window', 'with (window) {\n' + ALERTS_SRC + '\n}\n//# sourceURL=alerts.js');
const NAMES = ['Pending', 'runnerPoll', 'runnerSettle', 'submitTile', 'runnerPairPoll'];
const OWN = /^(runner|RUNNER_|_runner|submit|SUBMIT_|_submit|plain|PLAIN_|_plain|ship|SHIP_|_ship|relay|_relay)/;
const STUBS = liftSource(NAMES, []).ordered.filter((n) => !NAMES.includes(n) && !OWN.test(n));

const INSTALL = 'IiIiIiIiIiIiIiIiIiIiIg';
const OTHER   = 'OoOoOoOoOoOoOoOoOoOoOg';
const NOW = Date.parse('2026-11-09T12:00:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const nonce = (c, k) => (c + String(k)).padEnd(22, 'x');
const sid = (c) => String(c).repeat(32).slice(0, 32);	// a submission id, 32 hex
const COMMIT = 'c0e0ccdde'.padEnd(40, '0');

// His runners' device keys: DEV approved (his desk), PEND waiting for his approval, ALIEN another
// account's runner, paired there, so the gateway takes its posts (design §2b G1).
function runnerKey() { const k = generateKeyPairSync('ed25519'); return { priv: k.privateKey, pub: k.publicKey.export({ format: 'jwk' }).x }; }
const DEV = 'DeskDeskDeskDes1', PEND = 'PendPendPendPen2', ALIEN = 'AlienAlienAlien3';
const KEYS = { [DEV]: runnerKey(), [PEND]: runnerKey(), [ALIEN]: runnerKey() };
const runnerRow = (device, state) => ({ device, kind: 'runner', state, name: device, pubkey: KEYS[device].pub, joined: 1, approved: state === 'active' ? 2 : 0 });
/// The keeper's signed bytes for a ship entry (kimberlite device_key.rs `signed_bytes`, design §5 r5b).
const shipSigned = (dev, inst, n, at, body) => Buffer.concat([Buffer.from('kimberlite/device/v1\0'), Buffer.from('ship-state\0'),
	Buffer.from('kimberlite-ship:v1:' + dev + ':' + inst + ':' + n + ':' + at + ':' + body)]);
function shipSig(dev, inst, n, at, body, key) { return edSign(null, shipSigned(dev, inst, n, at, body), key.priv).toString('base64url'); }
const SHIP_V1 = JSON.parse(readFileSync(join(HERE, '../../verify/runner_compat/ship_v1/vectors.json'), 'utf8'));

function el(tag) {
	return { tag, className: '', textContent: '', title: '', children: [], attrs: {}, on: {}, dataset: {}, style: {},
		appendChild(c) { this.children.push(c); return c; }, addEventListener(t, f) { this.on[t] = f; }, setAttribute(k, v) { this.attrs[k] = v; } };
}
const walk = (e, out = []) => { out.push(e); for (const c of e.children) walk(c, out); return out; };
const texts = (els) => els.map((e) => e.textContent).filter(Boolean);

function page(o) {
	o = o || {};
	const win = makeWindow({ now: NOW, ls: o.ls });
	const st = { list: [], whole: {}, down: false, install: o.install === undefined ? INSTALL : o.install, lists: {},
		runners: [runnerRow(DEV, 'active')], unlocked: true, pair: 200, repost: 420, skew: 120, gw: undefined, hostile: false, reads: 0 };
	win.fetch = async (url) => {
		url = String(url);
		if (url.indexOf('/api/runner/pair/list') >= 0) {
			if (st.pair === 'throw') throw new Error('offline');
			if (st.pair !== 200) return { ok: false, status: st.pair, json: async () => ({ ok: false }) };
			return { ok: true, status: 200, json: async () => ({ ok: true, runners: st.runners }) };
		}
		if (st.down) return { ok: false, status: 503, json: async () => ({ ok: false }) };
		if (url.indexOf('?install=') >= 0) {
			const inst = decodeURIComponent(url.split('?install=')[1]);
			const l = st.lists[inst] || (inst === INSTALL ? st.list : []);
			return { ok: true, status: 200, json: async () => ({ ok: true, ship_repost_secs: st.repost, ship_skew_secs: st.skew, entries: l.map((e) => Object.assign({}, e)) }) };
		}
		// A ship is read by its signer and nonce (RL1 r2): no device, or another, is 404,
		// unless the gateway is the attacker's (`hostile`), which serves any body it likes.
		const q = new URLSearchParams(url.split('?')[1] || ''), n = q.get('nonce') || '';
		const w = st.whole[n];
		st.reads++;
		if (w === 'down') return { ok: false, status: 503, json: async () => ({ ok: false }) };
		if (!w || (w.kind === 'ship' && !st.hostile && q.get('device') !== w.device)) return { ok: false, status: 404, json: async () => ({ ok: false }) };
		return { ok: true, status: 200, json: async () => Object.assign({ ok: true }, w) };
	};
	win.DaimondHand = { runnerInstall: () => st.install };
	win.DaimondHandMode = { get: () => 'bypass' };
	win.DaimondNet = { runnerApprove: () => 'https://runner.test.daimond.app/approve' };
	win.DaimondIdentity = { isUnlocked: () => st.unlocked };
	win.DaimondPresence = { relayNow: () => st.gw === undefined ? win.Date.now() : st.gw };	// the gateway's clock; null: not yet learned
	win.document.createElement = el;
	LOAD_ALERTS(win);
	LOAD_NOBLE(win);
	LOAD_CURVE(win);
	const stub = {
		t: (k, v) => k + (v ? '|' + Object.keys(v).sort().map((x) => x + '=' + v[x]).join(',') : ''),
		readJson: (k, d) => { try { const v = win.localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
		PENDING_KEY: 'daimond-pending', PRIORITIES: ['high', 'normal', 'low'], NOTICED_KEY: 'daimond-pending-noticed', NOTICED_MAX: 64,
		settleConsent: () => false, _parked: {}, relTime: () => 'now', nudgeSync: () => {}, steerTile: () => {}, steerRaise: () => {},
		toast: () => {}, diamonds: [], pg: { diamonds: [] }, currentDiamond: null, selectDiamond: async () => {}, turnHold: () => null, confirmHold: async () => {},
		doSteer: async () => {}, steerPress: async () => {}, steerEdit: async () => {}, promptDialog: async () => null,
		sendMessage: async () => {}, newChat: async () => {}, DaimondPanels: { isOpen: () => true, show: () => {} },
		tombMapNow: () => ({}), DIAMOND_TOMBS_KEY: 'daimond-diamond-tombs', trashed: () => false,
	};
	let src = OLD ? liftSource(NAMES, STUBS).src : patchPage(liftSource(NAMES, STUBS).src);
	for (const n of STUBS) if (!(n in stub)) stub[n] = undefined;
	const sk = Object.keys(stub);
	const body = 'with (window) { return (function (' + sk.join(', ') + ') {\n' + src + '\nreturn { ' + NAMES.join(', ') + ' };\n}).apply(null, stubs); }';
	const fns = new Function('window', 'stubs', body)(win, sk.map((k) => stub[k]));
	fns.Pending.render = () => {};
	const A = win.DaimondAlerts;
	const items = () => { fns.Pending.fresh(); return fns.Pending.items; };
	const ships = () => items().filter((x) => x.kind === 'plainship');
	const draw = (it) => walk(fns.Pending.tile(it));
	const keys = () => Object.keys(JSON.parse(win.localStorage.getItem(A.KEY) || '{"items":{}}').items || {}).filter((k) => k.indexOf('@runner:plainship.') === 0);
	const held = (id) => A.held ? A.held(A.RUNNER, 'plainship.' + id) : null;
	return { win, st, fns, A, items, ships, draw, keys, held, poll: async () => { await fns.runnerPairPoll(); return fns.runnerPoll(); } };
}

/// One ship entry on `pg`'s relay for `inst`: listed by its nonce and kind, its body read by the nonce.
function shipBodyOf(o) {
	return Object.assign({ id: sid('a'), card: '', commit: COMMIT, summary: 'Fix the rail', diamond_name: 'Work', state: 'shipping',
		step: '', rc: 0, words: '', build: '', reds: '', alert: false, approved_at: Math.floor((NOW - 30 * MIN) / 1000), at: iso(NOW - 10 * MIN), stall_secs: 3600 }, o || {});
}
/// `by` names the signer (`dev`, default DEV), the post time (`at`, unix seconds, default a minute
/// before the page's clock) and, to forge, the key, body or install it signs (`key`, `sigBody`, `sigInst`).
function postShip(pg, tag, o, inst, by) {
	inst = inst || INSTALL;
	by = by || {};
	const n = by.nonce || nonce('S' + tag, 1), dev = by.dev || DEV, body = JSON.stringify(shipBodyOf(o));
	const at = by.at || Math.floor(pg.win.Date.now() / 1000) - 60;
	pg.st.whole[n] = { nonce: n, kind: 'ship', install: inst, device: dev, at, body, sig: shipSig(dev, by.sigInst || inst, n, at, by.sigBody || body, by.key || KEYS[dev]), expires_in: 600 };
	const list = inst === INSTALL ? pg.st.list : (pg.st.lists[inst] = pg.st.lists[inst] || []);
	if (!list.some((e) => e.nonce === n)) list.push({ nonce: n, kind: 'ship', device: dev, expires_in: 600 });
	return n;
}
/// A plain card on the relay (vector 0), as plainpending.test.mjs posts it.
function postCard(pg, extra) {
	const v = PV1.vectors[0], nn = nonce('P', 1);
	const text = JSON.stringify(Object.assign({
		v: 'plain/1', card: v.card_b64u, summary: v.summary, branch: v.branch, commit: v.commit, repo: v.repo,
		release_ref: v.commit, page_code: String(v.page_code), runner_code: String(v.runner_code), approve: '1',
		chat: v.chat, diamond: v.diamond, diamond_name: v.diamond_name,
		seq: String(v.seq), checks: v.checks.map((c) => ({ name: c.name, result: String(c.result), runs: String(c.runs) })),
	}, extra || {}));
	pg.st.whole[nn] = { nonce: nn, kind: 'submit', install: INSTALL, body: text, answered: false, alarmed: false, expires_in: 600, answers: [] };
	pg.st.list.push({ nonce: nn, kind: 'submit', answered: false, alarmed: false, expires_in: 600 });
	return nn;
}

if (OLD) {
	// The old cached page (t31b) over a listing with a ship entry and a record holding a ship item.
	console.log('the old cached page (t31b) over a ship entry and a ship item');
	await kase('t31b draws no ship item, counts none, raises nothing from a ship entry and clears no ship item', async () => {
		const pg = page();
		const card = postCard(pg);
		postShip(pg, 'a', { card });
		pg.A.raise(pg.A.RUNNER, 'plainship.' + sid('b'), 'plain ship', INSTALL + ' {"s":"stopped","t":1}', true);
		await pg.poll();
		const its = pg.items();
		eq(its.filter((x) => x.kind !== 'submit').map((x) => x.kind), [], 'only the card drawn');
		eq(pg.fns.Pending.counted(), 1, 'the card alone counts');
		eq(pg.keys(), ['@runner:plainship.' + sid('b')], 'the ship item held, nothing raised from the entry');
		ok(pg.A.live().some((a) => a.key === 'plainship.' + sid('b')), 'the ship item still up');
	});
	console.log(failures ? failures + ' of ' + cases + ' FAILED' : 'all ' + cases + ' passed');
	process.exit(failures ? 1 : 0);
}

console.log("a plain ship's state on the Pending panel (PLAIN-SHIPPER PS4)");

await kase('item_from_relay_states: one item per submission, his words and needs per state', async () => {
	const pg = page();
	const S = [['queued', sid('1'), { words: 'behind p0123' }], ['shipping', sid('2'), {}], ['live', sid('3'), { build: '9979d8516c0f' }],
		['live', sid('4'), {}], ['served', sid('5'), { build: 'b5' }], ['stopped', sid('6'), { step: 'arms', words: 'two reds' }],
		['refused', sid('7'), { words: 'pin gone: submit it again' }], ['served', sid('8'), { build: 'b6', alert: true }]];
	S.forEach(([state, id, o], i) => postShip(pg, String(i), Object.assign({ state, id, summary: 'S' + i }, o)));
	await pg.poll();
	const by = {};
	pg.ships().forEach((x) => { by[x.headline] = x.needs; });
	eq(by, {
		'pending.ship.queued|build=,step=?,summary=S0,words=behind p0123': false,
		'pending.ship.shipping|build=,step=?,summary=S1,words=?': false,
		'pending.ship.live|build=9979d8516c0f,step=?,summary=S2,words=?': false,
		'pending.ship.live_already|build=,step=?,summary=S3,words=?': false,
		'pending.ship.served|build=b5,step=?,summary=S4,words=?': false,
		'pending.ship.stopped|build=,step=arms,summary=S5,words=two reds': true,
		'pending.ship.refused|build=,step=?,summary=S6,words=pin gone: submit it again': true,
		'pending.ship.served_alert|build=b6,step=?,summary=S7,words=?': true,
	}, 'tiles');
	ok(pg.ships().every((x) => x.headline.indexOf('Live') < 0), 'never "Live"');
});

await kase('one_item_replaced_per_state: queued, shipping, live under one key', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'queued', at: iso(NOW - 30 * MIN) });
	await pg.poll();
	postShip(pg, 'a', { state: 'shipping', at: iso(NOW - 20 * MIN) });
	await pg.poll();
	postShip(pg, 'a', { state: 'live', build: 'B1', at: iso(NOW - 10 * MIN) });
	await pg.poll();
	eq(pg.keys(), ['@runner:plainship.' + sid('a')], 'one key');
	eq(pg.ships().map((x) => x.headline), ['pending.ship.live|build=B1,step=?,summary=Fix the rail,words=?'], 'the newest state');
});

await kase('phone_sees_ship_without_desktop: a device with no runner reads the install its card names and raises it', async () => {
	const pg = page({ install: '' });
	pg.A.raise(pg.A.RUNNER, 'submit.' + nonce('P', 1) + '.0', 'daimon change', INSTALL + ' Fix the rail', true);
	postShip(pg, 'a', { state: 'shipping' });
	await pg.poll();
	eq(pg.ships().map((x) => x.headline), ['pending.ship.shipping|build=,step=?,summary=Fix the rail,words=?'], 'the phone draws it');
	ok(pg.held(sid('a')), 'and holds it in the synced record');
	// The card's own item gone, the ship item alone names the install: still read.
	pg.A.clear(pg.A.RUNNER, 'submit.' + nonce('P', 1) + '.0');
	postShip(pg, 'a', { state: 'live', build: 'B2', at: iso(NOW - 5 * MIN) });
	await pg.poll();
	eq(pg.ships().map((x) => x.headline), ['pending.ship.live|build=B2,step=?,summary=Fix the rail,words=?'], 'read by the ship item\'s install');
});

await kase('older_entry_never_regresses: a replayed or slower older state writes nothing', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'live', build: 'B1', at: iso(NOW - 5 * MIN) });
	await pg.poll();
	const before = pg.held(sid('a'));
	postShip(pg, 'a', { state: 'shipping', at: iso(NOW - 10 * MIN) });
	await pg.poll();
	eq(pg.held(sid('a')), before, 'held item unchanged');
	eq(pg.ships().map((x) => x.headline), ['pending.ship.live|build=B1,step=?,summary=Fix the rail,words=?'], 'still deployed');
});

await kase('same_commit_two_submissions: two ids of one commit are two items, on two installs', async () => {
	const pg = page();
	postShip(pg, 'a', { id: sid('a'), state: 'refused', words: 'pin gone: submit it again', at: iso(NOW - 20 * MIN) });
	postShip(pg, 'b', { id: sid('b'), state: 'queued', at: iso(NOW - 10 * MIN) });
	await pg.poll();
	eq(pg.keys().sort(), ['@runner:plainship.' + sid('a'), '@runner:plainship.' + sid('b')], 'two keys');
	eq(pg.ships().map((x) => x.headline.split('|')[0]).sort(), ['pending.ship.queued', 'pending.ship.refused'], 'both drawn');
});

await kase('reload_keeps_item: a fresh window over the same record draws it before any relay read', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'shipping' });
	await pg.poll();
	const pg2 = page({ ls: pg.win.localStorage });
	await pg2.fns.runnerPairPoll();
	eq(pg2.ships().map((x) => x.headline), ['pending.ship.shipping|build=,step=?,summary=Fix the rail,words=?'], 'drawn after reload');
});

await kase('old_page_ignores_ship_entry: t31b\'s page over a ship entry and item (guard, run as the old page)', async () => {
	const scratch = mkdtempSync(join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'plainship_old.'));
	try {
		const repo = process.env.PLAINSHIP_GIT || join(HERE, '../..');
		const tar = execFileSync('git', ['-C', repo, 'archive', BASE, 'www/js', 'verify/runner_compat/plain_v1'], { maxBuffer: 1 << 30 });
		mkdirSync(scratch, { recursive: true });
		const x = spawnSync('tar', ['-x', '-C', scratch], { input: tar });
		ok(x.status === 0, 'tar: ' + x.status);
		const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--old'], { env: Object.assign({}, process.env, { TREE: scratch }), encoding: 'utf8' });
		ok(r.status === 0, 'old page: ' + (r.stdout + r.stderr).split('\n').filter((l) => l.indexOf('FAIL') >= 0 || l.indexOf('Error') >= 0).join(' / '));
	} finally { rmSync(scratch, { recursive: true, force: true }); }
});

await kase('lapsed_entry_as_of: an entry no longer listed leaves its words, "as of" while under way', async () => {
	const pg = page();
	postShip(pg, 'a', { id: sid('a'), state: 'shipping', at: iso(NOW - 10 * MIN) });
	postShip(pg, 'b', { id: sid('b'), state: 'stopped', step: 'arms', words: 'red', at: iso(NOW - 10 * MIN) });
	await pg.poll();
	pg.st.list.length = 0;
	await pg.poll();
	const ts = pg.ships();
	eq(ts.map((x) => x.headline.split('|')[0]).sort(), ['pending.ship.shipping', 'pending.ship.stopped'], 'both kept');
	const sh = texts(pg.draw(ts.find((x) => x.headline.indexOf('shipping') >= 0)));
	ok(sh.some((s) => s.indexOf('pending.ship.as_of|') === 0), 'shipping says as of: ' + JSON.stringify(sh));
	const st = texts(pg.draw(ts.find((x) => x.headline.indexOf('stopped') >= 0)));
	ok(!st.some((s) => s.indexOf('pending.ship.as_of') === 0), 'a terminal state does not: ' + JSON.stringify(st));
});

await kase('relay_down_writes_nothing: an unreadable listing or body changes nothing and marks nothing stale', async () => {
	const pg = page();
	const n = postShip(pg, 'a', { state: 'shipping' });
	await pg.poll();
	const before = pg.held(sid('a'));
	ok(before, 'raised first');
	pg.st.down = true;
	await pg.poll();
	pg.st.down = false;
	pg.st.whole[n] = 'down';
	await pg.poll();
	eq(pg.held(sid('a')), before, 'held item unchanged');
	const sh = texts(pg.draw(pg.ships()[0]));
	ok(!sh.some((s) => s.indexOf('pending.ship.as_of') === 0), 'not marked stale: ' + JSON.stringify(sh));
});

await kase('malformed_entry_skipped: a bad id, state, time or commit is skipped, the rest raised', async () => {
	const pg = page();
	postShip(pg, '1', { id: 'zz' });
	postShip(pg, '2', { id: sid('2'), state: 'bogus' });
	postShip(pg, '3', { id: sid('3'), at: 'yesterday' });
	postShip(pg, '4', { id: sid('4'), commit: 'abc' });
	pg.st.whole[nonce('S5', 1)] = { nonce: nonce('S5', 1), kind: 'ship', install: INSTALL, body: 'not json', expires_in: 600 };
	pg.st.list.push({ nonce: nonce('S5', 1), kind: 'ship', expires_in: 600 });
	postShip(pg, '6', { id: sid('6') });
	await pg.poll();
	eq(pg.keys(), ['@runner:plainship.' + sid('6')], 'only the good one');
});

await kase('newline_safe: line breaks and control characters in the text become one space', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'stopped', summary: 'Fix\nthe\u001b rail\u0085now\u202e!\u2066x\u200f\u061c', step: 'ar\r\nms', words: 'two\treds\u2028here' });
	await pg.poll();
	eq(pg.ships().map((x) => x.headline), ['pending.ship.stopped|build=,step=ar ms,summary=Fix the rail now ! x,words=two reds here'], 'one line each');
	ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(JSON.parse(pg.held(sid('a')).detail.slice(INSTALL.length + 1)).m), 'none in the synced detail');
});

await kase('capped_fits: an over-long body is fitted to the record, the longest text cut first, words kept', async () => {
	const pg = page();
	const words = 'Refused: ' + '😀'.repeat(900) + ' end';
	postShip(pg, 'a', { state: 'refused', summary: 'S'.repeat(400), words, reds: 'r'.repeat(50) });
	await pg.poll();
	const h = pg.held(sid('a'));
	ok(h, 'raised (not refused whole by the record)');
	ok(Buffer.byteLength(h.detail) <= 600, 'within 600 UTF-8 bytes: ' + Buffer.byteLength(h.detail));
	const j = JSON.parse(h.detail.slice(INSTALL.length + 1));
	ok(j.w.indexOf('Refused: 😀') === 0 && j.w.slice(-1) === '…', 'words kept, cut with …: ' + j.w.slice(0, 20));
	ok(j.m.slice(-1) === '…' && Array.from(j.m).length > 100, 'summary cut, not emptied: ' + Array.from(j.m).length);
	eq(j.x, 'r'.repeat(50), 'a short field untouched');
});

await kase('duplicate_entries_newest_wins: two entries of one id in one listing, the newer first', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'live', build: 'B3', at: iso(NOW - 2 * MIN) });
	postShip(pg, 'b', { state: 'shipping', at: iso(NOW - 9 * MIN) });
	await pg.poll();
	eq(pg.ships().map((x) => x.headline), ['pending.ship.live|build=B3,step=?,summary=Fix the rail,words=?'], 'newest');
});

await kase('merge_two_devices: one item from two devices, and a regress by a late stamp heals at the next read', async () => {
	const d1 = page(), d2 = page();
	postShip(d1, 'a', { state: 'live', build: 'B1', at: iso(NOW - 5 * MIN) });
	await d1.poll();
	d2.win._setNow(NOW + MIN);		// d2 read the older state, and wrote it later on its clock
	postShip(d2, 'a', { state: 'shipping', at: iso(NOW - 10 * MIN) });
	await d2.poll();
	const m = d1.A.merge(d1.A.syncSnapshot(), d2.A.syncSnapshot());
	eq(Object.keys(m.items).filter((k) => k.indexOf('plainship.') >= 0).length, 1, 'one item');
	d1.A.adoptSync(d2.A.syncSnapshot());
	d1.win._setNow(NOW + 2 * MIN);
	await d1.poll();
	eq(d1.ships().map((x) => x.headline), ['pending.ship.live|build=B1,step=?,summary=Fix the rail,words=?'], 'newest state after the next read');
});

await kase('dismiss_holds_until_next_state: ✕ holds the state down; a newer state comes up though it happened before the ✕', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'shipping', at: iso(NOW - 10 * MIN) });
	await pg.poll();
	pg.fns.Pending.drop(pg.ships()[0].id);
	await pg.poll();
	eq(pg.ships().length, 0, 'down after ✕');
	// It went live before his ✕ (NOW - 5 min); the desk posts it after (the next read, at NOW).
	postShip(pg, 'a', { state: 'live', build: 'B1', at: iso(NOW - 5 * MIN) });
	await pg.poll();
	eq(pg.ships().map((x) => x.headline), ['pending.ship.live|build=B1,step=?,summary=Fix the rail,words=?'], 'the next state up');
});

await kase('lapsed_quiet_not_reraised: a quiet state that lapsed after a day does not come back at the next read', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'live', build: 'B1', at: iso(NOW - 5 * MIN) });
	await pg.poll();
	eq(pg.ships().length, 1, 'up');
	pg.win._setNow(NOW + 25 * 60 * MIN);
	await pg.poll();
	eq(pg.ships().length, 0, 'lapsed, and not raised again');
});

await kase('add_refuses_ship_kind: Pending.add will not take a plainship item (guard)', async () => {
	const pg = page();
	const r = pg.fns.Pending.add({ kind: 'plainship', headline: 'x', detail: 'y' });
	ok(!r, 'refused: ' + JSON.stringify(r));
	eq(pg.ships().length, 0, 'nothing drawn');
});

await kase('door_refuses_ship_key: a daimon (or a runner report) cannot raise or clear plainship.*', async () => {
	const pg = page();
	const tool = pg.win.DaimondPendingTool;
	const r = JSON.parse(tool.raise('dmd1', JSON.stringify({ key: 'plainship.' + sid('a'), headline: 'Deployed', detail: 'x', needs: true })));
	eq(r.ok, false, 'raise refused');
	const c = JSON.parse(tool.clear('dmd1', JSON.stringify({ key: 'plainship.' + sid('a') })));
	eq(c.ok, false, 'clear refused');
});

await kase('quiet_ship_not_counted: the chip counts stopped and refused, not queued, shipping or deployed', async () => {
	const pg = page();
	postShip(pg, '1', { id: sid('1'), state: 'queued' });
	postShip(pg, '2', { id: sid('2'), state: 'shipping' });
	postShip(pg, '3', { id: sid('3'), state: 'live', build: 'B' });
	postShip(pg, '4', { id: sid('4'), state: 'stopped', step: 'arms', words: 'red' });
	await pg.poll();
	eq(pg.ships().length, 4, 'four drawn');
	eq(pg.fns.Pending.counted(), 1, 'one counted');
});

await kase('card_folds_ship_line: the card draws the ship\'s state in place of Approve; one tile', async () => {
	const pg = page();
	const card = postCard(pg);
	postShip(pg, 'a', { card, state: 'shipping' });
	await pg.poll();
	eq(pg.ships().length, 0, 'no ship tile beside the card');
	const cards = pg.items().filter((x) => x.kind === 'submit');
	eq(cards.length, 1, 'the card');
	eq(cards[0].needs, false, 'needs as the ship does');
	pg.draw(cards[0]);
	await new Promise((r) => setTimeout(r, 30));
	const els = pg.draw(pg.items().filter((x) => x.kind === 'submit')[0]);
	const tx = texts(els);
	ok(tx.indexOf('pending.ship.shipping|build=,step=?,summary=Fix the rail,words=?') >= 0, 'ship line: ' + JSON.stringify(tx));
	ok(!els.some((e) => String(e.className).indexOf('pend-submit-approve') >= 0), 'no Approve');
	ok(tx.indexOf('pending.plain.approved') < 0, 'not "Approved. It ships next"');
});

await kase('ship_item_after_card_lapse: once the card is gone the ship item is the tile, with ✕', async () => {
	const pg = page();
	const card = postCard(pg);
	postShip(pg, 'a', { card, state: 'stopped', step: 'arms', words: 'red', reds: 'arms: 2 red' });
	await pg.poll();
	pg.st.list.splice(pg.st.list.findIndex((e) => e.nonce === card), 1);
	await pg.poll();
	const ts = pg.ships();
	eq(ts.map((x) => x.headline), ['pending.ship.stopped|build=,step=arms,summary=Fix the rail,words=red'], 'the ship tile');
	const els = pg.draw(ts[0]);
	ok(texts(els).indexOf('arms: 2 red') >= 0, 'reds line: ' + JSON.stringify(texts(els)));
	const x = els.find((e) => e.textContent === '✕');
	ok(x, '✕ offered');
	x.on.click();
	eq(pg.ships().length, 0, '✕ takes it down');
});

await kase('no_ship_entry_card_unchanged: with no ship entry (an old Kimberlite) the card is as before (guard)', async () => {
	const pg = page();
	const card = postCard(pg);
	await pg.poll();
	let it = pg.items().filter((x) => x.kind === 'submit')[0];
	pg.draw(it);
	await new Promise((r) => setTimeout(r, 30));
	const go = pg.draw(it).find((e) => String(e.className).indexOf('pend-submit-approve') >= 0);
	ok(go, 'Approve offered');
	go.on.click();
	pg.st.list.find((e) => e.nonce === card).answered = true;
	await pg.poll();
	it = pg.items().filter((x) => x.kind === 'submit')[0];
	ok(texts(pg.draw(it)).indexOf('pending.plain.approved') >= 0, '"Approved. It ships next" after his tap');
});

await kase('bad_sig_dropped: a body not the one signed is dropped, uncounted; the signed one beside it raised', async () => {
	const pg = page();
	postShip(pg, '1', { id: sid('1'), state: 'stopped', step: 'arms', words: 'red' }, INSTALL, { sigBody: '{"other":1}' });
	postShip(pg, '2', { id: sid('2'), state: 'shipping' });
	await pg.poll();
	eq(pg.keys(), ['@runner:plainship.' + sid('2')], 'only the signed one');
	eq(pg.fns.Pending.counted(), 0, 'nothing counted');
});

await kase('other_accounts_device_not_drawn: an entry signed by a runner of another account is dropped', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'refused', words: 'forged' }, INSTALL, { dev: ALIEN });
	await pg.poll();
	eq(pg.keys(), [], 'nothing raised');
	eq(pg.ships().length, 0, 'nothing drawn');
});

await kase('pending_device_not_drawn: a runner still waiting for his approval is not a signer', async () => {
	const pg = page();
	pg.st.runners.push(runnerRow(PEND, 'pending'));
	postShip(pg, 'a', { state: 'refused', words: 'early' }, INSTALL, { dev: PEND });
	await pg.poll();
	eq(pg.keys(), [], 'nothing raised');
});

await kase('removed_device_withdrawn: an item raised from a runner he then removed is not drawn or counted', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'stopped', step: 'arms', words: 'red' });
	await pg.poll();
	eq(pg.ships().length, 1, 'up while his');
	pg.st.runners = [];
	await pg.poll();
	eq(pg.ships().length, 0, 'withdrawn');
	eq(pg.fns.Pending.counted(), 0, 'not counted');
});

await kase('locked_holds_and_hides: no keys yet, nothing drawn or raised; once read, drawn and not "as of"', async () => {
	const pg = page();
	postShip(pg, 'a', { id: sid('a'), state: 'shipping', at: iso(NOW - 10 * MIN) });
	await pg.poll();
	const pg2 = page({ ls: pg.win.localStorage });
	pg2.st.list = pg.st.list; pg2.st.whole = pg.st.whole;
	pg2.st.unlocked = false;
	postShip(pg2, 'b', { id: sid('b'), state: 'stopped', step: 'arms', words: 'red' });
	await pg2.poll();
	eq(pg2.ships().length, 0, 'not drawn while locked');
	eq(pg2.held(sid('b')), null, 'nothing raised while locked');
	pg2.st.unlocked = true;
	await pg2.fns.runnerPairPoll();
	const ts = pg2.ships();
	eq(ts.map((x) => x.headline.split('|')[0]), ['pending.ship.shipping'], 'drawn once his keys are read');
	ok(!texts(pg2.draw(ts[0])).some((x) => x.indexOf('pending.ship.as_of') === 0), 'not "as of": the locked read was held, not taken as empty');
});

await kase('dismissed_elsewhere_stays_down_after_wake: a device whose record has not heard of a ✕ given elsewhere raises it, and the ✕ wins the merge both ways', async () => {
	const d1 = page(), d2 = page();
	postShip(d1, 'a', { state: 'live', build: 'B1', at: iso(NOW - 5 * MIN) });
	await d1.poll();
	d1.fns.Pending.drop(d1.ships()[0].id);
	d2.win._setNow(NOW + MIN);
	postShip(d2, 'a', { state: 'live', build: 'B1', at: iso(NOW - 5 * MIN) });
	await d2.poll();
	eq(d2.ships().length, 1, 'd2, not yet merged, raised it');
	const a = d1.A.merge(d1.A.syncSnapshot(), d2.A.syncSnapshot()), b = d1.A.merge(d2.A.syncSnapshot(), d1.A.syncSnapshot());
	const st = (m) => Object.keys(m.items).filter((k) => k.indexOf('plainship.') >= 0).map((k) => m.items[k].state);
	eq([st(a), st(b)], [['dismissed'], ['dismissed']], 'the ✕ wins in either order');
	d2.A.adoptSync(d1.A.syncSnapshot());
	d1.A.adoptSync(d2.A.syncSnapshot());
	d2.win._setNow(NOW + 2 * MIN);
	await d2.poll();
	d1.A.adoptSync(d2.A.syncSnapshot());
	eq(d1.ships().length, 0, 'still down on the device that took it down');
	eq(d2.ships().length, 0, 'and on the one that had not heard of it');
});

await kase('stuck_shipping_after_a_day: a state under way that lapses comes back as Stalled, needs him, until ✕', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'shipping', at: iso(NOW - 10 * MIN) });
	await pg.poll();
	pg.st.list.length = 0;
	pg.win._setNow(NOW + 30 * MIN);
	await pg.poll();
	eq(pg.ships().map((x) => x.needs), [false], 'not Stalled inside its stall_secs');
	pg.win._setNow(NOW + 25 * 60 * MIN);
	await pg.poll();
	const ts = pg.ships();
	eq(ts.map((x) => x.headline), ['pending.ship.stalled|summary=Fix the rail,when=' + new Date(NOW - 10 * MIN).toLocaleString()], 'Stalled');
	eq(ts.map((x) => x.needs), [true], 'needs him');
	eq(pg.fns.Pending.counted(), 1, 'counted');
	pg.fns.Pending.drop(ts[0].id);
	pg.win._setNow(NOW + 50 * 60 * MIN);
	await pg.poll();
	eq(pg.ships().length, 0, 'his ✕ holds');
	postShip(pg, 'a', { state: 'live', build: 'B9', at: iso(NOW + 49 * 60 * MIN) });
	await pg.poll();
	eq(pg.ships().map((x) => x.headline), ['pending.ship.live|build=B9,step=?,summary=Fix the rail,words=?'], 'a terminal state replaces it');
});

await kase('no_stall_secs_no_stalled: an entry from a Kimberlite that sends no stall_secs only goes "as of"', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'shipping', stall_secs: undefined });
	await pg.poll();
	pg.st.list.length = 0;
	pg.win._setNow(NOW + 2 * 60 * MIN);
	await pg.poll();
	const ts = pg.ships();
	eq(ts.map((x) => x.headline), ['pending.ship.shipping|build=,step=?,summary=Fix the rail,words=?'], 'its state, not Stalled');
	eq(ts.map((x) => x.needs), [false], 'quiet');
	ok(texts(pg.draw(ts[0])).some((t) => t.indexOf('pending.ship.as_of') === 0), 'drawn "as of": ' + texts(pg.draw(ts[0])).join(' / '));
});

await kase('the_ship_v1_vector_verifies: the shared vector\'s signed bytes, and each case kept or dropped at its own now', async () => {
	const ROW = { paired: 'active', pending: 'pending' };
	const all = SHIP_V1.cases.concat(SHIP_V1.refusals || []);
	ok(all.some((c) => c.expect === 'dropped') && all.some((c) => c.expect === 'kept'), 'both outcomes in the file');
	for (const c of SHIP_V1.cases) eq(shipSigned(c.device, c.install, c.nonce, c.at, c.body).toString('hex'), c.signed_hex, c.name + ': signed bytes');
	for (const c of all) {
		ok(c.expect === 'kept' || c.expect === 'dropped', c.name + ': expect ' + c.expect);
		ok(Date.parse(c.now_rfc3339) === c.now * 1000, c.name + ': now and now_rfc3339 agree');
		const pg = page({ install: c.install });
		pg.win._setNow(c.now * 1000);
		pg.st.gw = c.now * 1000;
		pg.st.repost = SHIP_V1.repost_secs;
		pg.st.skew = SHIP_V1.skew_secs;
		pg.st.runners = ROW[c.device_state] ? [{ device: c.device, kind: 'runner', state: ROW[c.device_state], name: c.device, pubkey: c.pubkey, joined: 1, approved: 2 }] : [];
		pg.st.lists[c.install] = [{ nonce: c.nonce, kind: 'ship', device: c.device, expires_in: 600 }];
		pg.st.whole[c.nonce] = { nonce: c.nonce, kind: 'ship', install: c.install, device: c.device, at: c.at, body: c.body, sig: c.sig, expires_in: 600 };
		await pg.poll();
		eq(pg.held(JSON.parse(c.body).id) ? 'kept' : 'dropped', c.expect, c.name + ' (' + c.reason + ')');
	}
});

await kase('install_bound_sig: a state signed for another install, served under this one, is dropped', async () => {
	const pg = page();
	postShip(pg, '1', { id: sid('1'), state: 'stopped', step: 'arms', words: 'red' }, INSTALL, { sigInst: OTHER });
	postShip(pg, '2', { id: sid('2'), state: 'shipping' });
	await pg.poll();
	eq(pg.keys(), ['@runner:plainship.' + sid('2')], 'only the one signed for this install');
});

await kase('stale_ship_post_not_drawn: a post outside repost + skew of the gateway\'s clock, either way, is dropped (a replay after a lapse)', async () => {
	const pg = page();
	const t = Math.floor(NOW / 1000), w = 420 + 120;
	postShip(pg, '1', { id: sid('1'), state: 'stopped', step: 'arms', words: 'red' }, INSTALL, { at: t - w - 1 });
	postShip(pg, '2', { id: sid('2'), state: 'shipping' }, INSTALL, { at: t - w });
	postShip(pg, '3', { id: sid('3'), state: 'refused', words: 'x', at: iso(NOW + 9 * MIN) }, INSTALL, { at: t + w + 1 });
	postShip(pg, '4', { id: sid('4'), state: 'queued', at: iso(NOW + 8 * MIN) }, INSTALL, { at: t + w });
	await pg.poll();
	eq(pg.keys().sort(), ['@runner:plainship.' + sid('2'), '@runner:plainship.' + sid('4')], 'only those inside the window');
});

await kase('post_at_orders_one_state: two entries of one id and one state time, the later post wins whatever the order', async () => {
	const pg = page();
	const t = Math.floor(NOW / 1000);
	postShip(pg, 'a', { state: 'served', build: 'B1', alert: false }, INSTALL, { nonce: nonce('Sa', 1), at: t - 300 });
	postShip(pg, 'b', { state: 'served', build: 'B1', alert: true }, INSTALL, { nonce: nonce('Sb', 1), at: t - 60 });
	await pg.poll();
	eq(pg.ships().map((x) => x.needs), [true], 'the later post (alert) raised');
});

await kase('submit_dismissed_elsewhere_stays_down_after_wake: a device whose record has not heard of a card ✕ given elsewhere raises it, and the ✕ wins the merge both ways (UNBLOCK-195)', async () => {
	const d1 = page(), d2 = page();
	const subs = (pg) => pg.items().filter((x) => x.kind === 'submit');
	postCard(d1);
	await d1.poll();
	eq(subs(d1).length, 1, 'the card is up');
	d1.fns.Pending.drop(subs(d1)[0].id);
	d2.win._setNow(NOW + MIN);
	postCard(d2);
	await d2.poll();
	eq(subs(d2).length, 1, 'd2, not yet merged, raised it');
	const a = d1.A.merge(d1.A.syncSnapshot(), d2.A.syncSnapshot()), b = d1.A.merge(d2.A.syncSnapshot(), d1.A.syncSnapshot());
	const st = (m) => Object.keys(m.items).filter((k) => k.indexOf('submit.') >= 0).map((k) => m.items[k].state);
	eq([st(a), st(b)], [['dismissed'], ['dismissed']], 'the ✕ wins in either order');
	d2.A.adoptSync(d1.A.syncSnapshot());
	d2.win._setNow(NOW + 2 * MIN);
	await d2.poll();
	d1.A.adoptSync(d2.A.syncSnapshot());
	eq(subs(d1).length, 0, 'still down on the device that took it down');
	eq(subs(d2).length, 0, 'and on the one that had not heard of it');
});

for (const [what, post, mine] of [
	['ship', (pg) => postShip(pg, 'a', { state: 'stopped', step: 'build', words: 'red' }), (pg) => pg.ships()],
	['submit', (pg) => postCard(pg), (pg) => pg.items().filter((x) => x.kind === 'submit')],
]) {
	await kase('locked_' + what + '_drawn_at_once: a device whose sync pull cannot answer draws a new ' + what + ' item at its first read, no wait', async () => {
		const pg = page();
		post(pg);
		await pg.poll();
		eq(mine(pg).length, 1, 'drawn at once');
	});
}

await kase('unverified_ship_never_drawn: a ship body from the listing, or from a read of another kind, is settled only through shipRead', async () => {
	const pg = page();
	pg.st.hostile = true;
	const body = JSON.stringify(shipBodyOf({ id: sid('f'), state: 'stopped', step: 'arms', words: 'forged' }));
	pg.st.list.push({ nonce: nonce('Sf', 1), kind: 'ship', expires_in: 600, body, device: DEV });
	const n = nonce('Sg', 1), b2 = JSON.stringify(shipBodyOf({ id: sid('e'), state: 'live', build: 'EVIL' }));
	pg.st.list.push({ nonce: n, kind: 'release', alarmed: true, expires_in: 600 });
	pg.st.whole[n] = { nonce: n, kind: 'ship', install: INSTALL, device: DEV, at: Math.floor(NOW / 1000) - 60, postAt: Math.floor(NOW / 1000), body: b2, sig: 'AAAA' };
	postShip(pg, 'a', { id: sid('a'), state: 'shipping' });
	await pg.poll();
	eq(pg.keys(), ['@runner:plainship.' + sid('a')], 'only the signed one raised');
	eq(pg.fns.Pending.counted(), 0, 'nothing counted');
	// A listed body whose read fails, or read while his runners' keys are not known: still unread.
	const b3 = JSON.stringify(shipBodyOf({ id: sid('b'), state: 'refused', words: 'forged' }));
	const m = nonce('Sh', 1);
	pg.st.list.push({ nonce: m, kind: 'ship', device: DEV, body: b3, postAt: Math.floor(NOW / 1000), expires_in: 600 });
	pg.st.whole[m] = 'down';
	await pg.poll();
	pg.st.unlocked = false;
	await pg.poll();
	eq(pg.keys(), ['@runner:plainship.' + sid('a')], 'nothing raised from a listed body');
});

await kase('lock_clears_keys: once his identity locks, no ship item is drawn on the keys read before', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'stopped', step: 'arms', words: 'red' });
	await pg.poll();
	eq(pg.ships().length, 1, 'drawn while unlocked');
	pg.st.runners = [];
	pg.st.unlocked = false;
	pg.win._setNow(NOW + 2 * MIN);
	await pg.poll();
	eq(pg.ships().length, 0, 'not drawn on keys it could not read again');
});

for (const code of [401, 410]) {
	await kase('gone_session_clears_keys_' + code + ': pair/list answering ' + code + ' clears his runners\' keys', async () => {
		const pg = page();
		postShip(pg, 'a', { state: 'stopped', step: 'arms', words: 'red' });
		await pg.poll();
		eq(pg.ships().length, 1, 'drawn');
		pg.st.pair = code;
		await pg.fns.runnerPairPoll();
		eq(pg.ships().length, 0, 'not drawn once the session is over');
	});
}

await kase('net_fail_keeps_keys: a pair/list that fails on the network or answers 5xx keeps his runners\' keys', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'stopped', step: 'arms', words: 'red' });
	await pg.poll();
	for (const f of [503, 'throw']) {
		pg.st.pair = f;
		await pg.fns.runnerPairPoll();
		eq(pg.ships().length, 1, 'still drawn after ' + f);
	}
});

await kase('future_body_at_refused: a state dated past its own post time + skew is refused and cannot hold later states down', async () => {
	const pg = page();
	const t = Math.floor(NOW / 1000);
	postShip(pg, 'a', { id: sid('a'), state: 'shipping', at: '2036-01-01T00:00:00Z' }, INSTALL, { nonce: nonce('Sa', 1), at: t - 120 });
	postShip(pg, 'c', { id: sid('c'), state: 'queued', at: iso((t + 120) * 1000) }, INSTALL, { nonce: nonce('Sc', 1), at: t });
	await pg.poll();
	eq(pg.keys(), ['@runner:plainship.' + sid('c')], 'refused past post + skew, kept at it');
	pg.st.list.length = 0;
	postShip(pg, 'b', { id: sid('a'), state: 'stopped', step: 'arms', words: 'red', at: iso(NOW - MIN) }, INSTALL, { nonce: nonce('Sb', 1), at: t - 30 });
	pg.win._setNow(NOW + 2 * MIN);
	await pg.poll();
	eq(pg.ships().filter((x) => x.ship.id === sid('a')).map((x) => x.ship.state), ['stopped'], 'the real later state shows');
});

await kase('alien_device_not_read: entries the listing names as signed by a runner not his are never read', async () => {
	const pg = page();
	for (let i = 0; i < 20; i++) postShip(pg, 'x' + i, { id: sid('d'), state: 'live' }, INSTALL, { dev: ALIEN, nonce: ('X' + i).padEnd(22, 'x') });
	postShip(pg, 'a', { id: sid('a'), state: 'shipping' });
	await pg.poll();
	eq(pg.keys(), ['@runner:plainship.' + sid('a')], 'only his raised');
	eq(pg.st.reads, 1, 'one read: his');
});

await kase('keys_arrive_redraws: a synced ship item is drawn as soon as his runners\' keys arrive', async () => {
	const pg = page();
	postShip(pg, 'a', { id: sid('a'), state: 'stopped', step: 'arms', words: 'red' });
	await pg.poll();
	const d2 = page();
	d2.A.adoptSync(pg.A.syncSnapshot());
	let renders = 0;
	d2.fns.Pending.render = () => { renders++; };
	eq(d2.ships().length, 0, 'hidden before the keys');
	await d2.fns.runnerPairPoll();
	ok(renders > 0, 'a render once the keys are in');
	eq(d2.ships().length, 1, 'and drawn');
	renders = 0;
	await d2.fns.runnerPairPoll();
	eq(renders, 0, 'no redraw when they did not change');
});

for (const what of ['ship', 'submit']) {
	await kase('dismiss_final_across_resume_' + what + ': a device that resumes with no visibilitychange raises, then merges, and the ✕ given elsewhere holds', async () => {
		const d1 = page(), d2 = page();
		d2.st.list = d1.st.list; d2.st.whole = d1.st.whole;
		const mine = (pg) => what === 'ship' ? pg.ships() : pg.items().filter((x) => x.kind === 'submit');
		if (what === 'ship') { postShip(d1, 'a', { state: 'shipping', at: iso(NOW - 10 * MIN) }); await d1.poll(); }
		await d2.poll();
		d1.win._setNow(NOW + 2 * HOUR);
		if (what === 'ship') postShip(d1, 'a', { state: 'live', build: 'B1', at: iso(NOW + 100 * MIN) });
		else postCard(d1);
		await d1.poll();
		d1.fns.Pending.drop(mine(d1)[0].id);
		eq(mine(d1).length, 0, 'down on d1');
		d2.win._setNow(NOW + 3 * HOUR);
		if (what === 'ship') postShip(d2, 'a', { state: 'live', build: 'B1', at: iso(NOW + 100 * MIN) });	// the desk's re-post
		await d2.poll();
		eq(mine(d2).length, 1, 'd2 raised it before its pull');
		d2.A.adoptSync(d1.A.syncSnapshot());
		d1.A.adoptSync(d2.A.syncSnapshot());
		eq(mine(d1).length, 0, 'still down on d1');
		eq(mine(d2).length, 0, 'down on d2');
		d2.win._setNow(NOW + 3 * HOUR + MIN);
		await d2.poll();
		d1.A.adoptSync(d2.A.syncSnapshot());
		eq(mine(d1).length, 0, 'and at d2\'s next read');
	});
}

await kase('served_never_stalled: served, with an alert or without, keeps Deployed past stall_secs, listed or not', async () => {
	const pg = page();
	postShip(pg, 'a', { id: sid('a'), state: 'served', build: 'B1', alert: true, at: iso(NOW - 10 * MIN) });
	postShip(pg, 'b', { id: sid('b'), state: 'served', build: 'B2', at: iso(NOW - 10 * MIN) });
	await pg.poll();
	pg.win._setNow(NOW + 2 * HOUR);
	postShip(pg, 'a', { id: sid('a'), state: 'served', build: 'B1', alert: true, at: iso(NOW - 10 * MIN) });
	pg.st.list.splice(pg.st.list.findIndex((e) => e.nonce === nonce('Sb', 1)), 1);
	await pg.poll();
	eq(pg.ships().map((x) => x.headline.split('|')[0]).sort(), ['pending.ship.served', 'pending.ship.served_alert'], 'Deployed, never Stalled');
});

await kase('fold_listing_unread: a phone that cannot read the card\'s listing draws one tile for the submission, counted once', async () => {
	const d1 = page();
	const card = postCard(d1);
	postShip(d1, 'a', { card, state: 'stopped', step: 'arms', words: 'red' });
	await d1.poll();
	eq(d1.items().filter((x) => x.kind === 'submit' || x.kind === 'plainship').length, 1, 'one tile on the desk');
	const ph = page({ install: '', ls: d1.win.localStorage });
	ph.st.down = true;
	await ph.poll();
	eq(ph.items().filter((x) => x.kind === 'submit' || x.kind === 'plainship').map((x) => x.kind), ['submit'], 'the card, the ship folded in it');
	eq(ph.fns.Pending.counted(), 1, 'counted once');
});

await kase('fold_submit_not_up: the card listed but its submit item not up here, the ship state is its own tile', async () => {
	const d1 = page();
	const card = postCard(d1);
	postShip(d1, 'a', { card, state: 'stopped', step: 'arms', words: 'red' });
	await d1.poll();
	const ph = page({ install: '', ls: d1.win.localStorage });
	ph.st.list = d1.st.list; ph.st.whole = d1.st.whole; ph.st.lists = d1.st.lists;
	ph.A.dismiss(ph.A.RUNNER + ':submit.' + card + '.' + PV1.vectors[0].seq);	// his ✕ of the card, here
	await ph.poll();
	const its = ph.items().filter((x) => x.kind === 'submit' || x.kind === 'plainship');
	eq(its.map((x) => x.kind), ['plainship'], 'the stopped state drawn, once');
});

await kase('age_on_gateway_clock: a fresh post is kept and a stale one dropped whether the device runs fast or slow', async () => {
	for (const off of [20 * MIN, -20 * MIN]) {
		const pg = page();
		const t = Math.floor(NOW / 1000);
		pg.st.gw = NOW;
		pg.win._setNow(NOW + off);
		postShip(pg, '1', { id: sid('1'), state: 'stopped', step: 'arms', words: 'red' }, INSTALL, { at: t - 60 });
		postShip(pg, '2', { id: sid('2'), state: 'shipping' }, INSTALL, { at: t - 541 });
		await pg.poll();
		eq(pg.keys(), ['@runner:plainship.' + sid('1')], 'device ' + (off > 0 ? 'fast' : 'slow'));
	}
	const pg = page();
	pg.st.gw = null;		// the gateway's clock not learned yet: no age judged
	postShip(pg, '1', { id: sid('1'), state: 'shipping', at: iso(NOW - 90 * MIN) }, INSTALL, { at: Math.floor(NOW / 1000) - 5000 });
	await pg.poll();
	eq(pg.keys(), ['@runner:plainship.' + sid('1')], 'kept while the gateway clock is unknown');
});

await kase('aged_out_dropped: a post the page held goes once the gateway\'s clock passes repost + skew; its item stays', async () => {
	const pg = page();
	const t = Math.floor(NOW / 1000);
	postShip(pg, 'a', { id: sid('a'), state: 'stopped', step: 'arms', words: 'red' }, INSTALL, { at: t });
	await pg.poll();
	ok(pg.held(sid('a')), 'raised');
	postShip(pg, 'b', { id: sid('b'), state: 'shipping' }, INSTALL, { at: t });
	pg.win._setNow(NOW + 541 * 1000);
	await pg.poll();
	eq(pg.keys(), ['@runner:plainship.' + sid('a')], 'the aged post not raised');
});

await kase('stalled_listed_holds_still: a Stalled state the desk keeps re-posting is written once, not at every read', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'shipping', at: iso(NOW - 10 * MIN) });
	await pg.poll();
	pg.win._setNow(NOW + 2 * HOUR);
	postShip(pg, 'a', { state: 'shipping', at: iso(NOW - 10 * MIN) });
	await pg.poll();
	eq(pg.ships().map((x) => x.needs), [true], 'Stalled');
	const at0 = pg.held(sid('a')).at;
	for (const k of [1, 2, 3]) {
		pg.win._setNow(NOW + 2 * HOUR + k * MIN);
		postShip(pg, 'a', { state: 'shipping', at: iso(NOW - 10 * MIN) });
		await pg.poll();
	}
	eq(pg.held(sid('a')).at, at0, 'no write while nothing changed');
	eq(pg.ships().map((x) => x.needs), [true], 'still Stalled');
});

await kase('stalled_outlives_horizon: a Stalled item is re-stamped while it stays Stalled, and not shed past the month', async () => {
	const pg = page();
	postShip(pg, 'a', { state: 'shipping', at: iso(NOW - 10 * MIN) });
	await pg.poll();
	pg.st.list.length = 0;
	pg.win._setNow(NOW + 2 * HOUR);
	await pg.poll();
	eq(pg.ships().map((x) => x.needs), [true], 'Stalled');
	const at0 = pg.held(sid('a')).at;
	pg.win._setNow(NOW + 2 * HOUR + 8 * DAY);
	await pg.poll();
	ok(pg.held(sid('a')) && pg.held(sid('a')).at > at0, 're-stamped a week on');
	pg.win._setNow(NOW + 2 * HOUR + 40 * DAY);
	pg.fns.Pending.fresh();
	eq(pg.ships().map((x) => x.needs), [true], 'still drawn past the month');
});

console.log(failures ? failures + ' of ' + cases + ' FAILED' : 'all ' + cases + ' passed');
process.exit(failures ? 1 : 0);

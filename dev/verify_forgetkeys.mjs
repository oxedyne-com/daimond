// verify_forgetkeys.mjs — "Forget this identity" forgets the security settings too.
//
// THE DEFECT. The sweep in `forgetIdentity` (www/js/daimond.js) is a NAMED LIST, and
// the comment above it said the rest was caught by `remove()` below. It is not:
// `remove()` is guarded by `!acct.primary`, and accounts.js's own `remove()` refuses
// the primary outright and sweeps only `d~<id>~` keys anyway. There is no
// `localStorage.clear()` anywhere in the app. So on an ordinary single-user install
// — which is nearly all of them — a key missing from that list SURVIVES BEING
// FORGOTTEN, and the sentence saying otherwise is why nobody looked.
//
// WHAT A USER MEETS. A laptop is handed over. "Forget this identity" is used. A new
// identity is made — and it boots in BYPASS, where nothing is asked, having never
// been shown the one-off explanation of what bypass gives away, with commands
// granted the network in every chat. Nobody in that browser has answered one of
// those questions. Worse still sat beside them: the enrolled PASSKEY, whose record
// seals the identity bundle and the passphrase together (passkey.js, v2), so the
// browser kept a working door into the identity that had just been erased.
//
// THE TEST APPLIED, because "which keys" kept being answered case by case: a key
// belongs in that list when its ABSENCE is the careful default and its stale value
// would GRANT something the next person never chose, or SILENCE a warning they have
// never seen. Eight keys meet it. They are seeded here with permissive values, and
// the whole namespace was read against that test rather than only the three that
// were reported.
//
// FIVE PROPERTIES:
//
//   1. THE PREMISE, ASSERTED AND NOT ASSUMED. The account being forgotten is the
//      PRIMARY, and `DaimondAccounts.remove()` refuses it — so the named list really
//      is the whole sweep. Held first, because every check below is only about
//      anything at all if this is true, and a future change that made `remove()`
//      general would make them pass for a reason that had nothing to do with them.
//   2. THE THREE PERMISSION SETTINGS ARE GONE — the standing network answer, the
//      rung, and the bypass acknowledgement.
//   3. AND SO IS THE PASSKEY, which is the same fault at its worst.
//   4. AND THE FOUR OTHERS THE SWEEP OF THE NAMESPACE FOUND: the terminal's folder
//      ceiling, the trust log, the spend ceiling — and the agreement to be
//      recorded, which turned out to be cleared already by the sign-out that runs
//      first, and is asserted here because that call is wrapped in a `try/catch`
//      that says "erase anyway".
//   5. AND THE APP COMES BACK IN THE CAREFUL STATE, read from the engine and not
//      from the absent key: guarded, and asking about the network in each chat.
//      Separate from 2 because a key removed and a default not taken are two
//      claims, and a build that read the rung from somewhere else would satisfy
//      the first alone.
//
// PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_forgetkeys.mjs --break three   # 2, 5: the state before the fix
//   node dev/verify_forgetkeys.mjs --break passkey # 3
//   node dev/verify_forgetkeys.mjs --break sweep   # 2-4: the whole tail dropped
//   node dev/verify_forgetkeys.mjs                 # and then, clean
//
//   eval "$(bash dev/world.sh 4 --up)"
//   node dev/verify_forgetkeys.mjs
//
// Needs dev/serve.mjs and the mock. No gateway, no wasm rebuild.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch, shot } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Each break is one real edit to the served file: the sweep as it stood, in pieces.
const BREAKS = {
	three: {
		file: 'js/daimond.js',
		find: "\t\t\t 'daimond-net-standing', 'daimond-permission-mode', 'daimond-permission-bypass-ack',",
		with: "",
	},
	passkey: {
		file: 'js/daimond.js',
		find: "\t\t\t 'daimond-passkey', 'daimond-passkey-asked',",
		with: "",
	},
	// Everything after the trash swept into a list nothing runs: the sweep as it was
	// the day before the three were reported, with the ordinary stores still going.
	sweep: {
		file: 'js/daimond.js',
		find: "\t\t\t 'daimond-trash',\n",
		with: "\t\t\t 'daimond-trash',\n\t\t\t].forEach(function (k) { localStorage.removeItem(k); });\n\t\t\tif (false) [\n",
	},
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const stub = async (page) => {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	const src  = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	// An anchor that is not there exactly once patches nothing and the run would
	// pass quietly, which is worse than a red.
	if (src.split(spec.find).length !== 2) {
		console.error(`break '${BREAK}': its anchor is not in ${spec.file} exactly once`);
		process.exit(2);
	}
	const body = src.replace(spec.find, spec.with);
	await page.route('**/' + spec.file, (r) => r.fulfill({
		status: 200, contentType: 'application/javascript', body,
	}));
};

/// Everything seeded before the forget, with the value that makes it a GRANT rather
/// than a preference. The shapes are the ones the owning module writes: a stored rung
/// this build does not recognise falls back to the careful one, so a nonsense value
/// would make check 5 pass for the wrong reason.
const SEED = {
	'daimond-net-standing':          'allow',
	'daimond-permission-mode':       'bypass',
	'daimond-permission-bypass-ack': '1',
	'daimond-passkey':               JSON.stringify({ v: 2, cred: 'Y3JlZA==', blob: 'YmxvYg==' }),
	'daimond-telemetry':             '__ACCOUNT__',
	'daimond-terminal-root':         JSON.stringify({ 'ws-1': '/home' }),
	'daimond-trust-log':             JSON.stringify([{ scope: 'identity', method: 'in_person_qr' }]),
	'daimond-governor':              JSON.stringify({ budgetUsd: 500 }),
};

const s = await open({
	name:    'forgetkeys',
	profile: scratch('pw', 'forgetkeys' + (BREAK ? '-' + BREAK : '')),
	route:   stub,
});
const { page: p } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

try {
	// ── 1. The premise ───────────────────────────────────────────
	//
	// THE ACCOUNT IS THE PRIMARY AND CANNOT BE REMOVED, which is what makes the
	// named list the whole sweep. Asked of accounts.js itself rather than read off
	// the registry: `remove()` returning false is the behaviour the sweep depends
	// on, and a registry that merely says `primary: true` is a description of it.
	const premise = await p.evaluate(() => {
		const A = window.DaimondAccounts;
		if (!A) return { has: false };
		const id = A.current();
		return { has: true, id: id, removed: A.remove(id), n: A.count() };
	});
	check(premise.has && premise.removed === false && premise.n === 1,
		'THE ACCOUNT BEING FORGOTTEN IS THE PRIMARY, and accounts.js refuses to remove it',
		JSON.stringify(premise));

	// Seeded with the account's own id where the key holds one: `daimond-telemetry`
	// is compared against the CURRENT account, and the primary keeps its id through a
	// forget — which is exactly why an agreement left behind is inherited.
	await p.evaluate((seed) => {
		const id = (window.DaimondAccounts && window.DaimondAccounts.current()) || '';
		Object.keys(seed).forEach(function (k) {
			localStorage.setItem(k, seed[k] === '__ACCOUNT__' ? id : seed[k]);
		});
	}, SEED);
	const seeded = await p.evaluate((names) =>
		names.filter(k => localStorage.getItem(k) === null), Object.keys(SEED));
	check(seeded.length === 0,
		'and every setting under test is really present before the forget',
		seeded.length ? `missing: ${JSON.stringify(seeded)}` : '');

	// ── Forget, the way a person does it ─────────────────────────
	await p.evaluate(() => document.getElementById('user-row').click());
	await p.waitForTimeout(400);
	const label = await p.evaluate(() => DaimondI18n.t('identity.forget'));
	const hit = await p.evaluate((want) => {
		const b = [...document.querySelectorAll('#admin-home .admin-item')]
			.find(x => (x.textContent || '').trim() === want.trim());
		if (!b) return false;
		b.click();
		return true;
	}, label);
	check(hit, 'the account panel offers "Forget this identity"', JSON.stringify(label));
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await shot(s, 'forgetkeys-confirm');
	await p.evaluate(() => {
		const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
		card.querySelector('.dlg-ok').click();
	});
	// It ends in a reload. Waited for by the STATE the reload produces — an identity
	// gate over an app with no identity — rather than by a timer, which on a slow
	// OPFS wipe reads localStorage while the sweep is still running.
	await p.waitForFunction(() => {
		try { return localStorage.getItem('daimond-id-pub') === null; } catch (e) { return false; }
	}, null, { timeout: 30000 }).catch(() => {});
	await p.waitForTimeout(2500);

	const left = await p.evaluate((names) => {
		const out = {};
		names.forEach(function (k) {
			var v = null;
			try { v = localStorage.getItem(k); } catch (e) { v = 'unreadable'; }
			if (v !== null) out[k] = String(v).slice(0, 40);
		});
		return out;
	}, Object.keys(SEED));

	// ── 2. The three that were reported ──────────────────────────
	const three = ['daimond-net-standing', 'daimond-permission-mode', 'daimond-permission-bypass-ack'];
	const threeLeft = three.filter(k => k in left);
	check(threeLeft.length === 0,
		'THE THREE PERMISSION SETTINGS ARE GONE — the standing network answer, the rung, the bypass note',
		threeLeft.length ? `still set: ${JSON.stringify(threeLeft.map(k => [k, left[k]]))}` : '');

	// ── 3. The passkey ───────────────────────────────────────────
	check(!('daimond-passkey' in left),
		'AND THE PASSKEY IS GONE — a sealed record is a working door into the identity just erased',
		left['daimond-passkey'] ? `still set: ${left['daimond-passkey']}` : '');

	// ── 4. The four the namespace sweep found ────────────────────
	const rest = ['daimond-telemetry', 'daimond-terminal-root', 'daimond-trust-log', 'daimond-governor'];
	const restLeft = rest.filter(k => k in left);
	check(restLeft.length === 0,
		'AND SO ARE THE TERMINAL CEILING, THE TRUST LOG, THE SPEND CEILING AND THE AGREEMENT TO BE RECORDED',
		restLeft.length ? `still set: ${JSON.stringify(restLeft.map(k => [k, left[k]]))}` : '');

	// ── 5. And the app comes back careful ────────────────────────
	//
	// FROM THE ENGINE, not from the absent key. A key removed and a default taken
	// are two claims: `DaimondHandMode.get()` is what the chip and the wasm are
	// driven from, and a build that read the rung from somewhere else would have
	// satisfied check 2 while still booting in bypass.
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(2500);
	const after = await p.evaluate(() => ({
		rung:     (window.DaimondHandMode && DaimondHandMode.get) ? DaimondHandMode.get() : '(none)',
		standing: (window.DaimondHandMode && DaimondHandMode.standingNet) ? DaimondHandMode.standingNet() : '(none)',
	}));
	check(after.rung === 'guarded',
		'THE APP COMES BACK GUARDED, not in the bypass the last person chose',
		`rung=${after.rung}`);
	check(after.standing === '',
		'and the network is put to the user in each chat again',
		`standing=${JSON.stringify(after.standing)}`);
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);

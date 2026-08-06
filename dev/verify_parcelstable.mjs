// verify_parcelstable.mjs — the sync parcel is a fixed point, or two devices push for ever.
//
// `push()` skips the wire when the parcel stringifies to what it last sent
// (`www/js/sync.js:504`). That guard is the ONLY thing standing between an idle
// account and an endless round trip, and it compares bytes. So any part of the
// parcel that varies between two collects with nothing in between — a stamp
// taken at collect time, a map enumerated in whatever order the store felt like,
// a field rewritten by the merge — turns every device into a device that always
// has something to send.
//
// The failure that produces is not a slow sync. It is TWO DEVICES PUSHING AT
// EACH OTHER: A pushes, B pulls and merges, B's own collect now differs, B
// pushes, A pulls and merges, and neither of them is doing anything wrong. It
// was reported from an iPhone freshly paired by QR, as "the syncing seemed to go
// into an endless loop".
//
// Three properties, in the order they can break:
//
//   1. IDLE STABILITY. Two collects, nothing in between, byte-identical.
//   2. STABILITY AFTER WORK. The same, with Diamonds and a chat in the account,
//      because an empty account has almost nothing that could vary.
//   3. THE FIXED POINT, and this is the one the loop is made of. Applying a
//      parcel must not change what this device would then send. `applySync(p)`
//      followed by `collectSync()` must give `p` back. A merge that rewrites so
//      much as one stamp of its own fails here, and passes 1 and 2.
//
// Each failure names the sections that moved, then the fields inside them,
// because "the parcel differs" is not a finding anybody can act on.
//
//   node dev/verify_parcelstable.mjs
//
// Needs dev/serve.mjs on :8777. No gateway, no mock LLM: nothing here runs a turn.
import fs from 'node:fs';
import { open, signInAs, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'parcelstable');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Which top-level sections of two parcels differ, and — for an object or an
/// array of `{id}` — which entries inside them. A diff that stops at "diamonds"
/// sends the reader back to the same question they started with.
function differences(a, b) {
	const out = [];
	const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
	for (const k of keys) {
		const x = JSON.stringify(a ? a[k] : undefined);
		const y = JSON.stringify(b ? b[k] : undefined);
		if (x === y) continue;
		out.push(k + inner(a ? a[k] : undefined, b ? b[k] : undefined));
	}
	return out;
}

/// One level further in, when that is cheap and says something.
function inner(x, y) {
	if (Array.isArray(x) && Array.isArray(y)) {
		if (x.length !== y.length) return `[${x.length}→${y.length}]`;
		const moved = [];
		for (let i = 0; i < x.length; i++) {
			if (JSON.stringify(x[i]) === JSON.stringify(y[i])) continue;
			const id = (x[i] && (x[i].id || x[i].path || x[i].address)) || i;
			moved.push(String(id) + fields(x[i], y[i]));
		}
		return moved.length ? `[${moved.slice(0, 4).join(' ')}]` : '[reordered]';
	}
	if (x && y && typeof x === 'object' && typeof y === 'object') return fields(x, y);
	return '';
}

/// The named fields of two objects that do not match.
function fields(x, y) {
	if (!x || !y || typeof x !== 'object' || typeof y !== 'object') return '';
	const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])];
	const moved = keys.filter(k => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
	return moved.length ? `{${moved.slice(0, 5).join(',')}}` : '';
}

// Connected, because the rail's "new Diamond" control needs a provider before it
// will open its dialog, and an account with no Diamonds in it cannot show that
// the Diamonds section of the parcel is stable.
const s = await open({ name: 'parcelstable', profile: PROFILE });
const { page } = s;

try {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.collectSync),
		null, { timeout: 15000 });
	await page.waitForTimeout(800);

	const collect = () => page.evaluate(() => DaimondCore.collectSync());

	// ── 1. Idle stability ───────────────────────────────────────────
	// A pause between the two, because a stamp with second resolution taken at
	// collect time would sit still inside one millisecond and move inside two.
	const a1 = await collect();
	await page.waitForTimeout(2500);
	const a2 = await collect();
	const idle = differences(a1, a2);
	check(idle.length === 0, 'an idle account collects the same parcel twice', idle.join(' '));

	// ── 2. Stability with something in the account ──────────────────
	async function newDiamond(name) {
		await page.click('#new-diamond-btn', { force: true });
		await page.waitForSelector('.dlg-input', { timeout: 10000 });
		await page.fill('.dlg-input', name);
		await page.click('.dlg-ok', { force: true });
		await page.waitForTimeout(700);
	}
	await newDiamond('Stability one');
	await newDiamond('Stability two');
	await page.waitForTimeout(600);

	const b1 = await collect();
	await page.waitForTimeout(2500);
	const b2 = await collect();
	const worked = differences(b1, b2);
	check(worked.length === 0, 'an account with Diamonds collects the same parcel twice',
		worked.join(' '));

	// The parcel must actually have something in it, or checks 1-3 are three
	// ways of comparing two empty objects.
	const carried = (b2.diamonds || []).length;
	check(carried >= 2, 'and the parcel carries the Diamonds', `${carried} carried`);

	// ── 3. The fixed point ──────────────────────────────────────────
	// Apply this device's OWN parcel. Nothing in it is news, so nothing should
	// move -- and what this device would send next must be what it just took in.
	const applied = await page.evaluate(async (p) => {
		const report = await DaimondCore.applySync(p);
		return report && report.failed ? report.failed : [];
	}, b2);
	check(applied.length === 0, 'applying its own parcel reports no failed section',
		applied.join(','));

	await page.waitForTimeout(800);
	const c1 = await collect();
	const fixed = differences(b2, c1);
	check(fixed.length === 0, 'and leaves the next parcel unchanged (the fixed point)',
		fixed.join(' '));

	// ── 3b. A name parked at pairing, on storage that will not forget it ──
	// `touchSelfDevice` consumes `daimond-pair-label` and stamps `namedAt` with the
	// clock. The consuming `removeItem` is wrapped in a swallowing try/catch, so on
	// a browser that refuses the delete the label is read again on the NEXT collect
	// and stamped again -- a parcel that differs every time it is packed, on a
	// device that has just been paired, which is exactly the device the endless
	// loop was reported from. The stamp must be written only when the name it
	// carries actually changes, so that a failed delete costs nothing.
	// accounts.js shadows `removeItem` as an OWN property of the localStorage
	// instance so every `daimond-` key lands in the account's namespace, so the
	// prototype is not the thing the app calls and patching it proves nothing.
	// This file did exactly that first, and the check passed while testing nothing.
	await page.evaluate(() => {
		const real = localStorage.removeItem.bind(localStorage);
		localStorage.removeItem = function (k) {
			if (String(k).indexOf('daimond-pair-label') !== -1) return;	// the delete that will not take
			return real(k);
		};
		localStorage.setItem('daimond-pair-label', 'The phone');
	});
	const e1 = await collect();
	await page.waitForTimeout(1200);
	const e2 = await collect();
	const parked = differences(e1, e2);
	check(parked.length === 0,
		'a pairing name that will not delete is still stamped only once', parked.join(' '));

	// ── 4. And across a reload ──────────────────────────────────────
	// A device that restarts and immediately has something to send pushes on
	// every launch, which is the same loop with a slower clock.
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.collectSync),
		null, { timeout: 15000 });
	await page.waitForTimeout(1500);
	const d1 = await collect();
	const reloaded = differences(e2, d1);
	check(reloaded.length === 0, 'a reload does not change what this device would send',
		reloaded.join(' '));

} finally {
	await s.close();
}

console.log(bad === 0 ? '\nall checks passed' : `\n${bad} check(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);

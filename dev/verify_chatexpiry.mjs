// verify_chatexpiry.mjs — the algebra a chat's lifetime rests on.
//
// A chat is throw-away: untouched for the operator's few days it goes to the
// trash on its own, and the trash destroys it some weeks later. Both clocks run
// in the browser, on every device, with no server to arbitrate. So the whole
// feature is a claim about a MERGE, and this file is where that claim is put
// under load — two devices, driven directly, with parcels handed between them
// in whatever order the case wants.
//
// It runs under Node with no browser: `www/js/trash.js` is a classic script
// whose store half touches only `localStorage`, `window` and `fetch`, all three
// of which are shimmed below. The panel half is left unbuilt (no `document`
// nodes are asked for), which is deliberate — this file is about the record,
// and the panel is checked in the browser by verify_chatlife.mjs.
//
// WHAT IS ACTUALLY ASSERTED, and why each one is here:
//
//   1. A chat untouched past the window is trashed; one touched inside it is
//      not. The boundary, from both sides, because a check that only pushed a
//      chat far past the deadline would pass against code that trashed
//      everything.
//
//   2. THE OPERATOR SETTING MOVES THE BOUNDARY. The same chat, at the same
//      instant, under two different policies, comes out on opposite sides. This
//      is the check that fails if the knob is read once at boot, or read from
//      the wrong route, or ignored in favour of a constant.
//
//   3. TWO DEVICES CONVERGE RATHER THAN DUPLICATING. Two devices expire the
//      same chat days apart and must produce the SAME RECORD, byte for byte —
//      not two records, and not one record whose retention clock restarted. It
//      is asserted on the serialised parcel because that is what the push
//      comparison reads: a merge that differed by a field would push for ever.
//
//   4. AN AUTOMATIC ACT NEVER OUTRANKS A HUMAN ONE. A device that has been away
//      comes back with a deadline that has passed and must not bury a restore
//      somebody made by hand while it was gone. This is the property that made
//      `expire` take the deadline as an argument instead of stamping the clock,
//      and it is the one whose absence loses work.
//
//   5. A LOWERED RETENTION DOES NOT REACH BACK. The term is pinned on the
//      record when it is trashed, so moving the knob governs what happens next
//      and never brings forward a destruction date the panel has already shown
//      somebody.
//
//   6. THE TOMBSTONE TERM OUTLIVES A STALE PEER, including a peer working to a
//      retention this device has never been set to — which it learns from the
//      record the peer sends.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` patches
// www/js/trash.js in memory before it is evaluated, and the run is then expected
// to FAIL. A break whose anchor does not appear exactly once aborts, so a break
// that has rotted cannot report a quiet pass.
//
//   node dev/verify_chatexpiry.mjs --break stampsnow    # 3, 4: expire() stamps Date.now()
//   node dev/verify_chatexpiry.mjs --break repushes     # 3: expire() re-stamps an item already trashed
//   node dev/verify_chatexpiry.mjs --break buriesback   # 4: expire() ignores a restore
//   node dev/verify_chatexpiry.mjs --break livepolicy   # 5: retention read live, not pinned
//   node dev/verify_chatexpiry.mjs --break shorttomb    # 6: the old seven-day tombstone term
//   node dev/verify_chatexpiry.mjs --break ignoreknob   # 2: the expiry window is a constant
//   node dev/verify_chatexpiry.mjs                      # and then, clean
//
// No world and no server: it opens no port and touches no scratch directory.
import { readFileSync } from 'fs';
import vm from 'node:vm';

const SRC = new URL('../www/js/trash.js', import.meta.url);

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const DAY = 24 * 3600 * 1000;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
//
// Every one of these is a shape the code could plausibly have had. Two of them
// are shapes an earlier draft DID have.
const BREAKS = {
	// The obvious implementation: expiry is a trashing, so call the trashing
	// function. It is wrong because the stamp then says when this device
	// noticed rather than when the deadline passed, and two devices that
	// noticed at different times disagree for ever.
	stampsnow: {
		find: '\t\tr.at = when;',
		with: '\t\tr.at = Math.max(Date.now(), r.back + 1);',
	},
	// The guard against re-expiring something already in the trash is dropped.
	// Every sweep then rewrites the record and pushes the destruction date out,
	// so a trashed chat is never actually destroyed.
	repushes: {
		find: '\t\tif (r && r.at > r.back) return false;\t\t// already in the trash',
		with: '',
	},
	// The guard against outranking a restore is dropped.
	buriesback: {
		find: '\t\tif (r && when <= r.back) return false;\t\t// a restore outranks this deadline',
		with: '',
	},
	// The retention is read live from the policy instead of off the record —
	// which is what the file did before the figure was settable, and what makes
	// lowering the knob destroy things early.
	livepolicy: {
		find: '\t\t\t\tif (now >= r.at + r.r * DAY) {',
		with: '\t\t\t\tif (now >= r.at + retainDays() * DAY) {',
	},
	// The tombstone and restore-record term goes back to the flat seven days it
	// was, which is shorter than the retention it has to outlive.
	shorttomb: {
		find: '\t\ttombTtlMs:     function () { return (load().high + GRACE_DAYS) * DAY; },',
		with: '\t\ttombTtlMs:     function () { return 7 * DAY; },',
	},
	// The expiry window ignores the operator entirely.
	ignoreknob: {
		find: '\t\tchatExpireMs:  function () { return load().expire * DAY; },',
		with: '\t\tchatExpireMs:  function () { return 3 * DAY; },',
	},
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The module source, damaged if asked, or a hard stop.
function source() {
	let src = readFileSync(SRC, 'utf8');
	if (!BREAK) return src;
	const spec = BREAKS[BREAK];
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in trash.js, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

// ── One simulated device ─────────────────────────────────────────────
//
// A fresh evaluation of trash.js against its own `localStorage` and its own
// clock. Two of these is two devices; there is no shared state between them
// except the parcels this file hands over, which is the point.
function device(label) {
	const store = new Map();
	// A REAL vm context, in which `window` IS the global object — not a plain
	// object passed in under that name. It matters: trash.js publishes with
	// `window.DaimondTrash = …` and then reads `DaimondPolicy` as a BARE
	// identifier, which is only the same thing when `window` is the global. A
	// shim that got this wrong reported the shipped defaults for every policy
	// read and three checks below failed against correct code.
	const ctx = {
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => store.set(k, String(v)),
			removeItem: (k) => store.delete(k),
		},
		// No gateway in this harness. `refresh()` catches the rejection and
		// leaves the cached figures in place, which is the offline path.
		fetch: () => Promise.reject(new Error('no gateway in this harness')),
		// Just enough of a document for the PANEL half of the file to attach its
		// delegated listeners and then find nothing. It draws nothing here: every
		// render path returns early on a missing `#trash-list`, and none is
		// called. A fuller shim would be a second implementation of the browser
		// to keep in step, which is what this file most wants to avoid.
		document: {
			addEventListener: () => {},
			getElementById: () => null,
			querySelectorAll: () => [],
		},
		setTimeout, clearTimeout,
		console: { debug: () => {}, warn: () => {}, log: () => {} },
		Date, JSON, Math, Object, String, Number, Promise, isFinite, parseInt,
		// The cross-tab `storage` listener. One device here is one tab, so
		// nothing ever fires it; it exists because the module attaches it at load.
		addEventListener: () => {},
	};
	ctx.window = ctx;
	ctx.globalThis = ctx;
	vm.createContext(ctx);
	vm.runInContext(source(), ctx, { filename: 'trash.js[' + label + ']' });
	if (!ctx.DaimondTrash || !ctx.DaimondPolicy) {
		console.error(`device ${label}: trash.js did not publish its two modules`);
		process.exit(2);
	}
	// Asserted rather than assumed: if the bare-global lookup ever stops
	// working, every policy read below silently falls back to the shipped
	// figures and this file's checks become vacuous.
	ctx.DaimondPolicy.set(11, 22);
	if (ctx.DaimondTrash.retainMs() !== 22 * DAY) {
		console.error(`device ${label}: the trash store cannot see DaimondPolicy — `
			+ 'every check in this file would be measuring the shipped defaults.');
		process.exit(2);
	}
	ctx.DaimondPolicy.reset(); store.clear();
	return { label, trash: ctx.DaimondTrash, policy: ctx.DaimondPolicy, store };
}

/// Hand one device's state to the other, exactly as a parcel does.
const send = (from, to) => to.trash.adopt(from.trash.snapshot());

/// The bytes a push would compare. Two devices that have converged produce the
/// same string; two that have not, do not.
const bytes = (d) => JSON.stringify(d.trash.snapshot());

/// A chat's deadline, as `chatDueAt` in daimond.js computes it.
const dueOf = (d, touchedAt) => touchedAt + d.policy.chatExpireMs();

const CHAT = 'c-abc';
const T0 = Date.parse('2026-06-01T09:00:00Z');	// when the chat was last touched

// ── 1. The boundary, from both sides ─────────────────────────────────
{
	const d = device('A');
	d.policy.set(3, 30);
	const due = dueOf(d, T0);
	check('the window is the operator figure, in days', due - T0 === 3 * DAY,
		`${(due - T0) / DAY} days`);

	// Inside the window: a device looking on the last day must NOT trash it.
	// The caller is what decides, so the caller's rule is what is exercised:
	// `now >= due`.
	const insideNow = T0 + 3 * DAY - 1000;
	check('a chat touched inside the window is not yet due', insideNow < due);

	// Past it: trashed, and trashed AT THE DEADLINE.
	const movedOut = d.trash.expire(CHAT, 'chat', due);
	check('a chat untouched past the window is moved to the trash', movedOut === true);
	check('and it is IN the trash, not merely recorded', d.trash.has(CHAT) === true);
	check('and the record says the clock did it, not a person', d.trash.isAuto(CHAT) === true);
	const rec = d.trash.raw()[CHAT];
	check('the stamp written is the DEADLINE, not the moment it was noticed',
		rec.at === due, `at=${rec.at} due=${due}`);
}

// ── 2. The operator setting moves the boundary ───────────────────────
//
// The SAME chat and the SAME instant, judged under two policies. If the window
// were a constant this pair could not disagree.
{
	const strict = device('strict'); strict.policy.set(1, 30);
	const loose  = device('loose');  loose.policy.set(30, 30);
	const now = T0 + 5 * DAY;

	const dueStrict = dueOf(strict, T0), dueLoose = dueOf(loose, T0);
	check('a one-day policy has this chat overdue at five days', now >= dueStrict);
	check('a thirty-day policy does not', now < dueLoose);
	check('the two policies genuinely disagree about the same chat',
		(now >= dueStrict) !== (now >= dueLoose),
		`strict due ${(dueStrict - T0) / DAY}d, loose due ${(dueLoose - T0) / DAY}d`);

	strict.trash.expire(CHAT, 'chat', dueStrict);
	check('the chat is trashed under the short policy', strict.trash.has(CHAT) === true);
	check('and is untouched under the long one', loose.trash.has(CHAT) === false);
}

// ── 3. Two devices converge rather than duplicating ──────────────────
//
// A and B expire the same chat nine days apart. Both compute the deadline from
// the SAME synced `updatedAt`, so both must write the same record — and the
// serialised parcels must be identical, because that string is what the push
// compares against the last one sent.
{
	const A = device('A'), B = device('B');
	A.policy.set(3, 30); B.policy.set(3, 30);
	const due = dueOf(A, T0);

	A.trash.expire(CHAT, 'chat', due);				// A notices on the day
	B.trash.expire(CHAT, 'chat', dueOf(B, T0));		// B, nine days later, same deadline

	check('both devices hold the chat as trashed',
		A.trash.has(CHAT) && B.trash.has(CHAT));
	check('and their records are byte-identical BEFORE any parcel is exchanged',
		bytes(A) === bytes(B), `\n         A: ${bytes(A)}\n         B: ${bytes(B)}`);

	// The merge is then a no-op in both directions, which is what stops the two
	// devices telling each other about the same trashing for ever.
	const aMoved = send(B, A), bMoved = send(A, B);
	check('adopting the other device\'s parcel moves neither of them',
		aMoved === false && bMoved === false, `A moved:${aMoved} B moved:${bMoved}`);
	check('and they are still identical afterwards', bytes(A) === bytes(B));

	// ONE record, not two. The trash is keyed by id, so a duplicate would show
	// as a second entry — which is exactly what a scheme keyed by anything else
	// would have produced.
	check('there is exactly one trash record for the chat',
		Object.keys(A.trash.raw()).length === 1,
		Object.keys(A.trash.raw()).join(', '));

	// And the destruction date has not drifted: a device that restamped would
	// have pushed it nine days out on whichever side noticed second.
	check('the destruction date is the same on both, and is measured from the deadline',
		A.trash.dueAt(CHAT) === B.trash.dueAt(CHAT)
			&& A.trash.dueAt(CHAT) === due + 30 * DAY,
		`A ${A.trash.dueAt(CHAT)} B ${B.trash.dueAt(CHAT)} want ${due + 30 * DAY}`);
}

// ── 3b. The clock does not keep rewriting a record it has already written ──
//
// The sweep runs hourly for the life of the app, so `expire` is offered the
// same chat again and again after it is already in the trash. Two things must
// not happen, and neither is caught by the convergence checks above, because
// there both offers carried the SAME deadline.
{
	const d = device('A');
	d.policy.set(3, 30);

	// (a) A HUMAN DELETION IS NOT RELABELLED, and its date is not moved.
	// Somebody deletes a chat by hand today that they last touched a fortnight
	// ago. Its computed deadline is therefore a fortnight in the PAST, so an
	// `expire` that did not check would drag `at` backwards — bringing the
	// destruction date forward by a fortnight and telling the panel a clock did
	// what the person did.
	const deletedNow = Date.now();
	d.trash.put(CHAT, 'chat');
	const byHand = d.trash.raw()[CHAT].at;
	check('a chat deleted by hand is stamped now, not at some past deadline',
		Math.abs(byHand - deletedNow) < 5000);
	const staleDue = T0 + d.policy.chatExpireMs();		// a fortnight ago
	const relabelled = d.trash.expire(CHAT, 'chat', staleDue);
	check('the sweep does not relabel a hand-deleted chat as expired',
		relabelled === false && d.trash.isAuto(CHAT) === false);
	check('and it does not drag the destruction date backwards',
		d.trash.raw()[CHAT].at === byHand,
		`at moved from ${byHand} to ${d.trash.raw()[CHAT].at}`);

	// (b) AN ALREADY-EXPIRED CHAT IS NOT PUSHED OUT. A parcel can carry a
	// fresher `updatedAt` for a chat that is already in the trash — the other
	// device worked on it before it heard about the trashing — which makes the
	// computed deadline LATER than the stamp on the record. Rewriting it would
	// restart the retention clock, and the hourly sweep would restart it again
	// every time the chat was touched anywhere. Nothing would ever be destroyed.
	const e = device('B');
	e.policy.set(3, 30);
	const due = T0 + e.policy.chatExpireMs();
	e.trash.expire(CHAT, 'chat', due);
	const settled = e.trash.dueAt(CHAT);
	const later = due + 10 * DAY;
	const pushed = e.trash.expire(CHAT, 'chat', later);
	check('a later deadline does not move a chat already in the trash',
		pushed === false, 'the record was rewritten');
	check('so the retention clock does not restart',
		e.trash.dueAt(CHAT) === settled,
		`destruction date moved by ${(e.trash.dueAt(CHAT) - settled) / DAY} days`);
}

// ── 4. An automatic act never outranks a human one ───────────────────
//
// The case that loses work if it is got wrong. The chat expires on both
// devices; the user restores it on A; B has been switched off throughout and
// comes back holding a deadline that passed a fortnight ago.
{
	const A = device('A'), B = device('B');
	A.policy.set(3, 30); B.policy.set(3, 30);
	const due = dueOf(A, T0);

	A.trash.expire(CHAT, 'chat', due);
	B.trash.expire(CHAT, 'chat', due);
	A.trash.back(CHAT);								// the user presses Restore on A
	check('the restore takes it out of the trash on A', A.trash.has(CHAT) === false);

	// B boots, sees its own stale deadline, and tries again. It must decline.
	const buried = B.trash.expire(CHAT, 'chat', due);
	check('B re-expiring on its stale record changes nothing on B',
		buried === false || B.trash.raw()[CHAT].at === due);

	send(A, B);
	check('once the parcel arrives, B agrees the chat is restored',
		B.trash.has(CHAT) === false);

	// And now the sharp end: B tries once more, with the restore in hand.
	const again = B.trash.expire(CHAT, 'chat', due);
	check('an expiry whose deadline predates the restore is REFUSED',
		again === false, 'the automatic act overruled the person');
	check('so the chat is still out of the trash on B', B.trash.has(CHAT) === false);
	send(B, A);
	check('and B cannot push the trashing back onto A either',
		A.trash.has(CHAT) === false);

	// The way back in is a NEW deadline, which is what a restore earns by
	// stamping the chat: the window starts again from the restore.
	const restoredAt = A.trash.raw()[CHAT].back;
	const nextDue = restoredAt + A.policy.chatExpireMs();
	check('a deadline EARNED after the restore is accepted',
		A.trash.expire(CHAT, 'chat', nextDue) === true);
	check('so a restored chat rejoins the cycle rather than becoming immortal',
		A.trash.has(CHAT) === true);
}

// ── 5. A lowered retention does not reach back ───────────────────────
{
	const d = device('A');
	d.policy.set(3, 90);							// a generous operator
	const due = dueOf(d, T0);
	d.trash.expire(CHAT, 'chat', due);
	const promised = d.trash.dueAt(CHAT);
	check('the panel is promised ninety days', promised === due + 90 * DAY,
		`${(promised - due) / DAY} days`);

	d.policy.set(3, 7);								// the operator changes their mind
	check('lowering the knob does not move a date already promised',
		d.trash.dueAt(CHAT) === promised,
		`was ${(promised - due) / DAY}d, now ${(d.trash.dueAt(CHAT) - due) / DAY}d`);
	check('and the new figure does govern the NEXT thing trashed',
		d.policy.trashRetainMs() === 7 * DAY);

	// The sweep has to agree with the tile. A sweep reading the live policy
	// would destroy this on day seven, eighty-three days before the date its
	// owner was shown.
	const early = due + 8 * DAY;
	const realNow = Date.now;
	Date.now = () => early;
	try {
		const dueNow = d.trash.sweep().map((x) => x.id);
		check('and the sweep does not destroy it eighty-three days early',
			dueNow.indexOf(CHAT) === -1, `swept: ${dueNow.join(', ') || 'nothing'}`);
	} finally { Date.now = realNow; }
}

// ── 6. The tombstone term outlives a stale peer ──────────────────────
{
	const d = device('A');
	d.policy.set(3, 30);
	check('the tombstone term is longer than the retention it must outlive',
		d.policy.tombTtlMs() > d.policy.trashRetainMs(),
		`tomb ${d.policy.tombTtlMs() / DAY}d vs retain ${d.policy.trashRetainMs() / DAY}d`);
	// The concrete failure it exists to stop: destroy by hand on day one, be
	// away for the peer's whole retention, and the tombstone must still be in
	// the parcel when the peer returns.
	const peerStillHoldingUntil = 30 * DAY;
	check('a tombstone laid the day after a trashing survives until the peer\'s own verdict',
		d.policy.tombTtlMs() >= peerStillHoldingUntil,
		`${d.policy.tombTtlMs() / DAY}d`);

	// And a peer working to a LONGER retention than this device has ever been
	// set to teaches it, because the term rides on the record.
	const far = device('far');
	far.policy.set(3, 365);
	far.trash.put(CHAT, 'chat');
	const before = d.policy.tombTtlMs();
	send(far, d);
	check('adopting a peer\'s record raises this device\'s tombstone term to cover it',
		d.policy.tombTtlMs() >= 365 * DAY,
		`was ${before / DAY}d, now ${d.policy.tombTtlMs() / DAY}d`);
	check('and it does not fall again when the operator lowers the figure here',
		(d.policy.set(3, 5), d.policy.tombTtlMs() >= 365 * DAY),
		`${d.policy.tombTtlMs() / DAY}d`);
}

// ── Report ───────────────────────────────────────────────────────────
console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) {
	console.log('failed: ' + bad.join('; '));
	if (BREAK) console.log(`\n(expected: --break ${BREAK} is meant to fail)`);
	process.exit(1);
}
if (BREAK) {
	console.log(`\nBREAK '${BREAK}' PASSED EVERYTHING — the checks above do not `
		+ 'actually test what they claim to.');
	process.exit(1);
}
process.exit(0);

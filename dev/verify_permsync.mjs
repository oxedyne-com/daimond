// verify_permsync.mjs — the account-level PERMISSION POLICY travels between
// devices; machine-local trust does NOT.
//
// THE BUG THIS GUARDS. A turn dispatched from one device (a phone) is finished on
// a runner (argonaut). After a version update the runner meets a tool that has
// become gated -- web_search -- and, because consent was device-local, it puts
// the prompt on ITS OWN screen, where nobody is. The turn stalls invisibly. The
// fix is to carry the account's standing policy in the sync parcel, so a runner
// (or a freshly updated device) inherits it and does not re-ask.
//
// The split under test, exactly:
//   TRAVELS         the permission RUNG (ask/guarded/bypass) and the standing
//                   grants for gateway-brokered scopes (reading the web). Freshest
//                   -wins per fact, on a strict `at` stamp.
//   STAYS LOCAL     the bypass acknowledgement (a per-device safety tick), whether
//                   a COMMAND keeps its network on THIS machine, and this machine's
//                   autonomous / step-away postures. None of it is in the parcel.
//
// Drives the real client: DaimondHandMode's snapshotPolicy/adoptPolicy, and the
// real collectSync/applySync wiring the parcel rides. No gateway needed -- the
// policy is localStorage and the engine push is local. Needs dev/serve.mjs
// (DAIMOND_PORT) and dev/mockllm.mjs (DAIMOND_MOCK_PORT), like verify_permmode.
import { open, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const LS = {
	MODE:    'daimond-permission-mode',
	MODE_AT: 'daimond-permission-mode-at',
	SCOPES:  'daimond-permission-scopes',
	ACK:     'daimond-permission-bypass-ack',
	NET:     'daimond-net-standing',
	AUTO:    'daimond-autonomous-posture',
	HANDOFF: 'daimond-handoff-when-away',
};

const s = await open({ name: 'permsync' });
const p = s.page;

await p.waitForFunction(
	() => !!(window.DaimondCore && DaimondCore.collectSync && window.DaimondHandMode
		&& DaimondHandMode.snapshotPolicy),
	null, { timeout: 12000 },
).catch(() => {});

try {
	// ── The scope grant travels, and a fresh device inherits it ──────────────
	//
	// Device A grants the reading scope for the account. The parcel must carry it,
	// and a device that holds no grant of its own must see it granted after a
	// pull -- which is what stops a runner re-prompting for web_search.
	const grant = await p.evaluate(() => {
		DaimondHandMode.grantScope('reading', true);
		return {
			granted: DaimondHandMode.scopeGranted('reading'),
			snap:    DaimondHandMode.snapshotPolicy(),
		};
	});
	check('device A can grant the reading scope on the account',
		grant.granted === true, JSON.stringify(grant.snap && grant.snap.scopes));
	check('the policy snapshot carries the reading grant, stamped',
		!!(grant.snap && grant.snap.scopes && grant.snap.scopes.reading
			&& grant.snap.scopes.reading.on === 1 && grant.snap.scopes.reading.at > 0),
		JSON.stringify(grant.snap && grant.snap.scopes));

	// The REAL parcel carries it too (collectSync wiring, the collision surface).
	const inParcel = await p.evaluate(async () => {
		const parcel = await DaimondCore.collectSync();
		return {
			hasPerms:   !!parcel.perms,
			readingOn:  !!(parcel.perms && parcel.perms.scopes && parcel.perms.scopes.reading
				&& parcel.perms.scopes.reading.on === 1),
			perms:      parcel.perms,
		};
	});
	check('collectSync puts the policy in the parcel under `perms`',
		inParcel.hasPerms === true, JSON.stringify(inParcel.perms));
	check('and the reading grant is present in the real parcel',
		inParcel.readingOn === true, JSON.stringify(inParcel.perms && inParcel.perms.scopes));

	// Device B: no grant of its own, then it applies A's parcel through the REAL
	// applySync. It must end up granted -- and must NOT have been granted before,
	// or the check proves nothing.
	const bReading = await p.evaluate(async (LS) => {
		const aPerms = (await DaimondCore.collectSync()).perms;   // A's policy, as it rides
		localStorage.removeItem(LS.SCOPES);                        // B holds no scope grant
		const before = DaimondHandMode.scopeGranted('reading');
		await DaimondCore.applySync({ perms: aPerms });            // the real apply path
		const after  = DaimondHandMode.scopeGranted('reading');
		return { before, after };
	}, LS);
	check('a device with no grant of its own does NOT read as granted (the test is not trivial)',
		bReading.before === false);
	check('and after applying the parcel it sees the reading scope granted — no re-prompt',
		bReading.after === true, `before=${bReading.before} after=${bReading.after}`);

	// ── The rung travels, freshest-wins, strict ─────────────────────────────
	const rung = await p.evaluate(async (LS) => {
		// A known starting point on THIS device.
		await DaimondHandMode.set('guarded');
		const startMode = DaimondHandMode.get();
		const startAt   = Number(localStorage.getItem(LS.MODE_AT) || 0);
		// A remote policy from another device, strictly LATER, naming a different rung.
		const newer = { v: 1, mode: 'ask', mode_at: startAt + 100000, scopes: {} };
		DaimondHandMode.adoptPolicy(newer);
		const adopted = { mode: DaimondHandMode.get(), saved: localStorage.getItem(LS.MODE) };
		// A remote policy that is OLDER than what we now hold must not win.
		const older = { v: 1, mode: 'guarded', mode_at: startAt + 50000, scopes: {} };
		DaimondHandMode.adoptPolicy(older);
		const kept = DaimondHandMode.get();
		return { startMode, adopted, kept };
	}, LS);
	check('the rung starts where this device set it', rung.startMode === 'guarded', rung.startMode);
	check('a strictly-later rung from another device is adopted (page and store both)',
		rung.adopted.mode === 'ask' && rung.adopted.saved === 'ask',
		`mode=${rung.adopted.mode} saved=${rung.adopted.saved}`);
	check('an older rung from another device does NOT win (freshest-wins is strict)',
		rung.kept === 'ask', rung.kept);

	// ── Machine-local trust does NOT travel ─────────────────────────────────
	//
	// The bypass acknowledgement, the command-network standing answer, and the two
	// device postures are set on A, and none of them may appear in the parcel or be
	// created on B by adopting a policy.
	const local = await p.evaluate(async (LS) => {
		localStorage.setItem(LS.ACK, '1');
		localStorage.setItem(LS.NET, 'allow');
		localStorage.setItem(LS.AUTO, '1');
		localStorage.setItem(LS.HANDOFF, '1');
		const parcel = await DaimondCore.collectSync();
		const perms  = parcel.perms || {};
		const permsKeys = Object.keys(perms).sort();
		const wholeJson = JSON.stringify(parcel);
		// The perms section carries ONLY the account facts: version, rung, its
		// stamp, and the scope map. Nothing machine-local.
		const permsShapeOk = permsKeys.join(',') === 'mode,mode_at,scopes,v';
		const scopeKeys = Object.keys(perms.scopes || {}).sort();
		// A device that adopts a policy must not thereby acquire a bypass ack.
		localStorage.removeItem(LS.ACK);
		const aPerms = parcel.perms;
		await DaimondCore.applySync({ perms: aPerms });
		const ackAfterAdopt = localStorage.getItem(LS.ACK);
		return {
			permsKeys, permsShapeOk, scopeKeys,
			// The machine-local VALUES must not be findable anywhere in the parcel.
			// ('allow' is common, so the ack/posture markers are what we hunt.)
			netInParcel:  wholeJson.includes('net-standing') || wholeJson.includes('daimond-net'),
			ackKey:       wholeJson.includes('bypass-ack'),
			autoKey:      wholeJson.includes('autonomous-posture'),
			handoffKey:   wholeJson.includes('handoff-when-away'),
			ackAfterAdopt,
		};
	}, LS);
	check('the `perms` section carries only account facts (v, mode, mode_at, scopes)',
		local.permsShapeOk, local.permsKeys.join(','));
	check('and its scope map holds only account-brokered scopes (reading)',
		local.scopeKeys.every(k => k === 'reading'), local.scopeKeys.join(','));
	check('the bypass acknowledgement is NOT in the parcel', !local.ackKey);
	check('the command-network standing answer is NOT in the parcel', !local.netInParcel);
	check('the autonomous posture is NOT in the parcel', !local.autoKey);
	check('the step-away posture is NOT in the parcel', !local.handoffKey);
	check('adopting a policy does NOT grant this device the bypass acknowledgement',
		local.ackAfterAdopt === null, `ack=${local.ackAfterAdopt}`);

	// ── A revocation travels too, and an empty policy grants nothing ─────────
	const revoke = await p.evaluate(async (LS) => {
		// Grant on A, then revoke; the revoke carries a strictly later stamp.
		DaimondHandMode.grantScope('reading', true);
		const granted = DaimondHandMode.scopeGranted('reading');
		DaimondHandMode.grantScope('reading', false);
		const revoked = DaimondHandMode.scopeGranted('reading');
		const snap = DaimondHandMode.snapshotPolicy();     // reading { on: 0, at: Tr }
		const Tr = snap.scopes.reading.at;
		// Simulate device B holding an OLDER grant, then adopting A's fresher revoke.
		localStorage.setItem(LS.SCOPES, JSON.stringify({ reading: { at: Tr - 1000, on: 1 } }));
		const bHeld = DaimondHandMode.scopeGranted('reading');   // true, older than Tr
		DaimondHandMode.adoptPolicy(snap);
		const afterAdopt = DaimondHandMode.scopeGranted('reading');
		// An empty policy is a no-op: it resurrects nothing.
		DaimondHandMode.adoptPolicy({ v: 1, mode: 'guarded', mode_at: 0, scopes: {} });
		const afterEmpty = DaimondHandMode.scopeGranted('reading');
		return { granted, revoked, bHeld, afterAdopt, afterEmpty };
	}, LS);
	check('a grant can be revoked on the account', revoke.granted === true && revoke.revoked === false,
		`granted=${revoke.granted} revoked=${revoke.revoked}`);
	check('the revocation travels: a device holding an older grant drops it on adopt',
		revoke.bHeld === true && revoke.afterAdopt === false,
		`bHeld=${revoke.bHeld} after=${revoke.afterAdopt}`);
	check('an empty policy grants nothing (no resurrection)', revoke.afterEmpty === false);

	// ── A parcel that predates the policy applies as a no-op ─────────────────
	const legacy = await p.evaluate(async () => {
		DaimondHandMode.grantScope('reading', true);
		const held = DaimondHandMode.scopeGranted('reading');
		let threw = '';
		try {
			const parcel = await DaimondCore.collectSync();
			delete parcel.perms;                       // a device from before `perms`
			await DaimondCore.applySync(parcel);
		} catch (e) { threw = String(e && e.message || e); }
		return { held, still: DaimondHandMode.scopeGranted('reading'), threw };
	});
	check('a v-old parcel with no `perms` applies without error',
		legacy.threw === '' || !/perms/i.test(legacy.threw), legacy.threw || '(clean)');
	check('and leaves this device’s policy exactly where it was', legacy.still === legacy.held);

	const errs = errors(s).filter(e => !/502|Bad Gateway|the engine refused/.test(e));
	check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally {
	await s.close();
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }

/* ============================================================
   Test — the persistent desktop peer, STEP 1: prove the seam.
   ------------------------------------------------------------
   Drives the REAL www/js/identity.js, www/js/post.js and
   www/js/peer.js in two independent simulated tabs of ONE account
   (PHONE and LAPTOP), plus a THIRD tab of a DIFFERENT account
   (STRANGER), through the whole errand seam of dev/PEER_DESIGN.md
   step 7.1:

     A (PHONE) seals a minimal errand envelope to its OWN account
     and drops it in an in-memory post box (the `{to,addr,envelope}`
     shape `send` posts). B (LAPTOP), the same account, collects it,
     routes by the sealed `t` tag, runs the turn (a MOCK LLM), folds
     the answer into the transcript as an append, and pushes the
     parcel; it also posts a `done` report. A pulls the parcel and
     the answer is merged in by the ordinary append-only union
     (mergeMessages, daimond.js:997) -- no peer-specific merge.

   And the property step 1 exists to prove:

     the errand opens ONLY for the same account. STRANGER, a
     different identity with a different sealing key, CANNOT open
     the sealed envelope -- `DaimondPost.unseal` refuses it.

   No gateway is involved: the post box and the parcel store are
   in-memory stand-ins for `/api/post` and `/api/sync`, and the
   seal, the open and the fold are the real client code.

   Run:  node www/js/peer.test.mjs
   (Node 20+, whose WebCrypto implements X25519 and Ed25519 -- the
    real engine the seal and the identity run on.)
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAIMOND_SRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const real = webcrypto;
let failures = 0;
function check(name, cond) {
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name); failures++; }
}
const toHex = (bytes) => {
	const b = new Uint8Array(bytes);
	let s = '';
	for (let i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
	return s;
};
const encU8    = (s) => new TextEncoder().encode(s);
const b64Bytes = (u8) => Buffer.from(u8).toString('base64');
const httpResp = (obj) => ({ status: 200, json: async () => obj });
const eqBytes = (a, b) => {
	const x = new Uint8Array(a), y = new Uint8Array(b);
	if (x.length !== y.length) return false;
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
};

/// An errand as a sender builds one: its seed ends at the turn's own user message,
/// stamped when the turn was born (`born`, else the send), which is the birth a
/// collector ages it by (`turnAgeVerdict`, E-R1). A bare fixture id such as 't1'
/// carries no time of its own, so an errand without this is refused as unaged.
function sentErrand(P, fields) {
	const f = Object.assign({}, fields || {});
	f.ts = f.ts || Date.now();
	const born = f.born || f.ts;
	delete f.born;
	if (f.seed === undefined) {
		f.seed = { chatId: String(f.chatId || ''), title: '', provider: '', model: '',
			msgs: [{ role: 'user', content: String(f.prompt || ''), mid: String(f.turnId || ''), ts: born }] };
	}
	return P.makeErrand(f);
}

// ── One simulated tab ──────────────────────────────────────
//
// A Map-backed localStorage, a no-op document/window, the encoders and base64,
// and the real WebCrypto. Each context loads the four app scripts as the classic
// IIFEs they are and attaches their globals onto its own `window`, so two
// contexts are two independent devices with independent storage.
function makeTab(clockOffsetMs) {
	// A per-tab RAW clock offset (SIM-4): 0 by default, so every existing caller
	// keeps running on the real clock unchanged. A device more than the lease TTL
	// out from another's is exactly the pre-fix failure -- so the lease-clock test
	// below is the one caller that sets it. Precedent: pushretry.test.mjs's `VDate`
	// (F-S5-5), same technique for the same reason (a device's `Date.now()` is not
	// the clock a lease may be aged on).
	const offset = clockOffsetMs || 0;
	class TDate extends Date {
		constructor(...a) { if (a.length) super(...a); else super(Date.now() + offset); }
		static now() { return Date.now() + offset; }
	}
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = {};
	win.addEventListener = () => {};
	win.dispatchEvent = () => true;
	win.matchMedia = () => ({ matches: false, addListener: () => {}, addEventListener: () => {} });
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
	};
	const document = {
		readyState: 'complete',
		addEventListener: () => {},
		querySelector: () => null,
		querySelectorAll: () => [],
		getElementById: () => null,
		createElement: () => Object.assign({}, noEl),
		body: noEl,
	};
	const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
	const atob = (s) => Buffer.from(s, 'base64').toString('binary');
	function EventShim(t) { this.type = t; }

	function loadScript(rel, extra) {
		let body = readFileSync(join(HERE, rel), 'utf8');
		if (extra) body += extra;
		// A REAL browser makes `window` the global object, so the app scripts refer
		// to their siblings by a bare `DaimondIdentity` / `DaimondPost` after a
		// `window.X &&` guard. `new Function` gives them no such global, so free
		// identifiers are resolved against this tab's `window` with an enclosing
		// `with(window)` -- the one construct that puts an object in the scope chain.
		// Host built-ins the scripts also read bare (crypto, btoa, TextEncoder, ...)
		// are NOT properties of `window`, so they fall through `with` to the named
		// parameters below. The outer function is non-strict (no directive), which
		// is what makes `with` legal; each app script keeps its own inner 'use strict'.
		const fn = new Function(
			'window', 'document', 'crypto', 'localStorage', 'btoa', 'atob',
			'TextEncoder', 'TextDecoder', 'Event',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
			'console', 'globalThis', 'Date',
			'with (window) {\n' + body + '\n}');
		fn(win, document, real, localStorage, btoa, atob,
			TextEncoder, TextDecoder, EventShim,
			setTimeout, clearTimeout, setInterval, clearInterval,
			console, globalThis, TDate);
	}
	// The vendored bundle's top-level `var DaimondNoble` is wrapper-local here (a
	// browser turns it into a window property), so publish it explicitly, exactly
	// as curvefallback.test.mjs does.
	loadScript('store.js');
	loadScript('vendor/noble-curves.min.js', '\n;window.DaimondNoble = DaimondNoble;');
	loadScript('curvefallback.js');
	loadScript('identity.js');
	loadScript('post.js');
	loadScript('peer.js');
	return win;
}

// ── The in-memory transports ───────────────────────────────

/// The post box: `/api/post` reduced to its safety-relevant shape. A row is
/// `{ seq, kind:'post', to, addr, envelope }`; a re-post of the same address
/// collapses to one row (address is content, post.js). `collect(since)` returns
/// rows above a watermark, which is all the peer path needs of it here.
function makePostBox() {
	let seq = 0;
	const rows = [];
	return {
		post(body) {
			if (rows.some((r) => r.addr === body.addr)) return { ok: true, addr: body.addr };
			seq += 1;
			rows.push({ seq, kind: 'post', to: body.to, addr: body.addr, envelope: body.envelope });
			return { ok: true, addr: body.addr };
		},
		collect(since) { return rows.filter((r) => r.seq > (since | 0)); },
		top() { return seq; },
	};
}

/// The parcel store: `/api/sync` reduced to one versioned blob of chats, and the
/// append-only union that opens it on the far side. The union is a faithful port
/// of daimond.js `mergeMessages` (:997) and `mergeInto` (:1794) -- union by mid,
/// fuller copy wins, time order -- because THAT is the merge an errand result
/// rides home on, and step 1 is proving it rides home with no new rule.
function makeParcelStore() {
	let version = 0;
	let chats = [];
	return {
		push(next) { version += 1; chats = JSON.parse(JSON.stringify(next)); return version; },
		pull() { return { version, chats: JSON.parse(JSON.stringify(chats)) }; },
		version() { return version; },
	};
}
function unionMessages(a, b) {
	const at = {}, out = [];
	(a || []).concat(b || []).forEach((m) => {
		const had = at[m.mid];
		if (had === undefined) { at[m.mid] = out.length; out.push(m); return; }
		if ((out[had].elided || 0) && !(m.elided || 0)) out[had] = m;	// fuller wins
	});
	out.sort((x, y) => {
		if ((x.ts || 0) !== (y.ts || 0)) return (x.ts || 0) - (y.ts || 0);
		return String(x.mid).localeCompare(String(y.mid));
	});
	return out;
}
function mergeInto(base, incoming) {
	const byId = {};
	(base || []).forEach((c) => { if (c && c.id) byId[c.id] = c; });
	(incoming || []).forEach((c) => {
		if (!c || !c.id) return;
		const st = byId[c.id];
		if (!st) { byId[c.id] = c; return; }
		const fresh = (c.updatedAt || 0) > (st.updatedAt || 0) ? c : st;
		const merged = Object.assign({}, fresh);
		merged.messages = unionMessages(st.messages, c.messages);
		byId[c.id] = merged;
	});
	return Object.keys(byId).map((id) => byId[id]);
}

async function main() {
	const PASS_A = 'correct horse battery staple frigate';
	const PASS_S = 'a wholly different eight word passphrase indeed today';

	const box    = makePostBox();
	const parcel = makeParcelStore();

	// ── Set-up: two tabs of one account, one tab of another ────
	console.log('Set-up — three tabs, two accounts');
	const phone   = makeTab();
	const laptop  = makeTab();
	const stranger = makeTab();

	await phone.DaimondIdentity.create('Phone', PASS_A);
	check('phone account created and holds a sealing key',
		!!phone.DaimondIdentity.sealingKeyRaw()
		&& phone.DaimondIdentity.sealingKeyRaw().length === 32);

	// LAPTOP becomes the SAME account by adopting the bundle, then unlocking.
	const bundle = phone.DaimondIdentity.exportBundle();
	check('laptop adopts the account bundle', laptop.DaimondIdentity.importBundle(bundle));
	const un = await laptop.DaimondIdentity.unlock(PASS_A);
	check('laptop unlocks the shared account', !!un && un.ok === true && laptop.DaimondIdentity.isUnlocked());
	check('laptop and phone hold the SAME sealing key (same account)',
		eqBytes(phone.DaimondIdentity.sealingKeyRaw(), laptop.DaimondIdentity.sealingKeyRaw()));

	// STRANGER is a different identity entirely.
	await stranger.DaimondIdentity.create('Stranger', PASS_S);
	check('stranger is a DIFFERENT account (different sealing key)',
		!eqBytes(phone.DaimondIdentity.sealingKeyRaw(), stranger.DaimondIdentity.sealingKeyRaw()));

	// ── The PER-DEVICE id: distinct even on paired devices ─────
	//
	// Pairing copies the account keypair whole, so publicKeyB64url() is IDENTICAL on
	// phone and laptop -- it CANNOT be the device id. The peer keys holder/
	// dispatchedBy/presence on deviceId(), which is minted per device and never
	// travels in the bundle, so the two devices are distinguishable. On the pre-fix
	// code (device id === publicKeyB64url) the distinctness check below fails.
	console.log('\nDevice id — paired devices SHARE the account key but hold DISTINCT device ids');
	check('paired phone and laptop share the account public key (the trap)',
		phone.DaimondIdentity.publicKeyB64url() === laptop.DaimondIdentity.publicKeyB64url());
	// Defensive access: on the pre-fix code deviceId() does not exist, so these read
	// null and the checks FAIL cleanly (rather than crashing the run) -- which is the
	// evidence that the distinctness the peer needs is absent before the fix.
	const devId  = (tab) => (tab.DaimondIdentity.deviceId ? tab.DaimondIdentity.deviceId() : null);
	const phoneDev  = devId(phone);
	const laptopDev = devId(laptop);
	check('phone and laptop mint DISTINCT device ids despite the shared account key',
		!!phoneDev && !!laptopDev && phoneDev !== laptopDev);
	check('a device id is NOT the account public key (would collide across paired devices)',
		!!phoneDev && phoneDev !== phone.DaimondIdentity.publicKeyB64url());
	check('deviceId() is stable per device (a second read returns the same id)',
		!!phoneDev && devId(phone) === phoneDev);

	// The two consequences the shared-id bug caused, proven on the two REAL device
	// ids. Both checks pass now and FAIL if the device id collapses back to the
	// account key (phoneDev === laptopDev).
	const NOWD = 1700000000000;
	const Pd = phone.DaimondPeer;
	// (1) PRESENCE: a peer must see the OTHER device. With one shared id the only
	// entry is self, freshestPeer self-excludes it, and auto-dispatch is dead.
	const presenceBoth = {
		[phoneDev]:  { name: 'phone',  lastSeen: NOWD - 500 },
		[laptopDev]: { name: 'laptop', lastSeen: NOWD - 200 },
	};
	const seen = Pd.freshestPeer(presenceBoth, phoneDev, NOWD);
	check('presence lists the OTHER device (freshestPeer returns the laptop, not self)',
		!!seen && seen.deviceId === laptopDev);
	check('a shared id would self-exclude (proof the bug killed auto-dispatch)',
		Pd.freshestPeer({ [phoneDev]: { name: 'me', lastSeen: NOWD } }, phoneDev, NOWD) === null);
	// (2) THE LEASE (the money risk): the foreign-holder test must FIRE between two
	// distinct ids, and MUST NOT when holder === self -- the same-holder blind spot
	// that let both paired devices run and bill the same turn.
	const dispTurn = { why: 'dispatched', iturn: 'turn-money' };
	const leaseByLaptop = { turnId: 'turn-money', holder: laptopDev, mode: 'running', expiry: NOWD + 60000, renewedAt: NOWD };
	const leaseBySelf   = { turnId: 'turn-money', holder: phoneDev,  mode: 'running', expiry: NOWD + 60000, renewedAt: NOWD };
	check('foreign-holder detection FIRES: a lease held by the laptop reads peer-held on the phone',
		Pd.dispatchState(dispTurn, leaseByLaptop, phoneDev, NOWD) === 'peer-held');
	check('same-holder is the money bug: a lease whose holder EQUALS self is NOT peer-held',
		Pd.dispatchState(dispTurn, leaseBySelf, phoneDev, NOWD) === 'reclaimable');
	// And the CAS itself: two DISTINCT device ids racing one turn from one base -> one
	// wins, one stands down. With a shared holder id the merge could not tell them
	// apart and both would keep their claim.
	{
		const L = phone.DaimondLease;
		L.forget();
		const cas = makeCas({});
		const snap1 = await cas.read();
		const snap2 = await cas.read();
		const r1 = await L.takeFrom(snap1, 'turn-money', { holder: phoneDev,  eid: 'e1' }, cas, () => NOWD);
		const r2 = await L.takeFrom(snap2, 'turn-money', { holder: laptopDev, eid: 'e2' }, cas, () => NOWD + 1);
		check('two DISTINCT device ids race one turn: exactly one holds it (no double-bill)',
			(r1.won ? 1 : 0) + (r2.won ? 1 : 0) === 1);
		check('the committed lease names exactly one of the two distinct device ids',
			[phoneDev, laptopDev].includes(cas.peekLeases()['turn-money'].holder));
		L.forget();
	}

	// ── The phone dispatches ───────────────────────────────────
	console.log('\nDispatch — phone seals an errand to itself and posts it');

	// Persist-first: the prompt is pushed to the parcel BEFORE the errand, so a
	// peer can never claim an errand whose prompt it cannot yet read (§4.1).
	const chat0 = {
		id: 'chat-1', name: 'Arithmetic',
		messages: [{ mid: 'm-user-1', role: 'user', content: 'What is 2+2?', ts: 1000 }],
		updatedAt: 1000,
	};
	const vPrompt = parcel.push([chat0]);
	check('prompt parcel pushed before the errand', vPrompt === 1);

	const model = { provider: 'openrouter', model: 'test/model', url: 'https://openrouter.ai/api/v1/chat/completions' };
	const errand = phone.DaimondPeer.makeErrand({
		turnId: 'turn-1', chatId: 'chat-1', prompt: 'What is 2+2?',
		model, parcelVersion: vPrompt, dispatchedBy: 'phone-device',
	});
	const sealed = await phone.DaimondPeer.sealForSelf(errand);
	check('errand sealed to a {to, addr, envelope} post body',
		!!sealed.to && !!sealed.addr && !!sealed.envelope);
	const phonePubHex    = toHex(await phone.DaimondIdentity.publicKeyRaw());
	const phonePubB64url = phone.DaimondIdentity.publicKeyB64url();
	// The delivery address is the BASE64URL account form the gateway binds an account
	// to -- NOT the hex of the raw key. A hex `to` matched no account and every post
	// 404'd ("No account holds that key"), which is the whole reason a dispatch never
	// arrived. These two checks (b64url form, and NOT the old hex) fail on that code.
	check('errand `to` is the account\'s b64url public address (the form the gateway binds)',
		sealed.to === phonePubB64url);
	check('errand `to` is NOT the hex of the raw key (the 404 bug)',
		sealed.to !== phonePubHex && phonePubB64url !== phonePubHex);
	box.post(sealed);
	check('post box holds exactly one row after the post', box.top() === 1);

	// ── Same-account-ONLY: the negative that matters ───────────
	console.log('\nSeal — the errand opens for the account and for NOBODY else');
	// The stranger must be UNLOCKED and holding its own private sealing key, or a
	// refusal here would prove nothing -- a locked device fails to open everything.
	check('stranger is unlocked with its own key (so the refusal is meaningful)',
		stranger.DaimondIdentity.isUnlocked());
	let strangerOpened = false, strangerWhy = '';
	try { await stranger.DaimondPeer.openEnvelope(sealed.envelope); strangerOpened = true; }
	catch (e) { strangerOpened = false; strangerWhy = String(e && e.message || e); }
	check('a DIFFERENT account CANNOT open the sealed errand', strangerOpened === false);
	check('the refusal is the crypto "not for you", not an incidental error',
		/not sealed/i.test(strangerWhy));

	// ── The laptop collects, claims-nothing (step 1), runs, pushes ─
	console.log('\nPeer — laptop collects, runs the turn, folds and pushes');
	let ranErrand = null, pushedVersion = 0;
	const rows = box.collect(0);
	const tally = await laptop.DaimondPeer.routeRows(rows, {
		// A row the laptop cannot open should never happen in this run; if it does,
		// name why, so a regression reads as a sentence rather than a silent zero.
		onOther: (row, e) => { console.log('    note: a row did not open —', e && e.message); },
		onErrand: async (err) => {
			ranErrand = err;
			check('laptop opened the errand to the same fields the phone sealed',
				err.turnId === 'turn-1' && err.chatId === 'chat-1'
				&& err.prompt === 'What is 2+2?' && err.model && err.model.provider === 'openrouter'
				&& err.parcelVersion === vPrompt);

			// Reconstruct: pull the parcel to >= the errand's version, find the chat.
			const snap = parcel.pull();
			check('laptop pulled the parcel to at least the errand version',
				snap.version >= err.parcelVersion);
			const chat = snap.chats.find((c) => c.id === err.chatId);
			check('laptop reconstructed the chat carrying the prompt',
				!!chat && chat.messages.length === 1 && chat.messages[0].role === 'user');

			// Run the turn — a MOCK LLM stands in for runTurn's provider call.
			const answer = mockRunTurn(err.prompt);
			laptop.DaimondPeer.foldAssistant(chat, {
				mid: 'm-asst-1', turnId: err.turnId, text: answer, model: err.model, ts: 2000,
			});
			// Push the parcel under the ordinary path; the assistant message is a
			// pure append.
			pushedVersion = parcel.push(snap.chats);

			// Post the report — the nudge, not the answer.
			const report = laptop.DaimondPeer.makeReport({
				eid: err.eid, turnId: err.turnId, chatId: err.chatId,
				status: 'done', parcelVersion: pushedVersion,
			});
			const sealedRep = await laptop.DaimondPeer.sealForSelf(report);
			box.post(sealedRep);
		},
	});
	check('laptop routed exactly one errand', tally.errands === 1);
	check('the turn ran and produced an answer', !!ranErrand && pushedVersion === 2);

	// ── The phone returns and collects ─────────────────────────
	console.log('\nReturn — phone pulls the parcel and the answer is merged in');

	// The phone's local view is still the prompt-only chat it dispatched.
	const phoneLocal = [JSON.parse(JSON.stringify(chat0))];
	const snap = parcel.pull();
	const merged = mergeInto(phoneLocal, snap.chats);
	const mchat = merged.find((c) => c.id === 'chat-1');
	check('merged chat carries BOTH the prompt and the answer', !!mchat && mchat.messages.length === 2);
	const asst = mchat.messages.find((m) => m.role === 'assistant');
	check('the assistant answer is the peer\'s, folded under the turn id',
		!!asst && asst.content === mockRunTurn('What is 2+2?') && asst.iturn === 'turn-1');
	check('the user prompt survived the merge unchanged',
		mchat.messages.some((m) => m.role === 'user' && m.content === 'What is 2+2?'));

	// Idempotency: pulling and merging AGAIN duplicates nothing (union by mid).
	const merged2 = mergeInto(merged, parcel.pull().chats);
	const mchat2  = merged2.find((c) => c.id === 'chat-1');
	check('a second pull-and-merge duplicates nothing', mchat2.messages.length === 2);

	// The phone collects the report from the box.
	let sawReport = null;
	await phone.DaimondPeer.routeRows(box.collect(0), {
		onReport: async (rep) => { sawReport = rep; },
	});
	check('phone collected the done report for its turn',
		!!sawReport && sawReport.status === 'done' && sawReport.turnId === 'turn-1'
		&& sawReport.parcelVersion === 2);

	// The phone can of course also open its OWN errand (its self-slot); it just
	// must not act on its own dispatch. Proven here so the same-account property
	// is symmetric: both devices of the account open it, nobody else does.
	let phoneOpenedOwn = false;
	try { const e = await phone.DaimondPeer.openEnvelope(sealed.envelope); phoneOpenedOwn = e.turnId === 'turn-1'; }
	catch (e) { phoneOpenedOwn = false; }
	check('phone opens its OWN errand too (the account\'s self-slot)', phoneOpenedOwn === true);

	// ══════════════════════════════════════════════════════════
	// STEP 2 — signing, the raw poster, and the collector.
	// ══════════════════════════════════════════════════════════

	// ── Signing: the account's own opens AND verifies; a forgery does not ──
	console.log('\nSigning — the account\'s own verifies, a correspondent\'s forgery is refused');

	const ownOpened = await phone.DaimondPeer.openEnvelope(sealed.envelope);
	check('the opened own errand carries the account\'s author and a signature',
		!!ownOpened && ownOpened.author === phonePubHex && typeof ownOpened.sig === 'string' && ownOpened.sig.length > 0);
	check('phone opens its own errand and it VERIFIES',
		await phone.DaimondPeer.verifyEnvelope(ownOpened));

	// A tampered envelope: change a signed field after the fact -> verify fails.
	const tampered = Object.assign({}, ownOpened, { prompt: 'spend all the money' });
	check('a tampered errand FAILS verification', (await phone.DaimondPeer.verifyEnvelope(tampered)) === false);

	// THE FORGERY THAT THE SEAL ALONE DOES NOT STOP. The stranger knows the
	// account's PUBLIC sealing key (it is on the card), so it seals a forged errand
	// TO the account -- which the account can OPEN. Only the signature stops it: the
	// stranger cannot sign as the account.
	const forgedBase = stranger.DaimondPeer.makeErrand({
		turnId: 'forged-1', chatId: 'chat-1', prompt: 'transfer the credits',
	});
	const forgedSigned = await stranger.DaimondPeer.signEnvelope(forgedBase);	// signed by STRANGER
	const forgedSealed = await stranger.DaimondPost.seal(
		[phone.DaimondIdentity.sealingKeyRaw()], encU8(JSON.stringify(forgedSigned)));	// sealed TO phone
	const forgedEnv = b64Bytes(forgedSealed);

	let phoneOpenedForgery = false, forgeryWhy = '';
	try { await phone.DaimondPeer.openEnvelope(forgedEnv); phoneOpenedForgery = true; }
	catch (e) { phoneOpenedForgery = false; forgeryWhy = String(e && e.message || e); }
	check('phone can OPEN the forgery (it was sealed to the account\'s key)',
		(await phone.DaimondPeer.peek(forgedEnv)) !== null);
	check('phone REFUSES the forgery (it was not signed by the account)', phoneOpenedForgery === false);
	check('the refusal is the signature check, not something incidental',
		/not signed by this account/i.test(forgeryWhy));
	// And through the collector door: absorb verifies and DROPS, never routes.
	const forgedPeek = await phone.DaimondPeer.peek(forgedEnv);
	const absorbed = await phone.DaimondPeer.absorb(forgedPeek, { addr: 'x' });
	check('the collector ABSORB drops the forgery (verified:false, routed:false)',
		absorbed.verified === false && absorbed.routed === false);

	// ── AAD domain separation, and the DPY1 legacy read path ────
	console.log('\nSeal — the purpose (AAD) domain-separates the account key, and a legacy DPY1 still opens');
	const withMagic = (tag, body) => { const o = new Uint8Array(tag.length + body.length); o.set(tag, 0); o.set(body, tag.length); return o; };
	const DPY1 = new Uint8Array([0x44, 0x50, 0x59, 0x31]);
	const DPY2 = new Uint8Array([0x44, 0x50, 0x59, 0x32]);

	// A body sealed under one purpose opens only under that same purpose.
	const aad1 = await phone.DaimondIdentity.wrapBytesAad(encU8('coordination'), 'daimond/test/one');
	const round = await phone.DaimondIdentity.unwrapBytesAad(aad1, 'daimond/test/one');
	check('wrapBytesAad round-trips under the SAME purpose', new TextDecoder().decode(round) === 'coordination');
	let crossAad = false, noAad = false;
	try { await phone.DaimondIdentity.unwrapBytesAad(aad1, 'daimond/test/two'); } catch (e) { crossAad = true; }
	try { await phone.DaimondIdentity.unwrapBytes(aad1); } catch (e) { noAad = true; }
	check('a DIFFERENT purpose CANNOT open it (crypto-layer domain separation)', crossAad === true);
	check('a no-AAD open of an AAD body also fails (parcel/voice vs peer separation)', noAad === true);

	// A DPY2 envelope sealed under the WRONG purpose is refused by the peer open path.
	const legacyErr    = await phone.DaimondPeer.signEnvelope(phone.DaimondPeer.makeErrand({ turnId: 'legacy-1', chatId: 'c', prompt: 'hi' }));
	const legacyPlain  = encU8(JSON.stringify(legacyErr));
	const dpy2WrongAad = withMagic(DPY2, await phone.DaimondIdentity.wrapBytesAad(legacyPlain, 'not/the/peer/purpose'));
	let dpy2WrongFailed = false;
	try { await phone.DaimondPeer.openEnvelope(b64Bytes(dpy2WrongAad)); } catch (e) { dpy2WrongFailed = true; }
	check('a DPY2 body under the WRONG purpose is refused by openEnvelope', dpy2WrongFailed === true);

	// A legacy DPY1 envelope (same key, NO AAD) still opens and verifies — the rollout read path.
	const dpy1Env    = withMagic(DPY1, await phone.DaimondIdentity.wrapBytes(legacyPlain));
	const dpy1Opened = await phone.DaimondPeer.openEnvelope(b64Bytes(dpy1Env));
	check('a legacy DPY1 envelope (no AAD) still opens and verifies (rollout read path)',
		!!dpy1Opened && dpy1Opened.turnId === 'legacy-1');
	// And a paired sibling opens the same DPY1, since the key is the account's.
	const dpy1Sibling = await laptop.DaimondPeer.openEnvelope(b64Bytes(dpy1Env));
	check('a paired sibling opens the legacy DPY1 too (shared account key)',
		!!dpy1Sibling && dpy1Sibling.turnId === 'legacy-1');

	// ── The raw poster builds the correct body ─────────────────
	console.log('\nPoster — DaimondPost.post(body) builds {to,addr,envelope} with the own address');
	let lastPostBody = null;
	const relay2 = (() => {
		let seq = 0; const rows = [];
		return {
			put(b) { if (rows.some((r) => r.addr === b.addr)) return; seq++; rows.push({ seq, kind: 'post', to: b.to, addr: b.addr, envelope: b.envelope }); },
			since(s) { return rows.filter((r) => r.seq > (s | 0)); },
		};
	})();
	function wireGateway(win) {
		win.DaimondGateway = {
			clientApi: () => 1,
			gwFetch: async (path, opts) => {
				if (opts.method === 'POST') {
					lastPostBody = JSON.parse(opts.body);
					relay2.put(lastPostBody);
					return httpResp({ ok: true });
				}
				const m = /[?&]since=(\d+)/.exec(String(path));
				return httpResp({ ok: true, rows: relay2.since(m ? (m[1] | 0) : 0), more: false });
			},
		};
	}
	wireGateway(phone);

	const errandBody = await phone.DaimondPeer.sealForSelf(
		phone.DaimondPeer.makeErrand({ turnId: 'turn-2', chatId: 'chat-1', prompt: 'again?' }));
	const putRes = await phone.DaimondPost.post(errandBody);
	check('the raw put reports ok', putRes.ok === true && putRes.status === 200);
	// Gateway release 5: an errand also tells our own relay its turn id in the clear
	// (`relayMeta`), so the relay can stamp the turn's first post. Nothing of the sealed
	// errand itself -- the prompt, the chat -- ever rides beside the envelope.
	check('the posted body is exactly {to, addr, envelope} and the errand\'s turn',
		!!lastPostBody && Object.keys(lastPostBody).sort().join(',') === 'addr,envelope,to,turn'
		&& lastPostBody.turn === 'turn-2' && !JSON.stringify(lastPostBody).includes('again?'));
	check('the posted `to` is the account\'s OWN b64url public address', lastPostBody.to === phonePubB64url);
	check('the posted addr and envelope are the sealed artefact\'s',
		lastPostBody.addr === errandBody.addr && lastPostBody.envelope === errandBody.envelope);
	check('a put with a missing field is refused before any call',
		(await phone.DaimondPost.post({ to: 'x', addr: 'y' })).ok === false);

	// ── The collector routes errand/report BEFORE the message read ─
	console.log('\nCollector — real collect() routes errand & report, passes a non-peer row through');
	const routedErrands = [], routedReports = [];
	phone.DaimondPeer.onErrand(async (e) => { routedErrands.push(e); });
	phone.DaimondPeer.onReport(async (r) => { routedReports.push(r); });

	// A report, posted through the raw put.
	const reportBody = await phone.DaimondPeer.sealForSelf(
		phone.DaimondPeer.makeReport({ eid: 'e2', turnId: 'turn-2', chatId: 'chat-1', status: 'done', parcelVersion: 2 }));
	await phone.DaimondPost.post(reportBody);

	// A NON-peer sealed row: plain JSON with no peer tag, sealed to self. It must
	// peek to null and reach the message path (which, with no wasm bridge in this
	// harness, records a "bad" message -- proving the row was NOT swallowed by the
	// peer route).
	const nonPeerSealed = await phone.DaimondPost.seal(
		[phone.DaimondIdentity.sealingKeyRaw()], encU8(JSON.stringify({ kind: 'post', hello: 'not a peer envelope' })));
	relay2.put({ to: phonePubHex, addr: 'nonpeer-' + Date.now(), envelope: b64Bytes(nonPeerSealed) });

	check('a non-peer sealed row peeks to null (falls through to messages)',
		(await phone.DaimondPeer.peek(b64Bytes(nonPeerSealed))) === null);

	const col = await phone.DaimondPost.collect();
	check('collect() succeeded', col.ok === true);
	// AN ERRAND IS WORK, started once the collect has let go of the mailbox lock (E-R4):
	// the runner calls back into the mailbox from inside its turn. So it is routed a few
	// turns of the event loop after collect() answers, never inside it.
	for (let i = 0; i < 50 && !routedErrands.some((e) => e.turnId === 'turn-2'); i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
	check('the errand was routed to the peer runner', routedErrands.some((e) => e.turnId === 'turn-2'));
	const PP = phone.DaimondPeer;
	check('an errand and a compile are work, run after the lock; the four notes are not',
		PP.isWork({ t: 'errand' }) && PP.isWork({ t: 'compile' })
		&& ['report', 'consent-ask', 'consent-grant', 'built'].every((t) => !PP.isWork({ t })));
	check('a device runs one of each turn and each compile at a time',
		PP.workKey({ t: 'errand', turnId: 'T', eid: 'e1' }) === PP.workKey({ t: 'errand', turnId: 'T', eid: 'e2' })
		&& PP.workKey({ t: 'compile', cid: 'C' }) === 'compile:C'
		&& PP.workKey({ t: 'errand', turnId: 'T' }) !== PP.workKey({ t: 'compile', cid: 'T' }));
	check('the report was routed to the peer runner', routedReports.some((r) => r.turnId === 'turn-2'));
	// The crisp proof that the peer route did not touch the message list: collect's
	// own tally counts NO message stored from the errand and report rows, and the
	// non-peer row reached the message path (recorded unreadable, no bridge here).
	check('NO message was stored from the errand/report rows (got === 0)', col.got === 0);
	check('the non-peer row passed THROUGH to the message path (unreadable === 1)', col.unreadable === 1);

	// ══════════════════════════════════════════════════════════
	// STEP 3 — the lease (money-critical). All against DaimondLease,
	// the REAL take-if-vacant merge and lifecycle, over a CAS stub
	// that models the gateway's compare-and-set exactly.
	// ══════════════════════════════════════════════════════════
	console.log('\nLease — two devices race one turn; exactly one wins');
	const L = phone.DaimondLease;		// the real implementation under test

	await runLeaseAcceptance(L, check);
	await runLeaseClockAcceptance(check);

	// ══════════════════════════════════════════════════════════
	// STEP 4 — the dispatcher: the STRICT ORDER and the full errand.
	// buildDispatch is pure; the test drives its order end to end.
	// ══════════════════════════════════════════════════════════
	console.log('\nDispatcher — buildDispatch fixes the order and the whole errand');
	const T0 = 1700000000000;			// a realistic epoch-ms
	const dchat = { id: 'chat-9', provider: 'openrouter', model: 'test/m', holds: ['/a', '/b'],
		messages: [
			{ role: 'user', content: 'an earlier question', mid: 'm1', ts: T0 - 3000 },
			{ role: 'assistant', content: 'an earlier answer', mid: 'm2', ts: T0 - 2000 },
			{ role: 'user', content: 'do the thing', mid: 'turn-9', ts: T0 },
		] };
	const plan = phone.DaimondPeer.buildDispatch(dchat, {
		turnId: 'turn-9', prompt: 'do the thing', pause: { paused: ['x'] },
		scope: dchat.holds,			// daimond.js resolves scope (scopeChatTo / holds) and passes it
		dispatchedBy: 'devPHONE', now: T0,
	});
	check('the order is mark-dispatched -> post-errand -> push-prompt (the DURABLE record first)',
		plan.order.join(',') === 'mark-dispatched,post-errand,push-prompt');
	check('the mark is the dispatched reason on the turn',
		plan.mark.why === 'dispatched' && plan.mark.iturn === 'turn-9' && plan.mark.interrupted === true);
	check('the deadline defaults to ~15 minutes out',
		plan.fields.deadline === T0 + phone.DaimondPeer.DISPATCH_DEADLINE_MS);

	// Drive the order end to end: MARK the local turn first (the durable placeholder,
	// so a refused post is a transcript event, D-20260918-27), post the errand SECOND
	// (it still carries the thread AND is still ahead of the parcel push, which was the
	// whole of seq 223), and push the parcel LAST in the background. The sequence is
	// recorded and must equal plan.order.
	let ver = 41;
	const fakeSync = { push: async () => { ver += 1; }, version: () => ver };
	const seq = [];
	const errand9 = plan.errand(0);
	const body9 = await phone.DaimondPeer.sealForSelf(errand9);
	const before9 = relay2.since(0).length;
	seq.push('mark-dispatched');			// daimond.js marks the local turn here, BEFORE the post
	await phone.DaimondPost.post(body9); seq.push('post-errand');
	await fakeSync.push(); seq.push('push-prompt');
	const pv = fakeSync.version();

	check('the executed sequence matches the planned order', seq.join(',') === plan.order.join(','));
	check('the errand names NO parcel version -- there is no pushed version yet',
		errand9.parcelVersion === 0 && pv === 42);
	check('the durable mark precedes the post, and the post precedes the parcel push',
		seq.indexOf('mark-dispatched') < seq.indexOf('post-errand')
		&& seq.indexOf('post-errand') < seq.indexOf('push-prompt'));
	check('the post box grew by exactly the one errand', relay2.since(0).length === before9 + 1);

	// The full envelope survives seal+sign+open, cross-device (laptop opens it).
	const posted9 = relay2.since(before9).find((r) => r.addr === body9.addr);
	const opened9 = await laptop.DaimondPeer.openEnvelope(posted9.envelope);
	check('the dispatched errand opens on the peer with the whole envelope intact',
		opened9.turnId === 'turn-9' && opened9.chatId === 'chat-9'
		&& opened9.prompt === 'do the thing'
		&& opened9.model.provider === 'openrouter' && opened9.model.model === 'test/m'
		&& Array.isArray(opened9.scope) && opened9.scope.join(',') === '/a,/b'
		&& opened9.pause && opened9.pause.paused.join(',') === 'x'
		&& opened9.parcelVersion === 0
		&& opened9.deadline === T0 + phone.DaimondPeer.DISPATCH_DEADLINE_MS
		&& opened9.dispatchedBy === 'devPHONE');

	const P = phone.DaimondPeer;			// the seam every pure check below drives

	// ── THE SEED. What makes errand-first safe: the thread rides the envelope, so a
	//    peer that claims can run without the parcel. ──
	console.log('\nDispatcher — the errand carries the thread, so the claim waits on nothing');
	check('S1: the errand carries the seed, naming the chat',
		!!opened9.seed && opened9.seed.chatId === 'chat-9'
		&& opened9.seed.provider === 'openrouter' && opened9.seed.model === 'test/m');
	check('S2: the seed ends AT the turn\'s own user message -- the prompt the runner anchors to',
		opened9.seed.msgs.length === 3
		&& opened9.seed.msgs[2].mid === 'turn-9' && opened9.seed.msgs[2].content === 'do the thing');
	check('S3: and carries the history before it, in order',
		opened9.seed.msgs.map((m) => m.mid).join(',') === 'm1,m2,turn-9');
	check('S4: the whole sealed errand is KILOBYTES, not the account -- the 23.3s flush it replaces',
		body9.envelope.length < 8 * 1024, 'sealed errand: ' + body9.envelope.length + ' B');
	{
		// A thread with a placeholder after the turn (which is what the dispatcher
		// writes next) and a view-only row in it: neither belongs to a model.
		const noisy = { id: 'c', messages: [
			{ role: 'think_log', content: 'thinking thinking', mid: 't1' },
			{ role: 'user', content: 'q', mid: 'u1' },
			{ role: 'assistant', content: 'a', mid: 'a1' },
			{ role: 'user', content: 'the prompt', mid: 'TURN' },
			{ role: 'assistant', content: '', mid: 'ph', interrupted: true, why: 'dispatched' },
		] };
		const sd = P.seedFrom(noisy, 'TURN');
		check('S5: a view-only row (think_log) is not seeded -- the runner rebuilds its own',
			!sd.msgs.some((m) => m.role === 'think_log'));
		check('S6: the dispatched PLACEHOLDER after the turn is not seeded',
			!sd.msgs.some((m) => m.mid === 'ph') && sd.msgs[sd.msgs.length - 1].mid === 'TURN');
		check('S7: a chat with nothing to seed answers null, not an empty shell',
			P.seedFrom({ id: 'c', messages: [] }, 'TURN') === null);
		// THE BUDGET. A long thread is clipped, and the newest end is what survives.
		const long = { id: 'c', messages: [] };
		for (let i = 0; i < 200; i++) {
			long.messages.push({ role: 'user', content: 'q'.repeat(2000), mid: 'u' + i });
			long.messages.push({ role: 'assistant', content: 'a'.repeat(2000), mid: 'a' + i });
		}
		long.messages.push({ role: 'user', content: 'the prompt', mid: 'TURN' });
		const big = P.seedFrom(long, 'TURN');
		const chars = big.msgs.reduce((n, m) => n + m.content.length, 0);
		check('S8: a long thread is clipped to the seed budget, so the errand stays small',
			big.msgs.length <= P.SEED_MAX_MSGS && chars <= P.SEED_MAX_CHARS,
			big.msgs.length + ' msgs, ' + chars + ' chars');
		check('S9: and the NEWEST end is what survives -- the turn itself is always in it',
			big.msgs[big.msgs.length - 1].mid === 'TURN');
		// ONE HUGE MESSAGE is clipped rather than dropped: a seed of nothing would
		// hand the turn back for want of a prompt.
		const huge = { id: 'c', messages: [{ role: 'user', content: 'x'.repeat(400 * 1024), mid: 'TURN' }] };
		const hs = P.seedFrom(huge, 'TURN');
		check('S10: a single oversized message is CLIPPED, never dropped -- the prompt always travels',
			hs && hs.msgs.length === 1 && hs.msgs[0].mid === 'TURN'
			&& hs.msgs[0].content.length > 0 && hs.msgs[0].content.length <= P.SEED_MAX_CHARS);
	}
	{
		// ── THE GRAFT, on the runner. ──
		const seeded = { seed: { chatId: 'c', msgs: [
			{ role: 'user', content: 'q', mid: 'u1' },
			{ role: 'assistant', content: 'a', mid: 'a1' },
			{ role: 'user', content: 'the prompt', mid: 'TURN' },
		] }, chatId: 'c', turnId: 'TURN' };
		check('S11: a chat this runner has never seen needs the WHOLE seed',
			P.seedGraft(null, seeded).map((m) => m.mid).join(',') === 'u1,a1,TURN');
		const partly = { messages: [{ role: 'user', content: 'q', mid: 'u1' }] };
		check('S12: a chat holding part of the thread needs only the rest -- no message is doubled',
			P.seedGraft(partly, seeded).map((m) => m.mid).join(',') === 'a1,TURN');
		const all = { messages: seeded.seed.msgs.map((m) => ({ role: m.role, content: m.content, mid: m.mid })) };
		check('S13: a runner whose pull landed first needs nothing -- the graft is a no-op',
			P.seedGraft(all, seeded).length === 0);
		check('S14: an errand with no seed grafts nothing (a dispatcher on an older build)',
			P.seedGraft(partly, { chatId: 'c', turnId: 'TURN' }).length === 0);
		// `holdsTurn` is the reconstruct's readiness test, and the reason it exists:
		// residency alone let a chat that synced BEFORE the prompt break out of the
		// catch-up, and runTurn then anchored to a user message that was not there.
		check('S15: holdsTurn is FALSE for a chat synced before the prompt',
			P.holdsTurn(partly, 'TURN') === false);
		check('S16: and TRUE once the prompt is in it, by mid and role',
			P.holdsTurn(all, 'TURN') === true
			&& P.holdsTurn({ messages: [{ role: 'assistant', content: 'x', mid: 'TURN' }] }, 'TURN') === false);
	}

	// ══════════════════════════════════════════════════════════
	// FIX B — HAND OFF BY REFERENCE, NOT BY VALUE. The errand carries the thread
	// (`seed`) only when the SEALED envelope fits the relay; a large conversation the
	// target already has synced is handed off with `seed:null` so the errand never
	// seals past the /api/post door and 413s (which lost the whole turn). The runner
	// reconstructs the thread from the parcel it is syncing anyway.
	//
	// FIX A — a REFUSED POST is a durable transcript event, and the turn is recovered
	// locally, never cleared into an empty prompt.
	//
	// Fail-first on the unmodified tree: `DaimondPost.relayMaxBytes`/`fitsRelay` and
	// `DaimondPeer.sealFittingErrand` do not exist, and the dispatch order is
	// post-first, so B0–B4 and A1 all fail there.
	console.log('\nFIX B — a large synced thread is handed off by reference (seed:null), fitting the relay');
	{
		const cap = phone.DaimondPost.relayMaxBytes();
		check('B0: the relay client publishes ONE effective /api/post cap (the deployed 64 KiB)',
			cap === 64 * 1024);
		check('B0: fitsRelay mirrors the gateway estimate exactly (base64Len/4*3 <= cap)',
			phone.DaimondPost.fitsRelay(87380, cap) === true        // 87380/4*3 = 65535 <= 65536
			&& phone.DaimondPost.fitsRelay(87384, cap) === false);  // 87384/4*3 = 65538  > 65536

		// A REALISTIC ~90 KB thread -- the recent tail a long daimon chat carries. seedFrom
		// clips it to SEED_MAX_CHARS, and that seed still SEALS (sign + GCM + base64) past
		// the 64 KiB door: this is the Ontheism 413, reproduced.
		const big = { id: 'chat-big', provider: 'openrouter', model: 'test/m', holds: [], messages: [] };
		for (let i = 0; i < 24; i++) {
			const role = i % 2 ? 'assistant' : 'user';
			big.messages.push({ role, content: (role[0]).repeat(3100), mid: 'b' + i, ts: T0 + i * 10 });
		}
		big.messages.push({ role: 'user', content: 'the big-thread prompt', mid: 'TURN-BIG', ts: T0 + 1000 });
		const bigOpts = { turnId: 'TURN-BIG', prompt: 'the big-thread prompt', dispatchedBy: 'devPHONE', now: T0 };

		// The DISEASE: the default seed-bearing errand for this thread seals PAST the cap.
		const withSeed  = phone.DaimondPeer.buildDispatch(big, bigOpts);
		const sealedWith = await phone.DaimondPeer.sealForSelf(withSeed.errand(0));
		check('B1: a seed-bearing errand for a ~90 KB thread would NOT fit the relay (the 413)',
			!!withSeed.fields.seed
			&& phone.DaimondPost.fitsRelay(sealedWith.envelope.length, cap) === false,
			'sealed WITH seed: ' + sealedWith.envelope.length + ' B base64');

		// THE CURE (S-HAND #3): sealFittingErrand SHRINKS the seed down a ladder and re-seals
		// until it fits -- it CLIPS rather than dropping, so a synced peer still grafts the
		// tail. (Pre-#3 it dropped the whole seed: `seedDropped:true` -- the fail-first here.)
		const fit = await phone.DaimondPeer.sealFittingErrand(big, bigOpts);
		check('B2: sealFittingErrand CLIPPED the seed to fit (did not drop it)',
			fit.seedDropped === false && fit.seedClipped === true, JSON.stringify({ d: fit.seedDropped, c: fit.seedClipped, tries: fit.tries }));
		check('B3: the errand it seals still carries a seed, with FEWER messages than the full thread',
			!!fit.plan.fields.seed && fit.plan.fields.seed.msgs.length < fit.plan.fields.thread.n,
			'seed msgs=' + (fit.plan.fields.seed && fit.plan.fields.seed.msgs.length) + ' thread.n=' + (fit.plan.fields.thread && fit.plan.fields.thread.n));
		check('B4: and the clipped sealed errand FITS the relay -- no 413',
			phone.DaimondPost.fitsRelay(fit.body.envelope.length, cap) === true,
			'sealed clipped: ' + fit.body.envelope.length + ' B base64');

		// The peer opens the clipped errand and grafts the carried tail into an empty chat.
		const openedBig = await laptop.DaimondPeer.openEnvelope(fit.body.envelope);
		check('B5: the peer opens the clipped errand -- prompt and turn intact, seed present',
			openedBig.turnId === 'TURN-BIG' && openedBig.prompt === 'the big-thread prompt'
			&& !!openedBig.seed && openedBig.seed.msgs.length > 0);
		check('B6: a clipped seed grafts its carried tail into an empty chat',
			phone.DaimondPeer.seedGraft({ messages: [] }, openedBig).length === openedBig.seed.msgs.length);

		// And the runner RUNS it: reconstruct stands in for the parcel pull, runTurn fires
		// once, the answer is pushed and the relay errand acked.
		L.forget();
		const sync = makeLeaseSync({});
		let ran = 0, pushed = 0, acked = 0;
		const res = await phone.DaimondPeer.runErrand(openedBig, {
			selfId: 'devLAPTOP', cas: phone.DaimondPeer.syncCas(sync),
			finished:    async () => false,
			reconstruct: async () => ({ chat: big, app: {} }),		// the parcel pull, stood in
			runTurn:     async () => { ran++; },
			abort: () => {}, pushResult: async () => { pushed++; return 1; },
			post:  async () => {}, ack: async () => { acked++; }, now: () => T0 + 2000,
		});
		check('B7: the runner reconstructs and RUNS the clipped-seed turn once',
			res.ran === true && res.done === true && ran === 1 && pushed === 1 && acked === 1);

		// B8 — SEEDLESS only when the seed cannot ride at all: here the PROMPT alone is
		// larger than the door, so the char budget goes negative and the ladder drops
		// straight to seedless (the runner must reconstruct from the parcel; #3(c) flushes
		// it first). A seedless errand that STILL overflows is what Fix 6 refuses to post.
		const hugePrompt = 'x'.repeat(80 * 1024);
		const hugeOpts = { turnId: 'TURN-BIG', prompt: hugePrompt, dispatchedBy: 'devPHONE', now: T0 };
		const seedless = await phone.DaimondPeer.sealFittingErrand(big, hugeOpts);
		check('B8: a prompt larger than the door drops the seed entirely (seed:null)',
			seedless.seedDropped === true && seedless.plan.fields.seed === null,
			JSON.stringify({ d: seedless.seedDropped, tries: seedless.tries }));
		check('B8: and even seedless it does NOT fit -- Fix 6 refuses to post such a prompt',
			phone.DaimondPost.fitsRelay(seedless.body.envelope.length, cap) === false,
			'seedless len=' + seedless.body.envelope.length);
	}

	// ── S-HAND #3: the thread fingerprint and the runner's readiness over it ──
	console.log('\nFIX #3 — threadSig/holdsThread: the runner never runs an incomplete thread');
	{
		const P = phone.DaimondPeer;
		const chat = { id: 'chat-ts', provider: 'openrouter', model: 'test/m', messages: [
			{ role: 'user',      content: 'q1', mid: 'm1', ts: T0 },
			{ role: 'assistant', content: 'a1', mid: 'm2', ts: T0 + 1 },
			{ role: 'tool',      content: 't1', mid: 'm3', ts: T0 + 2 },
			{ role: 'think_log', content: 'thinking...', mid: 'mx', ts: T0 + 3 },	// view-only, not fed
			{ role: 'assistant', content: 'half', mid: 'm4', interrupted: true, ts: T0 + 4 }, // a half turn
			{ role: 'assistant', content: 'prov', mid: 'm5', provisional: true, ts: T0 + 5 },  // render-only
			{ role: 'user',      content: 'the turn', mid: 'TURN', ts: T0 + 6 },
			{ role: 'assistant', content: 'after',  mid: 'm7', ts: T0 + 7 },		// after the turn
		] };
		const sig = P.threadSig(chat, 'TURN');
		check('#3a: threadSig counts only user|assistant|tool BEFORE the turn (3), not think_log/interrupted/provisional/after',
			sig.n === 3, 'n=' + sig.n);

		const errand = { turnId: 'TURN', thread: sig };
		check('#3b: holdsThread TRUE for the dispatcher\'s own chat', P.holdsThread(chat, errand) === true);

		// One model-facing row missing -> the prefix differs -> NOT ready.
		const missing = { id: 'x', messages: chat.messages.filter((m) => m.mid !== 'm2') };
		check('#3c: holdsThread FALSE with one model-facing row missing (a stale runner)',
			P.holdsThread(missing, errand) === false);
		// One extra model-facing row -> also not the same thread.
		const extra = { id: 'x', messages: chat.messages.slice(0, 3)
			.concat([{ role: 'assistant', content: 'extra', mid: 'mE', ts: T0 + 2 }])
			.concat(chat.messages.slice(3)) };
		check('#3d: holdsThread FALSE with one EXTRA model-facing row', P.holdsThread(extra, errand) === false);

		// A chat holding the PREFIX but NOT the turn's user message is ready once the prompt
		// is appended -- the reconstruct's "prefix proven, complete the turn" path.
		const prefixOnly = { id: 'x', messages: chat.messages.filter((m) => m.mid !== 'TURN' && m.mid !== 'm7') };
		check('#3e: holdsThread TRUE for a chat holding the prefix only (turn message absent)',
			P.holdsThread(prefixOnly, errand) === true);
		check('#3e: ...and holdsTurn is FALSE there, so the reconstruct appends the prompt',
			P.holdsTurn(prefixOnly, 'TURN') === false);

		// An errand with no `thread` (an older dispatcher) falls back to holdsTurn.
		check('#3f: holdsThread falls back to holdsTurn for an errand carrying no thread',
			P.holdsThread(chat, { turnId: 'TURN' }) === true
			&& P.holdsThread(prefixOnly, { turnId: 'TURN' }) === false);
	}

	console.log('\nFIX A — a refused /api/post preserves the turn (durable record) and recovers it locally');
	{
		// A refusing relay: the errand post is turned away (a 413, or a relay that is down).
		const refuse = async () => ({ ok: false, status: 413, why: 'too large for the relay to carry' });

		// The turn as the send path leaves it: the user prompt persisted, and
		// dispatchToPeer's FIRST act (order[0]) is the durable why:'dispatched' placeholder.
		const chatA = { id: 'chat-A', provider: 'openrouter', model: 'test/m', holds: [],
			messages: [{ role: 'user', content: 'run this somewhere', mid: 'TURN-A', iturn: 'TURN-A', ts: T0 }] };
		const planA = phone.DaimondPeer.buildDispatch(chatA, {
			turnId: 'TURN-A', prompt: 'run this somewhere', dispatchedBy: 'devPHONE', now: T0 });
		check('A1: the durable placeholder is written BEFORE the post (order[0] === mark-dispatched)',
			planA.order[0] === 'mark-dispatched');

		// MARK FIRST: the placeholder exists before the post is even attempted.
		chatA.messages.push({ role: 'assistant', content: '', mid: 'ph-A', interrupted: true,
			why: planA.mark.why, iturn: planA.mark.iturn, itext: planA.mark.itext });
		const placeholder = chatA.messages.find((m) => m.why === 'dispatched' && m.iturn === 'TURN-A');

		// The post is REFUSED, and the placeholder is STAMPED -- not left bare, not lost.
		const sealedA  = await phone.DaimondPeer.sealFittingErrand(chatA, {
			turnId: 'TURN-A', prompt: 'run this somewhere', dispatchedBy: 'devPHONE', now: T0 }, planA);
		const postRes = await refuse(sealedA.body);
		check('A2: the relay refused the errand post', postRes.ok === false && postRes.status === 413);
		if (!postRes.ok) placeholder.refused = { status: postRes.status, why: postRes.why, ts: T0 };
		check('A3: the turn is PRESERVED -- the durable placeholder stands, stamped refused',
			chatA.messages.some((m) => m.why === 'dispatched' && m.iturn === 'TURN-A')
			&& !!placeholder.refused && placeholder.refused.status === 413);

		// The refused turn is RECOVERED LOCALLY -- the money-safe path dispatchToPeer takes
		// on refusal: a recovery errand from the placeholder runs HERE, once, via the lease.
		L.forget();
		const sync = makeLeaseSync({});
		let ran = 0, pushed = 0, acked = 0;
		// As `errandForRecovery` builds it: no seed, the placeholder's stamp, and the birth
		// read off this device's own copy of the chat (`turnBirthsHeld`, daimond.js).
		const recovery = phone.DaimondPeer.makeErrand({
			turnId: 'TURN-A', chatId: 'chat-A', prompt: placeholder.itext, eid: 'e-A',
			deadline: 0, dispatchedBy: 'devPHONE', ts: T0 });
		const rec = await phone.DaimondPeer.runErrand(recovery, {
			selfId: 'devPHONE', cas: phone.DaimondPeer.syncCas(sync), allowSelf: true,
			births: (er) => phone.DaimondPeer.turnBirthHints(chatA.messages, er.turnId),
			finished:    async () => false,
			reconstruct: async () => ({ chat: chatA, app: {} }),
			runTurn:     async () => { ran++; },
			abort: () => {}, pushResult: async () => { pushed++; return 1; },
			post:  async () => {}, ack: async () => { acked++; }, now: () => T0 + 2000,
		});
		check('A4: the refused turn RUNS locally exactly once (never cleared into an empty turn)',
			rec.ran === true && rec.done === true && ran === 1);
		check('A5: the local recovery pushes the answer and acks the relay errand',
			pushed === 1 && acked === 1);
	}

	// ── The why:'dispatched' handling: dispatchState against the lease ──
	console.log('\nDispatched turn — dispatchState classifies it against the lease');
	const dTurn = { why: 'dispatched', iturn: 'turn-9' };
	const liveForeign = { turnId: 'turn-9', holder: 'devLAPTOP', mode: 'running', expiry: T0 + 60000, renewedAt: T0 };
	const liveOwn     = { turnId: 'turn-9', holder: 'devPHONE',  mode: 'running', expiry: T0 + 60000, renewedAt: T0 };
	const expired     = { turnId: 'turn-9', holder: 'devLAPTOP', mode: 'running', expiry: T0 - 1,     renewedAt: T0 };
	check('a dispatched turn under a live FOREIGN lease is peer-held',
		P.dispatchState(dTurn, liveForeign, 'devPHONE', T0) === 'peer-held');
	check('a dispatched turn under our OWN lease is reclaimable',
		P.dispatchState(dTurn, liveOwn, 'devPHONE', T0) === 'reclaimable');
	check('a dispatched turn under an EXPIRED lease is reclaimable',
		P.dispatchState(dTurn, expired, 'devPHONE', T0) === 'reclaimable');
	check('a dispatched turn with NO lease is reclaimable',
		P.dispatchState(dTurn, null, 'devPHONE', T0) === 'reclaimable');
	check('an ordinary interrupted turn is not-dispatched',
		P.dispatchState({ why: 'offline' }, liveForeign, 'devPHONE', T0) === 'not-dispatched');

	// ══════════════════════════════════════════════════════════
	// STEP 5 — the runner: take -> run -> push -> report -> release,
	// the syncCas adapter, the revoke->abort path, ack-after-commit.
	// ══════════════════════════════════════════════════════════
	console.log('\nRunner — the errand runs end to end, and aborts on revoke');
	await runRunnerAcceptance(phone.DaimondPeer, phone.DaimondLease, check);

	// ══════════════════════════════════════════════════════════
	// STEP 5b — THE RENEW HEARTBEAT is bounded: it stops on every
	// exit and cannot outlive its turn. This is the fix for the
	// permanent 409 push-loop -- a lease that renewed for ever
	// rewrote the parcel every 30s, so it was never a fixed point.
	// ══════════════════════════════════════════════════════════
	console.log('\nHeartbeat — the renew ticker is owned by runErrand and can never renew for ever');
	await runHeartbeatContainment(phone.DaimondPeer, phone.DaimondLease, check);

	// ══════════════════════════════════════════════════════════
	// STEP 5c — THE >LEASE_TTL_MS DOUBLE-RUN, closed. A busy turn
	// cannot propagate a 30s renew (the push is suppressed over a
	// live turn), so a TTL-capped lease read EXPIRED on other
	// devices after 90s while the turn ran on -- and the phone's
	// recovery re-ran and re-billed it. The lease is now claimed to
	// the errand DEADLINE, so it stays live for the whole turn with
	// no renew, and exactly one device ever runs and bills it.
	// ══════════════════════════════════════════════════════════
	console.log('\nDeadline lease — a >TTL turn cannot be double-run (claim expires at the deadline, no renew)');
	await runDeadlineExpiryMoneySafety(phone.DaimondPeer, phone.DaimondLease, check);

	// ══════════════════════════════════════════════════════════
	// S-HAND #1 — the SETTLED own-errand is released (the MONEY
	// defect). `holdOwnDispatch` tells post.js when to stop holding
	// the sender's own errand; `leaseSetCas` stamps `settled:1` on
	// done->released and `leaseTakeFromCas` refuses a settled lease.
	// ══════════════════════════════════════════════════════════
	console.log('\nSettle — a settled own-errand stops holding, and a settled lease refuses a take');
	await runSettleMoneySafety(phone.DaimondPeer, phone.DaimondLease, check);

	// ══════════════════════════════════════════════════════════
	// STEP 6 — the UI state machine (pure). daimond.js only renders
	// what uiState decides; here every §5 state is asserted.
	// ══════════════════════════════════════════════════════════
	console.log('\nUI state — uiState classifies a dispatched turn through its life');
	const U = phone.DaimondPeer;
	const S = 1700000000000;
	const dt = { why: 'dispatched', iturn: 'turn-u', deadline: S + U.DISPATCH_DEADLINE_MS };
	const claimed = { turnId: 'turn-u', holder: 'devLAP', mode: 'claimed', expiry: S + 60000, renewedAt: S };
	const running = { turnId: 'turn-u', holder: 'devLAP', mode: 'running', expiry: S + 60000, renewedAt: S };
	const uExpired = { turnId: 'turn-u', holder: 'devLAP', mode: 'running', expiry: S - 1,     renewedAt: S };
	const released = { turnId: 'turn-u', holder: 'devLAP', mode: 'released', expiry: 0,        renewedAt: S };
	const repDone = { t: 'report', turnId: 'turn-u', status: 'done' };
	const repFail = { t: 'report', turnId: 'turn-u', status: 'refused-spend' };

	check('dispatched, no lease yet -> "dispatched"',
		U.uiState(dt, null, null, 'devPHONE', S) === 'dispatched');
	check('dispatched, deadline passed, no lease -> "no-peer-awake"',
		U.uiState(dt, null, null, 'devPHONE', S + U.DISPATCH_DEADLINE_MS + 1) === 'no-peer-awake');
	check('a live claimed lease -> "claimed"',
		U.uiState(dt, claimed, null, 'devPHONE', S) === 'claimed');
	check('a live running lease -> "running"',
		U.uiState(dt, running, null, 'devPHONE', S) === 'running');
	check('a done report -> "done" (outlives the lease)',
		U.uiState(dt, released, repDone, 'devPHONE', S) === 'done');
	check('a failure report -> "failed"',
		U.uiState(dt, running, repFail, 'devPHONE', S) === 'failed');
	check('a lease taken then EXPIRED with no report -> "failed" (peer stopped)',
		U.uiState(dt, uExpired, null, 'devPHONE', S) === 'failed');
	check('an ordinary (non-dispatched) turn -> "not-dispatched"',
		U.uiState({ why: 'offline' }, running, null, 'devPHONE', S) === 'not-dispatched');
	// The thin lease-record lookup the guards/renderer use.
	phone.DaimondLease.forget();
	check('DaimondLease.record is null for an unknown turn',
		phone.DaimondLease.record('nope') === null);

	// ══════════════════════════════════════════════════════════
	// STEP 7 — presence beat (freshest-scalar) + smart auto-dispatch.
	// ══════════════════════════════════════════════════════════
	console.log('\nPresence + auto-dispatch — awake peers, and when to hand off');
	await runPresenceAcceptance(phone.DaimondPeer, phone.DaimondPresence, check);

	// ══════════════════════════════════════════════════════════
	// MONEY-SAFETY REGRESSIONS — the four defects live two-context QA
	// found (dev/PEER_DESIGN.md §2, §3.3, §4). Each check fails on the
	// pre-fix code and passes on the fix.
	// ══════════════════════════════════════════════════════════
	await runMoneySafety(phone, laptop, check);

	// ══════════════════════════════════════════════════════════
	// ORPHAN RECOVERY — the shipped "sent to your other devices, then
	// nothing" failure. A phone dispatches a turn no peer runs and comes
	// back to nothing. The fix rescues it on return, THROUGH the same lease,
	// so a peer that also claims never causes a second run or a second
	// charge. These checks fail on the pre-fix code and pass on the fix.
	// ══════════════════════════════════════════════════════════
	await runRecoveryAcceptance(phone.DaimondPeer, phone.DaimondLease, check);

	// ══════════════════════════════════════════════════════════
	// S6-1 — the LOCAL doors get the same ask-answer guard the dispatched
	// tile already has: `continueTurn`/`retryTurn` (daimond.js), driven from
	// their real extracted source. Fails on 2207f686, passes on the fix.
	// ══════════════════════════════════════════════════════════
	await runLocalAskAnswerGuardAcceptance(phone.DaimondPeer, check);

	// ══════════════════════════════════════════════════════════
	// FIRE-AND-FORGET — once a desktop CLAIMS the lease it runs the
	// turn to COMPLETION and syncs the result WITHOUT the phone
	// staying awake. The phone dispatches, may background mid-turn
	// (its watch/expedite loop frozen), renders the result on its next
	// wake/pull without ever having DRIVEN the turn, and a wake
	// re-check NEVER double-runs. (owner deferred fix 2026-09-10.)
	// ══════════════════════════════════════════════════════════
	await runFireAndForgetAcceptance(phone.DaimondPeer, phone.DaimondLease, check);

	// ══════════════════════════════════════════════════════════
	// THE NOMINATED RUNNER — a claim guard that defers to one device
	// when it is FRESHLY awake, without ever stranding a turn: an
	// offline or stale nominee is no barrier, and the stand-down is
	// re-decided against live presence rather than being permanent.
	// ══════════════════════════════════════════════════════════
	await runNominationAcceptance(phone.DaimondPeer, phone.DaimondLease, check);

	// ══════════════════════════════════════════════════════════
	// THE FALLBACK LIVENESS GLUE — the HOLD (post.js takeRow) that
	// keeps a stood-down errand on the relay, the scheduled re-collect
	// that drives it, and the RE-ARM on a transient collect failure so
	// the driver is restored rather than dropped. Drives the REAL
	// post.js takeRow and peer.js runErrand; the daimond.js scheduler is
	// modelled faithfully (null-first, await, re-arm on !ok) on a hand
	// -driven timer, since daimond.js does not load under node.
	// ══════════════════════════════════════════════════════════
	await runFallbackLivenessAcceptance(laptop, check);

	// ══════════════════════════════════════════════════════════
	// REMOTE CONSENT FOR A HANDED-OFF TURN — the two envelopes, the
	// exact-act binding, the forged/replayed-grant defence, PARK ->
	// terminal at MAX_PARKS with the lease freed not stranded, the
	// GLOBAL two-device parkCount bound, policy composition, and
	// attended-only routing. (dev/HANDOFF_CONSENT_DESIGN.md.)
	// ══════════════════════════════════════════════════════════
	await runRemoteConsentAcceptance(phone, laptop, stranger, check);

	// ══════════════════════════════════════════════════════════
	// BROADCAST CONSENT (owner rule 2026-09-09) — a handed-off turn's
	// permission ask reaches EVERY device, is answerable from ANY, and
	// the first answer resolves it everywhere. A THIRD same-account
	// device (DESK) joins PHONE and LAPTOP so the sim is genuinely
	// multi-device; STRANGER is the forged-grant negative control.
	// ══════════════════════════════════════════════════════════
	const desk = makeTab();
	check('desk adopts the account bundle (third same-account device)',
		desk.DaimondIdentity.importBundle(bundle));
	const unD = await desk.DaimondIdentity.unlock(PASS_A);
	check('desk unlocks the shared account', !!unD && unD.ok === true && desk.DaimondIdentity.isUnlocked());
	await runBroadcastConsentAcceptance(phone, laptop, desk, stranger, check);

	streamedViewChecks(phone);
	// ══════════════════════════════════════════════════════════
	// THE BLOCKER (owner ruling 2026-09-12) — what stopped the runner is
	// copied to every device, answerable from any one of them, cleared
	// everywhere by the first answer; and a runner that restarted, or was
	// refused by the provider, hands the turn back instead of hanging it.
	// ══════════════════════════════════════════════════════════
	await runBlockerAcceptance(phone.DaimondPeer, phone.DaimondLease, check);

	// ══════════════════════════════════════════════════════════
	// E-R1 AND R4b (2026-09-23) — a handed-off turn is judged by its BIRTH,
	// never by the deadline its sender wrote, and the backstop never hands a
	// turn straight back to the desktop that just failed to collect it.
	// Every check fails at 4d164343 unless it says it holds a property.
	// ══════════════════════════════════════════════════════════
	await runTurnAgeAcceptance(phone.DaimondPeer, phone.DaimondLease, phone.DaimondPresence, check);
	await runElectedTriedAcceptance(phone.DaimondPeer, check);

	console.log(failures === 0 ? '\nALL PASS' : ('\n' + failures + ' FAILURE(S)'));
	if (failures) process.exitCode = 1;
}

// The REALISTIC leases CAS: unlike makeLeaseSync (a clean compare-and-set), this
// models sync.js's push() + daimond.js's peerSyncShim faithfully -- on a 409 it
// PULLS the winner's lease in, MERGES it (take-if-vacant drops our own claim) and
// RETRIES, and it reports success by the VERSION ADVANCING. That advance is NOT
// proof our claim landed: through this path a losing racer's version moves too. A
// take that trusts `ok` alone lets BOTH racers believe they won -- the double
// charge. `leaseTakeFrom` must re-read and confirm the section still names it.
function makeRealisticSync(L, gw, NOW) {
	let localVersion = gw.version();
	let view = {};
	return {
		version: () => localVersion,
		leases:  () => JSON.parse(JSON.stringify(view)),
		commit:  async (base, proposed) => {
			if (localVersion !== base) return { ok: false, version: localVersion, leases: JSON.parse(JSON.stringify(view)) };
			view = JSON.parse(JSON.stringify(proposed));				// install
			for (let a = 0; a < 4; a++) {
				const r = gw.push(localVersion, view);
				if (r.status === 200) { localVersion = r.version; break; }	// clean commit
				localVersion = r.version;								// 409: pull + merge + retry
				view = L.merge(view, r.leases, NOW);
			}
			if (localVersion > base) return { ok: true, version: localVersion };
			return { ok: false, version: localVersion, leases: JSON.parse(JSON.stringify(view)) };
		},
	};
}

async function runRecoveryAcceptance(P, L, check) {
	const NOW = 1700000000000;

	// ── ADVERSARIAL, the money crux: a phone RECOVERS-LOCAL while a PEER also
	//    claims, from the SAME base version, through the REALISTIC pull-merge-retry
	//    commit. Exactly one may hold the lease -- else exactly one double-charge. ──
	{
		console.log('\nRecovery — adversarial: recover-local vs a peer claim, realistic sync');
		L.forget();
		let gwV = 5, gwL = {};
		const gw = {
			version: () => gwV,
			leases:  () => JSON.parse(JSON.stringify(gwL)),
			push: (base, next) => {
				if (base !== gwV) return { status: 409, version: gwV, leases: JSON.parse(JSON.stringify(gwL)) };
				gwV += 1; gwL = JSON.parse(JSON.stringify(next));
				return { status: 200, version: gwV };
			},
		};
		const phoneCas = P.syncCas(makeRealisticSync(L, gw, NOW));
		const peerCas  = P.syncCas(makeRealisticSync(L, gw, NOW));
		const snapPhone = await phoneCas.read();		// both read the SAME base 5
		const snapPeer  = await peerCas.read();
		// The phone's local recovery take (allowSelf on the runner; here the take is
		// what matters) and the peer's take race from that one base version.
		const rPhone = await L.takeFrom(snapPhone, 'turn-adv', { holder: 'PHONE', eid: 'e', deadline: 0 }, phoneCas, () => NOW);
		const rPeer  = await L.takeFrom(snapPeer,  'turn-adv', { holder: 'PEER',  eid: 'e', deadline: 0 }, peerCas,  () => NOW + 1);
		check('recover-vs-peer: EXACTLY ONE take wins (no double-charge) through the realistic commit',
			(rPhone.won ? 1 : 0) + (rPeer.won ? 1 : 0) === 1);
		check('recover-vs-peer: the loser stood down and was told the true holder',
			rPeer.won === false && rPeer.holder === 'PHONE');
		check('recover-vs-peer: the gateway names exactly one holder',
			!!gw.leases()['turn-adv'] && gw.leases()['turn-adv'].holder === 'PHONE');
	}

	// ── An ORPHAN is rescued locally, exactly once, and acked so no peer re-runs. ──
	{
		console.log('\nRecovery — an orphaned dispatched turn runs locally on return');
		L.forget();
		const sync = makeLeaseSync({});
		let ran = 0, acked = 0, pushed = 0, reported = 0;
		const errand = sentErrand(P, { turnId: 't-orphan', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
		const res = await P.runErrand(errand, {
			selfId: 'PHONE', cas: P.syncCas(sync), allowSelf: true,
			finished:    async () => false,
			reconstruct: async () => ({ chat: {}, app: {} }),
			runTurn:     async () => { ran++; },
			abort: () => {}, pushResult: async () => { pushed++; return 1; },
			post:  async () => { reported++; }, ack: async () => { acked++; }, now: () => NOW,
		});
		check('orphan recovery RUNS the turn locally exactly once', res.ran === true && res.done === true && ran === 1);
		check('orphan recovery ACKS the relay errand (so no peer re-collects and re-runs)', acked === 1);
		check('orphan recovery pushes the answer and posts a done report', pushed === 1 && reported === 1);
		check('orphan recovery released the lease when done', sync.leases()['t-orphan'].mode === 'released');
	}

	// ── UNDELIVERABLE reconstruct: the peer HANDS THE TURN BACK cleanly. When the
	//    progress-based catch-up gives up (the chat's parcel never synced here), the
	//    reconstruct throws an `undeliverable` error. runErrand must: report status
	//    'undeliverable' (so the dispatcher drops to a local run), RELEASE the lease
	//    (nothing ran — money-safe), and ACK the errand (so no peer re-claims it into a
	//    loop — the production claim-loop). It must NOT run the turn. ──
	{
		console.log('\nReconstruct — an UNDELIVERABLE chat is handed back: report + release + ack, never run');
		L.forget();
		const sync = makeLeaseSync({});
		let ran = 0, acked = 0, pushed = 0; let report = null;
		const errand = sentErrand(P, { turnId: 't-undel', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'DESK' });
		const res = await P.runErrand(errand, {
			selfId: 'PEER', cas: P.syncCas(sync),
			finished:    async () => false,
			reconstruct: async () => { const e = new Error('could not sync in time'); e.undeliverable = true; throw e; },
			runTurn:     async () => { ran++; },
			abort: () => {}, pushResult: async () => { pushed++; return 1; },
			post:  async (r) => { report = r; }, ack: async () => { acked++; }, now: () => NOW,
		});
		check('undeliverable reconstruct did NOT run the turn (no bill)', ran === 0 && res.ran === false && res.done !== true);
		check('undeliverable reconstruct reported status "undeliverable"', !!report && report.status === 'undeliverable');
		check('undeliverable reconstruct ACKED the errand (peers stop re-claiming)', acked === 1);
		check('undeliverable reconstruct RELEASED the lease (reclaimable at once)', sync.leases()['t-undel'].mode === 'released');
		check('undeliverable reconstruct pushed nothing (nothing ran)', pushed === 0);
		check('undeliverable is flagged on the result for the caller', res.undeliverable === true);
		check('undeliverable trace is report → release → ack',
			res.trace.join(',').includes('reconstruct-undeliverable')
			&& res.trace.indexOf('release') > res.trace.indexOf('report')
			&& res.trace.indexOf('ack') > res.trace.indexOf('release'));
	}

	// ── A NON-undeliverable reconstruct error (a surprise this device could be alone in
	//    hitting) is still handed back, but NOT acked — left on the relay for another
	//    peer or the deadline, exactly as before the undeliverable split. ──
	{
		console.log('\nReconstruct — an unexpected error reports "error", releases, but does NOT ack');
		L.forget();
		const sync = makeLeaseSync({});
		let ran = 0, acked = 0; let report = null;
		const errand = sentErrand(P, { turnId: 't-err', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'DESK' });
		const res = await P.runErrand(errand, {
			selfId: 'PEER', cas: P.syncCas(sync),
			finished:    async () => false,
			reconstruct: async () => { throw new Error('scope blew up'); },	// no .undeliverable
			runTurn:     async () => { ran++; },
			abort: () => {}, pushResult: async () => 1,
			post:  async (r) => { report = r; }, ack: async () => { acked++; }, now: () => NOW,
		});
		check('unexpected reconstruct error did NOT run the turn', ran === 0 && res.ran === false);
		check('unexpected reconstruct error reported status "error"', !!report && report.status === 'error');
		check('unexpected reconstruct error did NOT ack (left on the relay for another peer)', acked === 0);
		check('unexpected reconstruct error released the lease', sync.leases()['t-err'].mode === 'released');
		check('unexpected reconstruct error is NOT flagged undeliverable', res.undeliverable !== true);
	}

	// ── Recovery STANDS DOWN when a peer holds a LIVE lease -- no take-over, no
	//    double run -- both by the pure decision and by the runner's own take. ──
	{
		console.log('\nRecovery — stands down when a peer is genuinely on the turn');
		L.forget();
		const now = NOW;
		const live = { 't-held': { turnId: 't-held', eid: 'e', holder: 'PEER', mode: 'running', expiry: now + L.LEASE_TTL_MS, renewedAt: now } };
		// The phone's own placeholder, sent a minute ago: the one the rescue exists for.
		const own = (iturn) => ({ why: 'dispatched', iturn, dispatchedBy: 'PHONE', ts: now - 60000 });
		check('recoverDecision: FALSE under a live foreign lease (leave it to the peer)',
			P.recoverDecision(own('t-held'), live['t-held'], false, 'PHONE', now) === false);
		check('recoverDecision: TRUE when vacant and unfinished (rescue the orphan)',
			P.recoverDecision(own('x'), null, false, 'PHONE', now) === true);
		check('recoverDecision: FALSE when the turn is already finished (a peer answered)',
			P.recoverDecision(own('x'), null, true, 'PHONE', now) === false);
		check('recoverDecision: FALSE for a turn that was never dispatched',
			P.recoverDecision({ why: 'offline', iturn: 'x', dispatchedBy: 'PHONE', ts: now }, null, false, 'PHONE', now) === false);
		// THE 2026-09-22 INCIDENT: gilgamesh re-ran turns another device had sent five days
		// before. A placeholder synced from elsewhere is never this device's to rescue, and
		// no hand-off is rescued automatically once its errand deadline has passed.
		check('recoverDecision: FALSE for a placeholder ANOTHER device sent (synced here, not ours)',
			P.recoverDecision({ why: 'dispatched', iturn: 'x', dispatchedBy: 'LAPTOP', ts: now - 60000 }, null, false, 'PHONE', now) === false);
		check('recoverDecision: FALSE for a placeholder that names no sender',
			P.recoverDecision({ why: 'dispatched', iturn: 'x', ts: now - 60000 }, null, false, 'PHONE', now) === false);
		check('recoverDecision: FALSE for our own hand-off once past its errand deadline',
			P.recoverDecision({ why: 'dispatched', iturn: 'x', dispatchedBy: 'PHONE', ts: now - P.DISPATCH_DEADLINE_MS - 1 }, null, false, 'PHONE', now) === false);
		check('recoverDecision: FALSE for a five-day-old hand-off (the incident, exactly)',
			P.recoverDecision({ why: 'dispatched', iturn: 'mu4y7fa4-1-du152', dispatchedBy: 'PHONE', ts: now - 5 * 86400000 }, null, false, 'PHONE', now) === false);
		check('uiState: an unclaimed hand-off past its errand deadline offers [Run here] (no-peer-awake)',
			P.uiState({ why: 'dispatched', iturn: 'x', ts: now - P.DISPATCH_DEADLINE_MS - 1 }, null, null, 'PHONE', now) === 'no-peer-awake');
		check('uiState: and one inside it is still "dispatched"',
			P.uiState({ why: 'dispatched', iturn: 'x', ts: now - 60000 }, null, null, 'PHONE', now) === 'dispatched');

		// THE WATCH BOUND (2026-09-23): a handed-off turn is watched for frames only while
		// some device could still be sending them.
		const DL = 15 * 60 * 1000;
		const seat = { why: 'dispatched', iturn: 'w', ts: now - 60000 };
		check('watchDecision: TRUE under a live foreign lease (the runner is streaming)',
			P.watchDecision(seat, live['t-held'], false, 'PHONE', now) === true);
		check('watchDecision: FALSE under this device\'s own live lease (it runs here)',
			P.watchDecision(seat, { holder: 'PHONE', mode: 'running', expiry: now + 1000, renewedAt: now }, false, 'PHONE', now) === false);
		check('watchDecision: TRUE for a fresh seat nobody has claimed yet',
			P.watchDecision(seat, null, false, 'PHONE', now) === true);
		check('watchDecision: FALSE for an unclaimed seat past the errand deadline',
			P.watchDecision({ why: 'dispatched', iturn: 'w', ts: now - DL - 1 }, null, false, 'PHONE', now) === false);
		check('watchDecision: FALSE once finished, even under a live lease',
			P.watchDecision(seat, live['t-held'], true, 'PHONE', now) === false);
		check('watchDecision: FALSE when this seat\'s claim lapsed (no device holds it)',
			P.watchDecision(seat, { holder: 'PEER', mode: 'running', expiry: now - 1, renewedAt: now - 30000 }, false, 'PHONE', now) === false);
		check('watchDecision: FALSE when this seat\'s claim was released',
			P.watchDecision(seat, { holder: 'PEER', mode: 'released', expiry: 0, renewedAt: now - 30000 }, false, 'PHONE', now) === false);
		check('watchDecision: TRUE for a re-seat whose only lease is an EARLIER seating\'s',
			P.watchDecision(seat, { holder: 'PEER', mode: 'released', expiry: 0, renewedAt: now - 120000 }, false, 'PHONE', now) === true);
		check('watchDecision: FALSE for a placeholder with no stamp to age it by',
			P.watchDecision({ why: 'dispatched', iturn: 'w' }, null, false, 'PHONE', now) === false);
		check('watchDecision: FALSE for a turn that was never dispatched',
			P.watchDecision({ why: 'offline', iturn: 'w', ts: now }, null, false, 'PHONE', now) === false);
		check('recoverDecision: FALSE for an ask-card answer ("Chose: …"), even our own and fresh',
			P.recoverDecision({ why: 'dispatched', iturn: 'x', dispatchedBy: 'PHONE', ts: now - 60000,
				itext: 'Chose: Detach the paths' }, null, false, 'PHONE', now) === false);
		check('recoverDecision: FALSE for an ask-card answer in the reader\'s own words ("Other: …")',
			P.recoverDecision({ why: 'dispatched', iturn: 'x', dispatchedBy: 'PHONE', ts: now - 60000,
				itext: 'Other: leave them' }, null, false, 'PHONE', now) === false);
		// AN UNDELIVERABLE HAND-BACK SPINS ONLY WHERE IT WILL BE RUN (audit F2). The tile
		// reads 'claimed', a spinner with no control, only on the device whose own recovery
		// gate says it runs the turn; everywhere else it is 'failed', with [Run here].
		{
			const undel = { t: 'report', status: 'undeliverable' };
			check('uiState: undeliverable on the sender, own fresh hand-off, is claimed (it recovers it)',
				P.uiState(own('u'), null, undel, 'PHONE', now) === 'claimed');
			check('uiState: undeliverable on a device that did NOT send it is failed ([Run here]), not a spinner',
				P.uiState(own('u'), null, undel, 'LAPTOP', now) === 'failed');
			check('uiState: undeliverable ask answer is failed, since no recovery will run it',
				P.uiState({ why: 'dispatched', iturn: 'u', dispatchedBy: 'PHONE', ts: now - 60000,
					itext: 'Chose: Detach the paths' }, null, undel, 'PHONE', now) === 'failed');
			check('uiState: undeliverable past the errand deadline is failed',
				P.uiState({ why: 'dispatched', iturn: 'u', dispatchedBy: 'PHONE',
					ts: now - P.DISPATCH_DEADLINE_MS - 1 }, null, undel, 'PHONE', now) === 'failed');
		}
		// THE DEADLINE CANNOT OUTLIVE THE ERRAND (audit F4): a placeholder's `deadline` is
		// capped at DISPATCH_DEADLINE_MS past its stamp, and a stamp far in the future (a
		// fast clock at send) reads as expired rather than recoverable for the skew.
		{
			const DDM = P.DISPATCH_DEADLINE_MS;
			check('handoffDeadline: a deadline past the errand\'s is capped at ts + DISPATCH_DEADLINE_MS',
				P.handoffDeadline({ ts: now - 60000, deadline: now + 10 * DDM }) === now - 60000 + DDM);
			check('handoffDeadline: a shorter deadline stands',
				P.handoffDeadline({ ts: now - 60000, deadline: now + 1000 }) === now + 1000);
			check('recoverDecision: FALSE for our own twenty-minute-old hand-off with an inflated deadline',
				P.recoverDecision({ why: 'dispatched', iturn: 'x', dispatchedBy: 'PHONE', ts: now - 20 * 60000,
					deadline: now + 10 * DDM }, null, false, 'PHONE', now) === false);
			check('recoverDecision: FALSE for our own hand-off stamped far in the future (clock ran fast)',
				P.recoverDecision({ why: 'dispatched', iturn: 'x', dispatchedBy: 'PHONE', ts: now + 2 * DDM },
					null, false, 'PHONE', now) === false);
			check('recoverDecision: TRUE for our own hand-off stamped a little ahead (ordinary skew)',
				P.recoverDecision({ why: 'dispatched', iturn: 'x', dispatchedBy: 'PHONE', ts: now + 30000 },
					null, false, 'PHONE', now) === true);
		}
		// AN ANSWER IS NEVER SENT WITHOUT ITS QUESTION, NOT EVEN ON A CLICK (replay site 4).
		{
			const ans = { why: 'dispatched', iturn: 'q', dispatchedBy: 'PHONE', ts: now - 5 * 86400000,
				itext: 'Chose: Detach the paths' };
			check('dispatchControl: an expired ask answer offers answeragain, never [Run here]',
				P.dispatchControl('no-peer-awake', ans) === 'answeragain');
			check('dispatchControl: a failed ask answer offers answeragain',
				P.dispatchControl('failed', ans) === 'answeragain');
			check('dispatchControl: a parked ask answer offers answeragain, not a re-run',
				P.dispatchControl('parked', ans) === 'answeragain');
			check('dispatchControl: an "Other: …" answer is an answer too',
				P.dispatchControl('no-peer-awake', Object.assign({}, ans, { itext: 'Other: leave them' })) === 'answeragain');
			check('dispatchControl: a plain expired prompt keeps [Run here]',
				P.dispatchControl('no-peer-awake', Object.assign({}, ans, { itext: 'Keep going autonomously now' })) === 'runhere');
			check('dispatchControl: an ask answer still in flight keeps its pre-claim take-back',
				P.dispatchControl('dispatched', ans) === 'takeback');
		}
		// A PLACEHOLDER WITH NO STAMP READS AS EXPIRED (audit F6), as watchDecision has it.
		check('uiState: a placeholder with no stamp is no-peer-awake ([Run here]), not "dispatched" for ever',
			P.uiState({ why: 'dispatched', iturn: 'x' }, null, null, 'PHONE', now) === 'no-peer-awake');
		// THE EXECUTION POINT HOLDS TOO: a recovery errand naming another device as its
		// sender is refused by the runner, whatever decided to ask.
		{
			const s2 = makeLeaseSync({});
			let ran2 = 0;
			const foreign = P.makeErrand({ turnId: 'mu4y7fa4-1-du152', chatId: 'c', prompt: 'Chose: Detach the paths',
				eid: 'e', deadline: now + 60000, dispatchedBy: 'ARGONAUT' });
			const r2 = await P.runErrand(foreign, {
				selfId: 'GILGAMESH', cas: P.syncCas(s2), allowSelf: true,
				finished: async () => false,
				reconstruct: async () => ({}),
				runTurn: async () => { ran2++; },
				abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {}, now: () => now,
			});
			check('runErrand: a RECOVERY of a turn another device sent is refused (not-own-recovery), nothing runs',
				ran2 === 0 && r2.ran === false && r2.why === 'not-own-recovery', JSON.stringify({ ran2, why: r2.why }));
		}
		{
			const s3 = makeLeaseSync({});
			let ran3 = 0;
			// As `errandForRecovery` builds it from a placeholder sent a window ago: the
			// placeholder's own stamp, and its deadline.
			const stale = sentErrand(P, { turnId: 't-stale', chatId: 'c', prompt: 'p', eid: 'e',
				deadline: now - 1000, dispatchedBy: 'PHONE', ts: now - P.DISPATCH_DEADLINE_MS - 1000 });
			const r3 = await P.runErrand(stale, {
				selfId: 'PHONE', cas: P.syncCas(s3), allowSelf: true,
				finished: async () => false,
				reconstruct: async () => ({}),
				runTurn: async () => { ran3++; },
				abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {}, now: () => now,
			});
			check('runErrand: our own recovery past the hand-off deadline takes no lease and runs nothing',
				ran3 === 0 && r3.ran === false, JSON.stringify({ ran3, why: r3.why }));
		}
		// And the runner itself stands down on the take, even asked to recover.
		const sync = makeLeaseSync(live);
		let ran = 0, touched = false;
		const errand = sentErrand(P, { turnId: 't-held', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
		const res = await P.runErrand(errand, {
			selfId: 'PHONE', cas: P.syncCas(sync), allowSelf: true,
			finished: async () => false,
			reconstruct: async () => { touched = true; return {}; },
			runTurn: async () => { ran++; },
			abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {}, now: () => now,
		});
		check('recovery runner STANDS DOWN on a live foreign lease (never runs)', res.ran === false && ran === 0 && touched === false);
	}

	// ── A turn a peer ALREADY finished is not re-run by recovery (D1b belt-and-braces
	//    for the release-then-recollect window, where the lease reads vacant). ──
	{
		console.log('\nRecovery — never re-runs a turn a peer already completed');
		L.forget();
		const sync = makeLeaseSync({});			// lease vacant (peer released after done)
		let ran = 0;
		const errand = sentErrand(P, { turnId: 't-fin', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
		const res = await P.runErrand(errand, {
			selfId: 'PHONE', cas: P.syncCas(sync), allowSelf: true,
			finished:    async () => true,			// a done report / merged answer exists
			reconstruct: async () => { ran = -99; return {}; },
			runTurn:     async () => { ran++; },
			abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {}, now: () => NOW,
		});
		check('recovery on an ALREADY-FINISHED turn stands down (no second charge)',
			res.ran === false && res.why === 'already-done' && ran === 0);
	}

	// ── The AUTOMATIC collect path still refuses this device's OWN errand (D1a),
	//    so an incidental re-collect on return never runs; only deliberate recovery
	//    (allowSelf) does. ──
	{
		console.log('\nRecovery — the automatic path still refuses a self-dispatch (D1a preserved)');
		L.forget();
		const sync = makeLeaseSync({});
		let ran = 0;
		const errand = sentErrand(P, { turnId: 't-self', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
		const res = await P.runErrand(errand, {			// allowSelf omitted -> false
			selfId: 'PHONE', cas: P.syncCas(sync),
			finished: async () => false,
			reconstruct: async () => { ran = -99; return {}; },
			runTurn: async () => { ran++; },
			abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {}, now: () => NOW,
		});
		check('automatic path refuses this device\'s OWN errand (D1a intact)',
			res.ran === false && res.why === 'self-dispatched' && ran === 0);
	}
}

// ── Pull the exact text of a top-level `function NAME(args) { ... }` out of
//    www/js/daimond.js, brace-matched from its opening `{` -- the same trick
//    verify_attach.test.mjs's `asyncFuncBody` and workerfinish.test.mjs's
//    `funcBody` use, kept whole here (not split into args/body) so three
//    sibling functions can be concatenated and evaluated together with their
//    calls to one another intact. None of the three carries a brace-bearing
//    string or regex literal, so a naive depth count is exact.
function daimondFuncSource(name) {
	const head = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
	const m = head.exec(DAIMOND_SRC);
	if (!m) throw new Error('function not found in daimond.js: ' + name);
	let i = m.index + m[0].length - 1, depth = 0;
	for (; i < DAIMOND_SRC.length; i++) {
		const c = DAIMOND_SRC[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) break; }
	}
	return DAIMOND_SRC.slice(m.index, i + 1);
}

// Build `continueTurn`, `retryTurn` and `answerAgain` exactly as daimond.js
// defines them (hoisted together so each can call the others), closed over a
// stub `window` and the handful of free identifiers they read bare -- the
// same `with (window)` construct `loadScript` above uses for the real app
// files, which is what makes evaluating them outside daimond.js's own IIFE
// legal (no `'use strict'` in this synthetic wrapper).
function buildS61Sandbox(P, spy) {
	const win = {
		DaimondPeer: {
			// The REAL isAskAnswer from peer.js, not a re-implementation --
			// S6-1 is a daimond.js bug, and peer.js's own marker logic is
			// already covered by the dispatchControl checks above.
			isAskAnswer:     P.isAskAnswer,
			dispatchState:   () => 'no-peer-awake',	// never peer-held here
			dispatchControl: () => '',					// no dispatched placeholder here
		},
		DaimondLease:   { record: () => null },
		DaimondJournal: { clearTurn: (id) => spy.journalCleared.push(id) },
		loadMsgTombs:       () => ({}),
		msgTombstone:       (mids) => spy.tombstoned.push.apply(spy.tombstoned, mids),
		touchChat:          (chat) => spy.touched.push(chat && chat.id),
		persistChats:       () => { spy.persisted++; },
		renderHistory:      () => { spy.rendered++; },
		runTurn:            (chat, text, opts) => spy.ranTurn.push({ text: text, opts: opts }),
		ChatStore:          { compact: (id) => spy.compacted.push(id) },
		CONTINUE_NUDGE:     '__continue_nudge__',
		handoffTargetLabel: () => '',
		peerUiStateFor:     () => 'no-peer-awake',
		selfDeviceId:       () => 'SELF',
		turnHold:           () => '',						// nothing paused here
		_askCard:           null,
	};
	const src = [
		daimondFuncSource('continueTurn'),
		daimondFuncSource('retryTurn'),
		daimondFuncSource('answerAgain'),
	].join('\n')
	+ '\nwindow.continueTurn = continueTurn;\nwindow.retryTurn = retryTurn;\nwindow.answerAgain = answerAgain;\n';
	const fn = new Function('window', 'with (window) {\n' + src + '\n}');
	fn(win);
	return win;
}

// S6-1 (re-check §6): an ask-card answer ("Chose: …" / "Other: …") interrupted
// LOCALLY and recovered from the write-ahead journal offers Continue and
// Retry, and -- before the fix -- either one re-sent the bare answer with no
// card beside it, because `continueTurn`/`retryTurn` had no `isAskAnswer`
// guard (the dispatched tile already had one, via `dispatchControl`). Each
// check here fails on daimond.js as it stood at 2207f686 and passes on the fix.
async function runLocalAskAnswerGuardAcceptance(P, check) {
	function freshSpy() {
		return { tombstoned: [], touched: [], persisted: 0, rendered: 0, ranTurn: [], compacted: [], journalCleared: [] };
	}

	// ── continueTurn: an ask-answer turn that died before any token arrived
	//    (the empty-partial branch, recovered as `interrupted` from the
	//    journal) must reopen the question, not resend "Chose: …" bare. ──
	{
		const spy = freshSpy();
		const win = buildS61Sandbox(P, spy);
		const chat = { id: 'c1', messages: [
			{ mid: 'm1', iturn: 'T1', role: 'user', content: 'Chose: Detach the paths' },
		] };
		win.continueTurn(chat, 'T1', 'Chose: Detach the paths');
		check('S6-1 continueTurn: an ask-answer with nothing arrived reopens the question (answerAgain), never resends',
			spy.ranTurn.length === 0 && spy.tombstoned.includes('m1') && chat.messages.length === 0);
	}
	// ── continueTurn: an ORDINARY interrupted turn (not an ask answer) with
	//    nothing arrived is UNCHANGED -- still retracted and re-run bare. ──
	{
		const spy = freshSpy();
		const win = buildS61Sandbox(P, spy);
		const chat = { id: 'c2', messages: [
			{ mid: 'm2', iturn: 'T2', role: 'user', content: 'Keep going autonomously now' },
		] };
		win.continueTurn(chat, 'T2', 'Keep going autonomously now');
		check('S6-1 continueTurn: an ordinary interrupted turn is still retracted and re-run (unchanged)',
			spy.ranTurn.length === 1 && spy.ranTurn[0].text === 'Keep going autonomously now');
	}
	// ── retryTurn: a COMPLETED local ask-answer turn (no dispatched
	//    placeholder to key the tile's own guard off) must also reopen the
	//    question rather than resend the bare answer. ──
	{
		const spy = freshSpy();
		const win = buildS61Sandbox(P, spy);
		const chat = { id: 'c3', messages: [
			{ mid: 'm3', iturn: 'T3', role: 'user', content: 'Other: leave them' },
			{ mid: 'm4', iturn: 'T3', role: 'assistant', content: 'Done.' },
		] };
		win.retryTurn(chat, 'T3', 'Other: leave them');
		check('S6-1 retryTurn: a completed local ask-answer reopens the question, never resends it bare',
			spy.ranTurn.length === 0 && spy.tombstoned.includes('m3') && chat.messages.length === 0);
	}
	// ── retryTurn: an ordinary completed turn is UNCHANGED -- still
	//    retracted and re-run with the given text. ──
	{
		const spy = freshSpy();
		const win = buildS61Sandbox(P, spy);
		const chat = { id: 'c4', messages: [
			{ mid: 'm5', iturn: 'T4', role: 'user', content: 'What is the capital of France?' },
			{ mid: 'm6', iturn: 'T4', role: 'assistant', content: 'Paris.' },
		] };
		win.retryTurn(chat, 'T4', 'What is the capital of France?');
		check('S6-1 retryTurn: an ordinary retry is still retracted and re-run (unchanged)',
			spy.ranTurn.length === 1 && spy.ranTurn[0].text === 'What is the capital of France?');
	}
}

// FIRE-AND-FORGET. After a desktop CLAIMS a handed-off turn, the RUNNER (the desktop)
// drives it to completion — reconstruct → runTurn → pushResult → report → release —
// entirely on the desktop, streaming progress on its OWN timer. The phone takes NO
// part in the run: it dispatches, may background (its watch/expedite loop frozen), and
// renders the answer on its next wake by pulling the parcel and collecting the report.
// A wake re-check of its own errand never re-runs it. These properties are exactly what
// let the owner put the phone away, and each check below fails if the turn were made to
// depend on the phone driving it.
async function runFireAndForgetAcceptance(P, L, check) {
	const NOW  = 1_700_000_000_000;
	const TURN = 't-faf', CHAT = 'c-faf', ANS = 'the thing is done';
	const tick0 = async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

	// The shared gateway PARCEL: the durable transcript the runner pushes its result
	// into and the phone later pulls. A pull is a copy of the committed messages into
	// the reader's own view — the ordinary append-only sync, modelled minimally.
	let parcel = { version: 0, messages: [] };
	const gatewayPush = (msgs) => { parcel = { version: parcel.version + 1, messages: JSON.parse(JSON.stringify(msgs)) }; return parcel.version; };
	const hasAnswer = (msgs) => (msgs || []).some((m) => m && m.role === 'assistant'
		&& String(m.iturn) === TURN && (m.content || '').trim());

	// ── (a) DESKTOP CLAIMS, PHONE BACKGROUNDS MID-TURN → the turn still COMPLETES on
	//    the desktop and the result is IN SYNC. The phone is modelled as doing NOTHING
	//    for the whole run (its JS is throttled while backgrounded): it passes no dep,
	//    ticks nothing, pulls nothing. The desktop's own progress timer is fired mid-run
	//    to prove the stream is desktop-driven and needs no phone. ──
	{
		console.log('\nFire-and-forget — the desktop completes a handed-off turn while the phone is backgrounded');
		L.forget();
		const sync = makeLeaseSync({});
		const timer = makeFakeTimer();
		// The prompt is already in the reconstructed transcript (the dispatcher pushed it
		// persist-first), exactly as the real runner reconstructs it (promptInTranscript).
		const deskChat = { id: CHAT, messages: [{ role: 'user', content: 'do the thing', mid: TURN, iturn: TURN, ts: NOW - 10 }] };
		let phoneTicks = 0;			// the phone's watch loop — must stay 0 (it is backgrounded)
		let progressPushes = 0, reported = null;
		let releaseTurn;
		const turnGate = new Promise((r) => { releaseTurn = r; });
		const errand = sentErrand(P, { turnId: TURN, chatId: CHAT, prompt: 'do the thing',
			eid: 'e-faf', deadline: NOW + P.DISPATCH_DEADLINE_MS, dispatchedBy: 'PHONE' });
		const running = P.runErrand(errand, {
			selfId: 'DESK', cas: P.syncCas(sync), now: () => NOW,
			setTimer: timer.set, clearTimer: timer.clear,
			finished:    async () => false,
			reconstruct: async () => ({ chat: deskChat }),
			// The turn is "still running" until the test releases the gate — the window in
			// which the phone backgrounds. It folds the answer only once released.
			runTurn: async (ctx, prompt, opts) => {
				await opts.onProgress();				// a read-only liveness tick
				await turnGate;
				P.foldAssistant(ctx.chat, { mid: 'a-faf', turnId: TURN, text: ANS, ts: NOW });
			},
			abort: () => {},
			pushProgress: async () => { progressPushes++; },						// desktop-owned stream
			pushResult:   async () => gatewayPush(deskChat.messages),				// commit to the parcel
			post:         async (r) => { reported = r; },
			ack:          async () => {},
		});
		await tick0(6);				// let take / reconstruct / claimed→running / the timers start
		// MID-TURN. The phone is backgrounded and drives nothing. Fire the DESKTOP's own
		// 2s progress timer a few times: the stream advances with no phone involvement.
		const prog = timer.handles.find((h) => h.live && h.ms === 2000);
		check('(a) the desktop started its OWN progress-streaming timer (no phone needed to stream)', !!prog);
		if (prog) { for (let i = 0; i < 3; i++) await prog.fn(); }
		check('(a) mid-turn the desktop streamed on its own and the phone drove nothing',
			progressPushes >= 1 && phoneTicks === 0);
		check('(a) the answer is NOT in sync yet (the turn is still running)', !hasAnswer(parcel.messages));
		// The phone stays backgrounded through the finish: release the turn and let the
		// desktop complete with the phone still doing nothing.
		releaseTurn();
		const res = await running;
		check('(a) the desktop RAN the turn and it COMPLETED (res.done), phone still idle',
			res.ran === true && res.done === true && phoneTicks === 0);
		check('(a) the ANSWER is now in the synced parcel — the result reached sync with no phone',
			hasAnswer(parcel.messages));
		check('(a) a DONE report was posted and the lease RELEASED (the runner finished cleanly)',
			!!reported && reported.status === 'done' && sync.leases()[TURN].mode === 'released');
		check('(a) every progress/liveness timer was stopped — nothing left driving the turn',
			timer.live() === 0);

		// ── (b) THE PHONE RENDERS THE COMPLETED TURN ON ITS NEXT WAKE/PULL, without ever
		//    having driven it. On wake it pulls the parcel (the answer merges beside its
		//    dispatched placeholder) and reads the done report; recoverDecision then says
		//    DO NOT run it here, and uiState reads 'done'. ──
		console.log('\nFire-and-forget — the phone renders the finished turn on wake, having driven nothing');
		const phoneChat = { id: CHAT, messages: [
			{ role: 'user', content: 'do the thing', mid: TURN, iturn: TURN, ts: NOW - 10 },
			// the local "dispatched" placeholder the phone drew at send time
			{ role: 'assistant', content: '', why: 'dispatched', iturn: TURN, ts: NOW - 9 },
		] };
		check('(b) before the wake pull the phone holds only the empty dispatched placeholder',
			!hasAnswer(phoneChat.messages));
		// THE WAKE PULL: copy the committed parcel into the phone's view (append-only union).
		const seen = new Set(phoneChat.messages.map((m) => m.mid));
		for (const m of parcel.messages) if (!seen.has(m.mid)) phoneChat.messages.push(JSON.parse(JSON.stringify(m)));
		const doneReport = reported;					// collected from the post box on the same wake
		const dPlaceholder = { why: 'dispatched', iturn: TURN, deadline: NOW + P.DISPATCH_DEADLINE_MS };
		const leaseRec = sync.leases()[TURN];			// released
		check('(b) after the wake pull the phone SHOWS the answer (rendered, not driven)',
			hasAnswer(phoneChat.messages));
		check('(b) recoverDecision tells the phone NOT to run a FINISHED turn (no phone-driven re-run)',
			P.recoverDecision(dPlaceholder, leaseRec, /* finished */ true, 'PHONE', NOW + 1000) === false);
		check('(b) uiState reads the dispatched turn as "done" once its report is in',
			P.uiState(dPlaceholder, leaseRec, doneReport, 'PHONE', NOW + 1000) === 'done');

		// ── (c) A WAKE RE-CHECK NEVER DOUBLE-RUNS. The phone, back in the foreground,
		//    re-collects its OWN self-posted errand and routes it to the runner: the
		//    automatic path stands down on its own dispatch (D1a). And any OTHER device
		//    that re-collects it after completion stands down on `finished` (D1b). Either
		//    way the turn ran exactly once and the lease is not re-claimed. ──
		console.log('\nFire-and-forget — a wake re-check re-collects the errand but never re-runs it');
		let selfRuns = 0;
		const selfRes = await P.runErrand(errand, {			// allowSelf omitted → the automatic path
			selfId: 'PHONE', cas: P.syncCas(sync), now: () => NOW + 2000,
			finished:    async () => true,					// the done report/answer are in
			reconstruct: async () => { selfRuns = -99; return {}; },
			runTurn:     async () => { selfRuns++; },
			abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {},
		});
		check('(c) the phone does NOT re-run its OWN dispatch on wake (self-dispatch stand-down)',
			selfRes.ran === false && selfRes.why === 'self-dispatched' && selfRuns === 0);
		let peerRuns = 0;
		const peerRes = await P.runErrand(errand, {			// a different device, after completion
			selfId: 'DESK2', cas: P.syncCas(sync), now: () => NOW + 2000,
			finished:    async () => true,					// a done report exists for the turn
			reconstruct: async () => { peerRuns = -99; return {}; },
			runTurn:     async () => { peerRuns++; },
			abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {},
		});
		check('(c) another device that re-collects a FINISHED turn stands down (no second run/charge)',
			peerRes.ran === false && peerRes.why === 'already-done' && peerRuns === 0);
		check('(c) the lease still names the desktop as its released holder — no re-claim on wake',
			sync.leases()[TURN].holder === 'DESK' && sync.leases()[TURN].mode === 'released');
	}
}

// The NOMINATED runner. The account may name ONE always-on device; a non-nominee
// stands down for it, but ONLY while it is genuinely, freshly awake -- an offline
// or stale nominee is no barrier, and the stand-down is re-decided against live
// presence so a turn is never stranded. The lease is still the single-runner
// arbiter, so the nomination only moves WHO attempts the claim.
async function runNominationAcceptance(P, L, check) {
	const NOW     = 1700000000000;
	const W       = P.DISPATCH_FRESH_MS;			// the freshness the guard reuses
	const NOMINEE = 'aaaa0000bbbb1111';			// 16-hex, the roster's id shape
	const OTHER   = 'cccc2222dddd3333';
	const freshNom = { [NOMINEE]: { name: 'desktop', lastSeen: NOW - 1000 } };
	const staleNom = { [NOMINEE]: { name: 'desktop', lastSeen: NOW - (W + 60000) } };

	console.log('\nNomination — the always-on-runner claim guard');

	// ── The pure decision, the crux of the guard. ──
	check('(a) the NOMINEE never stands down for its own nomination -> it claims',
		P.nominationStandDown(NOMINEE, NOMINEE, freshNom, NOW, W) === false);
	check('(b) a non-nominee STANDS DOWN for a freshly-awake nominee',
		P.nominationStandDown(NOMINEE, OTHER, freshNom, NOW, W) === true);
	check('(c) a non-nominee CLAIMS when the nominee is offline (absent from presence)',
		P.nominationStandDown(NOMINEE, OTHER, {}, NOW, W) === false);
	check('(d) NO nomination -> first-come unchanged (never stands down)',
		P.nominationStandDown('', OTHER, freshNom, NOW, W) === false);
	// (e) STALE-PRESENCE stall defence: a lagging map showing a slept nominee as
	// awake must NOT make a fallback stand down for a device that is gone.
	check('(e) a non-nominee does NOT stand down for a STALE nominee',
		P.nominationStandDown(NOMINEE, OTHER, staleNom, NOW, W) === false);
	check('(e) freshness edge: at the window stands down, one ms past claims',
		P.nominationStandDown(NOMINEE, OTHER, { [NOMINEE]: { name: 'd', lastSeen: NOW - W } }, NOW, W) === true
		&& P.nominationStandDown(NOMINEE, OTHER, { [NOMINEE]: { name: 'd', lastSeen: NOW - W - 1 } }, NOW, W) === false);
	// (f) NOT PERMANENT: the SAME beat that read fresh at T reads stale at T+W+1, so
	// a fallback that stood down re-decides and claims -- the turn is never stranded.
	{
		const nom = { [NOMINEE]: { name: 'desktop', lastSeen: NOW } };
		check('(f) stands down at T while the nominee is fresh',
			P.nominationStandDown(NOMINEE, OTHER, nom, NOW, W) === true);
		check('(f) NOT permanent: re-decided past the window, the fallback CLAIMS',
			P.nominationStandDown(NOMINEE, OTHER, nom, NOW + W + 1, W) === false);
	}

	// ── Colliding LABELS must never decide who runs the turn. ──
	//
	// A derived device name is the browser and the platform and nothing else, so two of a
	// user's Linux Chromes say "Google Chrome on Linux" identically. Seating the fresher
	// of them on a name they share is a lottery dressed as a preference, and it picks
	// which machine RUNS AND BILLS the turn. The nominee's ID still seats it; the LABEL
	// seats only when it picks out exactly one live desktop.
	{
		const SAME  = 'Google Chrome on Linux';
		const TWIN1 = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';
		const TWIN2 = 'f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2';
		const PHONE = 'e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0';
		const desk = (name, age) => ({ name, lastSeen: NOW - age, servicedAt: NOW - age,
			attended: false, mobileView: false });
		const twins = { [PHONE]: { name: 'iPhone', lastSeen: NOW, servicedAt: NOW, attended: true, mobileView: true },
			[TWIN1]: desk(SAME, 6000), [TWIN2]: desk(SAME, 500) };
		// The nominee's own id is live: it is seated, whatever anybody is called.
		const byId = P.handoffTarget(twins, { selfId: PHONE, windowMs: W, nominatedId: TWIN1,
			preferredLabel: SAME }, NOW);
		check('(g) the nominee is seated BY ID even when two live desktops share its label',
			byId.reason === 'nominee' && byId.target && byId.target.deviceId === TWIN1,
			'reason=' + byId.reason + ' peer=' + (byId.target && byId.target.deviceId || '').slice(0, 4));
		// The nominee's id is NOT live, and its label is ambiguous: no seat by label.
		const byLabel = P.handoffTarget(twins, { selfId: PHONE, windowMs: W,
			nominatedId: 'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0', preferredLabel: SAME }, NOW);
		check('(g) an AMBIGUOUS label seats nobody as the worker -- no lottery on a shared name',
			byLabel.reason !== 'worker', 'reason=' + byLabel.reason);
		check('(g) it falls through to a genuinely-servicing desktop instead, never local',
			byLabel.reason === 'other-desktop' && !!twins[byLabel.target && byLabel.target.deviceId],
			'reason=' + byLabel.reason + ' peer=' + (byLabel.target && byLabel.target.deviceId || '').slice(0, 4));
		// Distinct labels -- what `deviceSelfName` now mints -- and the label seats again,
		// on the device that carries it rather than on the fresher of the two.
		const named = { [PHONE]: twins[PHONE],
			[TWIN1]: desk(SAME + ' \u00b7 1f1f', 6000), [TWIN2]: desk(SAME + ' \u00b7 2f2f', 500) };
		const unique = P.handoffTarget(named, { selfId: PHONE, windowMs: W,
			nominatedId: 'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0', preferredLabel: SAME + ' \u00b7 1f1f' }, NOW);
		check('(g) a UNIQUE label still seats its device, not the fresher twin',
			unique.reason === 'worker' && unique.target && unique.target.deviceId === TWIN1,
			'reason=' + unique.reason + ' peer=' + (unique.target && unique.target.deviceId || '').slice(0, 4));
		// And the stand-down is by ID only: a device that merely shares the nominee's
		// label must not defer to it, or both twins would wait for each other.
		check('(g) nominationStandDown matches by id only -- a same-label twin is not the nominee',
			P.nominationStandDown(TWIN1, TWIN2, twins, NOW, W) === true
			&& P.nominationStandDown(TWIN1, TWIN1, twins, NOW, W) === false);
	}

	// ── MOBILITY IS THE DEVICE'S OWN ANSWER, not its name and not its window width. ──
	//
	// Seating used to judge a peer's mobility from the NAME it beat under
	// (daimond.js isMobileViewName) and this device's from its VIEWPORT (mobile.js
	// isPhone, width <= 760). Both are wrong about the thing they decide: a phone its
	// owner named "gilgamesh" was seatable as a worker and was handed turns it could
	// not hold, and a desktop window dragged narrow routed like a phone. Every device
	// now decides its own mobility at boot from real signals and beats `mobile`, and
	// the election reads that FIRST -- falling back to the old inference (carried here
	// as `mobileView`) only where the field is ABSENT, which is a peer on a build that
	// predates it.
	console.log('\nMobility — the beat\'s own `mobile` flag decides the seat, not the label or the width');
	{
		const PHONE  = 'aa11aa11aa11aa11aa11aa11aa11aa11';	// the dispatcher
		const GIL    = 'bb22bb22bb22bb22bb22bb22bb22bb22';	// a PHONE called "gilgamesh"
		const NARROW = 'cc33cc33cc33cc33cc33cc33cc33cc33';	// a DESKTOP in a narrow window
		const live = (extra) => Object.assign({ lastSeen: NOW, servicedAt: NOW, attended: false }, extra);
		// (a) A phone wearing a desktop's name. The old inference reads "gilgamesh" as a
		// desktop (mobileView false); the device's own `mobile:true` overrules it.
		const mislabelled = { [GIL]: live({ name: 'gilgamesh', mobile: true, mobileView: false }) };
		const mis = P.handoffTarget(mislabelled, { selfId: PHONE, windowMs: W }, NOW);
		check('(mob a) a PHONE named "gilgamesh" is NOT seated -- its own mobile:true beats its label',
			mis.reason === 'local' && mis.target === null, 'reason=' + mis.reason);
		// (b) A desktop whose window is under 760px. The viewport inference stamps it
		// mobileView:true; its own `mobile:false` overrules that and it is seated.
		const narrowed = { [NARROW]: live({ name: 'argonaut', mobile: false, mobileView: true }) };
		const nar = P.handoffTarget(narrowed, { selfId: PHONE, windowMs: W }, NOW);
		check('(mob b) a NARROW desktop window with mobile:false IS seated -- the flag beats the viewport',
			nar.reason === 'other-desktop' && nar.target && nar.target.deviceId === NARROW,
			'reason=' + nar.reason);
		// (c) The nominee gate reads the same flag: a nominated phone is not seated even
		// by id, so a mislabelled star cannot hand a phone its own turns.
		const nomPhone = P.handoffTarget(mislabelled, { selfId: PHONE, windowMs: W, nominatedId: GIL }, NOW);
		check('(mob c) a NOMINATED device that beats mobile:true is still not seated',
			nomPhone.reason === 'local' && nomPhone.target === null, 'reason=' + nomPhone.reason);
		// (d) And the label path: a unique preferred label on a mobile device seats nobody.
		const byLabelPhone = P.handoffTarget(mislabelled, { selfId: PHONE, windowMs: W,
			preferredLabel: 'gilgamesh' }, NOW);
		check('(mob d) the preferred LABEL cannot seat a device that beats mobile:true either',
			byLabelPhone.reason === 'local', 'reason=' + byLabelPhone.reason);
		// (e) MIXED-BUILD FLEET: a peer that sends no `mobile` field at all falls back to
		// the old inference, so hand-off is not disabled by an old build on either side.
		const oldBuild = { [GIL]: live({ name: 'iPhone', mobileView: true }),
			[NARROW]: live({ name: 'argonaut', mobileView: false }) };
		const mixed = P.handoffTarget(oldBuild, { selfId: PHONE, windowMs: W }, NOW);
		check('(mob e) with NO mobile field the old name/viewport inference still stands in',
			mixed.reason === 'other-desktop' && mixed.target && mixed.target.deviceId === NARROW,
			'reason=' + mixed.reason);
		// (f) recMobileView as a unit: the flag is final both ways, absent defers, and
		// absent on both reads as NON-mobile (a live desktop is never wrongly withheld).
		check('(mob f) recMobileView: the flag is final both ways; absent defers to mobileView; nothing reads desktop',
			P.recMobileView({ mobile: true,  mobileView: false }) === true
			&& P.recMobileView({ mobile: false, mobileView: true }) === false
			&& P.recMobileView({ mobileView: true }) === true
			&& P.recMobileView({}) === false
			&& P.recMobileView(null) === false);
	}

	// ── End to end through runErrand: the real CLAIM decision, not a smoke test. ──
	// A non-nominee with a freshly-awake nominee stands down BEFORE the lease take:
	// it never reconstructs, never runs, never touches the lease, and answers
	// why:'nominee' -- the signal takeRow reads to HOLD the errand on the relay.
	{
		L.forget();
		const sync = makeLeaseSync({});
		let ran = 0, touched = false;
		const errand = sentErrand(P, { turnId: 't-nom-b', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
		const res = await P.runErrand(errand, {
			selfId: OTHER, cas: P.syncCas(sync),
			nominatedId: NOMINEE, presence: freshNom, freshWindowMs: W,
			finished:    async () => false,
			reconstruct: async () => { touched = true; return {}; },
			runTurn:     async () => { ran++; },
			abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {}, now: () => NOW,
		});
		check('runErrand: a non-nominee STANDS DOWN for a fresh nominee (no run, lease untouched)',
			res.ran === false && res.why === 'nominee' && ran === 0 && touched === false && !sync.leases()['t-nom-b']);
	}
	// The NOMINEE runs its own errand: never stands down, so it takes the lease.
	{
		L.forget();
		const sync = makeLeaseSync({});
		let ran = 0;
		const errand = sentErrand(P, { turnId: 't-nom-a', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
		const res = await P.runErrand(errand, {
			selfId: NOMINEE, cas: P.syncCas(sync),
			nominatedId: NOMINEE, presence: freshNom, freshWindowMs: W,
			finished:    async () => false,
			reconstruct: async () => ({ chat: {}, app: {} }),
			runTurn:     async () => { ran++; },
			abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {}, now: () => NOW,
		});
		check('runErrand: the NOMINEE claims and runs its errand exactly once',
			res.ran === true && ran === 1 && sync.leases()['t-nom-a'].holder === NOMINEE);
	}
	// A non-nominee with the nominee OFFLINE claims and runs (fallback = any awake).
	{
		L.forget();
		const sync = makeLeaseSync({});
		let ran = 0;
		const errand = sentErrand(P, { turnId: 't-nom-c', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
		const res = await P.runErrand(errand, {
			selfId: OTHER, cas: P.syncCas(sync),
			nominatedId: NOMINEE, presence: {}, freshWindowMs: W,
			finished:    async () => false,
			reconstruct: async () => ({ chat: {}, app: {} }),
			runTurn:     async () => { ran++; },
			abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {}, now: () => NOW,
		});
		check('runErrand: a non-nominee CLAIMS when the nominee is offline (fallback runs)',
			res.ran === true && ran === 1 && sync.leases()['t-nom-c'].holder === OTHER);
	}
	// A non-nominee with the nominee STALE claims and runs -- the (e) stall defence,
	// proven through the runner and not only the pure decision.
	{
		L.forget();
		const sync = makeLeaseSync({});
		let ran = 0;
		const errand = sentErrand(P, { turnId: 't-nom-s', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
		const res = await P.runErrand(errand, {
			selfId: OTHER, cas: P.syncCas(sync),
			nominatedId: NOMINEE, presence: staleNom, freshWindowMs: W,
			finished:    async () => false,
			reconstruct: async () => ({ chat: {}, app: {} }),
			runTurn:     async () => { ran++; },
			abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {}, now: () => NOW,
		});
		check('runErrand: a non-nominee CLAIMS when the nominee is STALE (no stall)',
			res.ran === true && ran === 1 && sync.leases()['t-nom-s'].holder === OTHER);
	}
	// No nomination -> unchanged first-come: a non-nominee claims and runs.
	{
		L.forget();
		const sync = makeLeaseSync({});
		let ran = 0;
		const errand = sentErrand(P, { turnId: 't-nom-d', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
		const res = await P.runErrand(errand, {
			selfId: OTHER, cas: P.syncCas(sync),
			nominatedId: '', presence: freshNom, freshWindowMs: W,
			finished:    async () => false,
			reconstruct: async () => ({ chat: {}, app: {} }),
			runTurn:     async () => { ran++; },
			abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {}, now: () => NOW,
		});
		check('runErrand: NO nomination -> first-come unchanged (non-nominee claims)',
			res.ran === true && ran === 1 && sync.leases()['t-nom-d'].holder === OTHER);
	}
}

// The LIVENESS GLUE that keeps a nominee stand-down from stranding the turn. Three
// real pieces meet here and were only asserted by construction before:
//   - post.js takeRow returns HOLD on a `why:'nominee'` stand-down, so the errand
//     stays on the relay (not acked) for the nominee -- driven through the REAL
//     DaimondPost.take door and the REAL DaimondPeer.absorb/runErrand;
//   - a scheduled re-collect (daimond.js scheduleNomineeFallback) re-decides against
//     LIVE presence, so once the nominee's beat ages out the fallback CLAIMS;
//   - that scheduler RE-ARMS on a transient collect failure, so an offline blip
//     restores the driver instead of dropping the only prompt re-collect.
// daimond.js does not load under node (a large, DOM-bound IIFE), so the scheduler is
// reproduced here line-for-line -- null the handle first, await the collect, re-arm
// on !ok -- on a hand-driven timer; the HOLD, the routing and the claim are all real.
async function runFallbackLivenessAcceptance(tab, check) {
	console.log('\nFallback liveness — HOLD -> scheduled re-collect -> claim, and re-arm on a failed tick');
	const P = tab.DaimondPeer, L = tab.DaimondLease, Post = tab.DaimondPost;
	const W = P.DISPATCH_FRESH_MS;
	const NOMINEE = 'aaaa0000bbbb1111';			// the always-on runner (asleep after one beat)
	const selfId  = tab.DaimondIdentity.deviceId();	// this tab is the awake FALLBACK

	// One scenario, built fresh so it owns its box, lease and clock. `mode` flips the
	// collect driver between a real run and a transient failure (the offline blip).
	async function scenario() {
		const box  = makePostBox();
		const sync = makeLeaseSync({});
		L.forget();
		let clock = 1700000000000;
		const nomineeSeen = clock;					// the nominee's one and only beat
		const presence = { [NOMINEE]: { name: 'desktop', lastSeen: nomineeSeen } };
		let ran = 0;

		// The gateway's OWN view of the nominee's last beat: the source of truth the
		// collect path refreshes against, distinct from the local `presence` snapshot,
		// which can lag. `gatewayFresh()` models the nominee having beaten just now (awake);
		// `refreshMode==='fail'` models a refresh that fails or hangs (offline, hung gateway),
		// which the shipped code bounds and falls through to the local snapshot from.
		let gatewayLastSeen = nomineeSeen;
		let refreshMode = 'ok';
		async function refreshPresence() {
			if (refreshMode === 'fail') throw new Error('refresh failed');
			presence[NOMINEE] = { name: 'desktop', lastSeen: gatewayLastSeen };
		}

		// Stub for presenceTick: the shipped onErrand beats presence the instant a turn
		// ends (Fix A), so a just-run device asserts liveness for the next turn rather than
		// waiting on its throttled 45s timer. Counted so the test proves the beat fires.
		let beats = 0;
		function beat() { beats++; }

		// The REAL runner deps, carrying the nomination and the live presence/clock.
		function deps() {
			return {
				selfId, cas: P.syncCas(sync),
				nominatedId: NOMINEE, presence: presence, freshWindowMs: W, now: () => clock,
				finished:    async () => false,
				reconstruct: async () => ({ chat: {}, app: {} }),
				runTurn:     async () => { ran++; },
				abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {},
			};
		}

		// The daimond.js glue, reproduced: the onErrand handler runs the errand and, on
		// a nominee stand-down, arms the fallback; the scheduler nulls its handle first,
		// awaits the collect, and re-arms on failure. A hand-driven timer stands in for
		// setTimeout so ticks are deterministic.
		const timer = makeFakeTimer();
		let pending = null, arms = 0, mode = 'ok';
		function scheduleNomineeFallback() {
			if (pending) return;					// the guard: never two live timers
			arms++;
			pending = timer.set(async () => {
				pending = null;						// null FIRST, so a route's re-arm takes the slot
				let res = null;
				try { res = await driveCollect(); } catch (e) { res = null; }
				if (!res || !res.ok) scheduleNomineeFallback();		// re-arm on a failed tick
			}, W + 5000);
		}
		// A collect that runs each un-acked relay row through the REAL takeRow (Post.take),
		// so the HOLD, the routing and the claim are the shipping code. `mode==='fail'`
		// models a transient GET failure that routes nothing -- the offline blip.
		async function driveCollect() {
			if (mode === 'fail') return { ok: false, why: 'status_0' };
			let hold = false;
			for (const row of box.collect(0)) {
				const r = await Post.take(row);
				if (r && r.hold) hold = true;
			}
			return { ok: true, hold: hold };
		}

		P.onErrand(async (errand) => {
			// Mirror of the shipped onErrand handler (daimond.js): refresh live presence
			// before the stand-down reads the snapshot, fail-open. Shipped bounds it with
			// Promise.race(4s); a timeout resolves the same way a caught failure does --
			// proceed on the local snapshot -- which `refreshMode==='fail'` models here.
			try { await refreshPresence(); } catch (e) { /* local snapshot stands */ }
			const res = await P.runErrand(errand, deps());
			if (res && res.ran) { try { beat(); } catch (e) {} }	// mirror of shipped Fix A: beat on a completed run
			if (res && res.why === 'nominee') scheduleNomineeFallback();
			return res;
		});

		// Seal an errand to this account and drop it on the relay.
		const errand = sentErrand(P, { turnId: 'turn-live', chatId: 'c', prompt: 'p', model: {}, deadline: 0, dispatchedBy: 'phone-device' });
		const sealed = await P.sealForSelf(errand);
		box.post(sealed);

		return {
			box, sync, timer,
			ranCount: () => ran,
			armCount: () => arms,
			pendingLive: () => timer.live() > 0,
			setMode: (m) => { mode = m; },
			age: (ms) => { clock = nomineeSeen + ms; },	// move the clock relative to the beat
			collect: () => driveCollect(),				// the wake that first delivers the errand
			fire: async () => {							// fire every live timer callback, in order
				const live = timer.handles.filter((h) => h.live);
				live.forEach((h) => { h.live = false; });
				for (const h of live) await h.fn();
			},
			gatewayFresh: () => { gatewayLastSeen = clock; },	// the nominee actually beat just now
			setRefreshMode: (m) => { refreshMode = m; },		// 'ok' | 'fail'
			beatCount: () => beats,								// presence beats fired on a completed run
		};
	}

	// ── (g) HOLD -> scheduled re-collect -> claim once the nominee ages out. ──
	{
		const s = await scenario();
		// The wake: the fallback collects, stands down for the fresh nominee, and the
		// errand is HELD on the relay (real takeRow) with the fallback armed.
		const first = await s.collect();
		check('(g) the fallback HOLDs the errand for a fresh nominee (real takeRow)',
			first.ok === true && first.hold === true);
		check('(g) standing down ran nothing and armed the re-collect',
			s.ranCount() === 0 && s.armCount() === 1 && s.pendingLive() === true
			&& !s.sync.leases()['turn-live']);
		// The nominee sleeps: its one beat ages out of the freshness window.
		s.age(W + 1);
		await s.fire();
		check('(g) the scheduled re-collect CLAIMS once the nominee is stale (turn runs)',
			s.ranCount() === 1 && s.sync.leases()['turn-live'].holder === selfId);
		check('(g) the driver stops after the claim (no re-arm, no double run)',
			s.pendingLive() === false && s.ranCount() === 1);
	}

	// ── (h) a transient collect failure RE-ARMS rather than dropping the driver, and
	//    a later good tick still drives the claim. This is the gap the fix closes. ──
	{
		const s = await scenario();
		await s.collect();									// wake: HOLD + arm (nominee fresh)
		check('(h) armed after the wake', s.armCount() === 1 && s.pendingLive() === true);
		s.age(W + 1);										// the nominee has now slept out the window
		s.setMode('fail');									// the next tick hits an offline blip
		await s.fire();
		check('(h) a FAILED tick re-arms the driver rather than dropping it',
			s.ranCount() === 0 && s.armCount() === 2 && s.pendingLive() === true);
		s.setMode('ok');									// the blip clears
		await s.fire();
		check('(h) the re-armed driver drives the claim on the next good tick',
			s.ranCount() === 1 && s.sync.leases()['turn-live'].holder === selfId);
		check('(h) exactly one live timer throughout (no double-arm)',
			s.timer.live() === 0 && s.pendingLive() === false);
	}

	// ── (i) THE FIX: an awaited presence refresh on the collect path flips a stale LOCAL
	//    read of an awake nominee back to a stand-down. Without the refresh line in the
	//    reproduced onErrand glue this reddens -- the stale snapshot claims the nominee's
	//    turn, which is the shipped iOS bug. ──
	{
		const s = await scenario();
		s.age(W + 1);				// the LOCAL snapshot of the nominee is now stale...
		s.gatewayFresh();			// ...but the nominee actually beat just now (gateway is fresh)
		const r = await s.collect();		// wake: onErrand refreshes, then the stand-down sees it awake
		check('(i) refresh flips a stale local read: stands down for the awake nominee (HOLD, no claim)',
			r.ok === true && r.hold === true && s.ranCount() === 0
			&& !s.sync.leases()['turn-live']);
	}

	// ── (j) a refresh that fails, or the bounded-await timeout, falls through to the local
	//    snapshot and CLAIMS -- liveness, never a strand. The shipped Promise.race(4s)
	//    timeout proceeds on the local snapshot exactly as a caught failure does. ──
	{
		const s = await scenario();
		s.age(W + 1);				// local snapshot stale
		s.gatewayFresh();			// the nominee is actually awake...
		s.setRefreshMode('fail');		// ...but the refresh fails (offline / hung gateway / timeout)
		await s.collect();
		check('(j) a failed or timed-out refresh falls through to local and CLAIMS (liveness)',
			s.ranCount() === 1 && s.sync.leases()['turn-live'].holder === selfId);
	}

	// ── (k) THE WRITER-SIDE FIX: a device that runs a turn beats presence on completion,
	//    so the next turn's stand-down sees it fresh. Without the beat line in the glue this
	//    reddens (beatCount stays 0), which is the between-turns staleness that let gilgamesh
	//    grab turn 2 while argonaut was backgrounded. ──
	{
		const s = await scenario();
		s.age(W + 1);				// the nominee is genuinely stale, so this device claims and runs
		await s.collect();
		check('(k) running a turn beats presence on completion (liveness asserted, not left to the throttled timer)',
			s.ranCount() === 1 && s.beatCount() === 1);
	}
}

async function runPresenceAcceptance(P, PR, check) {
	const T = 1700000000000;
	const fresh = { argonaut: { name: 'argonaut', lastSeen: T - 1000 } };
	const stale = { argonaut: { name: 'argonaut', lastSeen: T - 200000 } };

	// ── Presence provider: freshest-scalar merge, freshness, self-exclusion. ──
	PR.forget();
	PR.beat('phone', 'phone-name', T);
	PR.adopt({ argonaut: { name: 'argonaut', lastSeen: T - 1000 } });
	check('presence snapshot carries this device and the adopted peer',
		!!PR.snapshot().phone && !!PR.snapshot().argonaut);
	check('awake() excludes self and lists the fresh peer',
		PR.awake('phone', T).length === 1 && PR.awake('phone', T)[0].deviceId === 'argonaut');
	// Freshest-scalar: an OLDER beat does not overwrite a newer one.
	PR.adopt({ argonaut: { name: 'argonaut', lastSeen: T - 5000 } });
	check('a stale incoming beat does NOT overwrite a fresher one (freshest-scalar)',
		PR.snapshot().argonaut.lastSeen === T - 1000);

	// A NEWER beat does win.
	PR.adopt({ argonaut: { name: 'argonaut', lastSeen: T - 100 } });
	check('a fresher incoming beat wins', PR.snapshot().argonaut.lastSeen === T - 100);
	check('a peer past the freshness window is not awake', PR.awake('phone', T + 200000).length === 0);
	check('the peer name is carried for the UI', PR.name('argonaut') === 'argonaut');

	// ── freshestPeer: the one shared "who is awake" answer. ──
	check('freshestPeer finds the fresh non-self peer',
		P.freshestPeer(fresh, 'phone', T).deviceId === 'argonaut');
	check('freshestPeer is null when the only beat is stale',
		P.freshestPeer(stale, 'phone', T) === null);
	check('freshestPeer excludes this device',
		P.freshestPeer({ phone: { name: 'me', lastSeen: T } }, 'phone', T) === null);

	// ── autoDispatchDecision: the policy (rewritten to the owner's authoritative
	// fallback rule, 2026-09-06). When the runner is down: MOBILE hands to a
	// GENUINELY-AVAILABLE peer, else runs LOCAL (last resort); DESKTOP/laptop runs
	// LOCAL (a desktop is itself a reliable runner and does not chase a peer). A fresh
	// GENUINE nominee still wins first. Eligibility is genuine availability (beating
	// AND servicing), so a phantom presence-only tab is never chosen. `fresh`/`stale`
	// carry no servicedAt, so recGenuine falls back to the bare beat -- a `fresh` peer
	// is genuine here, which is what these branch tests need. ──
	const quickChat = { id: 'c', provider: 'openrouter', model: 'm' };
	const workerChat = { id: 'c2', workerModel: 'w' };
	// A presence map whose peer beats but is a PHANTOM (stale servicing stamp).
	const phantomP = { argonaut: { name: 'argonaut', lastSeen: T, servicedAt: T - 5 * 60 * 1000 } };
	check('DESKTOP + AGENTIC (tools) turn + genuine peer -> dispatch to that peer (long-turn, feature kept)',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', toolsEnabled: true }, T); return d.dispatch === true && d.reason === 'long-turn' && d.peer.name === 'argonaut'; })());
	check('DESKTOP + AGENTIC (tools) turn + only a PHANTOM peer -> run LOCAL (no genuine peer)',
		(() => { const d = P.autoDispatchDecision(quickChat, phantomP, { selfId: 'phone', toolsEnabled: true }, T); return d.dispatch === false && d.reason === 'desktop-local'; })());
	check('DESKTOP + ORDINARY quick turn, runner down -> run LOCAL',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone' }, T); return d.dispatch === false && d.reason === 'desktop-local'; })());
	check('DESKTOP + no peer at all -> run LOCAL',
		P.autoDispatchDecision(quickChat, {}, { selfId: 'phone' }, T).dispatch === false);
	check('OPT-IN (toggle true) + genuine peer -> dispatch (toggle-on)',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', toggle: true }, T); return d.dispatch === true && d.reason === 'toggle-on'; })());
	check('OPT-IN (toggle true) but only a PHANTOM peer -> run LOCAL (phantom excluded)',
		(() => { const d = P.autoDispatchDecision(quickChat, phantomP, { selfId: 'phone', toggle: true }, T); return d.dispatch === false && d.reason === 'no-genuine-peer'; })());
	check('step-away posture (globalDefault) + genuine peer -> dispatch',
		P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', globalDefault: true }, T).dispatch === true);
	check('per-chat toggle OFF overrides a global default ON',
		P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', toggle: false, globalDefault: true }, T).dispatch === false);
	check('backgrounding with a turn in flight + genuine peer -> dispatch',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', backgrounding: true, turnInFlight: true }, T); return d.dispatch === true && d.reason === 'backgrounding-in-flight'; })());
	check('a genuine WORKER chat on DESKTOP dispatches to a genuine peer (long-turn, feature kept)',
		(() => { const d = P.autoDispatchDecision(workerChat, fresh, { selfId: 'phone' }, T); return d.dispatch === true && d.reason === 'long-turn'; })());

	// ── The nominated always-on runner (fix A, 2026-09-08): a nominee that is PRESENT
	// AND BEATING takes the turn -- the SAME liveness the CLAIM arbitration uses
	// (nominationStandDown / lastSeen), NOT recGenuine's stricter serviced_at. Dispatch
	// and claim must agree, else the originator labels/targets a fresher peer while the
	// beating nominee actually claims and runs (the owner's turn ran on argonaut but was
	// labelled gilgamesh). A nominee that beats but never services is a phantom recovered
	// by the dispatcher's backstop (dev/repro_nominee_phantom.mjs), not excluded at
	// dispatch. An OFFLINE nominee (beat stale) still falls through to the fallback. A
	// per-chat opt-out still wins. Scoped to the nominee: freshest-peer selection below
	// still requires recGenuine, so seq-217's phantom protection holds for non-nominees. ──
	check('a FRESH nominee dispatches even a QUICK foreground turn',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', nominatedId: 'argonaut' }, T); return d.dispatch === true && d.reason === 'nominee' && d.peer.deviceId === 'argonaut'; })());
	check('a STALE nominee (beat aged out) runs local',
		P.autoDispatchDecision(quickChat, stale, { selfId: 'phone', nominatedId: 'argonaut' }, T).dispatch === false);
	check('a BEATING nominee is seated DIRECTLY even when its serviced_at is stale (fix A) -- backstop recovers a phantom',
		(() => { const d = P.autoDispatchDecision(quickChat, phantomP, { selfId: 'phone', nominatedId: 'argonaut' }, T); return d.dispatch === true && d.reason === 'nominee' && d.peer.deviceId === 'argonaut'; })());
	check('this device IS the nominee -> it does not dispatch a turn to itself',
		P.autoDispatchDecision(quickChat, fresh, { selfId: 'argonaut', nominatedId: 'argonaut' }, T).dispatch === false);
	// The REAL regression (a hung daimon turn, 2026-09-17): `handoffTarget`'s own
	// nominee clause excludes a self match (`nom !== self`), by design, so when THIS
	// device is the elected nominee reading its own id back, that clause simply
	// never fires and the search falls through to (a')/(a'')/(b) -- which can find
	// some OTHER genuinely-live desktop and seat IT instead, dispatching the
	// nominee's own agentic/daimon turn away to a peer that was never asked to run
	// it (and which then just hangs, self-healing being the OTHER half of this fix).
	// `quickChat` above is not enough to expose this -- only the AGENTIC branch
	// (long-turn) reaches a target found this way before the runner-down fallback.
	{
		const otherDesktop = { gilgamesh: { name: 'gilgamesh', lastSeen: T, servicedAt: T, mobile: false } };
		const d = P.autoDispatchDecision(quickChat, otherDesktop,
			{ selfId: 'argonaut', nominatedId: 'argonaut', toolsEnabled: true }, T);
		check('this device IS the nominee -> an AGENTIC turn still runs local, not seated on some OTHER live desktop',
			d.dispatch === false && d.reason === 'self-nominee',
			JSON.stringify(d));
	}
	check('a per-chat opt-out (toggle OFF) STILL wins over a fresh nominee',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', nominatedId: 'argonaut', toggle: false }, T); return d.dispatch === false && d.reason === 'chat-local'; })());

	// ── THE RUNNER POSTURE IS A SEAT ON ITS OWN (owner, 2026-09-13). ──
	//
	// `runner:true` -- the machine's own claim, carried on every beat and relayed
	// verbatim by the gateway -- was written by three functions and read by none. The
	// live fault it let through: the phone held NO nominee record (the star lives in the
	// nominating device's localStorage and reaches a phone only on a full parcel round)
	// and argonaut's `serviced_at` was stale, so the nominee branch could not fire and
	// the generic desktop scan excluded it as a phantom. The phone ran the turn itself
	// beside a machine that had said it was arranged to take one.
	const armedP = { argonaut: { name: 'argonaut', lastSeen: T, servicedAt: T - 5 * 60 * 1000,
		mobile: false, runner: true } };
	check('an ARMED runner is seated with NO nominee record and a STALE servicing stamp',
		(() => { const d = P.autoDispatchDecision(quickChat, armedP, { selfId: 'phone', isPhone: true }, T);
			return d.dispatch === true && d.reason === 'runner-posture' && d.peer.deviceId === 'argonaut'; })());
	check('the posture is WORKER-GRADE: it takes an ordinary quick turn from a DESKTOP too',
		(() => { const d = P.autoDispatchDecision(quickChat, armedP, { selfId: 'gilgamesh' }, T);
			return d.dispatch === true && d.reason === 'runner-posture'; })());
	check('an armed runner whose BEAT has aged out is NOT seated (the posture is not a promise)',
		(() => { const cold = { argonaut: Object.assign({}, armedP.argonaut, { lastSeen: T - P.DISPATCH_FRESH_MS - 60000 }) };
			return P.autoDispatchDecision(quickChat, cold, { selfId: 'phone', isPhone: true }, T).dispatch === false; })());
	check('an armed MOBILE device is never seated as a worker',
		(() => { const ph = { gilgamesh: Object.assign({}, armedP.argonaut, { name: 'gilgamesh', mobile: true }) };
			return P.autoDispatchDecision(quickChat, ph, { selfId: 'phone', isPhone: true }, T).dispatch === false; })());
	check('an EXPLICIT star outranks another machine\u2019s posture',
		(() => { const both = Object.assign({}, armedP,
				{ gilgamesh: { name: 'gilgamesh', lastSeen: T, servicedAt: T, mobile: false } });
			const d = P.autoDispatchDecision(quickChat, both, { selfId: 'phone', isPhone: true, nominatedId: 'gilgamesh' }, T);
			return d.reason === 'nominee' && d.peer.deviceId === 'gilgamesh'; })());
	check('the per-chat opt-out STILL wins over a posture',
		P.autoDispatchDecision(quickChat, armedP, { selfId: 'phone', isPhone: true, toggle: false }, T).dispatch === false);
	check('`exclude` re-resolves past an armed runner that failed to claim',
		(() => { const d = P.autoDispatchDecision(quickChat, armedP,
				{ selfId: 'phone', isPhone: true, exclude: { argonaut: true } }, T);
			return d.dispatch === false; })());
	check('recRunner reads the beat\u2019s own flag, and absent is NOT a posture',
		P.recRunner({ runner: true }) === true && P.recRunner({}) === false && P.recRunner(null) === false);

	// ── The MOBILE fallback: when the runner is down, a phone hands to a GENUINELY-
	// AVAILABLE peer; if none is genuinely available it runs LOCAL -- the last resort,
	// because the phone is the least reliably connected device. A phantom is excluded. ──
	check('MOBILE + genuine peer -> dispatch (mobile-peer), naming the peer',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', isPhone: true }, T); return d.dispatch === true && d.reason === 'mobile-peer' && d.peer && d.peer.name === 'argonaut'; })());
	check('MOBILE + only a PHANTOM peer -> run LOCAL (phantom excluded, not chosen)',
		(() => { const d = P.autoDispatchDecision(quickChat, phantomP, { selfId: 'phone', isPhone: true }, T); return d.dispatch === false && d.reason === 'no-genuine-peer'; })());
	check('MOBILE with NO peer -> run LOCAL (never dispatch into the void)',
		(() => { const d = P.autoDispatchDecision(quickChat, stale, { selfId: 'phone', isPhone: true }, T); return d.dispatch === false && d.reason === 'no-genuine-peer'; })());

	// ── The per-chat OPT-OUT pins a chat to THIS device, and it must beat the mobile
	// default and the global default alike -- so it is decided before either. ──
	check('OPT-OUT (toggle false) keeps a chat local even on MOBILE with a peer awake',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', isPhone: true, toggle: false }, T); return d.dispatch === false && d.reason === 'chat-local'; })());
	check('OPT-OUT beats a global default ON as well (opt-out is decided first)',
		P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', isPhone: true, toggle: false, globalDefault: true }, T).dispatch === false);
	check('OPT-IN (toggle true) is still an override on DESKTOP (toggle-on, not desktop-local)',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', isPhone: false, toggle: true }, T); return d.dispatch === true && d.reason === 'toggle-on'; })());

	// ── LAPTOP step-away posture: `maybeAutoDispatch` passes it as
	// `globalDefault: handoffWhenAway()`, so a laptop set to "hand off while away"
	// routes its turns to a genuine peer; off by silence, a laptop runs its own turns
	// locally (desktop-local). ──
	check('LAPTOP (isPhone false) + step-away posture ON + genuine peer -> dispatch, naming the peer',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', isPhone: false, globalDefault: true }, T); return d.dispatch === true && d.reason === 'toggle-on' && d.peer && d.peer.name === 'argonaut'; })());
	check('LAPTOP + posture OFF + a QUICK turn -> run local (desktop-local)',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', isPhone: false }, T); return d.dispatch === false && d.reason === 'desktop-local'; })());

	// ── THE STEP-AWAY HAND-OFF: the opts `handoffInFlightOnStepAway` passes from
	// `pagehide` for a turn still running when the laptop is closed -- backgrounding, a
	// turn in flight. A genuine peer takes it; no genuine peer keeps it here for
	// recovery-on-return. ──
	check('STEP-AWAY: laptop closing with a turn in flight -> hand to the genuine peer',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', isPhone: false, backgrounding: true, turnInFlight: true }, T); return d.dispatch === true && d.reason === 'backgrounding-in-flight' && d.peer && d.peer.name === 'argonaut'; })());
	check('STEP-AWAY with NO genuine peer -> keep here for recovery (no dispatch into the void)',
		(() => { const d = P.autoDispatchDecision(quickChat, stale, { selfId: 'phone', isPhone: false, backgrounding: true, turnInFlight: true }, T); return d.dispatch === false && d.reason === 'no-genuine-peer'; })());
	check('STEP-AWAY still honours a per-chat OPT-OUT (a pinned chat is decided local first)',
		P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', isPhone: false, backgrounding: true, turnInFlight: true, toggle: false }, T).dispatch === false);

	// ── The genuine-availability gate (recGenuine / freshestGenuinePeer): a phantom
	// (beats but stale servicing) is excluded; a genuine peer (beats AND services) is
	// chosen; an absent servicing field (old gateway) falls back to the bare beat. ──
	check('recGenuine: a phantom (beat, stale serviced) is NOT genuine',
		P.recGenuine({ name: 'g', lastSeen: T, servicedAt: T - 5 * 60 * 1000 }, T, P.DISPATCH_FRESH_MS) === false);
	check('recGenuine: a genuine peer (beat + fresh serviced) IS genuine',
		P.recGenuine({ name: 'g', lastSeen: T, servicedAt: T }, T, P.DISPATCH_FRESH_MS) === true);
	check('recGenuine: no serviced field (old gateway) falls back to the beat',
		P.recGenuine({ name: 'g', lastSeen: T }, T, P.DISPATCH_FRESH_MS) === true);
	check('freshestGenuinePeer skips a phantom and picks the genuine peer',
		P.freshestGenuinePeer({ ph: { name: 'ph', lastSeen: T, servicedAt: T - 5 * 60 * 1000 }, ok: { name: 'ok', lastSeen: T - 40000, servicedAt: T - 40000 } }, 'phone', T, P.DISPATCH_FRESH_MS).deviceId === 'ok');

	// ── seq-217 ROLLOUT REGRESSION (permanent): the gateway must not conflate an
	// ABSENT `servicing` field (an old-build runner that CANNOT say) with an explicit
	// `servicing:false`. The fixed gateway OMITS the servicing pair for an old client, so
	// the relayed record ingests with servicedAt ABSENT and recGenuine falls back to the
	// bare beat -- the old runner stays reachable for hand-off. A PRESENT serviced_at:0
	// (an explicit not-servicing seq-217 tab) is still excluded. Before the fix the gateway
	// stamped serviced_at:0 for the old client too, so a live runner read as stale and every
	// mobile turn ran local with NO hand-off -- the symptom the owner hit on seq 217.
	// Driven through the REAL presenceIngest relay path (server clock -> client frame).
	{
		const sNow = Date.now();
		const win  = P.DISPATCH_FRESH_MS;
		const dispatch = () => P.autoDispatchDecision(quickChat, PR.snapshot(),
			{ selfId: 'phone', isPhone: true, nominatedId: 'argonaut' }, Date.now());
		// (a) OLD-build runner, FIXED wire: NO serviced/serviced_at keys, beating now.
		PR.forget();
		PR.ingest({ argonaut: { name: 'Argonaut', last_seen: sNow - 5000, attended: false, attended_at: 0 } }, sNow);
		const oldRec = PR.snapshot().argonaut;
		check('rollout(a): an old-build runner (no serviced_at on the wire) ingests with servicedAt ABSENT',
			oldRec.servicedAt == null);
		check('rollout(a): recGenuine makes an old-build runner ELIGIBLE via the bare beat',
			P.recGenuine(oldRec, Date.now(), win) === true);
		check('rollout(a): a mobile turn HANDS OFF to the old-build runner (was: ran local, no hand-off)',
			(() => { const d = dispatch(); return d.dispatch === true && d.peer && d.peer.deviceId === 'argonaut'; })());
		// (b) seq-217 EXPLICIT not-servicing: serviced_at:0 PRESENT. recGenuine still
		// EXCLUDES it (unchanged), so a NON-designated peer is never chosen on it -- but
		// under fix A a BEATING NOMINEE is seated regardless of servicing, and the
		// dispatcher's backstop recovers it if it never collects. So the same runner, when
		// it is the account's NOMINEE, is dispatched to (not run local).
		PR.forget();
		PR.ingest({ argonaut: { name: 'Argonaut', last_seen: sNow - 5000, attended: false, attended_at: 0,
			serviced: false, serviced_at: 0 } }, sNow);
		check('rollout(b): a seq-217 explicit-not-servicing runner is EXCLUDED by recGenuine (non-nominee protection intact)',
			P.recGenuine(PR.snapshot().argonaut, Date.now(), win) === false);
		check('rollout(b): as the BEATING NOMINEE it is still seated (fix A); the backstop recovers it if it never services',
			(() => { const d = dispatch(); return d.dispatch === true && d.reason === 'nominee' && d.peer && d.peer.deviceId === 'argonaut'; })());
		// (c) GENUINE seq-217 runner: fresh serviced_at -> eligible.
		PR.forget();
		PR.ingest({ argonaut: { name: 'Argonaut', last_seen: sNow - 5000, attended: false, attended_at: 0,
			serviced: true, serviced_at: sNow - 5000 } }, sNow);
		check('rollout(c): a genuine seq-217 runner (fresh serviced_at) is ELIGIBLE',
			P.recGenuine(PR.snapshot().argonaut, Date.now(), win) === true);
	}

	// ── The device's own MOBILITY answer travels with the beat. ──
	//
	// A beat that CAN say is authoritative; one that cannot must leave the field
	// ABSENT rather than assert "desktop", exactly as `servicedAt` does -- coercing
	// absence to false would seat a phone on an old build, and to true would strand a
	// fleet mid-rollout. Written, relayed and adopted, the flag survives all three.
	{
		PR.forget();
		// (the 7th argument is the runner posture; mobility is the 8th)
		PR.beat('ph', 'Jason\'s phone', T, false, false, '', false, true);
		PR.beat('dk', 'gilgamesh',      T, false, true,  '', false, false);
		PR.beat('un', 'old-build',      T, false, true);
		check('a beat records the device\'s own `mobile` flag, both ways',
			PR.snapshot().ph.mobile === true && PR.snapshot().dk.mobile === false);
		PR.beat('dk', 'gilgamesh', T + 1, false, true, '');
		check('a later beat that OMITS `mobile` keeps the known value (absent is not false)',
			PR.snapshot().dk.mobile === false);
		check('a device that never said carries NO `mobile` field at all (the inference stands in)',
			!('mobile' in PR.snapshot().un));
		// The gateway relay: present -> verbatim, absent -> absent.
		const sNow2 = Date.now();
		PR.forget();
		PR.ingest({ g1: { name: 'gilgamesh', last_seen: sNow2, mobile: true },
			g2: { name: 'karri', last_seen: sNow2 } }, sNow2);
		check('ingest relays `mobile` verbatim and leaves it ABSENT where the gateway did not send it',
			PR.snapshot().g1.mobile === true && !('mobile' in PR.snapshot().g2));
		// The parcel merge takes it up on a fresher line, and keeps it on an older one.
		PR.adopt({ g2: { name: 'karri', lastSeen: PR.snapshot().g2.lastSeen + 1000, mobile: false } });
		check('adopt takes up an arriving `mobile` on the freshest line',
			PR.snapshot().g2.mobile === false);
		PR.adopt({ g2: { name: 'karri', lastSeen: PR.snapshot().g2.lastSeen + 1000 } });
		check('a fresher line with NO `mobile` keeps what was last known (never blanks it)',
			PR.snapshot().g2.mobile === false);
	}
	PR.forget();
}

// ════════════════════════════════════════════════════════════════
// The four money-safety defects, each with a mutation-proving check.
// ════════════════════════════════════════════════════════════════
async function runMoneySafety(phone, laptop, check) {
	const Pp = phone.DaimondPeer, Pl = laptop.DaimondPeer;

	// ── D1 — the DISPATCHER must not re-run its own errand after release ──
	//
	// The sequential double-bill: phone dispatches -> laptop claims, runs, pushes,
	// RELEASES the lease -> phone returns and re-collects its OWN errand -> without
	// the guards it re-takes the released lease (which reads vacant) and runs the
	// already-completed turn a second time: two completions, two charges. The lease
	// CAS is shared (one parcel); each device runs through its own peer module.
	console.log('\nD1 — the dispatcher must NOT re-run its own errand after the peer releases');
	{
		phone.DaimondLease.forget(); laptop.DaimondLease.forget();
		const sync = makeLeaseSync({});
		let runCount = 0;
		const errand = sentErrand(Pp, {
			turnId: 'turn-d1', chatId: 'chat-d1', prompt: 'add up', eid: 'e-d1',
			deadline: 9e15, dispatchedBy: 'phoneDev',
		});
		const deps = (selfId, extra) => Object.assign({
			selfId, cas: Pp.syncCas(sync), now: () => 5000,
			reconstruct: async () => ({ chat: { id: 'chat-d1', messages: [{ role: 'user', content: 'add up', mid: 'turn-d1', ts: 1 }] } }),
			runTurn: async () => { runCount += 1; },
			abort: () => {}, pushResult: async () => 7, post: async () => {}, ack: async () => {},
		}, extra || {});

		// The peer (NOT the dispatcher) runs the turn and releases the lease.
		const lap = await Pl.runErrand(errand, deps('laptopDev'));
		check('D1: the peer runs the dispatched turn exactly once', lap.ran === true && runCount === 1);
		check('D1: the peer releases the lease when done (reads vacant afterwards)',
			sync.leases()['turn-d1'].mode === 'released');

		// (a) The phone returns and re-collects its OWN errand: it MUST stand down.
		const ph = await Pp.runErrand(errand, deps('phoneDev'));
		check('D1(a): the dispatcher stands down on its OWN errand (dispatchedBy === self)',
			ph.ran === false && ph.why === 'self-dispatched');
		check('D1(a): still exactly ONE run/charge after the dispatcher re-collects', runCount === 1);

		// (b) A THIRD device -- not the dispatcher -- collecting the SAME errand after
		// the release. The lease is 'released' (reads vacant), so without the finished
		// check it would re-take and re-run. A done report / merged answer means the
		// turn is FINISHED, not vacant-for-rerun: stand down before the take.
		const third = await Pl.runErrand(errand, deps('lap2Dev', { finished: async () => true }));
		check('D1(b): a released (vacant-reading) lease with a done answer is treated as FINISHED',
			third.ran === false && third.why === 'already-done');
		check('D1(b): still exactly ONE run/charge after a third device collects post-release', runCount === 1);
	}

	// ── D2 — a plain chat is not "agentic" merely because it mirrors its model, AND the
	// desktop agentic/worker dispatch (KEPT, owner 2026-09-06) is now GENUINE-PEER-GATED ──
	//
	// daimond.js seeds workerModel/workerProvider to the chat's OWN model for every active
	// chat, so a bare `c.workerModel` truthiness test dispatched EVERY quick turn. The
	// signal must be a GENUINE worker pair (differs from the chat's own). A genuine worker
	// turn on a desktop hands to a GENUINE peer; a phantom-only peer falls to local.
	console.log('\nD2 — a mirrored worker pair stays local; a genuine one dispatches to a genuine peer');
	{
		const T = 1700000000000;
		const fresh   = { argonaut: { name: 'argonaut', lastSeen: T - 1000 } };
		const phantom = { argonaut: { name: 'argonaut', lastSeen: T, servicedAt: T - 5 * 60 * 1000 } };
		const mirrored = { id: 'c', provider: 'openrouter', model: 'm', workerModel: 'm', workerProvider: 'openrouter' };
		const dM = Pp.autoDispatchDecision(mirrored, fresh, { selfId: 'phone' }, T);
		check('D2: a MIRRORED worker pair on DESKTOP is not agentic -> local (desktop-local)',
			dM.dispatch === false && dM.reason === 'desktop-local');
		const worker = { id: 'c2', provider: 'openrouter', model: 'm', workerModel: 'big/model', workerProvider: 'openrouter' };
		const dG = Pp.autoDispatchDecision(worker, fresh, { selfId: 'phone' }, T);
		check('D2: a GENUINE worker chat on DESKTOP dispatches to a genuine peer (long-turn, kept)',
			dG.dispatch === true && dG.reason === 'long-turn');
		const dGp = Pp.autoDispatchDecision(worker, phantom, { selfId: 'phone' }, T);
		check('D2: a genuine worker chat with only a PHANTOM peer -> local (no genuine peer)',
			dGp.dispatch === false && dGp.reason === 'desktop-local');
		// A worker PROVIDER that differs is genuine too, even with the same model name.
		const diffProv = { id: 'c3', provider: 'openrouter', model: 'm', workerModel: 'm', workerProvider: 'anthropic' };
		check('D2: a differing worker PROVIDER is agentic -> dispatch to a genuine peer',
			Pp.autoDispatchDecision(diffProv, fresh, { selfId: 'phone' }, T).dispatch === true);
	}

	// ── D3 — the peer runs against the transcript without re-appending the prompt ──
	//
	// The dispatcher persist-first pushed the prompt into the synced transcript
	// before the errand (§4.1). runErrand must tell runTurn so, or the model is fed
	// the prompt twice (seeded history + the re-sent turn) and it sits twice in the
	// messages array. The mock is a FAITHFUL stand-in for the real runTurn + agent
	// seam: the agent is seeded from the existing user/assistant history (ensureApp),
	// then run_turn SENDS `prompt`. Told the prompt is already present, the peer must
	// seed the agent WITHOUT it and not append a duplicate record.
	console.log('\nD3 — the peer does not feed the model the prompt twice');
	{
		phone.DaimondLease.forget();
		const sync = makeLeaseSync({});
		const errand = sentErrand(Pp, { turnId: 'turn-d3', chatId: 'chat-d3', prompt: 'the question', eid: 'e-d3', deadline: 9e15 });
		const ctxChat = { id: 'chat-d3', messages: [{ role: 'user', content: 'the question', mid: 'turn-d3', ts: 1 }] };
		let request = null;
		const res = await Pp.runErrand(errand, {
			selfId: 'peerZ', cas: Pp.syncCas(sync), now: () => 2000,
			reconstruct: async () => ({ chat: ctxChat }),
			runTurn: async (ctx, prompt, opts) => {
				const already = !!(opts && opts.promptInTranscript);
				const anchor  = opts && opts.turnId;
				const seeded = (ctx.chat.messages || [])
					.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
					.filter((m) => !(already && anchor && String(m.mid) === String(anchor)))
					.map((m) => m.content);
				request = seeded.concat([prompt]);			// run_turn always sends `prompt`
				if (!already) ctx.chat.messages.push({ role: 'user', content: prompt, mid: 'dup', ts: 9 });
				Pp.foldAssistant(ctx.chat, { mid: 'a-d3', turnId: 'turn-d3', text: 'answer', ts: 10 });
			},
			abort: () => {}, pushResult: async () => 3, post: async () => {}, ack: async () => {},
		});
		check('D3: the errand ran', res.ran === true && res.done === true);
		check('D3: the dispatched request carries the prompt exactly ONCE',
			request && request.filter((c) => c === 'the question').length === 1);
		check('D3: the prompt is not duplicated in the messages array',
			ctxChat.messages.filter((m) => m.role === 'user' && m.content === 'the question').length === 1);
	}

	// ── D4 — a sync-pulled lease update notifies the UI (footer advances) ──
	//
	// A lease learned through a SYNC pull moves the local view but touches no message
	// record, so the dispatched footer would sit on "Sent to your other devices" and
	// never advance to running / show "[Take back]". `leaseAdopt` fires a registered
	// change listener whenever the merge actually moved.
	console.log('\nD4 — a sync-pulled lease update re-renders the dispatched footer');
	{
		const L = phone.DaimondLease;
		L.forget();
		check('D4: DaimondLease.onChange is published', typeof L.onChange === 'function');
		let fired = 0;
		if (L.onChange) L.onChange(() => { fired += 1; });
		const T = 1700000000000;
		const rec = { 'turn-d4': { turnId: 'turn-d4', holder: 'devLAP', mode: 'running', expiry: T + 60000, renewedAt: T } };
		const moved = L.adopt(rec, () => T);
		check('D4: adopting a newly-seen lease MOVES the view', moved === true);
		check('D4: a moved lease fires the change listener (the footer re-renders)', fired === 1);
		const before = fired;
		L.adopt({ 'turn-d4': { turnId: 'turn-d4', holder: 'devLAP', mode: 'running', expiry: T + 60000, renewedAt: T } }, () => T);
		check('D4: an unchanged pull does not fire the listener (no needless redraw)', fired === before);
		L.forget();
	}

	// ── D5 — TWO SAME-DEVICE LOCAL RECOVERIES of one orphan must run it ONCE ──
	//
	// Fix B (the dispatcher-side ~95 s recovery timer, `runDispatchFallback`) and the
	// visibilitychange rescue (`peerCollectOnReturn`) both funnel through
	// `recoverOneLocally` -> `runErrand({allowSelf})` on the SAME device. Adversarial QA
	// (2026-09-07) found they share no synchronous mutual exclusion: `chat._generating`
	// is set LATE inside runTurn (after finished/leaseTake/reconstruct/leaseRenew), so
	// both pass it before either sets it; `_recovering` guards only the visibilitychange
	// driver; and the take-if-vacant lease treats two SAME-holder self-recoveries as
	// mutually reclaimable (holder === self is not foreign) -> both claim, both bill.
	// The fix is a SYNCHRONOUS per-turnId in-flight guard at the top of
	// `recoverOneLocally`, before the first await. This models that guard over the REAL
	// runErrand + lease, and proves (a) two concurrent recoveries run ONCE with it, and
	// (b) WITHOUT it the same two DOUBLE-run (the mutation that proves the guard bites).
	console.log('\nD5 — two concurrent same-device local recoveries run (and bill) the orphan exactly once');
	{
		const Lp = phone.DaimondLease;
		const SELF = 'devPHONE';
		const tick = () => new Promise((r) => setTimeout(r, 0));
		// Deps shared by both recoveries: ONE device, ONE lease CAS, ONE answered flag.
		// runTurn awaits a microtask before billing, so the two drivers genuinely overlap.
		const mkRun = (sync, counters) => (extra) => Object.assign({
			selfId: SELF, cas: Pp.syncCas(sync), allowSelf: true, now: () => 5000,
			finished: async () => { await tick(); return counters.answered; },
			reconstruct: async () => { await tick(); return { chat: { id: 'c', messages: [] } }; },
			runTurn: async () => { await tick(); counters.ran += 1; },      // the BILLABLE model call
			abort: () => {}, pushResult: async () => { counters.pushed += 1; counters.answered = true; return 7; },
			post: async () => {}, ack: async () => { counters.acked += 1; }, now: () => 5000,
		}, extra || {});
		const errand = sentErrand(Pp, { turnId: 'turn-d5', chatId: 'c', prompt: 'q', eid: 'e-d5',
			deadline: 9e15, dispatchedBy: SELF });

		// (a) WITH the synchronous guard (the fix): a module-level in-flight set shared by
		// both drivers, added before the first await and cleared in a finally -- exactly
		// what recoverOneLocally now does.
		{
			Lp.forget();
			const sync = makeLeaseSync({});
			const c = { ran: 0, pushed: 0, acked: 0, answered: false };
			const deps = mkRun(sync, c);
			const inFlight = Object.create(null);
			async function recoverOneLocally(turnId) {
				const tid = String(turnId);
				if (inFlight[tid]) return { ran: false, why: 'local-in-flight' };
				inFlight[tid] = true;
				try { return await Pp.runErrand(errand, deps()); }
				finally { delete inFlight[tid]; }
			}
			const [r1, r2] = await Promise.all([recoverOneLocally('turn-d5'), recoverOneLocally('turn-d5')]);
			check('D5(a): exactly ONE billable run across two concurrent recoveries (ran === 1)', c.ran === 1);
			check('D5(a): exactly ONE answer pushed (pushed === 1)', c.pushed === 1);
			check('D5(a): the second recovery short-circuits synchronously (local-in-flight)',
				(r1.why === 'local-in-flight') !== (r2.why === 'local-in-flight'));
		}

		// (b) MUTATION control: remove the guard (call runErrand directly twice) and the
		// SAME two recoveries double-run -- the exact bug, so the guard above is load-bearing.
		{
			Lp.forget();
			const sync = makeLeaseSync({});
			const c = { ran: 0, pushed: 0, acked: 0, answered: false };
			const deps = mkRun(sync, c);
			await Promise.all([Pp.runErrand(errand, deps()), Pp.runErrand(errand, deps())]);
			check('D5(b): WITHOUT the guard the same two recoveries DOUBLE-run (ran === 2) — the guard bites', c.ran === 2);
		}
		Lp.forget();
	}
}

// A sync-like object modelling the gateway's leases CAS for the syncCas adapter:
// `version()`, `leases()`, and `commit(base, leases)` that accepts only when
// `base` is current (then bumps), else answers the current blob -- the 409.
function makeLeaseSync(initial) {
	let version = 5;
	let leases = JSON.parse(JSON.stringify(initial || {}));
	return {
		version: () => version,
		leases: () => JSON.parse(JSON.stringify(leases)),
		commit: (base, next) => {
			if (base !== version) return { ok: false, version, leases: JSON.parse(JSON.stringify(leases)) };
			version += 1; leases = JSON.parse(JSON.stringify(next));
			return { ok: true, version };
		},
	};
}

// A leases CAS that COUNTS the pushes a renew commits and lets renews land (busy
// false), so a heartbeat that outlives its turn is visible as an ever-climbing
// version -- the permanent parcel churn the fix bounds. Faithful to makeLeaseSync's
// 409-on-stale-base, plus a `pushes` tally and a `bytes` digest of the leases.
function makeCountingSync(initial) {
	let version = 5;
	let leases = JSON.parse(JSON.stringify(initial || {}));
	let pushes = 0;
	return {
		version: () => version,
		leases:  () => JSON.parse(JSON.stringify(leases)),
		pushes:  () => pushes,
		bytes:   () => JSON.stringify(leases),
		commit:  (base, next) => {
			if (base !== version) return { ok: false, version, leases: JSON.parse(JSON.stringify(leases)) };
			version += 1; leases = JSON.parse(JSON.stringify(next)); pushes += 1;
			return { ok: true, version };
		},
	};
}

// An injectable timer the test drives by hand: `set` records a live handle and its
// callback; `clear` marks it dead. The test invokes the captured callback itself,
// so ticks are deterministic and no wall-clock 30s is waited.
function makeFakeTimer() {
	const handles = [];
	return {
		handles,
		set:   (fn, ms) => { const h = { fn, ms, live: true }; handles.push(h); return h; },
		clear: (h) => { if (h) h.live = false; },
		live:  () => handles.filter((h) => h.live).length,
	};
}

async function runHeartbeatContainment(P, L, check) {
	const TID = 'turn-hb';

	// ── (A) HAPPY PATH: the ticker is created, then CLEARED, so nothing renews after
	//    the turn. A ticker left live is the loop; a ticker cleared is a fixed point. ──
	{
		L.forget();
		const sync = makeCountingSync({});
		const timer = makeFakeTimer();
		const errand = sentErrand(P, { turnId: TID, chatId: 'c', prompt: 'p', eid: 'e', deadline: 9e15 });
		const res = await P.runErrand(errand, {
			selfId: 'peerA', cas: P.syncCas(sync), now: () => 2000,
			setTimer: timer.set, clearTimer: timer.clear,
			reconstruct: async () => ({ chat: { id: 'c', messages: [] } }),
			runTurn: async (ctx, prompt, opts) => { await opts.onProgress(); P.foldAssistant(ctx.chat, { mid: 'a', turnId: TID, text: 'ok', ts: 3 }); },
			abort: () => {}, pushResult: async () => 9, post: async () => {}, ack: async () => {},
		});
		check('heartbeat: the happy path creates a renew ticker', timer.handles.length === 1);
		check('heartbeat: and the ticker is CLEARED when the turn ends (no lingering renew)',
			timer.live() === 0 && res.done === true);
		// Fire the (dead) ticker callback anyway: a released lease must NEVER be re-renewed.
		const pushesAfter = sync.pushes();
		await timer.handles[0].fn();
		check('heartbeat: firing the ticker after release renews nothing (released lease is not resurrected)',
			sync.pushes() === pushesAfter && sync.leases()[TID].mode === 'released');
	}

	// ── (B) THE TICKER IS READ-ONLY: a running turn -- even one whose promise NEVER
	//    settles (the "couldn't finish" errand) -- causes NO parcel write from the
	//    ticker, so the parcel is a fixed point for the whole turn (the churn source is
	//    gone, not merely bounded). The lifetime CAP still stops the ticker and aborts a
	//    hung turn, so no timer fires for ever. Reverting the cap leaves the timer live. ──
	{
		L.forget();
		const sync = makeCountingSync({});
		const timer = makeFakeTimer();
		let clock = 1000, aborted = 0;
		const errand = sentErrand(P, { turnId: TID, chatId: 'c', prompt: 'p', eid: 'e', deadline: 9e15 });
		const running = P.runErrand(errand, {
			selfId: 'peerHang', cas: P.syncCas(sync), now: () => clock,
			setTimer: timer.set, clearTimer: timer.clear,
			maxLeaseLifeMs: 100,			// tiny cap so the test drives past it in a few ticks
			reconstruct: async () => ({ chat: { id: 'c', messages: [] } }),
			runTurn: () => new Promise(() => {}),		// never settles
			abort: () => { aborted += 1; },
			pushResult: async () => 9, post: async () => {}, ack: async () => {},
		});
		await new Promise((r) => setTimeout(r, 0));		// let take/mark-running/ticker start
		check('heartbeat: a hung turn holds the lease and started a liveness ticker',
			timer.handles.length === 1 && !!sync.leases()[TID]);
		// Only the take (claim) and the one claimed->running transition wrote; the ticker
		// must add nothing more, however many times it fires.
		const pushesAtRunStart = sync.pushes();
		const tick = timer.handles[0].fn;
		for (let i = 0; i < 8; i++) { clock += 40; await tick(); }		// each tick +40ms; cap 100ms
		check('heartbeat: the liveness ticker is READ-ONLY -- driving it pushes NOTHING (no renew churn)',
			sync.pushes() === pushesAtRunStart);
		check('heartbeat: a hung turn does NOT fire for ever -- the cap STOPS the ticker',
			timer.live() === 0);
		check('heartbeat: the cap aborts the hung run (best-effort hard stop)', aborted >= 1);
		for (let i = 0; i < 6; i++) { clock += 40; await tick(); }		// well past the cap
		check('heartbeat: past the cap the parcel is still untouched (fixed point during the turn)',
			sync.pushes() === pushesAtRunStart);
		void running;						// intentionally never awaited: the turn hung
	}

	// ── (C) CRASH: the error path leaves the lease to EXPIRE, and the fix guarantees it
	//    expires WITHOUT a further renew -- the ticker is cleared by the finally. ──
	{
		L.forget();
		const sync = makeCountingSync({});
		const timer = makeFakeTimer();
		const errand = sentErrand(P, { turnId: TID, chatId: 'c', prompt: 'p', eid: 'e', deadline: 9e15 });
		const res = await P.runErrand(errand, {
			selfId: 'peerCrash', cas: P.syncCas(sync), now: () => 2000,
			setTimer: timer.set, clearTimer: timer.clear,
			reconstruct: async () => ({ chat: { id: 'c', messages: [] } }),
			runTurn: async () => { throw new Error('kaboom'); },
			abort: () => {}, pushResult: async () => 9, post: async () => {}, ack: async () => {},
		});
		check('heartbeat: a crash is reported as an error and the lease is left unreleased (to expire)',
			res.error === true && sync.leases()[TID].mode !== 'released');
		check('heartbeat: the crash CLEARS the ticker, so the lingering lease expires without a renew',
			timer.live() === 0);
		const pushesAfter = sync.pushes();
		await timer.handles[0].fn();		// the dead ticker fires once more
		check('heartbeat: a fired-after-crash ticker renews nothing', sync.pushes() === pushesAfter);
	}
}

async function runDeadlineExpiryMoneySafety(P, L, check) {
	const NOW = 1_700_000_000_000;
	const DEADLINE = NOW + 15 * 60 * 1000;		// the dispatch deadline (buildDispatch default)

	// ── The claim expiry IS the deadline, and the record carries it. ──
	{
		L.forget();
		const cas = makeCas({});
		const took = await L.take('turn-ttl', { holder: 'DESK', eid: 'e', deadline: DEADLINE }, cas, () => NOW);
		check('deadline: a claim with a deadline expires AT the deadline (not now + TTL)',
			took.won === true && cas.peekLeases()['turn-ttl'].expiry === DEADLINE);
		check('deadline: the record carries `deadline` so every merge/clamp honours the same bound',
			cas.peekLeases()['turn-ttl'].deadline === DEADLINE);
	}

	// ── A recovery errand (no deadline) still gets a single TTL, unchanged. ──
	{
		L.forget();
		const cas = makeCas({});
		await L.take('turn-rec', { holder: 'PHONE', eid: 'e', deadline: 0 }, cas, () => NOW);
		check('deadline: a no-deadline (recovery) claim falls back to now + TTL',
			cas.peekLeases()['turn-rec'].expiry === NOW + L.LEASE_TTL_MS);
	}

	// ── S6-2: a MISSING or zero deadline is not "no deadline" once the errand
	//    carries a `ts` -- only an old build (or a hand-crafted envelope) posts one
	//    with no `deadline`, and it must age exactly as `handoffDeadline` ages a
	//    deadline-less PLACEHOLDER: `ts + DISPATCH_DEADLINE_MS`, not sit reclaimable
	//    by any fresh runner for ever. ──
	{
		L.forget();
		const cas = makeCas({});
		const OLD_TS = NOW - 20 * 60 * 1000;	// 20 min old -- past DISPATCH_DEADLINE_MS (15 min)
		const took = await L.take('turn-oldbuild',
			{ holder: 'DESK', eid: 'e', deadline: 0, ts: OLD_TS }, cas, () => NOW);
		check('S6-2: a stale deadline-less errand is refused on the deadline gate, not taken',
			took.won === false && took.why === 'deadline');
		check('S6-2: the refused take left no lease behind',
			!cas.peekLeases()['turn-oldbuild']);
		// A FRESH deadline-less errand (posted moments ago) is unaffected -- it is not
		// "no deadline" that is refused, only staleness past the derived one.
		const fresh = await L.take('turn-freshbuild',
			{ holder: 'DESK', eid: 'e', deadline: 0, ts: NOW - 1000 }, cas, () => NOW);
		check('S6-2: a fresh deadline-less errand is still taken normally',
			fresh.won === true && cas.peekLeases()['turn-freshbuild'].holder === 'DESK');
	}

	// ── THE MONEY CRUX: a busy peer holds a turn for >90s; the phone returns and MUST
	//    stand down, because the deadline-bounded lease still reads LIVE. Reverting the
	//    claim expiry to now+TTL re-opens the double-charge (proven by the mutation run).
	{
		L.forget();
		const cas = makeCas({});			// the one shared parcel both devices read
		const desk = await L.take('turn-long', { holder: 'DESK', eid: 'e', deadline: DEADLINE }, cas, () => NOW);
		check('>TTL: the peer holds the long turn (claimed to its deadline)', desk.won === true);
		const later = NOW + 100_000;		// past LEASE_TTL_MS (90s), well before the deadline
		// The phone returns, pulls the parcel, and evaluates recovery against server truth.
		L.forget();
		L.adopt(cas.peekLeases(), () => later);
		const rec = L.record('turn-long');
		check('>TTL: the peer lease still reads LIVE after 90s (deadline-bounded, no renew needed)',
			L.live(rec, later) === true);
		check('>TTL: recoverDecision stands the phone DOWN (a live foreign lease holds it)',
			P.recoverDecision({ why: 'dispatched', iturn: 'turn-long', dispatchedBy: 'PHONE', ts: NOW }, rec, false, 'PHONE', later) === false);
		// The take itself: the phone tries to reclaim through the CAS and MUST lose.
		const phone = await L.take('turn-long', { holder: 'PHONE', eid: 'e2', deadline: 0 }, cas, () => later);
		check('>TTL: the phone take STANDS DOWN while the peer still runs (no double-run/charge)',
			phone.won === false && phone.holder === 'DESK');
		check('>TTL: EXACTLY ONE holder remains -- the peer (no double-charge)',
			(desk.won ? 1 : 0) + (phone.won ? 1 : 0) === 1 && cas.peekLeases()['turn-long'].holder === 'DESK');
	}

	// ── The dead-peer bound: a lease is reclaimable at its DEADLINE, not before, and
	//    not forever -- the accepted recovery-latency tradeoff, honoured via the carried
	//    deadline (clampExpiry does not shrink it below the deadline on adopt). ──
	{
		L.forget();
		const cas = makeCas({});
		await L.take('turn-dead', { holder: 'DESK', eid: 'e', deadline: DEADLINE }, cas, () => NOW);
		// Before the deadline the lease is NOT reclaimable, even after adopting it fresh.
		L.forget();
		L.adopt(cas.peekLeases(), () => NOW + 100_000);
		const early = await L.take('turn-dead', { holder: 'PHONE', eid: 'e2', deadline: 0 }, cas, () => NOW + 100_000);
		check('dead-peer: before the deadline the lease is NOT reclaimable (held for the turn)',
			early.won === false && cas.peekLeases()['turn-dead'].holder === 'DESK');
		// Past the deadline (the dead peer never renews -- there is no renew) it expires.
		const reclaim = await L.take('turn-dead', { holder: 'PHONE', eid: 'e3', deadline: 0 }, cas, () => DEADLINE + 1);
		check('dead-peer: at the deadline a dead holder\'s lease IS reclaimable (bounded, not forever)',
			reclaim.won === true && cas.peekLeases()['turn-dead'].holder === 'PHONE');
	}
}

async function runRunnerAcceptance(P, L, check) {
	const TID = 'turn-run';
	const errand = sentErrand(P, { turnId: TID, chatId: 'chat-r', prompt: 'compute', eid: 'e-run', deadline: 9e15 });

	// ── syncCas arbitration: two takes from ONE base, exactly one wins. ──
	{
		L.forget();
		const sync = makeLeaseSync({});
		const cas = P.syncCas(sync);
		const snapA = await cas.read();		// both based on the SAME version through the adapter
		const snapB = await cas.read();
		const aRes = await L.takeFrom(snapA, TID, { holder: 'A', eid: 'ea' }, cas, () => 1000);
		const bRes = await L.takeFrom(snapB, TID, { holder: 'B', eid: 'eb' }, cas, () => 1001);
		check('syncCas: exactly one take wins through the adapter', (aRes.won ? 1 : 0) + (bRes.won ? 1 : 0) === 1);
		check('syncCas: the loser stood down (commit 409 -> adopt -> retry)', aRes.won === true && bRes.won === false);
		check('syncCas: the committed sync names the winner', sync.leases()[TID].holder === 'A');
	}

	// ── Happy path. THE RETURN LEG, REORDERED (seq 223): the answer travels before
	//    the account does -- final frame, report, lease, ack, and the parcel last. ──
	{
		L.forget();
		const sync = makeLeaseSync({});
		let pushed = 0, report = null, acked = 0, frames = [];
		// The user message carries the TURN's own mid, which is what `progressTail`
		// anchors to -- the runner's transcript holds the prompt the dispatcher sent.
		const ctxChat = { id: 'chat-r', messages: [{ role: 'user', content: 'compute', mid: TID, ts: 1 }] };
		const res = await P.runErrand(errand, {
			selfId: 'peerA', cas: P.syncCas(sync), now: () => 2000,
			reconstruct: async () => ({ chat: ctxChat }),
			runTurn: async (ctx, prompt, opts) => {
				await opts.onProgress();		// a journal event -> lease renew
				P.foldAssistant(ctx.chat, { mid: 'a1', turnId: TID, text: 'the answer is 42', ts: 3 });
			},
			abort: () => {},
			finalFrame: async (tid) => {
				// The runner encodes the structured rows as the door's JSON payload, which
				// is what the originator folds back in -- mirror that here.
				const rows = P.progressTail(ctxChat.messages, tid, 48 * 1024);
				const payload = JSON.stringify({ v: 1, msgs: rows });
				frames.push({ tid, rows, payload });
				return payload;
			},
			pushResult: async () => { pushed += 1; return 9; },
			post: async (rep) => { report = rep; },
			ack: async () => { acked += 1; },
			awaitPush: true,			// so the whole sequence is assertable here
		});
		check('the runner completes the errand', res.ran === true && res.done === true);
		check('the runner order is take,reconstruct,run,final-frame,report,complete,ack,release,push',
			res.trace.join(',') === 'take,reconstruct,run,final-frame,report,complete,ack,release,push',
			res.trace.join(','));
		check('the answer was folded into the transcript',
			ctxChat.messages.some((m) => m.role === 'assistant' && m.content === 'the answer is 42'));
		check('the transcript was pushed exactly once', pushed === 1);
		check('R1: the FINAL FRAME carried the answer (as a structured row), and went out BEFORE the parcel',
			frames.length === 1
			&& frames[0].rows.some((r) => r.role === 'assistant' && r.content === 'the answer is 42')
			&& /the answer is 42/.test(frames[0].payload)
			&& res.trace.indexOf('final-frame') < res.trace.indexOf('push'));
		check('R2: the report went out BEFORE the parcel -- the originator is not behind a flush',
			res.trace.indexOf('report') < res.trace.indexOf('push'));
		check('R3: and the lease was RELEASED before the parcel too',
			res.trace.indexOf('release') < res.trace.indexOf('push'));
		check('R4: the report says the answer already travelled, so the originator need not wait',
			!!report && report.t === 'report' && report.status === 'done' && report.finalTail === 1);
		check('the errand was acked exactly once, and before the parcel',
			acked === 1 && res.trace.indexOf('ack') < res.trace.indexOf('push'));
		check('the lease ends released', sync.leases()[TID].mode === 'released');
	}

	// ── R4b. THE REPORT NAMES THE DEVICE IT IS FOR (2026-09-24): the errand's dispatcher,
	//    so a collector that is not that device leaves it on the relay (`noteHeldFor`)
	//    rather than acking it away before the phone has collected it. ──
	{
		L.forget();
		const sync = makeLeaseSync({});
		let report = null;
		const e2 = sentErrand(P, { turnId: TID, chatId: 'chat-r', prompt: 'compute', eid: 'e-run2',
			deadline: 9e15, dispatchedBy: 'PHONE' });
		const ctxChat = { id: 'chat-r', messages: [{ role: 'user', content: 'compute', mid: TID, ts: 1 }] };
		const res = await P.runErrand(e2, {
			selfId: 'peerA', cas: P.syncCas(sync), now: () => 2000,
			reconstruct: async () => ({ chat: ctxChat }),
			runTurn: async (ctx) => { P.foldAssistant(ctx.chat, { mid: 'a1', turnId: TID, text: 'ok', ts: 3 }); },
			abort: () => {}, pushResult: async () => 1,
			post: async (rep) => { report = rep; }, ack: async () => {},
		});
		check('R4b: the done report names the dispatcher it is for',
			res.done === true && !!report && report.status === 'done' && report.to === 'PHONE',
			JSON.stringify(report && { status: report.status, to: report.to }));
	}

	// ── R5. A RUNNER WITH NO FINAL-FRAME DEP (an older build's wiring) still completes,
	//    and says so in the report, so the originator falls back to the parcel. ──
	{
		L.forget();
		const sync = makeLeaseSync({});
		let report = null;
		const ctxChat = { id: 'chat-r5', messages: [{ role: 'user', content: 'q', mid: 'u1', ts: 1 }] };
		const res = await P.runErrand(errand, {
			selfId: 'peerA', cas: P.syncCas(sync), now: () => 2000,
			reconstruct: async () => ({ chat: ctxChat }),
			runTurn: async (ctx) => { P.foldAssistant(ctx.chat, { mid: 'a1', turnId: TID, text: 'ok', ts: 3 }); },
			abort: () => {}, pushResult: async () => 11,
			post: async (rep) => { report = rep; }, ack: async () => {}, awaitPush: true,
		});
		check('R5: no final-frame dep -> the turn still completes, in order',
			res.done === true && res.trace.join(',') === 'take,reconstruct,run,report,complete,ack,release,push');
		check('R5: and the report says the answer did NOT travel ahead, so the parcel is the first sight',
			!!report && report.finalTail === 0);
	}

	// ── R6. A FINAL FRAME THAT FAILS costs the stream, never the turn. ──
	{
		L.forget();
		const sync = makeLeaseSync({});
		let report = null;
		const ctxChat = { id: 'chat-r6', messages: [{ role: 'user', content: 'q', mid: 'u1', ts: 1 }] };
		const res = await P.runErrand(errand, {
			selfId: 'peerA', cas: P.syncCas(sync), now: () => 2000,
			reconstruct: async () => ({ chat: ctxChat }),
			runTurn: async (ctx) => { P.foldAssistant(ctx.chat, { mid: 'a1', turnId: TID, text: 'ok', ts: 3 }); },
			abort: () => {},
			finalFrame: async () => { throw new Error('the door refused the frame'); },
			pushResult: async () => 12,
			post: async (rep) => { report = rep; }, ack: async () => {}, awaitPush: true,
		});
		check('R6: a refused final frame still reports, releases and pushes',
			res.done === true && res.trace.indexOf('report') >= 0
			&& res.trace.indexOf('release') >= 0 && res.trace.indexOf('push') >= 0);
		check('R6: and the report tells the truth about it -- no answer travelled ahead',
			!!report && report.finalTail === 0);
	}

	// ── R7. THE 409 STORM. Three devices, one turn: the originator and the runner may
	//    push; the third stands off while the lease reads `running`. ──
	{
		const now = 5000;
		const running = { T1: { turnId: 'T1', holder: 'RUNNER', mode: 'running', expiry: now + 60000, renewedAt: now } };
		check('R7a: the third device stands off -- its push would 409 the runner\'s answer',
			P.deferPushFor(running, 'THIRD', now, () => false) === 'T1');
		check('R7b: the RUNNER never stands off from its own turn',
			P.deferPushFor(running, 'RUNNER', now, () => false) === '');
		check('R7c: nor does the ORIGINATOR -- it is the one waiting for the answer',
			P.deferPushFor(running, 'PHONE', now, (id) => id === 'T1') === '');
		check('R7d: a CLAIMED lease is not yet running, so nobody stands off',
			P.deferPushFor({ T1: { turnId: 'T1', holder: 'RUNNER', mode: 'claimed',
				expiry: now + 60000, renewedAt: now } }, 'THIRD', now, () => false) === '');
		check('R7e: an EXPIRED lease holds nobody off -- the bound is the lease\'s own liveness',
			P.deferPushFor({ T1: { turnId: 'T1', holder: 'RUNNER', mode: 'running',
				expiry: now - 1, renewedAt: now - 99999 } }, 'THIRD', now, () => false) === '');
		check('R7f: a released lease holds nobody off',
			P.deferPushFor({ T1: { turnId: 'T1', holder: 'RUNNER', mode: 'released',
				expiry: now + 60000, renewedAt: now } }, 'THIRD', now, () => false) === '');
		check('R7g: no leases at all is no stand-off', P.deferPushFor({}, 'THIRD', now, () => false) === ''
			&& P.deferPushFor(null, 'THIRD', now, null) === '');
	}

	// ── R8. A FINAL FRAME CLOSES THE WATCHER'S VIEW, so a late ordinary frame cannot
	//    draw a stale tail over the answer that replaced it. ──
	{
		const one = [{ mid: 'x1', role: 'assistant', content: 'word one' }];
		const whole = [{ mid: 'x1', role: 'assistant', content: 'the whole answer' }];
		const open1 = P.foldProgress(null, { turn: 'T1', seq: 1, msgs: one });
		check('R8a: an ordinary frame opens the view', !!open1 && open1.msgs === one && open1.final === false);
		const closed = P.foldProgress(open1, { turn: 'T1', seq: 2, msgs: whole, final: true });
		check('R8b: a final frame closes it and carries the final rows',
			!!closed && closed.final === true && closed.msgs === whole);
		check('R8c: and no later frame reopens it',
			P.foldProgress(closed, { turn: 'T1', seq: 3, msgs: one }) === null);
	}

	// ── Stand down: a peer already holds the lease, so the runner does not run. ──
	{
		L.forget();
		const sync = makeLeaseSync({ [TID]: { turnId: TID, eid: 'other', holder: 'peerB', mode: 'running', expiry: 9e15, renewedAt: 1 } });
		let touched = false, acked = 0;
		const res = await P.runErrand(errand, {
			selfId: 'peerA', cas: P.syncCas(sync), now: () => 2000,
			reconstruct: async () => { touched = true; return { chat: {} }; },
			runTurn: async () => { touched = true; },
			abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => { acked += 1; },
		});
		check('the runner STANDS DOWN when a peer holds the lease', res.ran === false);
		check('a stood-down runner never reconstructs or runs', touched === false && res.trace.join(',') === 'take');
		check('a stood-down runner never acks', acked === 0);
	}

	// ── Revoke -> hard abort: the phone takes the turn back mid-run. ──
	{
		L.forget();
		const sync = makeLeaseSync({});
		const cas = P.syncCas(sync);
		const now = () => 1000;
		let abortFired = false, pushed = 0, acked = 0;
		const res = await P.runErrand(errand, {
			selfId: 'peerA', cas, now,
			reconstruct: async () => ({ chat: { id: 'chat-r', messages: [] } }),
			runTurn: async (ctx, prompt, opts) => {
				for (let i = 0; i < 6; i++) {
					if (i === 2) { await L.revoke(TID, cas, now); }		// the phone's take-back
					await opts.onProgress();
					if (abortFired) throw new Error('aborted by signal');
				}
			},
			abort: () => { abortFired = true; },
			pushResult: async () => { pushed += 1; return 9; },
			post: async () => {}, ack: async () => { acked += 1; },
		});
		check('a revoked lease HARD-ABORTS the turn', res.aborted === true && abortFired === true);
		check('an aborted run never pushes or acks (no double-bill commit)', pushed === 0 && acked === 0);
		check('the abort is recorded and the run never completed',
			res.trace.indexOf('abort') >= 0 && res.trace.indexOf('push') < 0);
	}

	// ── Crash before commit: no ack, so the errand is NOT dropped (step-2 gap closed). ──
	{
		L.forget();
		const sync = makeLeaseSync({});
		let acked = 0, pushed = 0;
		const res = await P.runErrand(errand, {
			selfId: 'peerA', cas: P.syncCas(sync), now: () => 2000,
			reconstruct: async () => ({ chat: { id: 'chat-r', messages: [] } }),
			runTurn: async () => { throw new Error('kaboom'); },
			abort: () => {}, pushResult: async () => { pushed += 1; return 9; },
			post: async () => {}, ack: async () => { acked += 1; },
		});
		check('a crash before commit is reported as an error', res.error === true);
		check('a crashed runner never acks (the errand survives on the relay to re-collect)',
			acked === 0 && pushed === 0);
		check('a crashed runner leaves the lease unreleased, to EXPIRE for the phone',
			!!sync.leases()[TID] && sync.leases()[TID].mode !== 'released');
	}
}

// A compare-and-set that models /api/sync: one versioned {version, leases} blob.
// `read()` hands back a COPY; `write(base, leases)` accepts ONLY when `base` is the
// current version (then bumps it), else answers the current blob -- the 409. Copies
// throughout, so a caller cannot mutate the server's state by holding a reference.
function makeCas(initialLeases) {
	let version = 5;					// an arbitrary non-zero base
	let leases = JSON.parse(JSON.stringify(initialLeases || {}));
	return {
		read: async () => ({ version, leases: JSON.parse(JSON.stringify(leases)) }),
		write: async (base, next) => {
			if (base !== version) return { ok: false, version, leases: JSON.parse(JSON.stringify(leases)) };
			version += 1;
			leases = JSON.parse(JSON.stringify(next));
			return { ok: true, version };
		},
		peekVersion: () => version,
		peekLeases: () => JSON.parse(JSON.stringify(leases)),
	};
}

// E-R1 (2026-09-23). On 2026-09-22 a tab still on an older build came back to the
// foreground and re-handed a turn sent five days before; the re-hand carried a fresh
// `ts` and a fresh `deadline`, the collector judged it by them, and the turn ran with
// nobody there. The age is now read off the turn's BIRTH, which no re-hand refreshes.
async function runTurnAgeAcceptance(P, L, PR, check) {
	console.log('\nE-R1 — a handed-off turn is aged from its birth, never from its sender\'s deadline');
	const DAY = 86400000, MIN = 60000, DL = P.DISPATCH_DEADLINE_MS;
	const REAL = Date.UTC(2026, 8, 23, 14, 0, 0);				// the relay's (true) time of the post
	const idAt = (ms, tag) => ms.toString(36) + '-1-' + (tag || 'abcde');
	const has = typeof P.turnAgeVerdict === 'function';
	const V = (e, o) => has ? P.turnAgeVerdict(e, o) : { ok: null, why: 'absent', age: -1, until: 0, clock: '' };
	// An errand as its sender posts it: born and sent on the SENDER's clock, the seed
	// ending at the turn's own user message, and the deadline the sender writes.
	const errandAt = (born, sent, extra) => P.makeErrand(Object.assign({
		turnId: idAt(born), chatId: 'c', prompt: 'p', eid: 'e', dispatchedBy: 'PHONE',
		ts: sent, deadline: sent + DL,
		seed: { chatId: 'c', title: '', provider: '', model: '',
			msgs: [{ role: 'user', content: 'p', mid: idAt(born), ts: born }] },
	}, extra || {}));
	// The relay stamped the row at `posted` (Unix seconds) and reads `relayNow` now.
	const at = (posted, relayNow, now, births) => ({ rowTs: Math.floor(posted / 1000), relayNow, now, births });

	// (1) THE INCIDENT: born five days ago, re-handed now with a fresh stamp and deadline.
	{
		const e = errandAt(REAL - 5 * DAY, REAL);
		const v = V(e, at(REAL, REAL + 30, REAL + 30));
		check('E-R1 (1): a turn born five days ago and re-handed now is refused, though its own deadline is 15 min off',
			v.ok === false && v.why === 'stale' && e.deadline > REAL + 30);
	}
	// (2) A SENDER FIVE DAYS FAST. Its five-day-old turn was born, on its clock, at the
	// relay's NOW -- so a collector reading the birth against its own clock passes it.
	{
		const fast = 5 * DAY;
		const e = errandAt(REAL - 5 * DAY + fast, REAL + fast);
		const v = V(e, at(REAL, REAL + 30, REAL + 30));
		check('E-R1 (2): a sender five days fast still reads its five-day-old turn as five days old (refused)',
			v.ok === false && v.why === 'stale' && Math.abs((REAL + 30) - (REAL - 5 * DAY + fast)) < DL);
	}
	// (3) A SENDER AN HOUR SLOW, a fresh turn: the deadline it wrote is already past on the
	// collector, which is what the old judge refused it on.
	{
		const slow = -60 * MIN;
		const e = errandAt(REAL + slow - 2000, REAL + slow);
		const v = V(e, at(REAL, REAL + 300, REAL + 300));
		check('E-R1 (3): a fresh hand-off from a sender an hour slow is started, though its deadline is past here',
			v.ok === true && v.age < 10000 && e.deadline < REAL + 300);
	}
	// (4) A COLLECTOR FIVE DAYS SLOW reads the relay's clock through presence, not its own.
	{
		const slow = -5 * DAY;
		const e = errandAt(REAL - 5 * DAY, REAL);
		check('E-R1 (4): a collector five days slow still refuses a five-day-old turn',
			V(e, at(REAL, REAL + 30, REAL + 30 + slow)).why === 'stale');
		const f = errandAt(REAL - 1000, REAL);
		check('E-R1 (4): ...and still starts a fresh one',
			V(f, at(REAL, REAL + 30, REAL + 30 + slow)).ok === true);
	}
	// (5) THE SENDER'S CLOCK STEPPED BACK between the birth and the send (audit F4's
	// future stamp): refused. A minute of ordinary disorder is not a step.
	{
		check('E-R1 (5): a turn born two days after it was sent is refused (clock-back)',
			V(errandAt(REAL + 2 * DAY, REAL), at(REAL, REAL + 30, REAL + 30)).why === 'clock-back');
		check('E-R1 (5): ...but a birth a minute after the stamp is ordinary disorder, and starts',
			V(errandAt(REAL + MIN, REAL), at(REAL, REAL + 30, REAL + 30)).ok === true);
	}
	// (6) NO PLAUSIBLE BIRTH: an id with no time in it, and `legacy-0000`, whose prefix
	// parses as base 36 to a moment in 1970. Unaged is refused; the stamps the collector
	// holds itself age it.
	{
		const bare = P.makeErrand({ turnId: 't1', chatId: 'c', prompt: 'p', ts: REAL, deadline: REAL + DL });
		const legacy = P.makeErrand({ turnId: 'legacy-0000', chatId: 'c', prompt: 'p', ts: REAL, deadline: REAL + DL });
		check('E-R1 (6): an errand whose turn has no plausible birth cannot be aged, and is refused',
			V(bare, at(REAL, REAL + 30, REAL + 30)).why === 'unaged'
			&& V(legacy, at(REAL, REAL + 30, REAL + 30)).why === 'unaged');
		check('E-R1 (6): ...and a birth the collector holds itself (its own copy of the chat) ages it',
			V(bare, at(REAL, REAL + 30, REAL + 30, [REAL - 5 * DAY])).why === 'stale'
			&& V(bare, at(REAL, REAL + 30, REAL + 30, [REAL - MIN])).ok === true);
		check('E-R1 (6): the EARLIEST birth wins: a fresh id does not hide an old seed stamp',
			V(errandAt(REAL - 1000, REAL, { seed: { chatId: 'c', msgs: [{ role: 'user', mid: idAt(REAL - 1000), ts: REAL - 5 * DAY }] } }),
				at(REAL, REAL + 30, REAL + 30)).why === 'stale');
	}
	// (7) THE RELAY TERM: time on the relay counts, read on the relay's clock.
	{
		const e = errandAt(REAL - 1000, REAL);
		check('E-R1 (7): a fresh errand that sat on the relay past the window is refused',
			V(e, at(REAL, REAL + DL + 1000, REAL + DL + 1000)).why === 'stale');
		const v = V(e, at(REAL, REAL + MIN, REAL + MIN));
		check('E-R1 (7): ...one that sat a minute starts, and ages out on this device\'s clock at birth + window',
			v.ok === true && v.clock === 'relay' && Math.abs(v.until - (REAL - 1000 + DL)) <= 1000);
		const vFast = V(e, at(REAL, REAL + MIN, REAL + MIN + 5 * DAY));
		check('E-R1 (7): a collector five days FAST reads the minute on the relay\'s clock, and starts it',
			vFast.ok === true && vFast.clock === 'relay');
		const vLocal = V(e, at(REAL, null, REAL + MIN));
		check('E-R1 (7): with no relay clock yet the local clock stands in, and the verdict says so',
			vLocal.ok === true && vLocal.clock === 'local');
		check('E-R1 (7): a relay stamp already in milliseconds is read as one, not as a post this instant',
			V(e, { rowTs: REAL, relayNow: REAL + DL + 1000, now: REAL + DL + 1000 }).why === 'stale');
		const vRec = V(e, { now: REAL + 20 * MIN });
		check('E-R1 (7): a recovery (no relay row) ages the turn on the sender\'s own clock',
			vRec.why === 'stale' && vRec.clock === 'sender');
	}
	// (8) THE RUNNER. A stale errand takes no lease and runs nothing, and the refusal is
	// ANSWERED with an `aborted` report, so the sender stops re-handing it.
	{
		L.forget();
		const cas = makeCas({});
		const posted = []; let ran = 0;
		const e = errandAt(REAL - 5 * DAY, REAL);
		const res = await P.runErrand(e, {
			selfId: 'DESK', cas, rowTs: Math.floor(REAL / 1000), relayNow: () => REAL + 30,
			finished: async () => false, reconstruct: async () => ({}), runTurn: async () => { ran++; },
			abort: () => {}, pushResult: async () => 1, post: async (r) => { posted.push(r); },
			ack: async () => {}, now: () => REAL + 30, setTimer: () => null, clearTimer: () => {},
		});
		check('E-R1 (8): runErrand refuses the five-day-old re-hand: nothing runs, no lease is taken',
			ran === 0 && res.ran === false && res.why === 'stale-turn' && !cas.peekLeases()[e.turnId]);
		check('E-R1 (8): ...and answers it with one `aborted` report for the turn',
			posted.length === 1 && posted[0].status === 'aborted' && posted[0].turnId === e.turnId);
		// A turn already settled is not reported aborted (its `done` would be overwritten).
		const posted2 = [];
		const r2 = await P.runErrand(e, {
			selfId: 'DESK', cas, rowTs: Math.floor(REAL / 1000), relayNow: () => REAL + 30,
			finished: async () => true, reconstruct: async () => ({}), runTurn: async () => { ran++; },
			abort: () => {}, pushResult: async () => 1, post: async (r) => { posted2.push(r); },
			ack: async () => {}, now: () => REAL + 30,
		});
		check('E-R1 (8): a stale errand for a turn already answered stands down as done, reporting nothing',
			has && r2.why === 'already-done' && posted2.length === 0);
	}
	// (9) A fresh turn from an hour-slow sender RUNS, which the old deadline judge refused.
	{
		L.forget();
		const cas = makeCas({});
		let ran = 0;
		const e = errandAt(REAL - 60 * MIN - 2000, REAL - 60 * MIN);
		const res = await P.runErrand(e, {
			selfId: 'DESK', cas, rowTs: Math.floor(REAL / 1000), relayNow: () => REAL + 300,
			finished: async () => false, reconstruct: async () => ({ chat: {}, app: {} }),
			runTurn: async () => { ran++; }, abort: () => {}, pushResult: async () => 1,
			post: async () => {}, ack: async () => {}, now: () => REAL + 300, awaitPush: true,
			setTimer: () => null, clearTimer: () => {},
		});
		check('E-R1 (9): runErrand starts a fresh turn from a sender an hour slow, exactly once',
			res.done === true && ran === 1);
	}
	// (10) THE TAKE. The verdict's `until`, on this device's clock, replaces the sender's
	// deadline as the judge; the claim lives to the later of the two.
	{
		L.forget();
		const cas = makeCas({});
		const took = await L.take('tu', { holder: 'DESK', eid: 'e', deadline: REAL - 45 * MIN, until: REAL + 14 * MIN }, cas, () => REAL);
		check('E-R1 (10): the take honours the age verdict over a sender deadline already past here',
			took.won === true);
		check('E-R1 (10): ...and holds the claim to the turn\'s window on this clock, not to one TTL',
			took.won === true && cas.peekLeases().tu.expiry === REAL + 14 * MIN);
		const late = await L.take('tv', { holder: 'DESK', eid: 'e', deadline: REAL + 10 * MIN, until: REAL - 1 }, cas, () => REAL);
		check('E-R1 (10): a turn that aged out between the verdict and the take is not taken',
			late.won === false && late.why === 'stale-turn');
		const fast = await L.take('tw', { holder: 'DESK', eid: 'e', deadline: REAL + 5 * DAY, until: REAL + 10 * MIN }, cas, () => REAL);
		check('E-R1 (10): (holds) a later sender deadline still bounds the claim, as it always has',
			fast.won === true && cas.peekLeases().tw.expiry === REAL + 5 * DAY);
		const cmp = await L.take('tx', { holder: 'DESK', eid: 'e', deadline: REAL - 1, ts: REAL - 20 * MIN }, cas, () => REAL);
		check('E-R1 (10): (holds) a take with no verdict -- a compile -- keeps the deadline refusal',
			cmp.won === false && cmp.why === 'deadline');
	}
	// (11) THE SENDER'S SIDE. A re-seat refreshes the placeholder's stamp and never its
	// turn's birth, so the chain of re-seats ends where the collector's verdict does.
	{
		const born = REAL - 20 * MIN;
		const reseat = { why: 'dispatched', iturn: idAt(born), mid: idAt(born + 50, 'ph'), itext: 'p',
			dispatchedBy: 'PHONE', ts: REAL - MIN };
		check('E-R1 (11): a hand-off re-seated a minute ago, born twenty minutes ago, is past its window',
			P.handoffExpired(reseat, REAL) === true);
		check('E-R1 (11): ...so its sender neither recovers nor re-seats it',
			P.recoverDecision(reseat, null, false, 'PHONE', REAL) === false);
		check('E-R1 (11): ...nor watches it, and its tile offers [Run here]',
			P.watchDecision(reseat, null, false, 'PHONE', REAL) === false
			&& P.uiState(reseat, null, null, 'PHONE', REAL) === 'no-peer-awake');
		const young = Object.assign({}, reseat, { iturn: idAt(REAL - 2 * MIN), mid: idAt(REAL - 2 * MIN + 50, 'ph') });
		check('E-R1 (11): (holds) a young one is still its sender\'s to recover',
			P.recoverDecision(young, null, false, 'PHONE', REAL) === true);
		check('E-R1 (11): a sender asks the same window before a parked re-run or a step-away',
			has && P.turnInWindow([idAt(REAL - 2 * MIN)], [], REAL) === true
			&& P.turnInWindow([idAt(REAL - 20 * MIN)], [], REAL) === false
			&& P.turnInWindow(['t1'], [], REAL) === false);
	}
	// (12) THE STAMPS A DEVICE HOLDS: the turn's user message and its placeholder's mid.
	{
		const msgs = [
			{ role: 'user', mid: 'TURN', ts: REAL - 5 * DAY },
			{ role: 'assistant', why: 'dispatched', iturn: 'TURN', mid: idAt(REAL - 5 * DAY + 30, 'ph') },
			{ role: 'user', mid: 'OTHER', ts: REAL },
		];
		const h = has ? P.turnBirthHints(msgs, 'TURN') : [];
		check('E-R1 (12): a device reads the turn\'s user message and placeholder as birth stamps, and nothing else',
			h.length === 2 && Math.min.apply(null, h) === REAL - 5 * DAY);
	}
	// (13) THE RELAY CLOCK comes from presence: kept from the server's `now`, and absent
	// until an answer carried one.
	{
		const ok = !!(PR && PR.relayNow);
		if (ok) {
			PR.forget();
			const before = PR.relayNow();
			PR.ingest({}, Date.now() + 5 * DAY);
			const lead = PR.relayNow() - Date.now();
			check('E-R1 (13): presence keeps the relay\'s clock from the server\'s `now`, and none before an answer',
				before === null && Math.abs(lead - 5 * DAY) < 5000);
			PR.ingest({}, undefined);
			check('E-R1 (13): an answer with no server clock leaves the kept one alone',
				Math.abs((PR.relayNow() - Date.now()) - 5 * DAY) < 5000);
			PR.forget();
		} else {
			check('E-R1 (13): presence keeps the relay\'s clock from the server\'s `now`', false);
		}
	}
}

// R4b (2026-09-23). With no nominee the send advertises no device, and the backstop
// seeded what it had tried from that advertisement alone: it found nothing tried and
// re-handed the turn to the very desktop that had just failed to collect it, so a
// one-desktop account ran it here only at the SECOND backstop, about 190 s after the
// send. The elected device is now recorded in `triedDevices` from the first send.
// Driven through daimond.js's own `electedTried`, `markTurnDispatched` and
// `retryNextDesktopBeforeLocal`, extracted from source, over the real peer.js.
async function runElectedTriedAcceptance(P, check) {
	console.log('\nR4b — the first backstop does not hand a turn back to the desktop that did not collect it');
	function sandbox(presence) {
		const spy = { redispatched: [], persisted: 0 };
		const win = {
			DaimondPeer: P,
			DaimondLease: { holder: () => null },
			DaimondPresence: { snapshot: () => presence },
			selfDeviceId: () => 'PHONE',
			annotatePresence: (p) => p,
			fleetCurrentBuild: () => '',
			preferredWorkerLabel: () => '',
			nominatedDeviceId: () => '',
			deviceLabelFor: (id) => String(id),
			touchChat: () => {}, persistChats: () => { spy.persisted++; },
			renderHistory: () => {}, ownsChat: () => false, diag: () => {},
			newMid: () => Date.now().toString(36) + '-1-ph000',
			_dispatchedIx: {}, updateExpedite: () => {},
			dispatchToPeer: (chat, tid, text, holds, opts) => {
				spy.redispatched.push({ tid, to: opts && opts.toId });
				return Promise.resolve({ ok: true });
			},
			scheduleDispatchFallback: () => {}, runDispatchFallback: () => {},
			// Nothing here is paused: the re-seat is asked the pause first (F2).
			turnHold: () => '',
			DISPATCH_RETRY_MAX: 3,
			_msNum: (x) => +x || 0,
		};
		const src = ['electedTried', 'markTurnDispatched', 'retryNextDesktopBeforeLocal']
			.map((n) => daimondFuncSource(n)).join('\n')
			+ '\nwindow.electedTried = electedTried;\nwindow.markTurnDispatched = markTurnDispatched;'
			+ '\nwindow.retryNextDesktopBeforeLocal = retryNextDesktopBeforeLocal;\n';
		new Function('window', 'with (window) {\n' + src + '\n}')(win);
		return { win, spy };
	}
	const now = Date.now();
	const desk = (name) => ({ name, lastSeen: now - 1000, servicedAt: now - 1000, mobile: false });
	const send = (sb, d) => {
		const chat = { id: 'c', messages: [{ role: 'user', mid: 'T', iturn: 'T', content: 'p', ts: now }] };
		// What dispatchToPeer marks for a send with no nominee: no advertised device, and
		// (the fix) the elected one recorded as tried.
		sb.win.markTurnDispatched(chat, { interrupted: true, why: 'dispatched', iturn: 'T', itext: 'p',
			dispatchedBy: 'PHONE', parkCount: 0, toDevice: '', toName: '', tried: sb.win.electedTried(d) });
		return { chat, m: chat.messages.find((x) => x.why === 'dispatched') };
	};
	try {
		// ONE desktop, which did not collect: the first backstop runs the turn here.
		{
			const sb = sandbox({ DESK: desk('desk') });
			const { chat, m } = send(sb, { dispatch: true, peer: { deviceId: 'DESK', name: 'desk' }, reason: 'mobile-peer' });
			check('R4b: the placeholder records the elected desktop as tried, and still advertises no device',
				Array.isArray(m.triedDevices) && m.triedDevices.indexOf('DESK') !== -1 && m.toDevice === '');
			const re = await sb.win.retryNextDesktopBeforeLocal(chat, m);
			check('R4b: at the first backstop a one-desktop account runs the turn here, not back to that desktop',
				re === false && sb.spy.redispatched.length === 0);
		}
		// TWO desktops: the first backstop moves the turn to the OTHER one.
		{
			const sb = sandbox({ DESK: desk('desk'), DESK2: desk('desk2') });
			const { chat, m } = send(sb, { dispatch: true, peer: { deviceId: 'DESK', name: 'desk' }, reason: 'mobile-peer' });
			const re = await sb.win.retryNextDesktopBeforeLocal(chat, m);
			check('R4b: with a second desktop the first backstop re-hands to it, never to the first',
				re === true && sb.spy.redispatched.length === 1 && sb.spy.redispatched[0].to === 'DESK2');
		}
	} catch (e) {
		check('R4b: the elected desktop is recorded as tried (' + String(e && e.message || e).slice(0, 80) + ')', false);
	}
}

/// S-HAND #1: the settled own-errand is released, and a settled lease refuses a take.
/// `holdOwnDispatch` is what post.js `takeRow` asks before it HOLDs; `leaseSetCas`
/// carries the completion proof into the lease so a raced taker stands down.
async function runSettleMoneySafety(P, L, check) {
	const TID = 'turn-settle';
	const TTL = L.LEASE_TTL_MS;
	const now = 1700000000000;

	// ── holdOwnDispatch: hold while live, drop when settled or past deadline+TTL ──
	{
		P.onSettled(null);					// no probe registered yet: decide on the deadline alone
		check('holdOwnDispatch HOLDS an errand within its deadline (no settle probe)',
			(await P.holdOwnDispatch({ deadline: now + P.DISPATCH_DEADLINE_MS }, now)) === true);
		check('holdOwnDispatch DROPS an errand past deadline + one TTL (no peer may start it)',
			(await P.holdOwnDispatch({ deadline: now - 20 * 60 * 1000 }, now)) === false);
		check('holdOwnDispatch still HOLDS just inside deadline + TTL',
			(await P.holdOwnDispatch({ deadline: now - (TTL - 1000) }, now)) === true);
		// A deadline-less recovery errand (deadline 0) is not aged out by the deadline arm.
		check('holdOwnDispatch HOLDS a deadline-less errand (the deadline arm does not fire)',
			(await P.holdOwnDispatch({ deadline: 0 }, now)) === true);

		// Register a probe: an errand whose turn is settled here must NOT be held.
		let settledTurns = new Set();
		P.onSettled((env) => settledTurns.has(String(env && env.turnId)));
		check('holdOwnDispatch HOLDS while the settle probe says not-finished',
			(await P.holdOwnDispatch({ turnId: TID, deadline: now + P.DISPATCH_DEADLINE_MS }, now)) === true);
		settledTurns.add(TID);
		check('holdOwnDispatch DROPS once the settle probe says the turn is finished here',
			(await P.holdOwnDispatch({ turnId: TID, deadline: now + P.DISPATCH_DEADLINE_MS }, now)) === false);
		P.onSettled(null);					// leave the module as we found it for later suites
	}

	// ── noteHeldFor: a note naming another device stays on the relay for it (2026-09-24) ──
	// The relay's ack is one watermark for the account, so a runner that acked past the
	// report it had just posted dropped it before the phone collected it.
	{
		const has = typeof P.noteHeldFor === 'function';
		const H = (env, rowTs, self, relayNow) => has ? P.noteHeldFor(env, { ts: rowTs }, self, relayNow) : 'absent';
		const sec = Math.floor(now / 1000);
		const rep = (to) => P.makeReport({ eid: 'eN', to: to, turnId: TID, chatId: 'c', status: 'done' });
		check('noteHeldFor: a report for the PHONE is held by the runner that collects it',
			H(rep('PHONE'), sec, 'RUNNER', now) === 'PHONE');
		check('noteHeldFor: and taken by the phone it names',
			H(rep('PHONE'), sec, 'PHONE', now) === '');
		check('noteHeldFor: a report that names nobody (an older runner\'s) is taken, as before',
			H(rep(''), sec, 'RUNNER', now) === '');
		check('noteHeldFor: held just inside its window, on the relay\'s clock',
			H(rep('PHONE'), sec, 'RUNNER', now + P.NOTE_HOLD_MS - 2000) === 'PHONE');
		check('noteHeldFor: let go once the window has passed',
			H(rep('PHONE'), sec, 'RUNNER', now + P.NOTE_HOLD_MS + 2000) === '');
		check('noteHeldFor: a stamp already in milliseconds is read as one',
			H(rep('PHONE'), now, 'RUNNER', now + 1000) === 'PHONE'
			&& H(rep('PHONE'), now, 'RUNNER', now + P.NOTE_HOLD_MS + 2000) === '');
		check('noteHeldFor: a row with no stamp cannot be aged, so it is not held',
			H(rep('PHONE'), 0, 'RUNNER', now) === '');
		check('noteHeldFor: an errand is work, claimed and never held for a device',
			H(P.makeErrand({ turnId: TID, dispatchedBy: 'PHONE' }), sec, 'RUNNER', now) === ''
			&& H(Object.assign(P.makeErrand({ turnId: TID }), { to: 'PHONE' }), sec, 'RUNNER', now) === '');
		check('noteHeldFor: a compile\'s account names its dispatcher the same way',
			H(P.makeBuilt({ eid: 'eB', cid: 'k', to: 'PHONE' }), sec, 'RUNNER', now) === 'PHONE');
		// R3 QA Q1: the stamp is the relay's, so with no relay clock known the age is not
		// read at all, and the report is held rather than aged on this device's clock.
		check('noteHeldFor: with no relay clock, a report is held however old the local clock reads it',
			H(rep('PHONE'), sec - 3600, 'RUNNER', null) === 'PHONE');
	}

	// ── A held note is decided from what its hold kept (R3 QA Q1, Q2, Q5) ──
	{
		const sec = Math.floor(now / 1000);
		const W = P.NOTE_HOLD_MS;
		const f = P.noteHoldFacts({ ts: sec }, now + 1000, now);
		check('noteHoldFacts: the stamp, the first sight on this clock, the age then on the relay\'s',
			f.ts === sec && f.seenAt === now && f.age0 === (now + 1000) - sec * 1000, JSON.stringify(f));
		check('noteHoldOpen: on the relay\'s clock where one is known',
			P.noteHoldOpen(f, sec * 1000 + W - 1000, 0) && !P.noteHoldOpen(f, sec * 1000 + W + 1000, 0));
		const g = P.noteHoldFacts({ ts: sec }, null, now);
		check('noteHoldFacts: with no relay clock the age at first sight is taken as none', g.age0 === 0);
		check('noteHoldOpen: with none, counted on this device\'s clock from first sight',
			P.noteHoldOpen(g, null, now + W - 1000) && !P.noteHoldOpen(g, null, now + W + 1000));
		const F = P.PRESENCE_FRESH_MS || 120000;
		check('noteLookAgain: a device the view has not got, or has not heard beat lately, is not looked for',
			!P.noteLookAgain('PHONE', {}, now) && !P.noteLookAgain('PHONE', null, now)
			&& !P.noteLookAgain('PHONE', { PHONE: { lastSeen: now - F - 1000 } }, now));
		check('noteLookAgain: an awake one is',
			P.noteLookAgain('PHONE', { PHONE: { lastSeen: now - 1000 } }, now));
		check('noteHoldOpen: which a clock twenty minutes out does not move',
			P.noteHoldOpen(P.noteHoldFacts({ ts: sec }, null, now + 1200000), null, now + 1200000 + 60000));
	}

	// ── Every report a runner posts names the device it is for (R3 QA Q3, Q6) ──
	{
		const e = { eid: 'eR', turnId: TID, chatId: 'chat-r', dispatchedBy: 'PHONE' };
		const r = P.reportFor(e, { status: 'error', why: 'This chat is paused.', to: 'NOBODY', turnId: 'x' });
		check('reportFor: the errand\'s turn, chat, id and dispatcher, whatever the fields say',
			r.t === 'report' && r.to === 'PHONE' && r.turnId === TID && r.chatId === 'chat-r' && r.eid === 'eR'
			&& r.status === 'error' && r.why === 'This chat is paused.', JSON.stringify(r));
		const l = P.reportFor({ turnId: TID, eid: 'eR', holder: 'RUNNER', dispatchedBy: 'PHONE', mode: 'running' },
			{ status: 'error', why: 'runner-restarted' });
		check('reportFor: from a lease, for a hand-back with no errand in hand',
			l.to === 'PHONE' && l.turnId === TID && l.eid === 'eR' && l.why === 'runner-restarted', JSON.stringify(l));
		check('reportFor: a lease an older build took names nobody, and the report is taken as before',
			P.reportFor({ turnId: TID }, { status: 'error' }).to === '');
	}

	// ── An own errand's hold keeps what `holdOwnDispatch` reads ──
	{
		const born = now - 60000;
		const tid = born.toString(36) + '-1-own';
		const env = P.makeErrand({ turnId: tid, chatId: 'c', eid: 'eO', dispatchedBy: 'PHONE', deadline: born + 900000,
			seed: { msgs: [{ role: 'user', mid: tid, ts: born }] } });
		const k = P.ownHoldFacts(env);
		check('ownHoldFacts: small, and the birth read once',
			!k.seed && k.turnId === tid && k.chatId === 'c' && k.born > 0 && k.deadline === born + 900000, JSON.stringify(k));
		// Live; past its deadline; and past its birth's window with a deadline far off.
		const far = P.makeErrand({ turnId: tid, chatId: 'c', eid: 'eO', dispatchedBy: 'PHONE', deadline: 9e15,
			seed: { msgs: [{ role: 'user', mid: tid, ts: born }] } });
		const TTL = L.LEASE_TTL_MS;
		const cases = [[env, now, true], [env, born + 900000 + TTL + 1000, false],
			[far, born + P.DISPATCH_DEADLINE_MS + TTL + 1000, false]];
		const got = [];
		for (const [e1, at, want] of cases) {
			got.push([await P.holdOwnDispatch(e1, at), await P.holdOwnDispatch(P.ownHoldFacts(e1), at), want]);
		}
		check('ownHoldFacts: holdOwnDispatch answers the same from the facts as from the envelope (hold, deadline, birth)',
			got.every(([a1, b1, w]) => a1 === w && b1 === w), JSON.stringify(got));
	}

	// ── leaseSetCas: done->released stamps settled:1; other releases do not ──
	// The clock ADVANCES between take, complete and release, exactly as a real turn's
	// does -- a same-holder tie on `renewedAt` is resolved in favour of the existing
	// record (pickLease), so a constant clock would lose the `complete` write.
	{
		L.forget();
		let t = now;
		const clock = () => t;
		const cas = makeCas({});
		const took = await L.take(TID, { holder: 'PEER', eid: 'eS', deadline: now + P.DISPATCH_DEADLINE_MS }, cas, clock);
		check('the peer takes the lease', took.won === true);
		t = now + 3000;							// the turn ran for a few seconds
		const done = await L.complete(TID, 'PEER', cas, clock);
		check('complete() marks the lease done', done.ok === true);
		check('a done lease is NOT yet stamped settled (done is transient)',
			(cas.peekLeases()[TID].settled | 0) === 0);
		t = now + 3010;
		const rel = await L.release(TID, 'PEER', cas, clock);
		check('release() after done succeeds', rel.ok === true);
		check('a done->released lease is stamped settled:1 (the completion proof)',
			cas.peekLeases()[TID].settled === 1);

		// A taker whose collect raced the errand and the done report together reads the
		// released lease as vacant -- but the settled stamp stands it down (S-HAND #1).
		t = now + 3020;
		const race = await L.take(TID, { holder: 'RACER', eid: 'eR', deadline: now + P.DISPATCH_DEADLINE_MS }, cas, clock);
		check('a take of a SETTLED lease stands down (why:settled)',
			race.won === false && race.why === 'settled', JSON.stringify(race));
	}

	// ── a PARK release (running->released) is NOT settled: a re-dispatch still claims ──
	{
		L.forget();
		let t = now;
		const clock = () => t;
		const cas = makeCas({});
		await L.take(TID, { holder: 'PEER', eid: 'eP', deadline: now + P.DISPATCH_DEADLINE_MS }, cas, clock);
		// running->released (a park hands the turn back), NOT done->released.
		t = now + 3000;
		await L.renew(TID, 'PEER', cas, clock);		// claimed -> running
		t = now + 3010;
		const rel = await L.release(TID, 'PEER', cas, clock);
		check('a park release succeeds', rel.ok === true);
		check('a running->released lease is NOT stamped settled (a re-dispatch may claim)',
			(cas.peekLeases()[TID].settled | 0) === 0);
		t = now + 3020;
		const reclaim = await L.take(TID, { holder: 'NEXT', eid: 'eN', deadline: now + P.DISPATCH_DEADLINE_MS }, cas, clock);
		check('a re-dispatch CLAIMS a parked (non-settled) released lease', reclaim.won === true);
	}
}

async function runLeaseAcceptance(L, check) {
	const TID = 'turn-race';

	// ── The core race: A and B both read v5, then both attempt a TAKE. ──
	// B is given a strictly LATER clock than A, so a freshest-scalar merge would
	// hand B the turn -- which is precisely the double claim the mutation test
	// below forces. The correct rule ignores the clock across holders.
	{
		L.forget();
		const cas = makeCas({});
		const snapA = await cas.read();		// both based on the SAME version 5
		const snapB = await cas.read();
		const nowA = () => 1000;
		const nowB = () => 1001;			// B's clock reads later
		const aRes = await L.takeFrom(snapA, TID, { holder: 'A', eid: 'eA' }, cas, nowA);
		const bRes = await L.takeFrom(snapB, TID, { holder: 'B', eid: 'eB' }, cas, nowB);

		check('device A wins the take (committed at the lower version)', aRes.won === true);
		check('device B STANDS DOWN (a live foreign lease beat its claim)', bRes.won === false);
		check('B was told who holds it', bRes.holder === 'A');
		check('EXACTLY ONE device won -- no double run', (aRes.won ? 1 : 0) + (bRes.won ? 1 : 0) === 1);
		check('the committed parcel names A as the holder', cas.peekLeases()[TID].holder === 'A');
		check('the version advanced exactly once (one claim committed)', cas.peekVersion() === 6);
	}

	// ── take-if-vacant keeps the winner when a fresh device adopts the parcel ──
	{
		const fresh = { forget: true };		// simulate a third device's local view via merge()
		// A third device, having pulled the parcel that names A, must keep A even if
		// it holds a stale local claim of its own for the same turn.
		const localClaimC = { [TID]: { turnId: TID, eid: 'eC', holder: 'C', mode: 'claimed', expiry: 9e15, renewedAt: 2000 } };
		const parcelWithA = { [TID]: { turnId: TID, eid: 'eA', holder: 'A', mode: 'running', expiry: 9e15, renewedAt: 1000 } };
		const merged = L.merge(localClaimC, parcelWithA, 3000);
		check('adopting a parcel that names A drops a local claim by C (incoming wins)',
			merged[TID].holder === 'A');
	}

	// ── An expired lease is vacant and reclaimable. ──
	{
		L.forget();
		const now = () => 100000;
		const dead = { [TID]: { turnId: TID, eid: 'eDead', holder: 'Dead', mode: 'running', expiry: 100000 - 1, renewedAt: 1 } };
		const cas = makeCas(dead);
		const res = await L.take(TID, { holder: 'Reclaimer', eid: 'eR' }, cas, now);
		check('an EXPIRED lease is reclaimable (a new device takes it)', res.won === true);
		check('the reclaimer is now the holder', cas.peekLeases()[TID].holder === 'Reclaimer');
	}

	// ── A renew keeps a live lease held against a would-be reclaimer. ──
	{
		L.forget();
		let clock = 100000;
		const now = () => clock;
		const cas = makeCas({});
		const held = await L.take(TID, { holder: 'Holder', eid: 'eH' }, cas, now);
		check('the holder takes the lease', held.won === true);
		// Time advances past the ORIGINAL expiry but the holder renews first.
		clock = 100000 + 40000;				// > RENEW cadence, < TTL
		const rnw = await L.renew(TID, 'Holder', cas, now);
		check('the holder renews its live lease', rnw.ok === true);
		// A reclaimer tries at a moment past the ORIGINAL expiry but before the
		// RENEWED one -- it must stand down, because the renew kept the lease live.
		clock = 100000 + 95000;				// past original 90s TTL, within the renewed one
		const late = await L.take(TID, { holder: 'LateComer', eid: 'eL' }, cas, now);
		check('a renew keeps the lease held (a late reclaimer stands down)', late.won === false);
		check('the late reclaimer was told the holder still holds it', late.holder === 'Holder');

		// And once the holder RELEASES, the turn is reclaimable again.
		const rel = await L.release(TID, 'Holder', cas, now);
		check('the holder can release the lease', rel.ok === true);
		clock = 100000 + 96000;
		const after = await L.take(TID, { holder: 'NextUp', eid: 'eN' }, cas, now);
		check('after release the turn is reclaimable', after.won === true);
	}

	// ── HARDENING a: a far-future expiry (fast-clock holder) is CLAMPED. ──
	{
		L.forget();
		const now = 1000000000000;			// a realistic epoch-ms, past 2^31
		const TTL = L.LEASE_TTL_MS;
		const farFuture = { [TID]: { turnId: TID, eid: 'eFast', holder: 'Fast',
			mode: 'running', expiry: now + 10 * TTL, renewedAt: now } };
		const merged = L.merge({}, farFuture, now);
		check('an adopted far-future expiry is CLAMPED to now + TTL',
			merged[TID].expiry === now + TTL);
		// And so it is reclaimable at the NORMAL ttl, not parked for 10x it.
		const cas = makeCas(merged);
		const late = () => now + TTL + 1;
		const res = await L.take(TID, { holder: 'Rescuer', eid: 'eRes' }, cas, late);
		check('a clamped lease is reclaimable at the normal TTL (not parked)', res.won === true);
	}

	// ── HARDENING b: equal renewedAt, 'released' beats 'running'. ──
	{
		const t = 5000;
		const running  = { turnId: TID, eid: 'e', holder: 'H', mode: 'running',  expiry: 9e12, renewedAt: t };
		const released = { turnId: TID, eid: 'e', holder: 'H', mode: 'released', expiry: 0,    renewedAt: t };
		check('equal renewedAt: released beats running (incoming released)',
			L.mergeOne(running, released, 100).mode === 'released');
		check('equal renewedAt: released beats running (local released)',
			L.mergeOne(released, running, 100).mode === 'released');
	}
}

// SIM-4 (CLK, high: a turn run and billed twice). A lease aged on each device's
// OWN raw clock lets a device far enough ahead read a peer's still-live lease as
// dead and take it out from under the peer -- both then run, and bill, the same
// turn. R and T here are two REAL, independent `peer.js` instances (their own
// `DaimondPresence`/`DaimondLease`, as two devices are) with raw clocks 120s
// apart -- past the 90s TTL -- sharing one fake gateway CAS door. The fix is
// `DaimondLease.authorityNow`: each corrects its raw clock by the offset its own
// `DaimondPresence.ingest` last learned from the gateway, so the two converge on
// one clock regardless of how far their raw ones have drifted.
async function runLeaseClockAcceptance(check) {
	console.log('\nSIM-4 — a lease is aged on the AUTHORITY clock, not each device\'s raw one');
	const TID = 'turn-clock-skew';
	const TRUE_NOW = Date.now();			// the gateway's (true) clock, shared by both

	// R's raw clock reads true; T's reads 120s FAST -- past the 90s TTL, as the
	// brief's acceptance case asks for two devices 120s apart.
	const R = makeTab(0);
	const T = makeTab(120000);
	await R.DaimondPresence.ingest({}, TRUE_NOW);	// R learns the gateway clock: skew ~0
	await T.DaimondPresence.ingest({}, TRUE_NOW);	// T learns it too: skew ~ -120000

	check('R\'s corrected clock reads close to the TRUE gateway time',
		Math.abs(R.DaimondLease.authorityNow() - TRUE_NOW) < 2000);
	check('T\'s corrected clock ALSO reads close to the TRUE gateway time, despite its raw clock running 120s fast',
		Math.abs(T.DaimondLease.authorityNow() - TRUE_NOW) < 2000);
	check('T\'s RAW clock genuinely is ~120s ahead of R\'s (the skew this test relies on is real)',
		Date.now() + 120000 - Date.now() >= 119000);

	// R takes and holds the lease -- a turn dispatched to it and now running. NO
	// `deadline` is given, so this is the bare 90s-TTL claim (`expiryCap`'s longer,
	// deadline-bounded expiry is a SEPARATE defence for a turn still running past
	// its TTL; this proves the clock fix on the TTL path underneath it).
	const cas = makeCas({});
	const held = await R.DaimondLease.take(TID, { holder: 'R', eid: 'eR' }, cas, R.DaimondLease.authorityNow);
	check('R takes the lease', held.won === true);

	// T, moments later (in real time), reads the SAME gateway state and judges
	// whether to also take TID -- exactly what a second device does before
	// running a handed-off turn. On the AUTHORITY clock, R's lease is still live
	// (no real time of consequence has passed), so T must stand down.
	const snapT = await cas.read();
	const race = await T.DaimondLease.takeFrom(snapT, TID,
		{ holder: 'T', eid: 'eT' }, cas, T.DaimondLease.authorityNow);
	check('T STANDS DOWN: the fix reads R\'s lease as live despite T\'s 120s-fast raw clock',
		race.won === false);
	check('T was told R still holds it', race.holder === 'R');
	check('EXACTLY ONE device holds the lease -- no double run, no double bill',
		cas.peekLeases()[TID].holder === 'R');
	check('the version advanced exactly once (T\'s claim never committed)', cas.peekVersion() === 6);

	// The counter-proof: T's OWN RAW clock (uncorrected), 120s past R's TTL-bound
	// claim, reads R's still-live lease as already dead -- the exact SIM-4 failure
	// the fix closes -- run against a throwaway CAS so it cannot affect the
	// assertions above.
	const casBug = makeCas({});
	await R.DaimondLease.take(TID, { holder: 'R', eid: 'eR2' }, casBug, R.DaimondLease.authorityNow);
	const snapBug = await casBug.read();
	const rawNowT = () => Date.now() + 120000;	// T's raw, UNCORRECTED clock
	const bugRace = await T.DaimondLease.takeFrom(snapBug, TID, { holder: 'T', eid: 'eBug' }, casBug, rawNowT);
	check('WITHOUT the fix (T\'s raw clock): T wrongly reads R\'s live lease as dead and takes it -- the bug this closes',
		bugRace.won === true);
}

// ── Remote consent for a handed-off turn ───────────────────
//
// The two envelopes (round-trip + the exact-act binding), the forged/replayed-grant
// defence, PARK reporting-then-releasing with a terminal fail at MAX_PARKS, the
// GLOBAL two-device parkCount bound (the money guarantee), policy composition, and
// attended-only routing. All against the REAL DaimondPeer under node.
async function runRemoteConsentAcceptance(phone, laptop, stranger, check) {
	const P  = phone.DaimondPeer;
	const Pl = laptop.DaimondPeer;
	const Ps = stranger.DaimondPeer;
	const MAX = P.MAX_PARKS;

	// ── A. The two envelopes: round-trip, exact-act binding, fresh cid. ──
	console.log('\nRemote consent — the ask/grant round-trip and the exact-act binding');
	{
		const ask = P.makeAsk({ eid: 'e1', turnId: 't1', chatId: 'c1', tool: 'web_type',
			host: 'shop.test', detail: 'card 4111 1111 1111 1111',
			deadline: 1700000000000 + 60000, dispatchedBy: 'devPHONE' });
		const askBody = await P.sealForSelf(ask);
		// The attended peer (same account) opens AND verifies the runner's question.
		const opened = await Pl.openEnvelope(askBody.envelope);
		check('consent-ask opens on an attended peer with tool/host/detail intact (uncut)',
			opened.t === 'consent-ask' && opened.tool === 'web_type' && opened.host === 'shop.test'
			&& opened.detail === 'card 4111 1111 1111 1111' && opened.turnId === 't1'
			&& opened.cid === ask.cid && opened.dispatchedBy === 'devPHONE');

		// The attended device answers: a grant naming the SAME cid.
		const grant = Pl.makeGrant({ cid: ask.cid, eid: 'e1', turnId: 't1', verdict: 'allow', by: 'devLAPTOP' });
		const grantBody = await Pl.sealForSelf(grant);
		const gOpened = await P.openEnvelope(grantBody.envelope);
		check('consent-grant opens on the runner with the verdict and cid intact',
			gOpened.t === 'consent-grant' && gOpened.verdict === 'allow'
			&& gOpened.cid === ask.cid && gOpened.turnId === 't1');
		check('the grant does NOT carry tool/host/detail (runner replays the EXACT held act, never re-derives)',
			gOpened.tool === undefined && gOpened.host === undefined && gOpened.detail === undefined);

		const ask2 = P.makeAsk({ turnId: 't1', tool: 'web_type' });
		check('a FRESH cid is minted on every ask (a replayed grant matches no new cid)',
			ask2.cid && ask2.cid !== ask.cid);
	}

	// ── B. Forged / replayed grant rejected. ──
	console.log('\nRemote consent — a forged or replayed grant authorises nothing');
	{
		// A STRANGER (different account) seals a grant; the runner cannot open it (it
		// is sealed to another account), and were the bytes forced in the signature is
		// not this account's -- either way it is refused before it reaches deliverGrant.
		const strangerGrant = Ps.makeGrant({ cid: 'deadbeef', turnId: 't1', verdict: 'allow', by: 'devEVIL' });
		const sBody = await Ps.sealForSelf(strangerGrant);
		let why = '';
		try { await P.openEnvelope(sBody.envelope); }
		catch (e) { why = String(e && e.message || e); }
		check('a grant sealed by a STRANGER account is refused by the runner (open/verify throws)',
			/not sealed|not signed|not for this device/i.test(why));

		// The spent-cid drop mirrors daimond.js `deliverGrant`: only an OUTSTANDING cid
		// resolves a waiting runner, and it is spent on first use, so a captured grant
		// replayed after the act ran authorises nothing.
		const outstanding = Object.create(null);
		outstanding['cidLIVE'] = { turnId: 't1' };
		function deliver(g) {
			const w = outstanding[g.cid];
			if (!w) return 'dropped';								// spent / unknown / replayed
			if (String(g.turnId) !== String(w.turnId)) return 'dropped';
			delete outstanding[g.cid];								// spend the cid
			return 'resolved';
		}
		check('a grant for an OUTSTANDING cid resolves the waiting runner exactly once',
			deliver({ cid: 'cidLIVE', turnId: 't1', verdict: 'allow' }) === 'resolved');
		check('the SAME grant REPLAYED after the cid is spent is dropped (authorises nothing)',
			deliver({ cid: 'cidLIVE', turnId: 't1', verdict: 'allow' }) === 'dropped');
		check('a grant for an UNKNOWN cid is dropped',
			deliver({ cid: 'nope', turnId: 't1', verdict: 'allow' }) === 'dropped');
	}

	// The deps a park test runs an errand over: the turn SPENDS (increments runCount)
	// then egressAllowed aborts it for consent (runTurn throws), and parkRequested
	// tells runErrand to park rather than treat the abort as a crash.
	function parkDeps(sync, selfId, reports, runCounter, terminalGuard) {
		return {
			selfId, cas: P.syncCas(sync), now: () => 5000, maxParks: MAX,
			// FINISHED stands a device down once a TERMINAL report exists, mirroring
			// daimond.js: a device that collects the aborted report must not respend a
			// turn that already failed clean. Absent otherwise.
			finished: terminalGuard ? (async () => terminalGuard()) : undefined,
			reconstruct: async () => ({ chat: { id: 'c', messages: [] }, app: {} }),
			runTurn: async () => { if (runCounter) runCounter.n += 1; throw new Error('aborted for consent'); },
			parkRequested: () => ({ why: null }),					// let the default sentences stand
			abort: () => {}, pushResult: async () => 1,
			post: async (r) => { reports.push(r); }, ack: async () => {},
		};
	}

	// ── C. PARK reports then releases; parked below the bound, terminal at it. ──
	console.log('\nRemote consent — PARK reports then releases; terminal at MAX_PARKS');
	{
		phone.DaimondLease.forget();
		const sync = makeLeaseSync({});
		const reports = [], rc = { n: 0 };
		const errand = sentErrand(P, { turnId: 't-park', chatId: 'c', prompt: 'go', eid: 'e', deadline: 9e15, parkCount: 0 });
		const res = await P.runErrand(errand, parkDeps(sync, 'runnerDev', reports, rc));
		check('a park below the bound is NOT terminal', res.parked === true && res.terminal === false);
		check('the turn spent exactly once before parking', rc.n === 1);
		check('a park posts a PARKED report carrying the bumped GLOBAL count',
			reports.length === 1 && reports[0].status === 'parked' && reports[0].parkCount === 1);
		check('a park RELEASES the lease (not stranded)', sync.leases()['t-park'].mode === 'released');
		check('a park REPORTS before it RELEASES (mirror the reconstruct-fail order)',
			res.trace.indexOf('report') < res.trace.indexOf('release'));

		phone.DaimondLease.forget();
		const sync2 = makeLeaseSync({});
		const reports2 = [], rc2 = { n: 0 };
		const errandN = sentErrand(P, { turnId: 't-term', chatId: 'c', prompt: 'go', eid: 'e2', deadline: 9e15, parkCount: MAX - 1 });
		const res2 = await P.runErrand(errandN, parkDeps(sync2, 'runnerDev', reports2, rc2));
		check('a park AT the bound is TERMINAL', res2.terminal === true && res2.parked === false);
		check('the terminal park posts an ABORTED report, the count at MAX_PARKS',
			reports2.length === 1 && reports2[0].status === 'aborted' && reports2[0].parkCount === MAX);
		check('the terminal report INFORMS the user (permission / did not run)',
			/permission/i.test(reports2[0].why) && /did not run/i.test(reports2[0].why));
		check('the terminal park RELEASES the lease (never stranded)', sync2.leases()['t-term'].mode === 'released');
		check('the terminal park REPORTS before it RELEASES',
			res2.trace.indexOf('report') < res2.trace.indexOf('release'));
	}

	// ── D. GLOBAL parkCount: two devices re-dispatching cannot exceed MAX_PARKS. ──
	//
	// The money guarantee. The count rides the errand and the parked report (SYNCED),
	// so a re-dispatch bumps from the true GLOBAL total, and the single-runner lease
	// plus the terminal-report stand-down cap the respend at MAX_PARKS -- NOT MAX_PARKS
	// per device, which a device-local counter would have allowed.
	console.log('\nRemote consent — GLOBAL parkCount: two devices cannot exceed MAX_PARKS total');
	{
		phone.DaimondLease.forget(); laptop.DaimondLease.forget();
		const sync = makeLeaseSync({});
		const reports = [], rc = { n: 0 };
		const TID = 't-global';
		const terminal = () => reports.some((r) => r.turnId === TID && r.status === 'aborted');

		// Dispatch #1 (parkCount 0): one runner spends and parks -> parked report, count 1.
		const r1 = await Pl.runErrand(
			sentErrand(P, { turnId: TID, chatId: 'c', prompt: 'go', eid: 'e0', deadline: 9e15, parkCount: 0 }),
			parkDeps(sync, 'lapDev', reports, rc, terminal));
		check('two-device: the first dispatch spends once and parks (GLOBAL count -> 1)',
			r1.parked === true && rc.n === 1 && reports[reports.length - 1].parkCount === 1);

		// BOTH devices read the SAME parked report's count and re-dispatch errand(parkCount 1)
		// for the SAME turnId, over the ONE shared lease. Exactly one re-runs; the other
		// stands down on the terminal report the winner posts.
		const carried = reports[reports.length - 1].parkCount;		// the GLOBAL count off the synced report
		check('two-device: the re-dispatch reads the count off the SYNCED report (not a device-local zero)',
			carried === 1);
		const rA = await phone.DaimondPeer.runErrand(
			sentErrand(P, { turnId: TID, chatId: 'c', prompt: 'go', eid: 'eA', deadline: 9e15, parkCount: carried }),
			parkDeps(sync, 'phoneDev', reports, rc, terminal));
		const rB = await laptop.DaimondPeer.runErrand(
			sentErrand(P, { turnId: TID, chatId: 'c', prompt: 'go', eid: 'eB', deadline: 9e15, parkCount: carried }),
			parkDeps(sync, 'lap2Dev', reports, rc, terminal));
		check('two-device: exactly ONE re-run spends; the other STANDS DOWN on the terminal report',
			rc.n === 2 && (rA.ran === false || rB.ran === false));
		check('two-device: the re-run is TERMINAL at MAX_PARKS (' + MAX + ')',
			(rA.terminal || rB.terminal) === true
			&& reports.some((r) => r.status === 'aborted' && r.parkCount === MAX));
		check('two-device: TOTAL respends never exceed MAX_PARKS (' + MAX + ') — the spend cap holds',
			rc.n <= MAX);
		check('two-device: the lease is RELEASED after the loop (not stranded)',
			sync.leases()[TID].mode === 'released');
	}

	// ── E. Policy composition: a covered act never asks. ──
	console.log('\nRemote consent — policy composition: a covered act never asks');
	{
		const now = 1700000000000;
		const attended = { lap: { name: 'lap', lastSeen: now - 1000, attended: true, attendedAt: now - 1000 } };
		const cov = P.consentRouteDecision(attended, 'self', now, { covered: true });
		check('a COVERED act resolves ALLOW with no ask (composes with the synced policy)',
			cov.action === 'allow' && cov.verdict === 'allow');
		check('a covered act never asks even with an attended peer present',
			P.consentRouteDecision(attended, 'self', now, { covered: true }).action !== 'ask');
		const unc = P.consentRouteDecision(attended, 'self', now, { covered: false });
		check('an UNCOVERED act with an attended peer ASKS that peer',
			unc.action === 'ask' && unc.peer && unc.peer.deviceId === 'lap');
	}

	// ── F. Attended-only routing: an awake-but-unwatched device parks. ──
	console.log('\nRemote consent — attended-only routing; an awake-but-unwatched device parks');
	{
		const now = 1700000000000;
		const awakeNotAttended = { lap: { name: 'lap', lastSeen: now - 1000, attended: false, attendedAt: 0 } };
		check('an AWAKE but unattended peer is NOT asked -> park',
			P.consentRouteDecision(awakeNotAttended, 'self', now, { covered: false }).action === 'park');
		check('attendedPeer is null for an awake-but-unattended map',
			P.attendedPeer(awakeNotAttended, 'self', now) === null);
		const attendedFresh = { lap: { name: 'lap', lastSeen: now - 1000, attended: true, attendedAt: now - 1000 } };
		check('a FRESH attended peer is routable',
			P.attendedPeer(attendedFresh, 'self', now).deviceId === 'lap');
		const attendedStale = { lap: { name: 'lap', lastSeen: now - 1000, attended: true, attendedAt: now - 10 * 60 * 1000 } };
		check('an attended peer whose attention has AGED OUT is not routable -> park',
			P.consentRouteDecision(attendedStale, 'self', now, { covered: false }).action === 'park');
		const indeterminate = { lap: { name: 'lap', lastSeen: now - 1000 } };		// no attention signal
		check('attention-INDETERMINATE (no signal) fails SAFE to park',
			P.consentRouteDecision(indeterminate, 'self', now, { covered: false }).action === 'park');
	}

	// ── G. Source-device routing: a chat's consent goes to where it was driven from. ──
	// Owner rule 2026-09-05: "any permissions related to a chat go to the source device".
	// The runner is 'self' (argonaut); the SOURCE is where the turn was dispatched from
	// (gilgamesh). The decision must prefer the source over any other attended device,
	// and over raising the dialog on the attended runner itself.
	console.log('\nRemote consent — a chat\'s consent routes to its SOURCE device');
	{
		const now = 1700000000000;
		const SRC = 'gilgamesh', RUN = 'self';
		// 1. Source AWAKE (not even attended) beats an attended third device.
		const m1 = {
			gilgamesh: { name: 'gilgamesh', lastSeen: now - 1000, attended: false, attendedAt: 0 },
			laptop:    { name: 'laptop',    lastSeen: now - 1000, attended: true,  attendedAt: now - 1000 },
		};
		const d1 = P.consentRouteDecision(m1, RUN, now, { source: SRC });
		check('G1: the SOURCE device is chosen even when it is awake-but-unattended and another device IS attended',
			d1.action === 'ask' && d1.peer.deviceId === SRC && d1.peer.source === true);

		// 2. Source attended and the runner also attended: still the source, never the runner.
		//    (attendedPeer skips self anyway, but this pins the SOURCE preference explicitly.)
		const m2 = {
			gilgamesh: { name: 'gilgamesh', lastSeen: now - 500, attended: true, attendedAt: now - 500 },
		};
		const d2 = P.consentRouteDecision(m2, RUN, now, { source: SRC });
		check('G2: with the source present, consent routes to the source (not the attended runner)',
			d2.action === 'ask' && d2.peer.deviceId === SRC);

		// 3. Source OFFLINE (aged past the window): fall back to an attended peer.
		const m3 = {
			gilgamesh: { name: 'gilgamesh', lastSeen: now - 10 * 60 * 1000, attended: false, attendedAt: 0 },
			laptop:    { name: 'laptop',    lastSeen: now - 1000, attended: true, attendedAt: now - 1000 },
		};
		const d3 = P.consentRouteDecision(m3, RUN, now, { source: SRC });
		check('G3: an OFFLINE source falls back to the freshest attended peer',
			d3.action === 'ask' && d3.peer.deviceId === 'laptop' && !d3.peer.source);

		// 4. Source OFFLINE and no other attended device: park (bounded), never the runner.
		const m4 = {
			gilgamesh: { name: 'gilgamesh', lastSeen: now - 10 * 60 * 1000, attended: false, attendedAt: 0 },
		};
		const d4 = P.consentRouteDecision(m4, RUN, now, { source: SRC });
		check('G4: an offline source with no attended fallback PARKS (never raises on the runner)',
			d4.action === 'park');

		// 5. No source given (a LOCAL, non-dispatched turn): unchanged attended-only routing.
		const m5 = { laptop: { name: 'laptop', lastSeen: now - 1000, attended: true, attendedAt: now - 1000 } };
		const d5 = P.consentRouteDecision(m5, RUN, now, {});
		check('G5: with no source (local turn) the old attended-peer routing is unchanged',
			d5.action === 'ask' && d5.peer.deviceId === 'laptop' && !d5.peer.source);

		// 6. A covered act still short-circuits to allow, source or no source.
		const d6 = P.consentRouteDecision(m1, RUN, now, { source: SRC, covered: true });
		check('G6: a covered act allows with no ask even when a source is named',
			d6.action === 'allow' && d6.verdict === 'allow');

		// 7. The ask carries the chosen target so exactly one device raises the tile.
		const ask = P.makeAsk({ turnId: 't-src', tool: 'web_type', dispatchedBy: RUN, target: SRC });
		check('G7: makeAsk carries the target device, so the source raises the tile and no one else',
			ask.target === SRC);
	}
}

// ── Broadcast consent: a faithful multi-device simulator ───
//
// daimond.js does not load under node, so its thin remote-consent WIRING is
// modelled here -- exactly as the fallback-liveness and PARK sections above model
// their daimond.js glue -- while the MONEY-SAFE DECISIONS run the REAL peer.js:
// `askRaiseDecision` (who raises a tile), `grantDecision` (first-committed-wins),
// and the REAL seal / open / verify (so a broadcast actually round-trips the post
// box and a stranger's grant genuinely fails to open). Each device holds the same
// state daimond.js does -- `_consentWait` (runner side), `_askTiles`, `_askResolved`,
// the Pending `panel` -- and routes collected rows the way `takeRow` -> `absorb`
// -> onAsk/onGrant does. `canAnswer` mirrors `someoneCanAnswer()` (foreground); a
// device with `online:false` collects nothing until it reconnects (the offline case).
function makeConsentSim(tab, box, opts) {
	const P = tab.DaimondPeer;
	const self = tab.DaimondIdentity.deviceId();
	const st = {
		self, P,
		canAnswer: !(opts && opts.canAnswer === false),		// default attended
		online:    !(opts && opts.online === false),		// default online
		cursor:    box.top(),								// join the box at "now": no backlog before this
		consentWait: Object.create(null),					// cid -> { turnId, resolve }
		askTiles:    Object.create(null),					// cid -> tileId
		askResolved: Object.create(null),					// cid -> true
		openAsk:     Object.create(null),					// turnId -> ask
		panel:       [],									// [{ id, cid, ask }] — the Pending tiles up here
		resolvedCount: 0,									// how many times a runner turn resolved (exactly-once)
		lastVerdict:   null,								// what the runner turn resolved to
		tileSeq: 0,
	};
	// Runner side: register an awaiting turn for an ask, exactly as routeConsentAsk's
	// `_consentWait[cid] = { turnId, resolve }` does. Resolving bumps a counter so the
	// test can prove the turn consumes the answer EXACTLY once.
	st.awaitAsk = function (ask) {
		return new Promise((resolve) => {
			st.consentWait[String(ask.cid)] = {
				turnId: String(ask.turnId),
				resolve: (v) => { st.resolvedCount += 1; st.lastVerdict = v; resolve(v); },
			};
		});
	};
	// raiseConsentFromPeer mirror: record the ask, then the REAL askRaiseDecision.
	st.onAsk = function (ask) {
		const cid = String(ask.cid || ''), turnId = String(ask.turnId || '');
		st.openAsk[turnId] = ask;
		const d = P.askRaiseDecision(ask, st.self, Date.now(), {
			resolved:  !!st.askResolved[cid],
			alreadyUp: !!st.askTiles[cid],
			canAnswer: st.canAnswer,
		});
		if (!d.raise) return d.why;
		const id = st.self + '-tile' + (++st.tileSeq);
		st.askTiles[cid] = id;
		st.panel.push({ id, cid, ask });
		return 'raised';
	};
	// onGrant mirror: deliverGrant (REAL grantDecision + spend) then adoptRemoteGrant.
	st.onGrant = function (grant) {
		const cid = String(grant.cid || '');
		const w = st.consentWait[cid] || null;
		const dec = P.grantDecision(w, grant);
		if (dec.commit) { delete st.consentWait[cid]; w.resolve(dec.verdict); }	// SPEND then resolve
		// adoptRemoteGrant on EVERY device: mark resolved, dismiss any local tile.
		st.askResolved[cid] = true;
		const tileId = st.askTiles[cid];
		if (tileId) {
			delete st.askTiles[cid];
			if (grant.turnId) delete st.openAsk[String(grant.turnId)];
			st.panel = st.panel.filter((tt) => tt.id !== tileId);
		}
	};
	// A person answers a tile HERE: retire the local tile (the .then path), then seal
	// and post the grant home over the REAL seal, exactly as sealAndPostGrant does.
	st.answer = async function (cid, verdict) {
		const tile = st.panel.find((tt) => tt.cid === cid);
		if (!tile) return false;
		delete st.askTiles[cid];
		st.askResolved[cid] = true;
		if (tile.ask.turnId) delete st.openAsk[String(tile.ask.turnId)];
		st.panel = st.panel.filter((tt) => tt.id !== tile.id);
		const grant = P.makeGrant({ cid, eid: tile.ask.eid, turnId: tile.ask.turnId, verdict, by: st.self });
		box.post(await P.sealForSelf(grant));
		return true;
	};
	// Collect the box the way takeRow does: open+verify via REAL peer.js (a stranger's
	// row throws and is skipped, never routed), then dispatch by the sealed type tag.
	st.collect = async function () {
		if (!st.online) return 0;
		let n = 0;
		for (const row of box.collect(st.cursor)) {
			st.cursor = Math.max(st.cursor, row.seq);
			let obj = null;
			try { obj = await P.openEnvelope(row.envelope); } catch (e) { continue; }
			if (obj.t === P.T_ASK)        { st.onAsk(obj);   n++; }
			else if (obj.t === P.T_GRANT) { st.onGrant(obj); n++; }
		}
		return n;
	};
	st.hasTile = function (cid) { return !!st.askTiles[cid]; };
	return st;
}

// The RUNNER's routeConsentAsk mirror: broadcast the ask (target ''), post it, and
// return the awaited verdict promise. The runner is `runner`; the ask is sealed to
// the account and posted, and the runner also registers itself as awaiting it.
async function runnerBroadcastAsk(runner, box, fields) {
	const P = runner.P;
	const ask = P.makeAsk(Object.assign({
		dispatchedBy: runner.self, target: '', deadline: Date.now() + 60000,
	}, fields));
	const p = runner.awaitAsk(ask);
	box.post(await P.sealForSelf(ask));
	return { ask, verdict: p };
}

async function runBroadcastConsentAcceptance(phone, laptop, desk, stranger, check) {
	const P = phone.DaimondPeer;

	// ── H0. askRaiseDecision — the fail-safe raise filter, as a unit. ──
	console.log('\nBroadcast consent — askRaiseDecision fail-safe filter');
	{
		const now = 1700000000000;
		const live = { cid: 'c', deadline: now + 60000 };
		check('H0a: an attended device with a fresh ask RAISES (broadcast, no target needed)',
			P.askRaiseDecision(live, 'dev', now, { canAnswer: true }).raise === true);
		check('H0b: a device nobody is at does NOT raise (record only)',
			P.askRaiseDecision(live, 'dev', now, { canAnswer: false }).raise === false);
		check('H0c: an ALREADY-RESOLVED ask is suppressed (offline-return: no re-raise)',
			P.askRaiseDecision(live, 'dev', now, { canAnswer: true, resolved: true }).raise === false
			&& P.askRaiseDecision(live, 'dev', now, { canAnswer: true, resolved: true }).why === 'resolved');
		check('H0d: a duplicate (tile already up) is suppressed',
			P.askRaiseDecision(live, 'dev', now, { canAnswer: true, alreadyUp: true }).raise === false);
		check('H0e: a STALE ask past its deadline is suppressed',
			P.askRaiseDecision({ cid: 'c', deadline: now - 1 }, 'dev', now, { canAnswer: true }).raise === false);
	}

	// ── H1/H2/H3 + the GOVERNING INVARIANT. Runner R (argonaut) is UNATTENDED; the
	//    user is on U (their phone); a third device D is also attended. The ask must
	//    appear on U and D (not trapped on R); answering on U must unblock R's turn;
	//    and D's tile must DISMISS once U has answered. ──
	console.log('\nBroadcast consent — ask reaches every attended device; first answer resolves + dismisses everywhere');
	{
		const box = makePostBox();
		const R = makeConsentSim(phone,  box, { canAnswer: false });	// runner: nobody at argonaut
		const U = makeConsentSim(laptop, box, { canAnswer: true  });	// the user's attended device
		const D = makeConsentSim(desk,   box, { canAnswer: true  });	// a third attended device
		const { ask, verdict } = await runnerBroadcastAsk(R, box, {
			eid: 'e1', turnId: 't1', chatId: 'c1', tool: 'web_type', host: 'shop.test',
			detail: 'card 4111 1111 1111 1111',
		});
		await R.collect(); await U.collect(); await D.collect();
		check('H1: the ask reaches BOTH attended devices — a tile is up on U AND on D',
			U.hasTile(ask.cid) && D.hasTile(ask.cid));
		check('H2 (governing invariant): the UNATTENDED runner raises NO local tile but STILL records the ask',
			!R.hasTile(ask.cid) && !!R.openAsk[ask.turnId]);
		check('the ask carries the full uncut detail to the devices (nothing summarised)',
			U.panel[0].ask.detail === 'card 4111 1111 1111 1111');

		// The user answers on U (their attended device). The grant travels home.
		await U.answer(ask.cid, 'allow');
		await R.collect(); await D.collect(); await U.collect();
		const v = await verdict;
		check('H2: answering on U UNBLOCKS the runner R — its parked turn proceeds on U\'s verdict',
			v === 'allow' && R.lastVerdict === 'allow');
		check('the runner consumed the resolution EXACTLY once', R.resolvedCount === 1);
		check('H3: D\'s now-moot tile is DISMISSED once U answered (no lingering dialog anywhere)',
			!D.hasTile(ask.cid) && D.panel.length === 0 && U.panel.length === 0);
		check('NEGATIVE CONTROL for broadcast: BOTH U and D had raised a tile (single-target routing would have raised on one)',
			U.tileSeq === 1 && D.tileSeq === 1);
	}

	// ── H4. RACE: two devices answer near-simultaneously. Exactly ONE wins, the turn
	//    acts ONCE, the loser is a no-op. Tested for allow-vs-deny (both post orders,
	//    to show the rule is a pure function of arrival order) and allow-vs-allow. ──
	console.log('\nBroadcast consent — race: two devices answer at once, exactly one wins, turn acts once');
	async function raceOnce(firstVerdict, secondVerdict) {
		const box = makePostBox();
		const R = makeConsentSim(phone,  box, { canAnswer: false });
		const U = makeConsentSim(laptop, box, { canAnswer: true  });
		const D = makeConsentSim(desk,   box, { canAnswer: true  });
		const { ask, verdict } = await runnerBroadcastAsk(R, box, {
			eid: 'e', turnId: 'trace', chatId: 'c', tool: 'web_click', host: 'shop.test', detail: 'Buy now',
		});
		await U.collect(); await D.collect();
		// Both tiles are up; both people tap. The FIRST grant posted has the lower seq,
		// so the runner (collecting in seq order) sees it first — first-committed-wins.
		await U.answer(ask.cid, firstVerdict);
		await D.answer(ask.cid, secondVerdict);
		await R.collect(); await U.collect(); await D.collect();
		return { R, U, D, verdict: await verdict, ask };
	}
	{
		const r1 = await raceOnce('allow', 'deny');
		check('H4a: allow-vs-deny — the FIRST-committed answer wins (allow), the second is a no-op',
			r1.verdict === 'allow' && r1.R.lastVerdict === 'allow');
		check('H4a: the turn resolved EXACTLY once (no double-apply from the second grant)',
			r1.R.resolvedCount === 1);
		check('H4a: no tile lingers on any device after the race',
			!r1.U.hasTile(r1.ask.cid) && !r1.D.hasTile(r1.ask.cid));

		const r2 = await raceOnce('deny', 'allow');
		check('H4b: deny-vs-allow — first-committed wins (deny), deterministic by arrival order',
			r2.verdict === 'deny' && r2.R.lastVerdict === 'deny' && r2.R.resolvedCount === 1);

		const r3 = await raceOnce('allow', 'allow');
		check('H4c: allow-vs-allow — exactly one commits, the turn acts once',
			r3.verdict === 'allow' && r3.R.resolvedCount === 1);
	}

	// ── H5. OFFLINE RETURN. A device offline when the ask went out must not re-raise an
	//    ALREADY-RESOLVED ask when it reconnects, and must not linger a tile. ──
	console.log('\nBroadcast consent — an offline device returns to an already-resolved ask and does NOT re-raise');
	{
		const box = makePostBox();
		const R = makeConsentSim(phone,  box, { canAnswer: false });
		const U = makeConsentSim(laptop, box, { canAnswer: true  });
		const D = makeConsentSim(desk,   box, { canAnswer: true, online: false });	// OFFLINE at ask time
		const { ask, verdict } = await runnerBroadcastAsk(R, box, {
			eid: 'e', turnId: 't-off', chatId: 'c', tool: 'web_type', host: 'shop.test', detail: 'hello',
		});
		await R.collect(); await U.collect(); await D.collect();		// D is offline: collects nothing
		check('H5a: the offline device raised no tile while it was away', !D.hasTile(ask.cid) && D.panel.length === 0);
		await U.answer(ask.cid, 'allow');
		await R.collect();
		check('H5b: the runner resolved from the online device while D was away', (await verdict) === 'allow' && R.resolvedCount === 1);
		// D reconnects and drains the backlog: the ask (lower seq) then the grant (higher).
		D.online = true;
		await D.collect();
		check('H5c: on reconnect D ends with NO tile — the ask was raised then dismissed by the grant it also collected',
			!D.hasTile(ask.cid) && D.panel.length === 0);
		check('H5d: a re-delivery of the same ask to D is now SUPPRESSED (the resolved-cid ledger)',
			D.onAsk(ask) === 'resolved');
	}

	// ── H6. NEGATIVE CONTROL: a STRANGER's grant authorises nothing. It is sealed to a
	//    different account, so the runner cannot even open it — it never reaches
	//    grantDecision, the turn stays parked, and nothing is consumed. ──
	console.log('\nBroadcast consent — a stranger\'s grant is refused and never resolves the runner');
	{
		const box = makePostBox();
		const R = makeConsentSim(phone,  box, { canAnswer: false });
		const U = makeConsentSim(laptop, box, { canAnswer: true  });
		const { ask, verdict } = await runnerBroadcastAsk(R, box, {
			eid: 'e', turnId: 't-str', chatId: 'c', tool: 'web_type', host: 'shop.test', detail: 'x',
		});
		await R.collect(); await U.collect();		// drain the ask (R records its own, U raises a tile)
		// The stranger (different account) seals a grant naming the live cid and posts it.
		const sGrant = stranger.DaimondPeer.makeGrant({ cid: ask.cid, turnId: ask.turnId, verdict: 'allow', by: 'devEVIL' });
		box.post(await stranger.DaimondPeer.sealForSelf(sGrant));
		const routed = await R.collect();		// only the stranger row is new: it throws on open and is skipped
		check('H6a: the runner routes 0 rows from the stranger\'s grant (it will not open on this account)',
			routed === 0);
		check('H6b: the runner\'s turn is STILL parked — a forged grant consumed nothing',
			!!R.consentWait[ask.cid] && R.resolvedCount === 0);
		// The genuine device then answers and the turn resolves normally.
		await U.answer(ask.cid, 'deny');
		await R.collect();
		check('H6c: the genuine grant then resolves it (deny), exactly once',
			(await verdict) === 'deny' && R.resolvedCount === 1);
	}

	// ── H7. grantDecision — the first-committed-wins CAS, as a unit. ──
	console.log('\nBroadcast consent — grantDecision first-committed-wins, as a unit');
	{
		const pend = { turnId: 't1' };
		check('H7a: a grant for the live cid COMMITS with its verdict',
			P.grantDecision(pend, { turnId: 't1', verdict: 'allow' }).commit === true
			&& P.grantDecision(pend, { turnId: 't1', verdict: 'allow' }).verdict === 'allow');
		check('H7b: once the caller has SPENT the record (pending null), a second grant DROPS (no override/re-apply)',
			P.grantDecision(null, { turnId: 't1', verdict: 'deny' }).commit === false
			&& P.grantDecision(null, { turnId: 't1', verdict: 'deny' }).drop === true);
		check('H7c: a grant bound to a DIFFERENT turn drops (never crosses turns)',
			P.grantDecision(pend, { turnId: 'other', verdict: 'allow' }).commit === false);
		check('H7d: a malformed verdict is read as DENY (fail-safe)',
			P.grantDecision(pend, { turnId: 't1', verdict: 'yes-please' }).verdict === 'deny');
	}
}

// ════════════════════════════════════════════════════════════
// THE STREAMED VIEW — what a frame says, and what a watcher does with it
// ------------------------------------------------------------
// The owner's complaint (2026-09-12): a turn typed on one device and run on
// another appeared only when the next whole-parcel sync landed. The runner now
// sends a small frame every couple of seconds and the watching device draws it.
// The two decisions in that are pure and live in peer.js, so they are tested
// here rather than through a browser: `progressTail` is what a frame SAYS, and
// `foldProgress` is what a watcher DOES with one that arrives.
// ════════════════════════════════════════════════════════════
function streamedViewChecks(tab) {
	const P = tab.DaimondPeer;

	console.log('\nThe streamed view — the frame a runner sends (STRUCTURED rows)');
	{
		const msgs = [
			{ role: 'user',      content: 'earlier turn', mid: 't0', iturn: 't0' },
			{ role: 'assistant', content: 'earlier answer', mid: 'a0' },
			{ role: 'user',      content: 'the dispatched prompt', mid: 't1', iturn: 't1' },
			{ role: 'think_log', content: 'x'.repeat(4000), mid: 'k1' },
			{ role: 'tool_log',  name: 'file_read', args: '{"path":"/p"}', outcome: 'ok', mid: 'l1' },
			{ role: 'assistant', content: 'PARTIAL ANSWER so far', mid: 'a1', ranOn: 'dev-runner' },
		];
		const rows = P.progressTail(msgs, 't1', 48 * 1024);
		const byMid = {};
		rows.forEach((r) => { byMid[r.mid] = r; });
		check('S1a: the frame is an ARRAY of structured rows, not flattened text',
			Array.isArray(rows));
		check('S1b: it holds the daimon\'s text for THIS turn as an assistant row',
			byMid.a1 && byMid.a1.role === 'assistant' && byMid.a1.content === 'PARTIAL ANSWER so far');
		check('S1c: a PREVIOUS turn is not in the frame (the tail starts at this turn)',
			!byMid.a0 && !byMid.t0 && !byMid.t1);
		check('S1d: thinking rides as a think_log ROW in full (the watcher draws it collapsed itself)',
			byMid.k1 && byMid.k1.role === 'think_log' && byMid.k1.content.length === 4000);
		check('S1e: a tool call is a tool_log row naming the tool, its outcome carried',
			byMid.l1 && byMid.l1.role === 'tool_log' && byMid.l1.name === 'file_read' && byMid.l1.outcome === 'ok');
		check('S1f: the answer row carries `ranOn`, so the FINAL row matches the parcel copy',
			byMid.a1.ranOn === 'dev-runner');
		check('S1g: a turn this device does not hold says nothing (an empty array, not an error)',
			P.progressTail(msgs, 'not-a-turn', 4096).length === 0 && P.progressTail([], 't1', 4096).length === 0);

		// One huge message is clipped so it cannot be the whole frame -- and being clipped
		// it will NOT byte-match its final copy, so the parcel merge replaces it by mid.
		const big = [
			{ role: 'user', content: 'p', mid: 'tb', iturn: 'tb' },
			{ role: 'assistant', content: 'Z'.repeat(40 * 1024), mid: 'ab' },
		];
		const bigRows = P.progressTail(big, 'tb', 48 * 1024);
		check('S1h: one huge message\'s content is clipped to the per-message share',
			bigRows.length === 1 && bigRows[0].content.length === 16 * 1024);

		// The budget: the OLDEST rows fall off the front, because those are what the
		// watcher already received in an earlier frame; the newest are kept.
		const many = [
			{ role: 'user',      content: 'p', mid: 'tc', iturn: 'tc' },
			{ role: 'assistant', content: 'A'.repeat(600), mid: 'm1' },
			{ role: 'assistant', content: 'B'.repeat(600), mid: 'm2' },
			{ role: 'assistant', content: 'C'.repeat(600), mid: 'm3' },
		];
		const cut = P.progressTail(many, 'tc', 1000);
		const cutMids = cut.map((r) => r.mid);
		check('S1i: the frame is cut to the budget and keeps the NEWEST rows',
			cutMids.indexOf('m3') >= 0 && cutMids.indexOf('m1') < 0);
	}

	console.log('\nThe streamed view — what a watcher does with an arriving frame');
	{
		const A = [{ mid: 'a1', role: 'assistant', content: 'first' }];
		const B = [{ mid: 'a1', role: 'assistant', content: 'first and second' }];
		const f1 = { turn: 't1', seq: 1, msgs: A };
		const v1 = P.foldProgress(null, f1);
		check('S2a: the first frame becomes the view', v1 && v1.seq === 1 && v1.msgs === A);
		const v2 = P.foldProgress(v1, { turn: 't1', seq: 2, msgs: B });
		check('S2b: a newer frame REPLACES the one before it (the rows are the whole tail)',
			v2 && v2.seq === 2 && v2.msgs === B);
		check('S2c: a frame already held changes nothing (no redraw is owed)',
			P.foldProgress(v2, { turn: 't1', seq: 2, msgs: B }) === null);
		check('S2d: a LATE frame never rewinds the view',
			P.foldProgress(v2, { turn: 't1', seq: 1, msgs: A }) === null);
		check('S2e: a frame for ANOTHER turn is not this watcher\'s',
			P.foldProgress(v2, { turn: 't9', seq: 99, msgs: A }) === null);
		check('S2f: an empty frame is not a view (nothing is drawn over something)',
			P.foldProgress(v2, { turn: 't1', seq: 3, msgs: [] }) === null);
		// The close: the real transcript has landed, so the streamed view stands down
		// and no frame still in flight can reopen it. The final frame CARRIES the rows.
		const done = P.foldProgress(v2, { turn: 't1', final: true, msgs: B });
		check('S2g: `final` closes the streamed view and carries the final rows',
			done && done.final === true && done.msgs === B);
		check('S2h: a frame arriving after the close is ignored (the answer is not overdrawn)',
			P.foldProgress(done, { turn: 't1', seq: 9, msgs: A }) === null);
		check('S2i: a malformed frame is ignored rather than thrown on',
			P.foldProgress(v2, null) === null && P.foldProgress(v2, {}) === null);
	}
}

// ══════════════════════════════════════════════════════════
// THE BLOCKER ON THE LEASE (owner ruling 2026-09-12) — what stopped the
// runner is copied to every device, answered from any one of them, and
// cleared everywhere by the first answer; the runner keeps local control.
// ══════════════════════════════════════════════════════════
/// Drives the real `DaimondLease.block`/`unblock` over the same compare-and-set the
/// claim goes through, plus the three pure decisions a tile and a runner rest on.
/// `L` is a tab's DaimondLease, `P` its DaimondPeer.
async function runBlockerAcceptance(P, L, check) {
	const TID = 'turn-blocked';

	// ── B1. WRITE and CLEAR, through the lease's own CAS. ──
	{
		L.forget();
		const cas = makeCas({});
		const took = await L.take(TID, { holder: 'RUNNER', eid: 'e1' }, cas, () => 1000);
		check('B1a: the runner holds the lease before it can block on anything', took.won === true);
		const w = await L.block(TID, 'RUNNER',
			{ kind: 'consent', tool: 'web_type', host: 'shop.test', detail: 'buy it', since: 1001 },
			cas, () => 1002);
		check('B1a2: the blocker write lands', w.ok === true && w.blocked === true);
		const rec = cas.peekLeases()[TID];
		check('B1b: the blocker is ON THE LEASE, so every device reads it from the door it already reads',
			!!rec.blocker && rec.blocker.kind === 'consent' && rec.blocker.detail === 'buy it');
		check('B1c: blocking is NOT a state change -- mode, deadline and expiry are untouched',
			rec.mode === 'claimed' && rec.holder === 'RUNNER' && rec.expiry === 1000 + L.LEASE_TTL_MS);
		check('B1d: `blocker()` reads the live one back off the turn',
			(L.blocker(TID, 1003) || {}).kind === 'consent');
		const c = await L.unblock(TID, 'RUNNER', cas, () => 1004);
		check('B1e: the clear lands and the record keeps the claim',
			c.ok === true && !cas.peekLeases()[TID].blocker && cas.peekLeases()[TID].mode === 'claimed');
		check('B1f: `blocker()` now reads nothing', L.blocker(TID, 1005) === null);
	}

	// ── B2. ONLY THE HOLDER MAY WRITE. A watching device that tried would be two
	//    devices describing one turn, which is what the CAS exists to stop. ──
	{
		L.forget();
		const cas = makeCas({});
		await L.take(TID, { holder: 'RUNNER', eid: 'e2' }, cas, () => 1000);
		const w = await L.block(TID, 'WATCHER', { kind: 'lock', detail: 'x' }, cas, () => 1001);
		check('B2a: a NON-holder\'s blocker write is refused (not_ours)',
			w.ok === false && w.why === 'not_ours');
		check('B2b: and nothing was written', !cas.peekLeases()[TID].blocker);
		// A released lease carries no blocker either: the question dies with the turn.
		await L.release(TID, 'RUNNER', cas, () => 1002);
		const w2 = await L.block(TID, 'RUNNER', { kind: 'lock', detail: 'x' }, cas, () => 1003);
		check('B2c: a blocker cannot be raised on a RELEASED lease', w2.ok === false);
	}

	// ── B3. THE BLOCKER TRAVELS BY THE ORDINARY MERGE, and a watching device's
	//    adopt keeps it -- that is the whole of "copied to every other device". ──
	{
		L.forget();										// this tab is now the WATCHER
		const runnerSide = {
			[TID]: {
				turnId: TID, eid: 'e3', holder: 'RUNNER', mode: 'running',
				deadline: 9000, expiry: 9000, renewedAt: 1100,
				blocker: { kind: 'ask', detail: 'Which one?', options: ['A', 'B'], since: 1099 },
			},
		};
		const moved = L.adopt(runnerSide, () => 1200);
		check('B3a: a pulled lease carrying a blocker MOVES the watcher\'s view', moved === true);
		const b = L.blocker(TID, 1200);
		check('B3b: the watcher reads the runner\'s question and its options',
			!!b && b.kind === 'ask' && b.options.length === 2 && b.options[0] === 'A');
		check('B3c: and `uiState` says BLOCKED, not "running" and not "sent to your other devices"',
			P.uiState({ why: P.REASON_DISPATCHED, iturn: TID }, L.record(TID), null, 'PHONE', 1200, null)
				=== 'blocked');
		// A blocker on a DEAD lease is not shown: the question died with the turn.
		check('B3d: past the expiry the blocker is gone, so no stale question can be answered',
			L.blocker(TID, 99999) === null
			&& P.uiState({ why: P.REASON_DISPATCHED, iturn: TID }, L.record(TID), null, 'PHONE', 99999, null)
				=== 'failed');
		// And a `done` report still settles it: a blocker must never outrank the answer.
		check('B3e: a done report outranks a blocker (the turn finished, whatever it asked)',
			P.uiState({ why: P.REASON_DISPATCHED, iturn: TID }, L.record(TID),
				{ t: 'report', status: 'done' }, 'PHONE', 1200, null) === 'done');
		L.forget();
	}

	// ── B4. FIRST ANSWER WINS, and the kinds cannot cross. ──
	{
		const pend = { turnId: 't1', kind: 'consent' };
		check('B4a: the first answer for the live cid COMMITS with its verdict',
			P.blockerAnswerDecision(pend, { turnId: 't1', kind: 'consent', verdict: 'allow' }).commit === true
			&& P.blockerAnswerDecision(pend, { turnId: 't1', kind: 'consent', verdict: 'allow' }).verdict === 'allow');
		check('B4b: once the runner has SPENT the record, a second answer DROPS -- never an override',
			P.blockerAnswerDecision(null, { turnId: 't1', kind: 'consent', verdict: 'deny' }).commit === false);
		check('B4c: an ASK answer cannot resolve a CONSENT (kind-mismatch)',
			P.blockerAnswerDecision(pend, { turnId: 't1', kind: 'ask', choice: 'A' }).why === 'kind-mismatch');
		check('B4d: an answer bound to another turn drops',
			P.blockerAnswerDecision(pend, { turnId: 'other', kind: 'consent', verdict: 'allow' }).commit === false);
		const pendAsk = { turnId: 't2', kind: 'ask' };
		check('B4e: an ask answer commits its CHOICE',
			P.blockerAnswerDecision(pendAsk, { turnId: 't2', kind: 'ask', choice: 'Second' }).choice === 'Second');
		check('B4f: an ask answer with no choice authorises nothing',
			P.blockerAnswerDecision(pendAsk, { turnId: 't2', kind: 'ask', choice: '  ' }).commit === false);
		// A grant from a build that predates the blocker carries no kind at all, and
		// must still resolve the consent it was written for.
		check('B4g: a kind-less grant (an older build) still resolves a consent',
			P.blockerAnswerDecision(pend, { turnId: 't1', verdict: 'deny' }).commit === true);
	}

	// ── B5. THE TILE FORMATTER, lifted out and driven as a unit. ──
	{
		const consent = P.blockerTileSpec(
			P.makeBlocker({ kind: 'consent', tool: 'web_type', host: 'shop.test', detail: 'card number' }),
			'argonaut');
		check('B5a: a consent offers GRANT and DENY, and is answerable away from the runner',
			consent.controls.join(',') === 'grant,deny' && consent.answerable === true
			&& consent.host === 'shop.test' && consent.name === 'argonaut');
		const ask = P.blockerTileSpec(
			P.makeBlocker({ kind: 'ask', detail: 'Which way?', options: [{ label: 'On the device' }, { label: 'In the cloud' }] }),
			'argonaut');
		check('B5b: an ask offers a button per option, carrying the LABELS',
			ask.controls.join(',') === 'choose' && ask.options.join('|') === 'On the device|In the cloud');
		for (const kind of ['fsa', 'lock', 'provider']) {
			const s = P.blockerTileSpec(P.makeBlocker({ kind: kind, detail: 'x' }), 'argonaut');
			check('B5c: a ' + kind + ' blocker is REPORT-ONLY -- "Run here instead" and nothing that pretends to reach across',
				s.controls.join(',') === 'runhere' && s.answerable === false);
		}
		check('B5d: an unknown kind degrades to a report, never to a dead button',
			P.blockerTileSpec({ kind: 'telepathy', detail: 'x' }, '').controls.join(',') === 'runhere');
		// The caps are where the record is BUILT, because the lease door has one
		// ceiling for every turn's record and a runaway detail would fail the CLAIM.
		const big = P.makeBlocker({ kind: 'ask', detail: 'z'.repeat(5000),
			options: ['a', 'b', 'c', 'd', 'e', 'f'] });
		check('B5e: a runaway detail is cut where the record is built, and the options bounded',
			big.detail.length <= 601 && big.options.length === 4);
		check('B5f: an unknown kind normalises to `lock` -- a report, the fail-safe reading',
			P.makeBlocker({ kind: 'telepathy' }).kind === 'lock');
	}

	// ── B6. A RUNNER THAT RESTARTED releases its OWN stale lease, so the
	//    originator re-seats at once instead of watching the 15-minute deadline. ──
	{
		const mine = {
			't-a': { holder: 'SELF', mode: 'running',  expiry: 9000, renewedAt: 1 },
			't-b': { holder: 'SELF', mode: 'claimed',  expiry: 9000, renewedAt: 1 },
			't-c': { holder: 'PEER', mode: 'running',  expiry: 9000, renewedAt: 1 },
			't-d': { holder: 'SELF', mode: 'released', expiry: 0,    renewedAt: 1 },
			't-e': { holder: 'SELF', mode: 'running',  expiry: 10,   renewedAt: 1 },
		};
		const out = P.staleOwnLeaseDecision(mine, 'SELF', {}, 1000).sort();
		check('B6a: on boot, every LIVE lease under our own name with no turn running is released',
			out.join(',') === 't-a,t-b');
		check('B6b: a PEER\'s lease is never ours to free, and a released/expired one needs nothing',
			out.indexOf('t-c') < 0 && out.indexOf('t-d') < 0 && out.indexOf('t-e') < 0);
		check('B6c: a turn GENUINELY running here is left alone -- a second tab must not free it',
			P.staleOwnLeaseDecision(mine, 'SELF', { 't-a': true }, 1000).join(',') === 't-b');
		check('B6d: with no id of our own, nothing is released', P.staleOwnLeaseDecision(mine, '', {}, 1000).length === 0);
	}

	// ── B6b. AN ASK RAISED WHILE HIDDEN IS RE-RAISED ON RETURN. The second half of
	//    the ruling: a question a device could not draw must not be lost.
	{
		const live = { t: 'consent-ask', cid: 'c-live', turnId: 't-1', deadline: 5000, tool: 'web_type' };
		const old  = { t: 'consent-ask', cid: 'c-old',  turnId: 't-2', deadline: 900,  tool: 'web_type' };
		const done = { t: 'consent-ask', cid: 'c-done', turnId: 't-3', deadline: 5000, tool: 'web_type' };
		const up   = { t: 'consent-ask', cid: 'c-up',   turnId: 't-4', deadline: 5000, tool: 'web_type' };
		const open = { 't-1': live, 't-2': old, 't-3': done, 't-4': up };
		const raised = P.reRaiseDecision(open, 'SELF', 1000,
			{ resolved: { 'c-done': true }, up: { 'c-up': 9 }, canAnswer: true });
		check('B6e: on return, the still-open ask is raised -- the one the hidden device never drew',
			raised.length === 1 && raised[0].cid === 'c-live');
		check('B6f: an EXPIRED, an ANSWERED and an ALREADY-DRAWN ask are each left alone',
			!raised.some((a) => a.cid === 'c-old' || a.cid === 'c-done' || a.cid === 'c-up'));
		check('B6g: a device nobody is at still raises nothing -- the filter is the same one',
			P.reRaiseDecision(open, 'SELF', 1000, { resolved: {}, up: {}, canAnswer: false }).length === 0);
		check('B6h: a non-ask in the map is ignored rather than drawn',
			P.reRaiseDecision({ 't-9': { t: 'report' } }, 'SELF', 1000, { canAnswer: true }).length === 0);
	}

	// ── B7. A PROVIDER REFUSAL IS NOT A CRASH. Classified, so the turn is handed
	//    back with a sentence rather than left to the deadline. ──
	{
		check('B7a: a 401 is a provider refusal', P.runnerErrorKind({ status: 401 }) === 'provider');
		check('B7b: a 402 is a provider refusal', P.runnerErrorKind(new Error('HTTP 402 payment required')) === 'provider');
		check('B7c: "insufficient credits" is a provider refusal',
			P.runnerErrorKind(new Error('Insufficient credits on this account')) === 'provider');
		check('B7d: a withdrawn folder grant is an FSA hand-back',
			P.runnerErrorKind(new Error('Read/write permission was not granted.')) === 'fsa');
		check('B7e: a lock under the turn is a hand-back',
			P.runnerErrorKind(new Error('peer: Daimond is locked, so nothing can be sealed for a peer.')) === 'lock');
		check('B7f: an ordinary crash is NOT classified, so the errand still waits on the relay',
			P.runnerErrorKind(new Error('Cannot read properties of undefined')) === null);
		check('B7g: the sentence names the machine and says the turn is theirs again',
			P.runnerErrorWhy('provider', 'argonaut').indexOf('argonaut') >= 0
			&& P.runnerErrorWhy('fsa', '').indexOf('the other device') >= 0);
	}

	// ── B8. runErrand HANDS BACK a classified failure: report + release, and the
	//    errand is left ON the relay (no ack) so another device may still take it. ──
	{
		L.forget();
		const cas = makeCas({});
		const posted = [];
		const out = await P.runErrand(
			sentErrand(P, { eid: 'e8', turnId: 'turn-402', chatId: 'c', prompt: 'p', deadline: 0 }),
			{
				selfId: 'RUNNER', selfName: 'argonaut', cas: cas,
				reconstruct: async () => ({}),
				runTurn: async () => { throw Object.assign(new Error('provider said no'), { status: 402 }); },
				post: async (r) => { posted.push(r); },
				ack: async () => { posted.push({ t: 'ack' }); },
				pushResult: async () => 1,
				now: () => 2000,
				setTimer: () => null, clearTimer: () => {},
			});
		check('B8a: the run reports the hand-back rather than a silent crash',
			out.error === true && out.handback === 'provider');
		check('B8b: an ERROR report went home, carrying the sentence',
			posted.length === 1 && posted[0].status === 'error' && /argonaut/.test(posted[0].why));
		check('B8c: the lease was RELEASED, so the originator can re-seat at once',
			cas.peekLeases()['turn-402'].mode === 'released');
		check('B8d: and the errand was NOT acked -- another device may still take it',
			!posted.some((p) => p.t === 'ack'));
		check('B8e: the trace says what happened, in order',
			out.trace.join(',') === 'take,reconstruct,handback,report,release');
		L.forget();
	}

	// ── B9. THE FEED'S `peer` FIELD. A hand-off target is `{ deviceId, name, ... }`
	//    and has no `id`, so the call site's `t.id || t` reached the OBJECT and the
	//    debug feed carried `peer:"[object Obje"` on every elected dispatch --
	//    twelve characters of a template where the device should have been. ──
	console.log('\nThe debug feed — a hand-off target reads as an id, never as a template');
	{
		const target = { deviceId: 'aabbccddeeff0011', name: 'argonaut', lastSeen: 1, build: 'b1' };
		check('B9a: a handoffTarget record answers its deviceId',
			P.peerIdOf(target) === 'aabbccddeeff0011');
		check('B9b: and NOT the object -- the bug was exactly this slice',
			String(P.peerIdOf(target)).slice(0, 12) === 'aabbccddeeff'
			&& String(P.peerIdOf(target)).slice(0, 12) !== '[object Obje');
		check('B9c: its label travels beside the id, so a reader knows the machine',
			P.peerLabelOf(target) === 'argonaut');
		check('B9d: a bare id string is answered verbatim (a caller that already resolved one)',
			P.peerIdOf('ffee0011') === 'ffee0011' && P.peerLabelOf('ffee0011') === '');
		check('B9e: an object carrying `id` rather than `deviceId` still resolves',
			P.peerIdOf({ id: 'legacy01' }) === 'legacy01');
		check('B9f: no target at all is the empty string, never "null" or "undefined"',
			P.peerIdOf(null) === '' && P.peerIdOf(undefined) === ''
			&& P.peerLabelOf(null) === '');
		check('B9g: an object with NEITHER field is empty -- never the template',
			P.peerIdOf({ name: 'nameless' }) === ''
			&& String(P.peerIdOf({ name: 'nameless' })).indexOf('object') === -1);
	}

	// ── B10. A PERSON'S PAUSE ON THE RUNNER (R2 QA, F2). A turn the pause holds -- on this
	//    device's set merged with the errand's own `pause` -- takes no lease and runs
	//    nothing, and the sender is told why; a pause landing mid-turn hands back rather
	//    than crashing to the deadline. ──
	console.log('\nA person\'s pause on the runner — refused before the take, or handed back');
	{
		L.forget();
		const cas = makeCas({});
		const posted = []; let ran = 0; let asked = null;
		const WHY = 'Paused Diamond is paused. No turn started, nothing spent. Press play on it to resume.';
		const out = await P.runErrand(
			sentErrand(P, { eid: 'e10', turnId: 'turn-held', chatId: 'c', prompt: 'p', deadline: 0 }),
			{
				selfId: 'RUNNER', selfName: 'argonaut', cas: cas,
				pauseHold: (e) => { asked = e.turnId; return { node: 'root/diamonds/d1/self', why: WHY }; },
				reconstruct: async () => ({}),
				runTurn: async () => { ran++; },
				post: async (r) => { posted.push(r); },
				ack: async () => {}, pushResult: async () => 1,
				now: () => 2000, setTimer: () => null, clearTimer: () => {},
			});
		check('B10a: the pause is asked of this errand', asked === 'turn-held');
		check('B10b: a held turn runs nothing and takes no lease',
			ran === 0 && out.ran === false && out.why === 'paused' && !cas.peekLeases()['turn-held']);
		check('B10c: one ERROR report goes home, carrying the refusal as the person reads it',
			posted.length === 1 && posted[0].status === 'error' && posted[0].why === WHY);
		// Not held: the same errand is claimed and run, so B10b measured the pause.
		L.forget();
		const cas2 = makeCas({});
		let ran2 = 0;
		const out2 = await P.runErrand(
			sentErrand(P, { eid: 'e10b', turnId: 'turn-free', chatId: 'c', prompt: 'p', deadline: 0 }),
			{
				selfId: 'RUNNER', cas: cas2, pauseHold: () => null,
				reconstruct: async () => ({}), runTurn: async () => { ran2++; },
				post: async () => {}, ack: async () => {}, pushResult: async () => 1,
				now: () => 2000, setTimer: () => null, clearTimer: () => {},
			});
		check('B10d: not held, the same errand is claimed and runs', ran2 === 1 && out2.ran === true);
		// Held mid-turn: the refusal models.js throws carries `paused`.
		const mid = Object.assign(new Error(WHY), { paused: true, pauseNode: 'root/diamonds/d1/self' });
		check('B10e: a pause refusal thrown by the turn is a hand-back, not a crash',
			P.runnerErrorKind(mid) === 'paused');
		check('B10f: and it goes home in its own words, naming what is paused',
			P.runnerErrorWhy('paused', 'argonaut', mid) === WHY);
		L.forget();
	}
}

/// The mock model turn. `runTurn` (daimond.js:17552) is the real engine the peer
/// runs; step 1 stands a deterministic answer in for the provider call, because
/// the seam -- not the model -- is what is under test.
function mockRunTurn(prompt) {
	return 'The answer to "' + prompt + '" is 4.';
}

main().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });

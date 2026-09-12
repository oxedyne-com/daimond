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

// ── One simulated tab ──────────────────────────────────────
//
// A Map-backed localStorage, a no-op document/window, the encoders and base64,
// and the real WebCrypto. Each context loads the four app scripts as the classic
// IIFEs they are and attaches their globals onto its own `window`, so two
// contexts are two independent devices with independent storage.
function makeTab() {
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
			'console', 'globalThis',
			'with (window) {\n' + body + '\n}');
		fn(win, document, real, localStorage, btoa, atob,
			TextEncoder, TextDecoder, EventShim,
			setTimeout, clearTimeout, setInterval, clearInterval,
			console, globalThis);
	}
	// The vendored bundle's top-level `var DaimondNoble` is wrapper-local here (a
	// browser turns it into a window property), so publish it explicitly, exactly
	// as curvefallback.test.mjs does.
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
	check('the posted body is exactly {to, addr, envelope}',
		!!lastPostBody && Object.keys(lastPostBody).sort().join(',') === 'addr,envelope,to');
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
	check('the errand was routed to the peer runner', routedErrands.some((e) => e.turnId === 'turn-2'));
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

	// ══════════════════════════════════════════════════════════
	// STEP 4 — the dispatcher: the STRICT ORDER and the full errand.
	// buildDispatch is pure; the test drives its order end to end.
	// ══════════════════════════════════════════════════════════
	console.log('\nDispatcher — buildDispatch fixes the order and the whole errand');
	const T0 = 1700000000000;			// a realistic epoch-ms
	const dchat = { id: 'chat-9', provider: 'openrouter', model: 'test/m', holds: ['/a', '/b'] };
	const plan = phone.DaimondPeer.buildDispatch(dchat, {
		turnId: 'turn-9', prompt: 'do the thing', pause: { paused: ['x'] },
		scope: dchat.holds,			// daimond.js resolves scope (scopeChatTo / holds) and passes it
		dispatchedBy: 'devPHONE', now: T0,
	});
	check('the order is push-prompt -> mark-dispatched -> post-errand',
		plan.order.join(',') === 'push-prompt,mark-dispatched,post-errand');
	check('the mark is the dispatched reason on the turn',
		plan.mark.why === 'dispatched' && plan.mark.iturn === 'turn-9' && plan.mark.interrupted === true);
	check('the deadline defaults to ~15 minutes out',
		plan.fields.deadline === T0 + phone.DaimondPeer.DISPATCH_DEADLINE_MS);

	// Drive the order end to end: push the prompt parcel FIRST (capturing the
	// version), then post the errand carrying it -- exactly what daimond.js's thin
	// wiring does. The sequence is recorded and must equal plan.order.
	let ver = 41;
	const fakeSync = { push: async () => { ver += 1; }, version: () => ver };
	const seq = [];
	await fakeSync.push(); seq.push('push-prompt');
	const pv = fakeSync.version();
	seq.push('mark-dispatched');			// daimond.js marks the local turn here
	const errand9 = plan.errand(pv);
	const body9 = await phone.DaimondPeer.sealForSelf(errand9);
	const before9 = relay2.since(0).length;
	await phone.DaimondPost.post(body9); seq.push('post-errand');

	check('the executed sequence matches the planned order', seq.join(',') === plan.order.join(','));
	check('the errand carries the version the prompt push committed at', errand9.parcelVersion === pv && pv === 42);
	check('the errand was posted only AFTER the prompt push (never before)',
		seq.indexOf('post-errand') > seq.indexOf('push-prompt'));
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
		&& opened9.parcelVersion === pv
		&& opened9.deadline === T0 + phone.DaimondPeer.DISPATCH_DEADLINE_MS
		&& opened9.dispatchedBy === 'devPHONE');

	// ── The why:'dispatched' handling: dispatchState against the lease ──
	console.log('\nDispatched turn — dispatchState classifies it against the lease');
	const P = phone.DaimondPeer;
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
		const errand = P.makeErrand({ turnId: 't-orphan', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
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
		const errand = P.makeErrand({ turnId: 't-undel', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'DESK' });
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
		const errand = P.makeErrand({ turnId: 't-err', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'DESK' });
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
		check('recoverDecision: FALSE under a live foreign lease (leave it to the peer)',
			P.recoverDecision({ why: 'dispatched', iturn: 't-held' }, live['t-held'], false, 'PHONE', now) === false);
		check('recoverDecision: TRUE when vacant and unfinished (rescue the orphan)',
			P.recoverDecision({ why: 'dispatched', iturn: 'x' }, null, false, 'PHONE', now) === true);
		check('recoverDecision: FALSE when the turn is already finished (a peer answered)',
			P.recoverDecision({ why: 'dispatched', iturn: 'x' }, null, true, 'PHONE', now) === false);
		check('recoverDecision: FALSE for a turn that was never dispatched',
			P.recoverDecision({ why: 'offline', iturn: 'x' }, null, false, 'PHONE', now) === false);
		// And the runner itself stands down on the take, even asked to recover.
		const sync = makeLeaseSync(live);
		let ran = 0, touched = false;
		const errand = P.makeErrand({ turnId: 't-held', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
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
		const errand = P.makeErrand({ turnId: 't-fin', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
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
		const errand = P.makeErrand({ turnId: 't-self', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
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
		const errand = P.makeErrand({ turnId: TURN, chatId: CHAT, prompt: 'do the thing',
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
		const errand = P.makeErrand({ turnId: 't-nom-b', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
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
		const errand = P.makeErrand({ turnId: 't-nom-a', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
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
		const errand = P.makeErrand({ turnId: 't-nom-c', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
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
		const errand = P.makeErrand({ turnId: 't-nom-s', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
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
		const errand = P.makeErrand({ turnId: 't-nom-d', chatId: 'c', prompt: 'p', eid: 'e', deadline: 0, dispatchedBy: 'PHONE' });
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
		const errand = P.makeErrand({ turnId: 'turn-live', chatId: 'c', prompt: 'p', model: {}, deadline: 0, dispatchedBy: 'phone-device' });
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
	check('a per-chat opt-out (toggle OFF) STILL wins over a fresh nominee',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', nominatedId: 'argonaut', toggle: false }, T); return d.dispatch === false && d.reason === 'chat-local'; })());

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
		const errand = Pp.makeErrand({
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
		const errand = Pp.makeErrand({ turnId: 'turn-d3', chatId: 'chat-d3', prompt: 'the question', eid: 'e-d3', deadline: 9e15 });
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
		const errand = Pp.makeErrand({ turnId: 'turn-d5', chatId: 'c', prompt: 'q', eid: 'e-d5',
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
		const errand = P.makeErrand({ turnId: TID, chatId: 'c', prompt: 'p', eid: 'e', deadline: 9e15 });
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
		const errand = P.makeErrand({ turnId: TID, chatId: 'c', prompt: 'p', eid: 'e', deadline: 9e15 });
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
		const errand = P.makeErrand({ turnId: TID, chatId: 'c', prompt: 'p', eid: 'e', deadline: 9e15 });
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
			P.recoverDecision({ why: 'dispatched', iturn: 'turn-long' }, rec, false, 'PHONE', later) === false);
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
	const errand = P.makeErrand({ turnId: TID, chatId: 'chat-r', prompt: 'compute', eid: 'e-run', deadline: 9e15 });

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

	// ── Happy path: take -> reconstruct -> run -> push -> report -> complete -> ack -> release. ──
	{
		L.forget();
		const sync = makeLeaseSync({});
		let pushed = 0, report = null, acked = 0;
		const ctxChat = { id: 'chat-r', messages: [{ role: 'user', content: 'compute', mid: 'u1', ts: 1 }] };
		const res = await P.runErrand(errand, {
			selfId: 'peerA', cas: P.syncCas(sync), now: () => 2000,
			reconstruct: async () => ({ chat: ctxChat }),
			runTurn: async (ctx, prompt, opts) => {
				await opts.onProgress();		// a journal event -> lease renew
				P.foldAssistant(ctx.chat, { mid: 'a1', turnId: TID, text: 'the answer is 42', ts: 3 });
			},
			abort: () => {},
			pushResult: async () => { pushed += 1; return 9; },
			post: async (rep) => { report = rep; },
			ack: async () => { acked += 1; },
		});
		check('the runner completes the errand', res.ran === true && res.done === true);
		check('the runner order is take,reconstruct,run,push,report,complete,ack,release',
			res.trace.join(',') === 'take,reconstruct,run,push,report,complete,ack,release');
		check('the answer was folded into the transcript',
			ctxChat.messages.some((m) => m.role === 'assistant' && m.content === 'the answer is 42'));
		check('the transcript was pushed exactly once', pushed === 1);
		check('a done report was posted carrying the pushed version',
			!!report && report.t === 'report' && report.status === 'done' && report.parcelVersion === 9);
		check('the errand was acked exactly once, AFTER the push',
			acked === 1 && res.trace.indexOf('ack') > res.trace.indexOf('push'));
		check('the lease ends released', sync.leases()[TID].mode === 'released');
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
		const errand = P.makeErrand({ turnId: 't-park', chatId: 'c', prompt: 'go', eid: 'e', deadline: 9e15, parkCount: 0 });
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
		const errandN = P.makeErrand({ turnId: 't-term', chatId: 'c', prompt: 'go', eid: 'e2', deadline: 9e15, parkCount: MAX - 1 });
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
			P.makeErrand({ turnId: TID, chatId: 'c', prompt: 'go', eid: 'e0', deadline: 9e15, parkCount: 0 }),
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
			P.makeErrand({ turnId: TID, chatId: 'c', prompt: 'go', eid: 'eA', deadline: 9e15, parkCount: carried }),
			parkDeps(sync, 'phoneDev', reports, rc, terminal));
		const rB = await laptop.DaimondPeer.runErrand(
			P.makeErrand({ turnId: TID, chatId: 'c', prompt: 'go', eid: 'eB', deadline: 9e15, parkCount: carried }),
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

	console.log('\nThe streamed view — the frame a runner sends');
	{
		const msgs = [
			{ role: 'user',      content: 'earlier turn', mid: 't0', iturn: 't0' },
			{ role: 'assistant', content: 'earlier answer', mid: 'a0' },
			{ role: 'user',      content: 'the dispatched prompt', mid: 't1', iturn: 't1' },
			{ role: 'think_log', content: 'x'.repeat(4000), mid: 'k1' },
			{ role: 'tool_log',  name: 'file_read', args: '{"path":"/very/long/'
				+ 'p'.repeat(400) + '"}', outcome: 'ok', mid: 'l1' },
			{ role: 'assistant', content: 'PARTIAL ANSWER so far', mid: 'a1' },
		];
		const tail = P.progressTail(msgs, 't1', 48 * 1024);
		check('S1a: the frame holds the daimon\'s text for THIS turn',
			tail.includes('PARTIAL ANSWER so far'));
		check('S1b: a PREVIOUS turn is not in the frame (the tail starts at this turn)',
			!tail.includes('earlier answer') && !tail.includes('earlier turn'));
		check('S1c: thinking is collapsed to a COUNT, not 4,000 characters of it',
			tail.includes('[thinking 4000 chars]') && !tail.includes('x'.repeat(100)));
		check('S1d: a tool call is one labelled line naming the tool',
			/\[tool file_read .*-> ok\]/.test(tail));
		check('S1e: a tool\'s arguments are clipped, so one big argument cannot be the frame',
			tail.length < 1200 && !tail.includes('p'.repeat(200)));
		check('S1f: a turn this device does not hold says nothing (a quiet frame, not an error)',
			P.progressTail(msgs, 'not-a-turn', 4096) === '' && P.progressTail([], 't1', 4096) === '');

		// The budget: the tail is the LAST n characters, because what falls off the
		// front is what the watcher already received in an earlier frame.
		const long = [
			{ role: 'user',      content: 'p', mid: 't2', iturn: 't2' },
			{ role: 'assistant', content: 'START' + 'y'.repeat(5000) + 'END', mid: 'a2' },
		];
		const cut = P.progressTail(long, 't2', 1000);
		check('S1g: the frame is cut to the budget and keeps the END of the transcript',
			cut.length === 1000 && cut.endsWith('END') && !cut.includes('START'));
	}

	console.log('\nThe streamed view — what a watcher does with an arriving frame');
	{
		const f1 = { turn: 't1', seq: 1, tail: 'first' };
		const v1 = P.foldProgress(null, f1);
		check('S2a: the first frame becomes the view', v1 && v1.seq === 1 && v1.tail === 'first');
		const v2 = P.foldProgress(v1, { turn: 't1', seq: 2, tail: 'first and second' });
		check('S2b: a newer frame REPLACES the one before it (the tail is the whole tail)',
			v2 && v2.seq === 2 && v2.tail === 'first and second');
		check('S2c: a frame already held changes nothing (no redraw is owed)',
			P.foldProgress(v2, { turn: 't1', seq: 2, tail: 'first and second' }) === null);
		check('S2d: a LATE frame never rewinds the view',
			P.foldProgress(v2, { turn: 't1', seq: 1, tail: 'first' }) === null);
		check('S2e: a frame for ANOTHER turn is not this watcher\'s',
			P.foldProgress(v2, { turn: 't9', seq: 99, tail: 'someone else' }) === null);
		check('S2f: an empty tail is not a view (nothing is drawn over something)',
			P.foldProgress(v2, { turn: 't1', seq: 3, tail: '' }) === null);
		// The close: the real transcript has landed, so the streamed view stands down
		// and no frame still in flight can reopen it.
		const done = P.foldProgress(v2, { turn: 't1', final: true });
		check('S2g: `final` closes the streamed view', done && done.final === true && done.tail === '');
		check('S2h: a frame arriving after the close is ignored (the answer is not overdrawn)',
			P.foldProgress(done, { turn: 't1', seq: 9, tail: 'too late' }) === null);
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
			{ eid: 'e8', turnId: 'turn-402', chatId: 'c', prompt: 'p', deadline: 0 },
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
}

/// The mock model turn. `runTurn` (daimond.js:17552) is the real engine the peer
/// runs; step 1 stands a deterministic answer in for the provider call, because
/// the seam -- not the model -- is what is under test.
function mockRunTurn(prompt) {
	return 'The answer to "' + prompt + '" is 4.';
}

main().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });

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
		/not sealed to any key/i.test(strangerWhy));

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

	console.log(failures === 0 ? '\nALL PASS' : ('\n' + failures + ' FAILURE(S)'));
	if (failures) process.exitCode = 1;
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

	// ── autoDispatchDecision: the policy. ──
	const quickChat = { id: 'c', provider: 'openrouter', model: 'm' };
	const workerChat = { id: 'c2', workerModel: 'w' };
	check('fresh peer + LONG turn (tools) -> dispatch',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', toolsEnabled: true }, T); return d.dispatch === true && d.reason === 'long-turn' && d.peer.name === 'argonaut'; })());
	check('fresh peer + QUICK turn -> run local',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone' }, T); return d.dispatch === false && d.reason === 'quick-local'; })());
	check('STALE peer -> run local (never dispatch into the void)',
		(() => { const d = P.autoDispatchDecision(quickChat, stale, { selfId: 'phone', toolsEnabled: true }, T); return d.dispatch === false && d.reason === 'no-fresh-peer'; })());
	check('no presence -> run local',
		P.autoDispatchDecision(quickChat, {}, { selfId: 'phone', toolsEnabled: true }, T).dispatch === false);
	check('TOGGLE on -> dispatch even a quick turn',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', toggle: true }, T); return d.dispatch === true && d.reason === 'toggle-on'; })());
	check('global default on (chat unset) -> dispatch a quick turn',
		P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', globalDefault: true }, T).dispatch === true);
	check('per-chat toggle OFF overrides a global default ON',
		P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', toggle: false, globalDefault: true }, T).dispatch === false);
	check('backgrounding with a turn in flight -> dispatch',
		(() => { const d = P.autoDispatchDecision(quickChat, fresh, { selfId: 'phone', backgrounding: true, turnInFlight: true }, T); return d.dispatch === true && d.reason === 'backgrounding-in-flight'; })());
	check('a worker chat is agentic -> dispatch',
		P.autoDispatchDecision(workerChat, fresh, { selfId: 'phone' }, T).reason === 'long-turn');
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

	// ── D2 — a plain chat is not "agentic" merely because it mirrors its model ──
	//
	// daimond.js seeds workerModel/workerProvider to the chat's OWN model for every
	// active chat (newChat, startChat), so a bare `c.workerModel` truthiness test
	// dispatched EVERY quick turn. The signal must be a GENUINE worker pair.
	console.log('\nD2 — a plain chat whose worker pair mirrors its own model stays local');
	{
		const T = 1700000000000;
		const fresh = { argonaut: { name: 'argonaut', lastSeen: T - 1000 } };
		const mirrored = { id: 'c', provider: 'openrouter', model: 'm', workerModel: 'm', workerProvider: 'openrouter' };
		const dM = Pp.autoDispatchDecision(mirrored, fresh, { selfId: 'phone' }, T);
		check('D2: a plain foreground chat with a MIRRORED worker pair stays local',
			dM.dispatch === false && dM.reason === 'quick-local');
		const genuine = { id: 'c2', provider: 'openrouter', model: 'm', workerModel: 'big/model', workerProvider: 'openrouter' };
		const dG = Pp.autoDispatchDecision(genuine, fresh, { selfId: 'phone' }, T);
		check('D2: a genuine worker chat (worker model differs) still dispatches',
			dG.dispatch === true && dG.reason === 'long-turn');
		// A worker PROVIDER that differs is genuine too, even with the same model name.
		const diffProv = { id: 'c3', provider: 'openrouter', model: 'm', workerModel: 'm', workerProvider: 'anthropic' };
		check('D2: a differing worker PROVIDER is agentic',
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

/// The mock model turn. `runTurn` (daimond.js:17552) is the real engine the peer
/// runs; step 1 stands a deterministic answer in for the provider call, because
/// the seam -- not the model -- is what is under test.
function mockRunTurn(prompt) {
	return 'The answer to "' + prompt + '" is 4.';
}

main().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });

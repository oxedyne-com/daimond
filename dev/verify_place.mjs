/* ============================================================
   verify_place.mjs — WHERE A TASK OTHER THAN A TURN RUNS
   (owner design, 2026-09-14).
   ------------------------------------------------------------
   The seat line answers that question for a turn. Everything
   else the app does answered it by assuming "here", which is
   right on a desktop and was the whole of the fault on a phone:
   the author's 48-page book is 29 files the phone may not hold
   and 306 MB of wasm heap it may not have, and pressing Compile
   there produced either a file the gather could not reach or a
   tab iOS ended without a word.

   `DaimondPeer.placeTask` is the answer, pure over presence, a
   device ledger and a task's declared needs — so this drives the
   REAL www/js/peer.js in node and enumerates every cell of the
   rule table rather than sampling it.

     (A) the table: kind x device, every cell;
     (B) the closed `why` set, and every key it can name present
         in www/i18n/en.js with the placeholders it substitutes;
     (C) the seat plan is UNTOUCHED: a `turn` answers seatPlan
         verbatim, and `handoffTarget` without `require` answers
         exactly what it answered before;
     (D) desktop unchanged: folder + hand places everything here;
     (E) a mobile device is never a seat, for a compile either;
     (F) `require` skips a peer that cannot say, and names it as
         unknown rather than striking it out (the seq-218 rule);
     (G) the errand and report shapes, and their bounds;
     (H) `runCompileErrand` over fake deps: the order, the revoke
         and the lost take.

   Run:  node dev/verify_place.mjs
         node dev/verify_place.mjs --list     # the cell count
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// The REAL peer.js as the classic IIFE it is, its bare sibling references resolved
// against a fresh `window` (the construct peer.test.mjs and verify_seatline.mjs use).
// `placeTask` is pure, so no other app script is needed.
function loadPeer() {
	const win = {};
	win.addEventListener = () => {};
	win.dispatchEvent    = () => {};
	const body = readFileSync(join(HERE, '..', 'www', 'js', 'peer.js'), 'utf8');
	const fn = new Function(
		'window', 'crypto', 'console', 'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'with (window) {\n' + body + '\n}');
	fn(win, webcrypto, console, TextEncoder, TextDecoder,
		setTimeout, clearTimeout, setInterval, clearInterval);
	return win.DaimondPeer;
}

function loadEn() {
	const win = { DaimondI18n: null };
	let table = null;
	win.DaimondI18n = { register: (_lang, t) => { table = t; } };
	const body = readFileSync(join(HERE, '..', 'www', 'i18n', 'en.js'), 'utf8');
	const fn = new Function('window', 'console', 'with (window) {\n' + body + '\n}');
	fn(win, console);
	return table;
}

const P = loadPeer();
const EN = loadEn();

// ── THE CELL COUNT, so `--list` can be asserted not to fall ──
//
// Counted from the table below rather than declared: a cell deleted from the file
// must move this number, which is the whole of what the assertion is worth.
const KINDS  = ['edit', 'view', 'save', 'compile', 'publish', 'dev', 'run',
	'verify', 'serve', 'terminal', 'turn'];
const COLUMNS = ['fits', 'missing', 'toolarge', 'noestimate', 'deskfull', 'deskNoHand',
	'asleep', 'chatlocal'];
if (process.argv.indexOf('--list') > 0) {
	console.log('cells ' + (KINDS.length * COLUMNS.length));
	process.exit(0);
}

const now  = Date.now();
const W    = P.DISPATCH_FRESH_MS;
const PHONE = 'p0000000000000000000000000000000';
const ARG   = 'a0000000000000000000000000000000';	// argonaut: folder + hand + runner
const GIL   = 'g0000000000000000000000000000000';	// gilgamesh: a desktop with no hand
const OLD   = 'o0000000000000000000000000000000';	// a runner on a build that cannot say

// A live desktop. `hand`/`folder` are the two new beat fields, sent only when true and
// read tri-state: absent is UNKNOWN, never false.
const desk = (name, f) => Object.assign({ name, lastSeen: now - 2000, servicedAt: now - 2000,
	attended: false, mobile: false }, f || {});
const runner = (name, f) => desk(name, Object.assign({ runner: true }, f || {}));

const ROSTER = {
	[ARG]: { name: 'argonaut', lastSeen: now - 2000, hand: true, folder: true, mobile: false },
	[GIL]: { name: 'gilgamesh', lastSeen: now - 5000, hand: false, folder: false, mobile: false },
};

const OPTS = (extra) => Object.assign({ selfId: PHONE, selfName: 'phone',
	freshWindowMs: W, roster: ROSTER, selfMobile: true, isPhone: true,
	chat: { id: 'c', provider: 'openrouter', model: 'm' } }, extra || {});

// The device ledgers the columns stand for.
const phoneFits   = { deviceId: PHONE, hand: false, folder: false, mobile: true,
	budgetMB: 768, heapMB: 306, headroom: 40, files: { missing: [] } };
const phoneMissing = Object.assign({}, phoneFits, { files: { missing: ['book/chap3.typ'] } });
const phoneLarge  = Object.assign({}, phoneFits, { heapMB: 700 });
const deskFull    = { deviceId: 'd1', hand: true, folder: true, mobile: false,
	budgetMB: 2500, heapMB: 300, headroom: 40, files: { missing: [] } };
const deskNoHand  = Object.assign({}, deskFull, { hand: false });

// The presence snapshots.
const AWAKE  = { [ARG]: runner('argonaut', { hand: true, folder: true }) };
const ASLEEP = {};

// `memoryMB` 0 is NO ESTIMATE: the compile happens here and the local heap guard holds.
const need = (kind, f) => Object.assign({ kind,
	person: kind === 'edit' || kind === 'view' || kind === 'terminal',
	files: [], memoryMB: 120, main: 'book/main.typ',
	hand: ['publish', 'dev', 'run', 'verify', 'serve', 'terminal'].indexOf(kind) >= 0,
	network: kind === 'publish' }, f || {});

const place = (kind, ledger, presence, extra, nf) =>
	P.placeTask(need(kind, nf), ledger, presence, OPTS(extra), now);

try {
	// ══ (A) THE RULE TABLE, EVERY CELL ═══════════════════════════════
	//
	// Each column is a device-and-world; each row a kind. A cell is a `where` and,
	// where it moved, the reason it moved for.
	const CELLS = {
		// kind: { column: [where, why] }
		here: ['here', 'here'],
	};
	const cell = (kind, col, ledger, presence, want, wantWhy, extra, nf) => {
		const p = place(kind, ledger, presence, extra, nf);
		check(`(A) ${kind} / ${col} -> ${want}` + (wantWhy ? ' (' + wantWhy + ')' : ''),
			p.where === want && (!wantWhy || p.why === wantWhy),
			`where=${p.where} why=${p.why} label=${p.label}`);
		return p;
	};

	// ── edit / view / save: here, in every world. ──
	for (const k of ['edit', 'view', 'save']) {
		cell(k, 'phone, all files, fits',  phoneFits,   AWAKE,  'here', 'here');
		cell(k, 'phone, file missing',     phoneMissing, AWAKE, 'here', 'here');
		cell(k, 'phone, too large',        phoneLarge,  AWAKE,  'here', 'here');
		cell(k, 'phone, no estimate',      phoneFits,   AWAKE,  'here', 'here', null, { memoryMB: 0 });
		cell(k, 'desktop + folder + hand', deskFull,    AWAKE,  'here', 'here');
		cell(k, 'desktop, no hand',        deskNoHand,  AWAKE,  'here', 'here');
		cell(k, 'runner asleep',           phoneFits,   ASLEEP, 'here', 'here');
		cell(k, 'chat-local',              phoneFits,   AWAKE,  'here', 'here', { globalDefault: false, chat: { id: 'c', handoff: false } });
	}

	// ── compile: two measurable needs and nothing else moves it. ──
	cell('compile', 'phone, all files, fits',  phoneFits,    AWAKE,  'here',   'here');
	cell('compile', 'phone, file missing',     phoneMissing, AWAKE,  'runner', 'missing-files');
	cell('compile', 'phone, too large',        phoneLarge,   AWAKE,  'runner', 'too-large');
	cell('compile', 'phone, no estimate',      phoneFits,    AWAKE,  'here',   'here', null, { memoryMB: 0 });
	cell('compile', 'desktop + folder + hand', deskFull,     AWAKE,  'here',   'here');
	cell('compile', 'desktop, no hand',        deskNoHand,   AWAKE,  'here',   'here');
	cell('compile', 'runner asleep, fits',     phoneFits,    ASLEEP, 'here',   'here');
	cell('compile', 'runner asleep, missing',  phoneMissing, ASLEEP, 'nobody', 'missing-files');
	cell('compile', 'chat-local still compiles where it must', phoneMissing, AWAKE, 'runner',
		'missing-files', { globalDefault: false, chat: { id: 'c', handoff: false } });

	// ── the six hand-bearing kinds: only a Hand-bearing device may run them. ──
	for (const k of ['publish', 'dev', 'run', 'verify', 'serve', 'terminal']) {
		cell(k, 'phone, all files, fits',  phoneFits,    AWAKE,  'runner', 'needs-hand');
		cell(k, 'phone, file missing',     phoneMissing, AWAKE,  'runner', 'needs-hand');
		cell(k, 'phone, too large',        phoneLarge,   AWAKE,  'runner', 'needs-hand');
		cell(k, 'phone, no estimate',      phoneFits,    AWAKE,  'runner', 'needs-hand', null, { memoryMB: 0 });
		cell(k, 'desktop + folder + hand', deskFull,     AWAKE,  'here',   'here');
		cell(k, 'desktop, no hand',        deskNoHand,   AWAKE,  'runner', 'needs-hand');
		cell(k, 'runner asleep',           phoneFits,    ASLEEP, 'nobody', 'needs-hand');
		// THE CHAT TOGGLE NEVER FENCES A RUN. It is about where a TURN runs; a publish
		// has no other seat to go to, and pinning a conversation to this device cannot
		// conjure a machine hand onto it.
		cell(k, 'chat-local',              phoneFits,    AWAKE,  'runner', 'needs-hand',
			{ globalDefault: false, chat: { id: 'c', handoff: false } });
	}

	// ── turn: seatPlan verbatim, in every column. ──
	for (const [col, ledger, presence, extra] of [
		['phone, all files, fits',  phoneFits,   AWAKE,  null],
		['phone, file missing',     phoneMissing, AWAKE, null],
		['phone, too large',        phoneLarge,  AWAKE,  null],
		['phone, no estimate',      phoneFits,   AWAKE,  null],
		['desktop + folder + hand', deskFull,    AWAKE,  null],
		['desktop, no hand',        deskNoHand,  AWAKE,  null],
		['runner asleep',           phoneFits,   ASLEEP, null],
		['chat-local',              phoneFits,   AWAKE,  { globalDefault: false, chat: { id: 'c', handoff: false } }],
	]) {
		const o = OPTS(extra);
		const p = P.placeTask(need('turn'), ledger, presence, o, now);
		const sp = P.seatPlan(o.chat, presence, o, now);
		check(`(A) turn / ${col} -> seatPlan verbatim`,
			JSON.stringify(p.seat) === JSON.stringify(sp)
			&& p.where === (sp.where === 'local' ? 'here' : 'runner'),
			`where=${p.where} seat=${sp.where}/${sp.key}`);
	}

	// ══ (B) THE CLOSED `why` SET, AND ITS KEYS ═══════════════════════
	{
		const seen = new Set();
		for (const k of KINDS) {
			for (const [ledger, presence, extra, nf] of [
				[phoneFits, AWAKE, null, null], [phoneMissing, AWAKE, null, null],
				[phoneLarge, AWAKE, null, null], [phoneFits, AWAKE, null, { memoryMB: 0 }],
				[deskFull, AWAKE, null, null], [deskNoHand, AWAKE, null, null],
				[phoneFits, ASLEEP, null, null], [phoneMissing, ASLEEP, null, null],
				[phoneFits, AWAKE, { globalDefault: false, chat: { id: 'c', handoff: false } }, null],
				[phoneFits, AWAKE, { nominatedId: ARG }, null],
				[phoneFits, ASLEEP, { nominatedId: ARG }, null],
			]) {
				const p = place(k, ledger, presence, extra, nf);
				seen.add(p.why);
				if (!P.taskKind(k)) continue;
			}
		}
		const closed = new Set([...P.PLACE_WHYS, '']);
		check('(B) every `why` the placement can name is in the closed set',
			[...seen].every((w) => closed.has(w)), [...seen].join(' '));
		check('(B) TASK_KINDS is the closed vocabulary and every member places',
			P.TASK_KINDS.length === KINDS.length && KINDS.every((k) => P.taskKind(k))
			&& !P.taskKind('nonsense'),
			P.TASK_KINDS.join(' '));
		// Every key the placement can NAME exists in en.js, with the placeholders it
		// substitutes. The button names its own key, so no call-site read can check it.
		const buttons = ['files.compile_here', 'files.compile_on', 'files.publish_here',
			'files.publish_on', 'place.nobody', 'place.nobody_maybe', 'place.nobody_generic'];
		const titles  = ['place.why_here', 'place.why_missing_files', 'place.why_too_large',
			'place.why_needs_hand'];
		const missing = [...buttons, ...titles, 'files.compiling_on', 'files.built_on',
			'files.compile_stale', 'files.runner_refused', 'files.retrying_on',
			'files.compile_too_many_changed', 'files.compile_toolarge_to_send',
			'files.compile_unsaved', 'files.publish_running'].filter((k) => !EN || !EN[k]);
		check('(B) every key the placement can name exists in en.js', missing.length === 0,
			missing.join(' '));
		check('(B) each device-naming key carries its {name}',
			['files.compile_on', 'files.publish_on', 'place.nobody', 'place.nobody_maybe',
				'place.why_needs_hand'].every((k) => String(EN[k]).indexOf('{name}') >= 0));
		check('(B) the two measured reasons carry the numbers they measured',
			String(EN['place.why_missing_files']).indexOf('{n}') >= 0
			&& String(EN['place.why_too_large']).indexOf('{need}') >= 0
			&& String(EN['place.why_too_large']).indexOf('{room}') >= 0);
		check('(B) placeKey and placeTitleKey answer exactly those sets',
			P.placeKey('compile', 'here') === 'files.compile_here'
			&& P.placeKey('compile', 'runner') === 'files.compile_on'
			&& P.placeKey('publish', 'here') === 'files.publish_here'
			&& P.placeKey('publish', 'runner') === 'files.publish_on'
			&& P.placeKey('turn', 'here') === ''
			&& P.placeTitleKey('too-large') === 'place.why_too_large'
			&& P.placeTitleKey('chat-local') === '');
		// The measured numbers actually reach the answer, or the tooltip asserts a case
		// it cannot state.
		const tl = place('compile', phoneLarge, AWAKE);
		check('(B) the too-large answer carries both megabyte numbers',
			tl.needMB === 160 && tl.roomMB === 68, `need=${tl.needMB} room=${tl.roomMB}`);
		const ms = place('compile', phoneMissing, AWAKE);
		check('(B) the missing answer carries how many are missing', ms.n === 1, 'n=' + ms.n);
	}

	// ══ (C) THE SEAT PLAN IS UNTOUCHED ═══════════════════════════════
	//
	// A snapshot of `handoffTarget` WITHOUT `require` over the seatline fixtures: a
	// change to the election that the placement did not intend goes red here.
	{
		const fixtures = [
			['live runner', { [ARG]: runner('argonaut') }, {}],
			['nominee by id', { [ARG]: desk('argonaut') }, { nominatedId: ARG }],
			['by label', { [ARG]: desk('argonaut') }, { preferredLabel: 'argonaut' }],
			['two desktops', { [ARG]: desk('argonaut'), [GIL]: desk('gilgamesh') }, {}],
			['nothing live', {}, {}],
			['mobile only', { [GIL]: Object.assign(desk('gilgamesh'), { mobile: true }) }, {}],
		];
		const shot = fixtures.map(([n, p, o]) => {
			const r = P.handoffTarget(p, Object.assign({ selfId: PHONE, windowMs: W }, o), now);
			return n + '=' + (r.target ? r.target.deviceId.slice(0, 4) : 'null') + '/' + r.reason;
		}).join(' | ');
		check('(C) handoffTarget without `require` is byte-identical to the election before',
			shot === 'live runner=a000/runner-posture | nominee by id=a000/nominee | '
				+ 'by label=a000/worker | two desktops=a000/other-desktop | '
				+ 'nothing live=null/local | mobile only=null/local', shot);
	}

	// ══ (D) DESKTOP UNCHANGED ════════════════════════════════════════
	{
		const worlds = [AWAKE, ASLEEP, { [ARG]: runner('argonaut', { hand: true, folder: true }),
			[GIL]: desk('gilgamesh') }];
		let all = true, firstBad = '';
		for (const p of worlds) {
			for (const k of KINDS) {
				if (k === 'turn') continue;
				const r = place(k, deskFull, p);
				if (r.where !== 'here') { all = false; firstBad = k + '->' + r.where; }
			}
		}
		check('(D) a device with the folder AND the hand places every non-turn kind here',
			all, firstBad);
	}

	// ══ (E) A MOBILE DEVICE IS NEVER A SEAT, FOR A COMPILE EITHER ════
	{
		const phoneRunner = { [GIL]: Object.assign(runner('gilgamesh',
			{ hand: true, folder: true }), { mobile: true }) };
		const c = place('compile', phoneMissing, phoneRunner);
		check('(E) a phone that beats folder:true is not chosen for a compile',
			c.where === 'nobody', `where=${c.where} label=${c.label}`);
		const r = place('publish', phoneFits, phoneRunner);
		check('(E) nor for a run, however it beats', r.where === 'nobody',
			`where=${r.where} label=${r.label}`);
	}

	// ══ (F) `require` AND THE ROLLOUT RULE ═══════════════════════════
	{
		// A runner beating `runner:true` with `hand`/`folder` ABSENT — an old build.
		const oldWorld = { [OLD]: runner('oldbox') };
		const oldRoster = { [OLD]: { name: 'oldbox', lastSeen: now - 2000, mobile: false } };
		const c = P.placeTask(need('compile'), phoneMissing, oldWorld,
			OPTS({ roster: oldRoster }), now);
		check('(F) a peer that cannot say is not seated on a guess',
			c.where === 'nobody', `where=${c.where}`);
		check('(F) and it is NAMED as unknown, never struck out',
			c.key === 'place.nobody_maybe' && c.label === 'oldbox',
			`key=${c.key} label=${c.label}`);
		const pub = P.placeTask(need('publish'), phoneFits, oldWorld,
			OPTS({ roster: oldRoster }), now);
		check('(F) the same for a publish — the seq-218 rule, applied here',
			pub.where === 'nobody' && pub.key === 'place.nobody_maybe', `key=${pub.key}`);
		// A roster that HAS seen a hand names that machine with the definite sentence.
		const sure = place('publish', phoneFits, ASLEEP);
		check('(F) a machine the roster saw holding the hand is named definitely',
			sure.key === 'place.nobody' && sure.label === 'argonaut',
			`key=${sure.key} label=${sure.label}`);
		// Nothing ever seen: the generic sentence, and it does not invent a name.
		const none = P.placeTask(need('publish'), phoneFits, ASLEEP, OPTS({ roster: {} }), now);
		check('(F) with nothing ever seen the sentence is generic and names nobody',
			none.key === 'place.nobody_generic' && none.label === '', `key=${none.key}`);
		// The filter itself: `require` narrows, and only where the field is absent.
		const t1 = P.handoffTarget(oldWorld, { selfId: PHONE, windowMs: W, require: 'hand' }, now);
		const t2 = P.handoffTarget(oldWorld, { selfId: PHONE, windowMs: W }, now);
		check('(F) handoffTarget with require skips a peer absent for the field, without it does not',
			!t1.target && !!t2.target, `${!!t1.target} / ${!!t2.target}`);
		check('(F) meetsRequire: true passes, false and absent do not',
			P.meetsRequire({ hand: true }, 'hand') && !P.meetsRequire({ hand: false }, 'hand')
			&& !P.meetsRequire({}, 'hand') && P.meetsRequire({}, ''));
		// R9: two desktops sharing a LABEL choose neither, so a collision cannot decide
		// which machine runs and bills.
		const twins = { [ARG]: runner('twin', { hand: true }), [GIL]: runner('twin', { hand: true }) };
		const byLabel = P.handoffTarget(twins, { selfId: PHONE, windowMs: W,
			preferredLabel: 'twin', require: 'hand' }, now);
		check('(F) a label shared by two desktops chooses neither BY LABEL',
			byLabel.reason !== 'worker', 'reason=' + byLabel.reason);
	}

	// ══ (G) THE ERRAND AND THE REPORT ════════════════════════════════
	{
		const big = 'x'.repeat(P.COMPILE_FILE_CHARS + 1);
		const plan1 = P.compilePlan([{ path: 'a.typ', sha: 'aa', text: 'hello' },
			{ path: 'b.typ', sha: 'bb', text: big }]);
		check('(G) a file past COMPILE_FILE_CHARS goes to the offload list',
			!plan1.refused && plan1.inline.length === 1 && plan1.offload.length === 1
			&& plan1.offload[0].path === 'b.typ',
			`inline=${plan1.inline.length} offload=${plan1.offload.length}`);
		const many = [];
		for (let i = 0; i <= P.COMPILE_FILES_MAX; i++) many.push({ path: 'f' + i, sha: 's', text: 'x' });
		const plan2 = P.compilePlan(many);
		check('(G) more changed files than the cap is REFUSED, with the count and a key',
			plan2.refused && plan2.n === P.COMPILE_FILES_MAX + 1
			&& plan2.why === 'files.compile_too_many_changed', JSON.stringify(plan2.why));
		// The total budget, not just the per-file one: three files each under the file cap
		// but over the total between them push the tail out to chunks.
		const third = 'y'.repeat(Math.floor(P.COMPILE_INLINE_CHARS / 2) + 100);
		const plan3 = P.compilePlan([{ path: '1', text: third }, { path: '2', text: third },
			{ path: '3', text: third }]);
		check('(G) the INLINE TOTAL is a bound too, and the tail goes to chunks',
			plan3.inline.length === 1 && plan3.offload.length === 2,
			`inline=${plan3.inline.length}`);

		// THE WORST CASE ACTUALLY FITS THE POST DOOR. 16 files at the per-file cap is not
		// the worst case the bounds admit -- the INLINE TOTAL is -- so the envelope is
		// built at the total, with a 29-file import set's hashes beside it.
		const files = [];
		let used = 0;
		for (let i = 0; i < P.COMPILE_FILES_MAX && used < P.COMPILE_INLINE_CHARS; i++) {
			const n = Math.min(P.COMPILE_FILE_CHARS, P.COMPILE_INLINE_CHARS - used);
			files.push({ path: 'book/chap' + i + '.typ', sha: 'a'.repeat(64), text: 'z'.repeat(n) });
			used += n;
		}
		const hashes = {}, imports = [];
		for (let i = 0; i < 29; i++) {
			imports.push('book/chap' + i + '.typ');
			hashes['book/chap' + i + '.typ'] = 'b'.repeat(64);
		}
		const env = P.makeCompileErrand({ main: 'book/main.typ', want: 'vector',
			wsid: 'w'.repeat(16), docKey: 'd'.repeat(32), files: files,
			expect: { imports, hashes }, deadline: now + P.COMPILE_DEADLINE_MS,
			dispatchedBy: PHONE });
		// The wire size is base64 of a GCM seal of the signed JSON: ~1.37x the plaintext
		// (4/3 for base64, plus the signature and the 12-byte IV and 16-byte tag).
		const plain = JSON.stringify(env).length + 256;		// + the signature fields
		const sealed = Math.ceil((plain + 28) * 4 / 3);
		check('(G) the worst-case errand seals under the 64 KiB post door',
			sealed < 64 * 1024, `${(sealed / 1024).toFixed(1)} KiB sealed, ${files.length} files`);
		check('(G) the errand names its own lease key, and it cannot collide with a turn id',
			/^cmp-/.test(env.cid) && env.t === 'compile' && env.v === 1, env.cid);

		// A 32-chunk manifest report stays small: the artifact never rides here.
		const chunks = [];
		for (let i = 0; i < 32; i++) chunks.push({ addr: 'c'.repeat(43), size: 262144 });
		const rep = P.makeBuilt({ eid: 'e', cid: env.cid, main: 'book/main.typ',
			status: 'done', by: ARG, ms: 4200, pages: 48, imports, hashes,
			wrote: imports.slice(0, 4), vector: { v: 2, size: 2000000, key: 'k', chunks },
			docKey: 'd'.repeat(32) });
		check('(G) a 32-chunk built report is well under 8 KiB',
			JSON.stringify(rep).length < 8 * 1024,
			`${(JSON.stringify(rep).length / 1024).toFixed(1)} KiB`);
		check('(G) the report carries what the phone needs to tell stale from current',
			rep.hashes && rep.imports.length === 29 && rep.vector.chunks.length === 32
			&& rep.t === 'built');
	}

	// ══ (H) runCompileErrand OVER FAKE DEPS ══════════════════════════
	//
	// The `runErrand` test pattern: a lease CAS over a plain object, deps that record
	// what they were asked, and the TRACE asserted rather than the side effects guessed.
	{
		// The same versioned {version, leases} blob peer.test.mjs models /api/sync with:
		// `write(base, next)` accepts only at the current version, which is what makes the
		// take a genuine compare-and-set rather than a last-write-wins.
		const mkCas = (seed) => {
			let version = 5;
			let leases = JSON.parse(JSON.stringify(seed || {}));
			return {
				read: async () => ({ version, leases: JSON.parse(JSON.stringify(leases)) }),
				write: async (base, next) => {
					if (base !== version) {
						return { ok: false, version, leases: JSON.parse(JSON.stringify(leases)) };
					}
					version += 1;
					leases = JSON.parse(JSON.stringify(next));
					return { ok: true, version };
				},
				peek: () => JSON.parse(JSON.stringify(leases)),
				set: (v) => { leases = JSON.parse(JSON.stringify(v)); version += 1; },
			};
		};
		const errand = P.makeCompileErrand({ main: 'book/main.typ', want: 'vector',
			docKey: 'dk', files: [{ path: 'book/chap.typ', sha: 'aa', text: 'x' }],
			deadline: now + P.COMPILE_DEADLINE_MS, dispatchedBy: PHONE });
		const deps = (over) => Object.assign({
			selfId: ARG, selfName: 'argonaut', presence: {}, cas: mkCas(),
			setTimer: () => null, clearTimer: () => {},
			check:   async () => ({ ok: true }),
			write:   async () => ({ wrote: ['book/chap.typ'], moved: [] }),
			compile: async () => ({ vector: new Uint8Array(16), pages: 48, ms: 4200,
				watch: ['book/main.typ'], hashes: { 'book/main.typ': 'cc' },
				heap: { before: 300, after: 340, growth: 40, headroom: 40 } }),
			offload: async () => ({ v: 2, size: 16, key: 'k', chunks: [{ addr: 'a', size: 16 }] }),
			frame:   async () => {},
			post:    async () => {},
			ack:     async () => {},
		}, over || {});

		const backbone = (tr) => tr.filter((x) => x !== 'frame');
		let posted = null;
		const r1 = await P.runCompileErrand(errand, deps({ post: async (e) => { posted = e; } }));
		check('(H) the order is take, check, write, compile, offload, final, report, release, ack',
			JSON.stringify(backbone(r1.trace)) === JSON.stringify(
				['take', 'check', 'write', 'compile', 'offload', 'final', 'report', 'release', 'ack']),
			r1.trace.join(','));
		check('(H) and the report is a `built` naming the runner and the pages',
			!!posted && posted.t === 'built' && posted.status === 'done' && posted.pages === 48
			&& posted.by === ARG && posted.vector.chunks.length === 1,
			posted ? posted.status : 'none');
		check('(H) at least two progress frames, and one before the final',
			r1.trace.filter((x) => x === 'frame').length >= 2
			&& r1.trace.indexOf('frame') < r1.trace.indexOf('final'),
			r1.trace.join(','));

		// A LOST TAKE writes nothing. Another device already holds the lease.
		const held = mkCas({ [errand.cid]: { turnId: errand.cid, holder: 'other',
			mode: 'claimed', deadline: now + 60000, expiry: now + 60000,
			renewedAt: now, eid: 'x' } });
		let wrote = 0;
		const r2 = await P.runCompileErrand(errand,
			deps({ cas: held, write: async () => { wrote++; return { wrote: [], moved: [] }; } }));
		check('(H) a lost take writes nothing and does not compile',
			!r2.ran && wrote === 0 && r2.trace.indexOf('write') < 0, r2.trace.join(','));

		// A REVOKE MID-COMPILE aborts and posts no report: the lease is the other
		// device's now, and a second report would fold a second set of pages.
		const cas3 = mkCas();
		let reported = 0, offloaded = 0;
		const r3 = await P.runCompileErrand(errand, deps({
			cas: cas3,
			post: async () => { reported++; },
			offload: async () => { offloaded++; return null; },
			compile: async () => {
				// The phone pressed "Compile here": the lease is taken back under us, and
				// the read-only ticker is given a real moment to notice.
				const snap = cas3.peek();
				snap[errand.cid] = { turnId: errand.cid, holder: 'phone', mode: 'claimed',
					deadline: now + 60000, expiry: now + 60000, renewedAt: now };
				cas3.set(snap);
				await new Promise((r) => setTimeout(r, 60));
				return { vector: new Uint8Array(4), pages: 1, ms: 5, watch: [], hashes: {},
					heap: { before: 1, after: 1, growth: 0, headroom: 0 } };
			},
			// The ticker is a real interval in production. Here it runs fast, so the test
			// is about the DECISION the read takes, not about how long it waits to take it.
			setTimer: (fn) => setInterval(fn, 10),
			clearTimer: (h) => clearInterval(h),
		}));
		check('(H) a revoke mid-compile aborts, and nothing is offloaded or reported for it',
			r3.aborted === true && reported === 0 && offloaded === 0
			&& r3.trace.indexOf('abort') >= 0,
			`aborted=${r3.aborted} reported=${reported} trace=${r3.trace.join(',')}`);

		// A REFUSED CHECK (the folder token does not match) reports, releases and ACKS:
		// the answer is the same on any machine with this folder, so leaving it on the
		// relay only buys a second refusal.
		let refused = null;
		const r4 = await P.runCompileErrand(errand, deps({
			check: async () => ({ ok: false, why: 'another folder' }),
			post: async (e) => { refused = e; } }));
		check('(H) a wsid mismatch is refused, reported, released and acked — never compiled',
			r4.refused === true && refused && refused.status === 'refused'
			&& backbone(r4.trace).indexOf('compile') < 0
			&& r4.trace.indexOf('ack') >= 0, r4.trace.join(','));

		// A COMPILE ERROR is the document's, not the placement's: reported and acked.
		let errRep = null;
		const r5 = await P.runCompileErrand(errand, deps({
			compile: async () => ({ error: 'label <x> does not exist' }),
			post: async (e) => { errRep = e; } }));
		check('(H) a compile error is reported with the compiler’s own sentence, and acked',
			r5.error === true && errRep && errRep.status === 'error'
			&& /label <x>/.test(errRep.why) && r5.trace.indexOf('ack') >= 0, r5.trace.join(','));

		// FILES THAT MOVED between dispatch and write are compiled anyway and NAMED.
		let staleRep = null;
		const r6 = await P.runCompileErrand(errand, deps({
			write: async () => ({ wrote: ['book/chap.typ'], moved: ['book/chap.typ'] }),
			post: async (e) => { staleRep = e; } }));
		check('(H) a file that moved under the errand is compiled and reported `stale`',
			r6.done === true && staleRep.status === 'stale'
			&& staleRep.moved.length === 1, staleRep ? staleRep.status : 'none');

		// THE SELF-DISPATCH GUARD, unchanged from the turn's: a device never runs its own.
		const mine = P.makeCompileErrand({ main: 'm.typ', dispatchedBy: ARG, docKey: 'dk' });
		const r7 = await P.runCompileErrand(mine, deps());
		check('(H) a device stands down on its OWN compile dispatch',
			!r7.ran && r7.why === 'self-dispatched', r7.why);

		// A `built` ALREADY COLLECTED for this eid is not compiled a second time.
		const r8 = await P.runCompileErrand(errand, deps({ finished: async () => true }));
		check('(H) a compile already reported is never re-run',
			!r8.ran && r8.why === 'already-done', r8.why);
	}

	// ══ THE DOCUMENT KEY ═════════════════════════════════════════════
	{
		const a = await P.docKeyFor('ws1', 'book/main.typ');
		const b = await P.docKeyFor('ws1', 'book/main.typ');
		const c = await P.docKeyFor('ws2', 'book/main.typ');
		const d = await P.docKeyFor('ws1', 'other/main.typ');
		check('(G) the document key is stable, and separates folder from document',
			a === b && a !== c && a !== d && a.length === 32, a);
	}
} catch (e) {
	bad.push('crashed: ' + (e && e.message || e));
	console.log('  FAIL crashed — ' + (e && e.stack || e));
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' fail'
	+ '  (cells ' + (KINDS.length * COLUMNS.length) + ')');
process.exitCode = bad.length ? 1 : 0;

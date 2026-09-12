// verify_offloadgate.mjs — a device that cannot COMMIT the chunk index must not
// OFFLOAD to it.
//
// THE HOLE THIS CLOSES. The gateway sweeps every held chunk the committed index
// `cmeta:<account>` does not name (`collect_orphan_chunks`, gateway/src/schema.rs),
// once marked for 24 h. Only a device that merged the account's index may commit
// one -- `applyChunked` refuses the merge, and `syncMayCommitChunks` refuses the
// commit, on the same condition: the tools are up and the workspace root is the
// OPFS sandbox rather than a real on-disk folder. But the three offload decisions
// (`collectFiles`, `planDiamonds`, `collectChatsRefs`) asked only whether the
// transport was loaded and the identity unlocked. So a device with no tools, or
// with a folder mounted, uploaded chunks, pushed a parcel naming them, and never
// declared them -- and a day later the gateway deleted the chunks with the head
// parcel still pointing at them. The owner's store showed exactly that shape:
// uploads at 13:22Z and 14:37Z with no index commit since 08:53Z.
//
// WHAT IS ASSERTED, against the SHIPPED source rather than a paraphrase. The real
// `filesSyncable` / `offloadAllowed` / `offloadBlockedReason` / `planDiamonds` /
// `collectChatsRefs` bodies are sliced out of www/js/daimond.js by literal text and
// run here over a simulated tab -- a plain object for `window`, resolved through
// `with`, the same construct dev/verify_presenceseating.mjs and www/js/peer.test.mjs
// use. No browser, no gateway, no wasm.
//
//   1. THE GATE. With the tools absent, or a real folder mounted, or no cloud
//      module, nothing offloads: zero `offloadBytes` calls, zero `contentSet`
//      writes, and every chat rides inline carrying its own messages.
//   2. UNCHANGED WHEN HEALTHY. Tools present and no folder: the big transcript
//      offloads exactly as before (a `messagesRef`, `messages` null) and the small
//      one still rides inline. The fix must cost a healthy device nothing.
//   3. THE DIAMOND PLAN agrees: `canOffload` false and `refReserve` 0 on a device
//      that cannot commit, true and non-zero on one that can.
//   4. ALL THREE SITES carry the gate, checked in the source text, so a fourth
//      collector added later without it is visible.
//   5. THE REFUSAL NAMES ITS REASON. The real refusal block out of www/js/sync.js
//      logs `tools-missing`, `folder-mounted` or `cloud-missing`.
//
// How it goes red: drop `&& offloadAllowed()` from any of the three sites (1, 3
// and 4 go red), or drop the reason from the sync.js line (5 goes red).
//
//   node dev/verify_offloadgate.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP  = readFileSync(join(HERE, '..', 'www/js/daimond.js'), 'utf8');
const SYNC = readFileSync(join(HERE, '..', 'www/js/sync.js'), 'utf8');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' — ' + detail : ''));
};

/// One function, verbatim, out of a source file: from its signature to the brace
/// that closes it. A rename fails loudly here rather than testing a stale copy.
function slice(src, name) {
	let start = src.indexOf('\tfunction ' + name + '(');
	if (start < 0) start = src.indexOf('\tasync function ' + name + '(');
	if (start < 0) throw new Error('could not find ' + name);
	let i = src.indexOf('{', start), depth = 0, end = -1;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
	}
	if (end < 0) throw new Error('unbalanced braces in ' + name);
	return src.slice(start, end);
}

// The constants the collectors budget against, read off the source so the test
// cannot drift from the app.
const NUM = (name) => {
	const m = new RegExp('var ' + name + '\\s*=\\s*([0-9*\\s]+);').exec(APP);
	if (!m) throw new Error('could not read ' + name);
	return Function('return (' + m[1] + ')')();
};
const SYNC_FILE_MAX         = NUM('SYNC_FILE_MAX');
const SYNC_CHATS_INLINE_MAX = NUM('SYNC_CHATS_INLINE_MAX');

// ── The simulated tab ───────────────────────────────────────────────
// `cfg` describes the world: whether the tools are up, whether a real folder is
// mounted, whether the cloud and chunk modules are loaded.
function makeTab(cfg) {
	const calls = { offloadBytes: [], contentSet: [], contentForget: [], contentReap: 0 };
	const content = {};									// the device's `@c/`/`@d/` manifests
	const win = {};

	win.DaimondTools = cfg.tools ? {} : undefined;
	win.Files = { folder: () => (cfg.folder ? { name: '/home/someone/work' } : null) };

	if (cfg.chunks !== false) {
		win.DaimondChunks = {
			offloadBytes: async (key, bytes) => {
				calls.offloadBytes.push(key);
				return { v: 1, size: bytes.length, key: 'k-' + key, chunks: ['addr-' + key] };
			},
		};
	}
	if (cfg.cloud !== false) {
		win.DaimondCloud = {
			available:     () => true,
			contentGet:    (k) => (Object.prototype.hasOwnProperty.call(content, k) ? content[k] : null),
			contentSet:    (k, v) => { calls.contentSet.push(k); content[k] = v; },
			contentForget: (k) => { calls.contentForget.push(k); delete content[k]; },
			contentReap:   () => { calls.contentReap++; },
			index:         () => ({}),
		};
	}

	// What `collectChatsRefs` reads around itself. `slimChat` drops the transcript
	// the way the app's does; `ChatStore.loadMessages` is the authoritative row.
	win.__chats = cfg.chats || [];
	win.storedChats = () => win.__chats.map((c) => ({ id: c.id, name: c.name, model: c.model, updatedAt: c.updatedAt }));
	win.ChatStore = { loadMessages: async (id) => ({ messages: (win.__chats.find((c) => c.id === id) || {}).messages || [] }) };
	win.slimChat = (c) => ({ id: c.id, name: c.name, model: c.model, updatedAt: c.updatedAt });
	win.SYNC_FILE_MAX         = SYNC_FILE_MAX;
	win.SYNC_CHATS_INLINE_MAX = SYNC_CHATS_INLINE_MAX;

	// What `planDiamonds` reads around itself.
	win.__diamonds = cfg.diamonds || [];
	win.loadDiamondTombs = () => ({});
	win.trashed = () => false;
	win.diamondStamp = (d) => d.touched || 0;
	win.diamondModels = () => ({});
	win.diamondApp = () => ({
		list_diamonds:       async () => JSON.stringify(win.__diamonds),
		export_diamond_size: async (id) => (win.__diamonds.find((d) => d.id === id) || {}).size || 0,
	});

	const body = [
		slice(APP, 'filesSyncable'),
		slice(APP, 'offloadAllowed'),
		slice(APP, 'offloadBlockedReason'),
		slice(APP, 'fileHash'),
		slice(APP, 'estRefBytes'),
		slice(APP, 'planDiamonds'),
		slice(APP, 'collectChatsRefs'),
	].join('\n');
	const factory = new Function('window', 'TextEncoder', 'console',
		'with (window) {\n' + body
		+ '\nreturn { filesSyncable, offloadAllowed, offloadBlockedReason, planDiamonds, collectChatsRefs };\n}');
	return { win, calls, content, api: factory(win, TextEncoder, console) };
}

/// A transcript whose serialisation is over the per-chat inline threshold, so it
/// offloads whenever offload is available at all.
function bigChat(id, stamp) {
	const msgs = [];
	while (JSON.stringify(msgs).length < SYNC_FILE_MAX + 20 * 1024) {
		msgs.push({ role: 'user', mid: id + '-m' + msgs.length, ts: 1000 + msgs.length, content: 'x'.repeat(2048) });
	}
	return { id, name: 'Big ' + id, model: 'mock/fast', updatedAt: stamp, messages: msgs };
}
const smallChat = (id, stamp) => ({ id, name: 'Small ' + id, model: 'mock/fast', updatedAt: stamp,
	messages: [{ role: 'user', mid: id + '-m0', ts: 1, content: 'hello' }] });

const CHATS    = () => [bigChat('big-1', 9000), smallChat('small-1', 8000)];
const DIAMONDS = () => [{ id: 'd-1', name: 'One', touched: 9000, size: SYNC_FILE_MAX * 3 },
	{ id: 'd-2', name: 'Two', touched: 8000, size: 4096 }];

// ═══════════════════════════════════════════════════════════════════
// The four worlds
// ═══════════════════════════════════════════════════════════════════
const WORLDS = [
	{ label: 'tools missing',  cfg: { tools: false, folder: false }, allowed: false, reason: 'tools-missing' },
	{ label: 'healthy',        cfg: { tools: true,  folder: false }, allowed: true,  reason: '' },
	{ label: 'folder mounted', cfg: { tools: true,  folder: true },  allowed: false, reason: 'folder-mounted' },
	{ label: 'cloud missing',  cfg: { tools: true,  folder: false, cloud: false }, allowed: false, reason: 'cloud-missing' },
];

console.log('\n— the predicate and its reason —');
for (const w of WORLDS) {
	const t = makeTab(w.cfg);
	check(`[${w.label}] offloadAllowed() is ${w.allowed}`, t.api.offloadAllowed() === w.allowed,
		'got ' + t.api.offloadAllowed());
	check(`[${w.label}] the reason is ${w.reason === '' ? '(none)' : w.reason}`,
		t.api.offloadBlockedReason() === w.reason, 'got ' + JSON.stringify(t.api.offloadBlockedReason()));
	// The two can never disagree: an empty reason and a false predicate would let a
	// refusal be logged as "nothing wrong".
	check(`[${w.label}] an empty reason means, exactly, that offload is allowed`,
		(t.api.offloadBlockedReason() === '') === t.api.offloadAllowed());
}

console.log('\n— chat transcripts: what leaves the device —');
for (const w of WORLDS) {
	const t = makeTab(Object.assign({ chats: CHATS() }, w.cfg));
	const out = await t.api.collectChatsRefs();
	const big = out.find((c) => c.id === 'big-1'), small = out.find((c) => c.id === 'small-1');
	if (w.allowed) {
		check('[healthy] the big transcript offloads and travels as a ref',
			!!(big && big.messagesRef) && big.messages === null,
			'ref ' + !!(big && big.messagesRef) + ' messages ' + JSON.stringify(big && big.messages && big.messages.length));
		check('[healthy] the small transcript still rides inline',
			!!(small && Array.isArray(small.messages) && small.messages.length === 1) && !small.messagesRef);
		check('[healthy] the upload happened and its manifest was recorded',
			t.calls.offloadBytes.length === 1 && t.calls.contentSet.length === 1,
			'offloads ' + t.calls.offloadBytes.length + ' contentSet ' + t.calls.contentSet.length);
	} else {
		check(`[${w.label}] NOTHING is uploaded`, t.calls.offloadBytes.length === 0,
			'offloadBytes calls ' + JSON.stringify(t.calls.offloadBytes));
		check(`[${w.label}] no manifest is written into the index`, t.calls.contentSet.length === 0,
			'contentSet ' + JSON.stringify(t.calls.contentSet));
		check(`[${w.label}] every chat rides inline, carrying its own transcript`,
			out.length === 2 && out.every((c) => Array.isArray(c.messages) && c.messages.length > 0 && !c.messagesRef),
			out.map((c) => c.id + (c.messagesRef ? ':ref' : ':inline')).join(' '));
	}
}

console.log('\n— a manifest already held is NOT dropped when the gate closes —');
{
	// A device that offloaded while healthy, then lost its tools, must not forget the
	// manifest: `contentForget` here would narrow its own index behind its back.
	const t = makeTab({ tools: false, folder: false, chats: CHATS() });
	t.content['@c/big-1'] = { v: 1, size: 10, key: 'k', chunks: ['a'], fp: 'stale' };
	await t.api.collectChatsRefs();
	check('a held @c/ manifest survives a round the device could not offload in',
		t.calls.contentForget.length === 0 && !!t.content['@c/big-1'],
		'forget ' + JSON.stringify(t.calls.contentForget));
}

console.log('\n— the Diamond plan —');
for (const w of WORLDS) {
	const t = makeTab(Object.assign({ diamonds: DIAMONDS() }, w.cfg));
	const plan = await t.api.planDiamonds();
	check(`[${w.label}] plan.canOffload is ${w.allowed}`, plan.canOffload === w.allowed, 'got ' + plan.canOffload);
	check(`[${w.label}] refReserve is ${w.allowed ? 'non-zero' : '0'}`,
		w.allowed ? plan.refReserve > 0 : plan.refReserve === 0, 'got ' + plan.refReserve);
	check(`[${w.label}] the store still enumerates (nothing is refused, only offload)`,
		plan.ok === true && plan.held.length === 2, 'ok ' + plan.ok + ' held ' + plan.held.length);
}

console.log('\n— every offload site carries the gate —');
{
	const sites = (APP.match(/&& DaimondCloud\.contentGet && offloadAllowed\(\)\);/g) || []).length;
	check('all three collectors gate on offloadAllowed() (files, Diamonds, chats)', sites === 3,
		'found ' + sites);
	const ungated = (APP.match(/var canOffload = !!\(window\.DaimondChunks/g) || []).length;
	check('and there is no fourth, ungated canOffload in daimond.js', ungated === sites,
		'canOffload sites ' + ungated + ', gated ' + sites);
	const POST = readFileSync(join(HERE, '..', 'www/js/post.js'), 'utf8');
	check('the mail collector gates on the same predicate through DaimondCore',
		/var canOffload = [\s\S]{0,400}?DaimondCore\.syncMayCommitChunks\(\)\);/.test(POST));
}

console.log('\n— the refusal names its reason —');
{
	// The REAL block out of sync.js, run over a stub `DaimondCore` and `log`.
	const at = SYNC.indexOf('if (!mayCommit) {');
	if (at < 0) throw new Error('could not find the refusal in sync.js');
	let i = SYNC.indexOf('{', at), depth = 0, end = -1;
	for (; i < SYNC.length; i++) {
		if (SYNC[i] === '{') depth++;
		else if (SYNC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
	}
	const block = SYNC.slice(at, end);
	for (const w of WORLDS) {
		if (w.allowed) continue;
		const t = makeTab(w.cfg);
		const lines = [], commits = [];
		// `dsCommit` is the debug feed's commit event, defined just above the
		// block in sync.js; here it records so the refusal's reason is asserted
		// to reach the feed as well as the log.
		const run = new Function('DaimondCore', 'log', 'mayCommit', 'dsCommit', block);
		run({ syncMayCommitChunks: t.api.offloadAllowed, syncCommitBlockedReason: t.api.offloadBlockedReason },
			(...a) => lines.push(a.join(' ')), false, (o, why) => commits.push(o + ':' + why));
		check(`[${w.label}] the feed's commit event says refused:${w.reason}`,
			commits.length === 1 && commits[0] === 'refused:' + w.reason, commits.join(' | '));
		check(`[${w.label}] the log line carries "${w.reason}"`,
			lines.length === 1 && lines[0].indexOf(w.reason) !== -1, lines.join(' | '));
		check(`[${w.label}] and still says a live set was not committed`,
			lines.length === 1 && lines[0].indexOf('not committing a live set') !== -1, lines.join(' | '));
	}
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { bad.forEach((n) => console.log('  FAILED: ' + n)); process.exit(1); }

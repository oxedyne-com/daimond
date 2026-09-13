// verify_lens.mjs — the archive reader, against logs whose every awkward case is
// deliberate.
//
// The fixtures are SYNTHETIC. The real feed carries the owner's decrypted
// account -- transcripts, model ids, spend -- and none of that belongs in the
// repository, so every byte here is invented and only the SHAPES are real: the
// gateway's block header, its two-space row layout, the `ds <kind> <id> i/N`
// chunk tags, and the `ev <kind>` envelope the client lane is adding.
//
// What is proved, and why each case rather than the next thing:
//
//   1. ROTATION DOES NOT DOUBLE-COUNT. `<name>.log.1` is the same stream one
//      rotation older, and a pull that catches the file mid-rotation sees the
//      same block in both. It must be ingested once. This is the case that
//      makes the archive trustworthy at all: a five-minute timer will meet a
//      rotation, and a reader that counts a turn twice is worse than one that
//      misses it.
//
//   2. A CHUNK SET ASSEMBLES ACROSS BLOCKS. One telemetry bundle is split over
//      two posts, as a real one is -- the handler takes 400 rows a post and a
//      snapshot is thousands.
//
//   3. A DUPLICATED CHUNK IS HARMLESS. The client re-posts rows whose reply it
//      lost, so the same `i` arrives twice; the set must still decode.
//
//   4. A MISSING CHUNK IS REPORTED, NOT GUESSED. Rotation on jarrah destroys the
//      rows a set is still waiting for. The reader says which are missing and
//      keeps going; it never invents a bundle out of a partial one.
//
//   5. AN EVENT ARRIVES ONCE. `(d,n)` is what the client makes unique, and a
//      failed post is retried, so the same `(d,n)` is normal traffic.
//
//   6. PULL IS IDEMPOTENT. The timer runs it every five minutes forever; a
//      second pull over the same files must add no byte to the archive.
//
//   7. EVERY QUESTION ANSWERS. status, turns, errors, console, events, snapshot,
//      watch and digest, each against data whose right answer is known here --
//      and status and digest inside their size caps, because those two are read
//      by a language model at every pickup and the cap IS the feature.
//
//   8. THE CONSOLE IS THE CONSOLE. `ev console` rows carry what the tab printed,
//      at every level, with `x` for the repeats inside a minute. warn and error
//      join `errors` and the rest do not; an ABORTED request -- the status 0 a
//      reload leaves behind -- is hidden unless it is asked for; and the beat's
//      feed health reaches `status` and `digest`, because a throttled feed is
//      why a count below it would be short.

import { execFileSync }	from 'node:child_process';
import fs			from 'node:fs';
import os			from 'node:os';
import path			from 'node:path';
import { fileURLToPath }	from 'node:url';

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const LENS	= path.join(HERE, 'lens.mjs');

const shortName = (m) => String(m).split('/').pop();
const utc = (ts) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The fixture logs ─────────────────────────────────────────────────

const ROOT	= fs.mkdtempSync(path.join(os.tmpdir(), 'lens-verify-'));
const TRACES	= path.join(ROOT, 'traces');
fs.mkdirSync(TRACES, { recursive: true });

const NOW	= Date.now();
const ACCOUNT	= 'acctfixture0000000000000000000';
const DEV_A	= 'devA00000000000000000000000000aa';
const DEV_B	= 'devB00000000000000000000000000bb';
const BUILD_A	= 'fixturebuild1';
const BUILD_B	= 'fixturebuild2';

/// The handler's own row rendering: two spaces, the client clock, two spaces,
/// the tag, and the data behind another two spaces when there is any.
function row(ts, tag, data) {
	return '  ' + ts + '  ' + tag + (data ? '  ' + data : '') + '\n';
}

function block(bt, device, rows) {
	return '\n===== ' + bt + ' account=' + ACCOUNT + ' device=' + device
		+ ' rows=' + rows.length + ' =====\n' + rows.join('');
}

/// Base64 the way the client does it, sliced at the handler's per-field cap.
function chunkRows(kind, id, bundle, ts) {
	const payload = Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64');
	const slices = [];
	for (let i = 0; i < payload.length; i += 360) slices.push(payload.slice(i, i + 360));
	if (!slices.length) slices.push('');
	return slices.map((d, i) => ({ tag: `ds ${kind} ${id} ${i + 1}/${slices.length}`, data: d, ts }));
}

// The telemetry bundle device A ships: two turns on the cost ledger (one of them
// failed), a build announcement and a page error on the breadcrumb trail, one
// benign diagnostics row, and the live context numbers.
const TEL = {
	v: 1, kind: 'telemetry', ts: NOW - 20000, iso: new Date(NOW - 20000).toISOString(),
	ledger: [
		{ t: NOW - 600000, m: 'fixture/model-a', p: 100000, c: 2000, ca: 80000, u: 1.25, r: 1, e: false, pv: 'fixture' },
		{ t: NOW - 300000, m: 'fixture/model-b', p: 50000,  c: 1000, ca: 10000, u: 0.50, r: 0, e: true,  pv: 'fixture' },
	],
	trail: [
		{ t: NOW - 90000, a: 1000, w: 'build', d: BUILD_A },
		{ t: NOW - 45000, a: 2000, w: 'page error', d: 'fixture blew up @ /js/fixture.js:12' },
	],
	diag: [ { ts: NOW - 40000, a: 3000, tag: 'sync push', data: 'kept=3 skipped=0 removed=0' } ],
	stats: {
		models: [ { model: 'fixture/model-a', turns: 1, prompt: 100000, completion: 2000,
			cached: 80000, cachedPct: 80, usd: 1.25, maxPromptTurn: 100000, reportedPct: 100 } ],
		diamonds: [], signalModels: [], cross: [],
		live: {
			contextActual: 12345, contextWindow: 200000, foldAt: 0.65,
			activeModel: 'fixture/model-a', provider: 'fixture',
			workerState: { active: 0, queued: 0, busy: false }, activity: 'idle',
		},
	},
};

// The snapshot device B ships. Small, because only its SHAPE is under test --
// and its device roster, which is where the only build the feed states today
// comes from.
// Two more ticks of the same running counters, which is how a turn is recovered
// when its ledger delta was lost to rotation. Tick 2 raises model-a's total with
// no ledger entry to explain it; tick 3 raises it again but ships the ledger
// entry for that interval, so the difference must NOT be counted a second time.
const models = (turns, prompt, cached, usd) => ([
	{ model: 'fixture/model-a', turns, prompt, completion: 2000, cached,
		cachedPct: 100 * cached / prompt, usd, maxPromptTurn: prompt, reportedPct: 100 },
]);

const TEL2 = {
	v: 1, kind: 'telemetry', ts: NOW - 15000, iso: new Date(NOW - 15000).toISOString(),
	ledger: [], trail: [], diag: [],
	stats: { models: models(3, 120000, 95000, 1.55), diamonds: [], signalModels: [], cross: [],
		live: TEL.stats.live },
};

const TEL3 = {
	v: 1, kind: 'telemetry', ts: NOW - 10000, iso: new Date(NOW - 10000).toISOString(),
	ledger: [ { t: NOW - 12000, m: 'fixture/model-a', p: 8000, c: 100, ca: 2000, u: 0.15, r: 1, e: false, pv: 'fixture' } ],
	trail: [], diag: [],
	stats: { models: models(4, 128000, 97000, 1.70), diamonds: [], signalModels: [], cross: [],
		live: TEL.stats.live },
};

const SNAP = {
	v: 1, kind: 'snapshot', ts: NOW - 30000, iso: new Date(NOW - 30000).toISOString(),
	config: { model: 'fixture/model-a', apiKey: 'fixt…a1b2' },
	transcripts: [], presence: null,
	roster: { [DEV_B]: { name: 'Fixture B', build: BUILD_B, seen: NOW - 30000 } },
	election: { self: DEV_B, nominated: DEV_A, trace: [] },
	tokenStats: [ { id: 'c1', name: 'fixture chat', model: 'fixture/model-a', messages: 4, contextWindow: 200000 } ],
	signals: null, ledger: [], ledgerDropped: 0, trail: [], diag: [],
};

const SNAP_GAP = Object.assign({}, SNAP, { iso: new Date(NOW - 7 * 3600000).toISOString() });

// ── Device A: two blocks, the first of which appears in BOTH files ───

const evRow = (n, kind, extra, t) =>
	row(t, 'ev ' + kind, JSON.stringify(Object.assign({ v: 1, d: DEV_A, n, b: BUILD_A, t }, extra)));

const A_BT1 = NOW - 120000, A_BT2 = NOW - 60000;
const telRows = chunkRows('telemetry', 'tfixture01', TEL, NOW - 20000);
const telHalf = Math.ceil(telRows.length / 2);

const A_BLOCK1 = block(A_BT1, DEV_A, [
	evRow(1, 'turn.start', { chat: 'c1', model: 'fixture/model-a', agentic: true }, NOW - 115000),
	evRow(2, 'turn.end', { model: 'fixture/model-a', rounds: 3, prompt: 9000,
		completion: 300, cached: 7000, usd: 0.02, outcome: 'done' }, NOW - 110000),
	evRow(3, 'error', { msg: 'TypeError: fixture is not a function', src: '/js/fixture.js:4211' }, NOW - 105000),
	row(NOW - 104000, 'election', 'self=devA0000 nominee=devB0000 present=Y reason=fixture'),
	...telRows.slice(0, telHalf).map(r => row(r.ts, r.tag, r.data)),
]);

// What the tab printed, which before this lane reached the developer as one
// line in five. The warning repeated twice inside its minute, so it is ONE row
// carrying `x`; the `[sync]` line is an ordinary log and belongs to the
// transcript, not to the errors; and the two fetch failures differ only in
// whether the page was going away when they happened.
const A_BLOCK2 = block(A_BT2, DEV_A, [
	// The retried post: the same `(d,n)` the gateway already filed.
	evRow(2, 'turn.end', { model: 'fixture/model-a', rounds: 3, prompt: 9000,
		completion: 300, cached: 7000, usd: 0.02, outcome: 'done' }, NOW - 110000),
	evRow(4, 'console', { lvl: 'warn', msg: 'i18n: no string for "home.sec_diag"',
		src: 'i18n.js:156', x: 2 }, NOW - 100000),
	evRow(5, 'console', { lvl: 'log',
		msg: '[sync] chunk index not merged on this device — not committing a live set',
		src: 'sync.js:351' }, NOW - 99000),
	evRow(6, 'console', { lvl: 'error', msg: 'RangeError: fixture stack depth',
		src: 'fixture.js:88' }, NOW - 98000),
	evRow(7, 'console', { lvl: 'debug', msg: '[improve] queue drawn', src: 'improve.js:166' }, NOW - 97000),
	evRow(8, 'fetch.fail', { path: '/api/parcel', status: 0, ms: 12, aborted: 1 }, NOW - 96000),
	evRow(9, 'fetch.fail', { path: '/api/improve', status: 400, ms: 30 }, NOW - 95000),
	// ONE PATH, THREE STATUSES, three faults. A 409 is "pull, merge and commit
	// again", a 413 is a parcel over the front door's ceiling and a 502 is the
	// gateway down: the remedies have nothing in common, and a reader that saw
	// `/api/sync N` x3 could not tell which had happened.
	evRow(11, 'fetch.fail', { path: '/api/sync', status: 409, ms: 40 }, NOW - 93500),
	evRow(12, 'fetch.fail', { path: '/api/sync', status: 413, ms: 41 }, NOW - 93400),
	evRow(13, 'fetch.fail', { path: '/api/sync', status: 502, ms: 42 }, NOW - 93300),
	// AN UNANNOUNCED RELOAD. A status 0 the client could not tag -- the page never
	// said `pagehide`, so `aborted` is absent -- with the boot it died in front of
	// two seconds later. Read as aborted on the boot's evidence.
	evRow(14, 'fetch.fail', { path: '/api/chunks', status: 0, ms: 9 }, NOW - 93000),
	evRow(15, 'boot', { b: BUILD_A }, NOW - 91000),
	// And the control: the same shape with no boot behind it is still a fault, or
	// the inference above would swallow every network failure there is.
	evRow(16, 'fetch.fail', { path: '/api/credits', status: 0, ms: 11 }, NOW - 97500),
	// The beat, and deliberately OLDER than every telemetry tick: the feed's own
	// health is the beat's to state, and a tick arriving after it says nothing
	// about the feed and must not hide what the beat said.
	evRow(10, 'beat', { ctx: 12345, win: 200000, busy: 0, ob: 3,
		throttled: 2, postFail: 1, cdrop: 5 }, NOW - 94000),
	// THE SCREEN (added 2026-09-13): what the person is actually looking at,
	// on the phone that cannot be driven from Linux. `tile` rides the wire as
	// one string, `"role: text"`; `status` splits it back for the reader.
	evRow(17, 'screen', { view: 'daimon', seat: 'Next turn: Chrome on argonaut',
		tile: 'daimon: Two of the three verifiers are green so far.',
		dlg: 'none', comp: 0, locked: 0, upd: 'none', w: 390, h: 844,
		vis: 'visible' }, NOW - 92000),
	...telRows.slice(telHalf).map(r => row(r.ts, r.tag, r.data)),
]);

const A_BLOCK3 = block(NOW - 5000, DEV_A, [
	...chunkRows('telemetry', 'tfixture02', TEL2, NOW - 15000).map(r => row(r.ts, r.tag, r.data)),
	...chunkRows('telemetry', 'tfixture03', TEL3, NOW - 10000).map(r => row(r.ts, r.tag, r.data)),
]);

// `.log.1` holds block 1; `.log` holds block 1 AGAIN and the rest -- a pull that
// arrived while the gateway was rotating.
fs.writeFileSync(path.join(TRACES, `${ACCOUNT}-${DEV_A}.log.1`), A_BLOCK1);
fs.writeFileSync(path.join(TRACES, `${ACCOUNT}-${DEV_A}.log`), A_BLOCK1 + A_BLOCK2 + A_BLOCK3);

// ── Device B: a set with a duplicate chunk, and one with a hole ──────

const snapRows = chunkRows('snapshot', 'sfixture01', SNAP, NOW - 30000);
const gapRows  = chunkRows('snapshot', 'sfixture02', SNAP_GAP, NOW - 7 * 3600000);
// The hole: everything but the second chunk, in a block old enough that the pull
// gives up on it in the same run rather than after six hours of waiting.
const holed = gapRows.filter((_, i) => i !== 1);

// The trap this fixture exists to catch: a block of generic rows OLDER than any
// telemetry on either device. It is real coverage for `events` and no coverage
// at all for a turn or a cost, and a header that quotes it claims to have been
// watching hours before the first tick arrived.
const B_BLOCK_DIAG = block(NOW - 9 * 3600000, DEV_B, [
	row(NOW - 9 * 3600000, 'diag store', 'open ns=fixture rows=3'),
	row(NOW - 9 * 3600000, 'handoff_latency', 'turn=fixture-old latencyMs=1234'),
]);

// Device B's own telemetry starts an hour ago -- hours after that diag block and
// hours before device A's, so the two devices disagree about when they can see.
const TEL_B = {
	v: 1, kind: 'telemetry', ts: NOW - 3600000, iso: new Date(NOW - 3600000).toISOString(),
	ledger: [], trail: [], diag: [],
	stats: {
		models: [], diamonds: [], signalModels: [], cross: [],
		live: { contextActual: 0, contextWindow: 0, foldAt: 0, activeModel: 'fixture/model-b',
			provider: 'fixture', workerState: { active: 0, queued: 0, busy: false }, activity: 'idle' },
	},
};
const B_BLOCK_TEL = block(NOW - 3600000, DEV_B,
	chunkRows('telemetry', 'tfixtureB1', TEL_B, NOW - 3600000).map(r => row(r.ts, r.tag, r.data)));

const B_BLOCK_OLD = block(NOW - 7 * 3600000, DEV_B, holed.map(r => row(r.ts, r.tag, r.data)));
// Two duplicates, because they fail differently: one inside the set (the plain
// retry) and one AFTER the last chunk closed it, which is what re-opens a set
// that is already filed and leaves a phantom behind.
const B_BLOCK_NEW = block(NOW - 30000, DEV_B, [
	row(snapRows[0].ts, snapRows[0].tag, snapRows[0].data),
	row(snapRows[1].ts, snapRows[1].tag, snapRows[1].data),
	row(snapRows[1].ts, snapRows[1].tag, snapRows[1].data),
	...snapRows.slice(2).map(r => row(r.ts, r.tag, r.data)),
	row(snapRows[0].ts, snapRows[0].tag, snapRows[0].data),
]);
fs.writeFileSync(path.join(TRACES, `${ACCOUNT}-${DEV_B}.log`),
	B_BLOCK_DIAG + B_BLOCK_OLD + B_BLOCK_TEL + B_BLOCK_NEW);

// ── Running the reader ───────────────────────────────────────────────

function lens(...args) {
	return execFileSync('node', [LENS, ...args], {
		encoding: 'utf8',
		env: Object.assign({}, process.env, { DAIMOND_LENS_HOME: ROOT, DAIMOND_LENS_REMOTE: '' }),
	});
}
function lensJson(...args) {
	const out = lens(...args, '--json').trim();
	try { return JSON.parse(out); } catch (e) { return { _unparsed: out }; }
}
function archiveBytes() {
	let total = 0;
	const walk = (d) => {
		for (const n of fs.readdirSync(d)) {
			const f = path.join(d, n);
			const st = fs.statSync(f);
			if (st.isDirectory()) walk(f); else total += st.size;
		}
	};
	try { walk(path.join(ROOT, 'archive')); } catch (e) { /* nothing yet */ }
	return total;
}

console.log('lens fixtures in ' + ROOT + '\n');

const p1 = lensJson('pull', '--no-rsync');
check('pull ingests every fixture block', p1.blocks === 7, `${p1.blocks} block(s), expected 7`);
check('the rotated duplicate block is skipped', p1.skipped === 1, `${p1.skipped} skipped, expected 1`);
check('a duplicate chunk index is not stored twice', p1.dupChunks === 2, `dupChunks=${p1.dupChunks}`);
check('a chunk arriving after its set closed leaves no phantom',
	(lensJson('snapshot').kind === 'snapshot'), 'the filed set is still the one returned');
check('a redelivered (d,n) event is counted once', p1.dupEvents === 1, `dupEvents=${p1.dupEvents}`);
check('the telemetry sets assemble, one of them across two blocks',
	p1.telemetry === 4, `telemetry=${p1.telemetry}`);
check('the complete snapshot set materialises', p1.snapshots === 1, `snapshots=${p1.snapshots}`);
check('the holed snapshot set is closed as a gap', p1.gapped === 1, `gapped=${p1.gapped}`);
check('nothing failed to decode', p1.broken === 0, `broken=${p1.broken}`);

const bytes1 = archiveBytes();
const p2 = lensJson('pull', '--no-rsync');
const bytes2 = archiveBytes();
check('a second pull ingests nothing', p2.blocks === 0 && p2.rows === 0 && p2.events === 0,
	`blocks=${p2.blocks} rows=${p2.rows} events=${p2.events}`);
check('a second pull adds no bytes to the archive', bytes1 === bytes2 && bytes1 > 0,
	`${bytes1} → ${bytes2}`);

// ── status ───────────────────────────────────────────────────────────

const st = lensJson('status');
const byDev = Object.fromEntries((st.devices || []).map(d => [d.device, d]));
check('status names both devices', Object.keys(byDev).length === 2, Object.keys(byDev).join(','));
check('device A reports its build from the event envelope',
	byDev[DEV_A] && byDev[DEV_A].build === BUILD_A, byDev[DEV_A] && byDev[DEV_A].build);
check('device B reports its build from the snapshot roster',
	byDev[DEV_B] && byDev[DEV_B].build === BUILD_B, byDev[DEV_B] && byDev[DEV_B].build);
check('device A reports the live context numbers',
	byDev[DEV_A] && byDev[DEV_A].live && byDev[DEV_A].live.contextActual === 12345
		&& byDev[DEV_A].live.contextWindow === 200000,
	JSON.stringify(byDev[DEV_A] && byDev[DEV_A].live && byDev[DEV_A].live.contextActual));

const statusLines = lens('status').trim().split('\n');
check('status stays inside its 40-line cap', statusLines.length <= 40, statusLines.length + ' line(s)');
check('status counts the console at warn and error',
	statusLines.some(l => /^console \(1h\): 2 warn, 1 err/.test(l)),
	statusLines.find(l => /^console/.test(l)));
check('status reports the feed\'s own health from the beat',
	statusLines.some(l => /^feed: throttled 2, postFail 1, console dropped 5 \(last beat\)/.test(l)),
	statusLines.find(l => /^feed:/.test(l)));
check('status --json carries the same two',
	st.console1h.warn === 2 && st.console1h.error === 1
		&& (st.devices.find(d => d.device === DEV_A) || {}).health.throttled === 2,
	JSON.stringify(st.console1h));

// The screen: the latest picture per device, printed right under its build
// line -- the one lane a phone that cannot be driven from Linux still has.
check('status --json carries device A\'s latest screen',
	byDev[DEV_A] && byDev[DEV_A].screen && byDev[DEV_A].screen.view === 'daimon'
		&& byDev[DEV_A].screen.tile === 'daimon: Two of the three verifiers are green so far.',
	JSON.stringify(byDev[DEV_A] && byDev[DEV_A].screen));
check('device B, which never sent one, carries no screen', !byDev[DEV_B].screen);
const seesLine = statusLines.find(l => /^\s+sees\s/.test(l));
check('status prints "sees" directly under device A\'s build line',
	seesLine && statusLines[statusLines.indexOf(seesLine) - 1].startsWith(DEV_A.slice(0, 7)),
	seesLine);
check('the tile splits back into its role and text head, not the raw "role: text" join',
	/tile daimon 'Two of the three verifiers are green so far\.'/.test(seesLine || ''), seesLine);
check('the seat line and the dialog state both print',
	/seat 'Next turn: Chrome on argonaut'/.test(seesLine || '') && / dlg none/.test(seesLine || ''),
	seesLine);

// Coverage, which is a different number per device AND per source. The archive
// holds rows from nine hours back and TICKS from one; a window reaching past
// either must say so rather than report the stretch it cannot see as a quiet one.
const near = (a, b) => Math.abs(a - b) < 2000;
check('status states when the archive begins',
	/^archive since \d{4}-\d\d-\d\d \d\d:\d\dZ \(telemetry\/ev\)/.test(statusLines[0]), statusLines[0]);
check('the header is the earliest TICK, not the older diagnostics block',
	near(st.coverage.ticks, NOW - 3600000)
		&& statusLines[0].includes(utc(NOW - 3600000))
		&& !statusLines[0].startsWith('archive since ' + utc(NOW - 9 * 3600000)),
	utc(st.coverage.ticks) + ' vs diag ' + utc(NOW - 9 * 3600000));
check('row coverage is kept separately, and is the older one',
	near(st.coverage.rows, NOW - 9 * 3600000) && /rows from/.test(statusLines[0]),
	utc(st.coverage.rows));
check('each device states its own first tick',
	near(st.coverage.byDevice[DEV_A].ticks, NOW - 115000)
		&& near(st.coverage.byDevice[DEV_B].ticks, NOW - 3600000),
	utc(st.coverage.byDevice[DEV_A].ticks) + ' / ' + utc(st.coverage.byDevice[DEV_B].ticks));
// Device A now carries a fourth line (`sees`, from its screen event) ahead of
// device B's build line, which the fixed index below accounts for.
check('the per-device lines carry those two different stamps',
	/ since \d\d:\d\dZ/.test(statusLines[1]) && / since \d\d:\d\dZ/.test(statusLines[5])
		&& statusLines[1].slice(-7) !== statusLines[5].slice(-7),
	statusLines[1].slice(-14) + ' | ' + statusLines[5].slice(-14));
// The device that cannot see the window must not report it as a zero.
const wide = lens('status', '--since', '24h');
check('a device blind to the window says so instead of reporting zero',
	/\(coverage from \d\d:\d\dZ\)/.test(wide),
	wide.split('\n').find(l => /coverage from/.test(l)));
check('a device that CAN see the window still reports its count',
	/window 6 turn\(s\)/.test(wide), wide.split('\n').find(l => /turn\(s\)/.test(l)));
check('a window reaching past the archive is reported as starting there',
	/\(archive start\)/.test(lens('turns', '--since', '24h')),
	lens('turns', '--since', '24h').trim().split('\n').pop());
check('a window inside the archive is reported as asked for',
	!/\(archive start\)/.test(lens('turns', '--since', '30m')),
	lens('turns', '--since', '30m').trim().split('\n').pop());

// ── turns ────────────────────────────────────────────────────────────

const turns = lensJson('turns', '--since', '24h');
check('turns come from all three sources', turns.length === 5,
	turns.length + ': ' + turns.map(t => t.src + '/' + shortName(t.model)).join(' '));
const spend = turns.reduce((a, t) => a + t.usd, 0);
check('the spend adds up across the three sources', Math.abs(spend - 2.22) < 1e-9, String(spend));
check('every turn is counted, including the ones a counter recovered',
	turns.reduce((a, t) => a + (t.turns || 1), 0) === 6,
	String(turns.reduce((a, t) => a + (t.turns || 1), 0)));

// The two counter cases, which are the whole reason for the third source.
const cum = turns.filter(t => t.src === 'cumulative');
check('two ticks of rising counters recover the turns between them',
	cum.length === 1 && cum[0].turns === 2 && Math.abs(cum[0].usd - 0.30) < 1e-9,
	cum.length + ' record(s): ' + JSON.stringify(cum.map(c => [c.turns, c.usd])));
check('an interval a ledger entry already covers is not counted twice',
	!cum.some(c => c.ts > NOW - 15000), 'no cumulative record over the ledgered interval');
check('a recovered turn claims no outcome it cannot know',
	cum.every(c => c.outcome === '?' && c.rounds === null));
check('a redelivered turn.end is one turn, not two',
	turns.filter(t => t.src === 'ev').length === 1);
check('the ledger entries are all three of them',
	turns.filter(t => t.src === 'ledger').length === 3);
check('the failed turn carries its outcome',
	turns.filter(t => t.outcome === 'error').length === 1);
check('a device filter narrows the turns',
	lensJson('turns', '--since', '24h', '--device', DEV_B).length === 0);

// ── errors ───────────────────────────────────────────────────────────

const errs = lensJson('errors', '--since', '24h');
const msgs = errs.map(e => e.msg).join(' | ');
check('the event error is reported', /TypeError: fixture is not a function/.test(msgs));
check('the breadcrumb page error is reported', /fixture blew up/.test(msgs));
check('the failed turn is reported', /turn ended in error/.test(msgs));
check('a benign diagnostics row is NOT an error', !/sync push/.test(msgs), msgs.slice(0, 80));
check('errors are deduplicated by message',
	errs.every(e => e.count >= 1) && errs.length === 10, errs.length + ' distinct');
check('--grep narrows the errors',
	lensJson('errors', '--since', '24h', '--grep', 'TypeError').length === 1);

// The console joins the errors at warn and error, and only there. A `log` is the
// transcript; an aborted request is a reload, not a fault.
const conErr = errs.filter(e => e.kind.indexOf('console.') === 0);
check('a console warning is an error the app printed',
	conErr.some(e => e.kind === 'console.warn' && /home\.sec_diag/.test(e.msg)),
	conErr.map(e => e.kind).join(','));
check('a console error is too',
	conErr.some(e => e.kind === 'console.error' && /RangeError/.test(e.msg)));
check('the repeat count is the count', 
	(conErr.find(e => e.kind === 'console.warn') || {}).count === 2);
check('a console log is NOT an error', !/chunk index not merged/.test(msgs), msgs.slice(0, 60));
check('a real 400 is an error', errs.some(e => e.kind === 'fetch.fail' && /\/api\/improve/.test(e.msg)));
check('an ABORTED request is not, by default',
	!errs.some(e => /\/api\/parcel/.test(e.msg)), errs.map(e => e.msg.slice(0, 20)).join('|'));
check('--aborted asks for it back',
	lensJson('errors', '--since', '24h', '--aborted').some(e => /\/api\/parcel/.test(e.msg)));

// A `fetch.fail` groups by PATH AND STATUS. The generic dedupe flattens every
// digit to `N`, which made three faults on one path one line with a count -- and
// 409, 413 and 502 on `/api/sync` have nothing in common but the path.
const syncFails = errs.filter(e => e.kind === 'fetch.fail' && /\/api\/sync/.test(e.msg));
check('three statuses on one path are three faults, not one line x3',
	syncFails.length === 3 && syncFails.every(e => e.count === 1),
	syncFails.map(e => e.msg + ' x' + e.count).join(' | '));
check('and each names its own status, so the remedy is legible',
	['409', '413', '502'].every(s => syncFails.some(e => e.msg.indexOf(s) >= 0)),
	syncFails.map(e => e.msg).join(' | '));

// A status 0 the client could not tag, with the boot it died in front of two
// seconds later: aborted on the boot's evidence.
check('a status 0 just before a boot is read as a reload, not a fault',
	!errs.some(e => /\/api\/chunks/.test(e.msg)), errs.map(e => e.msg.slice(0, 24)).join('|'));
check('and --aborted still shows it',
	lensJson('errors', '--since', '24h', '--aborted').some(e => /\/api\/chunks/.test(e.msg)));
check('a status 0 with NO boot behind it is still a fault',
	errs.some(e => /\/api\/credits/.test(e.msg)), errs.map(e => e.msg.slice(0, 24)).join('|'));

// ── console ──────────────────────────────────────────────────────────

const con = lensJson('console', '--since', '24h');
check('console defaults to warn and error', con.length === 2,
	con.map(c => c.lvl).join(','));
check('it carries the level, the message and the source',
	con[0].lvl === 'warn' && /home\.sec_diag/.test(con[0].msg) && con[0].src === 'i18n.js:156',
	JSON.stringify(con[0]));
check('a repeated line carries its count', con[0].x === 2);
const all = lensJson('console', '--since', '24h', '--lvl', 'all');
check('--lvl all is every level', all.length === 4, all.map(c => c.lvl).join(','));
check('the [sync] line the console showed is there',
	all.some(c => c.lvl === 'log' && /chunk index not merged/.test(c.msg) && c.src === 'sync.js:351'));
check('--lvl names one level', lensJson('console', '--since', '24h', '--lvl', 'debug').length === 1);
check('--grep narrows the console',
	lensJson('console', '--since', '24h', '--lvl', 'all', '--grep', 'improve').length === 1);
check('--device narrows it too',
	lensJson('console', '--since', '24h', '--lvl', 'all', '--device', DEV_B).length === 0);
const conText = lens('console', '--since', '24h', '--lvl', 'all');
check('without --json it is one legible line each, with a total',
	/x2/.test(conText) && /i18n\.js:156/.test(conText) && /4 distinct line\(s\), 5 printed/.test(conText),
	conText.trim().split('\n').pop());
check('a window with nothing in it says so, not nothing at all',
	/^console: nothing at warn\/error since/.test(lens('console', '--since', '30s')),
	lens('console', '--since', '30s').trim());

// ── events ───────────────────────────────────────────────────────────

const evs = lensJson('events', '--since', '24h');
check('every event row is in the stream once', evs.length === 20,
	evs.length + ': ' + evs.map(e => e.kind || e.tag).join(','));
check('--kind selects the console rows', lensJson('events', '--since', '24h', '--kind', 'console').length === 4);
check('--kind selects one event kind',
	lensJson('events', '--since', '24h', '--kind', 'turn.start').length === 1);
check('--kind reaches a generic gateway row too',
	lensJson('events', '--since', '24h', '--kind', 'election').length === 1);
check('--grep searches the payload',
	lensJson('events', '--since', '24h', '--grep', 'nominee').length === 1);

// `lens events --kind screen` needs no special-case ingestion: an `ev` row is
// filed generically by its tag, and the screen is just another kind.
const screenEvs = lensJson('events', '--since', '24h', '--kind', 'screen');
check('--kind screen selects the screen row', screenEvs.length === 1);
check('the screen row carries the wire\'s own fields',
	screenEvs[0].ev && screenEvs[0].ev.view === 'daimon' && screenEvs[0].ev.dlg === 'none',
	JSON.stringify(screenEvs[0] && screenEvs[0].ev));

// ── snapshot ─────────────────────────────────────────────────────────

const snap = lensJson('snapshot', '--latest');
check('the snapshot reassembles from its chunks, duplicate and all',
	snap && snap.kind === 'snapshot' && snap.election && snap.election.self === DEV_B,
	snap && (snap.kind || snap._unparsed || '').slice(0, 60));
// `config` aside, the archived body must match the bundle that was sent exactly.
// `config` itself is deliberately NOT byte-identical: the archive's own
// second-line redaction (below) runs `apiKey` back through the fingerprinter
// regardless of what the client already did to it, since it cannot tell an
// already-fingerprinted value from a raw one by looking at the value alone --
// only the field NAME says it is a secret. That is idempotent in effect (still
// a fingerprint, never the client's raw key) but not idempotent byte-for-byte.
check('the reassembled snapshot matches the bundle that was sent, config aside',
	JSON.stringify(Object.assign({}, snap, { config: undefined }))
		=== JSON.stringify(Object.assign({}, SNAP, { config: undefined })));
check('config.apiKey stays a fingerprint after the archive\'s own redaction pass',
	snap && snap.config && /^\[redacted /.test(snap.config.apiKey), JSON.stringify(snap && snap.config));
check('a non-secret config field (model) survives untouched',
	snap && snap.config && snap.config.model === 'fixture/model-a');
const gap = lensJson('snapshot', '--id', 'sfixture02');
check('the holed set reports its gap rather than a bundle',
	gap && gap.complete === false && gap.missing === '2', JSON.stringify(gap && gap.missing));
const gapText = lens('snapshot', '--id', 'sfixture02');
check('the gap is legible without --json', /INCOMPLETE/.test(gapText), gapText.trim().split('\n')[0]);

// ── watch and digest ─────────────────────────────────────────────────

const watched = lens('watch', '--once', '--no-pull', '--since', 'all');
check('watch tails the stream', /turn\.start/.test(watched) && /tick/.test(watched),
	watched.trim().split('\n').length + ' line(s)');

const digest = lens('digest');
check('digest stays inside its 2 KB cap', Buffer.byteLength(digest) <= 2048,
	Buffer.byteLength(digest) + ' bytes');
check('digest names the devices, the spend and the feed',
	/fixturebuild1/.test(digest) && /\$2\.22/.test(digest) && /telemetry tick/.test(digest),
	digest.trim().split('\n').length + ' line(s)');
check('digest states when the archive begins, from the ticks',
	digest.includes('archive since ' + utc(NOW - 3600000)), digest.trim().split('\n')[0]);
check('digest gives each device its own coverage stamp',
	digest.split('\n').filter(l => / since \d\d:\d\dZ /.test(l)).length === 2,
	digest.split('\n').filter(l => / since /.test(l)).length + ' device line(s)');
check('digest names the console and the feed health',
	/console \(1h\): 2 warn, 1 err/.test(digest) && /throttled 2 postFail 1 cdrop 5/.test(digest),
	digest.split('\n').filter(l => /console|throttled/.test(l)).join(' | '));
check('digest --json carries the feed health',
	lensJson('digest').console1h.warn === 2 && lensJson('digest').feedHealth[0].postFail === 1,
	JSON.stringify(lensJson('digest').feedHealth));
check('digest --json carries the same figures',
	Math.abs(lensJson('digest').spend24h - 2.22) < 1e-9
		&& lensJson('digest').turns24h === 6,
	JSON.stringify([lensJson('digest').spend24h, lensJson('digest').turns24h]));

// ── round/fold/ended — the turn-loop events added 2026-09-12 ─────────
//
// Its own archive, deliberately separate from the fixture universe above: a
// turn joined by `turn` id across `round`/`fold`/`ended`/`turn.end` touches
// `turnRecords`' whole merge, and folding it into the shared device A/B
// fixtures would ripple through every count that reads `turns`/`events`/
// `status` unfiltered. Two turns: an ordinary chat turn that DOES close with
// a `turn.end` (the real short keys daimond.js sends, not the long ones
// above), and a daimon-shaped turn that never gets one -- only `round`,
// `fold` and `ended` -- which is the gap this lane closes.

const ROOT2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-verify-rt-'));
fs.mkdirSync(path.join(ROOT2, 'traces'), { recursive: true });
const DEV_RT = 'devRT0000000000000000000000000rt';
const RT_BT = NOW - 40000;
const rtRow = (n, kind, extra, t) =>
	row(t, 'ev ' + kind, JSON.stringify(Object.assign({ v: 1, d: DEV_RT, n, b: BUILD_A, t }, extra)));
const RT_BLOCK = block(RT_BT, DEV_RT, [
	// The chat turn: rounds 1 and 5 sampled (throttled to every 5th), round 6
	// caught at `ended` because the turn stopped on one the throttle skipped --
	// exactly the catch-up `runTurn`'s `ended` arm does. One real fold partway
	// through, `turn.end` with the actual short field names, and the same
	// turn's `ended` alongside it (both arms fire for a chat turn).
	rtRow(1, 'round', { turn: 'chatT1', r: 1, ctx: 20000, win: 200000, ca: 5000, msgs: 2, tool: 'read_file' }, NOW - 39000),
	rtRow(2, 'round', { turn: 'chatT1', r: 4, ctx: 38000, win: 200000, ca: 9000, msgs: 8 }, NOW - 37000),
	rtRow(3, 'fold', { turn: 'chatT1', r: 4, folded: 12, kept: 4, trigger: 'real' }, NOW - 36500),
	rtRow(4, 'round', { turn: 'chatT1', r: 6, ctx: 15000, win: 200000, ca: 9000, msgs: 10 }, NOW - 35000),
	rtRow(5, 'turn.end', { turn: 'chatT1', r: 6, p: 15000, c: 800, ca: 9000, usd: 0.03, ms: 1200, out: 'done' }, NOW - 34900),
	rtRow(6, 'ended', { turn: 'chatT1', rounds: 6, how: 'done' }, NOW - 34800),
	// The daimon turn: no `turn.end` at all, ever -- only `round`/`fold`/`ended`,
	// `dia: 1`. Rounds 1, 5 and 10 sampled; it stops on the round-call limit.
	rtRow(7,  'round', { turn: 'daimonT1', r: 1,  ctx: 20000, win: 200000, ca: 4000, msgs: 2, dia: 1 }, NOW - 33000),
	rtRow(8,  'round', { turn: 'daimonT1', r: 5,  ctx: 60000, win: 200000, ca: 30000, msgs: 14, dia: 1 }, NOW - 31000),
	rtRow(9,  'fold', { turn: 'daimonT1', r: 7, folded: 30, kept: 10, trigger: 'real', dia: 1 }, NOW - 30500),
	rtRow(10, 'round', { turn: 'daimonT1', r: 10, ctx: 95000, win: 200000, ca: 55000, msgs: 22, dia: 1 }, NOW - 29000),
	rtRow(11, 'ended', { turn: 'daimonT1', rounds: 10, how: 'round_limit', dia: 1 }, NOW - 28900),
	// A WORKER's own round samples, keyed `w` rather than `turn` -- no `ctx`,
	// unlike a chat's or daimon's.
	rtRow(12, 'round', { w: 'w7', r: 1 }, NOW - 28000),
	rtRow(13, 'round', { w: 'w7', r: 5 }, NOW - 27000),
]);
fs.writeFileSync(path.join(ROOT2, 'traces', `${ACCOUNT}-${DEV_RT}.log`), RT_BLOCK);

function lens2(...args) {
	return execFileSync('node', [LENS, ...args], {
		encoding: 'utf8',
		env: Object.assign({}, process.env, { DAIMOND_LENS_HOME: ROOT2, DAIMOND_LENS_REMOTE: '' }),
	});
}
function lensJson2(...args) {
	return JSON.parse(lens2(...args, '--json').trim());
}

lensJson2('pull', '--no-rsync');
const rtTurns = lensJson2('turns', '--since', '24h');
const chatT1 = rtTurns.find(t => t.turn === 'chatT1');
const daimonT1 = rtTurns.find(t => t.turn === 'daimonT1');

check('a turn.end read by its real short field names carries rounds, tokens and cost',
	!!chatT1 && chatT1.rounds === 6 && chatT1.prompt === 15000 && chatT1.cached === 9000
		&& Math.abs(chatT1.usd - 0.03) < 1e-9 && chatT1.outcome === 'done',
	JSON.stringify(chatT1));
check('its max per-round prompt and fold count are joined on by turn id',
	!!chatT1 && chatT1.maxPrompt === 38000 && chatT1.folds === 1,
	JSON.stringify(chatT1 && [chatT1.maxPrompt, chatT1.folds]));
check('its `ended` event is not a second turn (de-duplicated by turn id)',
	rtTurns.filter(t => t.turn === 'chatT1').length === 1, String(rtTurns.filter(t => t.turn === 'chatT1').length));

check('a daimon turn with no turn.end at all is still a turn, from `ended` alone',
	!!daimonT1 && daimonT1.src === 'ended' && daimonT1.rounds === 10 && daimonT1.outcome === 'round_limit',
	JSON.stringify(daimonT1));
check('its max per-round prompt and fold count are joined the same way',
	!!daimonT1 && daimonT1.maxPrompt === 95000 && daimonT1.folds === 1,
	JSON.stringify(daimonT1 && [daimonT1.maxPrompt, daimonT1.folds]));
check('a daimon turn states no USD it cannot know, rather than reporting zero',
	!!daimonT1 && daimonT1.usd === null, JSON.stringify(daimonT1 && daimonT1.usd));

const rtLine = lens2('turns', '--since', '24h');
check('`lens turns` prints the round count, the max and the fold count',
	/r6\s+max 38k\s+f1/.test(rtLine) && /r10\s+max 95k\s+f1/.test(rtLine),
	rtLine.trim().split('\n').filter(l => /chatT1|r6|r10/.test(l) || true).slice(0, 2).join(' | '));

const roundEvents = lens2('events', '--since', '24h', '--kind', 'round');
check('`lens events --kind round` summarises the sampled rounds per turn',
	/turn daimonT1: rounds 1-10 sampled \(3\), max prompt 95k/.test(roundEvents),
	roundEvents.trim().split('\n').slice(-3).join(' | '));
check('and a worker\'s own rounds, by its id rather than a turn',
	/worker w7: rounds 1-5 sampled \(2\)/.test(roundEvents),
	roundEvents.trim().split('\n').slice(-4).join(' | '));

fs.rmSync(ROOT2, { recursive: true, force: true });

// ── second-line redaction: a secret the client's own regex missed ────
//
// `www/js/debugshare.js` matches a secret-shaped key on a `_`/`.`/`-` boundary,
// so a camelCase-joined field such as `pushToken` (a GitHub personal access
// token, carried on `config`) or a nested `authSecret` slides past it, exactly
// the shape the client-side fix and this one both close. Its own archive,
// since a snapshot fixture belongs with the other snapshot coverage above but
// this one is deliberately built to arrive UN-redacted -- simulating the client
// missing it -- and must not perturb the counts asserted against SNAP.

const ROOT3 = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-verify-secret-'));
fs.mkdirSync(path.join(ROOT3, 'traces'), { recursive: true });
const DEV_S = 'devS00000000000000000000000000ss';
const RAW_PUSH_TOKEN = 'ghp_ZZZFAKEpersonalAccessTOKEN0123456789abcd';	// allowlist secret
const RAW_AUTH_SECRET = 'ZZZFAKEnestedAUTHsecretvalue998877';	// allowlist secret
const SNAP_SECRET = {
	v: 1, kind: 'snapshot', ts: NOW - 20000, iso: new Date(NOW - 20000).toISOString(),
	config: {
		model: 'fixture/model-c',
		pushToken: RAW_PUSH_TOKEN,			// camelCase-joined -- the field this lane exists for
		nested: { authSecret: RAW_AUTH_SECRET },	// one level down, still camelCase-joined
	},
	transcripts: [], presence: null, roster: {}, election: null,
	tokenStats: [], signals: null, ledger: [], ledgerDropped: 0, trail: [], diag: [],
};
const secretRows = chunkRows('snapshot', 'sfixturesecret', SNAP_SECRET, NOW - 20000);
const S_BLOCK = block(NOW - 20000, DEV_S, secretRows.map(r => row(r.ts, r.tag, r.data)));
fs.writeFileSync(path.join(ROOT3, 'traces', `${ACCOUNT}-${DEV_S}.log`), S_BLOCK);

function lens3(...args) {
	return execFileSync('node', [LENS, ...args], {
		encoding: 'utf8',
		env: Object.assign({}, process.env, { DAIMOND_LENS_HOME: ROOT3, DAIMOND_LENS_REMOTE: '' }),
	});
}
function lensJson3(...args) { return JSON.parse(lens3(...args, '--json').trim()); }

lensJson3('pull', '--no-rsync');
const snapSecret = lensJson3('snapshot', '--latest');
// The bytes actually sitting in the archive, not just what the CLI prints, so
// this proves the FILE never carried the raw value -- the point of a second
// line the client cannot bypass by us only checking its own read path.
const secretBodyFile = fs.readdirSync(path.join(ROOT3, 'archive', 'snapshots'))
	.map(n => path.join(ROOT3, 'archive', 'snapshots', n))
	.find(f => fs.readFileSync(f, 'utf8').includes('"kind":"snapshot"'));
const secretBodyText = secretBodyFile ? fs.readFileSync(secretBodyFile, 'utf8') : '';

check('a camelCase pushToken the client missed is NOT on disk in the clear',
	!secretBodyText.includes(RAW_PUSH_TOKEN));
check('pushToken is fingerprinted by the archive\'s own second-line redaction',
	snapSecret && snapSecret.config && /^\[redacted /.test(snapSecret.config.pushToken),
	JSON.stringify(snapSecret && snapSecret.config));
check('a nested camelCase authSecret the client missed is NOT on disk in the clear',
	!secretBodyText.includes(RAW_AUTH_SECRET));
check('the nested authSecret is fingerprinted a level down',
	snapSecret && snapSecret.config && snapSecret.config.nested
		&& /^\[redacted /.test(snapSecret.config.nested.authSecret),
	JSON.stringify(snapSecret && snapSecret.config && snapSecret.config.nested));
check('an ordinary config field alongside the secrets survives untouched',
	snapSecret && snapSecret.config && snapSecret.config.model === 'fixture/model-c');

fs.rmSync(ROOT3, { recursive: true, force: true });

// ── second-line CONTENT scrubbing: a key in free text, not in a field name ──
//
// The block above proves the archive's own name-based redaction. This one proves
// the other half, and the one the owner actually asked for: a credential sitting
// in FREE TEXT -- a console line, a transcript, a tool argument, a failed fetch's
// URL -- has no field name to match on, and `redactConfig` is blind to every one
// of them. The client scrubs these before posting; this proves the archive does
// it again on ingest, so a device on an older build cannot leave a plaintext key
// in `~/.cache/daimond-lens/archive` for good.
//
// Every fixture is BUILT from a seed rather than typed, so this file carries no
// paste-able credential and only the SHAPES are real.

const ROOT4 = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-verify-scrub-'));
fs.mkdirSync(path.join(ROOT4, 'traces'), { recursive: true });
// A device id and a snapshot id of the shape the REAL feed mints, deliberately:
// joined, they are a 45-character run the entropy catch scores at 4.42 and would
// take, which is how `lens snapshot` lost the body file it had just written. A
// zero-padded fixture id would have scored far lower and proved nothing.
const DEV_X = 'b3f71c9a2e604d8815aa77c0deef1932';
const SNAP_X_ID = 'smtz4k7qv91b';

const seeded = (n, seed, alpha) => {
	alpha = alpha || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let s = '', h = (seed * 2654435761) >>> 0;
	for (let i = 0; i < n; i++) { h = (h * 1103515245 + 12345) >>> 0; s += alpha[(h >>> 8) % alpha.length]; }
	return s;
};
// One per lane, so a survivor names the path it came in on.
const FAKE = {
	transcript: 'sk-' + seeded(48, 301),		// quoted back by the daimon, in a chat
	toolarg:    'ghp_' + seeded(36, 302),		// an argument a tool was called with
	console:    'sk-ant-api03-' + seeded(80, 303),	// a line the tab printed
	fetchurl:   seeded(32, 304),				// a token in a failed request's URL
	tile:       'AIza' + seeded(35, 305),		// what the person was LOOKING at
};

const SNAP_SCRUB = {
	v: 1, kind: 'snapshot', ts: NOW - 20000, iso: new Date(NOW - 20000).toISOString(),
	// Not a secret-NAMED field anywhere: every one of these is prose.
	config: { model: 'fixture/model-d', baseUrl: 'https://fixture.invalid/v1' },
	transcripts: [ { id: 'cScrub', name: 'fixture chat', model: 'fixture/model-d', messages: [
		{ role: 'user', mid: 'mfix-1-aaaaa', content: 'here it is: ' + FAKE.transcript },
		{ role: 'tool_log', mid: 'mfix-2-bbbbb', name: 'file_read',
			callId: 'call_00_AbC9dEf1GhI2jKl3',
			args: '{"path":"/home/x/.netrc","token":"' + FAKE.toolarg + '"}', content: '' },
	] } ],
	presence: null, roster: {}, election: null,
	tokenStats: [ { id: 'cScrub', name: 'fixture chat', model: 'fixture/model-d', messages: 2, contextWindow: 200000 } ],
	signals: null, ledger: [], ledgerDropped: 0, trail: [], diag: [],
};

const evX = (n, kind, extra, t) =>
	row(t, 'ev ' + kind, JSON.stringify(Object.assign({ v: 1, d: DEV_X, n, b: BUILD_A, t }, extra)));

const X_BT = NOW - 20000;
const scrubRows = chunkRows('snapshot', SNAP_X_ID, SNAP_SCRUB, X_BT)
	.map(r => row(r.ts, r.tag, r.data));
const X_BLOCK = block(X_BT, DEV_X, [
	evX(1, 'console', { lvl: 'warn', msg: '[gw] refused: ' + FAKE.console, src: 'gateway.js:689' }, X_BT),
	evX(2, 'fetch.fail', { path: '/api/sync?access_token=' + FAKE.fetchurl, status: 401, ms: 12 }, X_BT),
	evX(3, 'screen', { view: 'chat', seat: 'runner: this device',
		tile: 'assistant: your key is ' + FAKE.tile, dlg: 'none', comp: 0, locked: 0 }, X_BT),
	...scrubRows,
]);
fs.writeFileSync(path.join(ROOT4, 'traces', `${ACCOUNT}-${DEV_X}.log`), X_BLOCK);

function lens4(...args) {
	return execFileSync('node', [LENS, ...args], {
		encoding: 'utf8',
		env: Object.assign({}, process.env, { DAIMOND_LENS_HOME: ROOT4, DAIMOND_LENS_REMOTE: '' }),
	});
}
lens4('pull', '--no-rsync');

// EVERY BYTE the archive holds for this device, not just what the CLI chooses to
// print: the point of a second line is that the FILE never carried the value.
const archiveText = (() => {
	const dirs = [path.join(ROOT4, 'archive'), path.join(ROOT4, 'archive', 'snapshots')];
	let out = '';
	for (const d of dirs) {
		let names = [];
		try { names = fs.readdirSync(d); } catch (e) { continue; }
		for (const n of names) {
			const f = path.join(d, n);
			if (!fs.statSync(f).isFile()) continue;
			out += fs.readFileSync(f, 'utf8');
		}
	}
	return out;
})();

const survivors = Object.keys(FAKE).filter(k => archiveText.includes(FAKE[k]));
check('no credential shape survives ingest, in any lane',
	survivors.length === 0, survivors.length ? 'survived: ' + survivors.join(', ') : 'five lanes clean');
check('the archive carries the scrubber\'s marker in their place',
	/\[redacted (?:sk|gh|gcp|urlarg|named|hi) #[0-9a-f]+\/\d+\]/.test(archiveText));
// And the legibility half: an archive scrubbed into uselessness is no archive.
check('the chat, the tool name and the message ids still read',
	archiveText.includes('cScrub') && archiveText.includes('file_read')
		&& archiveText.includes('mfix-1-aaaaa'));
check('the tool-call id a reader correlates by still reads',
	archiveText.includes('call_00_AbC9dEf1GhI2jKl3'));
check('the device id, the build id and the model id still read',
	archiveText.includes(DEV_X) && archiveText.includes(BUILD_A)
		&& archiveText.includes('fixture/model-d'));
// The `console` and `errors` questions must still answer over a scrubbed line.
const scrubConsole = lens4('console', '--device', DEV_X);
check('`lens console` still prints the scrubbed line, source and all',
	/gateway\.js:689/.test(scrubConsole) && /refused/.test(scrubConsole)
		&& !scrubConsole.includes(FAKE.console));

// THE INDEX MUST STILL POINT AT THE BODY. The snapshot filename is a device id
// and a snapshot id joined -- a 45-character run the entropy catch reads as a
// credential -- so `body` is exempt from that catch (and from nothing else). If
// it stops being, this is the check that says so rather than a silent "the body
// file is missing" months later.
const snapOut = lens4('snapshot', '--latest', '--json');
let snapBody = null;
try { snapBody = JSON.parse(snapOut.trim()); } catch (e) { /* left null */ }
check('`lens snapshot --latest` still resolves the body file it wrote',
	!!(snapBody && snapBody.kind === 'snapshot'),
	snapBody ? 'chats ' + (snapBody.tokenStats || []).length : snapOut.trim().slice(0, 80));
check('and the resolved body is the SCRUBBED one, not the posted one',
	!!snapBody && !JSON.stringify(snapBody).includes(FAKE.transcript));

fs.rmSync(ROOT4, { recursive: true, force: true });

// ── roster names, and the ledger/turn.end merge for a daimon turn ────
//
// Two things this lane fixes, in one small fixture: `status`/`turns`/etc.
// printing the ID ALONE is what made two sessions in one day mis-assign
// a7b34e2 (= gilgamesh) as argonaut (= 96a1474) -- so this device's roster
// names it "Chrome on argonaut" and both the print and `--device argonaut`
// are checked. And a daimon turn -- `turn.start`, two `round`s, three `tool`s,
// `ended`, and its OWN `turn.end` (`dia: 1`, no model on the `turn.end` payload,
// which is the real shape) -- alongside the telemetry ledger entry the same
// turn posts, joined by device + a five-second clock skew + equal prompt
// tokens: proof the merge yields ONE row, not the $1.74-for-$0.87 double count
// this lane was written to close.

const ROOT5 = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-verify-merge-'));
fs.mkdirSync(path.join(ROOT5, 'traces'), { recursive: true });
const DEV_M = 'devM00000000000000000000000000mm';
const BUILD_M = 'fixturebuildm';
const mRow = (n, kind, extra, t) =>
	row(t, 'ev ' + kind, JSON.stringify(Object.assign({ v: 1, d: DEV_M, n, b: BUILD_M, t }, extra)));

// The roster: the only source of a short NAME, same as it is the only source of
// a build until `ev` rows ship it.
const SNAP_M = {
	v: 1, kind: 'snapshot', ts: NOW - 19000, iso: new Date(NOW - 19000).toISOString(),
	config: { model: 'fixture/glm-5.3' }, transcripts: [], presence: null,
	roster: { [DEV_M]: { name: 'Chrome on argonaut', label: '', created: NOW - 100000,
		namedAt: 0, seen: NOW - 19000, build: BUILD_M } },
	election: null, tokenStats: [], signals: null, ledger: [], ledgerDropped: 0, trail: [], diag: [],
};
// The ledger tick: `t` five seconds inside the `turn.end` row below and the
// SAME prompt tokens (12000) -- the join key -- carrying the model and the
// `reported` flag the `turn.end` payload for this path does not.
const TEL_M = {
	v: 1, kind: 'telemetry', ts: NOW - 20000, iso: new Date(NOW - 20000).toISOString(),
	ledger: [ { t: NOW - 20100, m: 'fixture/glm-5.3', p: 12000, c: 500, ca: 4000, u: 0.42,
		r: 1, e: false, pv: 'fixture' } ],
	trail: [], diag: [],
	stats: { models: [], diamonds: [], signalModels: [], cross: [],
		live: { contextActual: 0, contextWindow: 0, foldAt: 0, activeModel: 'fixture/glm-5.3',
			provider: 'fixture', workerState: { active: 0, queued: 0, busy: false }, activity: 'idle' } },
};

const M_BLOCK = block(NOW - 25000, DEV_M, [
	mRow(1, 'turn.start', { turn: 'daimonM1', chat: 'cM', model: 'fixture/glm-5.3', dia: 1 }, NOW - 24000),
	mRow(2, 'round', { turn: 'daimonM1', r: 1, ctx: 8000, win: 200000, ca: 2000, msgs: 2, dia: 1 }, NOW - 23000),
	mRow(3, 'round', { turn: 'daimonM1', r: 2, ctx: 12000, win: 200000, ca: 4000, msgs: 4, dia: 1 }, NOW - 22000),
	mRow(4, 'tool', { turn: 'daimonM1', name: 'read_file', dia: 1 }, NOW - 21800),
	mRow(5, 'tool', { turn: 'daimonM1', name: 'grep', dia: 1 }, NOW - 21600),
	mRow(6, 'tool', { turn: 'daimonM1', name: 'edit', dia: 1 }, NOW - 21400),
	mRow(7, 'ended', { turn: 'daimonM1', rounds: 2, how: 'done', dia: 1 }, NOW - 20200),
	// The daimon's OWN `turn.end` -- no `m`/`model` field, which is why the
	// unmatched row this lane used to leave behind printed as `? r2 est`.
	mRow(8, 'turn.end', { turn: 'daimonM1', r: 2, p: 12000, c: 500, ca: 4000, usd: 0.42,
		out: 'done', dia: 1 }, NOW - 20100),
	...chunkRows('telemetry', 'tfixturem01', TEL_M, NOW - 20000).map(r => row(r.ts, r.tag, r.data)),
	...chunkRows('snapshot', 'sfixturem01', SNAP_M, NOW - 19000).map(r => row(r.ts, r.tag, r.data)),
]);
fs.writeFileSync(path.join(ROOT5, 'traces', `${ACCOUNT}-${DEV_M}.log`), M_BLOCK);

function lens5(...args) {
	return execFileSync('node', [LENS, ...args], {
		encoding: 'utf8',
		env: Object.assign({}, process.env, { DAIMOND_LENS_HOME: ROOT5, DAIMOND_LENS_REMOTE: '' }),
	});
}
function lensJson5(...args) { return JSON.parse(lens5(...args, '--json').trim()); }

lensJson5('pull', '--no-rsync');

const mTurns = lensJson5('turns', '--since', '24h');
const daimonM = mTurns.filter(t => t.turn === 'daimonM1');
check('a daimon turn posting both a ledger tick and its own turn.end is ONE row',
	daimonM.length === 1, JSON.stringify(mTurns.map(t => [t.src, t.turn, t.model, t.usd])));
check('the merged row carries the ledger\'s model and reported flag',
	!!daimonM[0] && daimonM[0].model === 'fixture/glm-5.3' && daimonM[0].reported === true,
	JSON.stringify(daimonM[0]));
check('and the turn.end\'s own rounds, not the ledger\'s null',
	!!daimonM[0] && daimonM[0].rounds === 2, JSON.stringify(daimonM[0] && daimonM[0].rounds));
check('its maxPrompt/folds still join by turn id after the merge',
	!!daimonM[0] && daimonM[0].maxPrompt === 12000 && daimonM[0].folds === 0,
	JSON.stringify(daimonM[0] && [daimonM[0].maxPrompt, daimonM[0].folds]));
check('the spend is counted once, not doubled to $0.84',
	Math.abs(mTurns.reduce((a, t) => a + (t.usd || 0), 0) - 0.42) < 1e-9,
	JSON.stringify(mTurns.map(t => t.usd)));

const statusM = lens5('status');
const statusMLine = statusM.split('\n').find(l => l.startsWith(DEV_M.slice(0, 7))) || '';
check('status labels the device by its roster name, beside the id',
	statusMLine.startsWith(DEV_M.slice(0, 7) + ' argonaut'), statusMLine);
check('--device selects by roster name substring, not just an id prefix',
	lensJson5('turns', '--since', '24h', '--device', 'argonaut').length === 1
		&& lensJson5('turns', '--since', '24h', '--device', 'argonaut')[0].turn === 'daimonM1',
	JSON.stringify(lensJson5('turns', '--since', '24h', '--device', 'argonaut').map(t => t.turn)));
check('the name match is case-insensitive',
	lensJson5('status', '--device', 'Argonaut').devices.length === 1);

fs.rmSync(ROOT5, { recursive: true, force: true });

// ── An unknown command must not look like success ────────────────────

let rc = 0;
try { lens('nonsense'); } catch (e) { rc = e.status; }
check('an unknown command exits non-zero', rc === 2, 'exit ' + rc);

fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\nlens: ${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);

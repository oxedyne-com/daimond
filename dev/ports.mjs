// ports.mjs — the bindings that used to be fixed for the whole machine, read
// from the world that owns them.
//
// `dev/world.sh` holds the port register and says why it exists. Three of its
// rows were, until 2026-08-25, in a paragraph headed "fixed, and shared by every
// world": the gateway, the IMAP fixture and the submission stand-in. Nineteen
// files in `dev/` held the literal `http://127.0.0.1:9002` between them, each
// having decided for itself that the gateway is at a fixed address.
//
// It is not, and the cost was measured in lane-afternoons rather than in calls.
// `dev/serve.mjs` proxied EVERY world's `/api` to 9002, so which gateway a
// verifier read was whichever lane happened to have one up: `verify_attachfocus`
// and `verify_chatworkspace` went red four runs out of six on a tree nobody had
// changed, and both answered it by excluding 401 from their console check --
// a remedy per file, which is how four files came to have one and two did not.
// `dev/pro.mjs` posted a signed Pro webhook at a stranger's gateway the same day,
// which answered 500: the suite read that as "entitled accounts ready: no" and
// skipped two verifiers, and the stranger was sent a licence event for an account
// it had never heard of.
//
// So this is the one place that answers "where is it". A twentieth file cannot
// decide the question differently again without deleting this line.
//
// 2026-10-16 (K1): the register itself moved out of a comment in `dev/world.sh`
// into `dev/ports.json`, read here. Thirty-odd files still held a fixed port of
// their own -- 9187, 8960, 9143 and the rest -- and each landed on some world's
// derived port: world 88's mock is 9187, so a lane in world 88 killed
// `verify_granthand` in every other world, and world 62's terminal demo was
// 9002, the production gateway. Every port is now `base + stride*N` for this
// world's N, read through `port()`, and `dev/portlint.mjs` refuses a literal
// that is not a row.
//
// THE FALLBACKS ARE THE HISTORICAL PORTS AND THAT IS NOT AN OVERSIGHT: a server
// started by hand in no world should still find a fixture started by hand in no
// world. Under a world every one of these variables is set, and the gateway's is
// never set to 9002 -- see `dev/world.sh`, which explains why that port belongs
// to nobody.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/// The register, as data. Rows, the world-less ports named one by one, and the
/// bands of world numbers that belong to someone.
export const REGISTER = JSON.parse(fs.readFileSync(
	fileURLToPath(new URL('./ports.json', import.meta.url)), 'utf8'));

/// This process's world number: `DAIMOND_WORLD` as `world.sh` exports it, else
/// read back from the app port (every world before K1 exported only that), else
/// 0, the historical world a hand run with no world gets.
export const WORLD = (() => {
	const w = process.env.DAIMOND_WORLD;
	if (w !== undefined && w !== '') return Number(w);
	// Only when the app port IS a world's: a verifier that starts a server of its
	// own hands that server DAIMOND_PORT too, and that number names no world.
	const n = Number(process.env.DAIMOND_PORT) - 8777;
	return Number.isInteger(n) && n >= 0 && n <= REGISTER.worlds.max ? n : 0;
})();

/// The `i`-th port of row `name` for world `n`, with no environment consulted.
export function portOf(name, n = WORLD, i = 0) {
	const r = REGISTER.rows.find(x => x.name === name);
	if (!r) throw new Error(`ports.mjs: no register row '${name}' in dev/ports.json`);
	const span = r.span || 1;
	if (!(i >= 0 && i < span)) throw new Error(`ports.mjs: row '${name}' has ${span} port(s), asked for #${i}`);
	if (!(Number.isInteger(n) && n >= 0 && n <= REGISTER.worlds.max)) {
		throw new Error(`ports.mjs: world ${n} is outside 0..${REGISTER.worlds.max}, where the register is disjoint`);
	}
	return r.base + r.stride * n + i;
}

/// The `i`-th port of row `name` in this world. The row's own variable, when it
/// has one and it is set, wins for the first port: a caller that chose a port
/// has asked for it.
export function port(name, i = 0) {
	const r = REGISTER.rows.find(x => x.name === name);
	if (r && r.env && i === 0 && process.env[r.env]) return Number(process.env[r.env]);
	return portOf(name, WORLD, i);
}

/// Every way `reg` fails to be a register: for each world N in 0..max, two rows
/// meeting, a row meeting a port fixed by name or leaving the usable range, and
/// two bands claiming one world number. Empty when it is one. `dev/portlint.mjs`
/// and `dev/verify_worldports.mjs` both judge by this, so there is one rule.
export function registerFaults(reg) {
	const faults = [];
	const fixedAt = new Map();
	for (const f of reg.fixed) {
		const lo = f.port ?? f.from, hi = f.port ?? f.to;
		for (let p = lo; p <= hi; p++) fixedAt.set(p, f.name);
	}
	const owner = new Map();	// port -> "row R world N"
	let claims = 0;
	for (const r of reg.rows) {
		const span = r.span || 1;
		if (r.stride < span) faults.push(`row ${r.name}: stride ${r.stride} is narrower than its span ${span}, so world N meets world N+1`);
		for (let n = 0; n <= reg.worlds.max; n++) {
			for (let i = 0; i < span; i++) {
				const p = r.base + r.stride * n + i;
				claims++;
				if (p < 1024 || p > 65535) faults.push(`row ${r.name} world ${n}: :${p} is not a usable port`); // portlint: ok, the usable range
				else if (p >= 32768 && p <= 60999) faults.push(`row ${r.name} world ${n}: :${p} is in the kernel's ephemeral range`);
				if (fixedAt.has(p)) faults.push(`row ${r.name} world ${n}: :${p} is ${fixedAt.get(p)}, fixed by name`);
				const o = owner.get(p);
				if (o) faults.push(`row ${r.name} world ${n}: :${p} is already ${o}`);
				else owner.set(p, `row ${r.name} world ${n}`);
			}
		}
	}
	const names = new Set();
	for (const r of reg.rows) { if (names.has(r.name)) faults.push(`row name ${r.name} appears twice`); names.add(r.name); }
	const bandOf = new Map();
	for (const b of reg.bands) {
		for (let n = b.from; n <= b.to; n++) {
			if (n > reg.worlds.max) faults.push(`band ${b.name}: world ${n} is past ${reg.worlds.max}`);
			if (bandOf.has(n)) faults.push(`world ${n} is in band ${bandOf.get(n)} and band ${b.name}`);
			bandOf.set(n, b.name);
		}
	}
	const [w0, w1] = reg.worlds.nightly_window;
	for (let n = w0; n <= w1; n++) {
		if (/^nightly/.test(bandOf.get(n) || '')) faults.push(`world ${n} is the nightly's and inside its own window`);
	}
	faults.claims = claims;
	faults.fixed = fixedAt;
	return faults;
}

/// The worlds of band `name`, less any it holds back.
export function bandWorlds(name, reg = REGISTER) {
	const b = reg.bands.find(x => x.name === name);
	if (!b) throw new Error(`ports.mjs: no band '${name}' in dev/ports.json`);
	const out = [];
	for (let n = b.from; n <= b.to; n++) if (!(b.less || []).includes(n)) out.push(n);
	return out;
}

/// The port this world's gateway listens on, or would if it had one.
export const GW_PORT = Number(process.env.DAIMOND_GW_PORT || 9002);

/// The gateway's base URL — no trailing slash, so `${GW_URL}/api/health` reads
/// the way every call site already wrote it.
export const GW_URL = `http://127.0.0.1:${GW_PORT}`;

/// fe2o3's `imap_test_server`, which takes its port as its first argument.
export const IMAP_PORT = Number(process.env.DAIMOND_IMAP_PORT || 1143);

/// `dev/smtpd.mjs`, the submission stand-in that catches what is sent.
export const SMTP_PORT = Number(process.env.SMTPD_PORT || 1587);

// ── The command line, for bash ─────────────────────────────────────────────
//
//   node dev/ports.mjs <row> [i]         one port of this world (DAIMOND_WORLD)
//   node dev/ports.mjs --world N <row>   one port of world N
//   node dev/ports.mjs --table [N]       the register, with world N's ports
//   node dev/ports.mjs --nightly-admits N   exit 0 when world N may come up while
//                                        the nightly runs: its window or its own band
//                                        (the band only for DAIMOND_NIGHTLY_SHARD=1)
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
	const a = process.argv.slice(2);
	let n = WORLD;
	const wi = a.indexOf('--world');
	if (wi !== -1) { n = Number(a[wi + 1]); a.splice(wi, 2); }
	try {
		if (a[0] === '--table') {
			if (a[1] !== undefined) n = Number(a[1]);
			for (const r of REGISTER.rows) {
				const span = r.span || 1;
				const ps = [];
				for (let i = 0; i < span; i++) ps.push(portOf(r.name, n, i));
				const f = `${r.base}${r.stride === 1 ? ' + N' : ` + ${r.stride}N`}${span > 1 ? ` (+0..${span - 1})` : ''}`;
				console.log(`${f.padEnd(22)}${r.name.padEnd(18)}${(r.env || '').padEnd(24)}world ${n}: ${ps.join(' ')}`);
			}
			for (const x of REGISTER.fixed) {
				console.log(`${String(x.port ?? `${x.from}-${x.to}`).padEnd(22)}FIXED: ${x.name}`);
			}
		} else if (a[0] === '--nightly-admits') {
			const w = Number(a[1]);
			const [w0, w1] = REGISTER.worlds.nightly_window;
			const own = REGISTER.bands.filter(b => /^nightly/.test(b.name));
			// The nightly's own band is its shards', not anybody's who asks: a lane taking
			// world 83 during the nightly's setup would have shard 3's `--up` refused, and a
			// band the night leaves unused would stand open until morning. `gateshard_run.sh`
			// marks its callers with DAIMOND_NIGHTLY_SHARD=1.
			const shard = process.env.DAIMOND_NIGHTLY_SHARD === '1';
			if ((w >= w0 && w <= w1) || (shard && own.some(b => w >= b.from && w <= b.to))) process.exit(0);
			console.log(`${w0}-${w1}` + own.map(b => ` (the nightly's own ${b.from}-${b.to} only with DAIMOND_NIGHTLY_SHARD=1)`).join(''));
			process.exit(1);
		} else if (a[0]) {
			const i = Number(a[1] || 0);
			console.log(wi === -1 ? port(a[0], i) : portOf(a[0], n, i));
		} else {
			console.error('usage: node dev/ports.mjs <row> [i] | --world N <row> [i] | --table [N] | --nightly-admits N');
			process.exit(2);
		}
	} catch (e) { console.error(e.message); process.exit(2); }
}

// engineworker_fixture.mjs -- the folder the engine-worker starvation probe searches (U5, 2026-10-11).
//
// A tree of about forty thousand files, NONE of them in a directory the walk ignores (.git,
// node_modules, target), so the search has to open every one: what keeps the probe RED after
// the FIRE fixes that cut the walk of ignored trees. It is written into his agreed tree, the
// page's own store (root '/'), through the page's own door (`DaimondCloud.writeText`); the
// browser Machine folder it once stood in went with G5 (D-20261031-11).
//
// The tree is deterministic: `top-NN/sub-NN/file-NN.<ext>`, each file a few hundred bytes of
// source-like text. The needle `ENGWORK_NEEDLE` sits in one file in five hundred, so a search
// for it reads the whole tree and reports a few dozen hits. Each run is a fresh profile, so
// every run searches a fresh tree.
//
//   import { FIXTURE, seedFixture } from './engineworker_fixture.mjs';
//   const shape = await seedFixture(page, { dir: 'engwork' });

export const FIXTURE = {
	tops:	40,				// top-level directories
	subs:	25,				// directories in each
	files:	40,				// files in each of those
	needle:	'ENGWORK_NEEDLE',
	every:	500,			// one file in this many carries the needle
};

export const fixtureCount = (f = FIXTURE) => f.tops * f.subs * f.files;

/// Write the tree into the store at `dir`. Runs in the page; returns `{ files, ms, needles }`.
export async function seedFixture(page, { dir, fixture = FIXTURE }) {
	return page.evaluate(async ({ dir, f }) => {
		const t0   = performance.now();
		const total = f.tops * f.subs * f.files;
		const needles = Math.floor((total - 1) / f.every) + 1;
		const exts = ['md', 'rs', 'js', 'txt', 'typ'];
		const words = ['alpha', 'beacon', 'cinder', 'delta', 'ember', 'falcon', 'garnet', 'harbour',
			'island', 'juniper', 'kestrel', 'lantern', 'meadow', 'nickel', 'orchard', 'pebble'];
		const body = (k) => {
			let s = '// fixture file ' + k + '\n';
			for (let l = 0; l < 12; l++) {
				s += 'fn ' + words[(k + l) % 16] + '_' + l + '() { let ' + words[(k * 7 + l) % 16]
					+ ' = ' + ((k * 31 + l) % 997) + '; }\n';
			}
			if (k % f.every === 0) s += 'const marker = "' + f.needle + '";\n';
			return s;
		};
		// Sixty-four writes in flight: forty thousand of them one at a time take minutes.
		const jobs = [];
		for (let a = 0; a < f.tops; a++) {
			for (let b = 0; b < f.subs; b++) jobs.push([a, b]);
		}
		const pad = (n) => String(n).padStart(2, '0');
		let next = 0;
		const worker = async () => {
			while (next < jobs.length) {
				const [a, b] = jobs[next++];
				const d = dir + '/top-' + pad(a) + '/sub-' + pad(b);
				for (let c = 0; c < f.files; c++) {
					const k = (a * f.subs + b) * f.files + c;
					await window.DaimondCloud.writeText(d + '/file-' + pad(c) + '.' + exts[k % exts.length], body(k));
				}
			}
		};
		await Promise.all(Array.from({ length: 64 }, worker));
		return { files: total, ms: Math.round(performance.now() - t0), needles };
	}, { dir, f: fixture });
}

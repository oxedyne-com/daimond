// engineworker_fixture.mjs -- the folder the engine-worker starvation probe searches (U5, 2026-10-11).
//
// A real-folder grant of about forty thousand files, NONE of them in a directory the walk
// ignores (.git, node_modules, target), so the search has to open every one: what keeps the
// probe RED after the FIRE fixes that cut the walk of ignored trees. It is written into the
// page's own storage (OPFS) and handed to the app through `standInFolders` in `harness.mjs`,
// the stand-in for a folder picked on this computer.
//
// The tree is deterministic: `top-NN/sub-NN/file-NN.<ext>`, each file a few hundred bytes of
// source-like text. The needle `ENGWORK_NEEDLE` sits in one file in five hundred, so a search
// for it reads the whole tree and reports a few dozen hits. It is written after
// `standInFolders` has made (and emptied) the folder, so every run searches a fresh tree.
//
//   import { FIXTURE, seedFixture } from './engineworker_fixture.mjs';
//   const shape = await seedFixture(page, { tag: 'engwork', name: 'usr' });

export const FIXTURE = {
	tops:	40,				// top-level directories
	subs:	25,				// directories in each
	files:	40,				// files in each of those
	needle:	'ENGWORK_NEEDLE',
	every:	500,			// one file in this many carries the needle
};

export const fixtureCount = (f = FIXTURE) => f.tops * f.subs * f.files;

/// Write the tree into OPFS `<tag>-a/<name>`. Runs in the page; returns `{ files, ms, needles }`.
export async function seedFixture(page, { tag, name = 'usr', fixture = FIXTURE }) {
	return page.evaluate(async ({ tag, name, f }) => {
		const t0   = performance.now();
		const root = await navigator.storage.getDirectory();
		const top  = await (await root.getDirectoryHandle(tag + '-a', { create: true }))
			.getDirectoryHandle(name, { create: true });
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
		// Sixty-four writes in flight: OPFS writes are cheap, but forty thousand of them one at a
		// time take minutes.
		const jobs = [];
		for (let a = 0; a < f.tops; a++) {
			for (let b = 0; b < f.subs; b++) jobs.push([a, b]);
		}
		const pad = (n) => String(n).padStart(2, '0');
		let next = 0;
		const worker = async () => {
			while (next < jobs.length) {
				const [a, b] = jobs[next++];
				const d = await (await top.getDirectoryHandle('top-' + pad(a), { create: true }))
					.getDirectoryHandle('sub-' + pad(b), { create: true });
				for (let c = 0; c < f.files; c++) {
					const k = (a * f.subs + b) * f.files + c;
					const w = await (await d.getFileHandle('file-' + pad(c) + '.' + exts[k % exts.length],
						{ create: true })).createWritable();
					await w.write(body(k));
					await w.close();
				}
			}
		};
		await Promise.all(Array.from({ length: 64 }, worker));
		return { files: total, ms: Math.round(performance.now() - t0), needles };
	}, { tag, name, f: fixture });
}

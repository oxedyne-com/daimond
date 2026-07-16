// shots_matrix.mjs — capture every view across the cell matrix, for the vision
// review that no assertion can do: spacing rhythm, alignment, truncation, theme
// coherence, "does this read as one system". Writes PNGs to dev/shots/matrix/,
// named <view>.<device>.<engine>.<theme>.png, and prints an index to read back.
//
// Pair with verify_style.mjs: that catches the mechanical faults (overflow,
// contrast, tap size); these images catch the ones only an eye sees.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCell, defaultCells, VIEWS, cellLabel, enginesAvailable, resetView } from './matrix.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT  = path.join(HERE, 'shots', 'matrix');
fs.mkdirSync(OUT, { recursive: true });
// Start clean so a stale image never masquerades as this run's.
for (const f of fs.readdirSync(OUT)) { if (f.endsWith('.png')) fs.rmSync(path.join(OUT, f)); }

const avail = await enginesAvailable();
console.log('engines: ' + Object.entries(avail).map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`).join('  '));

// A tighter default than the audit: enough to see coherence across form factors
// and themes without hundreds of frames. Widen with DAIMOND_DEVICES / DAIMOND_THEMES.
if (!process.env.DAIMOND_DEVICES) process.env.DAIMOND_DEVICES = 'desktop,iphone,pixel';
if (!process.env.DAIMOND_THEMES)  process.env.DAIMOND_THEMES  = 'dark,light';

const cells = defaultCells().filter(c => avail[c.engine]);
const index = [];

for (const cell of cells) {
	const label = cellLabel(cell);
	// The locked screen needs no auth; everything else does. Do one signed-out
	// pass for `locked`, then a signed-in cell for the rest.
	for (const phase of ['locked', 'auth']) {
		const views = VIEWS.filter(v => (phase === 'locked' ? v.name === 'locked' : v.needsAuth));
		if (!views.length) continue;
		let s;
		try { s = await openCell(cell, { signIn: phase === 'auth', connect: phase === 'auth' }); }
		catch (e) { console.log(`  skip ${label} (${phase}) — ${e.message}`); continue; }
		try {
			for (const view of views) {
				await resetView(s.page);
				await view.setup(s.page).catch(() => {});
				const file = `${view.name}.${label}.png`;
				await s.page.screenshot({ path: path.join(OUT, file), fullPage: false, timeout: 8000 }).catch(() => {});
				index.push(file);
				console.log('  shot ' + file);
			}
		} finally {
			await s.close();
		}
	}
}

fs.writeFileSync(path.join(OUT, 'INDEX.txt'), index.sort().join('\n') + '\n');
console.log(`\n${index.length} frames in ${OUT}`);
console.log('Review them for: alignment & spacing rhythm, truncation/clipping, theme coherence (colours from the palette, both themes legible), trust-band/chip consistency, and whether every surface reads as one system.');

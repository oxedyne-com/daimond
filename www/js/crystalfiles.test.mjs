// crystalfiles.test.mjs -- the file list under a Diamond's crystal never buries the crystal
// (UNBLOCK-49, D-20261027-02: "the file list that grows underneath the crystal view can
// become so big as to completely obscure it, needs a better ui").
//
//	node --test www/js/crystalfiles.test.mjs
//
// Two halves. The LAYOUT half draws the AI panel's own markup, cut from index.html, under
// the app's real stylesheets in headless Chrome, at a desktop and a phone size, with the
// crystal footer holding 200 files and every fold in it open, and measures how much of the
// crystal is left on screen. The STATE half runs the fold's own functions, cut out of
// daimond.js by name: the list starts shut when it holds more than the bound and open when
// it fits, and a choice is remembered per Diamond.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW  = join(HERE, '..');
const SRC  = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const HTML = readFileSync(join(WWW, 'index.html'), 'utf8');

// ── The layout ─────────────────────────────────────────────────────────
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
	.find((p) => existsSync(p));

// The stylesheets index.html links, in its order, so the cascade is the app's.
const SHEETS = [...HTML.matchAll(/<link rel="stylesheet" href="(css\/[^"]+)"/g)].map((m) => m[1]);
const PANEL  = (() => {
	const at = HTML.indexOf('<section class="panel ai" id="panel-ai"');
	assert.ok(at >= 0, 'index.html has no AI panel');
	return HTML.slice(at, HTML.indexOf('</section>', at) + '</section>'.length);
})();

// The crystal footer as `renderCrystalControls` and `renderArtefacts` build it: the links
// row with the files strip in it, then the list, its head band, its tiles and the daimon's
// group, every one of them open.
function footer(n) {
	const row = (i) => `<div class="arte-row"><span class="arte-kind">file</span>`
		+ `<button class="arte-open">notes/file-${i}.md</button><button class="attach-state">Note</button>`
		+ `<button class="arte-drop">×</button></div>`;
	const rows = Array.from({ length: n }, (_, i) => row(i)).join('');
	return `<div class="crystal-status" id="crystal-status"></div>`
		+ `<div class="link-sec" id="link-sec"><button class="link-strip foot-toggle lead-disc" aria-expanded="false">Links (0)</button>`
		+ `<button class="arte-strip foot-toggle lead-disc" id="arte-strip" aria-expanded="true">Files (${n})</button></div>`
		+ `<div class="arte-list" id="arte-list"><div class="attach-head"><button class="attach-view-btn">≡</button></div>`
		+ `<div class="attach-body" role="group">${rows}</div>`
		+ `<div class="arte-daimon-group"><button class="arte-daimon-toggle lead-disc" aria-expanded="true">Added by the daimon (${n})</button>`
		+ `<div class="arte-daimon-body" role="group">${rows}</div></div></div>`;
}

function page(n) {
	const links = SHEETS.map((h) => `<link rel="stylesheet" href="${pathToFileURL(join(WWW, h))}">`).join('\n');
	const crystal = '<h1>Kitchen renovation</h1>' + '<p>New kitchen for the Leederville house.</p>'.repeat(30);
	return `<!doctype html><html lang="en" data-skin="obsidian"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${links}
<style>html, body { margin: 0; height: 100%; } body { display: flex; }
#panel-ai { flex: 1; display: flex; flex-direction: column; height: 100vh; }</style></head>
<body>${PANEL}
<script>
const p = document.getElementById('panel-ai');
p.classList.add('crystal-face');
const cv = document.getElementById('crystal-view');
cv.style.display = 'flex';
document.getElementById('crystal-body').innerHTML = ${JSON.stringify(crystal)};
document.getElementById('crystal-controls').innerHTML = ${JSON.stringify(footer(n))};
const b = document.getElementById('crystal-body').getBoundingClientRect();
const v = cv.getBoundingClientRect();
const list = document.getElementById('arte-list').getBoundingClientRect();
const shown = Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
const out = document.createElement('pre');
out.id = 'out';
out.textContent = JSON.stringify({ top: b.top, bottom: b.bottom, shown, view: v.height, list: list.height, vh: innerHeight });
document.body.appendChild(out);
</script></body></html>`;
}

function measure(w, h, n) {
	const dir = mkdtempSync(join(tmpdir(), 'crystalfiles-'));
	try {
		const f = join(dir, 'page.html');
		writeFileSync(f, page(n));
		const r = spawnSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
			`--user-data-dir=${join(dir, 'prof')}`, `--window-size=${w},${h}`, '--virtual-time-budget=3000',
			'--dump-dom', pathToFileURL(f).href], { encoding: 'utf8', timeout: 60000 });
		const m = /<pre id="out">([^<]*)<\/pre>/.exec(r.stdout || '');
		assert.ok(m, `no measurement from Chrome at ${w}x${h}: ${(r.stderr || '').slice(-400)}`);
		return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

for (const [label, w, h] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
	test(`200 files leave the crystal on screen (${label} ${w}x${h})`, { skip: !CHROME && 'no Chrome on this machine' }, () => {
		const m = measure(w, h, 200);
		// The crystal's box is in the viewport and keeps at least half of its view: the files
		// are a footer to the crystal, never the page.
		assert.ok(m.top < m.vh && m.bottom > 0, `crystal off screen: ${JSON.stringify(m)}`);
		assert.ok(m.shown >= m.view / 2, `crystal holds ${Math.round(m.shown)} of ${Math.round(m.view)} px: ${JSON.stringify(m)}`);
	});
}

// ── The fold's state ───────────────────────────────────────────────────
function cut(name) {
	const at = SRC.indexOf('function ' + name + '(');
	assert.ok(at >= 0, `daimond.js has no ${name}`);
	let depth = 0;
	for (let i = SRC.indexOf('{', at); i < SRC.length; i++) {
		if (SRC[i] === '{') depth++;
		else if (SRC[i] === '}' && --depth === 0) return SRC.slice(at, i + 1);
	}
	assert.fail(`${name} never closes`);
}
const KEY = /var CRYSTAL_FILES_KEY\s*=\s*('[^']+');/.exec(SRC);

function fold(store) {
	assert.ok(KEY, 'daimond.js names no CRYSTAL_FILES_KEY');
	const ls = {
		getItem: (k) => (k in store ? store[k] : null),
		setItem: (k, v) => { store[k] = String(v); },
	};
	return new Function('localStorage', `var CRYSTAL_FILES_KEY = ${KEY[1]};\nvar crystalFilesNow = {};\n`
		+ `${cut('crystalFilesOpen')}\n${cut('setCrystalFilesOpen')}\n`
		+ 'return { open: crystalFilesOpen, set: setCrystalFilesOpen };')(ls);
}

test('unchosen, the list is open while it fits and shut past the bound', () => {
	const f = fold({});
	assert.equal(f.open('d1', 0, 5), true);
	assert.equal(f.open('d1', 5, 5), true);
	assert.equal(f.open('d1', 6, 5), false);
	assert.equal(f.open('d1', 200, 5), false);
	// A bound the stylesheet did not give is no licence to bury the crystal.
	assert.equal(f.open('d1', 1, NaN), false);
});

test('a choice is remembered per Diamond, on this device', () => {
	const store = {};
	const f = fold(store);
	f.set('d1', true);
	assert.equal(f.open('d1', 200, 5), true, 'opened by hand stays open');
	assert.equal(f.open('d2', 200, 5), false, 'another Diamond keeps its own default');
	f.set('d2', false);
	assert.equal(f.open('d2', 1, 5), false, 'shut by hand stays shut');
	// A reload: a fresh fold over the same storage reads the same answers back.
	const g = fold(store);
	assert.equal(g.open('d1', 200, 5), true);
	assert.equal(g.open('d2', 1, 5), false);
	assert.equal(g.open('d3', 2, 5), true);
});

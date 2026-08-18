// verify_qrscan.mjs — the QR reader is held to the QR writer, at every version.
//
// THE WRITER IS THE ORACLE. `fe2o3_graphics::qr` is a from-scratch ISO 18004
// encoder in Rust; `www/js/qrscan.js` is the reading half in JavaScript, for the
// browsers with no `BarcodeDetector`. Two implementations of one format is
// exactly the arrangement that drifts, so the reader is never asked to agree
// with itself: it is asked to read what the Rust wrote, at every version the
// Rust will produce, with no picture in between and then with one.
//
// The version range is the point. The codec this reader is ported from
// (oxegen/www/public/js/qr.js) stops at version 10, and a signed identity card
// is 336 bytes, whose `#c=` URL needs version 17. A reader capped at 10 could
// never once have read the thing Daimond shows it.
//
//   1. Matrix in, matrix out: every version the encoder reaches round-trips.
//   2. A rendered picture — 6px modules, 4-module quiet zone, the pairing
//      canvas's own geometry — decodes to the same text.
//   3. A REAL signed card URL goes through the whole path and parses back to
//      the same key.
//
// Needs the dev server only (DAIMOND_PORT). No gateway.
import { open, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'qrscan', signIn: true, connect: false });
const { page } = s;
await page.waitForFunction(() => !!window.DaimondQR && !!window.DaimondCrypto, null, { timeout: 20000 });

// trust.js landed in index.html at 5c14eea, and qrscan.js is loaded on demand by
// trust.js rather than tagged. The check below is the reachability gate and is
// meant to be read: it is now a regression guard rather than a pending item.
const tagged = await page.evaluate(async () => {
	const html = await (await fetch('/index.html')).text();
	// A SCRIPT TAG, not the string. index.html carries a comment naming
	// js/trust.js, and matching that reported the tag present for a build that
	// never loaded the file — a verifier passing for the wrong reason.
	const tag = n => new RegExp('<script[^>]+src=["\']js/' + n + '\\.js["\']').test(html);
	return { trust: tag('trust'), scan: tag('qrscan') };
});
check('index.html loads js/trust.js', tagged.trust,
	tagged.trust ? '' : 'GONE — the People button and the #c= handler cannot run without it');
console.log('  note  js/qrscan.js is loaded on demand by trust.js, so it wants no tag of its own'
	+ (tagged.scan ? ' (one is present)' : ''));

await page.addScriptTag({ url: 'js/trust.js' });
await page.evaluate(() => window.DaimondTrust.scanner());
await page.waitForFunction(() => !!window.DaimondQRScan, null, { timeout: 10000 });

try {
	// ── 1. Matrix in, matrix out, at every version the encoder reaches. ───────
	const walk = await page.evaluate(() => {
		const seen = {};
		const fails = [];
		// Lengths chosen to walk the whole version range: the encoder picks the
		// smallest version that fits at Medium, so growing the payload steps it up.
		for (let len = 8; len <= 2200; len += 7) {
			let text = '';
			for (let i = 0; i < len; i++) text += String.fromCharCode(48 + (i % 74));
			const grid = window.DaimondQR.matrix(text);
			if (!grid || !grid.length) continue;
			const side = Math.round(Math.sqrt(grid.length));
			const version = (side - 17) / 4;
			if (seen[version]) continue;
			const got = window.DaimondQRScan.fromMatrix(grid, side);
			seen[version] = got && got.text === text ? 'ok' : 'FAIL';
			if (seen[version] !== 'ok') {
				fails.push({ version, side, len, got: got ? got.text.length : null });
			}
		}
		const versions = Object.keys(seen).map(Number).sort((a, b) => a - b);
		const read = versions.filter(v => seen[v] === 'ok');
		return { versions, read, fails, highest: read[read.length - 1] };
	});
	check('every version the encoder produced was read back exactly',
		walk.fails.length === 0,
		`${walk.versions.length} versions, ${walk.versions[0]}–${walk.highest}`
		+ (walk.fails.length ? `; failed at ${walk.fails.map(f => 'v' + f.version).join(', ')}` : ''));
	// The version an identity card needs. Named on its own, because this is the
	// one the ported ceiling of 10 would have missed — and it asks whether v17
	// was READ, not merely whether the encoder reached it. The weaker form of
	// this check passed on a build that could not read a single symbol above v10.
	check('version 17 was read back (a signed card needs it)', walk.read.indexOf(17) >= 0,
		`read ${walk.read.length} of ${walk.versions.length} versions`);
	check('the versions read reach past 30', walk.highest >= 30, `highest read v${walk.highest}`);

	// ── 2. A rendered picture, at the geometry the app actually draws. ────────
	const pic = await page.evaluate(() => {
		const out = [];
		const texts = [
			'DMND-ID1.short',
			'https://daimond.oxedyne.com/#c=' + 'A'.repeat(300),
			'https://daimond.oxedyne.com/#c=' + 'B'.repeat(700),
		];
		for (const text of texts) {
			const grid = window.DaimondQR.matrix(text);
			const n = Math.round(Math.sqrt(grid.length));
			const quiet = 4, scale = 6, dim = (n + quiet * 2) * scale;
			const c = document.createElement('canvas');
			c.width = dim; c.height = dim;
			const ctx = c.getContext('2d', { willReadFrequently: true });
			ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, dim, dim);
			ctx.fillStyle = '#000000';
			for (let y = 0; y < n; y++) {
				for (let x = 0; x < n; x++) {
					if (grid[y * n + x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
				}
			}
			const frame = ctx.getImageData(0, 0, dim, dim);
			const got = window.DaimondQRScan.decode(frame);
			out.push({ version: (n - 17) / 4, px: dim, read: !!got && got.text === text });
		}
		return out;
	});
	for (const p of pic) {
		check(`a drawn symbol at v${p.version} decoded from its pixels`, p.read, `${p.px}px canvas`);
	}

	// ── 3. The real thing: a signed card, all the way round. ──────────────────
	const real = await page.evaluate(async () => {
		await window.DaimondIdentity.ensureSealingKey();
		await window.DaimondIdentity.mintCard();
		const url = window.DaimondTrust.cardUrl();
		const grid = window.DaimondQR.matrix(url);
		if (!grid || !grid.length) return { encoded: false };
		const n = Math.round(Math.sqrt(grid.length));
		const quiet = 4, scale = 6, dim = (n + quiet * 2) * scale;
		const c = document.createElement('canvas');
		c.width = dim; c.height = dim;
		const ctx = c.getContext('2d', { willReadFrequently: true });
		ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, dim, dim);
		ctx.fillStyle = '#000000';
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < n; x++) {
				if (grid[y * n + x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
			}
		}
		const got = window.DaimondQRScan.decode(ctx.getImageData(0, 0, dim, dim));
		const card = got ? window.DaimondTrust.parse(got.text) : null;
		const mine = window.DaimondIdentity.publicKeyB64url();
		const mineHex = Array.from(atob(mine.replace(/-/g, '+').replace(/_/g, '/')))
			.map(ch => (ch.charCodeAt(0) + 256).toString(16).slice(1)).join('');
		return {
			encoded: true, version: (n - 17) / 4, urlLen: url.length,
			read: !!got, sameText: !!got && got.text === url,
			parsed: !!card, sameKey: !!card && card.key === mineHex,
			label: card ? card.label : '',
		};
	});
	check('a signed identity card fits a QR at all', real.encoded, `v${real.version}, ${real.urlLen} chars`);
	check('the card symbol decoded from its own pixels', real.sameText);
	// The check with teeth: not "something came back" but "the bytes verified as
	// a card and named the same 32-byte key". A reader that returned a truncated
	// string would pass a length check and fail this one.
	check('what came back verified as a card naming the same key', real.sameKey,
		real.parsed ? `label "${real.label}"` : 'did not parse');

	await shot(s, 'qrscan');
} finally {
	const errs = errors(s);
	if (errs.length) console.log('  console errors:', errs.slice(0, 5));
	await s.close();
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAIL ' + b)); process.exit(1); }

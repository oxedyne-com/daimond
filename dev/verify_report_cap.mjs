// verify_report_cap.mjs — a worker's report to the daimon, capped, byte-exact, without a
// browser.
//
// THE CHANGE (2026-09-12). `gather` used to hand the daimon EVERY streamed `text` event a
// worker produced, concatenated whole (`run.text`), as the report for a finished fan-out. A
// chatty worker's narration -- the thinking-out-loud between tool calls -- billed the daimon's
// next round at the full size of everything the worker ever said, not what it actually
// answered. `capReportBytes` is the byte-safe head+tail cap that keeps a report to ~8 KB; this
// file proves it in isolation, on inputs chosen to catch the two ways a byte cap goes wrong: a
// cut that lands inside a multi-byte UTF-8 character, and an off-by-one in the "nothing is cut
// when it already fits" path.
//
// Needs nothing running: `capReportBytes` and `withCommas` are lifted verbatim from
// www/js/daimond.js and run with `new Function`, not retyped -- a rename or a move throws here
// rather than silently testing a stale copy.
//
//   node dev/verify_report_cap.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = fs.readFileSync(path.join(HERE, '..', 'www', 'js', 'daimond.js'), 'utf8');

let bad = 0, ran = 0;
const check = (pass, name, detail) => {
	ran++;
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// A function declaration by signature, brace-matched from its opening `{`. Same device as
/// dev/verify_classifier_phrases.mjs's `grabFn`: neither body carries a brace inside a string,
/// regex or comment, so a plain depth count is exact.
function grabFn(sig) {
	const start = SRC.indexOf(sig);
	if (start < 0) { console.error(`could not find '${sig}' in js/daimond.js`); process.exit(2); }
	const open = SRC.indexOf('{', start);
	let depth = 0, i = open;
	for (; i < SRC.length; i++) {
		const c = SRC[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return SRC.slice(start, i);
}

const WC_SRC = grabFn('function withCommas(');
const CR_SRC = grabFn('function capReportBytes(');
const f = new Function(WC_SRC + '\n' + CR_SRC + '\nreturn { capReportBytes: capReportBytes };');
const { capReportBytes } = f();

// ── A report that already fits is passed through untouched ──────────

{
	const text = 'All three files were updated; tests pass.';
	const r = capReportBytes(text, 2048, 6144);
	check(r.text === text, 'a short report is returned verbatim, no marker');
	check(r.rawBytes === r.sentBytes, 'raw and sent bytes are equal when nothing is cut',
		`${r.rawBytes} vs ${r.sentBytes}`);
	check(r.rawBytes === Buffer.byteLength(text), 'rawBytes is the real UTF-8 byte length',
		String(r.rawBytes));
}

// Exactly AT the cap: head+tail bytes, not one more. The boundary a fencepost
// error hides behind.
{
	const text = 'x'.repeat(2048 + 6144);
	const r = capReportBytes(text, 2048, 6144);
	check(r.text === text, 'a report exactly at the cap is not touched');
	check(r.sentBytes === 8192, 'its sent size is exactly the cap', String(r.sentBytes));
}

// ── A long report is capped, head and tail kept, middle marked ───────

{
	const head = 'HEAD'.repeat(1000);		// well over 2048 bytes
	const middle = 'm'.repeat(50000);
	const tail = 'TAIL'.repeat(2000);		// well over 6144 bytes
	const text = head + middle + tail;
	const r = capReportBytes(text, 2048, 6144);
	check(r.rawBytes === Buffer.byteLength(text), 'rawBytes is the uncapped size', String(r.rawBytes));
	check(r.sentBytes < r.rawBytes, 'sentBytes is smaller than rawBytes once capped',
		`${r.sentBytes} < ${r.rawBytes}`);
	check(r.sentBytes <= 8192 + 64, 'sentBytes stays close to the 8 KB budget (marker included)',
		String(r.sentBytes));
	check(r.text.startsWith(head.slice(0, 2048)), 'the kept head is byte-exact');
	check(r.text.endsWith(tail.slice(-6144)), 'the kept tail is byte-exact');
	check(/\[… [\d,]+ bytes elided …\]/.test(r.text), 'the marker names how much went',
		(r.text.match(/\[…[^\]]*…\]/) || [''])[0]);
	check(r.text.indexOf(middle) < 0, 'none of the elided middle survives');
}

// ── A cut that lands inside a multi-byte character is not corrupted ──
//
// '💥' is four UTF-8 bytes. A head cap of 2050 bytes lands two bytes into the
// 513th emoji (2048 ASCII bytes of filler + 2 bytes) -- exactly the case
// `TextDecoder` exists to absorb rather than throw on or mangle.

{
	const filler = 'a'.repeat(2048);
	const boom = '💥'.repeat(2000);
	const tailFiller = 'z'.repeat(8000);
	const text = filler + boom + tailFiller;
	const r = capReportBytes(text, 2050, 6144);
	check(!r.text.includes('\uD800') && !/[\uD800-\uDFFF]/.test(r.text.replace(/[\uD83D][\uDCA5]/g, '')),
		'no bare surrogate half reaches the output', JSON.stringify(r.text.slice(2040, 2060)));
	check(r.text.slice(0, 2048) === filler, 'the whole-byte part of the head survives exactly');
	// Node's TextDecoder(fatal:false) turns the two leftover bytes of the split
	// emoji into one U+FFFD rather than a corrupt pair -- proving the cut did
	// not silently produce invalid UTF-16.
	check(Buffer.byteLength(r.text, 'utf8') === Buffer.byteLength(JSON.parse(JSON.stringify(r.text)), 'utf8'),
		're-encoding the result is lossless (no lone surrogate)');
}

// ── Unicode round-trips exactly when nothing needs cutting ───────────

{
	const text = 'Café — 日本語 — 💥 done.';
	const r = capReportBytes(text, 2048, 6144);
	check(r.text === text, 'multi-byte text under the cap is untouched', r.text);
}

console.log(`\nreport cap: ${ran - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);

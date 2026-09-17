#!/usr/bin/env node
// forge #16 -- worker reports: the fallback when a run ends on a tool result is
// the LAST SPOKEN SEGMENT, never the whole narration. Pure-Node: lifts the
// report-assembly expression out of www/js/daimond.js and runs it against a
// miniature of a worker run that ends mid-tools after three long segments.
//
// BREAK-FIRST: `--break wholetext` serves the pre-fix expression (the whole of
// run.text as the fallback) -- the defect as it shipped -- and must redden.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'www', 'js', 'daimond.js');
const BREAK = process.argv.includes('--break')
	? process.argv[process.argv.indexOf('--break') + 1] : null;
if (BREAK && BREAK !== 'wholetext') {
	console.error(`unknown break '${BREAK}' -- this verifier declares wholetext`);
	process.exit(2);
}

let src = readFileSync(SRC, 'utf8');

// LIFT the three live lines out of the page (they are one statement in situ).
const LIFT_ANCHOR = "\t\t\t\tvar _tailText = (run._tail || '').trim();";
const SRC_ANCHOR_END = "\t\t\t\tvar _capped = capReportBytes(_src.trim(), _clip.head, _clip.tail);";
const i = src.indexOf(LIFT_ANCHOR);
if (i < 0) throw new Error('report assembly drifted: tailText anchor not found');
const j = src.indexOf(SRC_ANCHOR_END, i);
if (j < 0) throw new Error('report assembly drifted: capped anchor not found');

let LIFTED = src.slice(i, j + SRC_ANCHOR_END.length);
if (BREAK === 'wholetext') {
	// the defect as it shipped: whole-text fallback
	LIFTED = LIFTED.replace(
		/: \(run\._segs && run\._segs\.length \? run\._segs\[run\._segs\.length - 1\] : \(run\.text \|\| ''\)\);/,
		": (run.text || '');");
}

// a miniature of the byte-cap (the real one is TextEncoder-based; the shape is
// what is under test, not the byte math)
function capReportBytes(text, head, tail) {
	if (text.length <= head + tail) return { text };
	return text.slice(0, head) + '\n\n[… elided …]\n\n' + text.slice(text.length - tail);
}
const reportClip = () => ({ head: 2000, tail: 2000 });

// the run: three long spoken segments, each followed by a tool call, the last
// tool call ending the run (the cap lands on a tool result).
function seg(n) {
	let s = 'SEGMENT ' + n + ': ';
	for (let k = 0; k < 200; k++) s += 'word' + n + ' ';
	return s.trim();
}
const run = {
	text: seg(1) + '\n\n' + seg(2) + '\n\n' + seg(3),
	_tail: '',
	_segs: [seg(1), seg(2), seg(3)],
};

const fn = new Function('run', 'capReportBytes', 'reportClip',
	LIFTED + '\nrun.report = _capped.text;\nreturn run.report;');
const report = fn(run, capReportBytes, reportClip);

let fails = 0, ran = 0;
function check(name, cond, detail) {
	ran++;
	if (!cond) fails++;
	console.log((cond ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
}

check('report is the last spoken segment, not the whole narration',
	report.startsWith('SEGMENT 3:'), 'report head: ' + report.slice(0, 40));
check('report carries segment 3 only (no segment 1 prose)',
	!report.includes('SEGMENT 1:'), 'report length ' + report.length);
check('report is bounded (no segment 2 prose either)',
	!report.includes('SEGMENT 2:'), 'report length ' + report.length);

// the tail case is unchanged: a run that SPOKE last keeps its tail as before.
const run2 = { text: seg(1) + '\n\n' + seg(2), _tail: seg(2), _segs: [seg(1), seg(2)] };
const report2 = fn(run2, capReportBytes, reportClip);
check('a run that spoke last still reports its spoken tail',
	report2.startsWith('SEGMENT 2:'), 'report2 head: ' + report2.slice(0, 40));

// a run that never finished a tool call still falls back to run.text.
const run3 = { text: seg(1), _tail: null, _segs: [] };
const report3 = fn(run3, capReportBytes, reportClip);
check('a run with no completed tool call falls back to run.text',
	report3.startsWith('SEGMENT 1:'), 'report3 head: ' + report3.slice(0, 40));

console.log(`${ran - fails}/${ran} checks passed${fails ? ` — ${fails} FAILED` : ''}`);
if (BREAK === 'wholetext' && fails === 0) {
	console.error('BREAK wholetext PROVED NOTHING -- the defect still passed');
	process.exit(1);
}
process.exit(fails ? 1 : 0);

// models_seam.test.mjs — the two seams cut into the Models panel (FIRE D-20261018-09 S0).
//
// `renderProviders(box)` draws the provider rows and `routingFor(providerId, model, box)` draws
// the per-model routing field and its note. Three later units each own one block, so each block
// must have exactly one writer: a second place that builds a provider row or a routing field is
// a second copy one unit would change and another would not. This reads models.js as text and
// asserts each function exists once, is called where `render()` drew the block, and holds the
// only code that builds the block's elements.
//
//   node www/js/models_seam.test.mjs                     # clean
//   node www/js/models_seam.test.mjs --break secondfield # a routing field built outside routingFor
//   node www/js/models_seam.test.mjs --break inlinerows  # render() drawing the rows itself again
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const bi    = process.argv.indexOf('--break');
const BREAK = bi > 0 ? process.argv[bi + 1] : '';

let src = fs.readFileSync(path.join(HERE, 'models.js'), 'utf8');
const BREAKS = {
	secondfield: (s) => s.replace("\tfunction keyBlock(p) {\n",
		"\tfunction keyBlock(p) {\n\t\tvar stray = document.createElement('input'); stray.className = 'models-route-row';\n"),
	inlinerows: (s) => s.replace("\t\trenderProviders(el);\n",
		"\t\tproviders().forEach(function (p) { var row = document.createElement('div'); row.className = 'models-prov'; el.appendChild(row); });\n"),
};
if (BREAK) {
	if (!BREAKS[BREAK]) { console.error(`ABORT: no break called "${BREAK}"`); process.exit(2); }
	const out = BREAKS[BREAK](src);
	if (out === src) { console.error(`ABORT: the "${BREAK}" break no longer matches`); process.exit(2); }
	src = out;
	console.log(`BREAK ${BREAK}\n`);
}

/// The body of the top-level `function <name>(` in the module, by brace matching.
function body(name) {
	const at = src.indexOf('\tfunction ' + name + '(');
	if (at < 0) return null;
	const open = src.indexOf('{', at);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}' && --depth === 0) return { start: at, end: i + 1, text: src.slice(at, i + 1) };
	}
	return null;
}

/// Every index at which `needle` occurs.
function where(needle) {
	const out = [];
	for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) out.push(i);
	return out;
}

const inside = (i, b) => b && i >= b.start && i < b.end;
const bad    = [];
const check  = (name, pass, detail) => {
	console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
	if (!pass) bad.push(name);
};

const rp = body('renderProviders');
const rf = body('routingFor');
const rd = body('render');

check('renderProviders(box) exists once',
	!!rp && where('\tfunction renderProviders(').length === 1 && /function renderProviders\(box\)/.test(rp.text));
check('routingFor(providerId, model, box) exists once',
	!!rf && where('\tfunction routingFor(').length === 1
		&& /function routingFor\(providerId, model, box\)/.test(rf.text));
check('the old routingRow is gone', where('routingRow').length === 0,
	`${where('routingRow').length} mention(s)`);

check('render() calls renderProviders once, into the list',
	!!rd && (rd.text.match(/renderProviders\(/g) || []).length === 1 && rd.text.includes('renderProviders(el);'));

// The only writers. A provider row is the element whose class starts `models-prov` and is not
// one of its children (`-head`, `-name`, ...): the literal `'models-prov' +` or `'models-prov'`.
const rowWrites = where("className = 'models-prov'");
check('a provider row is built only inside renderProviders',
	rowWrites.length === 1 && rowWrites.every((i) => inside(i, rp)), `${rowWrites.length} writer(s)`);
const heads = where("className = 'models-prov-head'");
check('a provider head is built only inside renderProviders',
	heads.length === 1 && heads.every((i) => inside(i, rp)), `${heads.length} writer(s)`);

// Since U5b the block is rows of hosts, so the bits are the rows' own.
const fieldBits = ["'models-routing'", "'models-route-row'", "'models-route-btn'",
	"'models-route-head'", "'models.route_head'", "'models.route_none'", "'models.route_prefer'"];
for (const bit of fieldBits) {
	const at = where(bit);
	check(`${bit} appears only inside routingFor`,
		at.length >= 1 && at.every((i) => inside(i, rf)), `${at.length} mention(s)`);
}
check('routingFor appends to the box it is given', !!rf && rf.text.includes('box.appendChild(disc);'));
check('setRouting is wired only from routingFor',
	where('setRouting(providerId, model, RR.').concat(where("setRouting(providerId, model, '')"))
		.every((i) => inside(i, rf)) && where('setRouting(providerId, model, RR.').length === 1);

// Today's two callers are both inside the provider rows; U3b adds the model detail later. The
// model row's names the offer's own payer (U5a: a twin's "Through X" line routes on X's key).
const calls = where('routingFor(p.id').concat(where('routingFor(o.provider'));
check('routingFor is called from the model row and the disclosure, both in renderProviders',
	calls.length === 2 && calls.every((i) => inside(i, rp)), `${calls.length} call(s)`);

if (BREAK) {
	if (bad.length) { console.log('\nthe break was caught, as it should be'); process.exit(0); }
	console.log('\nthe break was NOT caught'); process.exit(1);
}
console.log(bad.length ? `\n${bad.length} FAILED` : '\nall seam checks pass');
process.exit(bad.length ? 1 : 0);

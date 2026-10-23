// Who asked: a daimon or one of its workers, told by the app's own words (src/prompts.rs).
//
// A brief worker gets DEFAULT_WORKER as its system prompt. Since r578c a fork worker keeps the
// daimon's system prompt and tools (spawn_agent included) and is told its role by
// DEFAULT_WORKER_HANDOFF, opening a paragraph of its last user message. Neither marker is copied
// here: both are read from the app tree (dev/rig/appconst.mjs `appStr`), as the rig's law MDL
// reads them (rigfix7), so a check moves with the prompts instead of silently finding no workers.

import { appStr } from './rig/appconst.mjs';

/// The opening sentence of an app prompt, without its full stop; null when the app has none.
export const openingOf = (text) => (text == null ? null : String(text).split(/\.(?:\s|$)/)[0]);

const textOf = (c) => (typeof c === 'string' ? c
	: Array.isArray(c) ? c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('')
	: JSON.stringify(c || ''));

/// `{ brief, fork }` regexes: `brief` matches a worker's system prompt, `fork` a paragraph start of
/// its last user message (anchored, since the daimon's gather turn quotes the worker's reply, and so
/// the hand-off, mid-line). `fork` is null for an app before r578c.
export function workerMarks(read = appStr) {
	const brief = openingOf(read('DEFAULT_WORKER')), fork = openingOf(read('DEFAULT_WORKER_HANDOFF'));
	if (!brief) throw new Error('workermarks: the app tree has no DEFAULT_WORKER in src/prompts.rs');
	const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return { brief: new RegExp(esc(brief)), fork: fork ? new RegExp(`(?:^|\n\n)${esc(fork)}`) : null };
}
let marks = null;
const marksNow = () => (marks = marks || workerMarks());

const systemOf = (req) => ((req && req.messages) || []).filter((m) => m && m.role === 'system')
	.map((m) => textOf(m.content)).join('\n');

/// The last user message as sent, turn note and all: the hand-off follows the standing context.
const lastUserRaw = (req) => {
	const ms = (req && req.messages) || [];
	for (let i = ms.length - 1; i >= 0; i--) if (ms[i] && ms[i].role === 'user') return textOf(ms[i].content);
	return '';
};

/// `daimon` or `workers`: who sent this chat-completions request.
export function roleOf(req, m = marksNow()) {
	if (m.brief.test(systemOf(req))) return 'workers';
	return m.fork && m.fork.test(lastUserRaw(req)) ? 'workers' : 'daimon';
}
export const isWorker = (req, m) => roleOf(req, m) === 'workers';

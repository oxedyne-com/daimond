// The t27 release's page (the build a rollback went to on 08 Nov), for the arms that
// prove an older build cannot misread a store a newer one laid out.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const T27 = 'ca92aa49d';	// fixed: release/t27's record commit

/// A tree holding t27's www/js and dev, extracted once. PAGESTORE_REPO names the
/// repository when the arm runs from a copy outside it.
export function t27Tree() {
	const repo = process.env.PAGESTORE_REPO || join(dirname(fileURLToPath(import.meta.url)), "../../..");
	const dir = join(process.env.XDG_CACHE_HOME || join(process.env.HOME, '.cache'), 'pagestore_t27', T27);
	if (!existsSync(join(dir, 'www/js/durable.js'))) {
		mkdirSync(dir, { recursive: true });
		const tar = execFileSync('git', ['-C', repo, 'archive', T27, 'www/js', 'www/i18n', 'dev'], { maxBuffer: 1 << 30 });
		execFileSync('tar', ['-x', '-C', dir], { input: tar });
	}
	return dir;
}

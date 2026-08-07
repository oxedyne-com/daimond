import { open, chat } from './harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// This checkout's own shots directory; an absolute path here is one
// developer's layout, and dev/ is carved into a public mirror.
const S = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
const s = await open({ name: 'skinshot' });
const { page } = s;
// Give it a chat so the surface isn't just the empty state.
await chat(s, 'Hello — can you help me plan a small project?');
await page.waitForTimeout(500);

async function grab(skin, theme, label) {
  await page.evaluate(({ skin, theme }) => {
    window.DaimondSkin.set(skin);
    if (theme) window.DaimondTheme.set(theme);
  }, { skin, theme });
  await page.waitForTimeout(700);   // let the webfont + repaint settle
  await page.screenshot({ path: `${S}/skin_${label}.png`, fullPage: false });
  console.log('shot', label);
}
await grab('sharp', 'dark',  'sharp_dark');
await grab('warm',  'light', 'warm_light');
await grab('warm',  'dark',  'warm_dark');
await grab('sharp', 'light', 'sharp_light');
// Mobile width
await page.setViewportSize({ width: 390, height: 780 });
await page.waitForTimeout(400);
await grab('warm', 'light', 'warm_light_mobile');
await grab('sharp', 'dark', 'sharp_dark_mobile');
await s.close();

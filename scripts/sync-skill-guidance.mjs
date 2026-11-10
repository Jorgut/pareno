import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('skills/pareno-writing/SKILL.md', root), 'utf8');
const section = heading => {
  const marker = `\n## ${heading}\n`;
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`Missing skill section: ${heading}`);
  const start = at + marker.length;
  const end = source.indexOf('\n## ', start);
  return source.slice(start, end < 0 ? undefined : end).trim();
};
const generated = `// Generated from skills/pareno-writing/SKILL.md. Run npm run sync:skill after editing the skill.\n` +
  `export const adaptationGuidance = ${JSON.stringify(section('Chinese-to-English adaptation'))};\n` +
  `export const editingGuidance = ${JSON.stringify(section('Editing and English learning'))};\n`;
const target = new URL('src/skill-guidance.ts', root);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== generated) throw new Error('Skill guidance is out of sync. Run npm run sync:skill.');
} else {
  await writeFile(target, generated);
}

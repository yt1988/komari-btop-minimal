import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const manifest = JSON.parse(readFileSync(new URL('../komari-theme.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('release contract', () => {
  it('keeps package metadata and the Komari manifest aligned', () => {
    expect(manifest.version).toBe(packageJson.version);
    for (const field of ['name', 'short', 'description', 'version', 'author', 'url', 'preview']) {
      expect(manifest[field]).toEqual(expect.any(String));
      expect((manifest[field] as string).trim()).not.toBe('');
    }
  });

  it('links safely to the canonical theme repository from the footer', () => {
    expect(indexHtml).toContain(`href="${manifest.url}"`);
    expect(indexHtml).toContain('target="_blank"');
    expect(indexHtml).toContain('rel="noopener noreferrer"');
    expect(indexHtml).toContain('Theme By Btop Minimal');
    expect(indexHtml).toContain('opens in a new tab');
  });

  it('declares reproducible validation and project metadata', () => {
    expect(packageJson.license).toBe('MIT');
    expect(packageJson.engines).toMatchObject({ node: '>=22.12.0 <25', npm: '>=10 <12' });
    expect(packageJson.packageManager).toBe('npm@11.17.0');
    expect(packageJson.repository).toMatchObject({ type: 'git' });
    expect(packageJson.scripts).toMatchObject({
      check: expect.any(String),
      package: expect.any(String),
      'prepare:flags': expect.any(String),
    });
  });
});

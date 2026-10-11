import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('narrow viewport layout', () => {
  it('reflows node rows and detail metrics instead of retaining the desktop table width', () => {
    const mobileStyles = styles.slice(styles.indexOf('@media (max-width: 1240px)'));

    expect(styles).toMatch(/\.table-scroll,\s*\.metric-table\s*\{[\s\S]*?overflow-x:\s*clip;/);
    expect(styles).not.toContain('overflow-x: auto');
    expect(styles).toContain('@media (max-width: 1240px)');
    expect(mobileStyles).toMatch(/\.head\s*\{\s*display:\s*none;/);
    expect(mobileStyles).toMatch(/\.row\s*\{[\s\S]*?grid-template-areas:[\s\S]*?min-width:\s*0;/);
    expect(mobileStyles).toMatch(/\.metric-head\s*\{\s*display:\s*none;/);
    expect(mobileStyles).toMatch(/\.metric-row\s*\{[\s\S]*?grid-template-areas:[\s\S]*?min-width:\s*0;/);
    expect(mobileStyles).toContain("'node node node node node node'");
    expect(mobileStyles).toContain("'cpu cpu mem mem disk disk'");
    expect(mobileStyles).toContain("'network network network traffic traffic traffic'");
    expect(mobileStyles).not.toContain('min-width: 1050px');
  });
});

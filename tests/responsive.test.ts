import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const trafficView = readFileSync(new URL('../src/views/traffic.ts', import.meta.url), 'utf8');
const detailView = readFileSync(new URL('../src/views/detail.ts', import.meta.url), 'utf8');
const mobileStyles = styles.slice(styles.indexOf('@media (max-width: 1240px)'));
const compactStyles = styles.slice(styles.indexOf('@media (max-width: 700px)'));

describe('narrow viewport layout', () => {
  it('reflows node rows and detail metrics instead of retaining the desktop table width', () => {
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

  it('keeps resource values next to their bars at narrow widths', () => {
    expect(mobileStyles).toMatch(/\.resource\s*\{[\s\S]*?grid-template-columns:\s*max-content\s+max-content;/);
    expect(mobileStyles).not.toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/);
  });

  it('reserves a stable traffic limit row and shares duplex columns with detail metrics', () => {
    expect(styles).toMatch(/\.traffic\s*\{[\s\S]*?grid-template-rows:\s*18px\s+15px;/);
    expect(styles).toMatch(/\.network\s*\{[^}]*grid-template-rows:\s*18px\s+15px;/);
    expect(styles).not.toMatch(/\.traffic\.has-no-limit\s*\{[\s\S]*?grid-template-rows:\s*1fr;/);
    expect(styles).toMatch(/\.traffic-limit\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
    expect(styles).toMatch(/\.limit-track\s*\{[\s\S]*?width:\s*100%;/);
    expect(styles).toMatch(/\.metric-network\s*,\s*\.metric-traffic\s+\.traffic-current\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
    expect(mobileStyles).toMatch(/'network network network traffic traffic traffic'/);
    expect(compactStyles).toMatch(/'network network network'\s*'traffic traffic traffic'/);
    expect(mobileStyles).toMatch(/\.network\s*\{[\s\S]*?grid-template-rows:\s*13px\s+18px\s+15px;/);
    expect(mobileStyles).toMatch(/\.network\s*\{[\s\S]*?row-gap:\s*3px;/);
    expect(trafficView).toContain('formatTraffic');
    expect(trafficView).toContain('traffic-current');
    expect(trafficView).toContain('traffic-limit');
    expect(detailView).toContain('renderTrafficCell');
  });
});

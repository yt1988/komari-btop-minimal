import { describe, expect, it } from 'vitest';
import { normalizeRegionCode, normalizeRegionFlag, regionFlagSvg } from '../src/region';

describe('node region flags', () => {
  it('maps Taiwan variants to the China flag', () => {
    expect(normalizeRegionFlag('🇹🇼')).toBe('🇨🇳');
    expect(normalizeRegionFlag('台湾')).toBe('🇨🇳');
    expect(normalizeRegionFlag('Taiwan')).toBe('🇨🇳');
    expect(normalizeRegionFlag('TW')).toBe('🇨🇳');
  });

  it('preserves native flags and converts ISO country codes', () => {
    expect(normalizeRegionFlag('🇩🇪')).toBe('🇩🇪');
    expect(normalizeRegionFlag('jp')).toBe('🇯🇵');
    expect(normalizeRegionFlag('')).toBe('');
  });

  it('provides a Windows-safe country code and inline flag graphic', () => {
    expect(normalizeRegionCode('🇹🇼')).toBe('CN');
    expect(normalizeRegionCode('jp')).toBe('JP');
    expect(regionFlagSvg('CN')).toContain('<svg');
    expect(regionFlagSvg('CN')).not.toContain('🇨🇳');
  });
});

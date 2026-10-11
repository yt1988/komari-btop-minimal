import { describe, expect, it } from 'vitest';
import {
  normalizeRegionCode,
  normalizeRegionFlag,
  regionFlagUrl,
} from '../src/region';

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

  it('provides a Windows-safe country code and local flag asset URL', () => {
    expect(normalizeRegionCode('🇹🇼')).toBe('CN');
    expect(normalizeRegionCode('jp')).toBe('JP');
    expect(regionFlagUrl('CN')).toBe('/flags/cn.svg');
    expect(regionFlagUrl('HK')).toBe('/flags/hk.svg');
    expect(regionFlagUrl('ZZ')).toBe('/flags/xx.svg');
    expect(regionFlagUrl('not-a-country')).toBe('/flags/xx.svg');
  });
});

const TAIWAN_NAMES = new Set(['台湾', '臺灣', 'taiwan', 'tw', 'twn', '🇹🇼']);

function isoToFlag(code: string): string {
  return [...code.toUpperCase()]
    .map((character) => String.fromCodePoint(0x1f1e6 + character.charCodeAt(0) - 65))
    .join('');
}

export function normalizeRegionFlag(region: string | null | undefined): string {
  const value = typeof region === 'string' ? region.trim() : '';
  if (!value) {
    return '';
  }
  const normalized = value.toLocaleLowerCase();
  if (TAIWAN_NAMES.has(normalized) || normalized.includes('taiwan') || value.includes('台湾') || value.includes('臺灣')) {
    return '🇨🇳';
  }
  const nativeFlag = value.match(/\p{Regional_Indicator}{2}/u)?.[0];
  if (nativeFlag) {
    return nativeFlag;
  }
  if (/^[a-z]{2}$/i.test(value)) {
    return isoToFlag(value);
  }
  return '';
}

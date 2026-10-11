import countryData from 'flag-icons/country.json';

const TAIWAN_NAMES = new Set(['台湾', '臺灣', 'taiwan', 'tw', 'twn', '🇹🇼']);
const FLAG_CODES = new Set(
  (countryData as Array<{ code: string }>).map(({ code }) => code.toLowerCase()),
);

const REGION_NAMES = new Map<string, string>([
  ['中国', 'CN'],
  ['china', 'CN'],
  ['香港', 'HK'],
  ['hong kong', 'HK'],
  ['日本', 'JP'],
  ['japan', 'JP'],
  ['德国', 'DE'],
  ['germany', 'DE'],
  ['美国', 'US'],
  ['united states', 'US'],
  ['usa', 'US'],
  ['英国', 'GB'],
  ['united kingdom', 'GB'],
  ['uk', 'GB'],
  ['荷兰', 'NL'],
  ['netherlands', 'NL'],
  ['新加坡', 'SG'],
  ['singapore', 'SG'],
  ['韩国', 'KR'],
  ['south korea', 'KR'],
  ['法国', 'FR'],
  ['france', 'FR'],
  ['加拿大', 'CA'],
  ['canada', 'CA'],
  ['澳大利亚', 'AU'],
  ['australia', 'AU'],
  ['印度', 'IN'],
  ['india', 'IN'],
  ['俄罗斯', 'RU'],
  ['russia', 'RU'],
  ['乌克兰', 'UA'],
  ['ukraine', 'UA'],
  ['巴西', 'BR'],
  ['brazil', 'BR'],
]);

function regionalIndicatorsToCode(flag: string): string {
  return [...flag]
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      return String.fromCharCode(point - 0x1f1e6 + 65);
    })
    .join('');
}

function isoToFlag(code: string): string {
  return [...code]
    .map((character) => String.fromCodePoint(0x1f1e6 + character.charCodeAt(0) - 65))
    .join('');
}

export function normalizeRegionCode(region: string | null | undefined): string {
  const value = typeof region === 'string' ? region.trim() : '';
  if (!value) {
    return '';
  }

  const normalized = value.toLocaleLowerCase();
  if (TAIWAN_NAMES.has(normalized) || normalized.includes('taiwan') || value.includes('台湾') || value.includes('臺灣')) {
    return 'CN';
  }

  const nativeFlag = value.match(/^\p{Regional_Indicator}{2}$/u)?.[0];
  if (nativeFlag) {
    const code = regionalIndicatorsToCode(nativeFlag);
    return code === 'TW' ? 'CN' : code;
  }

  if (/^[a-z]{2}$/i.test(value)) {
    const code = value.toUpperCase();
    return code === 'TW' ? 'CN' : code;
  }
  if (/^twn$/i.test(value)) {
    return 'CN';
  }
  return REGION_NAMES.get(normalized) ?? '';
}

export function normalizeRegionFlag(region: string | null | undefined): string {
  const code = normalizeRegionCode(region);
  return code ? isoToFlag(code) : '';
}

export function regionFlagUrl(code: string): string {
  const normalized = code.trim().toLowerCase();
  const assetCode = /^[a-z]{2}$/.test(normalized) && FLAG_CODES.has(normalized) ? normalized : 'xx';
  return `/flags/${assetCode}.svg`;
}

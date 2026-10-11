const TAIWAN_NAMES = new Set(['台湾', '臺灣', 'taiwan', 'tw', 'twn', '🇹🇼']);

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

const FLAG_DESIGNS: Record<string, string> = {
  AU: '<rect width="18" height="12" fill="#012169"/><path d="M0 0h8v6H0z" fill="#012169"/><path d="M0 0 8 6M8 0 0 6" stroke="#fff" stroke-width="1.5"/><path d="M0 0 8 6M8 0 0 6" stroke="#c8102e" stroke-width=".6"/><circle cx="13.5" cy="8.5" r="1" fill="#fff"/>',
  BR: '<rect width="18" height="12" fill="#009c3b"/><path d="m9 1.3 6.3 4.7L9 10.7 2.7 6z" fill="#ffdf00"/><circle cx="9" cy="6" r="2.2" fill="#002776"/>',
  CA: '<rect width="18" height="12" fill="#fff"/><path d="M0 0h4v12H0zM14 0h4v12h-4z" fill="#d52b1e"/><path d="m9 2 .7 2.5 1.8-.8-.9 1.8 1.8.8-2 .4.2 2.2L9 7.6 7.4 9l.2-2.2-2-.4 1.8-.8-.9-1.8 1.8.8z" fill="#d52b1e"/>',
  CN: '<rect width="18" height="12" fill="#de2910"/><path d="m3.2 1.2.45 1.25 1.35.05-1.05.8.35 1.3-1.1-.75-1.1.75.35-1.3-1.05-.8 1.35-.05z" fill="#ffde00"/>',
  DE: '<path d="M0 0h18v4H0z" fill="#000"/><path d="M0 4h18v4H0z" fill="#d00"/><path d="M0 8h18v4H0z" fill="#ffce00"/>',
  FR: '<path d="M0 0h6v12H0z" fill="#0055a4"/><path d="M6 0h6v12H6z" fill="#fff"/><path d="M12 0h6v12h-6z" fill="#ef4135"/>',
  GB: '<rect width="18" height="12" fill="#012169"/><path d="M0 0 18 12M18 0 0 12" stroke="#fff" stroke-width="3"/><path d="M0 0 18 12M18 0 0 12" stroke="#c8102e" stroke-width="1"/><path d="M9 0v12M0 6h18" stroke="#fff" stroke-width="4"/><path d="M9 0v12M0 6h18" stroke="#c8102e" stroke-width="2"/>',
  HK: '<rect width="18" height="12" fill="#de2910"/><path d="M9 2.5c2.1 0 2.7 1.9 1.4 3.2S8 6.5 8 5s.8-2.5 1-2.5z" fill="#fff"/>',
  IN: '<path d="M0 0h18v4H0z" fill="#ff9933"/><path d="M0 4h18v4H0z" fill="#fff"/><path d="M0 8h18v4H0z" fill="#128807"/><circle cx="9" cy="6" r="1.5" fill="none" stroke="#000080" stroke-width=".35"/>',
  IT: '<path d="M0 0h6v12H0z" fill="#009246"/><path d="M6 0h6v12H6z" fill="#fff"/><path d="M12 0h6v12h-6z" fill="#ce2b37"/>',
  JP: '<rect width="18" height="12" fill="#fff"/><circle cx="9" cy="6" r="3.2" fill="#bc002d"/>',
  KR: '<rect width="18" height="12" fill="#fff"/><circle cx="9" cy="6" r="2.4" fill="#cd2e3a"/><path d="M9 6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 1 1 0-4.8z" fill="#0047a0"/>',
  NL: '<path d="M0 0h18v4H0z" fill="#ae1c28"/><path d="M0 4h18v4H0z" fill="#fff"/><path d="M0 8h18v4H0z" fill="#21468b"/>',
  RU: '<path d="M0 0h18v4H0z" fill="#fff"/><path d="M0 4h18v4H0z" fill="#0039a6"/><path d="M0 8h18v4H0z" fill="#d52b1e"/>',
  SG: '<path d="M0 0h18v6H0z" fill="#ed2939"/><path d="M0 6h18v6H0z" fill="#fff"/><circle cx="4" cy="3" r="1.7" fill="#fff"/><circle cx="4.6" cy="3" r="1.4" fill="#ed2939"/>',
  UA: '<path d="M0 0h18v6H0z" fill="#0057b7"/><path d="M0 6h18v6H0z" fill="#ffd700"/>',
  US: '<path d="M0 0h18v12H0z" fill="#b22234"/><path d="M0 1.85h18v1.85H0zM0 5.55h18V7.4H0zM0 9.25h18v1.85H0z" fill="#fff"/><path d="M0 0h8v6.5H0z" fill="#3c3b6e"/>',
};

export function regionFlagSvg(code: string): string {
  const normalized = /^[A-Z]{2}$/.test(code) ? code : '??';
  const design = FLAG_DESIGNS[normalized]
    ?? `<rect width="18" height="12" rx="1" fill="#0d3a20"/><text x="9" y="8" fill="#35f477" font-size="5" font-family="monospace" text-anchor="middle">${normalized}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 12" role="img" aria-label="${normalized} flag">${design}</svg>`;
}

export function regionFlagDataUrl(code: string): string {
  return `data:image/svg+xml,${encodeURIComponent(regionFlagSvg(code))}`;
}

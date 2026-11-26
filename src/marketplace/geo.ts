/**
 * Approximate distance from home (Ramsey, Huntingdonshire) using a small
 * built-in gazetteer: no external geocoding, no API cost. Marketplace already
 * filters by radius, so this only ranks; an unknown place is a review
 * candidate, never a rejection. Coordinates are town centres, accurate to a
 * few miles, which is all the scoring needs.
 */

export const HOME = { name: 'Ramsey', lat: 52.4497, lon: -0.1077 } as const;

const TOWNS: Record<string, [number, number]> = {
  ramsey: [52.4497, -0.1077],
  huntingdon: [52.3306, -0.1857],
  'st ives': [52.3307, -0.0745],
  'st neots': [52.2283, -0.2701],
  'st. ives': [52.3307, -0.0745],
  'st. neots': [52.2283, -0.2701],
  godmanchester: [52.3197, -0.1748],
  somersham: [52.3816, 0.0016],
  warboys: [52.4031, -0.0794],
  sawtry: [52.4383, -0.2779],
  yaxley: [52.5137, -0.2593],
  whittlesey: [52.5583, -0.1300],
  chatteris: [52.4565, 0.0526],
  march: [52.5510, 0.0880],
  peterborough: [52.5695, -0.2405],
  wisbech: [52.6661, 0.1594],
  ely: [52.3995, 0.2624],
  cambridge: [52.2053, 0.1218],
  stamford: [52.6517, -0.4800],
  oundle: [52.4833, -0.4667],
  thrapston: [52.3967, -0.5383],
  kettering: [52.3983, -0.7262],
  corby: [52.4914, -0.6965],
  wellingborough: [52.3029, -0.6948],
  rushden: [52.2905, -0.5990],
  northampton: [52.2405, -0.9027],
  bedford: [52.1360, -0.4667],
  sandy: [52.1316, -0.2970],
  biggleswade: [52.0866, -0.2648],
  'st albans': [51.7550, -0.3360],
  stevenage: [51.9038, -0.1966],
  hitchin: [51.9490, -0.2830],
  letchworth: [51.9780, -0.2297],
  royston: [52.0480, -0.0240],
  luton: [51.8787, -0.4200],
  'milton keynes': [52.0406, -0.7594],
  newmarket: [52.2445, 0.4065],
  'bury st edmunds': [52.2463, 0.7111],
  haverhill: [52.0833, 0.4333],
  "king's lynn": [52.7517, 0.3956],
  'kings lynn': [52.7517, 0.3956],
  downham: [52.6000, 0.3833],
  'downham market': [52.6000, 0.3833],
  thetford: [52.4130, 0.7520],
  spalding: [52.7865, -0.1531],
  holbeach: [52.8040, 0.0150],
  bourne: [52.7684, -0.3777],
  boston: [52.9789, -0.0266],
  grantham: [52.9118, -0.6420],
  oakham: [52.6704, -0.7277],
  uppingham: [52.5870, -0.7230],
  'market harborough': [52.4775, -0.9208],
  leicester: [52.6369, -1.1398],
  sleaford: [52.9990, -0.4100],
  mildenhall: [52.3446, 0.5097],
  brandon: [52.4471, 0.6247],
  'saffron walden': [52.0225, 0.2397],
  stansted: [51.8990, 0.1990],
  'bishops stortford': [51.8720, 0.1590],
  "bishop's stortford": [51.8720, 0.1590],
  hertford: [51.7960, -0.0780],
  welwyn: [51.8310, -0.2150],
  'welwyn garden city': [51.8010, -0.2040],
  harlow: [51.7720, 0.1020],
  norwich: [52.6309, 1.2974],
  lincoln: [53.2307, -0.5406],
  nottingham: [52.9548, -1.1581],
  ipswich: [52.0567, 1.1482],
  colchester: [51.8959, 0.8919],
  chelmsford: [51.7356, 0.4685],
  london: [51.5072, -0.1276],
};

/** County fallback: the rough centre of each county. Low confidence. */
const COUNTIES: Record<string, [number, number]> = {
  cambridgeshire: [52.3, 0.05],
  huntingdonshire: [52.35, -0.2],
  northamptonshire: [52.3, -0.85],
  bedfordshire: [52.05, -0.45],
  hertfordshire: [51.85, -0.25],
  lincolnshire: [53.1, -0.3],
  rutland: [52.65, -0.65],
  leicestershire: [52.7, -1.1],
  suffolk: [52.2, 1.0],
  norfolk: [52.65, 0.9],
  essex: [51.8, 0.55],
  buckinghamshire: [51.8, -0.8],
};

export interface Distance {
  miles: number | null;
  basis: 'town' | 'county' | 'unknown';
}

export function haversineMiles(a: readonly [number, number], b: readonly [number, number]): number {
  const R = 3958.8;
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z' .]/g, ' ').replace(/\s+/g, ' ').trim();

/** Distance from home for a Marketplace location such as "Huntingdon, Cambridgeshire". */
export function distanceFromHome(location: string | null, home: readonly [number, number] = [HOME.lat, HOME.lon]): Distance {
  if (!location) return { miles: null, basis: 'unknown' };
  const parts = location.split(',').map(norm).filter(Boolean);
  const round = (n: number): number => Math.round(n * 10) / 10;
  for (const p of parts) {
    const t = TOWNS[p];
    if (t) return { miles: round(haversineMiles(home, t)), basis: 'town' };
  }
  for (const p of parts) {
    const c = COUNTIES[p];
    if (c) return { miles: round(haversineMiles(home, c)), basis: 'county' };
  }
  return { miles: null, basis: 'unknown' };
}

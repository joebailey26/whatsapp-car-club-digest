import { z } from 'zod';

/**
 * Rule-first, explainable lead scoring. This is a ranking aid, not an ROI
 * proof: it never rejects a car for missing year, mileage, MOT, fault detail
 * or valuation. Every point comes with a reason that is stored in D1 and shown
 * in the email and admin view. All weights and word lists are configuration
 * (PUT /admin/api/settings), versioned, and can be replayed against stored
 * listings before they go live.
 */

const Words = z.array(z.string().min(2).max(40)).max(200);

export const ScoringSchema = z.object({
  version: z.string().min(1).max(40),
  urgentThreshold: z.number().int().min(0).max(200),
  reviewThreshold: z.number().int().min(-100).max(200),
  /** Urgent alerts are only for adverts at or under this price (pence); dearer ones go to review at best. */
  urgentMaxPricePence: z.number().int().min(0),
  /** A desirable car at or under this price is always urgent (the "£750 MX-5" guarantee). */
  desirableAlwaysUrgentPence: z.number().int().min(0),
  price: z.object({
    strongUnderPence: z.number().int(),
    strongBonus: z.number().int(),
    goodUnderPence: z.number().int(),
    goodBonus: z.number().int(),
    stretchUnderPence: z.number().int(),
    stretchBonus: z.number().int(),
    overPenalty: z.number().int(),
  }),
  distance: z.object({
    nearMiles: z.number(),
    nearBonus: z.number().int(),
    inRangeMiles: z.number(),
    inRangeBonus: z.number().int(),
    farMiles: z.number(),
    farPenalty: z.number().int(),
    tooFarPenalty: z.number().int(),
  }),
  age: z.object({ preferredMaxYear: z.number().int(), olderBonus: z.number().int(), newerPenalty: z.number().int() }),
  priceDropBonus: z.number().int(),
  /** A drop counts as significant when it is at least this many pence OR this fraction of the old price. */
  priceDrop: z.object({ minPence: z.number().int().min(0), minFraction: z.number().min(0).max(1) }),
  desirable: z.object({ bonus: z.number().int(), words: Words }),
  japaneseMakes: z.object({ bonus: z.number().int(), words: Words }),
  extras: z.object({ bonus: z.number().int(), cap: z.number().int(), words: Words }),
  repairableFaults: z.object({ bonus: z.number().int(), words: Words }),
  severeFaults: z.object({ penalty: z.number().int(), words: Words }),
  uncertainElectrical: z.object({ penalty: z.number().int(), words: Words }),
  notCars: z.object({ penalty: z.number().int(), words: Words }),
});
export type Scoring = z.infer<typeof ScoringSchema>;

export const DEFAULT_SCORING: Scoring = {
  version: 'rules-2026-11-25.1',
  // Permissive on purpose: early tuning favours not missing a bargain over fewer emails.
  urgentThreshold: 45,
  reviewThreshold: 5,
  urgentMaxPricePence: 150_000,
  desirableAlwaysUrgentPence: 100_000,
  price: {
    strongUnderPence: 50_000,
    strongBonus: 30,
    goodUnderPence: 100_000,
    goodBonus: 15,
    stretchUnderPence: 150_000,
    stretchBonus: 0,
    overPenalty: -30,
  },
  distance: { nearMiles: 25, nearBonus: 10, inRangeMiles: 50, inRangeBonus: 5, farMiles: 70, farPenalty: -5, tooFarPenalty: -25 },
  age: { preferredMaxYear: 2009, olderBonus: 10, newerPenalty: -10 },
  priceDropBonus: 15,
  priceDrop: { minPence: 5_000, minFraction: 0.1 },
  desirable: {
    bonus: 25,
    words: [
      'mx5', 'mx-5', 'mx 5', 'miata', 'eunos', 'mr2', 'mr-2', 'celica', 'supra', 'skyline', 'silvia', '200sx', '300zx', '350z',
      's2000', 'integra', 'type r', 'ep3', 'crx', 'cr-x', 'del sol', 'prelude', 'rx7', 'rx-7', 'rx8', 'rx-8', 'impreza', 'wrx', 'sti',
      'legacy gt', 'evo', 'lancer evolution', 'fto', 'gto', '3000gt', 'starlet', 'glanza', 'ae86', 'levin', 'trueno', 'figaro', 'pao',
      'copen', 'cappuccino', 'beat', 'swift sport', 'jimny', 'pajero', 'delica', 'land cruiser', 'hilux surf', 'mx-3', 'mx3', 'mx-6',
      'gti', '205', '106 gti', 'saxo vts', 'clio 172', 'clio 182', 'clio williams', 'mini cooper', 'e30', 'e36', 'e46', 'z3', 'z4',
      'slk', 'boxster', 'mgf', 'mg tf', 'elise', '9-3 aero', 'aero', '850 t5', 'cabriolet', 'convertible', 'roadster', 'coupe',
    ],
  },
  japaneseMakes: {
    bonus: 10,
    words: ['mazda', 'toyota', 'honda', 'nissan', 'subaru', 'mitsubishi', 'suzuki', 'daihatsu', 'lexus', 'isuzu', 'datsun', 'infiniti'],
  },
  extras: {
    bonus: 10,
    cap: 20,
    words: ['hardtop', 'hard top', 'alloys', 'alloy wheels', 'new clutch', 'full service history', 'fsh', 'long mot', 'spare wheels', 'spares included', 'cambelt done', 'timing belt done'],
  },
  repairableFaults: {
    bonus: 5,
    words: [
      'needs mot', 'mot failure', 'failed mot', 'no mot', 'mot expired', 'cosmetic', 'dent', 'scratches', 'needs battery', 'flat battery',
      'needs clutch', 'clutch slipping', 'needs brakes', 'exhaust', 'sills', 'welding', 'rust', 'spares or repair', 'spares/repair',
      'spares repair', 'project', 'needs tlc', 'easy fix', 'cv joint', 'drop link', 'bushes', 'tyres',
    ],
  },
  severeFaults: {
    penalty: -20,
    words: [
      'head gasket', 'gearbox', 'transmission', 'cvt', 'engine knock', 'knocking', 'non runner', 'non-runner', 'no start', "won't start",
      'wont start', 'does not start', 'timing chain', 'seized', 'blown', 'smoking', 'overheating', 'engine fault', 'misfire', 'water in oil',
    ],
  },
  uncertainElectrical: { penalty: -10, words: ['electrical fault', 'electrical issue', 'warning lights', 'immobiliser', 'ecu'] },
  // Parts, wanted adverts and non-cars that a vehicles search can still return.
  notCars: { penalty: -40, words: ['wanted', 'breaking', 'for parts only', 'engine only', 'wheels only', 'caravan', 'motorhome', 'trailer', 'quad', 'motorbike', 'scooter'] },
};

export type Route = 'urgent' | 'review' | 'low';

export interface ScoreInput {
  title: string;
  description: string | null;
  pricePence: number | null;
  distanceMiles: number | null;
  distanceBasis: 'town' | 'county' | 'unknown';
  year: number | null;
  /** Pence the price fell by since we last saw it (or a struck-through price on the card). */
  priceDropPence: number | null;
  previousPricePence: number | null;
}

export interface ScoreResult {
  score: number;
  route: Route;
  reasons: string[];
  rulesetVersion: string;
  /** True when the route is uncertain enough that an optional AI check may help. */
  borderline: boolean;
}

/** Lower-case, punctuation-light text for whole-word phrase matching. */
export function normaliseText(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9'\-/ ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

export function matchWords(text: string, words: readonly string[]): string[] {
  const hits: string[] = [];
  for (const w of words) {
    const needle = normaliseText(w);
    if (needle.trim() && text.includes(needle)) hits.push(w);
  }
  return hits;
}

const gbp = (p: number): string => `£${(p / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;

export function isSignificantDrop(oldPence: number | null, newPence: number | null, cfg: Scoring['priceDrop']): boolean {
  if (oldPence === null || newPence === null || newPence >= oldPence) return false;
  const drop = oldPence - newPence;
  return drop >= cfg.minPence || drop >= oldPence * cfg.minFraction;
}

export function scoreListing(input: ScoreInput, cfg: Scoring = DEFAULT_SCORING): ScoreResult {
  const reasons: string[] = [];
  let score = 0;
  let uncertain = false;
  const add = (n: number, why: string): void => {
    score += n;
    reasons.push(n === 0 ? why : `${n > 0 ? '+' : ''}${n} ${why}`);
  };

  const titleText = normaliseText(input.title);
  const text = normaliseText(`${input.title} ${input.description ?? ''}`);

  // Price
  const p = input.pricePence;
  if (p === null) {
    uncertain = true;
    reasons.push('price not shown: review');
  } else if (p < cfg.price.strongUnderPence) add(cfg.price.strongBonus, `asking ${gbp(p)} (under ${gbp(cfg.price.strongUnderPence)})`);
  else if (p <= cfg.price.goodUnderPence) add(cfg.price.goodBonus, `asking ${gbp(p)} (${gbp(cfg.price.strongUnderPence)}–${gbp(cfg.price.goodUnderPence)})`);
  else if (p <= cfg.price.stretchUnderPence) add(cfg.price.stretchBonus, `asking ${gbp(p)}: only if unusually desirable`);
  else add(cfg.price.overPenalty, `asking ${gbp(p)} (over ${gbp(cfg.price.stretchUnderPence)})`);

  // Distance
  const d = input.distanceMiles;
  if (d === null) {
    uncertain = true;
    reasons.push('location unknown or not in gazetteer: review');
  } else {
    const approx = input.distanceBasis === 'county' ? ' (county centre, approximate)' : '';
    if (d <= cfg.distance.nearMiles) add(cfg.distance.nearBonus, `~${Math.round(d)} miles away${approx}`);
    else if (d <= cfg.distance.inRangeMiles) add(cfg.distance.inRangeBonus, `~${Math.round(d)} miles away${approx}`);
    else if (d <= cfg.distance.farMiles) add(cfg.distance.farPenalty, `~${Math.round(d)} miles away, just outside range${approx}`);
    else add(cfg.distance.tooFarPenalty, `~${Math.round(d)} miles away${approx}`);
  }

  // Age
  if (input.year !== null) {
    if (input.year <= cfg.age.preferredMaxYear) add(cfg.age.olderBonus, `${input.year} (pre-${cfg.age.preferredMaxYear + 1})`);
    else add(cfg.age.newerPenalty, `${input.year} (newer than preferred)`);
  }

  // Make / model (title only: descriptions mention other cars too often)
  const desirable = matchWords(titleText, cfg.desirable.words);
  if (desirable.length) add(cfg.desirable.bonus, `enthusiast/quirky: ${desirable.slice(0, 3).join(', ')}`);
  const jp = matchWords(titleText, cfg.japaneseMakes.words);
  if (jp.length) add(cfg.japaneseMakes.bonus, `Japanese make: ${jp[0]}`);

  // Extras and faults (title + description)
  const extras = matchWords(text, cfg.extras.words);
  if (extras.length) add(Math.min(cfg.extras.bonus * extras.length, cfg.extras.cap), `extras: ${extras.slice(0, 4).join(', ')}`);
  const repairable = matchWords(text, cfg.repairableFaults.words);
  if (repairable.length) add(cfg.repairableFaults.bonus, `known/repairable: ${repairable.slice(0, 4).join(', ')}${repairable.some((w) => /weld|rust|sills/.test(w)) ? ' (welding is a costed repair, ~£300/patch)' : ''}`);
  const severe = matchWords(text, cfg.severeFaults.words);
  if (severe.length) {
    add(cfg.severeFaults.penalty, `major/unexplained fault: ${severe.slice(0, 3).join(', ')}`);
    uncertain = true;
  }
  const elec = matchWords(text, cfg.uncertainElectrical.words);
  if (elec.length) {
    add(cfg.uncertainElectrical.penalty, `uncertain electrics: ${elec.slice(0, 2).join(', ')}`);
    uncertain = true;
  }
  const notCar = matchWords(titleText, cfg.notCars.words);
  if (notCar.length) add(cfg.notCars.penalty, `probably not a whole car: ${notCar[0]}`);

  // Price drop
  if (input.priceDropPence !== null && input.priceDropPence > 0 && input.previousPricePence !== null) {
    add(cfg.priceDropBonus, `price dropped ${gbp(input.priceDropPence)} from ${gbp(input.previousPricePence)}`);
  }

  // Routing. Desirable + cheap is always urgent unless clearly too far or not a car.
  const tooFar = d !== null && d > cfg.distance.farMiles;
  let route: Route;
  if (desirable.length && p !== null && p <= cfg.desirableAlwaysUrgentPence && !tooFar && !notCar.length) {
    route = 'urgent';
    if (score < cfg.urgentThreshold) reasons.push('urgent: desirable car under the always-alert price');
  } else if (score >= cfg.urgentThreshold && p !== null && p <= cfg.urgentMaxPricePence) {
    route = 'urgent';
  } else if (score >= cfg.reviewThreshold || (uncertain && !notCar.length && !tooFar)) {
    route = 'review';
  } else {
    route = 'low';
  }
  const borderline = route === 'review' || (route === 'low' && score >= cfg.reviewThreshold - 10);
  return { score, route, reasons, rulesetVersion: cfg.version, borderline };
}

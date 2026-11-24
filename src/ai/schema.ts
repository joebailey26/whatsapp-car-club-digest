import { z } from 'zod';

/**
 * Structured output contract for event extraction. Every model response is
 * validated against this with Zod. JSON Mode alone is not trusted.
 *
 * Unknown values must be null. Nothing may be inferred beyond the cited messages.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const CandidateKind = z.enum(['event', 'cancellation', 'change', 'rsvp_request', 'deadline', 'announcement']);
export const EventStatus = z.enum(['tentative', 'confirmed', 'updated', 'cancelled']);

export const CandidateSchema = z.object({
  kind: CandidateKind,
  title: z.string().trim().min(1).max(120),
  date: isoDate.nullable(),
  startTime: hhmm.nullable(),
  location: z.string().trim().max(120).nullable(),
  meetingPoint: z.string().trim().max(120).nullable(),
  status: EventStatus,
  confidence: z.number().min(0).max(1),
  rsvpRequired: z.boolean(),
  rsvpDeadline: isoDate.nullable(),
  price: z.string().trim().max(40).nullable(),
  notes: z.string().trim().max(300).nullable(),
  /** For change/cancellation: the title of the event it refers to, as written. */
  refersTo: z.string().trim().max(120).nullable(),
  /** Short refs (e.g. "m12") of the messages that support this candidate. */
  sourceRefs: z.array(z.string().regex(/^[mc]\d{1,4}$/)).min(1).max(20),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** A member selling a car or parts, or saying an earlier listing is sold/withdrawn/repriced. */
export const ListingSchema = z.object({
  kind: z.enum(['car', 'part']),
  action: z.enum(['for_sale', 'price_change', 'sold', 'withdrawn']),
  title: z.string().trim().min(1).max(120),
  make: z.string().trim().max(40).nullable(),
  model: z.string().trim().max(60).nullable(),
  year: z.number().int().min(1900).max(2100).nullable(),
  price: z.string().trim().max(40).nullable(),
  mileage: z.string().trim().max(30).nullable(),
  location: z.string().trim().max(80).nullable(),
  details: z.string().trim().max(240).nullable(),
  refersTo: z.string().trim().max(120).nullable(),
  confidence: z.number().min(0).max(1),
  sourceRefs: z.array(z.string().regex(/^[mc]\d{1,4}$/)).min(1).max(10),
});
export type Listing = z.infer<typeof ListingSchema>;

export const ExtractionSchema = z.object({ candidates: z.array(CandidateSchema).max(30), listings: z.array(ListingSchema).max(30).default([]) });
export type Extraction = z.infer<typeof ExtractionSchema>;

export const LISTING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'action', 'title', 'make', 'model', 'year', 'price', 'mileage', 'location', 'details', 'refersTo', 'confidence', 'sourceRefs'],
  properties: {
    kind: { type: 'string', enum: ['car', 'part'] },
    action: { type: 'string', enum: ['for_sale', 'price_change', 'sold', 'withdrawn'] },
    title: { type: 'string' },
    make: { type: ['string', 'null'] },
    model: { type: ['string', 'null'] },
    year: { type: ['integer', 'null'] },
    price: { type: ['string', 'null'], description: 'as written, e.g. "£4,500 ono"' },
    mileage: { type: ['string', 'null'] },
    location: { type: ['string', 'null'] },
    details: { type: ['string', 'null'] },
    refersTo: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    sourceRefs: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
} as const;

/** Structured-output schema for the separate listings call. */
export const LISTINGS_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['listings'],
  properties: { listings: { type: 'array', maxItems: 30, items: LISTING_JSON_SCHEMA } },
} as const;

/** JSON Schema given to the model's structured-output mode (mirrors the Zod schema). */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'kind',
          'title',
          'date',
          'startTime',
          'location',
          'meetingPoint',
          'status',
          'confidence',
          'rsvpRequired',
          'rsvpDeadline',
          'price',
          'notes',
          'refersTo',
          'sourceRefs',
        ],
        properties: {
          kind: { type: 'string', enum: ['event', 'cancellation', 'change', 'rsvp_request', 'deadline', 'announcement'] },
          title: { type: 'string' },
          date: { type: ['string', 'null'], description: 'YYYY-MM-DD or null' },
          startTime: { type: ['string', 'null'], description: 'HH:MM 24h or null' },
          location: { type: ['string', 'null'] },
          meetingPoint: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['tentative', 'confirmed', 'updated', 'cancelled'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          rsvpRequired: { type: 'boolean' },
          rsvpDeadline: { type: ['string', 'null'], description: 'YYYY-MM-DD or null' },
          price: { type: ['string', 'null'] },
          notes: { type: ['string', 'null'] },
          refersTo: { type: ['string', 'null'] },
          sourceRefs: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
    },
  },
} as const;

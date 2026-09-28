/**
 * concertIngest/concertResolver.ts
 *
 * Reusable, read-only duplicate detection for concerts using the agreed
 * application-level event identity (see buildEventIdentity). Query-before-insert:
 * fetch the few concerts an artist has on a given date, recompute each one's
 * identity, and compare. Never writes.
 *
 * Shared by the historical Excel import and the future BookMyShow/District
 * ingestion so both use one identity definition.
 */
import type { PrismaClient } from '@prisma/client';
import { buildEventIdentity, classifyVenue } from './normalize';

export interface ConcertIdentityInput {
  artistId: string;
  date: Date;
  city: string;
  venueName?: string | null;
  eventName?: string | null;
}

export interface DuplicateResult {
  isDuplicate: boolean;
  /** Existing concert id when a DB duplicate was found. */
  existingConcertId?: string;
  identity: string;
}

type ConcertReader = Pick<PrismaClient['concert'], 'findMany'>;

/**
 * Recompute the identity of an already-stored concert so re-imports dedup
 * correctly. Crucially, the stored venueName is re-classified: if it is a
 * placeholder (e.g. "Venue to be announced") or a city-as-venue value, it is
 * treated as absent and the identity falls back to the event name (which we
 * write into `notes`) — mirroring exactly how the row was keyed at ingest.
 * Real venues key off venueName and ignore notes.
 */
export function storedConcertIdentity(row: {
  artistId: string;
  concertDate: Date;
  city: string;
  venueName: string | null;
  notes: string | null;
}): string {
  const classification = classifyVenue(row.venueName, row.city);
  const realVenue = classification.kind === 'real' ? classification.text : null;
  return buildEventIdentity({
    artistId: row.artistId,
    date: row.concertDate,
    city: row.city,
    venueName: realVenue,
    eventName: row.notes,
  });
}

/**
 * Detect whether a concert already exists in the DB (read-only).
 *
 * `seenIdentities` catches duplicates *within the same import run* (two rows in
 * the workbook that resolve to the same event) before they ever reach the DB.
 */
export async function detectDuplicateConcert(
  concert: { findMany: ConcertReader['findMany'] },
  input: ConcertIdentityInput,
  seenIdentities?: Set<string>
): Promise<DuplicateResult> {
  const identity = buildEventIdentity({
    artistId: input.artistId,
    date: input.date,
    city: input.city,
    venueName: input.venueName,
    eventName: input.eventName,
  });

  if (seenIdentities?.has(identity)) {
    return { isDuplicate: true, identity };
  }

  const candidates = await concert.findMany({
    where: { artistId: input.artistId, concertDate: input.date },
    select: { id: true, artistId: true, concertDate: true, city: true, venueName: true, notes: true },
  });

  const match = candidates.find((c) => storedConcertIdentity(c) === identity);

  if (seenIdentities) seenIdentities.add(identity);

  return match
    ? { isDuplicate: true, existingConcertId: match.id, identity }
    : { isDuplicate: false, identity };
}

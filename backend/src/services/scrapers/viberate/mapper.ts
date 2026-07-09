/**
 * mapper.ts
 *
 * Converts raw Viberate API graph responses into typed rows
 * ready for Prisma upsert into ViberateMetricDaily.
 *
 * Kept separate from collector.ts so it can be unit-tested independently.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ViberateGraphMetric {
  graph: {
    diff: Record<string, number>;
    total: Record<string, number>; // may be {} for some metrics
  };
}

export interface ViberateGraphResponse {
  api_version: string;
  data: Record<string, ViberateGraphMetric>;
}

// Matches the ViberateMetricDaily Prisma model shape
export interface MappedMetricRow {
  artistId: string;
  metricName: string;
  date: Date;
  diffValue: number | null;
  totalValue: number | null;
  apiVersion: string;
}

// ─── Mapper ──────────────────────────────────────────────────────────────────

export function mapGraphResponse(
  artistId: string,
  response: ViberateGraphResponse
): MappedMetricRow[] {
  const rows: MappedMetricRow[] = [];
  const apiVersion = response.api_version ?? 'unknown';

  for (const [metricName, metricData] of Object.entries(response.data)) {
    // Defensive: handle malformed responses gracefully
    if (!metricData?.graph) {
      console.warn(`[mapper] No graph data for metric: ${metricName}`);
      continue;
    }

    const diffMap = metricData.graph.diff ?? {};
    const totalMap = metricData.graph.total ?? {};

    // Build the union of all dates from both diff and total.
    // Some metrics have total but sparse diff (e.g. youtube_channel_views),
    // some have diff but no total (e.g. instagram_likes).
    const allDates = new Set([
      ...Object.keys(diffMap),
      ...Object.keys(totalMap),
    ]);

    for (const dateStr of allDates) {
      const rawDiff = diffMap[dateStr];
      const rawTotal = totalMap[dateStr];

      rows.push({
        artistId,
        metricName,
        // Parse the YYYY-MM-DD string into a Date object
        // Prisma @db.Date stores only the date portion, no time component
        date: new Date(`${dateStr}T00:00:00.000Z`),

        // Store the raw diff value including zeros.
        // The collector and analytics layer will interpret diff=0 as
        // "no Viberate update" when needed, but we don't discard it here
        // since the zero is still meaningful for gap detection.
        diffValue: rawDiff !== undefined ? rawDiff : null,

        // Null when total is genuinely missing from the response.
        // Known metrics with always-empty total:
        //   instagram_likes, instagram_comments, tiktok_views, tiktok_comments
        totalValue: rawTotal !== undefined ? rawTotal : null,

        apiVersion,
      });
    }
  }

  return rows;
}

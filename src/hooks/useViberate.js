import { useQuery } from '@tanstack/react-query'
import client from '../api/client'

/**
 * Viberate hooks — backed by:
 *   GET /artists/:id/score
 *   GET /artists/:id/viberate-metrics?metric=...&days=N
 *
 * NOTE: the old ArtistPopularityV2 leaderboard was removed along with that
 * scoring system (FORMULA_DECISIONS.md §2) — /artists/:id/score now returns
 * the canonical Popularity breakdown instead.
 */

export function useArtistScore(id) {
  return useQuery({
    queryKey: ['artistScore', id],
    queryFn: async () => {
      const response = await client.get(`/artists/${id}/score`)
      return response.data.data // { artistId, artistName, latest }
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!id,
  })
}

export function useViberateMetrics(id, metrics, days = 90) {
  const metricParam = Array.isArray(metrics) ? metrics.join(',') : (metrics || '')
  return useQuery({
    queryKey: ['viberateMetrics', id, metricParam, days],
    queryFn: async () => {
      const response = await client.get(
        `/artists/${id}/viberate-metrics?metric=${encodeURIComponent(metricParam)}&days=${days}`
      )
      return response.data.data.series // { [metricName]: [{date, diff, total}] }
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!id && metricParam.length > 0,
  })
}

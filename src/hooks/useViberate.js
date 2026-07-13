import { useQuery } from '@tanstack/react-query'
import client from '../api/client'

/**
 * Viberate / PopularityV2 hooks — backed by:
 *   GET /artists/leaderboard
 *   GET /artists/:id/score?history=N
 *   GET /artists/:id/viberate-metrics?metric=...&days=N
 */

export function useLeaderboard() {
  return useQuery({
    queryKey: ['leaderboard'],
    queryFn: async () => {
      const response = await client.get('/artists/leaderboard')
      return response.data.data // { leaderboard, unscored, scoreVersion }
    },
    staleTime: 5 * 60 * 1000,
  })
}

export function useArtistScore(id, history = 60) {
  return useQuery({
    queryKey: ['artistScore', id, history],
    queryFn: async () => {
      const response = await client.get(`/artists/${id}/score?history=${history}`)
      return response.data.data // { artistId, artistName, latest, history }
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!id,
    // 404 just means "not scored yet" — don't hammer the API
    retry: (failureCount, error) =>
      error?.response?.status === 404 ? false : failureCount < 2,
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

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import client from '../api/client'

export function useAutoPredict(artistId, city, capacity, enabled, options = {}) {
  return useQuery({
    queryKey: ['autoPredict', artistId, city, capacity, options],
    queryFn: async () => {
      if (!artistId || !city) return null
      const payload = {
        artist_id: artistId,
        artist_name: options.artistName,
        city,
        country: options.country || 'India',
        avg_ticket_price: options.avgTicketPrice,
        event_date: options.eventDate,
        venue_name: options.venueName,
        venue_type: options.venueType,
      }
      if (capacity) payload.capacity = capacity
      // Pass through a Demand score the page already fetched (e.g. Analysis' own
      // useMadDemand call for the same artist/city) so the backend's revenue
      // predictor reuses it instead of recomputing Demand itself from scratch.
      if (options.demandScore != null) payload.demand_score = options.demandScore
      // Pass through a Popularity score the page already fetched so Revenue's
      // Tier 2 feasibility softening (see revenue/predictor.py) has a real
      // value to check -- omitted entirely (never a guessed/default value)
      // when the caller hasn't fetched Popularity for this artist.
      if (options.popularityScore != null) payload.popularity_score = options.popularityScore

      const { data } = await client.post('/analytics/ml/revenue', payload)
      return data.data
    },
    enabled: enabled,
    staleTime: Infinity,
    retry: false,
  })
}

export function useMadGrowth(artistId, enabled) {
  return useQuery({
    queryKey: ['madGrowth', artistId],
    queryFn: async () => {
      if (!artistId) return null
      const { data } = await client.post('/analytics/ml/growth', { artist_id: artistId })
      return data.data
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

export function useMadDemand(artistId, city, enabled, options = {}) {
  return useQuery({
    queryKey: ['madDemand', artistId, city, options],
    queryFn: async () => {
      if (!artistId || !city) return null
      const { data } = await client.post('/analytics/ml/demand', {
        artist_id: artistId,
        city,
        country: options.country || 'India',
        target_date: options.targetDate,
      })
      return data.data
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

export function useMadPopularity(artistId, enabled) {
  return useQuery({
    queryKey: ['madPopularity', artistId],
    queryFn: async () => {
      if (!artistId) return null
      const { data } = await client.post('/analytics/ml/popularity', { artist_id: artistId })
      return data.data
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

export function useMadLlmPrediction(artistId, city, capacity, enabled, options = {}) {
  return useQuery({
    queryKey: ['madLlmPrediction', artistId, city, capacity, options],
    queryFn: async () => {
      if (!artistId || !city) return null
      const { data } = await client.post('/analytics/ml/llm-predict', {
        artist_id: artistId,
        artist_name: options.artistName,
        city,
        venue_capacity: capacity,
        venue_name: options.venueName,
        venue_type: options.venueType || 'arena',
        currency: options.currency || undefined,  // Let backend resolve from country
      })
      return data.data
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

export function useMadVenueCapacity(venueName, city, enabled, options = {}) {
  return useQuery({
    queryKey: ['madVenueCapacity', venueName, city, options],
    queryFn: async () => {
      if (!venueName || !city) return null
      const { data } = await client.post('/analytics/ml/venue-capacity', {
        venue_name: venueName,
        city,
        country: options.country || 'India',
        venue_type: options.venueType || 'arena',
        supplied_capacity: options.suppliedCapacity,
      })
      return data.data
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

export function useModelInfo() {
  return useQuery({
    queryKey: ['modelInfo'],
    queryFn: async () => ({ models: [] }), // We can populate this later if there is a model info endpoint
    staleTime: Infinity,
    retry: false,
  })
}

// "Sync Now" (weekly-cache-plus-manual-sync design, 2026-09). Popularity is
// normally read from artists.popularity, refreshed automatically on a
// schedule (as often as every 24h) -- normal page loads never wait on a
// live calculation. This is the manual override for anyone who wants
// today's number specifically (e.g. right before a stakeholder demo).
// Shared by the Dashboard and Artists pages so both stay in sync after one
// click, wherever it was clicked from.
export function useSyncPopularity() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { data } = await client.post('/analytics/ml/popularity/refresh')
      return data.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['artists'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'top-artists'] })
      // 'artist' (singular, ['artist', id]) is a separate cache from the
      // 'artists' list queries above -- ArtistProfile fetches an individual
      // artist from a different endpoint, so it needs its own invalidation
      // or it can keep showing the pre-sync popularity/lastUpdated.
      queryClient.invalidateQueries({ queryKey: ['artist'] })
    },
  })
}


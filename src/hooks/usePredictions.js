import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
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

// Engagement ratios (YouTube like-rate, Spotify follow-rate) -- see
// mad_analytics/engagement/scorer.py for the WHY each ratio pairs the
// specific metrics it does, and which platforms (Instagram, Facebook) have
// no honest ratio available at all (always null, never a fabricated 0%).
export function useEngagement(artistId, enabled) {
  return useQuery({
    queryKey: ['engagement', artistId],
    queryFn: async () => {
      if (!artistId) return null
      const { data } = await client.get('/analytics/ml/engagement', { params: { artist_id: artistId } })
      return data.data
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

// State-level (NOT city-level) Google Trends search interest -- see
// mad_analytics/trends/regional.py: Google Trends' public API doesn't go
// finer than state/region for India, so this is always labelled by the
// resolved state name, never presented as city-specific.
export function useMadRegionalTrend(artistName, city, enabled) {
  return useQuery({
    queryKey: ['madRegionalTrend', artistName, city],
    queryFn: async () => {
      if (!artistName || !city) return null
      const { data } = await client.get('/analytics/ml/regional-trends', { params: { artist_name: artistName, city } })
      return data.data
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

// Per-artist repeat-visit rate -- of every city this artist has ever played,
// what fraction did they return to more than once. See
// mad_analytics/touring_history/scorer.py's repeat_visit_rate() for the WHY
// (a real touring-precedent signal, not another Popularity/Demand estimate).
export function useRepeatVisitRate(artistId, enabled) {
  return useQuery({
    queryKey: ['repeatVisitRate', artistId],
    queryFn: async () => {
      if (!artistId) return null
      const { data } = await client.get('/analytics/ml/touring-history/repeat-visit-rate', { params: { artist_id: artistId } })
      return data.data
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

// Every real, data-grounded insight the touring-history engine can find for
// ONE artist -- the per-artist surface of the same engine Dashboard's
// Touring Spotlight draws its roster-wide "best of" picks from. See
// mad_analytics/touring_history/scorer.py::artist_insights().
export function useArtistInsights(artistId, enabled) {
  return useQuery({
    queryKey: ['artistInsights', artistId],
    queryFn: async () => {
      if (!artistId) return null
      const { data } = await client.get('/analytics/ml/touring-history/insights', { params: { artist_id: artistId } })
      return data.data
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

// TOPSIS-ranked "how feasible is this city for this artist, vs. every other
// candidate city" -- see mad_analytics/feasibility/topsis.py for the WHY
// behind each of the 5 criteria (Artist Power, Engagement, City Affinity,
// Touring Precedent, Venue Fit) and their weights. rank/total_cities_compared
// reflect the FULL NCCS-covered candidate-city universe, not just whichever
// city this one call happens to ask about.
export function useFeasibility(artistId, city, country, enabled) {
  return useQuery({
    queryKey: ['feasibility', artistId, city, country],
    queryFn: async () => {
      if (!artistId || !city) return null
      const { data } = await client.post('/analytics/ml/feasibility', {
        artist_id: artistId,
        city,
        country: country || 'India',
      })
      return data.data
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

// Fan-out helper: fetches Feasibility for the SAME artist across several
// candidate cities in parallel (used to build a ranked city-comparison view).
// Each individual response is still the real, independent TOPSIS output for
// that one city -- this never reshapes or recomputes anything client-side,
// it just lets the UI issue several of the single-city calls above at once.
export function useFeasibilityForCities(artistId, cities, country, enabled) {
  return useQueries({
    queries: (cities || []).map((city) => ({
      queryKey: ['feasibility', artistId, city, country],
      queryFn: async () => {
        const { data } = await client.post('/analytics/ml/feasibility', {
          artist_id: artistId,
          city,
          country: country || 'India',
        })
        return data.data
      },
      enabled: Boolean(enabled && artistId && city),
      staleTime: 5 * 60 * 1000,
      retry: false,
    })),
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


import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import client from '../api/client'
import { classifyVenue } from '../utils/venueClassifier'

const getArrayPayload = (payload, key) => {
  if (Array.isArray(payload?.data?.[key])) return payload.data[key]
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.[key])) return payload[key]
  return []
}

// Groups the same ['concerts', 'all'] fetch already used by useDashboardData/
// useArtists (shared cache, no extra network round-trip) by venue+city, and
// cross-references the curated KNOWN_VENUES list so capacity can be labeled
// verified vs. estimated instead of shown as one undifferentiated number.
export function useVenues() {
  const { data: allConcertsRaw, isLoading: concertsLoading } = useQuery({
    queryKey: ['concerts', 'all'],
    queryFn: async () => {
      const response = await client.get('/concerts?limit=1000')
      return getArrayPayload(response.data, 'concerts')
    },
    staleTime: 10 * 60 * 1000,
  })

  const { data: knownVenuesRaw, isLoading: knownLoading } = useQuery({
    queryKey: ['venueCapacity', 'knownList'],
    queryFn: async () => {
      const response = await client.get('/analytics/ml/venue-capacity/known-list')
      return getArrayPayload(response.data, 'venues')
    },
    staleTime: 30 * 60 * 1000,
  })

  const venues = useMemo(() => {
    if (!allConcertsRaw) return []
    const knownSet = new Set(
      (knownVenuesRaw || []).map(k => `${(k.venue_name || '').toLowerCase()}|${(k.city || '').toLowerCase()}`)
    )

    const groups = {}
    for (const c of allConcertsRaw) {
      const venueName = c.venueName || ''
      const city = c.city || ''
      if (!venueName || !city) continue
      const key = `${venueName}|${city}`
      if (!groups[key]) {
        const { category, isOutdoor } = classifyVenue(venueName)
        groups[key] = {
          venueName,
          city,
          category,
          isOutdoor,
          capacity: Number(c.capacity || 0),
          isVerifiedCapacity: knownSet.has(`${venueName.toLowerCase()}|${city.toLowerCase()}`),
          concertCount: 0,
          artists: new Set(),
        }
      }
      groups[key].concertCount += 1
      const artistName = c.artist?.artistName || c.artistName
      if (artistName) groups[key].artists.add(artistName)
    }

    return Object.values(groups)
      .map(v => ({ ...v, artists: [...v.artists] }))
      .sort((a, b) => a.city.localeCompare(b.city) || b.concertCount - a.concertCount)
  }, [allConcertsRaw, knownVenuesRaw])

  return { venues, isLoading: concertsLoading || knownLoading }
}

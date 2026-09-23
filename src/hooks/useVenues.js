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

// The curated known-venues list stores names/cities lowercase (it's a lookup
// table, not a display list) -- title-case them only when we're about to
// show a venue that has no concert-derived (properly-cased) name to use.
const titleCase = (str = '') =>
  str.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1))

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

    // Blind-spot fix (2026-09, owner-flagged): "there are venues in a city
    // where the artist has not performed but they should also be there."
    // Until now, anything in KNOWN_VENUES that didn't already have a real
    // concert row was invisible on this page -- the cross-reference above
    // only used it to badge capacity on venues concerts already surfaced.
    // Add the remainder in explicitly, honestly zeroed out (concertCount: 0,
    // noTrackedConcerts: true) rather than silently merged in as if they had
    // touring history. This is still just the curated KNOWN_VENUES list --
    // a few hundred cross-verified entries, not a census of every venue in
    // a city -- so nothing here should be read as "full coverage."
    // `groups` keys above are built from the concert rows' raw casing (not
    // lowercased), so membership must be checked case-insensitively here too
    // -- otherwise a known-list entry whose casing differs even slightly
    // from the matching concert row (both refer to the same real venue)
    // would be wrongly treated as "not yet represented" and added a second
    // time under a different dict key, rendering as a duplicate tile.
    const existingKeysLower = new Set(Object.keys(groups).map(k => k.toLowerCase()))
    const cityCasing = {}
    for (const g of Object.values(groups)) {
      const cityLower = g.city.toLowerCase()
      if (!cityCasing[cityLower]) cityCasing[cityLower] = g.city
    }

    for (const k of knownVenuesRaw || []) {
      const rawVenue = k.venue_name || ''
      const rawCity = k.city || ''
      if (!rawVenue || !rawCity) continue
      const keyLower = `${rawVenue}|${rawCity}`.toLowerCase()
      if (existingKeysLower.has(keyLower)) continue // already represented via a real concert
      if (groups[keyLower]) continue // already added from an earlier known-list row

      const displayCity = cityCasing[rawCity.toLowerCase()] || titleCase(rawCity)
      const displayVenueName = titleCase(rawVenue)
      const { category, isOutdoor } = classifyVenue(displayVenueName)
      groups[keyLower] = {
        venueName: displayVenueName,
        city: displayCity,
        category,
        isOutdoor,
        capacity: Number(k.capacity || 0),
        isVerifiedCapacity: true, // it came from the curated list itself
        concertCount: 0,
        noTrackedConcerts: true, // honesty flag -- see comment above
        artists: [],
      }
    }

    return Object.values(groups)
      .map(v => ({ ...v, artists: Array.isArray(v.artists) ? v.artists : [...v.artists] }))
      .sort((a, b) => a.city.localeCompare(b.city) || b.concertCount - a.concertCount)
  }, [allConcertsRaw, knownVenuesRaw])

  return { venues, isLoading: concertsLoading || knownLoading }
}

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import client from '../api/client'

const isAuthenticated = () => !!localStorage.getItem('token')

const getArrayPayload = (payload, key) => {
  if (Array.isArray(payload?.data?.[key])) return payload.data[key]
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.[key])) return payload[key]
  return []
}

const getArtistType = (nationality = '') =>
  nationality.toLowerCase().includes('india') ? 'indian' : 'international'

function capitalize(str) {
  if (!str) return ''
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()
}

export function useDashboardData() {

  // ── KPIs ─────────────────────────────────────────────────────────────────
  const { data: kpisData, isLoading: kpisLoading, error: kpisError } = useQuery({
    queryKey: ['dashboard', 'kpis'],
    queryFn: async () => {
      const response = await client.get('/dashboard/kpis')
      return response.data?.data || {}
    },
    enabled: isAuthenticated(),
    staleTime: 5 * 60 * 1000,
  })

  // ── Top artists pool ──────────────────────────────────────────────────────
  const { data: topArtistsData, isLoading: topArtistsLoading } = useQuery({
    queryKey: ['dashboard', 'top-artists'],
    queryFn: async () => {
      const response = await client.get('/dashboard/top-artists?limit=100')
      return getArrayPayload(response.data, 'artists')
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!kpisData && isAuthenticated(),
  })

  // ── Platform growth trends ────────────────────────────────────────────────
  // Backend returns: [{ date: 'Jan 2025', followers: 12345678 }, ...]
  // Spotify: backend maps streams → followers key automatically
  const { data: instagramTrends, isLoading: instagramLoading } = useQuery({
    queryKey: ['analytics', 'trends', 'instagram'],
    queryFn: async () => {
      const response = await client.get('/analytics/trends?platform=instagram&months=12')
      return getArrayPayload(response.data, 'trends')
    },
    staleTime: 10 * 60 * 1000,
    enabled: !!kpisData && isAuthenticated(),
  })

  const { data: youtubeTrends, isLoading: youtubeLoading } = useQuery({
    queryKey: ['analytics', 'trends', 'youtube'],
    queryFn: async () => {
      const response = await client.get('/analytics/trends?platform=youtube&months=12')
      return getArrayPayload(response.data, 'trends')
    },
    staleTime: 10 * 60 * 1000,
    enabled: !!kpisData && isAuthenticated(),
  })

  const { data: spotifyTrends, isLoading: spotifyLoading } = useQuery({
    queryKey: ['analytics', 'trends', 'spotify'],
    queryFn: async () => {
      const response = await client.get('/analytics/trends?platform=spotify&months=12')
      return getArrayPayload(response.data, 'trends')
    },
    staleTime: 10 * 60 * 1000,
    enabled: !!kpisData && isAuthenticated(),
  })

  // ── Genre data ────────────────────────────────────────────────────────────
  const { data: genresData, isLoading: genresLoading } = useQuery({
    queryKey: ['analytics', 'genres'],
    queryFn: async () => {
      const response = await client.get('/analytics/genres')
      return getArrayPayload(response.data, 'genres')
    },
    staleTime: 10 * 60 * 1000,
    enabled: !!kpisData && isAuthenticated(),
  })

  // ── All artists (for type mapping) ───────────────────────────────────────
  const { data: allArtistsRaw } = useQuery({
    queryKey: ['artists', 'all-for-dashboard'],
    queryFn: async () => {
      const response = await client.get('/artists?limit=1000')
      return getArrayPayload(response.data, 'artists')
    },
    staleTime: 10 * 60 * 1000,
    enabled: !!kpisData && isAuthenticated(),
  })

  // ── All concerts ──────────────────────────────────────────────────────────
  const { data: allConcertsRaw } = useQuery({
    queryKey: ['concerts', 'all-for-dashboard'],
    queryFn: async () => {
      const response = await client.get('/concerts?limit=1000')
      return getArrayPayload(response.data, 'concerts')
    },
    staleTime: 10 * 60 * 1000,
    enabled: !!kpisData && isAuthenticated(),
  })

  // ── Demographics ──────────────────────────────────────────────────────────
  const { data: ageDemographicsData, isLoading: ageLoading } = useQuery({
    queryKey: ['analytics', 'demographics', 'age'],
    queryFn: async () => {
      const response = await client.get('/analytics/demographics/age')
      return getArrayPayload(response.data, 'breakdown')
    },
    staleTime: 15 * 60 * 1000,
    enabled: !!kpisData && isAuthenticated(),
  })

  const { data: genderDemographicsData, isLoading: genderLoading } = useQuery({
    queryKey: ['analytics', 'demographics', 'gender'],
    queryFn: async () => {
      const response = await client.get('/analytics/demographics/gender')
      return getArrayPayload(response.data, 'breakdown')
    },
    staleTime: 15 * 60 * 1000,
    enabled: !!kpisData && isAuthenticated(),
  })

  const isLoading = kpisLoading || topArtistsLoading || instagramLoading ||
    youtubeLoading || spotifyLoading || genresLoading || ageLoading || genderLoading
  const error = kpisError

  // ── Artist type map ───────────────────────────────────────────────────────
  const artistTypeById = useMemo(() => {
    if (!allArtistsRaw) return {}
    const map = {}
    allArtistsRaw.forEach(artist => {
      map[artist.id] = getArtistType(artist.nationality || '')
    })
    return map
  }, [allArtistsRaw])

  // ── KPI transform ─────────────────────────────────────────────────────────
  const rawKpis = kpisData?.kpis || kpisData
  const kpis = rawKpis ? {
    totalArtists:       rawKpis.totalArtists || 0,
    totalConcerts:      rawKpis.totalConcerts || 0,
    ticketsSoldYTD:     rawKpis.ticketsSoldYTD || 0,
    revenueYTD:         rawKpis.revenueYTD || 0,
    avgRoG:             rawKpis.avgRoGDaily ? parseFloat(rawKpis.avgRoGDaily.toFixed(2)) : 0,
    topArtistByStreams:  rawKpis.topArtistByStreams || null,
  } : null

  // ── Top artists transform ─────────────────────────────────────────────────
  const transformedArtistsPool = useMemo(() => {
    if (!topArtistsData) return []
    return topArtistsData.map(item => {
      const artist = item.artist
      if (!artist) return null

      const nationality = artist.nationality || ''
      const genres = artist.genres || []
      const type = artistTypeById[artist.id] || getArtistType(nationality)
      const genre = genres.length > 0 ? genres[0]?.genre?.name || 'Unknown' : 'Unknown'

      const followers = { instagram: 0, youtube: 0, spotify: 0, facebook: 0, applemusic: 0 }
      const rog       = { instagram: 0, youtube: 0, spotify: 0, facebook: 0, applemusic: 0 }

      if (item.platforms && Array.isArray(item.platforms)) {
        item.platforms.forEach(p => {
          const key = String(p.platform || '').toLowerCase()
          if (key in followers) followers[key] = p.followers || 0
        })
      }

      const totalFollowers = Number(item.totalFollowers || 0)
      const popularity     = Math.min(100, Math.round(totalFollowers / 1_000_000))
      const monthlyStreams  = Math.round(totalFollowers * 0.001)
      const photo = artist.photoUrl ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(artist.artistName)}&background=6366F1&color=fff`

      return {
        id: artist.id, name: artist.artistName, type, genre, nationality,
        age: 0, totalConcerts: 0, popularity, monthlyStreams, followers, rog, photo, totalFollowers,
      }
    }).filter(Boolean)
  }, [topArtistsData, artistTypeById])

  const artistConcertCounts = useMemo(() => {
    if (!allConcertsRaw) return {}
    const counts = {}
    allConcertsRaw.forEach(concert => {
      counts[concert.artistId] = (counts[concert.artistId] || 0) + 1
    })
    return counts
  }, [allConcertsRaw])

  const topArtistsWithConcerts = useMemo(() => {
    if (!transformedArtistsPool.length) return []
    return transformedArtistsPool.map(artist => ({
      ...artist,
      totalConcerts: artistConcertCounts[artist.id] || 0,
    }))
  }, [transformedArtistsPool, artistConcertCounts])

  // ── Demographics transforms ───────────────────────────────────────────────
  const ageData = useMemo(() => {
    if (!ageDemographicsData) return []
    return ageDemographicsData.map(item => ({
      name:  capitalize(item.dimensionValue),
      value: Math.round(item._avg?.percentage || 0),
    }))
  }, [ageDemographicsData])

  const genderData = useMemo(() => {
    if (!genderDemographicsData) return []
    return genderDemographicsData.map(item => ({
      name:  capitalize(item.dimensionValue),
      value: Math.round(item._avg?.percentage || 0),
    }))
  }, [genderDemographicsData])

  // ── Follower trends ───────────────────────────────────────────────────────
  // Merges three platform arrays into: [{ date: 'Jan 2025', instagram, youtube, spotify }]
  // Keyed by full 'Mon YYYY' so months across different years never collide.
  const followerTrends = useMemo(() => {
    const map = {}

    const merge = (data, platform) => {
      if (!Array.isArray(data)) return
      data.forEach((row, i) => {
        const key = row.date                            // e.g. "Jan 2025"
        if (!map[key]) {
          map[key] = { date: key, instagram: 0, youtube: 0, spotify: 0, _order: i }
        }
        map[key][platform] = row.followers || 0
      })
    }

    merge(instagramTrends || [], 'instagram')
    merge(youtubeTrends   || [], 'youtube')
    merge(spotifyTrends   || [], 'spotify')

    return Object.values(map)
      .sort((a, b) => new Date(a.date + ' 1').getTime() - new Date(b.date + ' 1').getTime())
      .map(({ _order, ...rest }) => rest)              // strip internal sort key
  }, [instagramTrends, youtubeTrends, spotifyTrends])

  // ── Genre transform ───────────────────────────────────────────────────────
  const genreData = useMemo(() => {
    if (!genresData) return []
    return genresData.map(g => ({
      genre:   g.genreName,
      streams: g.totalFollowers,
    }))
  }, [genresData])

  // ── Concert transform ─────────────────────────────────────────────────────
  const transformedConcerts = useMemo(() => {
    if (!allConcertsRaw) return []
    return allConcertsRaw
      .map(c => {
        const artist = c.artist?.artistName || c.artistName || 'Unknown Artist'
        const venue  = c.venueName || ''
        const eventName = c.concertName || c.name || venue || c.city || 'Live Event'
        return {
          id:               c.id,
          artistId:         c.artistId,
          artist,
          name:             eventName,
          date:             new Date(c.concertDate),
          city:             c.city,
          state:            c.state,
          country:          c.country,
          venue,
          capacity:         Number(c.capacity || 0),
          ticketsSold:      Number(c.ticketsSold || 0),
          avgTicketPrice:   Number(c.avgTicketPrice || 0),
          totalRevenue:     Number(c.totalRevenue || 0),
          lat:              Number(c.latitude || 0),
          lng:              Number(c.longitude || 0),
          sponsors:         [],
        }
      })
      .sort((a, b) => b.date.getTime() - a.date.getTime())  // recent-first
  }, [allConcertsRaw])

  // ── Return ────────────────────────────────────────────────────────────────
  return {
    data: {
      kpis,
      topArtistsPool:  topArtistsWithConcerts,
      allConcerts:     transformedConcerts,
      allArtists:      allArtistsRaw,
      followerTrends,
      genres:          genreData,
      ageData,
      genderData,
      artistIdToType:  artistTypeById,
    },
    isLoading,
    error,
    isKpisLoading:         kpisLoading,
    isTopArtistsLoading:   topArtistsLoading,
    isConcertsLoading:     allConcertsRaw === undefined,
    isTrendsLoading:       instagramLoading || youtubeLoading || spotifyLoading,
    isGenresLoading:       genresLoading,
    isDemographicsLoading: ageLoading || genderLoading,
  }
}
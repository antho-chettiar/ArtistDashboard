import { useQuery } from '@tanstack/react-query'
import client from '../api/client'

export function useArtists({ search = '', genre = '', limit = 100 } = {}) {
  const params = new URLSearchParams()
  if (search) params.append('search', search)
  if (genre && genre !== 'All') params.append('genre', genre)
  params.append('limit', limit.toString())

  const { data: artistsData, isLoading: artistsLoading, error: artistsError } = useQuery({
    queryKey: ['artists', search, genre],
    queryFn: async () => {
      const response = await client.get(`/artists?${params.toString()}`)
      return response.data.data?.artists || response.data.artists || []
    },
    staleTime: 2 * 60 * 1000,
  })

  const { data: concertsData, isLoading: concertsLoading } = useQuery({
    queryKey: ['concerts', 'all'],
    queryFn: async () => {
      const response = await client.get('/concerts?limit=1000')
      return response.data.data.concerts
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!artistsData,
  })

  // Canonical popularity for the whole cohort in ONE cached call (never a
  // frontend formula, never the stale Artist.popularity column). Keeps the card
  // consistent with the Analysis page, which also uses the Python engine.
  const { data: popularityData } = useQuery({
    queryKey: ['popularity', 'all'],
    queryFn: async () => {
      const response = await client.get('/analytics/ml/popularity/all')
      return response.data?.data || []
    },
    staleTime: 10 * 60 * 1000,
    retry: false,
  })

  const popularityById = {}
  ;(Array.isArray(popularityData) ? popularityData : []).forEach(p => {
    if (p?.artist_id != null) popularityById[p.artist_id] = p.popularity_score
  })

  const transformedData = artistsData?.map(artist => {
    const artistConcerts = concertsData?.filter(c => c.artistId === artist.id) || []
    const totalConcerts = artistConcerts.length

    const type = artist.nationality?.toLowerCase().includes('india') ? 'indian' : 'international'

    // const genre = artist.genres?.[0]?.genre?.name || 'Unknown'
    const genre = artist.genres?.[0]?.genre?.name

    const metricsByPlatform = (artist.platformMetrics || []).reduce((acc, m) => {
      const p = m.platform?.toLowerCase()
      if (!p) return acc
      if (!acc[p] || new Date(m.metricDate) > new Date(acc[p].metricDate)) {
        acc[p] = { followers: Number(m.followers || 0), rogDaily: Number(m.rogDaily || 0), rogWeekly: Number(m.rogWeekly || 0), rogMonthly: Number(m.rogMonthly || 0), metricDate: m.metricDate }
      }
      return acc
    }, {})

    // Keyed strictly by platform so totalFollowers/topPlatform math (in Artists.jsx)
    // isn't double-counted by aliases of the same Spotify number.
    const followers = {
      instagram: Number(artist.instagramFollowers || metricsByPlatform.instagram?.followers || 0),
      youtube: Number(artist.youtubeSubscribers || metricsByPlatform.youtube?.followers || 0),
      spotify: Number(artist.spotifyFollowers || 0),
      facebook: Number(artist.facebookFollowers || metricsByPlatform.facebook?.followers || 0),
    }

    const spotifyMonthlyListeners = Number(artist.spotifyMonthlyListeners || 0)

    const rog = {
      instagram: Number(metricsByPlatform.instagram?.rogDaily || 0),
      youtube: Number(metricsByPlatform.youtube?.rogDaily || 0),
      spotify: Number(metricsByPlatform.spotify?.rogDaily || 0),
      facebook: Number(metricsByPlatform.facebook?.rogDaily || 0),
      // applemusic: Number(metricsByPlatform.applemusic?.rogDaily || 0),
    }

    return {
      id: artist.id,
      name: artist.artistName || artist.name || 'Unknown',
      type,
      genre,
      nationality: artist.nationality || 'Unknown',
      age: artist.age || 'N/A',
      totalConcerts,
      // Canonical Python popularity (null → "—"). Never the NULL Artist.popularity → 0.
      popularity: popularityById[artist.id] ?? null,
      monthlyStreams: artist.monthlyStreams || 0,
      followers,
      spotifyMonthlyListeners,
      rog,
      photo: artist.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(artist.artistName || artist.name || 'Unknown')}&background=6366F1&color=fff`,
    }
  })

  return {
    data: transformedData,
    isLoading: artistsLoading,
    error: artistsError,
    concerts: concertsData || [],
    isConcertsLoading: concertsLoading,
  }
}
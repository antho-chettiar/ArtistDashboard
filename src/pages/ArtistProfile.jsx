import { useParams, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, MapPin, Music, TrendingUp, DollarSign, Users, Ticket } from 'lucide-react'
import PageHeader from '../components/ui/PageHeader'
import RoGBadge from '../components/ui/RoGBadge'
import ChartContainer from '../components/charts/ChartContainer'
import LineChart from '../components/charts/LineChart'
import PieChart from '../components/charts/PieChart'
import EmptyState from '../components/ui/EmptyState'
import client from '../api/client'
import { formatNumber, formatCurrency, formatDate } from '../utils/formatters'

const TABS = ['Platforms', 'Growth Trends', 'Concerts', 'Demographics']

const PLATFORM_META = {
  instagram: { label: 'Instagram', color: '#E1306C' },
  youtube: { label: 'YouTube', color: '#FF0000' },
  spotify: { label: 'Spotify', color: '#1DB954' },
}

const TREND_LINES = [
  { key: 'instagram', label: 'Instagram', color: '#E1306C' },
  { key: 'youtube', label: 'YouTube', color: '#FF0000' },
  { key: 'spotify', label: 'Spotify', color: '#1DB954' },
]

function ArtistProfile() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [activeTab, setTab] = useState('Platforms')

  // Fetch artist details
  const { data: artistData, isLoading: artistLoading, error: artistError } = useQuery({
    queryKey: ['artist', id],
    queryFn: async () => {
      const response = await client.get(`/artists/${id}`)
      return response.data.data.artist
    },
    staleTime: 2 * 60 * 1000,
    enabled: !!id,
  })

  // Fetch all concerts for this artist
  const { data: concertsData, isLoading: concertsLoading } = useQuery({
    queryKey: ['artistConcerts', id],
    queryFn: async () => {
      const response = await client.get(`/artists/${id}/concerts`)
      return response.data.data.concerts
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!id,
  })

  // Fetch all platform metrics for trends (full history)
  const { data: allMetricsData } = useQuery({
    queryKey: ['artistAllMetrics', id],
    queryFn: async () => {
      const response = await client.get(`/artists/${id}/metrics`)
      return response.data.data.metrics
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!id,
  })

  // Fetch demographics (age)
  const { data: ageDemographics } = useQuery({
    queryKey: ['artistDemographicsAge', id],
    queryFn: async () => {
      const response = await client.get(`/artists/${id}/demographics?dimension=age`)
      return response.data.data.demographics
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!id,
  })

  // Fetch demographics (gender)
  const { data: genderDemographics } = useQuery({
    queryKey: ['artistDemographicsGender', id],
    queryFn: async () => {
      const response = await client.get(`/artists/${id}/demographics?dimension=gender`)
      return response.data.data.demographics
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!id,
  })

  const isLoading = artistLoading || concertsLoading
  const error = artistError

  // Show loading state
  if (isLoading) {
    return (
      <div className="relative">
        <div className="fixed top-20 right-20 w-96 h-96 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.07), transparent 70%)', filter: 'blur(40px)' }} />
        <button onClick={() => navigate('/artists')}
          className="flex items-center gap-2 text-sm mb-5 transition-all duration-200 hover:gap-3"
          style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft size={15} /> Back to Artists
        </button>
        <div className="glass-card p-6 mb-6 animate-pulse">
          <div className="flex items-start gap-6">
            <div className="w-24 h-24 rounded-2xl bg-gray-200 dark:bg-gray-700" />
            <div className="flex-1">
              <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-3" />
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/4 mb-4" />
              <div className="grid grid-cols-4 gap-3">
                {[1, 2, 3, 4].map(item => (
                  <div key={item} className="h-16 bg-gray-200 dark:bg-gray-700 rounded-xl" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Show error state
  if (error || !artistData) {
    return (
      <div className="relative">
        <div className="fixed top-20 right-20 w-96 h-96 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.07), transparent 70%)', filter: 'blur(40px)' }} />
        <button onClick={() => navigate('/artists')}
          className="flex items-center gap-2 text-sm mb-5 transition-all duration-200 hover:gap-3"
          style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft size={15} /> Back to Artists
        </button>
        <EmptyState
          title="Artist not found"
          subtitle={error?.response?.data?.message || 'Failed to load artist data'}
          action={{
            label: 'Go Back',
            onClick: () => navigate('/artists')
          }}
        />
      </div>
    )
  }

  // Transform artist data
  const artist = artistData
  const concerts = concertsData || []

  // Calculate genre
  const genre = artist.genres?.[0]?.genre?.name || 'Unknown'

  // Aggregate platform metrics to get latest values per platform
  const followerMap = new Map()
  const rogMap = new Map()

  // Use allMetricsData if available (full history), else fallback to artist.platformMetrics
  const allMetrics = allMetricsData || artist.platformMetrics || []

  allMetrics.forEach((metric) => {
    const platform = (metric.platform || '').toLowerCase()
    const followers = Number(metric.followers) || 0
    const rog = Number(metric.rogWeekly) || 0 // Use weekly RoG

    if (!followerMap.has(platform) || followerMap.get(platform) < followers) {
      followerMap.set(platform, followers)
    }
    // For RoG, take the first (metrics should be sorted by date desc)
    if (!rogMap.has(platform)) {
      rogMap.set(platform, rog)
    }
  })

  const followers = {
    instagram: followerMap.get('instagram') || Number(artist.instagramFollowers) || 0,
    youtube: followerMap.get('youtube') || Number(artist.youtubeSubscribers) || 0,
    spotify: followerMap.get('spotify') || Number(artist.spotifyFollowers) || 0,
    spotifyMonthlyListeners: followerMap.get('spotify') || Number(artist.spotifyMonthlyListeners) || 0,
    facebook: followerMap.get('facebook') || Number(artist.facebookFollowers) || 0,
    applemusic: followerMap.get('applemusic') || 0,
  }

  const rog = {
    instagram: rogMap.get('instagram') || 0,
    youtube: rogMap.get('youtube') || 0,
    spotify: rogMap.get('spotify') || 0,
    facebook: rogMap.get('facebook') || 0,
    applemusic: rogMap.get('applemusic') || 0,
  }

  // Calculate totals
  const totalFollowers = Object.values(followers).reduce((a, b) => a + b, 0)
  const avgRoG = Object.values(rog).reduce((a, b) => a + b, 0) / Object.keys(rog).length
  const totalRevenue = concerts.reduce((a, c) => a + (c.totalRevenue || 0), 0)
  const totalTickets = concerts.reduce((a, c) => a + (c.ticketsSold || 0), 0)

  // Transform concert data to match UI format
  const transformedConcerts = concerts.map(c => ({
    id: c.id,
    name: c.concertName,
    date: c.concertDate,
    city: c.city,
    venue: c.venueName,
    ticketsSold: c.ticketsSold,
    totalRevenue: c.totalRevenue,
    country: c.country,
    avgTicketPrice: c.avgTicketPrice,
  }))

  // Transform trends: aggregate metrics by date and platform
  const trendMap = new Map()

  allMetrics?.forEach((metric) => {
    const dateStr = new Date(metric.metricDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    const platform = (metric.platform || '').toLowerCase()
    const followers = Number(metric.followers) || 0

    if (!trendMap.has(dateStr)) {
      trendMap.set(dateStr, { date: dateStr, instagram: 0, youtube: 0, spotify: 0 })
    }

    const entry = trendMap.get(dateStr)
    if (platform === 'instagram') entry.instagram = followers
    if (platform === 'youtube') entry.youtube = followers
    if (platform === 'spotify') entry.spotify = followers
  })

  const trendData = Array.from(trendMap.values())
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  // Transform demographics for pie charts (group by dimensionValue and sum absoluteCount)
  const groupDemographics = (data) => {
    const map = new Map()
    data?.forEach(d => {
      const key = d.dimensionValue || 'Unknown'
      const count = d.absoluteCount != null ? d.absoluteCount : 0
      map.set(key, (map.get(key) || 0) + count)
    })
    return Array.from(map.entries()).map(([name, value]) => ({ name, value }))
  }

  const ageData = groupDemographics(ageDemographics)
  const genderData = groupDemographics(genderDemographics)

  return (
    <div className="relative">
      {/* Ambient glow */}
      <div className="fixed top-20 right-20 w-96 h-96 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.07), transparent 70%)', filter: 'blur(40px)' }} />

      {/* Back */}
      <button onClick={() => navigate('/artists')}
        className="flex items-center gap-2 text-sm mb-5 transition-all duration-200 hover:gap-3"
        style={{ color: 'var(--text-muted)' }}>
        <ArrowLeft size={15} /> Back to Artists
      </button>

      {/* Hero Card */}
      <div className="glass-card p-6 mb-6 animate-fade-up relative overflow-hidden">
        {/* Background gradient */}
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(circle at 100% 0%, rgba(99,102,241,0.06), transparent 60%)' }} />

        <div className="flex flex-col sm:flex-row items-start gap-6 relative z-10">
          {/* Avatar */}
          <div className="relative flex-shrink-0">
            <img src={artist.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(artist.artistName || artist.name || 'Unknown')}&background=6366F1&color=fff`} alt={artist.artistName || artist.name}
              className="w-24 h-24 rounded-2xl object-cover"
              style={{ border: '2px solid var(--border-strong)', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }} />
            <div className="absolute -bottom-2 -right-2 px-2 py-0.5 rounded-lg text-xs font-bold"
              style={{ background: 'linear-gradient(135deg, #6366F1, #818CF8)', color: '#fff' }}>
              {genre.split('/')[0]}
            </div>
          </div>

          {/* Info */}
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <h1 className="font-display font-bold text-3xl" style={{ color: 'var(--text-primary)' }}>
                {artist.artistName || artist.name}
              </h1>
              {/* <RoGBadge value={avgRoG} /> */}
            </div>
            <div className="flex items-center gap-4 text-sm mb-5" style={{ color: 'var(--text-muted)' }}>
              <div className="flex items-center gap-1.5">
                <MapPin size={13} style={{ color: 'var(--accent-indigo)' }} />
                {artist.nationality}
              </div>
              <div className="flex items-center gap-1.5">
                <Music size={13} style={{ color: 'var(--accent-gold)' }} />
                {concerts.length} concerts on record
              </div>
            </div>

            {/* KPI Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Spotify Monthly Listeners', value: formatNumber(followers.spotifyMonthlyListeners), icon: Users, color: 'var(--accent-indigo)' },
                { label: 'Top Platform', value: Object.entries(followers).sort((a, b) => b[1] - a[1])[0][0] || 'N/A', icon: TrendingUp, color: 'var(--accent-gold)' },
                { label: 'Total Revenue', value: formatCurrency(totalRevenue), icon: DollarSign, color: 'var(--accent-green)' },
                { label: 'Tickets Sold', value: formatNumber(totalTickets), icon: Ticket, color: 'var(--accent-red)' },
              ].map((stat, i) => (
                <div key={i} className="rounded-xl p-3"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <stat.icon size={12} style={{ color: stat.color }} />
                    <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                      {stat.label}
                    </p>
                  </div>
                  <p className="font-display font-bold text-base capitalize" style={{ color: 'var(--text-primary)' }}>
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-2xl mb-6 w-fit"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        {TABS.map(tab => (
          <button key={tab} onClick={() => setTab(tab)}
            className="px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200"
            style={activeTab === tab ? {
              background: 'linear-gradient(135deg, #6366F1, #818CF8)',
              color: '#fff',
              boxShadow: '0 4px 12px rgba(99,102,241,0.3)'
            } : {
              color: 'var(--text-muted)',
              background: 'transparent'
            }}>
            {tab}
          </button>
        ))}
      </div>

      {/* ── Tab: Platforms ── */}
      {activeTab === 'Platforms' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Object.entries(followers).map(([platform, count], i) => {
            const meta = PLATFORM_META[platform]
            if (!meta) return null
            return (
              <div key={platform} className="glass-card p-5 animate-fade-up"
                style={{ animationDelay: `${i * 80}ms`, animationFillMode: 'both', opacity: 0, borderTop: `3px solid ${meta.color}` }}>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-sm font-bold" style={{ color: meta.color }}>{meta.label}</span>
                  <RoGBadge value={rog[platform]} />
                </div>
                <p className="font-display font-bold text-3xl mb-1" style={{ color: 'var(--text-primary)' }}>
                  {formatNumber(count)}
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Followers</p>

                {/* Mini progress bar */}
                <div className="mt-4 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                  <div className="h-full rounded-full"
                    style={{ width: `${totalFollowers > 0 ? (count / totalFollowers) * 100 : 0}%`, background: meta.color }} />
                </div>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {totalFollowers > 0 ? ((count / totalFollowers) * 100).toFixed(1) : 0}% of total
                </p>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Tab: Growth Trends ── */}
      {activeTab === 'Growth Trends' && (
        <ChartContainer
          title="Follower Growth — All Platforms"
          subtitle="Instagram · YouTube · Spotify monthly trend"
        >
          <div className="flex gap-2 mb-4 flex-wrap">
            {TREND_LINES.map(p => (
              <span key={p.key}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium"
                style={{ background: `${p.color}18`, color: p.color, border: `1px solid ${p.color}30` }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.color }} />
                {p.label}
              </span>
            ))}
          </div>
          <LineChart data={trendData} xKey="date" lines={TREND_LINES} height={320} />
        </ChartContainer>
      )}

      {/* ── Tab: Concerts ── */}
      {activeTab === 'Concerts' && (
        transformedConcerts.length === 0 ? (
          <EmptyState title="No concerts found" subtitle="No concert data available for this artist." />
        ) : (
          <div className="glass-card overflow-hidden animate-fade-up">
            <table className="w-full text-sm">
              <thead style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>
                <tr>
                  {['Concert', 'Date', 'City', 'Venue', 'Tickets', 'Revenue'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-widest"
                      style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {transformedConcerts.map((c) => (
                  <tr key={c.id}
                    style={{ borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td className="px-4 py-3 font-semibold" style={{ color: 'var(--text-primary)' }}>{c.name}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{formatDate(c.date)}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{c.city}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{c.venue}</td>
                    <td className="px-4 py-3 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{formatNumber(c.ticketsSold)}</td>
                    <td className="px-4 py-3 font-bold font-display text-sm" style={{ color: 'var(--accent-gold)' }}>{formatCurrency(c.totalRevenue, { country: c.country })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* ── Tab: Demographics ── */}
      {activeTab === 'Demographics' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ChartContainer title="Audience Age Distribution" subtitle="% by age group">
            <PieChart data={ageData.length > 0 ? ageData : [{ name: 'No data', value: 1 }]} nameKey="name" valueKey="value" innerRadius={55} height={260} />
          </ChartContainer>
          <ChartContainer title="Gender Distribution" subtitle="% by gender">
            <PieChart data={genderData.length > 0 ? genderData : [{ name: 'No data', value: 1 }]} nameKey="name" valueKey="value" innerRadius={55} height={260} />
          </ChartContainer>
        </div>
      )}
    </div>
  )
}

export default ArtistProfile

import { useState, useMemo } from 'react'
import {
  Users, Music2, Ticket, DollarSign, TrendingUp,
} from 'lucide-react'
import PageHeader from '../components/ui/PageHeader'
import KpiCard from '../components/ui/KpiCard'
import ChartContainer from '../components/charts/ChartContainer'
import LineChart from '../components/charts/LineChart'
import BarChart from '../components/charts/BarChart'
import PieChart from '../components/charts/PieChart'
import RoGBadge from '../components/ui/RoGBadge'
import useFilterStore from '../store/useFilterStore'
import { useDashboardData } from '../hooks/useDashboardData'
import { formatNumber, formatCurrency, formatDate } from '../utils/formatters'

const TIME_FILTERS = [
  { label: '6M',  months: 6  },
  { label: '12M', months: 12 },
  { label: '18M', months: 18 },
  { label: '24M', months: 24 },
  { label: '36M', months: 36 },
]

const TREND_LINES = [
  { key: 'instagram', label: 'Instagram', color: '#E1306C' },
  { key: 'youtube',   label: 'YouTube',   color: '#FF0000' },
  { key: 'spotify',   label: 'Spotify',   color: '#1DB954' },
]

function Dashboard() {
  const { artistType } = useFilterStore()
  const [timeFilter, setTimeFilter] = useState(12)

  const { data, isLoading, error } = useDashboardData()

  // if (isLoading) {
  //   return (
  //     <div className="flex items-center justify-center h-64">
  //       <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading dashboard...</div>
  //     </div>
  //   )
  // }

  // if (error) {
  //   return (
  //     <div className="p-4 rounded-xl border" style={{ borderColor: 'var(--border)', background: 'rgba(239,68,68,0.1)' }}>
  //       <p className="text-sm" style={{ color: '#EF4444' }}>Failed to load dashboard data: {error.message}</p>
  //     </div>
  //   )
  // }

 // if (!data) return null

  // const { 
  // kpis,
  // topArtistsPool,
  // allConcerts,
  // allArtists,
  // followerTrends,
  // genres: genreData,
  // ageData,
  // genderData,
  // artistIdToType,
  // } = data || {}
      const {
        kpis = {},
        topArtistsPool = [],
        allConcerts = [],
        allArtists = [],
        followerTrends = [],
        genres: genreData = [],
        ageData = [],
        genderData = [],
        artistIdToType = {},
      } = data || {}

  const safeTrends = followerTrends || []

  const marketLabel = artistType === 'indian'
    ? '🇮🇳 Indian'
    : artistType === 'international'
    ? '🌍 International'
    : ''

  // Total Artists count by type
  const totalArtistsCount = useMemo(() => {
    if (!allArtists) return 0
    if (!artistType) return allArtists.length
    return allArtists.filter(a => artistIdToType[a.id] === artistType).length
  }, [allArtists, artistIdToType, artistType])

  // Filter top artists pool by type (for top list)
  const filteredArtists = useMemo(() => {
    if (!topArtistsPool.length) return []
    return artistType ? topArtistsPool.filter(a => a.type === artistType) : topArtistsPool
  }, [topArtistsPool, artistType])

  // Apply time filter and get top 10
  const topArtistsByPopularity = useMemo(() => {
    // Real composite popularity only — no time-scaling (there is no time-scoped
    // popularity endpoint yet) and no fabricated streams. Unscored artists
    // (popularity === null) sort last and render as "—".
    return [...filteredArtists]
      .map(a => ({ ...a, displayPopularity: a.popularity }))
      .sort((a, b) => (b.displayPopularity ?? -1) - (a.displayPopularity ?? -1))
      .slice(0, 10)
  }, [filteredArtists])

  // Filter all concerts by artist type
  const filteredConcerts = useMemo(() => {
    if (!allConcerts) return []
    return artistType
      ? allConcerts.filter(c => artistIdToType[c.artistId] === artistType)
      : allConcerts
  }, [allConcerts, artistIdToType, artistType])

  // Show only the latest 15 concerts in the dashboard list
  const recentConcerts = useMemo(() => filteredConcerts.slice(0, 10), [filteredConcerts])

  // Count concerts per city (real event counts). Revenue is NOT used here —
  // the imported historical concerts have unknown/NULL revenue, so summing it
  // would show fake zeros. Kept client-side over filteredConcerts so it still
  // reacts to the artist-type filter (the /concerts/cities endpoint returns a
  // global aggregate and cannot filter by artist type).
  const concertsByCity = useMemo(() => {
    if (!filteredConcerts.length) return []
    const grouped = filteredConcerts.reduce((acc, c) => {
      if (!c.city) return acc
      if (!acc[c.city]) acc[c.city] = { name: c.city, count: 0 }
      acc[c.city].count += 1
      return acc
    }, {})
    return Object.values(grouped).sort((a, b) => b.count - a.count)
  }, [filteredConcerts])

  // Normalize chart data coming from backend so charts receive numeric values
  const ageChartData = useMemo(() => (ageData || []).map(d => ({
    name: d.name ?? d.label ?? d.age ?? 'Unknown',
    value: Number(d.value ?? d.count ?? d.percentage ?? 0)
  })), [ageData])

  const genderChartData = useMemo(() => (genderData || []).map(d => ({
    name: d.name ?? d.label ?? d.gender ?? 'Unknown',
    value: Number(d.value ?? d.count ?? d.percentage ?? 0)
  })), [genderData])

  const genreChartData = useMemo(() => (genreData || []).map(d => ({
    genre: d.genre ?? d.name ?? 'Unknown',
    streams: Number(d.streams ?? d.value ?? d.count ?? 0)
  })), [genreData])

  const KPI_CONFIG = [
    {
      title: 'Total Artists',
      value: totalArtistsCount,
      subtitle: `${marketLabel} artists`,
      //rog: 8.3,
      icon: Users,
      accentColor: '#818CF8',
      delay: 0,
    },
    {
      title: 'Total Concerts',
      value: filteredConcerts.length,
      subtitle: 'All time',
      //rog: 12.5,
      icon: Music2,
      accentColor: '#FBBF24',
      delay: 80,
    },
    {
      // Unknown ≠ zero: imported concerts carry no ticket data, so a 0 here means
      // "not available", not real zero sales. Show a dash rather than "0".
      title: 'Tickets Sold YTD',
      value: (kpis?.ticketsSoldYTD || 0) > 0 ? formatNumber(kpis.ticketsSoldYTD) : '—',
      subtitle: (kpis?.ticketsSoldYTD || 0) > 0 ? undefined : 'Not available',
      icon: Ticket,
      accentColor: '#34D399',
      delay: 160,
    },
    {
      // Unknown ≠ zero: revenue is NULL on the imported concerts. Show a dash.
      title: 'Revenue YTD',
      value: (kpis?.revenueYTD || 0) > 0 ? formatCurrency(kpis.revenueYTD) : '—',
      subtitle: (kpis?.revenueYTD || 0) > 0 ? undefined : 'Not available',
      icon: DollarSign,
      accentColor: '#F87171',
      delay: 240,
    },
    // {
    //   title: 'Avg Social RoG',
    //   value: `${kpis?.avgRoG || 0}%`,
    //   subtitle: 'All platforms',
    //   rog: kpis?.avgRoG || 0,
    //   icon: TrendingUp,
    //   accentColor: '#A78BFA',
    //   delay: 320,
    // },
  ]

  return (
    <div className="relative">


      {isLoading && (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading dashboard...
        </div>
      </div>
    )}

    {error && (
      <div className="p-4 rounded-xl border">
        <p style={{ color: '#EF4444' }}>
          Failed: {error.message}
        </p>
      </div>
    )}

      {/* Ambient glows */}
      <div className="fixed top-20 left-72 w-96 h-96 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.08), transparent 70%)', filter: 'blur(40px)' }} />
      <div className="fixed bottom-20 right-20 w-80 h-80 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(245,158,11,0.06), transparent 70%)', filter: 'blur(40px)' }} />

      <PageHeader
        title="Dashboard"
        subtitle={`${marketLabel} Artist Performance & Concert Analytics`}
      />

      {/* ── KPI Strip ── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mb-6">
        {KPI_CONFIG.map((kpi, i) => (
          <KpiCard key={i} {...kpi} />
        ))}
      </div>

      {/* ── Row 1: Trend Chart + Top 10 Artists ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">

        {/* Multi-line trend */}
        <ChartContainer
          title="Platform Growth Trends"
          subtitle="Instagram · YouTube · Spotify - monthly followers / subscribers / streams over time"
          delay={100}
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
          <LineChart data={safeTrends} xKey="date" lines={TREND_LINES} height={260}
            margin={{ top: 10, right: 48, left: 48, bottom: 10 }}
            yDomain={[1000000, 450000000]} />
        </ChartContainer>

        {/* Top 10 Artists */}
        <div className="glass-card p-5 animate-fade-up"
          style={{ animationDelay: '150ms', animationFillMode: 'both', opacity: 0 }}>

          {/* Header + Time Filter */}
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                🏆 Top {marketLabel} Artists
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Ranked by popularity score
              </p>
            </div>
            {/* Time filter pills */}
            <div className="flex gap-1 p-1 rounded-xl"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              {TIME_FILTERS.map(tf => (
                <button key={tf.months}
                  onClick={() => setTimeFilter(tf.months)}
                  className="text-xs px-2 py-1 rounded-lg font-semibold transition-all duration-200"
                  style={timeFilter === tf.months ? {
                    background: 'linear-gradient(135deg, #6366F1, #818CF8)',
                    color: '#fff',
                  } : {
                    color: 'var(--text-muted)',
                    background: 'transparent'
                  }}>
                  {tf.label}
                </button>
              ))}
            </div>
          </div>

          {/* Artist List */}
          <div className="space-y-2 overflow-y-auto" style={{ maxHeight: '340px' }}>
            {topArtistsByPopularity.length === 0 ? (
              <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
                No artists found for selected market
              </p>
            ) : (
              topArtistsByPopularity.map((artist, i) => {
                const avgRoG = artist.rog
                ? Object.values(artist.rog).reduce((a, b) => a + b, 0) / Object.values(artist.rog).length
                : 0
                return (
                  <div key={artist.id}
                    className="flex items-center gap-3 p-2.5 rounded-xl transition-all duration-200 cursor-pointer"
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    {/* Rank */}
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
                      style={{
                        background: i === 0 ? 'rgba(245,158,11,0.2)' : i === 1 ? 'rgba(160,160,160,0.15)' : i === 2 ? 'rgba(180,100,60,0.15)' : 'var(--bg-secondary)',
                        color: i === 0 ? '#F59E0B' : i === 1 ? '#9CA3AF' : i === 2 ? '#B46432' : 'var(--text-muted)',
                        border: i === 0 ? '1px solid rgba(245,158,11,0.3)' : i === 1 ? '1px solid rgba(160,160,160,0.2)' : i === 2 ? '1px solid rgba(180,100,60,0.2)' : '1px solid var(--border)'
                      }}>
                      {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                    </div>

                    {/* Avatar */}
                    <img src={artist.photo} alt={artist.name}
                      className="w-8 h-8 rounded-xl object-cover flex-shrink-0"
                      style={{ border: '1px solid var(--border-strong)' }} />

                    {/* Name + bar */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs font-bold truncate" style={{ color: 'var(--text-primary)' }}>
                          {artist.name}
                        </p>
                        <span className="text-xs font-bold ml-1 flex-shrink-0"
                          style={{ color: 'var(--accent-gold)' }}>
                          {artist.displayPopularity ?? '—'}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                        <div className="h-full rounded-full transition-all duration-1000"
                          style={{
                            width: `${artist.displayPopularity ?? 0}%`,
                            background: i === 0
                              ? 'linear-gradient(90deg, #F59E0B, #FBBF24)'
                              : i <= 2
                              ? 'linear-gradient(90deg, #818CF8, #A78BFA)'
                              : 'linear-gradient(90deg, #34D399, #6EE7B7)'
                          }} />
                      </div>
                    </div>

                    {/* Total followers (real; monthly-stream data is not available) */}
                    <div className="text-right flex-shrink-0 w-20">
                      <p className="text-xs font-bold font-display" style={{ color: 'var(--accent-indigo)' }}>
                        {artist.totalFollowers > 0 ? formatNumber(artist.totalFollowers) : '—'}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>followers</p>
                    </div>

                    {/* RoG */}
                    <RoGBadge value={parseFloat(avgRoG.toFixed(1))} />
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* ── Row 2: Revenue + Age + Gender ── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-4">
        <ChartContainer title="Concerts by City" subtitle="Number of concerts per city" delay={150}>
          <BarChart data={concertsByCity} xKey="name" layout="horizontal"
            bars={[{ key: 'count', label: 'Concerts', color: '#818CF8' }]} height={240} />
        </ChartContainer>
        <ChartContainer title="Audience Age Distribution" subtitle="% of total audience" delay={230}>
          <PieChart data={ageChartData} nameKey="name" valueKey="value" innerRadius={55} height={240} />
        </ChartContainer>
        <ChartContainer title="Gender Distribution" subtitle="% of total audience" delay={310}>
          <PieChart data={genderChartData} nameKey="name" valueKey="value" innerRadius={55} height={240} />
        </ChartContainer>
    
      </div>

      {/* ── Row 3: Genre + Recent Concerts ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ChartContainer title="Genre Popularity" subtitle="Total streams by music genre" delay={200}>
          <BarChart data={genreChartData} xKey="genre" layout="vertical"
            bars={[{ key: 'streams', label: 'Streams' }]} multiColor={true} height={260} />
        </ChartContainer>

        {/* Recent Concerts */}
        <div className="glass-card p-5 animate-fade-up"
          style={{ animationDelay: '280ms', animationFillMode: 'both', opacity: 0 }}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                Concerts
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {marketLabel} Artist events at a glance
              </p>
            </div>
            {/* <span className="text-xs px-2.5 py-1 rounded-full font-semibold"
              style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--accent-indigo)' }}>
              {filteredConcerts.length} events
              Upcoming events
            </span> */}
          </div>

          <div className="space-y-2 overflow-y-auto pr-2" style={{ maxHeight: '260px' }}>
            {filteredConcerts.length === 0 ? (
              <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
                No concerts found for selected market
              </p>
            ) : (
              recentConcerts.map((c, i) => (
                <div key={c.id}
                  className="flex items-center gap-3 p-3 rounded-xl transition-all duration-200 cursor-pointer"
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <span className="w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                      {c.artist}
                    </p>
                    <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                      {c.city} · {formatDate(c.date)}
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-bold font-display" style={{ color: 'var(--accent-gold)' }}>
                      {formatCurrency(c.totalRevenue, { country: c.country })}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {formatNumber(c.ticketsSold)} tickets
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Dashboard
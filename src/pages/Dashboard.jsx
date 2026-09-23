import { useState, useMemo } from 'react'
import {
  Users, Music2, History,
} from 'lucide-react'
import PageHeader from '../components/ui/PageHeader'
import KpiCard from '../components/ui/KpiCard'
import ChartContainer from '../components/charts/ChartContainer'
import LineChart from '../components/charts/LineChart'
import BarChart from '../components/charts/BarChart'
import RoGBadge from '../components/ui/RoGBadge'
import SyncPopularityButton from '../components/ui/SyncPopularityButton'
import useFilterStore from '../store/useFilterStore'
import { useDashboardData } from '../hooks/useDashboardData'
import { formatNumber, formatDate } from '../utils/formatters'
import { classifyVenue } from '../utils/venueClassifier'

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
  { key: 'facebook',  label: 'Facebook',  color: '#1877F2' },
]

// Real daily ranges only — data currently spans 31 days, so no longer ranges.
const TREND_RANGES = [
  { label: '7D',  days: 7  },
  { label: '15D', days: 15 },
  { label: '30D', days: 30 },
]

const capitalizeCity = (city = '') => city.charAt(0).toUpperCase() + city.slice(1)

// Full category names (see venueClassifier.js) read fine in a sentence but
// wrap into a mangled 3-line mess in the chart's fixed-width axis label --
// shortened purely for the chart tick; topVenueCategory's headline sentence
// below still uses the full, unambiguous name.
const VENUE_CATEGORY_SHORT_LABEL = {
  'Stadium / Arena': 'Stadium/Arena',
  'Auditorium / Theatre / Hall': 'Auditorium/Theatre',
  'Educational Institution': 'Educational',
  'Outdoor Grounds / Park / Lawn': 'Outdoor/Park',
  'Mall / Corporate / Hotel': 'Mall/Corporate',
  'Other': 'Other',
}

const HIGHLIGHT_ICON = {
  most_repeated: '🔁',
  longest_relationship: '📈',
  widest_reach: '🗺️',
  biggest_show: '🏟️',
  most_consistent: '🎯',
}

// A future concert can never have real ticket/revenue data yet -- showing
// "Not available" for something that structurally cannot exist yet reads as
// broken, not honest. A countdown is always real and always computable.
const daysUntil = (dateStr) => {
  if (!dateStr) return null
  const diff = Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24))
  return diff
}

function Dashboard() {
  const { artistType } = useFilterStore()
  const [timeFilter, setTimeFilter] = useState(12)
  const [trendDays, setTrendDays] = useState(30)

  const { data, isLoading, error } = useDashboardData(trendDays)

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
        topArtistsPool = [],
        allConcerts = [],
        allArtists = [],
        followerTrends = [],
        artistIdToType = {},
        highlights = {},
      } = data || {}

  const safeTrends = followerTrends || []

  // Latest absolute reading per platform (for the legend chips) -- the chart
  // itself plots % change so Spotify's streams and the others' followers are
  // comparable on one axis; the chips show the real current scale alongside.
  const latestByPlatform = useMemo(() => {
    const last = safeTrends[safeTrends.length - 1]
    return last || {}
  }, [safeTrends])

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

  // Most recent scheduled/manual Popularity refresh across the pool, for the
  // "Popularity synced X ago" label next to the Sync Now button.
  const latestPopularitySync = useMemo(() => {
    if (!filteredArtists.length) return null
    return filteredArtists.reduce((latest, a) => {
      if (!a.popularityUpdatedAt) return latest
      return !latest || new Date(a.popularityUpdatedAt) > new Date(latest) ? a.popularityUpdatedAt : latest
    }, null)
  }, [filteredArtists])

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

  // Venue-type breakdown -- leads with what we DO know (where concerts
  // actually happen) instead of a bare capacity-verified fraction, which
  // reads as a failure rate. Full breakdown (venueCategoryData) feeds the
  // chart below; topVenueCategory is just its headline for the KPI card.
  // See Venues.jsx for the full per-city, per-venue detail.
  const venueCategoryData = useMemo(() => {
    const withVenue = filteredConcerts.filter(c => c.venue)
    if (!withVenue.length) return []
    const counts = {}
    withVenue.forEach(c => {
      const { category } = classifyVenue(c.venue)
      counts[category] = (counts[category] || 0) + 1
    })
    return Object.entries(counts)
      .map(([category, count]) => ({
        category: VENUE_CATEGORY_SHORT_LABEL[category] || category,
        fullCategory: category,
        count,
      }))
      .sort((a, b) => b.count - a.count)
  }, [filteredConcerts])

  const topVenueCategory = useMemo(() => {
    if (!venueCategoryData.length) return null
    const total = venueCategoryData.reduce((sum, v) => sum + v.count, 0)
    const { fullCategory, count } = venueCategoryData[0]
    return { category: fullCategory, count, total, pct: Math.round((count / total) * 100) }
  }, [venueCategoryData])

  // Cap at one concert per artist so a single artist's cluster of scheduled
  // shows (e.g. many future tour dates logged for one artist, none yet for
  // the rest of the roster) can't crowd out every other artist in this
  // roster-wide "at a glance" widget -- filteredConcerts is already sorted
  // most-future/most-recent-first (see useDashboardData.js), so the first
  // occurrence per artistId is each artist's single most relevant concert.
  const recentConcerts = useMemo(() => {
    const seenArtists = new Set()
    const perArtist = []
    for (const c of filteredConcerts) {
      if (seenArtists.has(c.artistId)) continue
      seenArtists.add(c.artistId)
      perArtist.push(c)
    }
    return perArtist.slice(0, 10)
  }, [filteredConcerts])

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
    // Presentation-friendly: Top 10 cities by real concert count.
    return Object.values(grouped).sort((a, b) => b.count - a.count).slice(0, 10)
  }, [filteredConcerts])

  // Concert Genre Representation: count concerts by the performing artist's
  // genre (the reliable Artist.genre string; the ArtistGenre join is empty).
  // Artists without a usable genre are excluded — not bucketed as 0/Unknown.
  const concertGenreData = useMemo(() => {
    if (!filteredConcerts.length || !allArtists?.length) return []
    const genreByArtist = {}
    allArtists.forEach(a => { if (a?.id && a?.genre) genreByArtist[a.id] = a.genre })
    const counts = {}
    filteredConcerts.forEach(c => {
      const g = genreByArtist[c.artistId]
      if (!g) return
      counts[g] = (counts[g] || 0) + 1
    })
    return Object.entries(counts)
      .map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count)
  }, [filteredConcerts, allArtists])

  // Real, but genuinely coarse: this roster is tagged into only 2 genres, so
  // a full bar chart for 2 values is mostly empty space. A one-line fact
  // says the same thing honestly, in less room, and explains WHY it looks
  // that way instead of leaving it to look broken.
  const genreSummary = useMemo(() => {
    if (!concertGenreData.length) return null
    const total = concertGenreData.reduce((sum, g) => sum + g.count, 0)
    return concertGenreData
      .map(g => `${g.genre} (${Math.round((g.count / total) * 100)}%)`)
      .join(' · ')
  }, [concertGenreData])

  // NOTE: Demographics (age/gender) charts hidden by product decision
  // (Demographics is out of scope for the current Artist Analytics product).
  // useDashboardData() still fetches ageData/genderData internally — only
  // this page's rendering of them was removed.

  // Trimmed to the two counts that are always meaningful on their own, with
  // no chart to pair them with. Venue Type and Repeat-Visit each moved next
  // to their own supporting chart below (same card, not a separate tile
  // scattered elsewhere on the page) -- a number and the chart that explains
  // it should be adjacent, not just visually similar-looking boxes.
  const KPI_CONFIG = [
    {
      title: 'Total Artists',
      value: totalArtistsCount,
      subtitle: `${marketLabel} artists`,
      icon: Users,
      accentColor: '#818CF8',
      delay: 0,
    },
    {
      title: 'Total Concerts',
      value: filteredConcerts.length,
      subtitle: 'All time',
      icon: Music2,
      accentColor: '#FBBF24',
      delay: 80,
    },
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
      <div className="grid grid-cols-2 gap-3 mb-6 max-w-xl">
        {KPI_CONFIG.map((kpi, i) => (
          <KpiCard key={i} {...kpi} />
        ))}
      </div>

      {/* ── Row 1: Trend Chart + Top 10 Artists ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">

        {/* Multi-line trend */}
        <ChartContainer
          title="Platform Growth Trends"
          subtitle={`Instagram · YouTube · Spotify · Facebook — daily, last ${trendDays} days`}
          delay={100}
        >
          <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
            <div className="flex gap-2 flex-wrap">
              {TREND_LINES.map(p => (
                <span key={p.key}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium"
                  style={{ background: `${p.color}18`, color: p.color, border: `1px solid ${p.color}30` }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.color }} />
                  {p.label}
                  {latestByPlatform[p.key] != null && (
                    <span style={{ opacity: 0.75 }}>· {formatNumber(latestByPlatform[p.key])}</span>
                  )}
                </span>
              ))}
            </div>
            {/* Real daily range selector (7/15/30D) */}
            <div className="flex gap-1 p-1 rounded-xl"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              {TREND_RANGES.map(r => (
                <button key={r.days}
                  onClick={() => setTrendDays(r.days)}
                  className="text-xs px-2 py-1 rounded-lg font-semibold transition-all duration-200"
                  style={trendDays === r.days ? {
                    background: 'linear-gradient(135deg, #6366F1, #818CF8)',
                    color: '#fff',
                  } : {
                    color: 'var(--text-muted)',
                    background: 'transparent',
                  }}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <LineChart data={safeTrends} xKey="date"
            lines={TREND_LINES.map(p => ({ ...p, key: `${p.key}Pct` }))} height={260}
            margin={{ top: 10, right: 48, left: 48, bottom: 10 }}
            yDomain={['auto', 'auto']}
            yTickFormatter={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}%`}
            tooltipValueFormatter={(value, entry) => {
              const rawKey = entry.dataKey.replace('Pct', '')
              const raw = entry.payload?.[rawKey]
              return `${value > 0 ? '+' : ''}${value.toFixed(1)}%  (${formatNumber(raw)})`
            }} />
        </ChartContainer>

        {/* Top 10 Artists */}
        <div className="glass-card p-5 animate-fade-up"
          style={{ animationDelay: '150ms', animationFillMode: 'both', opacity: 0 }}>

          {/* Header + Time Filter */}
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                🏆 Top {marketLabel} Artists by Digital Reach
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {/* 2026-09 dashboard-authenticity redesign: Popularity is
                    followers/streams/search-trend reach, not live commercial
                    draw -- see the Feasibility signal below for that. */}
                Ranked by Popularity (digital/social reach, not live draw)
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

          <div className="flex justify-end mb-3">
            <SyncPopularityButton lastUpdated={latestPopularitySync} />
          </div>

          {/* Artist List */}
          <div className="space-y-2 overflow-y-auto" style={{ maxHeight: '340px' }}>
            {topArtistsByPopularity.length === 0 ? (
              <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
                No artists found for selected market
              </p>
            ) : (
              topArtistsByPopularity.map((artist, i) => {
                // Real RoG from the canonical backend (getTopArtists). Not
                // computed in the browser; null → "—" (never a hardcoded 0).
                const avgRoG = artist.avgRogDaily
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

                    {/* RoG — real backend value, or "—" when no history */}
                    {avgRoG != null
                      ? <RoGBadge value={parseFloat(Number(avgRoG).toFixed(1))} />
                      : <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-muted)' }}>—</span>}
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* ── Row 2: City touring patterns + Venue types ── */}
      {/* Each headline stat now lives INSIDE the same card as the chart that
          explains it, not scattered in a KPI strip elsewhere on the page. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <ChartContainer title="Concerts by City" subtitle="Top 10 cities by concert count" delay={150}>
          <div className="flex items-end gap-3 mb-4 flex-wrap">
            <p className="font-display font-bold text-3xl" style={{ color: 'var(--text-primary)' }}>
              {formatNumber(highlights?.cities_with_repeat_visit || 0)}
              <span className="text-base font-normal" style={{ color: 'var(--text-muted)' }}>
                {' '}/ {formatNumber(highlights?.distinct_cities_played || 0)}
              </span>
            </p>
            <p className="text-xs pb-1 flex-1" style={{ color: 'var(--text-muted)', minWidth: '160px' }}>
              cities played have seen the <strong style={{ color: 'var(--text-secondary)' }}>same artist invited back</strong> more than once — not just any concert happening there again
            </p>
          </div>
          <BarChart data={concertsByCity} xKey="name" layout="horizontal"
            bars={[{ key: 'count', label: 'Concerts', color: '#818CF8' }]} height={220} />
        </ChartContainer>

        <ChartContainer title="Venue Type Distribution" subtitle="Classified from venue name — an estimate, not a verified survey" delay={200}>
          {topVenueCategory && (
            <div className="flex items-end gap-3 mb-4 flex-wrap">
              <p className="font-display font-bold text-3xl" style={{ color: 'var(--text-primary)' }}>
                {topVenueCategory.pct}%
              </p>
              <p className="text-xs pb-1 flex-1" style={{ color: 'var(--text-muted)', minWidth: '160px' }}>
                of identified venues are a <strong style={{ color: 'var(--text-secondary)' }}>{topVenueCategory.category}</strong> ({topVenueCategory.count} of {topVenueCategory.total})
              </p>
            </div>
          )}
          <BarChart data={venueCategoryData} xKey="category" layout="vertical"
            bars={[{ key: 'count', label: 'Concerts' }]} multiColor={true} height={220} />
        </ChartContainer>
      </div>

      {/* ── Row 2.5: Genre mix (real, but coarse -- a one-line fact instead of
          a chart that's mostly empty space) + Next Concert Per Artist ── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-4">
        <div className="glass-card p-5 animate-fade-up"
          style={{ animationDelay: '230ms', animationFillMode: 'both', opacity: 0 }}>
          <h3 className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
            Genre Mix
          </h3>
          <p className="text-xs mt-0.5 mb-4" style={{ color: 'var(--text-muted)' }}>
            By artist, not by concert count
          </p>
          {genreSummary ? (
            <>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{genreSummary}</p>
              <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
                This roster's genre tagging is coarse, not broken — most artists share one broad label, so a bar chart here would mostly show one giant bar next to a sliver.
              </p>
            </>
          ) : (
            <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No genre data available</p>
          )}
        </div>

        {/* Next Concert Per Artist */}
        <div className="glass-card p-5 animate-fade-up xl:col-span-2"
          style={{ animationDelay: '280ms', animationFillMode: 'both', opacity: 0 }}>
          <h3 className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
            Next Concert — Per Artist
          </h3>
          <p className="text-xs mt-0.5 mb-4" style={{ color: 'var(--text-muted)' }}>
            {/* A scheduled show genuinely can't have real ticket/revenue data
                yet -- a countdown is always real, unlike a "Not available"
                line that reads as broken rather than honest. */}
            Nearest scheduled show per {marketLabel} artist — or their most recent one, if nothing's upcoming
          </p>

          <div className="space-y-2 overflow-y-auto pr-2" style={{ maxHeight: '260px' }}>
            {filteredConcerts.length === 0 ? (
              <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
                No concerts found for selected market
              </p>
            ) : (
              recentConcerts.map((c, i) => {
                const days = daysUntil(c.date)
                const upcoming = days != null && days >= 0
                return (
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
                      <p className="text-sm font-bold font-display"
                        style={{ color: upcoming ? 'var(--accent-indigo)' : 'var(--text-muted)' }}>
                        {days == null ? '—' : upcoming ? `in ${days}d` : `${Math.abs(days)}d ago`}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {upcoming ? 'upcoming' : 'most recent'}
                      </p>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* ── Row 3: Touring Spotlight + Revisit Reminders ── */}
      {/* 2026-09 dashboard-authenticity redesign: a plain fact ("it's been
          this long since X played Y"), never a scored prediction -- see
          mad_analytics/touring_history/scorer.py's dashboard_highlights(). */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="glass-card p-5 animate-fade-up"
          style={{ animationDelay: '320ms', animationFillMode: 'both', opacity: 0 }}>
          <h3 className="font-display font-semibold text-sm flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <History size={16} /> Touring Spotlight
          </h3>
          <p className="text-xs mt-0.5 mb-4" style={{ color: 'var(--text-muted)' }}>
            Real facts pulled straight from logged concert history — no scored prediction
          </p>
          {highlights?.highlights?.length ? (
            <div className="space-y-3.5">
              {highlights.highlights.map((h, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <span className="text-base flex-shrink-0 leading-tight" aria-hidden="true">
                    {HIGHLIGHT_ICON[h.insight_type] || '•'}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>
                      {h.headline}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{h.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
              Not enough concert data yet
            </p>
          )}
        </div>

        <div className="glass-card p-5 animate-fade-up xl:col-span-2"
          style={{ animationDelay: '360ms', animationFillMode: 'both', opacity: 0 }}>
          <h3 className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
            Worth Revisiting
          </h3>
          <p className="text-xs mt-0.5 mb-4" style={{ color: 'var(--text-muted)' }}>
            {/* A long gap alone isn't evidence of an overlooked opportunity --
                it's equally consistent with real interest having cooled off.
                Each reminder below is cross-checked against real per-city
                digital-demand data where it exists, so "worth revisiting" is
                a claim backed by something more than elapsed time. */}
            A long gap can mean an oversight, or it can mean real demand has cooled — each one below shows which
          </p>
          {highlights?.revisit_reminders?.length ? (
            <div className="space-y-2">
              {highlights.revisit_reminders.map((r) => (
                <div key={`${r.artist_id}-${r.city}`}
                  className="p-3 rounded-xl" style={{ background: 'var(--bg-secondary)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {r.artist_name} · {capitalizeCity(r.city)}
                      </p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        Last played {formatDate(r.last_visit)} ({r.visit_count} visit{r.visit_count === 1 ? '' : 's'} total)
                      </p>
                    </div>
                    <span className="text-xs font-bold px-2.5 py-1 rounded-full flex-shrink-0"
                      style={{ background: 'rgba(251,191,36,0.12)', color: 'var(--accent-gold)' }}>
                      {Math.round(r.days_since_last_visit / 365 * 10) / 10}y ago
                    </span>
                  </div>
                  {r.demand_signal_pct != null ? (
                    <p className="text-xs mt-2" style={{ color: '#34D399' }}>
                      ✓ Real digital demand still here — {r.demand_signal_pct}% of monthly listeners are from {capitalizeCity(r.city)}
                    </p>
                  ) : (
                    <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                      No corroborating demand signal found — treat this as an open question, not a confirmed opportunity
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
              No overdue artist-city pairs right now
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default Dashboard
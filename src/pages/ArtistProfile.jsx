import { useParams, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, MapPin, Music, TrendingUp, DollarSign, Users, Ticket, Youtube, Repeat } from 'lucide-react'
import PageHeader from '../components/ui/PageHeader'
import RoGBadge from '../components/ui/RoGBadge'
import ChartContainer from '../components/charts/ChartContainer'
import LineChart from '../components/charts/LineChart'
import EmptyState from '../components/ui/EmptyState'
import client from '../api/client'
import { formatNumber, formatCurrency, formatDate, formatPercent } from '../utils/formatters'
import ViberateTrends from '../components/viberate/ViberateTrends'
import ScoreBreakdown from '../components/viberate/ScoreBreakdown'
import { useEngagement, useRepeatVisitRate } from '../hooks/usePredictions'

// NOTE: 'Demographics' tab hidden by product decision (Demographics is out of
// scope for the current Artist Analytics product). The underlying data-fetch
// and backend implementation are untouched; only this page's UI entry point
// was removed. See git history for the exact removed tab markup if reinstating.
const TABS = ['Platforms', 'Growth Trends', 'Concerts', 'Platform Trends', 'Score']

// Real daily ranges only — history currently spans 31 days.
const GROWTH_RANGES = [
  { label: '7D', days: 7 },
  { label: '15D', days: 15 },
  { label: '30D', days: 30 },
]

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

// Growth Trends adds a Combined line (sum of the real platform series).
const GROWTH_LINES = [
  ...TREND_LINES,
  { key: 'combined', label: 'Combined', color: '#A78BFA' },
]

function ArtistProfile() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [activeTab, setTab] = useState('Platforms')
  const [growthDays, setGrowthDays] = useState(30)

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


  // Engagement ratios (true-fan proxy, real ratios or honest nulls -- see
  // mad_analytics/engagement/scorer.py) and per-artist repeat-visit rate
  // (real touring precedent -- see mad_analytics/touring_history/scorer.py).
  // Both fetched independently of the artist/concerts queries above so a
  // slow/unavailable analytics call never blocks the rest of the page.
  const engagement = useEngagement(id, !!id)
  const repeatVisit = useRepeatVisitRate(id, !!id)

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
    // platform_metrics.SPOTIFY.followers stores Spotify *monthly listeners*, not the
    // follower count -- use the Artist column directly so this stays distinct from
    // spotifyMonthlyListeners below (matches Artists.jsx list card behavior).
    spotify: Number(artist.spotifyFollowers) || 0,
    facebook: followerMap.get('facebook') || Number(artist.facebookFollowers) || 0,
    applemusic: followerMap.get('applemusic') || 0,
  }

  const spotifyMonthlyListeners = followerMap.get('spotify') || Number(artist.spotifyMonthlyListeners) || 0

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

  // Growth Trends: aggregate real DAILY platform metrics (no month-bucketing,
  // no multipliers). Combined = sum of the platform series for that day.
  const trendMap = new Map()

  allMetrics?.forEach((metric) => {
    const d = new Date(metric.metricDate)
    const dayKey = d.toISOString().slice(0, 10) // YYYY-MM-DD (unique, sortable)
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) // "Jul 5"
    const platform = (metric.platform || '').toLowerCase()
    const followers = Number(metric.followers) || 0

    if (!trendMap.has(dayKey)) {
      trendMap.set(dayKey, { key: dayKey, date: label, instagram: 0, youtube: 0, spotify: 0 })
    }
    const entry = trendMap.get(dayKey)
    if (platform === 'instagram') entry.instagram = followers
    if (platform === 'youtube') entry.youtube = followers
    if (platform === 'spotify') entry.spotify = followers
  })

  const trendDataAll = Array.from(trendMap.values())
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ key, ...rest }) => ({ ...rest, combined: rest.instagram + rest.youtube + rest.spotify }))

  // Only the last N days that actually have data — never padded.
  const trendData = trendDataAll.slice(-growthDays)

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
                { label: 'Spotify Monthly Listeners', value: formatNumber(spotifyMonthlyListeners), icon: Users, color: 'var(--accent-indigo)' },
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

      {/* Engagement & Touring Precedent — real, already-computed signals that
          previously had zero frontend presence (2026-09 display-gap audit).
          "Not available" is rendered explicitly wherever the underlying
          metric is genuinely unavailable (Instagram/Facebook engagement have
          no honest ratio at all — see mad_analytics/engagement/scorer.py) —
          never a guessed 0% standing in for missing data. */}
      <div className="glass-card p-5 mb-6 animate-fade-up">
        <h3 className="font-display font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
          Engagement & Touring Precedent
        </h3>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          True-fan engagement ratios and real repeat-booking history — not another popularity estimate
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {[
            {
              label: 'YouTube Like Rate',
              rate: engagement.data?.youtube_like_rate,
              icon: Youtube,
              color: '#FF0000',
            },
            {
              label: 'Spotify Follow Rate',
              rate: engagement.data?.spotify_follow_rate,
              icon: TrendingUp,
              color: '#1DB954',
            },
            {
              label: 'Instagram Engagement',
              rate: engagement.data?.instagram_engagement_rate,
              icon: Users,
              color: '#E1306C',
            },
            {
              label: 'Facebook Engagement',
              rate: engagement.data?.facebook_engagement_rate,
              icon: Users,
              color: '#1877F2',
            },
          ].map((stat) => {
            const isAvailable = stat.rate != null
            return (
              <div key={stat.label} className="rounded-xl p-3"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <stat.icon size={12} style={{ color: stat.color }} />
                  <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                    {stat.label}
                  </p>
                </div>
                <p className="font-display font-bold text-base"
                  style={{
                    color: isAvailable ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontStyle: isAvailable ? 'normal' : 'italic',
                  }}>
                  {!engagement.data ? '—' : isAvailable ? formatPercent(stat.rate) : 'Not available'}
                </p>
              </div>
            )
          })}
        </div>

        {/* Repeat-visit rate: real numbers first (per the honest-disclosure
            discipline — a bare % on a small sample is easy to misread), the
            rate itself as supporting context. */}
        <div className="rounded-xl p-3 flex items-center gap-3"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(99,102,241,0.12)' }}>
            <Repeat size={16} style={{ color: 'var(--accent-indigo)' }} />
          </div>
          <div>
            {!repeatVisit.data ? (
              <p className="text-sm font-semibold" style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                {repeatVisit.isLoading ? 'Loading touring history…' : 'Not available'}
              </p>
            ) : repeatVisit.data.distinct_cities === 0 ? (
              <p className="text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>
                No logged concerts for this artist yet
              </p>
            ) : (
              <>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Revisited {repeatVisit.data.repeat_cities} of {repeatVisit.data.distinct_cities} cities played
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {formatPercent(repeatVisit.data.repeat_rate)} repeat-visit rate — real booking history, not a formula estimate
                </p>
              </>
            )}
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
          subtitle={`Instagram · YouTube · Spotify · Combined — daily, last ${growthDays} days`}
        >
          <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
            <div className="flex gap-2 flex-wrap">
              {GROWTH_LINES.map(p => (
                <span key={p.key}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium"
                  style={{ background: `${p.color}18`, color: p.color, border: `1px solid ${p.color}30` }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.color }} />
                  {p.label}
                </span>
              ))}
            </div>
            <div className="flex gap-1 p-1 rounded-xl"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              {GROWTH_RANGES.map(r => (
                <button key={r.days}
                  onClick={() => setGrowthDays(r.days)}
                  className="text-xs px-2 py-1 rounded-lg font-semibold transition-all duration-200"
                  style={growthDays === r.days ? {
                    background: 'linear-gradient(135deg, #6366F1, #818CF8)', color: '#fff',
                  } : { color: 'var(--text-muted)', background: 'transparent' }}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          {trendData.length > 0 ? (
            <LineChart data={trendData} xKey="date" lines={GROWTH_LINES} height={320}
              yDomain={['auto', 'auto']} />
          ) : (
            <EmptyState title="No platform history" message="No daily platform metrics are available for this artist yet." />
          )}
        </ChartContainer>
      )}
{activeTab === 'Platform Trends' && <ViberateTrends artistId={id} />}
{activeTab === 'Score' && <ScoreBreakdown artistId={id} />}
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
                    <td className="px-4 py-3 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{c.ticketsSold > 0 ? formatNumber(c.ticketsSold) : '—'}</td>
                    <td className="px-4 py-3 font-bold font-display text-sm" style={{ color: 'var(--accent-gold)' }}>{c.totalRevenue > 0 ? formatCurrency(c.totalRevenue, { country: c.country }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

    </div>
  )
}

export default ArtistProfile

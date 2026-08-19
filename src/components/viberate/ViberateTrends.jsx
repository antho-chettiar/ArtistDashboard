import { useState, useMemo } from 'react'
import ChartContainer from '../charts/ChartContainer'
import LineChart from '../charts/LineChart'
import EmptyState from '../ui/EmptyState'
import { useViberateMetrics } from '../../hooks/useViberate'

/**
 * ViberateTrends — daily time-series charts from ViberateMetricDaily.
 *
 * mode 'total' → charts the running total (followers, subscribers, ...)
 * mode 'diff'  → charts the daily change (metrics Viberate provides no total
 *                for: instagram_likes/comments, tiktok_views/comments)
 *
 * NOTE on diffs: a 0 means "no Viberate update that day", not zero activity.
 */

const LINE_COLORS = ['#818CF8', '#FBBF24', '#34D399', '#F87171', '#A78BFA']

const PLATFORM_GROUPS = [
  {
    platform: 'Spotify', color: '#1DB954',
    metrics: [
      { name: 'spotify_listeners', label: 'Monthly Listeners', mode: 'total' },
      { name: 'spotify_followers', label: 'Followers', mode: 'total' },
      { name: 'spotify_streams', label: 'Streams', mode: 'total' },
      { name: 'spotify_popularity', label: 'Popularity', mode: 'total' },
    ],
  },
  {
    platform: 'YouTube', color: '#FF0000',
    metrics: [
      { name: 'youtube_subscribers', label: 'Subscribers', mode: 'total' },
      { name: 'youtube_views', label: 'Views', mode: 'total' },
      { name: 'youtube_channel_views', label: 'Channel Views', mode: 'total' },
      { name: 'youtube_likes', label: 'Likes', mode: 'total' },
    ],
  },
  {
    platform: 'Instagram', color: '#E1306C',
    metrics: [
      { name: 'instagram_followers', label: 'Followers', mode: 'total' },
      { name: 'instagram_likes', label: 'Likes (daily)', mode: 'diff' },
      { name: 'instagram_comments', label: 'Comments (daily)', mode: 'diff' },
    ],
  },
  {
    platform: 'Facebook', color: '#1877F2',
    metrics: [
      { name: 'facebook_followers', label: 'Followers', mode: 'total' },
    ],
  },
  {
    platform: 'TikTok', color: '#00F2EA',
    metrics: [
      { name: 'tiktok_followers', label: 'Followers', mode: 'total' },
      { name: 'tiktok_channel_likes', label: 'Channel Likes', mode: 'total' },
      { name: 'tiktok_views', label: 'Views (daily)', mode: 'diff' },
      { name: 'tiktok_comments', label: 'Comments (daily)', mode: 'diff' },
    ],
  },
]

// Real daily ranges only — Viberate history currently spans 31 days, so longer
// windows (90/180/365) are intentionally not offered until enough data exists.
const DAY_OPTIONS = [7, 15, 30]

function ViberateTrends({ artistId }) {
  const [activePlatform, setPlatform] = useState(PLATFORM_GROUPS[0])
  const [selectedMetrics, setSelected] = useState([PLATFORM_GROUPS[0].metrics[0].name])
  const [days, setDays] = useState(30)

  const { data: series, isLoading, error } = useViberateMetrics(
    artistId,
    selectedMetrics,
    days
  )

  const metricDefs = useMemo(
    () => activePlatform.metrics.filter(m => selectedMetrics.includes(m.name)),
    [activePlatform, selectedMetrics]
  )

  // Merge selected metric series into LineChart rows: [{date, metricA, metricB}]
  const { chartData, lines } = useMemo(() => {
    if (!series) return { chartData: [], lines: [] }

    const byDate = new Map()
    const chartLines = []

    metricDefs.forEach((def, i) => {
      const rows = series[def.name] || []
      chartLines.push({
        key: def.name,
        label: def.label,
        color: LINE_COLORS[i % LINE_COLORS.length],
      })
      rows.forEach(row => {
        const value = def.mode === 'total' ? row.total : row.diff
        if (value === null || value === undefined) return
        if (!byDate.has(row.date)) byDate.set(row.date, { date: row.date })
        byDate.get(row.date)[def.name] = value
      })
    })

    const data = Array.from(byDate.values()).sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    )
    return { chartData: data, lines: chartLines }
  }, [series, metricDefs])

  const switchPlatform = (group) => {
    setPlatform(group)
    setSelected([group.metrics[0].name])
  }

  const toggleMetric = (name) => {
    setSelected(prev => {
      if (prev.includes(name)) {
        const next = prev.filter(m => m !== name)
        return next.length > 0 ? next : prev // keep at least one selected
      }
      return [...prev, name]
    })
  }

  const hasDiffMetric = metricDefs.some(m => m.mode === 'diff')

  return (
    <ChartContainer
      title={`${activePlatform.platform} — Daily Trends`}
      subtitle={`Viberate time-series · last ${days} days${hasDiffMetric ? ' · daily metrics: 0 can mean "no update from Viberate"' : ''}`}
    >
      {/* Platform selector */}
      <div className="flex gap-2 mb-3 flex-wrap">
        {PLATFORM_GROUPS.map(group => (
          <button key={group.platform} onClick={() => switchPlatform(group)}
            className="text-xs px-3 py-1.5 rounded-xl font-medium transition-all duration-200"
            style={activePlatform.platform === group.platform ? {
              background: `${group.color}20`, color: group.color,
              border: `1px solid ${group.color}50`,
            } : {
              background: 'var(--bg-card)', color: 'var(--text-muted)',
              border: '1px solid var(--border)',
            }}>
            {group.platform}
          </button>
        ))}
      </div>

      {/* Metric + days selectors */}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex gap-2 flex-wrap">
          {activePlatform.metrics.map(metric => {
            const active = selectedMetrics.includes(metric.name)
            return (
              <button key={metric.name} onClick={() => toggleMetric(metric.name)}
                className="text-xs px-2.5 py-1 rounded-full font-medium transition-all duration-200"
                style={active ? {
                  background: 'linear-gradient(135deg, #6366F1, #818CF8)',
                  color: '#fff', boxShadow: '0 4px 12px rgba(99,102,241,0.3)',
                } : {
                  background: 'var(--bg-secondary)', color: 'var(--text-muted)',
                  border: '1px solid var(--border)',
                }}>
                {metric.label}
              </button>
            )
          })}
        </div>
        <div className="flex gap-1.5">
          {DAY_OPTIONS.map(d => (
            <button key={d} onClick={() => setDays(d)}
              className="text-xs px-2.5 py-1 rounded-lg font-semibold transition-all duration-200"
              style={days === d ? {
                background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                border: '1px solid var(--border-strong)',
              } : {
                background: 'transparent', color: 'var(--text-muted)',
                border: '1px solid var(--border)',
              }}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      {isLoading ? (
        <div className="h-72 rounded-xl animate-pulse" style={{ background: 'var(--bg-secondary)' }} />
      ) : error ? (
        <EmptyState title="Failed to load Viberate data"
          subtitle={error?.response?.data?.message || error.message} />
      ) : chartData.length === 0 ? (
        <EmptyState title="No data for this selection"
          subtitle="This artist may not be tracked on this platform, or the window has no rows yet." />
      ) : (
        <LineChart data={chartData} xKey="date" lines={lines} height={320} />
      )}
    </ChartContainer>
  )
}

export default ViberateTrends

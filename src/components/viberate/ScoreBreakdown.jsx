import { useMemo } from 'react'
import { Gauge, TrendingUp, Zap, Search } from 'lucide-react'
import ChartContainer from '../charts/ChartContainer'
import LineChart from '../charts/LineChart'
import EmptyState from '../ui/EmptyState'
import { useArtistScore } from '../../hooks/useViberate'

/**
 * ScoreBreakdown — ArtistPopularityV2 (v2.1-viberate) score card.
 *
 * Layer 1: entropy-weighted reach (0–1)
 * Layer 2: engagement multiplier (log-compressed engaged headcount, cap 2×)
 * Layer 3: Google Trends (0–1) — 70/30 blend, final scale 5–100
 */

const SCORE_HISTORY_DAYS = 60

function LayerRow({ icon: Icon, label, display, barPct, color, note }) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <Icon size={12} style={{ color }} />
          <span className="text-xs uppercase tracking-widest"
            style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{label}</span>
        </div>
        <span className="text-sm font-bold font-display" style={{ color: 'var(--text-primary)' }}>
          {display}
        </span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
        <div className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(100, Math.max(0, barPct))}%`, background: color }} />
      </div>
      {note && (
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{note}</p>
      )}
    </div>
  )
}

function ScoreBreakdown({ artistId }) {
  const { data, isLoading, error } = useArtistScore(artistId, SCORE_HISTORY_DAYS)

  const historyData = useMemo(() => {
    if (!data?.history) return []
    return [...data.history]
      .sort((a, b) => new Date(a.computedAt).getTime() - new Date(b.computedAt).getTime())
      .map(snap => ({
        date: new Date(snap.computedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        score: Number(snap.finalScore),
      }))
  }, [data])

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[1, 2].map(i => (
          <div key={i} className="glass-card p-5 animate-pulse">
            <div className="h-4 rounded w-1/3 mb-4" style={{ background: 'var(--bg-secondary)' }} />
            <div className="h-48 rounded-xl" style={{ background: 'var(--bg-secondary)' }} />
          </div>
        ))}
      </div>
    )
  }

  if (error?.response?.status === 404) {
    return (
      <EmptyState
        title="No V2 score yet"
        subtitle="Run the scorer to generate a popularity snapshot for this artist." />
    )
  }

  if (error || !data?.latest) {
    return (
      <EmptyState
        title="Failed to load score"
        subtitle={error?.response?.data?.message || error?.message || 'Please try again'} />
    )
  }

  const snap = data.latest
  const finalScore = Number(snap.finalScore)
  const reach = Number(snap.reachScore)
  const engagement = Number(snap.engagementMultiplier)
  const trends = Number(snap.trendsScore)
  const trendsMissing = snap.trendsMetadata?.source === 'missing'

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Score card */}
      <div className="glass-card p-5 animate-fade-up relative overflow-hidden"
        style={{ animationFillMode: 'both', opacity: 0 }}>
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(circle at 100% 0%, rgba(99,102,241,0.06), transparent 60%)' }} />

        <div className="relative z-10">
          <div className="flex items-start justify-between mb-5">
            <div>
              <h3 className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                Popularity Score
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {snap.scoreVersion} · computed {new Date(snap.computedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
              </p>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--accent-indigo)' }}>
              5–100 scale
            </span>
          </div>

          {/* Big number */}
          <div className="mb-6">
            <p className="font-display font-bold" style={{ color: 'var(--text-primary)', fontSize: '52px', lineHeight: 1 }}>
              {finalScore}
            </p>
            <div className="mt-3 h-2 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
              <div className="h-full rounded-full"
                style={{
                  width: `${((finalScore - 5) / 95) * 100}%`,
                  background: 'linear-gradient(135deg, #6366F1, #818CF8)',
                }} />
            </div>
          </div>

          {/* Layer breakdown */}
          <LayerRow icon={Gauge} label="Reach Score (entropy-weighted)"
            display={reach.toFixed(3)}
            barPct={reach * 100}
            color="#818CF8" />

          <LayerRow icon={Zap} label="Engagement Multiplier"
            display={`${engagement.toFixed(3)}×`}
            barPct={(engagement / 2) * 100}
            color="#FBBF24"
            note="30-day engaged headcount, log-compressed (max 2×)" />

          <LayerRow icon={Search} label="Google Trends"
            display={trendsMissing ? '—' : trends.toFixed(3)}
            barPct={trendsMissing ? 0 : trends * 100}
            color="#34D399"
            note={trendsMissing
              ? 'No Trends data — score computed from reach only'
              : snap.trendsMetadata?.keyword
                ? `Keyword: "${snap.trendsMetadata.keyword}" (${snap.trendsMetadata.geo || 'IN'})`
                : undefined} />

          <p className="text-xs pt-3" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
            {trendsMissing
              ? 'Final = normalized(reach × engagement)'
              : 'Final = 0.70 × normalized(reach × engagement) + 0.30 × trends'}
          </p>
        </div>
      </div>

      {/* Score history */}
      <ChartContainer
        title="Score Trend"
        subtitle={`Last ${historyData.length} snapshots · ${snap.scoreVersion}`}
        delay={80}
      >
        {historyData.length < 2 ? (
          <EmptyState title="Not enough history yet"
            subtitle="The score trend appears after a few daily scorer runs." />
        ) : (
          <LineChart
            data={historyData}
            xKey="date"
            lines={[{ key: 'score', label: 'Final Score', color: '#818CF8' }]}
            height={320}
            yDomain={[0, 100]}
          />
        )}
      </ChartContainer>
    </div>
  )
}

export default ScoreBreakdown

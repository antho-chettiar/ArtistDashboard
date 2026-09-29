import { Gauge, Search } from 'lucide-react'
import EmptyState from '../ui/EmptyState'
import { useArtistScore } from '../../hooks/useViberate'

/**
 * ScoreBreakdown — canonical Popularity score card (mad_analytics, Blueprint v2.0).
 *
 * Popularity = BaseEntropy×0.80 + GoogleTrends×0.20, weights renormalized
 * over whichever components are available for this artist (see
 * mad_analytics/popularity/calculator.py's WEIGHT_BASE/WEIGHT_GOOGLE_TRENDS).
 *
 * This card previously showed the ArtistPopularityV2 (Viberate) breakdown
 * (Reach / Engagement / Trends); that system was retired in favor of a single
 * canonical Popularity formula everywhere (FORMULA_DECISIONS.md §2). There is
 * no historical trend chart here anymore — the canonical engine keeps only
 * the latest score per artist, not a dated snapshot history.
 *
 * A Momentum row used to live here too, for an earlier version of this
 * formula that included a Momentum component -- removed (not just hidden)
 * once Momentum was retired product-wide, since the backend genuinely never
 * returns a momentum value any more (see artist.controller.ts's getScore),
 * not merely a per-artist gap worth showing as "no data yet".
 */

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
  const { data, isLoading, error } = useArtistScore(artistId)

  if (isLoading) {
    return (
      <div className="glass-card p-5 animate-pulse">
        <div className="h-4 rounded w-1/3 mb-4" style={{ background: 'var(--bg-secondary)' }} />
        <div className="h-48 rounded-xl" style={{ background: 'var(--bg-secondary)' }} />
      </div>
    )
  }

  if (error?.response?.status === 503) {
    return (
      <EmptyState
        title="Analytics unavailable"
        subtitle="The popularity engine is temporarily unavailable. Try again shortly." />
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
  const hasBase = snap.baseScore != null
  const hasTrends = snap.trendsScore != null

  return (
    <div className="glass-card p-5 animate-fade-up relative overflow-hidden max-w-xl"
      style={{ animationFillMode: 'both', opacity: 0 }}>
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(circle at 100% 0%, color-mix(in srgb, var(--accent-indigo) 6%, transparent), transparent 60%)' }} />

      <div className="relative z-10">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h3 className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
              Popularity Score
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              computed {new Date(snap.computedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </p>
          </div>
          <span className="text-xs px-2 py-0.5 rounded-full font-medium"
            style={{ background: 'color-mix(in srgb, var(--accent-indigo) 12%, transparent)', color: 'var(--accent-indigo)' }}>
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
                background: 'linear-gradient(135deg, var(--accent-indigo), var(--accent-indigo))',
              }} />
          </div>
        </div>

        {/* Component breakdown */}
        <LayerRow icon={Gauge} label="Base (Entropy-weighted followers)"
          display={hasBase ? snap.baseScore.toFixed(1) : '—'}
          barPct={hasBase ? snap.baseScore : 0}
          color="var(--accent-indigo)" />

        <LayerRow icon={Search} label="Google Trends"
          display={hasTrends ? snap.trendsScore.toFixed(1) : '—'}
          barPct={hasTrends ? snap.trendsScore : 0}
          color="var(--accent-green)"
          note={hasTrends ? undefined : 'No Trends data yet — dropped from the blend'} />

        <p className="text-xs pt-3" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
          Popularity = Base×0.80 + Google Trends×0.20 (weights renormalized
          over whichever components are available).
        </p>
      </div>
    </div>
  )
}

export default ScoreBreakdown

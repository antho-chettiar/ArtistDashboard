import { RefreshCw } from 'lucide-react'
import { useSyncPopularity } from '../../hooks/usePredictions'

// Weekly-cache-plus-manual-sync design (2026-09): Popularity is normally
// read straight from artists.popularity, refreshed automatically on a
// schedule (as often as every 24h) -- normal page loads never wait on a
// live calculation. This button is the manual override for anyone who
// wants today's number specifically (e.g. right before a stakeholder demo).
// Shared by the Dashboard and Artists pages so a click on either one
// refreshes both.
function timeAgo(dateString) {
  if (!dateString) return null
  const d = new Date(dateString)
  if (Number.isNaN(d.getTime())) return null
  const diffMs = Date.now() - d.getTime()
  if (diffMs < 0) return 'just now'
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function SyncPopularityButton({ lastUpdated }) {
  const { mutate, isPending, isError } = useSyncPopularity()
  const label = timeAgo(lastUpdated)

  return (
    <div className="flex items-center gap-2">
      {label && !isPending && (
        <span className="text-xs whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
          Popularity synced {label}
        </span>
      )}
      {isError && (
        <span className="text-xs whitespace-nowrap" style={{ color: 'var(--accent-red, #EF4444)' }}>
          Sync failed
        </span>
      )}
      <button
        onClick={() => mutate()}
        disabled={isPending}
        title="Recompute Popularity right now instead of waiting for the next scheduled refresh"
        className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          color: 'var(--text-primary)',
          opacity: isPending ? 0.6 : 1,
          cursor: isPending ? 'default' : 'pointer',
        }}
      >
        <RefreshCw size={13} className={isPending ? 'animate-spin' : ''} />
        {isPending ? 'Syncing…' : 'Sync Now'}
      </button>
    </div>
  )
}

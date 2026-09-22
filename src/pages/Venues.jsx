import { useMemo, useState } from 'react'
import { Building2, Loader2, MapPin, Sun, Home } from 'lucide-react'
import PageHeader from '../components/ui/PageHeader'
import EmptyState from '../components/ui/EmptyState'
import { useVenues } from '../hooks/useVenues'
import { formatNumber } from '../utils/formatters'

const CATEGORY_COLORS = {
  'Stadium / Arena': '#818CF8',
  'Auditorium / Theatre / Hall': '#34D399',
  'Educational Institution': '#FBBF24',
  'Outdoor Grounds / Park / Lawn': '#F87171',
  'Mall / Corporate / Hotel': '#38BDF8',
  'Other': '#94A3B8',
}

function Venues() {
  const { venues, isLoading } = useVenues()
  const [activeCity, setActiveCity] = useState('All')

  const cities = useMemo(() => {
    const set = new Set(venues.map(v => v.city))
    return ['All', ...[...set].sort()]
  }, [venues])

  // Venue-type breakdown: leads with what we DO know (where concerts
  // actually happen) rather than a bare "X verified / Y total" fraction --
  // see the 2026-09 dashboard-authenticity conversation on framing honest
  // data without making every gap read as a failure.
  const categoryBreakdown = useMemo(() => {
    const counts = {}
    venues.forEach(v => { counts[v.category] = (counts[v.category] || 0) + 1 })
    const total = venues.length || 1
    return Object.entries(counts)
      .map(([category, count]) => ({ category, count, pct: Math.round((count / total) * 100) }))
      .sort((a, b) => b.count - a.count)
  }, [venues])

  const filteredVenues = useMemo(() => {
    if (activeCity === 'All') return venues
    return venues.filter(v => v.city === activeCity)
  }, [venues, activeCity])

  const groupedByCity = useMemo(() => {
    const groups = {}
    filteredVenues.forEach(v => {
      if (!groups[v.city]) groups[v.city] = []
      groups[v.city].push(v)
    })
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
  }, [filteredVenues])

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 glass-card mx-6 my-10">
        <Loader2 className="animate-spin text-amber-500" size={40} />
        <p className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>Loading venues...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-6 py-6">
      <PageHeader title="Venues" subtitle="Every known concert venue, grouped by city" />

      {/* Venue-type breakdown -- the honest replacement for a bare capacity-
          coverage fraction (see Dashboard's KPI row). */}
      <div className="glass-card p-5">
        <h3 className="font-display font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
          What kind of venues does this roster actually play?
        </h3>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          Classified from the venue name — a presentation grouping, not a verified survey
        </p>
        <div className="flex flex-wrap gap-3">
          {categoryBreakdown.map(({ category, count, pct }) => (
            <div key={category} className="flex items-center gap-2 px-3 py-2 rounded-xl"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ background: CATEGORY_COLORS[category] || CATEGORY_COLORS.Other }} />
              <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{category}</span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{count} · {pct}%</span>
            </div>
          ))}
        </div>
      </div>

      {/* City filter */}
      <div className="flex flex-wrap gap-2">
        {cities.map(city => (
          <button key={city}
            onClick={() => setActiveCity(city)}
            className="text-xs font-semibold px-3 py-1.5 rounded-full transition-all duration-200"
            style={{
              background: activeCity === city ? 'var(--accent-indigo)' : 'var(--bg-card)',
              color: activeCity === city ? '#fff' : 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}>
            {city}
          </button>
        ))}
      </div>

      {/* Venues grouped by city */}
      {groupedByCity.length === 0 ? (
        <EmptyState title="No venues found" subtitle="Try a different city filter" />
      ) : (
        groupedByCity.map(([city, cityVenues]) => (
          <div key={city} className="glass-card p-5">
            <h3 className="font-display font-semibold text-sm mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <MapPin size={15} /> {city}
              <span className="text-xs font-normal" style={{ color: 'var(--text-muted)' }}>({cityVenues.length} venues)</span>
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {cityVenues.map(v => (
                <div key={`${v.venueName}-${v.city}`} className="p-3 rounded-xl"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{v.venueName}</p>
                    {v.isOutdoor !== null && (
                      v.isOutdoor
                        ? <Sun size={14} style={{ color: '#FBBF24' }} title="Outdoor (estimated)" />
                        : <Home size={14} style={{ color: '#818CF8' }} title="Indoor (estimated)" />
                    )}
                  </div>
                  <p className="text-xs mt-1" style={{ color: CATEGORY_COLORS[v.category] || CATEGORY_COLORS.Other }}>
                    {v.category}
                  </p>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {v.concertCount} concert{v.concertCount === 1 ? '' : 's'}
                    </span>
                    {v.capacity > 0 ? (
                      <span className="text-xs font-bold px-2 py-0.5 rounded-full"
                        style={{
                          background: v.isVerifiedCapacity ? 'rgba(52,211,153,0.12)' : 'rgba(148,163,184,0.12)',
                          color: v.isVerifiedCapacity ? '#34D399' : 'var(--text-muted)',
                        }}>
                        {formatNumber(v.capacity)} {v.isVerifiedCapacity ? '(verified)' : '(est.)'}
                      </span>
                    ) : (
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

export default Venues

import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Calendar, MapPin, Users, Ticket, DollarSign, TrendingUp, Star, Loader2, AlertCircle } from 'lucide-react'
import EmptyState from '../components/ui/EmptyState'
import { useConcertDetail } from '../hooks/useConcerts'
import { formatNumber, formatCurrency, formatDate } from '../utils/formatters'

function ConcertDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: concert, isLoading, error } = useConcertDetail(id)

  if (isLoading) return (
    <div className="flex flex-col items-center justify-center py-20 gap-4 glass-card mx-6 my-10">
      <Loader2 className="animate-spin text-amber-500" size={40} />
      <p className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>Loading concert details...</p>
    </div>
  )

  if (error || !concert) return (
    <div className="p-6">
      <EmptyState 
        title={error ? "Error loading concert" : "Concert not found"} 
        subtitle={error ? "There was a problem fetching the concert data." : "This concert does not exist."} 
      />
    </div>
  )

  // No real sponsor-revenue data exists anywhere in this system -- there's no
  // sponsor-revenue column, and concert.sponsors is just a list of names with
  // no dollar figures attached. A flat 15% split was fabricated here; removed
  // rather than replaced with a different guess (see the removed "Revenue
  // Breakdown" chart below). Total revenue is still shown, honestly, in the
  // KPI cards.

  // Sell-through is only a real number when both capacity AND a real ticket
  // count are known -- either being missing/zero must read as "unknown", not
  // collapse into the red "poor performance" bucket (imported historical
  // concerts often store 0 where the real value was never recorded).
  const hasSellThroughData = Boolean(concert.capacity) && Boolean(concert.ticketsSold)
  const st = hasSellThroughData ? (concert.ticketsSold / concert.capacity) * 100 : null

  const stColor = !hasSellThroughData
    ? 'var(--text-muted)'
    : st >= 95 ? 'var(--accent-green)' : st >= 75 ? 'var(--accent-gold)' : 'var(--accent-red)'

  // Imported historical concerts often store 0 where the real value was
  // never recorded -- treat 0 as missing here too, not a real zero.
  const kpis = [
    { label: 'Tickets Sold',    value: concert.ticketsSold > 0 ? formatNumber(concert.ticketsSold) : '—', sub: concert.capacity > 0 ? `of ${formatNumber(concert.capacity)}` : 'capacity unknown', icon: Ticket,      color: 'var(--accent-indigo)' },
    { label: 'Avg Ticket Price',value: concert.avgTicketPrice > 0 ? formatCurrency(concert.avgTicketPrice, { country: concert.country }) : '—', sub: 'per ticket',            icon: TrendingUp,  color: 'var(--accent-gold)'   },
    { label: 'Total Revenue',   value: concert.totalRevenue > 0 ? formatCurrency(concert.totalRevenue, { country: concert.country }) : '—',    sub: 'incl. sponsors',        icon: DollarSign,  color: 'var(--accent-green)'  },
    { label: 'Sponsors',        value: concert.sponsors.length,                  sub: 'brand partners',        icon: Star,        color: 'var(--accent-red)'    },
  ]

  return (
    <div className="relative">
      <div className="fixed top-20 right-20 w-80 h-80 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(245,158,11,0.07), transparent 70%)', filter: 'blur(40px)' }} />

      <button onClick={() => navigate('/concerts')}
        className="flex items-center gap-2 text-sm mb-5 transition-all duration-200 hover:gap-3"
        style={{ color: 'var(--text-muted)' }}>
        <ArrowLeft size={15} /> Back to Concerts
      </button>

      {/* Hero */}
      <div className="glass-card p-6 mb-6 animate-fade-up relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(circle at 0% 0%, rgba(245,158,11,0.05), transparent 60%)' }} />
        <div className="flex flex-col sm:flex-row items-start justify-between gap-4 relative z-10">
          <div>
            <h1 className="font-display font-bold text-3xl mb-1" style={{ color: 'var(--text-primary)' }}>
              {concert.name}
            </h1>
            <p className="font-semibold mb-4" style={{ color: 'var(--accent-gold)' }}>{concert.artist}</p>
            <div className="flex flex-wrap gap-4 text-sm" style={{ color: 'var(--text-muted)' }}>
              <div className="flex items-center gap-1.5">
                <Calendar size={13} style={{ color: 'var(--accent-indigo)' }} />
                {formatDate(concert.date)}
              </div>
              <div className="flex items-center gap-1.5">
                <MapPin size={13} style={{ color: 'var(--accent-gold)' }} />
                {concert.venue}, {concert.city}
              </div>
              <div className="flex items-center gap-1.5">
                <Users size={13} style={{ color: 'var(--accent-green)' }} />
                Capacity: {formatNumber(concert.capacity)}
              </div>
            </div>
          </div>

          {/* Sell-through ring */}
          <div className="text-center rounded-2xl px-8 py-5 flex-shrink-0"
            style={{ background: `${stColor}10`, border: `1px solid ${stColor}30` }}>
            <p className="text-xs uppercase tracking-widest mb-1"
              style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Sell-Through</p>
            <p className="font-display font-bold text-4xl" style={{ color: stColor }}>
              {hasSellThroughData ? `${st.toFixed(1)}%` : '—'}
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {!hasSellThroughData ? 'Capacity unknown' : st >= 95 ? '🔥 Sold Out' : st >= 75 ? '✅ Strong' : '⚠️ Moderate'}
            </p>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {kpis.map((k, i) => (
          <div key={i} className="glass-card p-4 animate-fade-up"
            style={{ animationDelay: `${i * 80}ms`, animationFillMode: 'both', opacity: 0 }}>
            <div className="flex items-center gap-1.5 mb-2">
              <k.icon size={13} style={{ color: k.color }} />
              <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                {k.label}
              </p>
            </div>
            <p className="font-display font-bold text-xl" style={{ color: 'var(--text-primary)' }}>{k.value}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{k.sub}</p>
          </div>
        ))}
      </div>

      {/* Sponsors. No real sponsor-revenue data exists in this system (see
          note above) -- the fabricated "Revenue Breakdown: Ticket vs Sponsor
          Revenue" chart that used to sit next to this card was removed
          rather than replaced with a different guess. This card only ever
          shows real brand-partner names, never a dollar figure. */}
      <div className="glass-card p-5 mb-6 animate-fade-up" style={{ animationDelay: '100ms', animationFillMode: 'both', opacity: 0 }}>
        <h3 className="font-display font-semibold text-sm mb-4" style={{ color: 'var(--text-primary)' }}>
          Sponsors
        </h3>
        {concert.sponsors.length === 0 ? (
          <EmptyState title="No sponsors" />
        ) : (
          <div className="space-y-3">
            {concert.sponsors.map((sponsor, i) => (
              <div key={i} className="flex items-center justify-between p-3 rounded-xl"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold"
                    style={{ background: 'linear-gradient(135deg, #6366F1, #818CF8)' }}>
                    {sponsor[0]}
                  </div>
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{sponsor}</span>
                </div>
                <span className="text-xs px-2.5 py-1 rounded-full font-medium"
                  style={{ background: 'rgba(99,102,241,0.1)', color: 'var(--accent-indigo)' }}>
                  Brand Partner
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Location */}
      <div className="glass-card p-5 animate-fade-up" style={{ animationDelay: '200ms', animationFillMode: 'both', opacity: 0 }}>
        <h3 className="font-display font-semibold text-sm mb-3" style={{ color: 'var(--text-primary)' }}>Location</h3>
        <div className="flex items-center gap-3 mb-3">
          <MapPin size={15} style={{ color: 'var(--accent-gold)' }} />
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {concert.venue}, {concert.city}, {concert.state}, {concert.country}
          </span>
        </div>
        <div className="p-3 rounded-xl font-mono text-xs" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
          Lat: {concert.lat} · Lng: {concert.lng}
        </div>
      </div>
    </div>
  )
}

export default ConcertDetail
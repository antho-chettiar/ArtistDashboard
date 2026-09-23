import { useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet'
import PageHeader from '../components/ui/PageHeader'
import { useConcerts } from '../hooks/useConcerts'
import { formatNumber, formatCurrency, formatDate } from '../utils/formatters'
import { sumTickets, sumRevenueINR } from '../utils/concertMetrics'
import { MapPin, Ticket, DollarSign, Music2, Loader2 } from 'lucide-react'
import L from 'leaflet'

delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

function getRadius(t) { return t >= 50000 ? 28 : t >= 30000 ? 22 : t >= 15000 ? 16 : 12 }

// Unknown sell-through (missing capacity OR missing ticket count) must never
// collapse into the same red used for a genuinely poor-performing show --
// same "unknown != bad" principle as ConcertDetail.jsx's sell-through ring.
// Ticket counts are unrecorded for the large majority of concerts in this
// dataset today, so this guard is what keeps the map from painting nearly
// every pin the "bad" color.
function getColor(s, c) {
  if (!c || !s) return '#94A3B8'
  const p = s / c
  return p >= 0.95 ? '#34D399' : p >= 0.75 ? '#FBBF24' : '#F87171'
}

function MapView() {
  const [selectedArtist, setArtist]   = useState('All Artists')
  const [selectedConcert, setConcert] = useState(null)

  const { data: concerts = [], isLoading } = useConcerts()

  const artists = ['All Artists', ...new Set(concerts.map(c => c.artist))]

  const filtered = concerts.filter(c =>
    selectedArtist === 'All Artists' || c.artist === selectedArtist
  )

  // Shared with Concerts.jsx / ArtistProfile.jsx -- sums to null (never a
  // fabricated 0) when nothing in the filtered set has a real recorded value.
  const totalTickets  = sumTickets(filtered)
  const totalRevenue  = sumRevenueINR(filtered)

  if (isLoading) return (
    <div className="flex flex-col items-center justify-center py-20 gap-4 glass-card mx-6 my-10">
      <Loader2 className="animate-spin text-amber-500" size={40} />
      <p className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>Initializing tour map...</p>
    </div>
  )

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 120px)' }}>
      <div className="fixed top-20 left-72 w-72 h-72 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.06), transparent 70%)', filter: 'blur(40px)' }} />

      <PageHeader title="Tour Map" subtitle="Geographic view of concert locations and performance" />

      {/* Controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
        <div
          className="flex items-center gap-2 rounded-xl px-4 py-2.5"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        >
          <MapPin size={16} className="flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
          <select
            value={selectedArtist}
            onChange={e => setArtist(e.target.value)}
            className="bg-transparent outline-none text-sm w-full"
            style={{ color: 'var(--text-primary)', fontFamily: 'Satoshi' }}
          >
            {artists.map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-3 flex-wrap">
          {[
            { icon: Music2,     label: 'Concerts', value: filtered.length,          color: 'var(--accent-indigo)' },
            { icon: Ticket,     label: 'Tickets',  value: formatNumber(totalTickets), color: 'var(--accent-gold)'   },
            { icon: DollarSign, label: 'Revenue',  value: formatCurrency(totalRevenue), color: 'var(--accent-green)' },
          ].map((stat, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-xl"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <stat.icon size={13} style={{ color: stat.color }} />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{stat.label}:</span>
              <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{stat.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Map + Sidebar */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Map */}
        <div className="flex-1 rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          <MapContainer center={[20.5937, 78.9629]} zoom={5} style={{ height: '100%', width: '100%' }}>
            <TileLayer
              attribution='&copy; OpenStreetMap'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {filtered.map(concert => {
              const lat = Number(concert.lat || 0)
              const lng = Number(concert.lng || 0)
              const tickets = Number(concert.ticketsSold || 0)
              const capacity = Number(concert.capacity || 0)
              
              if (!lat || !lng) return null

              return (
                <CircleMarker
                  key={concert.id}
                  center={[lat, lng]}
                  radius={getRadius(tickets)}
                  pathOptions={{
                    color: getColor(tickets, capacity),
                    fillColor: getColor(tickets, capacity),
                    fillOpacity: 0.75, weight: 2,
                  }}
                  eventHandlers={{ click: () => setConcert(concert) }}
                >
                  <Tooltip direction="top" offset={[0, -8]} opacity={0.95}>
                    <div style={{ fontFamily: 'Satoshi', fontSize: '12px' }}>
                      <p style={{ fontWeight: 700 }}>{concert.artist || 'Unknown Artist'}</p>
                      <p>{concert.venue || 'TBA'}, {concert.city || 'TBA'}</p>
                      <p>{formatDate(concert.date)}</p>
                    </div>
                  </Tooltip>
                </CircleMarker>
              )
            })}
          </MapContainer>
        </div>

        {/* Sidebar */}
        <div className="w-68 flex flex-col gap-2 overflow-y-auto" style={{ width: '270px' }}>
          {selectedConcert ? (
            <div className="glass-card p-4">
              <button onClick={() => setConcert(null)}
                className="text-xs mb-3 transition-all duration-200"
                style={{ color: 'var(--text-muted)' }}>
                ← Back to list
              </button>
              <h3 className="font-display font-bold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
                {selectedConcert.name || 'Live Event'}
              </h3>
              <p className="text-xs font-semibold mb-3" style={{ color: 'var(--accent-gold)' }}>
                {selectedConcert.artist || 'Unknown Artist'}
              </p>
              <div className="flex items-center gap-1.5 mb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                <MapPin size={11} style={{ color: 'var(--accent-indigo)' }} />
                {selectedConcert.venue || 'TBA'}, {selectedConcert.city || 'TBA'}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                      { label: 'Date',         value: formatDate(selectedConcert.date) },
                      { label: 'Capacity',     value: selectedConcert.capacity > 0 ? formatNumber(selectedConcert.capacity) : '—' },
                      { label: 'Tickets Sold', value: selectedConcert.ticketsSold > 0 ? formatNumber(selectedConcert.ticketsSold) : '—' },
                      { label: 'ATP',          value: selectedConcert.avgTicketPrice > 0 ? formatCurrency(selectedConcert.avgTicketPrice, { country: selectedConcert.country }) : '—' },
                      { label: 'Revenue',      value: selectedConcert.totalRevenue > 0 ? formatCurrency(selectedConcert.totalRevenue, { country: selectedConcert.country }) : '—' },
                      { label: 'Sell-Through', value: selectedConcert.capacity > 0 && selectedConcert.ticketsSold > 0 ? ((selectedConcert.ticketsSold / selectedConcert.capacity) * 100).toFixed(1) + '%' : '—' },
                ].map((item, i) => (
                  <div key={i} className="rounded-xl p-2" style={{ background: 'var(--bg-secondary)' }}>
                    <p className="text-xs" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{item.label}</p>
                    <p className="font-bold text-xs mt-0.5" style={{ color: 'var(--text-primary)' }}>{item.value}</p>
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>Sponsors</p>
                <div className="flex flex-wrap gap-1.5">
                  {selectedConcert.sponsors.map((s, i) => (
                    <span key={i} className="text-xs px-2 py-0.5 rounded-full font-medium"
                      style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--accent-indigo)' }}>
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <>
              <p className="text-xs uppercase tracking-widest px-1 mb-1"
                style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                {filtered.length} Concerts
              </p>
              {filtered.map(concert => (
                <div key={concert.id} onClick={() => setConcert(concert)}
                  className="glass-card p-3 cursor-pointer transition-all duration-200"
                  style={{ animationFillMode: 'both' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.transform = 'translateX(3px)' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'translateX(0)' }}>
                  <div className="flex items-start justify-between mb-1.5">
                    <div>
                      <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{concert.artist}</p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{concert.city}</p>
                    </div>
                      <span className="w-2.5 h-2.5 rounded-full mt-0.5 flex-shrink-0"
                      style={{ background: getColor(concert.ticketsSold, concert.capacity) }} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{formatDate(concert.date)}</span>
                    <span className="text-xs font-bold font-display" style={{ color: 'var(--accent-gold)' }}>
                      {concert.totalRevenue > 0 ? formatCurrency(concert.totalRevenue, { country: concert.country }) : '—'}
                    </span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 mt-3">
        <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
          Sell-Through:
        </p>
        {[
          { color: '#34D399', label: '≥ 95% Sold Out' },
          { color: '#FBBF24', label: '75–95%'         },
          { color: '#F87171', label: '< 75%'          },
          { color: '#94A3B8', label: 'Capacity/tickets unknown' },
        ].map((item, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: item.color }} />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{item.label}</span>
          </div>
        ))}
        <span className="text-xs ml-2" style={{ color: 'var(--text-muted)' }}>· Circle size = tickets sold</span>
      </div>
    </div>
  )
}

export default MapView
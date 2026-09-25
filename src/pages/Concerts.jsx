import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  ArrowUpDown,
  Building2,
  Calendar,
  ChevronRight,
  Loader2,
  MapPin,
  Music2,
  Search,
  SlidersHorizontal,
  TrendingUp,
  X,
} from 'lucide-react'
import PageHeader from '../components/ui/PageHeader'
import EmptyState from '../components/ui/EmptyState'
import { useConcerts } from '../hooks/useConcerts'
import { formatNumber, formatCurrency, formatDate } from '../utils/formatters'
import { sumCapacity, sumRevenueINR, sumTickets } from '../utils/concertMetrics'

const DEFAULT_CITIES = ['Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Kolkata']

const SORT_OPTIONS = [
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc', label: 'Oldest first' },
  { value: 'revenue-desc', label: 'Highest revenue' },
  { value: 'tickets-desc', label: 'Most tickets' },
  { value: 'sell-through-desc', label: 'Best sell-through' },
]

function getTime(value) {
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

// Returns null (never a fabricated 0%) whenever either side of the ratio is
// genuinely unknown -- 0 of 233 concerts in this dataset have real ticket
// data, so a bare `ticketsSold` of 0 always means "not tracked", not "sold
// zero tickets". Matches the same guard already applied in
// ConcertDetail.jsx/MapView.jsx -- this file's own row/card view had been
// missed in that pass.
function getSellThrough(concert) {
  const tickets = Number(concert.ticketsSold || 0)
  const capacity = Number(concert.capacity || 0)
  if (!capacity || !tickets) return null
  return (tickets / capacity) * 100
}

function getSellThroughStatus(value, capacity, ticketsSold) {
  if (!capacity) return { label: 'Capacity TBA', color: 'var(--text-muted)' }
  if (!ticketsSold || value == null) return { label: 'Not tracked', color: 'var(--text-muted)' }
  if (value >= 95) return { label: 'Sold out', color: '#10B981' }
  if (value >= 80) return { label: 'Strong', color: '#F59E0B' }
  return { label: 'Building', color: '#6366F1' }
}

function MetricCard({ icon, label, value, helper, color, delay = 0 }) {
  return (
    <div
      className="glass-card p-4 animate-fade-up"
      style={{ animationDelay: `${delay}ms`, animationFillMode: 'both', opacity: 0 }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className="text-xs uppercase tracking-widest font-semibold"
            style={{ color: 'var(--text-muted)', fontSize: '10px' }}
          >
            {label}
          </p>
          <p className="font-display font-bold text-2xl mt-2 truncate" style={{ color: 'var(--text-primary)' }}>
            {value}
          </p>
        </div>
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: `${color}18`, border: `1px solid ${color}30` }}
        >
          {createElement(icon, { size: 17, style: { color } })}
        </div>
      </div>
      {helper && (
        <p className="text-xs mt-2 truncate" style={{ color: 'var(--text-muted)' }}>
          {helper}
        </p>
      )}
    </div>
  )
}

function SellThroughBar({ value, capacity, ticketsSold }) {
  const status = getSellThroughStatus(value, capacity, ticketsSold)
  const isUnknown = value == null

  return (
    <div className="flex flex-col gap-1 items-center">
      <p className="text-xs font-bold leading-tight" style={{ color: status.color }}>
        {isUnknown ? 'N/A' : `${value.toFixed(1)}%`}
      </p>
      <div className="h-2 w-20 rounded-full overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: isUnknown ? '0%' : `${Math.min(value, 100)}%`,
            backgroundColor: status.color,
          }}
        />
      </div>
    </div>
  )
}

function ConcertCard({ concert, onOpen }) {
  const sellThrough = getSellThrough(concert)
  const capacity = Number(concert.capacity || 0)

  return (
    <button
      type="button"
      onClick={onOpen}
      className="glass-card p-4 text-left animate-fade-up transition-transform duration-200 active:scale-[0.99]"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <p className="text-sm font-display font-bold truncate" style={{ color: 'var(--text-primary)' }}>
            {concert.artist || 'Unknown Artist'}
          </p>
          <p className="text-xs mt-1 truncate" style={{ color: 'var(--text-muted)' }}>
            {concert.name || 'Live Event'}
          </p>
        </div>
        <ChevronRight size={17} className="flex-shrink-0 mt-1" style={{ color: 'var(--text-muted)' }} />
      </div>

      <div className="space-y-2 mb-4">
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <Calendar size={13} style={{ color: 'var(--accent-indigo)' }} />
          <span>{formatDate(concert.date)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs min-w-0" style={{ color: 'var(--text-secondary)' }}>
          <MapPin size={13} className="flex-shrink-0" style={{ color: 'var(--accent-gold)' }} />
          <span className="truncate">{concert.venue || 'TBA'}, {concert.city || 'TBA'}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="rounded-xl p-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <p className="text-xs" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Tickets</p>
          <p className="text-sm font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
            {/* Imported historical concerts often have 0 stored where the real
                value was never recorded -- `|| 0` here was actively turning a
                genuinely missing value into a fabricated zero. */}
            {concert.ticketsSold > 0 ? formatNumber(concert.ticketsSold) : '—'}
          </p>
        </div>
          <div className="rounded-xl p-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <p className="text-xs" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Revenue</p>
          <p className="text-sm font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
            {concert.totalRevenue > 0 ? formatCurrency(concert.totalRevenue, concert.currency) : '—'}
          </p>
        </div>
      </div>

      <SellThroughBar value={sellThrough} capacity={capacity} ticketsSold={concert.ticketsSold} />
    </button>
  )
}

function Concerts() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [activeCity, setCity] = useState('All')
  const [sortBy, setSortBy] = useState('date-desc')
  const [year, setYear] = useState('')
  const observerTarget = useRef(null)

  const queryCity = activeCity && activeCity !== 'All' ? activeCity : undefined
  const queryYear = /^\d{4}$/.test(year) ? year : ''

  const {
    data: concerts = [],
    total,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useConcerts({
    city: queryCity,
    year: queryYear || undefined,
    limit: 50,
  })

  useEffect(() => {
    const target = observerTarget.current
    if (!target) return undefined

    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage()
        }
      },
      { rootMargin: '160px', threshold: 0.1 }
    )

    observer.observe(target)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const cityOptions = useMemo(() => {
    const extraCities = concerts
      .map(concert => concert.city)
      .filter(Boolean)
      .filter(city => !DEFAULT_CITIES.includes(city))
      .sort((a, b) => a.localeCompare(b))

    const selectedCity = activeCity && activeCity !== 'All' && !DEFAULT_CITIES.includes(activeCity)
      ? [activeCity]
      : []

    return ['All', ...new Set([...DEFAULT_CITIES, ...selectedCity, ...extraCities])]
  }, [activeCity, concerts])

  const yearOptions = useMemo(() => {
    return [...new Set(concerts.map(concert => new Date(concert.date).getFullYear()).filter(Boolean))]
      .sort((a, b) => b - a)
  }, [concerts])

  const filtered = useMemo(() => {
    const searchTerm = search.trim().toLowerCase()
    const cityTerm = activeCity === 'All' ? '' : activeCity.trim().toLowerCase()

    return concerts
      .filter(concert => {
        const searchMatch = !searchTerm || [
          concert.artist,
          concert.city,
          concert.name,
          concert.venue,
          concert.state,
          concert.country,
        ].some(value => String(value || '').toLowerCase().includes(searchTerm))

        const cityMatch = !cityTerm || String(concert.city || '').toLowerCase().includes(cityTerm)
        const yearMatch = !queryYear || new Date(concert.date).getFullYear().toString() === queryYear

        return searchMatch && cityMatch && yearMatch
      })
      .sort((a, b) => {
        if (sortBy === 'date-asc') return getTime(a.date) - getTime(b.date)
        if (sortBy === 'revenue-desc') return Number(b.totalRevenue || 0) - Number(a.totalRevenue || 0)
        if (sortBy === 'tickets-desc') return Number(b.ticketsSold || 0) - Number(a.ticketsSold || 0)
        if (sortBy === 'sell-through-desc') return (getSellThrough(b) ?? -1) - (getSellThrough(a) ?? -1)
        return getTime(b.date) - getTime(a.date)
      })
  }, [activeCity, concerts, queryYear, search, sortBy])

  const metrics = useMemo(() => {
    // Shared with ArtistProfile.jsx / MapView.jsx -- null (not 0) when the
    // filtered set has no real revenue/ticket/capacity data at all.
    const totalTickets = sumTickets(filtered)
    const totalCapacity = sumCapacity(filtered)
    const totalRevenueINR = sumRevenueINR(filtered)

    const capacityLoggedCount = filtered.filter(concert => Number(concert.capacity || 0) > 0).length
    const avgCapacity = totalCapacity != null && capacityLoggedCount > 0
      ? totalCapacity / capacityLoggedCount
      : null

    const avgTicketPrice = totalTickets && totalRevenueINR != null
      ? totalRevenueINR / totalTickets
      : null

    const avgSellThrough = totalTickets && totalCapacity
      ? (totalTickets / totalCapacity) * 100
      : null

    // Real, always-computable: which city has the most logged events in the
    // current filter. Ranking by revenue would surface an arbitrary "leader"
    // today -- ticket/revenue figures are absent for effectively this entire
    // dataset (see Tickets Sold / Revenue KPI tiles below, which were removed
    // for the same reason), so count is the only honest ranking available.
    const cityCounts = {}
    filtered.forEach(concert => {
      const city = concert.city || 'Unknown'
      cityCounts[city] = (cityCounts[city] || 0) + 1
    })
    const topCityEntry = Object.entries(cityCounts).sort((a, b) => b[1] - a[1])[0]
    const topCity = topCityEntry ? { city: topCityEntry[0], count: topCityEntry[1] } : null

    const distinctCities = new Set(filtered.map(concert => concert.city).filter(Boolean)).size
    const distinctVenues = new Set(filtered.map(concert => concert.venue).filter(Boolean)).size

    return {
      totalTickets,
      totalRevenue: totalRevenueINR,
      avgTicketPrice,
      avgSellThrough,
      avgCapacity,
      capacityLoggedCount,
      distinctCities,
      distinctVenues,
      topCity,
    }
  }, [filtered])

  const hasActiveFilters = Boolean(search.trim() || year || activeCity !== 'All')
  const resultCount = filtered.length
  const totalLabel = total || concerts.length

  const clearFilters = () => {
    setSearch('')
    setCity('All')
    setYear('')
    setSortBy('date-desc')
  }

  const openConcert = id => {
    navigate(`/concerts/${id}`)
  }

  const handleRowKeyDown = (event, id) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openConcert(id)
    }
  }

  return (
    <div className="relative space-y-6">
      <div
        className="fixed top-24 right-16 w-80 h-80 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.07), transparent 70%)', filter: 'blur(40px)' }}
      />

      <PageHeader
        title="Concerts"
        subtitle={isLoading && concerts.length === 0
          ? 'Loading concert events'
          : `Showing ${formatNumber(resultCount)} of ${formatNumber(totalLabel)} events`}
      >
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition-all duration-200"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            <X size={14} />
            Clear
          </button>
        )}
      </PageHeader>

      {/* Tickets Sold / Revenue / Sell-Through were dropped from this strip --
          ticket and revenue figures are absent for effectively every concert
          currently logged, so those tiles would read "0"/"—" no matter which
          filter is applied (the same hollow-KPI problem Dashboard.jsx already
          solved for its own YTD tiles). Replaced with facts that are always
          real for whatever's currently filtered: city/venue counts, and a
          capacity coverage stat modeled on Venues.jsx's own verified/estimated
          disclosure -- honest about what's missing without reading as a
          failure rate. */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <MetricCard
          icon={Music2}
          label="Events"
          value={formatNumber(resultCount)}
          helper={metrics.topCity ? `${metrics.topCity.city} leads with ${metrics.topCity.count} events` : 'No events for current filters'}
          color="#818CF8"
          delay={0}
        />
        <MetricCard
          icon={MapPin}
          label="Cities"
          value={formatNumber(metrics.distinctCities)}
          helper={`${formatNumber(metrics.distinctVenues)} venues across these cities`}
          color="#F59E0B"
          delay={70}
        />
        <MetricCard
          icon={Building2}
          label="Venues"
          value={formatNumber(metrics.distinctVenues)}
          helper={metrics.topCity ? `Most active in ${metrics.topCity.city}` : 'No venue data yet'}
          color="#10B981"
          delay={140}
        />
        <MetricCard
          icon={TrendingUp}
          label="Avg Capacity"
          value={metrics.avgCapacity != null ? formatNumber(Math.round(metrics.avgCapacity)) : '—'}
          helper={metrics.capacityLoggedCount > 0
            ? `Logged for ${metrics.capacityLoggedCount} of ${formatNumber(resultCount)} events`
            : 'No capacity data logged yet'}
          color="#6366F1"
          delay={210}
        />
      </div>

      <div className="glass-card p-4 animate-fade-up" style={{ animationDelay: '120ms', animationFillMode: 'both', opacity: 0 }}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-[1fr_180px_150px_210px] gap-3">
          <div
            className="flex items-center gap-2 rounded-xl px-3 py-2.5 min-w-0"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
          >
            <Search size={16} className="flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Search artist, city, venue"
              value={search}
              onChange={event => setSearch(event.target.value)}
              className="bg-transparent outline-none w-full text-sm min-w-0"
              style={{ color: 'var(--text-primary)', fontFamily: 'Satoshi' }}
            />
          </div>

          <div
            className="flex items-center gap-2 rounded-xl px-3 py-2.5"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
          >
            <MapPin size={16} className="flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
            <select
              value={activeCity}
              onChange={event => setCity(event.target.value)}
              className="bg-transparent outline-none w-full text-sm"
              style={{ color: 'var(--text-primary)', fontFamily: 'Satoshi' }}
            >
              {cityOptions.map(city => (
                <option key={city} value={city}>{city === 'All' ? 'All cities' : city}</option>
              ))}
            </select>
          </div>

          <div
            className="flex items-center gap-2 rounded-xl px-3 py-2.5"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
          >
            <Calendar size={16} className="flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
            <input
              list="concert-year-options"
              type="number"
              min="2000"
              max={new Date().getFullYear() + 2}
              value={year}
              onChange={event => setYear(event.target.value)}
              placeholder="Year"
              className="bg-transparent outline-none w-full text-sm"
              style={{ color: 'var(--text-primary)', fontFamily: 'Satoshi' }}
            />
            <datalist id="concert-year-options">
              {yearOptions.map(option => <option key={option} value={option} />)}
            </datalist>
          </div>

          <div
            className="flex items-center gap-2 rounded-xl px-3 py-2.5"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
          >
            <ArrowUpDown size={16} className="flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
            <select
              value={sortBy}
              onChange={event => setSortBy(event.target.value)}
              className="bg-transparent outline-none w-full text-sm"
              style={{ color: 'var(--text-primary)', fontFamily: 'Satoshi' }}
            >
              {SORT_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap mt-4">
          <SlidersHorizontal size={14} style={{ color: 'var(--text-muted)' }} />
          {['All', ...DEFAULT_CITIES].map(city => (
            <button
              key={city}
              type="button"
              onClick={() => setCity(city)}
              className="text-xs px-3 py-1.5 rounded-xl font-semibold transition-all duration-200"
              style={activeCity === city ? {
                background: 'linear-gradient(135deg, #6366F1, #818CF8)',
                color: '#fff',
                border: '1px solid rgba(99,102,241,0.3)',
              } : {
                background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid var(--border)',
              }}
            >
              {city === 'All' ? 'All cities' : city}
            </button>
          ))}
        </div>
      </div>

      {isLoading && concerts.length === 0 ? (
        <div className="glass-card py-20 flex flex-col items-center justify-center gap-4">
          <Loader2 className="animate-spin" size={40} style={{ color: 'var(--accent-indigo)' }} />
          <p className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>Fetching concert database...</p>
        </div>
      ) : error ? (
        <div className="glass-card py-20 flex flex-col items-center justify-center gap-4 px-4 text-center">
          <AlertCircle size={40} style={{ color: 'var(--accent-red)' }} />
          <div>
            <h3 className="font-display font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
              Failed to load concerts
            </h3>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              {error.response?.data?.message || error.message || 'Please try again.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-xs px-4 py-2 rounded-xl font-semibold"
            style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--accent-indigo)', border: '1px solid rgba(99,102,241,0.24)' }}
          >
            Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass-card">
          <EmptyState
            title="No concerts found"
            subtitle="Adjust the current filters or clear them to return to the full list."
            action={hasActiveFilters ? { label: 'Clear filters', onClick: clearFilters } : undefined}
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 lg:hidden">
            {filtered.map(concert => (
              <ConcertCard
                key={concert.id}
                concert={concert}
                onOpen={() => openConcert(concert.id)}
              />
            ))}
          </div>

          <div className="glass-card overflow-hidden animate-fade-up hidden lg:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>
                  <tr>
                    {['Artist / Concert', 'Date', 'Location', 'Venue', 'Tickets', 'Sell-Through', 'ATP', 'Revenue', ''].map(header => (
                      <th
                        key={header || 'open'}
                        className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-widest"
                        style={{ color: 'var(--text-muted)', fontSize: '10px' }}
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(concert => {
                    const tickets = Number(concert.ticketsSold || 0)
                    const capacity = Number(concert.capacity || 0)
                    const sellThrough = getSellThrough(concert)

                    return (
                      <tr
                        key={concert.id}
                        tabIndex={0}
                        role="button"
                        onClick={() => openConcert(concert.id)}
                        onKeyDown={event => handleRowKeyDown(event, concert.id)}
                        className="cursor-pointer transition-all duration-150 outline-none"
                        style={{ borderBottom: '1px solid var(--border)' }}
                        onMouseEnter={event => { event.currentTarget.style.background = 'var(--bg-secondary)' }}
                        onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
                      >
                        <td className="px-4 py-4">
                          <div className="min-w-0">
                            <p className="font-display font-bold text-sm truncate max-w-32" style={{ color: 'var(--text-primary)' }}>
                              {concert.artist || 'Unknown Artist'}
                            </p>
                            {/* <p className="text-xs mt-1 truncate max-w-32" style={{ color: 'var(--text-muted)' }}>
                              {concert.name || 'Live Event'}
                            </p> */}
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                            <Calendar size={13} style={{ color: 'var(--accent-indigo)' }} />
                            {formatDate(concert.date)}
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                              {concert.city || 'TBA'}
                            </p>
                            <p className="text-xs mt-1 flex items-center gap-1 truncate max-w-48" style={{ color: 'var(--text-muted)' }}>
                              <MapPin size={11} className="flex-shrink-0" />
                              {concert.state && concert.country ? `${concert.state}, ${concert.country}` : concert.country || concert.state || 'Location TBA'}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold truncate max-w-32" style={{ color: 'var(--text-primary)' }}>
                              {concert.venue || 'Venue TBA'}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <p className="text-sm font-bold font-mono" style={{ color: 'var(--text-primary)' }}>
                            {concert.ticketsSold > 0 ? formatNumber(tickets) : '—'}
                          </p>
                          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                            {concert.capacity > 0 ? `of ${formatNumber(capacity)}` : 'capacity unknown'}
                          </p>
                        </td>
                        <td className="px-4 py-4">
                          <SellThroughBar value={sellThrough} capacity={capacity} ticketsSold={concert.ticketsSold} />
                        </td>
                        <td className="px-4 py-4 text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                          {concert.avgTicketPrice > 0 ? formatCurrency(concert.avgTicketPrice, concert.currency) : '—'}
                        </td>
                        <td className="px-4 py-4 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                          {concert.totalRevenue > 0 ? formatCurrency(concert.totalRevenue, concert.currency) : '—'}
                        </td>
                        <td className="px-4 py-4">
                          <ChevronRight size={17} style={{ color: 'var(--text-muted)' }} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div ref={observerTarget} className="py-7 flex justify-center">
            {isFetchingNextPage ? (
              <div className="flex items-center gap-2" style={{ color: 'var(--accent-indigo)' }}>
                <Loader2 size={20} className="animate-spin" />
                <span className="text-xs font-semibold">Loading more concerts...</span>
              </div>
            ) : hasNextPage ? (
              <div className="h-4" />
            ) : (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                End of loaded concerts
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default Concerts

import { useState } from 'react'
import {
  TrendingUp, MapPin, DollarSign, Users,
  BarChart3, Zap, Trophy, ArrowRight,
  Star, Ticket, Music2, Activity
} from 'lucide-react'
import PageHeader from '../components/ui/PageHeader'
import ChartContainer from '../components/charts/ChartContainer'
import BarChart from '../components/charts/BarChart'
import LineChart from '../components/charts/LineChart'
import RoGBadge from '../components/ui/RoGBadge'
import { formatNumber, formatCurrency } from '../utils/formatters'
import { useArtists } from '../hooks/useArtists'
import { useConcerts } from '../hooks/useConcerts'
import {
  useAutoPredict,
  useMadGrowth,
  useMadDemand,
  useMadPopularity,
  useMadLlmPrediction,
  useMadVenueCapacity,
} from '../hooks/usePredictions'

const TABS = ['Profitability Predictor', 'Artist Comparison']

const CITIES = [
  { name: 'Mumbai', multiplier: 1.4, demand: 92, population: 20700000 },
  { name: 'Delhi', multiplier: 1.3, demand: 88, population: 32900000 },
  { name: 'Bangalore', multiplier: 1.2, demand: 84, population: 13200000 },
  { name: 'Chennai', multiplier: 1.0, demand: 76, population: 11200000 },
  { name: 'Kolkata', multiplier: 0.9, demand: 72, population: 14900000 },
  { name: 'Hyderabad', multiplier: 1.1, demand: 79, population: 10500000 },
  { name: 'Pune', multiplier: 1.0, demand: 74, population: 7400000 },
  { name: 'Ahmedabad', multiplier: 0.9, demand: 68, population: 8400000 },
]

// Predict revenue for an artist at a city based on historical concert data
function predictRevenue(artist, city, artistConcerts = [], venueCapacity = 0) {
  if (!artist || !city) return null

  let avgTicketsSold = 15000
  let avgAtp = 2000
  if (artistConcerts.length > 0) {
    const totalTix = artistConcerts.reduce((s, c) => s + (c.ticketsSold || 0), 0)
    const totalRev = artistConcerts.reduce((s, c) => s + (c.totalRevenue || 0), 0)
    const totalAtp = artistConcerts.reduce((s, c) => s + (c.avgTicketPrice || 0), 0)

    avgTicketsSold = Math.floor(totalTix / artistConcerts.length) || 15000
    avgAtp = (totalAtp / artistConcerts.length) || (totalRev / totalTix) || 2000
  }

  const defaultCapacity = Math.floor(avgTicketsSold * 1.2 * city.multiplier)
  const capacity = venueCapacity > 0 ? venueCapacity : defaultCapacity
  const ticketsSold = capacity > 0
    ? Math.min(capacity, Math.floor(avgTicketsSold * city.multiplier))
    : Math.floor(avgTicketsSold * city.multiplier)
  const sellThrough = capacity > 0 ? Math.min(ticketsSold / capacity, 0.99) : 0

  const atp = avgAtp * city.multiplier
  const ticketRevenue = ticketsSold * atp
  const sponsorRevenue = ticketRevenue * 0.18 * (city.demand / 100)
  const totalRevenue = ticketRevenue + sponsorRevenue
  const roi = totalRevenue > 0 ? ((totalRevenue - totalRevenue * 0.45) / (totalRevenue * 0.45)) * 100 : 0

  const popularityScore = Math.min(Math.round(city.demand * 0.6 + (ticketsSold / 50000) * 40), 99)

  return {
    adjustedCap: capacity,
    ticketsSold, atp,
    ticketRevenue, sponsorRevenue, totalRevenue,
    sellThrough: sellThrough * 100, roi, popularityScore,
    demandScore: city.demand,
  }
}

function predictionDate() {
  const date = new Date()
  date.setDate(date.getDate() + 30)
  return date.toISOString().slice(0, 10)
}

function applyModelPrediction(fallback, model) {
  if (!fallback || !model?.predicted_revenue) return fallback

  const capacity = Number(model.inputs?.venue_capacity || fallback.adjustedCap || 0)
  const atp = Number(model.inputs?.avg_ticket_price || fallback.atp || 0)
  const totalRevenue = Number(model.predicted_revenue || 0)
  const ticketsSold = capacity > 0 && atp > 0
    ? Math.min(capacity, Math.round(totalRevenue / atp))
    : fallback.ticketsSold
  const sellThrough = capacity > 0 ? (ticketsSold / capacity) * 100 : fallback.sellThrough
  const estimatedCost = totalRevenue * 0.45

  return {
    ...fallback,
    adjustedCap: capacity || fallback.adjustedCap,
    ticketsSold,
    atp: atp || fallback.atp,
    ticketRevenue: totalRevenue,
    sponsorRevenue: 0,
    totalRevenue,
    sellThrough,
    roi: estimatedCost > 0 ? ((totalRevenue - estimatedCost) / estimatedCost) * 100 : fallback.roi,
    popularityScore: Math.min(99, Math.round(Number(model.demand_score_used || fallback.popularityScore))),
    demandScore: Math.round(Number(model.demand_score_used || fallback.demandScore)),
    confidence: Math.round(Number(model.confidence || 0) * 100),
    lowerBound: Number(model.lower_bound || 0),
    upperBound: Number(model.upper_bound || 0),
    modelSource: model.model_source || 'mad_analytics',
    currency: model.currency || 'INR',
    totalRevenueUsd: Number(model.predicted_revenue_usd || 0),
    exchangeRate: Number(model.exchange_rate || 1),
  }
}

// Score bar component
function ScoreBar({ label, value, max = 100, color }) {
  return (
    <div>
      <div className="flex justify-between mb-1">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
        <span className="text-xs font-bold" style={{ color }}>{value}{max === 100 ? '%' : ''}</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
        <div
          className="h-full rounded-full transition-all duration-1000"
          style={{ width: `${(value / max) * 100}%`, background: `linear-gradient(90deg, ${color}88, ${color})` }}
        />
      </div>
    </div>
  )
}

// Stat box
function StatBox({ label, value, sub, color, delay = 0 }) {
  return (
    <div className="glass-card p-4 animate-fade-up"
      style={{ animationDelay: `${delay}ms`, animationFillMode: 'both', opacity: 0 }}>
      <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{label}</p>
      <p className="font-display font-bold text-xl" style={{ color: color || 'var(--text-primary)' }}>{value}</p>
      {sub && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub}</p>}
    </div>
  )
}

// ── PROFITABILITY PREDICTOR ──
function ProfitabilityPredictor({ artists, concerts }) {
  const [selectedArtist, setArtist] = useState('')
  const [selectedCity, setCity] = useState('')
  const [selectedVenue, setVenue] = useState('')

  const artist = artists.find(a => a.id === selectedArtist)
  const city = CITIES.find(c => c.name === selectedCity)

  const venueOptions = selectedCity
    ? Array.from(new Set(concerts
      .filter(c => c.city === selectedCity && c.venue)
      .map(c => c.venue))).sort()
    : []

  const selectedVenueData = selectedVenue
    ? concerts.find(c => c.city === selectedCity && c.venue === selectedVenue)
    : null

  const artistConcerts = concerts.filter(c => c.artistId === selectedArtist)
  const fallbackPred = predictRevenue(artist, city, artistConcerts, selectedVenueData?.capacity)
  const venueName = selectedVenue || (city ? `${city.name} Arena` : '')
  const venueCapacityValue = selectedVenueData?.capacity || fallbackPred?.adjustedCap

  const modelPrediction = useAutoPredict(selectedArtist, selectedCity, venueCapacityValue, Boolean(selectedArtist && selectedCity), {
    artistName: artist?.name,
    country: 'India',
    avgTicketPrice: fallbackPred?.atp,
    eventDate: predictionDate(),
    venueName,
    venueType: 'arena',
  })
  const pred = applyModelPrediction(fallbackPred, modelPrediction.data)
  // Increment 2b: only a REAL ML revenue prediction may drive the revenue UI.
  // fallbackPred/predictRevenue are kept for safety but never displayed when a
  // real prediction is absent (no fabricated revenue shown).
  const hasModel = Boolean(modelPrediction.data?.predicted_revenue)
  const revenueLoading = modelPrediction.isFetching
  const growth = useMadGrowth(selectedArtist, Boolean(selectedArtist))
  const demand = useMadDemand(selectedArtist, selectedCity, Boolean(selectedArtist && selectedCity), { country: 'India', targetDate: predictionDate() })
  const popularity = useMadPopularity(selectedArtist, Boolean(selectedArtist))
  const llmPrediction = useMadLlmPrediction(selectedArtist, selectedCity, venueCapacityValue, Boolean(selectedArtist && selectedCity), {
    artistName: artist?.name,
    venueName,
    venueType: 'arena',
  })
  const venueCapacity = useMadVenueCapacity(venueName, selectedCity, Boolean(selectedCity), {
    venueType: 'arena',
    suppliedCapacity: venueCapacityValue,
  })

  // Validated Risk & Confidence come straight from the demand engine
  // (demand.data.risk / demand.data.confidence). No frontend fabrication.
  const riskLevel = demand.data?.risk?.level
  const riskColor = riskLevel === 'High' ? 'var(--accent-red)'
    : riskLevel === 'Medium' ? 'var(--accent-gold)'
    : riskLevel === 'Low' ? 'var(--accent-green)'
    : 'var(--text-muted)'

  // Revenue is heuristic when the engine returns the rule-based fallback
  // importances (no supervised model trained). Those keys never appear in a
  // trained-model response, so they are a reliable heuristic-mode signal.
  const revenueImportances = modelPrediction.data?.feature_importances || {}
  const revenueIsHeuristic = hasModel && ('seasonality' in revenueImportances || 'artist_tier' in revenueImportances)

  // City comparison for selected artist
  const cityComparison = artist
    ? CITIES.map(c => ({
      name: c.name,
      revenue: predictRevenue(artist, c, artistConcerts)?.totalRevenue || 0,
    })).sort((a, b) => b.revenue - a.revenue)
    : []

  return (
    <div>
      {/* Selector */}
      <div className="glass-card p-5 mb-6 animate-fade-up">
        <h3 className="font-display font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
          Configure Prediction
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-xs font-semibold uppercase tracking-widest block mb-2"
              style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
              Select Artist
            </label>
            <select
              value={selectedArtist}
              onChange={e => setArtist(e.target.value)}
              className="w-full rounded-xl px-4 py-3 text-sm outline-none transition-all duration-200"
              style={{
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', fontFamily: 'Satoshi'
              }}
            >
              <option value="">Choose an artist...</option>
              {artists.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-widest block mb-2"
              style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
              Select City
            </label>
            <select
              value={selectedCity}
              onChange={e => {
                setCity(e.target.value)
                setVenue('')
              }}
              className="w-full rounded-xl px-4 py-3 text-sm outline-none transition-all duration-200"
              style={{
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', fontFamily: 'Satoshi'
              }}
            >
              <option value="">Choose a city...</option>
              {CITIES.map(c => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-widest block mb-2"
              style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
              Select Venue
            </label>
            <select
              value={selectedVenue}
              onChange={e => setVenue(e.target.value)}
              disabled={!selectedCity}
              className="w-full rounded-xl px-4 py-3 text-sm outline-none transition-all duration-200"
              style={{
                background: selectedCity ? 'var(--bg-secondary)' : 'rgba(148,163,184,0.08)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)', fontFamily: 'Satoshi'
              }}
            >
              <option value="">{selectedCity ? 'Choose a venue...' : 'Select city first'}</option>
              {venueOptions.map(venue => (
                <option key={venue} value={venue}>{venue}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Empty state */}
      {!pred && (
        <div className="glass-card p-16 text-center animate-fade-up">
          <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center"
            style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)' }}>
            <Zap size={28} style={{ color: 'var(--accent-indigo)' }} />
          </div>
          <h3 className="font-display font-semibold text-lg mb-2" style={{ color: 'var(--text-primary)' }}>
            Select an Artist & City
          </h3>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Our AI model will predict revenue, ticket demand, and ROI
          </p>
        </div>
      )}

      {/* Results */}
      {pred && artist && city && (
        <>
          {/* Header */}
          <div className="flex items-center gap-3 mb-4 animate-fade-up">
            <img src={artist.photo} alt={artist.name}
              className="w-12 h-12 rounded-xl object-cover"
              style={{ border: '2px solid var(--border-strong)' }} />
            <div>
              <p className="font-display font-bold" style={{ color: 'var(--text-primary)' }}>
                {artist.name} <span style={{ color: 'var(--text-muted)' }}>in</span> {city.name}{selectedVenue ? ` · ${selectedVenue}` : ''}
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Predicted performance analysis
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2 px-3 py-1.5 rounded-xl"
              style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)' }}>
              <Zap size={13} style={{ color: 'var(--accent-indigo)' }} />
              <span className="text-xs font-semibold" style={{ color: 'var(--accent-indigo)' }}>
                {revenueLoading ? 'Running Model' : hasModel ? (revenueIsHeuristic ? 'MAD Analytics · Heuristic Estimate' : 'MAD Analytics') : 'Analytics Unavailable'}
              </span>
            </div>
          </div>

          {/* Revenue: real model KPIs, a loading state, or an explicit
              unavailable state — never the fabricated fallback numbers. */}
          {revenueLoading ? (
            <div className="glass-card p-6 mb-6 text-center animate-fade-up">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Running revenue model…</p>
            </div>
          ) : hasModel ? (
            /* Success — existing KPI grid, unchanged */
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
              <StatBox label="Predicted Revenue" value={formatCurrency(pred.totalRevenue, pred.currency)} sub={revenueIsHeuristic ? 'Heuristic estimate' : undefined} color="var(--accent-gold)" delay={0} />
              <StatBox label="Est. Tickets Sold" value={formatNumber(pred.ticketsSold)} color="var(--accent-indigo)" delay={80} />
              <StatBox label="Avg. Ticket Price" value={formatCurrency(pred.atp, pred.currency)} color="var(--accent-green)" delay={160} />
              <StatBox
                label={pred.modelSource ? 'Model Confidence' : 'Projected ROI'}
                value={pred.modelSource ? `${pred.confidence}%` : `${pred.roi.toFixed(1)}%`}
                color={pred.modelSource || pred.roi > 50 ? 'var(--accent-green)' : 'var(--accent-gold)'}
                delay={240}
              />
            </div>
          ) : (
            /* Unavailable — no fabricated revenue is shown */
            <div className="glass-card p-6 mb-6 animate-fade-up"
              style={{ border: '1px solid rgba(245,158,11,0.25)', background: 'rgba(245,158,11,0.06)' }}>
              <div className="flex items-center gap-2 mb-1">
                <Zap size={15} style={{ color: 'var(--accent-gold)' }} />
                <span className="text-sm font-bold" style={{ color: 'var(--accent-gold)' }}>
                  Revenue prediction unavailable
                </span>
              </div>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                The analytics model didn’t return a revenue prediction (the service may be
                starting up, or required concert/venue inputs are missing). No estimated
                revenue is shown. Live signals below remain available.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-6">
            <StatBox
              label="Growth Score"
              value={growth.data ? `${growth.data.cross_platform_score?.toFixed?.(1) ?? growth.data.cross_platform_score}` : '—'}
              sub={growth.data?.platforms?.[0] ? `${growth.data.platforms[0].platform} ${growth.data.platforms[0].rog_30d?.toFixed?.(1) ?? growth.data.platforms[0].rog_30d}%` : 'No growth data'}
              color="var(--accent-indigo)"
            />
            <StatBox
              label="Demand Score"
              value={demand.data ? `${demand.data.score?.toFixed?.(1) ?? demand.data.score}` : '—'}
              sub={demand.data?.components?.momentum != null ? `Momentum ${demand.data.components.momentum.toFixed?.(1) ?? demand.data.components.momentum}` : 'No demand data'}
              color="var(--accent-gold)"
            />
            <StatBox
              label="Popularity"
              value={popularity.data ? `${popularity.data.popularity_score?.toFixed?.(1) ?? popularity.data.popularity_score}` : '—'}
              sub={popularity.data?.platform_weights ? 'Entropy weighted' : 'No popularity data'}
              color="var(--accent-green)"
            />
            <StatBox
              label="Risk"
              value={riskLevel ?? '—'}
              sub={demand.data?.risk ? `Index ${Math.round((demand.data.risk.score ?? 0) * 100)} / 100` : 'No risk data'}
              color={riskColor}
            />
            <StatBox
              label="Confidence"
              value={demand.data?.confidence ?? '—'}
              sub={demand.data?.confidence ? 'Signal completeness' : 'No confidence data'}
              color="var(--accent-indigo)"
            />
            <StatBox
              label="LLM Revenue"
              value={llmPrediction.data ? formatCurrency(llmPrediction.data.total_revenue, llmPrediction.data.currency) : '—'}
              sub={llmPrediction.data ? `${llmPrediction.data.tickets_sold} tickets` : 'No LLM data'}
              color="var(--accent-gold)"
            />
            <StatBox
              label="Venue Capacity"
              value={venueCapacity.data ? formatNumber(venueCapacity.data.capacity) : '—'}
              sub={venueCapacity.data ? venueCapacity.data.status : 'No venue data'}
              color="var(--accent-indigo)"
            />
          </div>

          {/* Score bars, ROI verdict, revenue breakdown and city comparison are
              model-derived — rendered only when a REAL revenue prediction exists.
              (Unchanged success layout; simply gated so no fabricated revenue shows.) */}
          {hasModel && (
          <>
          {/* Score Bars + Revenue Breakdown */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
            <div className="glass-card p-5 animate-fade-up" style={{ animationDelay: '100ms', animationFillMode: 'both', opacity: 0 }}>
              <h3 className="font-display font-semibold text-sm mb-4" style={{ color: 'var(--text-primary)' }}>
                Performance Scores
              </h3>
              <div className="space-y-4">
                <ScoreBar label="Popularity Score" value={pred.popularityScore} color="#818CF8" />
                <ScoreBar label="City Demand Index" value={pred.demandScore} color="#FBBF24" />
                <ScoreBar label="Sell-Through Rate" value={Math.round(pred.sellThrough)} color="#34D399" />
                <ScoreBar label="Revenue Confidence" value={Math.round(pred.confidence ?? 0)} color="#F87171" />
              </div>

              {/* Verdict */}
              <div className="mt-5 p-3 rounded-xl"
                style={{
                  background: pred.roi > 60
                    ? 'rgba(16,185,129,0.08)' : pred.roi > 30
                      ? 'rgba(245,158,11,0.08)' : 'rgba(239,68,68,0.08)',
                  border: `1px solid ${pred.roi > 60 ? 'rgba(16,185,129,0.2)' : pred.roi > 30 ? 'rgba(245,158,11,0.2)' : 'rgba(239,68,68,0.2)'}`
                }}>
                <div className="flex items-center gap-2 mb-1">
                  <Trophy size={14} style={{ color: pred.roi > 60 ? 'var(--accent-green)' : pred.roi > 30 ? 'var(--accent-gold)' : 'var(--accent-red)' }} />
                  <span className="text-xs font-bold" style={{ color: pred.roi > 60 ? 'var(--accent-green)' : pred.roi > 30 ? 'var(--accent-gold)' : 'var(--accent-red)' }}>
                    {pred.roi > 60 ? 'Highly Profitable' : pred.roi > 30 ? 'Moderately Profitable' : 'High Risk'}
                  </span>
                </div>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {pred.roi > 60
                    ? `Strong market fit. ${city.name} is an ideal venue for ${artist.name}.`
                    : pred.roi > 30
                      ? `Decent potential. Consider mid-size venues to reduce risk.`
                      : `Lower demand signals. Consider a smaller venue or different timing.`}
                </p>
              </div>
            </div>

            {/* Revenue breakdown */}
            <ChartContainer
              title={pred.modelSource ? 'Prediction Range' : 'Revenue Breakdown'}
              subtitle={pred.modelSource ? 'Lower, predicted and upper model bounds' : 'Ticket vs sponsor contribution'}
              delay={180}
            >
              <BarChart
                data={pred.modelSource
                  ? [
                    { name: 'Lower Bound', value: Math.round(pred.lowerBound) },
                    { name: 'Prediction', value: Math.round(pred.totalRevenue) },
                    { name: 'Upper Bound', value: Math.round(pred.upperBound) },
                  ]
                  : [
                    { name: 'Ticket Revenue', value: Math.round(pred.ticketRevenue) },
                    { name: 'Sponsor Revenue', value: Math.round(pred.sponsorRevenue) },
                  ]}
                xKey="name"
                layout="horizontal"
                bars={[{ key: 'value', label: 'Revenue (INR)', color: '#818CF8' }]}
                height={220}
              />
            </ChartContainer>
          </div>

          {/* City Comparison */}
          {cityComparison.length > 0 && (
            <ChartContainer
              title={`Best Cities for ${artist.name}`}
              subtitle="Predicted revenue across all cities — ranked"
              delay={200}
            >
              <BarChart
                data={cityComparison}
                xKey="name"
                layout="horizontal"
                bars={[{ key: 'revenue', label: 'Predicted Revenue', color: '#FBBF24' }]}
                multiColor={false}
                height={260}
              />
            </ChartContainer>
          )}
          </>
          )}
        </>
      )}
    </div>
  )
}

// ── ARTIST COMPARISON ──
function ArtistComparison({ artists, concerts }) {
  const CONCERT_CITIES = ['All Cities', ...Array.from(new Set(concerts.map(c => c.city))).sort()]

  const [artistA, setArtistA] = useState('')
  const [artistB, setArtistB] = useState('')
  const [selectedCity, setSelCity] = useState('All Cities')
  const [selectedVenue, setSelVenue] = useState('All Venues')

  const cityVenues = selectedCity === 'All Cities'
    ? Array.from(new Set(concerts.map(c => c.venue).filter(Boolean))).sort()
    : Array.from(new Set(concerts.filter(c => c.city === selectedCity && c.venue).map(c => c.venue))).sort()
  const venueOptions = ['All Venues', ...cityVenues]

  const a = artists.find(x => x.id === artistA)
  const b = artists.find(x => x.id === artistB)

  const concertsA = concerts.filter(c =>
    c.artistId === artistA &&
    (selectedCity === 'All Cities' || c.city === selectedCity) &&
    (selectedVenue === 'All Venues' || c.venue === selectedVenue)
  )
  const concertsB = concerts.filter(c =>
    c.artistId === artistB &&
    (selectedCity === 'All Cities' || c.city === selectedCity) &&
    (selectedVenue === 'All Venues' || c.venue === selectedVenue)
  )

  const getStats = (artist, artistConcerts) => {
    if (!artist) return null
    const followersValues = Object.values(artist.followers || {})
    const rogValues = Object.values(artist.rog || {})
    return {
      totalFollowers: followersValues.reduce((s, v) => s + v, 0),
      avgRoG: rogValues.reduce((s, v) => s + v, 0) / (rogValues.length || 1),
      totalRevenue: artistConcerts.reduce((s, c) => s + (c.totalRevenue || 0), 0),
      totalTickets: artistConcerts.reduce((s, c) => s + (c.ticketsSold || 0), 0),
      concertCount: artistConcerts.length,
      topPlatform: Object.entries(artist.followers || {}).sort((x, y) => y[1] - x[1])[0] || ['Unknown', 0],
    }
  }

  const statsA = getStats(a, concertsA)
  const statsB = getStats(b, concertsB)

  const comparisonRows = statsA && statsB ? [
    {
      label: 'Total Followers', a: formatNumber(statsA.totalFollowers), b: formatNumber(statsB.totalFollowers),
      winner: statsA.totalFollowers > statsB.totalFollowers ? 'a' : 'b'
    },
    {
      label: 'Avg. RoG', a: `${statsA.avgRoG.toFixed(1)}%`, b: `${statsB.avgRoG.toFixed(1)}%`,
      winner: statsA.avgRoG > statsB.avgRoG ? 'a' : 'b'
    },
    {
      label: 'Total Revenue', a: formatCurrency(statsA.totalRevenue), b: formatCurrency(statsB.totalRevenue),
      winner: statsA.totalRevenue > statsB.totalRevenue ? 'a' : 'b'
    },
    {
      label: 'Tickets Sold', a: formatNumber(statsA.totalTickets), b: formatNumber(statsB.totalTickets),
      winner: statsA.totalTickets > statsB.totalTickets ? 'a' : 'b'
    },
    {
      label: 'Concerts', a: statsA.concertCount, b: statsB.concertCount,
      winner: statsA.concertCount > statsB.concertCount ? 'a' : 'b'
    },
    {
      label: 'Top Platform', a: statsA.topPlatform[0], b: statsB.topPlatform[0],
      winner: statsA.topPlatform[1] > statsB.topPlatform[1] ? 'a' : 'b'
    },
  ] : []

  // Radar-style comparison data for bar chart
  const comparisonChartData = statsA && statsB ? [
    { metric: 'Followers', a: statsA.totalFollowers / 1000000, b: statsB.totalFollowers / 1000000 },
    { metric: 'RoG %', a: statsA.avgRoG, b: statsB.avgRoG },
    { metric: 'Revenue M', a: statsA.totalRevenue / 1000000, b: statsB.totalRevenue / 1000000 },
    { metric: 'Tickets K', a: statsA.totalTickets / 1000, b: statsB.totalTickets / 1000 },
  ] : []

  return (
    <div>
      {/* Artist selectors */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        {/* Artist A */}
        <div className="glass-card p-5 animate-fade-up" style={{ animationFillMode: 'both', opacity: 0, borderLeft: '3px solid #818CF8' }}>
          <label className="text-xs font-semibold uppercase tracking-widest block mb-3"
            style={{ color: '#818CF8', fontSize: '10px' }}>
            Artist A
          </label>
          <select
            value={artistA}
            onChange={e => setArtistA(e.target.value)}
            className="w-full rounded-xl px-4 py-3 text-sm outline-none mb-3"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'Satoshi' }}
          >
            <option value="">Choose artist A...</option>
            {artists.map(x => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
          {a && (
            <div className="flex items-center gap-3">
              <img src={a.photo} alt={a.name} className="w-10 h-10 rounded-xl object-cover" />
              <div>
                <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{a.name}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{a.genre} Â· {a.nationality}</p>
              </div>
            </div>
          )}
        </div>

        {/* Artist B */}
        <div className="glass-card p-5 animate-fade-up delay-1" style={{ animationFillMode: 'both', opacity: 0, borderLeft: '3px solid #FBBF24' }}>
          <label className="text-xs font-semibold uppercase tracking-widest block mb-3"
            style={{ color: '#FBBF24', fontSize: '10px' }}>
            Artist B
          </label>
          <select
            value={artistB}
            onChange={e => setArtistB(e.target.value)}
            className="w-full rounded-xl px-4 py-3 text-sm outline-none mb-3"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'Satoshi' }}
          >
            <option value="">Choose artist B...</option>
            {artists.map(x => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
          {b && (
            <div className="flex items-center gap-3">
              <img src={b.photo} alt={b.name} className="w-10 h-10 rounded-xl object-cover" />
              <div>
                <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{b.name}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{b.genre} · {b.nationality}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* City filter */}
      <div className="glass-card p-4 mb-6 animate-fade-up" style={{ animationDelay: '80ms', animationFillMode: 'both', opacity: 0 }}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="flex items-center gap-2">
            <MapPin size={14} style={{ color: 'var(--accent-gold)' }} />
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
              City & Venue Filters
            </span>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-1">
            <select
              value={selectedCity}
              onChange={e => {
                setSelCity(e.target.value)
                setSelVenue('All Venues')
              }}
              className="flex-1 rounded-xl px-4 py-2.5 text-sm outline-none transition-all duration-200"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'Satoshi', maxWidth: '260px' }}
            >
              {CONCERT_CITIES.map(city => (
                <option key={city} value={city} style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
                  {city}
                </option>
              ))}
            </select>
            <select
              value={selectedVenue}
              onChange={e => setSelVenue(e.target.value)}
              className="flex-1 rounded-xl px-4 py-2.5 text-sm outline-none transition-all duration-200"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'Satoshi', maxWidth: '260px' }}
              disabled={cityVenues.length === 0}
            >
              {venueOptions.map(venue => (
                <option key={venue} value={venue} style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
                  {venue}
                </option>
              ))}
            </select>
          </div>
          {(selectedCity !== 'All Cities' || selectedVenue !== 'All Venues') && (
            <span className="text-xs px-2.5 py-1 rounded-full font-semibold"
              style={{ background: 'rgba(245,158,11,0.12)', color: 'var(--accent-gold)', border: '1px solid rgba(245,158,11,0.2)' }}>
              {selectedCity !== 'All Cities' ? `City: ${selectedCity}` : 'All Cities'}{selectedVenue !== 'All Venues' ? ` · Venue: ${selectedVenue}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* Empty state – no artists selected */}
      {(!a || !b) && (
        <div className="glass-card p-16 text-center animate-fade-up">
          <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center"
            style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)' }}>
            <BarChart3 size={28} style={{ color: 'var(--accent-gold)' }} />
          </div>
          <h3 className="font-display font-semibold text-lg mb-2" style={{ color: 'var(--text-primary)' }}>
            Select Two Artists to Compare
          </h3>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Head-to-head stats, revenue, followers and RoG side by side
          </p>
        </div>
      )}

      {/* Empty state – city has no data for one or both artists */}
      {a && b && selectedCity !== 'All Cities' && (concertsA.length === 0 || concertsB.length === 0) && (
        <div className="glass-card p-14 text-center animate-fade-up">
          <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
            <MapPin size={28} style={{ color: 'var(--accent-red)' }} />
          </div>
          <h3 className="font-display font-semibold text-lg mb-2" style={{ color: 'var(--text-primary)' }}>
            No data available for {selectedCity}
          </h3>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {concertsA.length === 0 && concertsB.length === 0
              ? `Neither ${a.name} nor ${b.name} has concerts in ${selectedCity}.`
              : concertsA.length === 0
                ? `${a.name} has no concerts in ${selectedCity}.`
                : `${b.name} has no concerts in ${selectedCity}.`}
          </p>
          <button onClick={() => setSelCity('All Cities')}
            className="mt-4 text-xs px-4 py-2 rounded-xl font-semibold transition-all duration-200"
            style={{ background: 'rgba(99,102,241,0.1)', color: 'var(--accent-indigo)', border: '1px solid rgba(99,102,241,0.2)' }}>
            Clear city filter
          </button>
        </div>
      )}

      {/* Comparison Results */}
      {a && b && statsA && statsB && !(selectedCity !== 'All Cities' && (concertsA.length === 0 || concertsB.length === 0)) && (
        <>
          {/* Head to head table */}
          <div className="glass-card overflow-hidden mb-4 animate-fade-up">
            {/* Header */}
            <div className="grid grid-cols-3 p-4"
              style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
              <div className="flex items-center gap-2">
                <img src={a.photo} className="w-8 h-8 rounded-lg object-cover" alt={a.name} />
                <span className="font-display font-bold text-sm" style={{ color: '#818CF8' }}>{a.name}</span>
              </div>
              <div className="text-center">
                <span className="text-xs font-semibold uppercase tracking-widest"
                  style={{ color: 'var(--text-muted)', fontSize: '10px' }}>VS</span>
              </div>
              <div className="flex items-center gap-2 justify-end">
                <span className="font-display font-bold text-sm" style={{ color: '#FBBF24' }}>{b.name}</span>
                <img src={b.photo} className="w-8 h-8 rounded-lg object-cover" alt={b.name} />
              </div>
            </div>

            {/* Rows */}
            {comparisonRows.map((row, i) => (
              <div key={i} className="grid grid-cols-3 px-4 py-3"
                style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg-secondary)' }}>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm"
                    style={{ color: row.winner === 'a' ? '#818CF8' : 'var(--text-secondary)' }}>
                    {row.a}
                  </span>
                  {row.winner === 'a' && (
                    <Trophy size={12} style={{ color: '#818CF8' }} />
                  )}
                </div>
                <div className="text-center">
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{row.label}</span>
                </div>
                <div className="flex items-center gap-2 justify-end">
                  {row.winner === 'b' && (
                    <Trophy size={12} style={{ color: '#FBBF24' }} />
                  )}
                  <span className="font-semibold text-sm"
                    style={{ color: row.winner === 'b' ? '#FBBF24' : 'var(--text-secondary)' }}>
                    {row.b}
                  </span>
                </div>
              </div>
            ))}

            {/* Winner Banner */}
            <div className="p-4"
              style={{
                background: statsA.totalRevenue > statsB.totalRevenue
                  ? 'linear-gradient(135deg, rgba(129,140,248,0.1), transparent)'
                  : 'linear-gradient(135deg, rgba(251,191,36,0.1), transparent)'
              }}>
              <div className="flex items-center gap-2">
                <Star size={16} style={{ color: 'var(--accent-gold)' }} />
                <span className="font-display font-bold text-sm" style={{ color: 'var(--text-primary)' }}>
                  Overall Winner:
                </span>
                <span className="font-bold text-sm"
                  style={{ color: statsA.totalRevenue > statsB.totalRevenue ? '#818CF8' : '#FBBF24' }}>
                  {statsA.totalRevenue > statsB.totalRevenue ? a.name : b.name}
                </span>
                <span className="text-xs ml-1" style={{ color: 'var(--text-muted)' }}>
                  — higher revenue performance
                </span>
              </div>
            </div>
          </div>

          {/* Side by side charts */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <ChartContainer
              title="Head-to-Head Metrics"
              subtitle="Normalised comparison across key indicators"
              delay={100}
            >
              <BarChart
                data={comparisonChartData}
                xKey="metric"
                layout="horizontal"
                bars={[
                  { key: 'a', label: a.name, color: '#818CF8' },
                  { key: 'b', label: b.name, color: '#FBBF24' },
                ]}
                height={260}
              />
            </ChartContainer>

            {/* Platform followers side by side */}
            <ChartContainer
              title="Platform Follower Breakdown"
              subtitle="Followers per platform comparison"
              delay={180}
            >
              <BarChart
                data={[
                  { platform: 'Instagram', a: a.followers.instagram, b: b.followers.instagram },
                  { platform: 'YouTube', a: a.followers.youtube, b: b.followers.youtube },
                  { platform: 'Spotify', a: a.followers.spotify, b: b.followers.spotify },
                ]}
                xKey="platform"
                layout="horizontal"
                bars={[
                  { key: 'a', label: a.name, color: '#818CF8' },
                  { key: 'b', label: b.name, color: '#FBBF24' },
                ]}
                height={260}
              />
            </ChartContainer>
          </div>
        </>
      )}
    </div>
  )
}

// ── MAIN PAGE ──
function Analysis() {
  const [activeTab, setTab] = useState('Profitability Predictor')

  const { data: artists, isLoading: loadingArtists, error: errArtists } = useArtists()
  const { data: concerts, isLoading: loadingConcerts, error: errConcerts } = useConcerts()

  if (loadingArtists || loadingConcerts) {
    return (
      <div className="relative p-8 text-center" style={{ color: 'var(--text-muted)' }}>
        Loading analysis data...
      </div>
    )
  }

  if (errArtists || errConcerts) {
    return (
      <div className="relative p-8 text-center" style={{ color: 'var(--accent-red)' }}>
        Failed to load analysis data.
      </div>
    )
  }

  const safeArtists = artists || []
  const safeConcerts = concerts || []

  return (
    <div className="relative">
      {/* Ambient glows */}
      <div className="fixed top-32 right-32 w-80 h-80 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(245,158,11,0.06), transparent 70%)', filter: 'blur(40px)' }} />

      <PageHeader
        title="Analysis"
        subtitle="Revenue prediction and artist comparison engine"
      />

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-2xl mb-6 w-fit"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setTab(tab)}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200"
            style={activeTab === tab ? {
              background: 'linear-gradient(135deg, #6366F1, #818CF8)',
              color: '#fff',
              boxShadow: '0 4px 16px rgba(99,102,241,0.3)'
            } : {
              color: 'var(--text-muted)',
              background: 'transparent'
            }}
          >
            {tab === 'Profitability Predictor' ? '🎯 ' : '⚔️ '}{tab}
          </button>
        ))}
      </div>

      {activeTab === 'Profitability Predictor' && <ProfitabilityPredictor artists={safeArtists} concerts={safeConcerts} />}
      {activeTab === 'Artist Comparison' && <ArtistComparison artists={safeArtists} concerts={safeConcerts} />}
    </div>
  )
}

export default Analysis

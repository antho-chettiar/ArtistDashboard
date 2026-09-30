import { useState, useEffect } from 'react'
import {
  TrendingUp, MapPin, DollarSign, Users,
  BarChart3, Zap, Trophy, ArrowRight,
  Star, Ticket, Music2, Activity, Compass
} from 'lucide-react'
import PageHeader from '../components/ui/PageHeader'
import ChartContainer from '../components/charts/ChartContainer'
import BarChart from '../components/charts/BarChart'
import LineChart from '../components/charts/LineChart'
import { useArtists } from '../hooks/useArtists'
import { useConcerts } from '../hooks/useConcerts'
import { useArtistScore } from '../hooks/useViberate'
import {
  useRepeatVisitRate,
  useCityAudiencePresence,
  useFeasibilityForCities,
} from '../hooks/usePredictions'
// NOTE: useMadGrowth (Growth/RoG) is intentionally no longer imported here — the
// Growth Score tile was removed from this screen by product decision (RoG is
// archived, not deleted; see mad_analytics/legacy/growth_calculator.py). The
// hook itself is left intact in usePredictions.js in case it's needed again.

// Profitability Predictor tab removed (2026-09-29): it surfaced
// mad_analytics/revenue/predictor.py, an unvalidated heuristic (no real
// ticket-sales data backs any of its constants) that product decided was
// out of scope for this version. The Python module and its /ml/revenue
// route are left in place, unlinked, for when a real, data-backed revenue
// model is built -- only the UI surface is removed here.
const TABS = ['Artist Comparison', 'Where To Tour Next']

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

// Stat box
function StatBox({ label, value, sub, color, delay = 0, badge }) {
  return (
    <div className="glass-card p-4 animate-fade-up"
      style={{ animationDelay: `${delay}ms`, animationFillMode: 'both', opacity: 0 }}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="text-xs uppercase tracking-widest" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{label}</p>
        {badge}
      </div>
      <p className="font-display font-bold text-xl" style={{ color: color || 'var(--text-primary)' }}>{value}</p>
      {sub && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub}</p>}
    </div>
  )
}

// ── ARTIST COMPARISON ──
function ArtistComparison({ artists, concerts }) {
  // India only -- this roster is India-only right now, but a stray non-Indian
  // concert record (e.g. the one Abu Dhabi show) would otherwise leak into
  // this dropdown as a selectable "city" with no Indian booking data behind it.
  const CONCERT_CITIES = ['All Cities', ...Array.from(new Set(concerts.filter(c => c.country === 'India').map(c => c.city))).sort()]

  const [artistA, setArtistA] = useState('')
  const [artistB, setArtistB] = useState('')
  const [selectedCity, setSelCity] = useState('All Cities')

  const a = artists.find(x => x.id === artistA)
  const b = artists.find(x => x.id === artistB)

  // Venue-level filtering removed (2026-09-29): the venue dropdown listed
  // every artist's venues in a city, not just the two being compared, so
  // picking one nearly always showed a false "neither artist has concerts
  // here" -- city is the right granularity for a booking-decision
  // comparison; venue-level detail belongs on Concerts/ConcertDetail.
  const concertsA = concerts.filter(c => c.artistId === artistA && (selectedCity === 'All Cities' || c.city === selectedCity))
  const concertsB = concerts.filter(c => c.artistId === artistB && (selectedCity === 'All Cities' || c.city === selectedCity))

  const citySelected = selectedCity !== 'All Cities'

  // Real, roster-wide signals -- replacing Avg. RoG / Total Revenue / Tickets
  // Sold (2026-09-29 redesign): those three were dead for nearly every artist
  // pair (this app has no real recorded ticket/revenue data for almost any
  // historical concert), so "comparison" was really just "0 vs 0, tie."
  // These four are real and well-covered, checked against the live database:
  // Popularity, Revealed Demand, Repeat Visit Rate, real Concert count.
  const scoreA = useArtistScore(artistA)
  const scoreB = useArtistScore(artistB)
  const repeatA = useRepeatVisitRate(artistA, Boolean(artistA))
  const repeatB = useRepeatVisitRate(artistB, Boolean(artistB))
  // City Audience % only makes sense once a specific city is picked -- see
  // audience_city/scorer.py: coverage is real but artist-dependent and can
  // fluctuate, so `available` (not a fabricated 0%) gates display per artist.
  const audienceA = useCityAudiencePresence(artistA, citySelected ? selectedCity : null, Boolean(artistA) && citySelected)
  const audienceB = useCityAudiencePresence(artistB, citySelected ? selectedCity : null, Boolean(artistB) && citySelected)

  // 'a' | 'b' | 'tie' -- a bare `x > y ? 'a' : 'b'` treats every tie as a B
  // win, which used to fire constantly on this sparse dataset (RoG/Revenue/
  // Tickets are 0 vs 0 for most artist pairs).
  const cmp = (x, y) => (x > y ? 'a' : x < y ? 'b' : 'tie')

  const popularityA = scoreA.data?.latest?.finalScore
  const popularityB = scoreB.data?.latest?.finalScore
  const revealedDemandA = scoreA.data?.latest?.revealedDemandScore
  const revealedDemandB = scoreB.data?.latest?.revealedDemandScore
  const repeatRateA = repeatA.data?.repeat_rate
  const repeatRateB = repeatB.data?.repeat_rate

  const scoresReady = artistA && artistB && !scoreA.isLoading && !scoreB.isLoading
    && !repeatA.isLoading && !repeatB.isLoading

  // aRaw/bRaw carry the plain numeric value alongside the formatted display
  // string -- used to draw each row's inline progress bar (share of a+b)
  // without re-parsing a formatted string back into a number. A row whose
  // value is null/undefined on either side (Revealed Demand: no verified
  // show yet for this artist) is marked noContest for THIS comparison
  // rather than treating the gap as evidence of low demand.
  const comparisonRows = scoresReady ? [
    {
      label: 'Popularity', a: popularityA?.toFixed(1) ?? '—', b: popularityB?.toFixed(1) ?? '—',
      aRaw: popularityA ?? 0, bRaw: popularityB ?? 0,
      winner: popularityA != null && popularityB != null ? cmp(popularityA, popularityB) : 'tie',
      noContest: popularityA == null || popularityB == null,
    },
    {
      label: 'Revealed Demand', a: revealedDemandA?.toFixed(1) ?? 'No verified show', b: revealedDemandB?.toFixed(1) ?? 'No verified show',
      aRaw: revealedDemandA ?? 0, bRaw: revealedDemandB ?? 0,
      winner: revealedDemandA != null && revealedDemandB != null ? cmp(revealedDemandA, revealedDemandB) : 'tie',
      noContest: revealedDemandA == null || revealedDemandB == null,
    },
    {
      label: 'Repeat Visit Rate', a: `${((repeatRateA ?? 0) * 100).toFixed(0)}%`, b: `${((repeatRateB ?? 0) * 100).toFixed(0)}%`,
      aRaw: repeatRateA ?? 0, bRaw: repeatRateB ?? 0,
      winner: cmp(repeatRateA ?? 0, repeatRateB ?? 0),
    },
    {
      label: citySelected ? `Concerts in ${selectedCity}` : 'Concerts', a: concertsA.length, b: concertsB.length,
      aRaw: concertsA.length, bRaw: concertsB.length,
      winner: cmp(concertsA.length, concertsB.length)
    },
  ] : []

  // Overall Winner used to only ever check Total Revenue -- almost always
  // 0 vs 0 on this dataset (real revenue data is sparse), so it silently
  // crowned B nearly every time under a fabricated "higher revenue
  // performance" caption. Now a real aggregate: whoever wins more of the
  // real, contested metrics above; a tie in wins is shown honestly as a tie.
  const contestedRows = comparisonRows.filter(r => !r.noContest)
  const winsA = contestedRows.filter(r => r.winner === 'a').length
  const winsB = contestedRows.filter(r => r.winner === 'b').length
  const overallWinner = winsA === winsB ? 'tie' : (winsA > winsB ? 'a' : 'b')

  return (
    <div>
      {/* Artist selectors */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        {/* Artist A */}
        <div className="glass-card p-5 animate-fade-up" style={{ animationFillMode: 'both', opacity: 0, borderLeft: '3px solid var(--accent-indigo)' }}>
          <label className="text-xs font-semibold uppercase tracking-widest block mb-3"
            style={{ color: 'var(--accent-indigo)', fontSize: '10px' }}>
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
              // Disabled, not filtered out entirely, when already picked as
              // Artist B -- comparing an artist against themselves ties on
              // every metric and isn't a real comparison; the roster still
              // stays visible either way, just not double-selectable.
              <option key={x.id} value={x.id} disabled={x.id === artistB}>{x.name}</option>
            ))}
          </select>
          {a && (
            <div className="flex items-center gap-3">
              <img src={a.photo} alt={a.name} className="w-10 h-10 rounded-xl object-cover" />
              <div>
                <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{a.name}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{a.genre} · {a.nationality}</p>
              </div>
            </div>
          )}
        </div>

        {/* Artist B */}
        <div className="glass-card p-5 animate-fade-up delay-1" style={{ animationFillMode: 'both', opacity: 0, borderLeft: '3px solid var(--accent-gold)' }}>
          <label className="text-xs font-semibold uppercase tracking-widest block mb-3"
            style={{ color: 'var(--accent-gold)', fontSize: '10px' }}>
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
              <option key={x.id} value={x.id} disabled={x.id === artistA}>{x.name}</option>
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

      {/* City filter -- city-level only (see venue-removal note above) */}
      <div className="glass-card p-4 mb-6 animate-fade-up" style={{ animationDelay: '80ms', animationFillMode: 'both', opacity: 0 }}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="flex items-center gap-2">
            <MapPin size={14} style={{ color: 'var(--accent-gold)' }} />
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
              City Filter
            </span>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-1">
            <select
              value={selectedCity}
              onChange={e => setSelCity(e.target.value)}
              className="flex-1 rounded-xl px-4 py-2.5 text-sm outline-none transition-all duration-200"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'Satoshi', maxWidth: '260px' }}
            >
              {CONCERT_CITIES.map(city => (
                <option key={city} value={city} style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
                  {city}
                </option>
              ))}
            </select>
          </div>
          {citySelected && (
            <span className="text-xs px-2.5 py-1 rounded-full font-semibold"
              style={{ background: 'color-mix(in srgb, var(--accent-gold) 12%, transparent)', color: 'var(--accent-gold)', border: '1px solid color-mix(in srgb, var(--accent-gold) 20%, transparent)' }}>
              City: {selectedCity}
            </span>
          )}
        </div>
      </div>

      {/* Empty state – no artists selected */}
      {(!a || !b) && (
        <div className="glass-card p-16 text-center animate-fade-up">
          <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center"
            style={{ background: 'color-mix(in srgb, var(--accent-gold) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-gold) 20%, transparent)' }}>
            <BarChart3 size={28} style={{ color: 'var(--accent-gold)' }} />
          </div>
          <h3 className="font-display font-semibold text-lg mb-2" style={{ color: 'var(--text-primary)' }}>
            Select Two Artists to Compare
          </h3>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Popularity, Revealed Demand, Repeat Visit Rate and real touring history, side by side
          </p>
        </div>
      )}

      {/* Comparison Results -- no longer gated on concerts-in-city being
          non-empty: Popularity/Revealed Demand/Repeat Visit Rate are
          roster-wide real signals, still meaningful even when an artist
          hasn't (yet) played the selected city; that city's own concert
          count is just one honest row among several, not a blocker. */}
      {a && b && scoresReady && (
        <>
          {/* Head to head table */}
          <div className="glass-card overflow-hidden mb-4 animate-fade-up">
            {/* Header */}
            <div className="grid grid-cols-3 p-4"
              style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
              <div className="flex items-center gap-2">
                <img src={a.photo} className="w-8 h-8 rounded-lg object-cover" alt={a.name} />
                <span className="font-display font-bold text-sm" style={{ color: 'var(--accent-indigo)' }}>{a.name}</span>
              </div>
              <div className="text-center">
                <span className="text-xs font-semibold uppercase tracking-widest"
                  style={{ color: 'var(--text-muted)', fontSize: '10px' }}>VS</span>
              </div>
              <div className="flex items-center gap-2 justify-end">
                <span className="font-display font-bold text-sm" style={{ color: 'var(--accent-gold)' }}>{b.name}</span>
                <img src={b.photo} className="w-8 h-8 rounded-lg object-cover" alt={b.name} />
              </div>
            </div>

            {/* Rows -- a thin split progress bar under each contested row
                (share of a+b) puts a real visual on the same row the
                numbers already live on, instead of a separate chart section
                repeating the same four metrics further down the page. */}
            {comparisonRows.map((row, i) => {
              const total = !row.noContest ? Math.abs(row.aRaw) + Math.abs(row.bRaw) : 0
              const aShare = total > 0 ? (Math.abs(row.aRaw) / total) * 100 : 50
              return (
                <div key={i} className="px-4 py-3"
                  style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg-secondary)' }}>
                  <div className="grid grid-cols-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm"
                        style={{ color: row.winner === 'a' ? 'var(--accent-indigo)' : 'var(--text-secondary)' }}>
                        {row.a}
                      </span>
                      {row.winner === 'a' && (
                        <Trophy size={12} style={{ color: 'var(--accent-indigo)' }} />
                      )}
                    </div>
                    <div className="text-center">
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{row.label}</span>
                      {row.winner === 'tie' && !row.noContest && (
                        <span className="block text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Tie</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 justify-end">
                      {row.winner === 'b' && (
                        <Trophy size={12} style={{ color: 'var(--accent-gold)' }} />
                      )}
                      <span className="font-semibold text-sm"
                        style={{ color: row.winner === 'b' ? 'var(--accent-gold)' : 'var(--text-secondary)' }}>
                        {row.b}
                      </span>
                    </div>
                  </div>
                  {!row.noContest && (
                    <div className="flex h-1.5 rounded-full overflow-hidden mt-2" style={{ background: 'var(--border)' }}>
                      <div style={{ width: `${aShare}%`, background: 'var(--accent-indigo)' }} />
                      <div style={{ width: `${100 - aShare}%`, background: 'var(--accent-gold)' }} />
                    </div>
                  )}
                </div>
              )
            })}

            {/* Winner Banner -- a real aggregate (wins across the contested
                rows above), not just whoever has more revenue. Shown
                honestly as a tie when the win count itself ties. */}
            <div className="p-4"
              style={{
                background: overallWinner === 'a'
                  ? 'linear-gradient(135deg, color-mix(in srgb, var(--accent-indigo) 10%, transparent), transparent)'
                  : overallWinner === 'b'
                    ? 'linear-gradient(135deg, color-mix(in srgb, var(--accent-gold) 10%, transparent), transparent)'
                    : 'var(--bg-secondary)'
              }}>
              <div className="flex items-center gap-2">
                <Star size={16} style={{ color: 'var(--accent-gold)' }} />
                <span className="font-display font-bold text-sm" style={{ color: 'var(--text-primary)' }}>
                  Overall Winner:
                </span>
                {overallWinner === 'tie' ? (
                  <>
                    <span className="font-bold text-sm" style={{ color: 'var(--text-secondary)' }}>Tie</span>
                    <span className="text-xs ml-1" style={{ color: 'var(--text-muted)' }}>
                      — {winsA} {winsA === 1 ? 'metric' : 'metrics'} won each
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-bold text-sm"
                      style={{ color: overallWinner === 'a' ? 'var(--accent-indigo)' : 'var(--accent-gold)' }}>
                      {overallWinner === 'a' ? a.name : b.name}
                    </span>
                    <span className="text-xs ml-1" style={{ color: 'var(--text-muted)' }}>
                      — won {overallWinner === 'a' ? winsA : winsB} of {contestedRows.length} metrics
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* City Audience % -- only meaningful once a specific city is
              picked (real Spotify/Instagram audience-by-city data, see
              audience_city/scorer.py). `available` gates display per artist
              rather than fabricating a 0% for an artist Viberate has no
              current city data for -- coverage genuinely fluctuates. */}
          {citySelected && (audienceA.data?.available || audienceB.data?.available) && (
            <div className="glass-card p-4 mb-4 animate-fade-up">
              <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                Real Digital Audience Share in {selectedCity}
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs mb-1" style={{ color: 'var(--accent-indigo)' }}>{a.name}</p>
                  {audienceA.data?.available ? (
                    <>
                      {audienceA.data.monthly_listeners_pct != null && (
                        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{audienceA.data.monthly_listeners_pct}% of Spotify monthly listeners</p>
                      )}
                      {audienceA.data.total_followers_pct != null && (
                        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{audienceA.data.total_followers_pct}% of Instagram followers</p>
                      )}
                    </>
                  ) : (
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No current data for this city</p>
                  )}
                </div>
                <div>
                  <p className="text-xs mb-1" style={{ color: 'var(--accent-gold)' }}>{b.name}</p>
                  {audienceB.data?.available ? (
                    <>
                      {audienceB.data.monthly_listeners_pct != null && (
                        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{audienceB.data.monthly_listeners_pct}% of Spotify monthly listeners</p>
                      )}
                      {audienceB.data.total_followers_pct != null && (
                        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{audienceB.data.total_followers_pct}% of Instagram followers</p>
                      )}
                    </>
                  ) : (
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No current data for this city</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── WHERE TO TOUR NEXT (Feasibility, TOPSIS) ──
// Surfaces mad_analytics/feasibility/topsis.py — the most complete,
// decision-grade signal in the system (5 real, weighted criteria) — which
// previously had a working endpoint nobody in the product could reach.
// Candidate cities reuse this page's existing CITIES list (already the
// city universe "Best Cities for {artist}" above compares against); each
// city gets its own live /feasibility call, run in parallel, and each
// response still carries its TRUE rank against the full NCCS-covered
// candidate-city universe (total_cities_compared), not just the cities
// queried here.
const FEASIBILITY_CITY_NAMES = CITIES.map(c => c.name)

function CityFeasibility({ artists }) {
  const [selectedArtist, setArtist] = useState('')
  const [detailCity, setDetailCity] = useState('')

  const artist = artists.find(a => a.id === selectedArtist)

  const queries = useFeasibilityForCities(
    selectedArtist,
    FEASIBILITY_CITY_NAMES,
    'India',
    Boolean(selectedArtist)
  )

  const cityResults = FEASIBILITY_CITY_NAMES.map((city, i) => ({ city, query: queries[i] }))
  const isLoading = Boolean(selectedArtist) && queries.some(q => q.isLoading || q.isFetching)
  const succeeded = cityResults
    .filter(r => r.query.data)
    .map(r => ({ city: r.city, ...r.query.data }))
    .sort((x, y) => y.score - x.score)
  const failedCount = cityResults.filter(r => r.query.isError).length
  const allFailed = Boolean(selectedArtist) && !isLoading && succeeded.length === 0 && failedCount > 0

  // Auto-select the top-ranked city for the detail panel once results land,
  // but never overwrite a city the user deliberately clicked on.
  useEffect(() => {
    // Wait for every candidate city's call to settle before picking a default
    // — the 8 calls resolve at different times (each is its own live TOPSIS
    // computation), so setting this as soon as the FIRST one lands would
    // "stick" on whichever city happened to answer fastest, not the actual
    // top-ranked one.
    if (!isLoading && succeeded.length && !succeeded.some(r => r.city === detailCity)) {
      setDetailCity(succeeded[0].city)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, succeeded.length, selectedArtist])

  const active = succeeded.find(r => r.city === detailCity) || succeeded[0] || null

  const chartData = succeeded.map(r => ({ name: r.city, value: Math.round(r.score * 1000) / 10 }))

  return (
    <div>
      {/* Selector */}
      <div className="glass-card p-5 mb-6 animate-fade-up">
        <h3 className="font-display font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
          Configure Feasibility Ranking
        </h3>
        <div className="max-w-sm">
          <label className="text-xs font-semibold uppercase tracking-widest block mb-2"
            style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
            Select Artist
          </label>
          <select
            value={selectedArtist}
            onChange={e => { setArtist(e.target.value); setDetailCity('') }}
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
      </div>

      {/* Empty state */}
      {!selectedArtist && (
        <div className="glass-card p-16 text-center animate-fade-up">
          <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center"
            style={{ background: 'color-mix(in srgb, var(--accent-green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-green) 20%, transparent)' }}>
            <Compass size={28} style={{ color: 'var(--accent-green)' }} />
          </div>
          <h3 className="font-display font-semibold text-lg mb-2" style={{ color: 'var(--text-primary)' }}>
            Select an Artist
          </h3>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            TOPSIS-ranks candidate cities by real touring precedent, city affinity,
            venue fit, artist power and engagement — see which city this artist is
            actually most feasible to tour in next.
          </p>
        </div>
      )}

      {/* Loading */}
      {selectedArtist && isLoading && (
        <div className="glass-card p-10 text-center animate-fade-up">
          <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            Ranking {FEASIBILITY_CITY_NAMES.length} candidate cities for {artist?.name}…
          </p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Each city runs a live TOPSIS computation (including a fresh Popularity /
            Google Trends read) — this can take up to 30 seconds.
          </p>
        </div>
      )}

      {/* Fully unavailable */}
      {allFailed && (
        <div className="glass-card p-6 mb-6 animate-fade-up"
          style={{ border: '1px solid color-mix(in srgb, var(--accent-gold) 25%, transparent)', background: 'color-mix(in srgb, var(--accent-gold) 6%, transparent)' }}>
          <div className="flex items-center gap-2 mb-1">
            <Zap size={15} style={{ color: 'var(--accent-gold)' }} />
            <span className="text-sm font-bold" style={{ color: 'var(--accent-gold)' }}>
              Feasibility ranking unavailable
            </span>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            The analytics service didn't return a result for any candidate city.
            No feasibility ranking is shown.
          </p>
        </div>
      )}

      {/* Results */}
      {selectedArtist && !isLoading && succeeded.length > 0 && (
        <>
          {failedCount > 0 && (
            <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
              {failedCount} of {FEASIBILITY_CITY_NAMES.length} candidate cities couldn't be scored
              (analytics service unavailable for that request) and are omitted below.
            </p>
          )}

          {/* Honest caveat, matching this project's established disclosure tone
              (see estimatedInputsNote above / Popularity's own docstrings) --
              Artist Power and Engagement describe the ARTIST, not the city, so
              they are identical across every row here and contribute nothing
              to which city ranks higher (see mad_analytics/feasibility/topsis.py). */}
          <p className="text-xs mb-6 -mt-2" style={{ color: 'var(--text-muted)' }}>
            Artist Power and Engagement are the same for {artist?.name} in every city below —
            they measure the artist, not the city, so they mathematically can't move this
            ranking (see topsis.py). Only when comparing different artists against one fixed
            city would they start to matter. City Affinity, Touring Precedent and Venue Fit are
            what actually separates these cities here.
          </p>

          <ChartContainer
            title={`Where To Tour Next — ${artist?.name}`}
            subtitle="TOPSIS closeness score (0–100) across candidate cities — higher is more feasible"
            delay={0}
          >
            <BarChart
              data={chartData}
              xKey="name"
              layout="horizontal"
              bars={[{ key: 'value', label: 'Feasibility Score' }]}
              height={260}
            />
          </ChartContainer>

          {/* Per-city rank chips */}
          <div className="flex flex-wrap gap-2 mt-4 mb-6">
            {succeeded.map((r, i) => (
              <button
                key={r.city}
                onClick={() => setDetailCity(r.city)}
                className="text-xs px-3 py-1.5 rounded-full font-semibold transition-all duration-200"
                style={r.city === detailCity ? {
                  background: 'color-mix(in srgb, var(--accent-green) 15%, transparent)', color: 'var(--accent-green)', border: '1px solid color-mix(in srgb, var(--accent-green) 35%, transparent)'
                } : {
                  background: 'var(--bg-secondary)', color: 'var(--text-muted)', border: '1px solid var(--border)'
                }}
              >
                #{i + 1} {r.city} · {(r.score * 100).toFixed(1)}
              </button>
            ))}
          </div>

          {/* Detail panel for the selected city */}
          {active && (
            <div className="glass-card p-5 animate-fade-up">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                    {active.city} — Feasibility Breakdown
                  </h3>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Ranked #{active.rank} of {active.total_cities_compared} NCCS-covered candidate cities nationally
                  </p>
                </div>
                <div className="px-3 py-1.5 rounded-xl text-right"
                  style={{ background: 'color-mix(in srgb, var(--accent-green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-green) 20%, transparent)' }}>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Closeness Score</p>
                  <p className="font-display font-bold" style={{ color: 'var(--accent-green)' }}>{(active.score * 100).toFixed(1)}%</p>
                </div>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <StatBox label="Artist Power" value={active.components.artist_power.toFixed(1)} sub="Popularity · constant here" color="var(--accent-indigo)" />
                <StatBox label="Engagement" value={`${(active.components.engagement_score * 100).toFixed(2)}%`} sub="Fan-quality ratio · constant here" color="var(--accent-indigo)" />
                <StatBox label="City Affinity" value={active.components.city_affinity.toFixed(1)} sub="NCCS market activity" color="var(--accent-indigo)" />
                <StatBox label="Touring Precedent" value={active.components.touring_precedent_visits} sub={active.components.city_audience_monthly_listeners_pct != null ? `+digital audience boost (${active.components.city_audience_monthly_listeners_pct.toFixed(1)}% monthly listeners)` : 'Real past visits'} color="var(--accent-gold)" />
                <StatBox label="Venue Fit" value={active.components.venue_fit_index.toFixed(1)} sub="Avg. known venue capacity index" color="var(--accent-red)" />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── MAIN PAGE ──
function Analysis() {
  const [activeTab, setTab] = useState('Artist Comparison')

  const { data: artists, isLoading: loadingArtists, error: errArtists } = useArtists()
  // useConcerts() defaults to limit:50 (one page, no fetchNextPage call on
  // this page) -- with ~233 real concerts across the roster, that silently
  // truncated every city/venue lookup below to whichever 50 happened to be
  // most recent roster-wide, regardless of which artist/city was selected.
  // Matches the limit already used elsewhere for a full concert set (Venues
  // page, useArtists.js's own concerts fetch).
  const { data: concerts, isLoading: loadingConcerts, error: errConcerts } = useConcerts({ limit: 1000 })

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
        style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--accent-gold) 6%, transparent), transparent 70%)', filter: 'blur(40px)' }} />

      <PageHeader
        title="Analysis"
        subtitle="Artist comparison and touring feasibility engine"
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
              background: 'linear-gradient(135deg, var(--accent-indigo), var(--accent-indigo))',
              color: '#fff',
              boxShadow: '0 4px 16px color-mix(in srgb, var(--accent-indigo) 30%, transparent)'
            } : {
              color: 'var(--text-muted)',
              background: 'transparent'
            }}
          >
            {tab === 'Artist Comparison' ? '⚔️ ' : '🧭 '}{tab}
          </button>
        ))}
      </div>

      {activeTab === 'Artist Comparison' && <ArtistComparison artists={safeArtists} concerts={safeConcerts} />}
      {activeTab === 'Where To Tour Next' && <CityFeasibility artists={safeArtists} />}
    </div>
  )
}

export default Analysis

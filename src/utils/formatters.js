// Format numbers: 1,200,000 -> "1.2M"
export function formatNumber(num) {
  if (!num && num !== 0) return '\u2014'
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B'
  if (num >= 1_000_000)     return (num / 1_000_000).toFixed(1) + 'M'
  if (num >= 1_000)         return (num / 1_000).toFixed(1) + 'K'
  return num.toLocaleString('en-IN')
}

// Format currency with proper symbol based on currency code or country
// Accepts: formatCurrency(175000) -> "₹1.75L"
//          formatCurrency(45000, 'USD') -> "$45.0K"
//          formatCurrency(165000, { country: 'United Arab Emirates' }) -> "AED 165.0K"
export function formatCurrency(num, currencyOrOpts = 'INR') {
  if (!num && num !== 0) return '\u2014'

  // Resolve currency code from either a string or { country, currency } object
  let code = 'INR'
  if (typeof currencyOrOpts === 'string') {
    code = currencyOrOpts.toUpperCase()
  } else if (currencyOrOpts && typeof currencyOrOpts === 'object') {
    if (currencyOrOpts.currency) {
      code = String(currencyOrOpts.currency).toUpperCase()
    } else if (currencyOrOpts.country) {
      code = resolveCountryCurrency(String(currencyOrOpts.country))
    }
  }

  const currencyConfig = {
    INR: { symbol: '\u20B9', locale: 'en-IN' },
    USD: { symbol: '$', locale: 'en-US' },
    EUR: { symbol: '\u20AC', locale: 'en-DE' },
    GBP: { symbol: '\u00A3', locale: 'en-GB' },
    AUD: { symbol: 'A$', locale: 'en-AU' },
    CAD: { symbol: 'C$', locale: 'en-CA' },
    AED: { symbol: 'AED ', locale: 'en-AE' },
    SGD: { symbol: 'S$', locale: 'en-SG' },
    NZD: { symbol: 'NZ$', locale: 'en-NZ' },
    JPY: { symbol: '\u00A5', locale: 'ja-JP' },
    KRW: { symbol: '\u20A9', locale: 'ko-KR' },
  }

  const config = currencyConfig[code] || { symbol: code + ' ', locale: 'en-US' }

  // Indian notation (Cr, L, K)
  if (code === 'INR') {
    if (num >= 10_000_000) return config.symbol + (num / 10_000_000).toFixed(2) + 'Cr'
    if (num >= 100_000)    return config.symbol + (num / 100_000).toFixed(2) + 'L'
    if (num >= 1_000)      return config.symbol + (num / 1_000).toFixed(1) + 'K'
    return config.symbol + num.toLocaleString('en-IN')
  }

  // Western notation (B, M, K)
  if (num >= 1_000_000_000) return config.symbol + (num / 1_000_000_000).toFixed(2) + 'B'
  if (num >= 1_000_000)     return config.symbol + (num / 1_000_000).toFixed(2) + 'M'
  if (num >= 1_000)         return config.symbol + (num / 1_000).toFixed(1) + 'K'
  return config.symbol + num.toLocaleString(config.locale)
}

// Resolve currency code from country name
function resolveCountryCurrency(country) {
  if (!country) return 'INR'
  const lower = country.toLowerCase()
  if (lower.includes('india')) return 'INR'
  if (lower.includes('united states') || lower === 'usa' || lower === 'us') return 'USD'
  if (lower.includes('united kingdom') || lower === 'uk') return 'GBP'
  if (lower.includes('australia')) return 'AUD'
  if (lower.includes('canada')) return 'CAD'
  if (lower.includes('united arab') || lower === 'uae') return 'AED'
  if (lower.includes('singapore')) return 'SGD'
  if (lower.includes('new zealand')) return 'NZD'
  if (lower.includes('japan')) return 'JPY'
  if (['germany', 'france', 'italy', 'spain', 'netherlands', 'ireland', 'austria', 'belgium', 'portugal', 'finland'].some(c => lower.includes(c))) return 'EUR'
  return 'USD'
}

// Format RoG: 12.4 -> "+12.4%"
export function formatRoG(value) {
  if (!value && value !== 0) return '\u2014'
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

// Format date: "2024-03-15" -> "15 Mar 2024"
export function formatDate(dateStr) {
  if (!dateStr) return '\u2014'
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day:   '2-digit',
    month: 'short',
    year:  'numeric',
  })
}

// Format percentage: 0.742 -> "74.2%"
export function formatPercent(value) {
  if (!value && value !== 0) return '\u2014'
  return `${(value * 100).toFixed(1)}%`
}

// Sell-through %: tickets sold / capacity. Returns '\u2014' (never a
// fabricated 0.0%) when either side is genuinely unknown -- 0 of 233
// concerts in this dataset have real ticket data, so a bare `sold` of 0
// always means "not tracked", not "sold zero tickets" (same guard as
// Concerts.jsx/ConcertDetail.jsx/MapView.jsx's own sell-through logic).
export function sellThrough(sold, capacity) {
  if (!capacity || !sold) return '\u2014'
  return `${((sold / capacity) * 100).toFixed(1)}%`
}

// Truncate long text
export function truncate(str, maxLength = 40) {
  if (!str) return '\u2014'
  return str.length > maxLength ? str.slice(0, maxLength) + '...' : str
}

// Platform display names and colours
export const PLATFORM_META = {
  instagram:   { label: 'Instagram',   color: '#E1306C', bg: '#FDE8F1' },
  youtube:     { label: 'YouTube',     color: '#FF0000', bg: '#FFE5E5' },
  spotify:     { label: 'Spotify',     color: '#1DB954', bg: '#E5F8EC' },
  facebook:    { label: 'Facebook',    color: '#1877F2', bg: '#E7F0FD' },
  twitter:     { label: 'Twitter/X',   color: '#000000', bg: '#F0F0F0' },
  apple_music: { label: 'Apple Music', color: '#FC3C44', bg: '#FFE9EA' },
  reddit:      { label: 'Reddit',      color: '#FF4500', bg: '#FFF0E8' },
  quora:       { label: 'Quora',       color: '#B92B27', bg: '#FAEAEA' },
}

// Genre colours for charts
export const GENRE_COLORS = [
  '#2563EB', '#F97316', '#0D9488', '#7C3AED',
  '#15803D', '#DC2626', '#0891B2', '#D97706',
]

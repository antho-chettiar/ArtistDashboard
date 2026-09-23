// Shared revenue/ticket math for concerts -- previously duplicated (and
// silently disagreeing) across Concerts.jsx, ArtistProfile.jsx,
// ConcertDetail.jsx and MapView.jsx. Consolidated 2026-09 as part of the
// dashboard-authenticity pass so every consumer sums the same way, converts
// currency with the same rates, and treats "no real data" as null -- never
// a fabricated zero.

// Exchange rates: 1 unit of currency = X INR.
// Moved from Concerts.jsx, the only place already doing real INR conversion
// -- the single source of truth now, instead of each file keeping (or not
// keeping) its own copy.
export const RATES_TO_INR = {
  INR: 1,
  USD: 84.0,
  EUR: 91.0,
  GBP: 106.0,
  AUD: 55.0,
  CAD: 61.0,
  AED: 22.9,
  SGD: 63.0,
  NZD: 51.0,
  JPY: 0.54,
  KRW: 0.062,
}

export function convertToINR(amount, currency) {
  if (!amount) return 0
  const rate = RATES_TO_INR[String(currency || 'INR').toUpperCase()] || RATES_TO_INR.USD
  return amount * rate
}

// Sums revenue across a list of concerts, converting each to INR first.
// Returns null (never a fabricated 0) when none of the concerts have a real
// recorded revenue figure -- callers should render that as "--"/"Not
// available", the same way formatCurrency(null) already does, rather than a
// bold "₹0" that reads as a confirmed fact.
export function sumRevenueINR(concerts = []) {
  let sum = 0
  let hasReal = false
  concerts.forEach(c => {
    const revenue = Number(c?.totalRevenue || 0)
    if (revenue > 0) {
      hasReal = true
      sum += convertToINR(revenue, c?.currency)
    }
  })
  return hasReal ? sum : null
}

// Sums tickets sold across a list of concerts. Returns null (not 0) when
// none of the concerts have a real recorded ticket count -- imported
// historical concerts often store 0 where the real value was never recorded.
export function sumTickets(concerts = []) {
  let sum = 0
  let hasReal = false
  concerts.forEach(c => {
    const tickets = Number(c?.ticketsSold || 0)
    if (tickets > 0) {
      hasReal = true
      sum += tickets
    }
  })
  return hasReal ? sum : null
}

// Sums venue capacity across a list of concerts. Returns null when none of
// the concerts have a known capacity.
export function sumCapacity(concerts = []) {
  let sum = 0
  let hasReal = false
  concerts.forEach(c => {
    const capacity = Number(c?.capacity || 0)
    if (capacity > 0) {
      hasReal = true
      sum += capacity
    }
  })
  return hasReal ? sum : null
}

// Average sell-through (%) across a list of concerts. Null when tickets or
// capacity are entirely unknown across the set -- never a fabricated 0%.
export function avgSellThrough(concerts = []) {
  const tickets = sumTickets(concerts)
  const capacity = sumCapacity(concerts)
  if (!tickets || !capacity) return null
  return (tickets / capacity) * 100
}

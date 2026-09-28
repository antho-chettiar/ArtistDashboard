// Mirrors mad_analytics/demand/scorer.py's _CITY_ALIASES / _normalize_city_key
// exactly -- same real-world spelling variants for the same city (e.g. this
// dataset stores some concerts as "Bangalore" and others as "Bengaluru" for
// the same real city). Keep the two lists in sync if either changes.
const CITY_ALIASES = {
  bangalore: 'bengaluru',
  bombay: 'mumbai',
  calcutta: 'kolkata',
  madras: 'chennai',
  'new delhi': 'delhi',
  'delhi ncr': 'delhi',
  gurugram: 'gurgaon',
  thiruvananthapuram: 'trivandrum',
  prayagraj: 'allahabad',
  pondicherry: 'puducherry',
}

export function normalizeCityKey(name) {
  const key = (name || '').trim().toLowerCase()
  return CITY_ALIASES[key] || key
}

export function citiesMatch(a, b) {
  return normalizeCityKey(a) === normalizeCityKey(b)
}

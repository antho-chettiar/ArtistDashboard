// Best-effort classification from the venue's NAME only -- a presentation
// grouping, not verified fact (mirrors mad_analytics/revenue/predictor.py's
// OUTDOOR_VENUE_KEYWORDS heuristic, kept as a separate JS copy since this
// runs client-side over already-fetched concert data). Category priority
// matters: e.g. "Chandigarh University, Main Ground" hits both Educational
// Institution and Outdoor Grounds keywords -- Educational Institution wins
// as the more informative category, while isOutdoor is tracked independently
// so it's still correctly flagged outdoor.
const CATEGORY_RULES = [
  { category: 'Stadium / Arena', keywords: ['stadium', 'arena'] },
  { category: 'Auditorium / Theatre / Hall', keywords: ['auditorium', 'theatre', 'theater', 'hall', 'centre', 'center'] },
  { category: 'Educational Institution', keywords: ['college', 'university', 'institute', 'school', 'iit', 'nit ', 'campus', 'vidyalaya'] },
  { category: 'Outdoor Grounds / Park / Lawn', keywords: ['ground', 'park', 'lawn', 'garden', 'maidan', 'party plot', 'festival'] },
  { category: 'Mall / Corporate / Hotel', keywords: ['mall', 'resort', 'hotel', 'club', 'lounge', 'bar', 'plaza', 'mart', 'restaurant', 'diner', 'cafe'] },
]

const OUTDOOR_KEYWORDS = ['stadium', 'arena', 'ground', 'park', 'lawn', 'garden', 'maidan', 'festival', 'open air', 'open-air', 'outdoor']

export function classifyVenue(venueName = '') {
  const normalized = venueName.toLowerCase()
  if (!normalized) return { category: 'Unknown', isOutdoor: null }
  const rule = CATEGORY_RULES.find(({ keywords }) => keywords.some(k => normalized.includes(k)))
  const isOutdoor = OUTDOOR_KEYWORDS.some(k => normalized.includes(k))
  return { category: rule?.category || 'Other', isOutdoor }
}

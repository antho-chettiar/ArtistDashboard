import { citiesMatch } from './cityAlias'

// "For the decision maker" notes shown under a Where To Tour Next result.
//
// Why this exists: the ranking is a decision AID built on judgment calls
// (criterion weights that are labelled assumptions in topsis.py, not fitted to
// ticket sales) and on a concert log that can be incomplete. Showing a clean
// score without that context invites it to be read as a verdict. These notes
// put the caveats next to the number, and the ones that depend on the data
// (scheduled shows counted as visits, no logged shows, no audience data) are
// computed per artist + city so they only appear when they actually apply.
//
// Pure on purpose (no React, no fetching): `now` is a parameter so the
// future-dated-show rule is testable.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatDate(d) {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

export function buildDecisionNotes({ artistName, city, components, artistConcerts = [], now = new Date() }) {
  const notes = []
  const name = artistName || 'this artist'

  notes.push({
    id: 'weights',
    text: 'This ranking is a decision aid, not a verdict. The weights (touring history 40%, city market 30%, venue fit 20%, artist power 5%, engagement 5%) are judgment calls, not fitted to ticket sales.',
  })
  notes.push({
    id: 'proven-bias',
    text: 'It favours cities the artist has already played. A city with no logged shows can only win on market size and venue fit, so if you suspect untapped demand somewhere, weigh that yourself.',
  })

  const inCity = artistConcerts.filter(c => citiesMatch(c.city, city))
  const scheduled = inCity.filter(c => c.date instanceof Date && !Number.isNaN(c.date.getTime()) && c.date > now)

  if (scheduled.length > 0) {
    const next = scheduled.reduce((a, b) => (a.date <= b.date ? a : b))
    notes.push({
      id: 'scheduled-counted',
      text: `${scheduled.length} of ${inCity.length} logged shows in ${city} ${scheduled.length === 1 ? 'is' : 'are'} dated in the future (next: ${formatDate(next.date)}). Scheduled shows count toward Touring Precedent even though they have not happened yet.`,
    })
  }

  if (inCity.length === 0) {
    notes.push({
      id: 'no-shows',
      text: `No logged shows for ${name} in ${city}, so this score rests on market size and venue fit only.`,
    })
  }

  if (components?.city_audience_monthly_listeners_pct == null) {
    notes.push({
      id: 'no-audience-data',
      text: `No audience-by-city data for ${name} in ${city}, so no digital-audience adjustment was applied.`,
    })
  }

  notes.push({
    id: 'log-size',
    text: `Based on ${artistConcerts.length} logged concert${artistConcerts.length === 1 ? '' : 's'} for ${name}. A show missing from the log lowers that city's score, so check the log for cities you know well.`,
  })

  return notes
}

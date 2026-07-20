import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Filter, TrendingUp } from 'lucide-react'
import PageHeader from '../components/ui/PageHeader'
import RoGBadge from '../components/ui/RoGBadge'
import EmptyState from '../components/ui/EmptyState'
import useFilterStore from '../store/useFilterStore'
import { useArtists } from '../hooks/useArtists'
import { formatNumber } from '../utils/formatters'


const GENRES = ['All', 'Bollywood', 'Pop', 'R&B', 'Classical/Fusion']

const PLATFORM_META = {
  instagram:  { label: 'IG', color: '#E1306C' },
  youtube:    { label: 'YT', color: '#FF0000' },
  spotify:    { label: 'SP', color: '#1DB954' },
  facebook:   { label: 'FB', color: '#1877F2' },
  applemusic: { label: 'AM', color: '#FC3C44' },
}

// function ArtistCard({ artist, onClick, delay = 0 }) {
//   const totalFollowers = Object.values(artist.followers).reduce((a, b) => a + b, 0)
//   const avgRoG = Object.values(artist.rog).reduce((a, b) => a + b, 0) / Object.values(artist.rog).length
//   const topPlatform = Object.entries(artist.followers).sort((a, b) => b[1] - a[1])[0]

//   return (
//     <div onClick={onClick}
//       className="glass-card p-5 cursor-pointer group animate-fade-up relative overflow-hidden"
//       style={{ animationDelay: `${delay}ms`, animationFillMode: 'both', opacity: 0 }}
//       onMouseEnter={e => {
//         e.currentTarget.style.transform = 'translateY(-4px)'
//         e.currentTarget.style.boxShadow = '0 20px 40px rgba(99,102,241,0.15)'
//         e.currentTarget.style.borderColor = 'var(--border-strong)'
//       }}
//       onMouseLeave={e => {
//         e.currentTarget.style.transform = 'translateY(0)'
//         e.currentTarget.style.boxShadow = 'none'
//         e.currentTarget.style.borderColor = 'var(--border)'
//       }}
//     >
//       <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none rounded-2xl"
//         style={{ background: 'radial-gradient(circle at 50% 0%, rgba(99,102,241,0.06), transparent 70%)' }} />

//       {/* Type badge */}
//       <div className="absolute top-3 right-3">
//         <span className="text-xs px-2 py-0.5 rounded-full font-medium"
//           style={artist.type === 'indian' ? {
//             background: 'rgba(255,153,51,0.15)', color: '#FF9933'
//           } : {
//             background: 'rgba(99,102,241,0.15)', color: '#818CF8'
//           }}>
//           {artist.type === 'indian' ? '🇮🇳' : '🌍'}
//         </span>
//       </div>

//       {/* Avatar + Name */}
//       <div className="flex items-start gap-3 mb-4">
//         <div className="relative flex-shrink-0">
//           <img src={artist.photo} alt={artist.name}
//             className="w-14 h-14 rounded-2xl object-cover"
//             style={{ border: '2px solid var(--border-strong)' }} />
//           <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2"
//             style={{ background: '#10B981', borderColor: 'var(--bg-card)' }} />
//         </div>
//         <div className="flex-1 min-w-0">
//           <h3 className="font-display font-bold text-sm truncate" style={{ color: 'var(--text-primary)' }}>
//             {artist.name}
//           </h3>
//           <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
//             <span className="text-xs px-2 py-0.5 rounded-full font-medium"
//               style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--accent-indigo)' }}>
//               {artist.genre}
//             </span>
//             <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
//               {artist.nationality}
//             </span>
//           </div>
//         </div>
//         <RoGBadge value={avgRoG} />
//       </div>

//       {/* Total Followers */}
//       <div className="mb-4">
//         <p className="text-xs uppercase tracking-widest mb-1"
//           style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Total Followers</p>
//         <p className="font-display font-bold text-2xl" style={{ color: 'var(--text-primary)' }}>
//           {formatNumber(totalFollowers)}
//         </p>
//       </div>

//       {/* Platform breakdown */}
//       <div className="grid grid-cols-5 gap-1.5 mb-4">
//         {Object.entries(artist.followers).map(([platform, count]) => {
//           const meta = PLATFORM_META[platform]
//           if (!meta) return null
//           return (
//             <div key={platform} className="rounded-xl p-2 text-center"
//               style={{ background: `${meta.color}12`, border: `1px solid ${meta.color}20` }}>
//               <p className="text-xs font-bold mb-0.5" style={{ color: meta.color }}>{meta.label}</p>
//               <p className="text-xs font-semibold" style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>
//                 {formatNumber(count)}
//               </p>
//             </div>
//           )
//         })}
//       </div>

//       {/* Footer */}
//       <div className="flex items-center justify-between pt-3"
//         style={{ borderTop: '1px solid var(--border)' }}>
//         <div className="flex items-center gap-1.5">
//           <TrendingUp size={12} style={{ color: 'var(--text-muted)' }} />
//           <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
//             Top: <span className="font-semibold capitalize" style={{ color: 'var(--text-secondary)' }}>
//               {topPlatform[0]}
//             </span>
//           </span>
//         </div>
//         <span className="text-xs font-semibold px-2.5 py-1 rounded-lg"
//           style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
//           View Profile →
//         </span>
//       </div>
//     </div>
//   )
// }

function ArtistCard({ artist, onClick, delay = 0 }) {
  const followers = artist.followers || {}
  const totalFollowers = Object.values(followers).reduce((a, b) => a + Number(b || 0), 0)
  const rog = artist.rog || {}
  const rogValues = Object.values(rog)
  const avgRoG = rogValues.length > 0 ? rogValues.reduce((a, b) => a + Number(b || 0), 0) / rogValues.length : 0
  const sortedPlatforms = Object.entries(followers).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
  const topPlatform = sortedPlatforms.length > 0 ? sortedPlatforms[0] : ['N/A', 0]
  const totalConcerts = Number(artist.totalConcerts || 0)

  return (
    <div onClick={onClick}
      className="glass-card p-5 cursor-pointer group animate-fade-up relative overflow-hidden"
      style={{ animationDelay: `${delay}ms`, animationFillMode: 'both', opacity: 0 }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-4px)'
        e.currentTarget.style.boxShadow = '0 20px 40px rgba(99,102,241,0.15)'
        e.currentTarget.style.borderColor = 'var(--border-strong)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = 'none'
        e.currentTarget.style.borderColor = 'var(--border)'
      }}
    >
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none rounded-2xl"
        style={{ background: 'radial-gradient(circle at 50% 0%, rgba(99,102,241,0.06), transparent 70%)' }} />

      {/* Type badge */}
      <div className="absolute top-3 right-3">
        <span className="text-xs px-2 py-0.5 rounded-full font-medium"
          style={artist.type === 'indian' ? {
            background: 'rgba(255,153,51,0.15)', color: '#FF9933'
          } : {
            background: 'rgba(99,102,241,0.15)', color: '#818CF8'
          }}>
          {artist.type === 'indian' ? '🇮🇳' : '🌍'}
        </span>
      </div>

      {/* Avatar + Name */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative flex-shrink-0">
          <img src={artist.photo || `https://ui-avatars.com/api/?name=${encodeURIComponent(artist.name || 'U')}&background=6366F1&color=fff`} alt={artist.name || 'Unknown'}
            className="w-14 h-14 rounded-2xl object-cover"
            style={{ border: '2px solid var(--border-strong)' }} />
          <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2"
            style={{ background: '#10B981', borderColor: 'var(--bg-card)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-display font-bold text-sm truncate" style={{ color: 'var(--text-primary)' }}>
            {/* {artist.name || 'Unknown Artist'} */}
            {artist.name}
          </h3>
          {/* <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--accent-indigo)' }}>
              {artist.genre || 'Various'}
            </span>
          </div> */}
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {/* {artist.nationality || 'Unknown'} */}
            {artist.nationality}
          </p>
        </div>
        {/* <RoGBadge value={avgRoG} /> */}
      </div>

      {/* Age + Concerts row */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="rounded-xl p-2 text-center"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <p className="text-xs" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Age</p>
          <p className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{artist.age || 'N/A'}</p>
        </div>
        <div className="rounded-xl p-2 text-center"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <p className="text-xs" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Career Concerts</p>
          <p className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{totalConcerts}</p>
        </div>
        <div className="rounded-xl p-2 text-center"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <p className="text-xs" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Popularity</p>
          <p className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{Number(artist.popularity || 0)}</p>
        </div>
      </div>

      {/* Spotify Monthly Listeners */}
      <div className="mb-3">
        <p className="text-xs uppercase tracking-widest mb-1"
          style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Spotify Monthly Listeners</p>
        <p className="font-display font-bold text-2xl" style={{ color: 'var(--text-primary)' }}>
          {formatNumber(followers.spotifyMonthlyListeners || 0)}
        </p>
      </div>

      {/* Platform breakdown */}
      <div className="grid grid-cols-4 gap-1.5 mb-3">
        {Object.entries(followers).map(([platform, count]) => {
          const meta = PLATFORM_META[platform]
          if (!meta) return null
          return (
            <div key={platform} className="rounded-xl p-2 text-center"
              style={{ background: `${meta.color}12`, border: `1px solid ${meta.color}20` }}>
              <p className="text-xs font-bold mb-0.5" style={{ color: meta.color }}>{meta.label}</p>
              <p className="font-semibold" style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>
                {formatNumber(Number(count || 0))}
              </p>
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-3"
        style={{ borderTop: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1.5">
          <TrendingUp size={12} style={{ color: 'var(--text-muted)' }} />
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Top: <span className="font-semibold capitalize" style={{ color: 'var(--text-secondary)' }}>
              {topPlatform[0]}
            </span>
          </span>
        </div>
        <span className="text-xs font-semibold px-2.5 py-1 rounded-lg"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
          View Profile →
        </span>
      </div>
    </div>
  )
}

function Artists() {
  const navigate = useNavigate()
  const { artistType } = useFilterStore()
  const [search, setSearch]     = useState('')
  const [activeGenre, setGenre] = useState('All')

  // Fetch artists from API
  const { data: artists, isLoading, error } = useArtists({
    search: search,
    genre: activeGenre === 'All' ? '' : activeGenre,
  })

  // Apply additional filters (artistType)
  const filtered = useMemo(() => {
    if (!artists) return []
    return artists.filter(a => {
      const matchType = !artistType || a.type === artistType
      return matchType
    })
  }, [artists, artistType])

  const marketLabel = artistType === 'indian' ? '🇮🇳 Indian' : artistType === 'international' ? '🌍 International' : ''

  // Loading state
  if (isLoading) {
    return (
      <div className="relative">
        <div className="fixed top-32 right-20 w-72 h-72 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.07), transparent 70%)', filter: 'blur(40px)' }} />
        <PageHeader
          title="Artists"
          subtitle="Loading artists..."
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[1,2,3,4,5,6,7,8].map(i => (
            <div key={i} className="glass-card p-5 animate-pulse">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-14 h-14 rounded-2xl bg-gray-200 dark:bg-gray-700" />
                <div className="flex-1">
                  <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-2" />
                  <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/2" />
                </div>
              </div>
              <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/2 mb-3" />
              <div className="grid grid-cols-5 gap-1.5 mb-3">
                {[1,2,3,4,5].map(j => (
                  <div key={j} className="h-12 bg-gray-200 dark:bg-gray-700 rounded-xl" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="relative">
        <div className="fixed top-32 right-20 w-72 h-72 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.07), transparent 70%)', filter: 'blur(40px)' }} />
        <PageHeader
          title="Artists"
          subtitle={`${marketLabel} artists tracked on the platform`}
        />
        <EmptyState
          title="Failed to load artists"
          subtitle={error?.response?.data?.message || error.message || 'Please try again'}
          action={{
            label: 'Retry',
            onClick: () => window.location.reload()
          }}
        />
      </div>
    )
  }

  return (
    <div className="relative">
      <div className="fixed top-32 right-20 w-72 h-72 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.07), transparent 70%)', filter: 'blur(40px)' }} />

      <PageHeader
        title="Artists"
        subtitle={`${filtered.length} ${marketLabel} artists tracked on the platform`}
      />

      {/* Search + Filter */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl flex-1"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <Search size={15} style={{ color: 'var(--text-muted)' }} />
          <input type="text" placeholder="Search artists..."
            value={search} onChange={e => setSearch(e.target.value)}
            className="bg-transparent text-sm outline-none w-full"
            style={{ color: 'var(--text-primary)', fontFamily: 'Satoshi' }} />
        </div>
        {/* <div className="flex items-center gap-2 flex-wrap">
          <Filter size={14} style={{ color: 'var(--text-muted)' }} />
          {GENRES.map(g => (
            <button key={g} onClick={() => setGenre(g)}
              className="text-xs px-3 py-1.5 rounded-xl font-medium transition-all duration-200"
              style={activeGenre === g ? {
                background: 'linear-gradient(135deg, #6366F1, #818CF8)',
                color: '#fff', boxShadow: '0 4px 12px rgba(99,102,241,0.3)'
              } : {
                background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px solid var(--border)'
              }}>
              {g}
            </button>
          ))}
        </div> */}
      </div>

      <p className="text-xs mb-4 uppercase tracking-widest"
        style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
        Showing {filtered.length} of {artists?.length || 0} artists
      </p>

      {filtered.length === 0 ? (
        <EmptyState title="No artists found" subtitle="Try adjusting your search or genre filter" />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((artist, i) => (
            <ArtistCard key={artist.id} artist={artist} delay={i * 60}
              onClick={() => navigate(`/artists/${artist.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
}

export default Artists
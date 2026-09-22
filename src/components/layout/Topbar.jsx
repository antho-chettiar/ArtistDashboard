import { Bell, Search, Sun, Moon, LogOut } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import useThemeStore from '../../store/useThemeStore'
import useFilterStore from '../../store/useFilterStore'
import useAuthStore from '../../store/useAuthStore'

const pageTitles = {
  '/dashboard':       'Dashboard',
  '/artists':         'Artists',
  '/concerts':        'Concerts',
  '/venues':          'Venues',
  '/demographics':    'Demographics',
  '/analysis':        'Analysis',
  '/map':             'Map View',
  '/admin/users':     'Admin — Users',
  '/admin/ingestion': 'Admin — Ingestion',
}

function Topbar() {
  const { pathname }                      = useLocation()
  const navigate = useNavigate()
  const { theme, toggleTheme, initTheme } = useThemeStore()
  const { artistType, setArtistType }     = useFilterStore()
  const logout                           = useAuthStore((state) => state.logout)

  useEffect(() => { initTheme() }, [initTheme])

  const title = Object.entries(pageTitles).find(([key]) =>
    pathname.startsWith(key)
  )?.[1] || 'Dashboard'

  return (
    <header style={{
      background: 'var(--bg-card)',
      borderBottom: '1px solid var(--border)',
      backdropFilter: 'blur(12px)',
    }} className="h-16 flex items-center px-6 gap-3 sticky top-0 z-30">

      {/* Page Title */}
      <h2 className="font-display font-semibold text-lg flex-1"
        style={{ color: 'var(--text-primary)' }}>
        {title}
      </h2>

      {/* Search */}
      {/* 
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl w-48"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <Search size={14} style={{ color: 'var(--text-muted)' }} />
        <input type="text" placeholder="Search..."
          className="bg-transparent text-sm outline-none w-full"
          style={{ color: 'var(--text-primary)', fontFamily: 'Satoshi' }} />
      </div> */}

      {/* Artist Type Toggle — only shows after selection */}
      {artistType && (
        <div className="flex items-center gap-1 p-1 rounded-xl"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <button
            onClick={() => setArtistType('indian')}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all duration-200"
            style={artistType === 'indian' ? {
              background: 'linear-gradient(135deg, #FF9933, #FF671F)',
              color: '#fff',
              boxShadow: '0 4px 12px rgba(255,153,51,0.35)'
            } : {
              color: 'var(--text-muted)',
              background: 'transparent'
            }}
          >
            🇮🇳 Indian
          </button>
          <button
            onClick={() => setArtistType('international')}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all duration-200"
            style={artistType === 'international' ? {
              background: 'linear-gradient(135deg, #6366F1, #818CF8)',
              color: '#fff',
              boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
            } : {
              color: 'var(--text-muted)',
              background: 'transparent'
            }}
          >
            🌍 International
          </button>
        </div>
      )}

      {/* Theme Toggle */}
      <button onClick={toggleTheme}
        className="relative w-14 h-7 rounded-full transition-all duration-300 flex items-center px-1"
        style={{
          background: theme === 'dark'
            ? 'linear-gradient(135deg, #6366F1, #818CF8)'
            : 'linear-gradient(135deg, #F59E0B, #FCD34D)',
          boxShadow: theme === 'dark'
            ? '0 0 16px rgba(99,102,241,0.4)'
            : '0 0 16px rgba(245,158,11,0.4)'
        }}>
        <div className="w-5 h-5 rounded-full bg-white flex items-center justify-center transition-all duration-300 shadow-sm"
          style={{ transform: theme === 'dark' ? 'translateX(28px)' : 'translateX(0)' }}>
          {theme === 'dark'
            ? <Moon size={11} className="text-indigo-600" />
            : <Sun  size={11} className="text-amber-500" />}
        </div>
      </button>

      {/* Notifications */}
      <button className="relative p-2 rounded-xl"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <Bell size={17} style={{ color: 'var(--text-secondary)' }} />
        <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
          style={{ background: 'var(--accent-gold)' }} />
      </button>

      {/* Logout */}
      <button onClick={() => { logout(); navigate('/login'); }}
        className="flex items-center gap-2 text-sm px-3 py-2 rounded-xl transition-colors hover:opacity-80"
        style={{ color: 'var(--text-secondary)', background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <LogOut size={15} />
        <span className="hidden sm:block">Logout</span>
      </button>
    </header>
  )
}

export default Topbar

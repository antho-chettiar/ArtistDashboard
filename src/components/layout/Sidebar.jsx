import { createElement } from 'react'
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Mic2, Music2,
  Map, Upload, UserCog, ChevronRight,
  BarChart3
} from 'lucide-react'

function NavIcon({ icon }) {
  return createElement(icon, { size: 17 })
}

const navItems = [
  { label: 'Dashboard',    path: '/dashboard',      icon: LayoutDashboard },
  { label: 'Artists',      path: '/artists',         icon: Mic2            },
  { label: 'Concerts',     path: '/concerts',        icon: Music2          },
  // { label: 'Demographics', path: '/demographics',    icon: Users           },
  { label: 'Analysis',     path: '/analysis',        icon: BarChart3       },
  { label: 'Map View',     path: '/map',             icon: Map             },
]

const adminItems = [
  { label: 'Users',        path: '/admin/users',     icon: UserCog         },
  { label: 'Ingestion',    path: '/admin/ingestion', icon: Upload          },
]

function Sidebar() {
  return (
    <aside style={{ background: 'var(--sidebar-bg)', borderRight: '1px solid var(--border)' }}
      className="w-64 flex flex-col h-full relative overflow-hidden">

      {/* Ambient glow top */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-32 rounded-full opacity-20 pointer-events-none"
        style={{ background: 'radial-gradient(circle, #6366F1, transparent 70%)', filter: 'blur(24px)' }} />

      {/* Logo */}
      <div className="px-6 py-6 relative z-10">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg"
            style={{ background: 'linear-gradient(135deg, #6366F1, #818CF8)', boxShadow: '0 0 20px rgba(99,102,241,0.4)' }}>
            🎵
          </div>
          <div>
            <h1 className="font-display font-bold text-white text-lg tracking-tight leading-none">Artist Metrics</h1>
            <p className="text-xs mt-0.5" style={{ color: 'var(--sidebar-text)' }}>Analytics Platform</p>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="mx-4 mb-4" style={{ height: '1px', background: 'var(--border)' }} />

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-1 overflow-y-auto relative z-10">
        <p className="text-xs font-semibold uppercase tracking-widest px-3 mb-3"
          style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Main</p>

        {navItems.map(({ label, path, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) =>
              `group flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                isActive ? 'active-nav' : ''
              }`
            }
            style={({ isActive }) => isActive ? {
              background: 'linear-gradient(135deg, rgba(99,102,241,0.25), rgba(129,140,248,0.1))',
              color: '#818CF8',
              border: '1px solid rgba(99,102,241,0.3)',
              boxShadow: '0 0 20px rgba(99,102,241,0.1)'
            } : {
              color: 'var(--sidebar-text)',
              border: '1px solid transparent',
            }}
          >
            <NavIcon icon={Icon} />
            <span className="flex-1">{label}</span>
            <ChevronRight size={13} className="opacity-0 group-hover:opacity-40 transition-opacity" />
          </NavLink>
        ))}

        {/* Admin */}
        <div className="pt-4">
          <p className="text-xs font-semibold uppercase tracking-widest px-3 mb-3"
            style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Admin</p>
          {adminItems.map(({ label, path, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              className="group flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200"
              style={({ isActive }) => isActive ? {
                background: 'linear-gradient(135deg, rgba(99,102,241,0.25), rgba(129,140,248,0.1))',
                color: '#818CF8',
                border: '1px solid rgba(99,102,241,0.3)',
              } : {
                color: 'var(--sidebar-text)',
                border: '1px solid transparent',
              }}
            >
              <NavIcon icon={Icon} />
              <span className="flex-1">{label}</span>
              <ChevronRight size={13} className="opacity-0 group-hover:opacity-40 transition-opacity" />
            </NavLink>
          ))}
        </div>
      </nav>

      {/* User */}
      <div className="p-4 relative z-10" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="flex items-center gap-3 px-2">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, #6366F1, #F59E0B)' }}>
            A
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">Admin User</p>
            <p className="text-xs truncate" style={{ color: 'var(--sidebar-text)' }}>admin@digitalabs.com</p>
          </div>
        </div>
      </div>
    </aside>
  )
}

export default Sidebar

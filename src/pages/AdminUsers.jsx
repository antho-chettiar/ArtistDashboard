import { useState } from 'react'
import { UserPlus, Shield, Eye, Trash2, Search, RefreshCw } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import PageHeader from '../components/ui/PageHeader'
import EmptyState from '../components/ui/EmptyState'
import client from '../api/client'

function AdminUsers() {
  const queryClient = useQueryClient()
  const [search, setSearch]       = useState('')
  const [showModal, setShowModal] = useState(false)
  const [newUser, setNewUser]     = useState({ email: '', password: '', role: 'VIEWER' })

  // Fetch users
  const { data: usersData, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const response = await client.get('/users')
      return response.data.data.users
    }
  })

  const users = usersData || []

  // Create user
  const createMutation = useMutation({
    mutationFn: (data) => client.post('/users', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      setShowModal(false)
      setNewUser({ email: '', password: '', role: 'VIEWER' })
    }
  })

  // Delete user
  const deleteMutation = useMutation({
    mutationFn: (id) => client.delete(`/users/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] })
  })

  // Toggle status
  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => client.patch(`/users/${id}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] })
  })

  const filtered = users.filter(u =>
    u.email.toLowerCase().includes(search.toLowerCase())
  )

  function handleAdd() {
    if (!newUser.email || !newUser.password) return
    createMutation.mutate(newUser)
  }

  function toggleStatus(user) {
    updateMutation.mutate({ id: user.id, data: { active: !user.active } })
  }

  const statCards = [
    { label: 'Total Users', value: users.length,                                    color: 'var(--accent-indigo)' },
    { label: 'Active',      value: users.filter(u => u.active).length, color: 'var(--accent-green)'  },
    { label: 'Admins',      value: users.filter(u => u.role === 'ADMIN').length,    color: 'var(--accent-gold)'   },
    { label: 'Viewers',     value: users.filter(u => u.role === 'VIEWER').length,   color: 'var(--accent-indigo)' },
  ]

  return (
    <div className="relative">
      <PageHeader title="User Management" subtitle={`${users.filter(u => u.active).length} active users`}>
        <button onClick={() => setShowModal(true)}
          className="flex items-center gap-2 text-sm px-4 py-2.5 rounded-xl font-semibold transition-all duration-200"
          style={{ background: 'linear-gradient(135deg, #6366F1, #818CF8)', color: '#fff', boxShadow: '0 4px 16px rgba(99,102,241,0.3)' }}>
          <UserPlus size={15} /> Add User
        </button>
      </PageHeader>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {statCards.map((s, i) => (
          <div key={i} className="glass-card p-4 animate-fade-up"
            style={{ animationDelay: `${i * 60}ms`, animationFillMode: 'both', opacity: 0 }}>
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
              {s.label}
            </p>
            <p className="font-display font-bold text-3xl" style={{ color: s.color }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 px-4 py-3 rounded-xl mb-6 max-w-md"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        <Search size={15} style={{ color: 'var(--text-muted)' }} />
        <input type="text" placeholder="Search by email..." value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-transparent text-sm outline-none w-full"
          style={{ color: 'var(--text-primary)', fontFamily: 'Satoshi' }} />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><RefreshCw className="animate-spin text-indigo-500" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No users found" />
      ) : (
        <div className="glass-card overflow-hidden animate-fade-up">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>
              <tr>
                {['User', 'Role', 'Status', 'Joined', 'Actions'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-widest"
                    style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((user) => (
                <tr key={user.id} style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold"
                        style={{ background: 'linear-gradient(135deg, #6366F1, #818CF8)' }}>
                        {user.email[0].toUpperCase()}
                      </div>
                      <div>
                        <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full"
                      style={user.role === 'ADMIN' ? {
                        background: 'rgba(245,158,11,0.12)', color: 'var(--accent-gold)'
                      } : {
                        background: 'rgba(99,102,241,0.12)', color: 'var(--accent-indigo)'
                      }}>
                      {user.role === 'ADMIN' ? <Shield size={10} /> : <Eye size={10} />}
                      {user.role === 'ADMIN' ? 'Admin' : 'Viewer'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-bold px-2.5 py-1 rounded-full"
                      style={user.active ? {
                        background: 'rgba(16,185,129,0.12)', color: 'var(--accent-green)'
                      } : {
                        background: 'var(--border)', color: 'var(--text-muted)'
                      }}>
                      {user.active ? '● Active' : '○ Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {new Date(user.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button onClick={() => toggleStatus(user)}
                        className="text-xs px-2.5 py-1.5 rounded-lg transition-all duration-200"
                        style={{ border: '1px solid var(--border)', color: 'var(--text-muted)', background: 'transparent' }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-indigo)'; e.currentTarget.style.color = 'var(--accent-indigo)' }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}>
                        {user.active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button onClick={() => deleteMutation.mutate(user.id)}
                        className="p-1.5 rounded-lg transition-all duration-200"
                        style={{ color: 'var(--text-muted)' }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.1)'; e.currentTarget.style.color = 'var(--accent-red)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }}>
          <div className="glass-card p-6 w-full max-w-md mx-4 animate-scale-in">
            <h2 className="font-display font-bold text-xl mb-5" style={{ color: 'var(--text-primary)' }}>
              Add New User
            </h2>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold uppercase tracking-widest block mb-2"
                  style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Email Address</label>
                <input type="email" placeholder="e.g. priya@company.com"
                  value={newUser.email}
                  onChange={e => setNewUser(p => ({ ...p, email: e.target.value }))}
                  className="w-full rounded-xl px-4 py-3 text-sm outline-none transition-all duration-200"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'Satoshi' }} />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-widest block mb-2"
                  style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Password</label>
                <input type="password" placeholder="••••••••"
                  value={newUser.password}
                  onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))}
                  className="w-full rounded-xl px-4 py-3 text-sm outline-none transition-all duration-200"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'Satoshi' }} />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-widest block mb-2"
                  style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Role</label>
                <select value={newUser.role}
                  onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}
                  className="w-full rounded-xl px-4 py-3 text-sm outline-none"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'Satoshi' }}>
                  <option value="VIEWER">Viewer</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowModal(false)}
                className="flex-1 py-3 rounded-xl text-sm font-semibold transition-all duration-200"
                style={{ border: '1px solid var(--border)', color: 'var(--text-muted)', background: 'transparent' }}>
                Cancel
              </button>
              <button onClick={handleAdd} disabled={createMutation.isPending}
                className="flex-1 py-3 rounded-xl text-sm font-semibold transition-all duration-200"
                style={{ background: 'linear-gradient(135deg, #6366F1, #818CF8)', color: '#fff', boxShadow: '0 4px 16px rgba(99,102,241,0.3)' }}>
                {createMutation.isPending ? 'Adding...' : 'Add User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AdminUsers

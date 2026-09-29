import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import AppShell from './components/layout/AppShell'

// Pages
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Artists from './pages/Artists'
import ArtistProfile from './pages/ArtistProfile'
import Concerts from './pages/Concerts'
import Venues from './pages/Venues'
import ConcertDetail from './pages/ConcertDetail'
import Demographics from './pages/Demographics'
import AdminUsers from './pages/AdminUsers'
import AdminIngestion from './pages/AdminIngestion'
import NotFound from './pages/NotFound'
import Analysis from './pages/Analysis'

import useAuthStore from './store/useAuthStore'

// Protected Route Wrapper
function ProtectedRoute({ children }) {
  const token = useAuthStore((state) => state.token)
  const location = useLocation()

  if (!token) {
    // Redirect to login, saving the attempted location for post-login redirect
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return children ? children : <AppShell />
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/login" element={<Login />} />

        {/* Protected Routes */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppShell />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="artists" element={<Artists />} />
          <Route path="artists/:id" element={<ArtistProfile />} />
          <Route path="concerts" element={<Concerts />} />
          <Route path="venues" element={<Venues />} />
          <Route path="concerts/:id" element={<ConcertDetail />} />
          {/* <Route path="demographics" element={<Demographics />} /> */}
          {/* Map View unlinked, not deleted (2026-09-29): 0% real data
              coverage today (no concert or venue in this app has ever had
              lat/lng geocoded), and every real question it could answer --
              touring footprint, where to tour next -- is already answered
              better, with real ranked data, by touring_history's insights
              and the Feasibility/TOPSIS tab. src/pages/MapView.jsx is left
              in place, archived, in case real geocoded data makes a map
              worthwhile later. */}
          <Route path="admin/users" element={<AdminUsers />} />
          <Route path="admin/ingestion" element={<AdminIngestion />} />
          <Route path="analysis" element={<Analysis />} />
        </Route>

        {/* 404 */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
import { useState, useRef } from 'react'
import { Upload, RefreshCw, CheckCircle, XCircle, Clock, AlertCircle } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import PageHeader from '../components/ui/PageHeader'
import client from '../api/client'

const PLATFORMS = [
  { key: 'instagram',  label: 'Instagram',   color: '#E1306C' },
  { key: 'youtube',    label: 'YouTube',     color: '#FF0000' },
  { key: 'spotify',    label: 'Spotify',     color: '#1DB954' },
  { key: 'facebook',   label: 'Facebook',    color: '#1877F2' },
  { key: 'twitter',    label: 'Twitter / X', color: '#000000' },
]

const SCRAPE_SOURCES = [
  { key: 'BOOKMYSHOW', label: 'BookMyShow' },
  { key: 'SONGKICK', label: 'Songkick' },
  { key: 'BANDSINTOWN', label: 'Bandsintown' },
  { key: 'EVENTBRITE', label: 'Eventbrite' },
  { key: 'GOOGLE_CSE', label: 'Google CSE' },
]

const STATUS_META = {
  SUCCESS: { icon: CheckCircle, color: 'var(--accent-green)', bg: 'rgba(16,185,129,0.12)',  label: 'Success' },
  FAILED:  { icon: XCircle,     color: 'var(--accent-red)',   bg: 'rgba(239,68,68,0.12)',   label: 'Failed'  },
  RUNNING: { icon: RefreshCw,   color: 'var(--accent-indigo)',bg: 'rgba(99,102,241,0.12)', label: 'Running' },
  PENDING: { icon: Clock,       color: 'var(--accent-gold)',  bg: 'rgba(245,158,11,0.12)', label: 'Pending' },
}

function AdminIngestion() {
  const queryClient = useQueryClient()
  const [dragOver, setDragOver]     = useState(false)
  const [uploadedFile, setFile]     = useState(null)
  const [uploading, setUploading]   = useState(false)
  const [uploadDone, setUploadDone] = useState(false)
  const fileRef = useRef()

  // Fetch jobs
  const { data: jobsData } = useQuery({
    queryKey: ['ingestionJobs'],
    queryFn: async () => {
      const response = await client.get('/ingestion/jobs')
      return response.data.data.jobs
    },
    refetchInterval: 5000, // Poll every 5s while on this page
  })

  const jobs = jobsData || []

  const { data: artistOptions = [] } = useQuery({
    queryKey: ['artists', 'scrape-options'],
    queryFn: async () => {
      const response = await client.get('/artists?limit=100')
      return response.data.data?.artists || []
    },
    staleTime: 2 * 60 * 1000,
  })

  // Sync platform mutation
  const syncMutation = useMutation({
    mutationFn: (platform) => client.post(`/ingestion/sync/${platform}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ingestionJobs'] })
  })

  // Enrich artists mutation
  const enrichMutation = useMutation({
    mutationFn: () => client.post('/ingestion/enrich'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingestionJobs'] })
      queryClient.invalidateQueries({ queryKey: ['artists'] })
      queryClient.invalidateQueries({ queryKey: ['artist'] })
    }
  })

  // Scrape concerts mutation
  const scrapeMutation = useMutation({
    mutationFn: ({ sources, dateFrom, dateTo, artistIds, country }) =>
      client.post('/concerts/intelligence', {
        sources,
        artistIds,
        dateFrom,
        dateTo,
        country: country || undefined,
        limitPerSource: 25,
        maxPages: 8,
        runPredictions: true,
        persistConcerts: true,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingestionJobs'] })
      queryClient.invalidateQueries({ queryKey: ['concerts'] })
      queryClient.invalidateQueries({ queryKey: ['concert'] })
    }
  })

  const [scrapeSources, setScrapeSources] = useState(['BOOKMYSHOW', 'SONGKICK', 'BANDSINTOWN', 'EVENTBRITE'])
  const [selectedArtistIds, setSelectedArtistIds] = useState([])
  const [scrapeCountry, setScrapeCountry] = useState('')
  const [dateFrom, setDateFrom] = useState(() => new Date().toISOString().split('T')[0])
  const [dateTo, setDateTo] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() + 18)
    return d.toISOString().split('T')[0]
  })

  // Excel upload mutation
  const uploadMutation = useMutation({
    mutationFn: (formData) => client.post('/ingestion/excel/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    }),
    onSuccess: () => {
      setUploading(false)
      setUploadDone(true)
      queryClient.invalidateQueries({ queryKey: ['ingestionJobs'] })
      setTimeout(() => { setFile(null); setUploadDone(false) }, 3000)
    },
    onError: () => setUploading(false)
  })

  function handleSync(platform) {
    syncMutation.mutate(platform.key)
  }

  function handleFileDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer?.files?.[0] || e.target.files?.[0]
    if (file) setFile(file)
  }

  function handleUpload() {
    if (!uploadedFile) return
    setUploading(true)
    const formData = new FormData()
    formData.append('file', uploadedFile)
    uploadMutation.mutate(formData)
  }

  return (
    <div>
      <PageHeader title="Data Ingestion" subtitle="Sync platform data and upload Excel files" />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">

        {/* Upload */}
        <div className="glass-card p-5 animate-fade-up">
          <h3 className="font-display font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>Excel Data Upload</h3>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>Upload .xlsx files for artist metrics, concerts or demographics</p>

          <div onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleFileDrop}
            onClick={() => fileRef.current.click()}
            className="rounded-2xl p-10 text-center cursor-pointer transition-all duration-200"
            style={{
              border: `2px dashed ${dragOver ? 'var(--accent-indigo)' : uploadedFile ? 'var(--accent-green)' : 'var(--border-strong)'}`,
              background: dragOver ? 'rgba(99,102,241,0.05)' : uploadedFile ? 'rgba(16,185,129,0.05)' : 'var(--bg-secondary)'
            }}>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileDrop} />
            {uploadDone ? (
              <div className="flex flex-col items-center gap-2">
                <CheckCircle size={32} style={{ color: 'var(--accent-green)' }} />
                <p className="text-sm font-bold" style={{ color: 'var(--accent-green)' }}>Upload Successful!</p>
              </div>
            ) : uploadedFile ? (
              <div className="flex flex-col items-center gap-2">
                <CheckCircle size={28} style={{ color: 'var(--accent-green)' }} />
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{uploadedFile.name}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{(uploadedFile.size / 1024).toFixed(1)} KB</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Upload size={28} style={{ color: 'var(--text-muted)' }} />
                <p className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Drop your Excel file here</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>or click to browse · .xlsx .xls .csv</p>
              </div>
            )}
          </div>

          {uploadedFile && !uploadDone && (
            <button onClick={handleUpload} disabled={uploading}
              className="w-full mt-3 py-3 rounded-xl text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-60"
              style={{ background: 'linear-gradient(135deg, #6366F1, #818CF8)', color: '#fff', boxShadow: '0 4px 16px rgba(99,102,241,0.3)' }}>
              {uploading ? <><RefreshCw size={14} className="animate-spin" /> Processing...</> : <><Upload size={14} /> Upload & Import</>}
            </button>
          )}

          <div className="mt-4 p-3 rounded-xl flex items-start gap-2"
            style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.15)' }}>
            <AlertCircle size={13} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--accent-indigo)' }} />
            <p className="text-xs" style={{ color: 'var(--accent-indigo)' }}>
              Use the provided template. Sheets: <strong>Artist_Metrics</strong>, <strong>Concerts</strong>
            </p>
          </div>
        </div>

        {/* Artist Enrichment */}
        <div className="glass-card p-5 animate-fade-up delay-1">
          <h3 className="font-display font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>Artist Data Enrichment</h3>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>Fetch real social media data from external APIs to fill missing artist profiles</p>

          <div className="p-4 rounded-xl mb-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2 h-2 rounded-full" style={{ background: '#1DB954' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Spotify</span>
            </div>
            <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
              Searches each artist on Spotify, fetches follower count and popularity, then stores in platform metrics
            </p>
            <button onClick={() => enrichMutation.mutate()} disabled={enrichMutation.isPending}
              className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-60"
              style={{ background: 'linear-gradient(135deg, #1DB954, #169C46)', color: '#fff', boxShadow: '0 4px 16px rgba(29,185,84,0.3)' }}>
              {enrichMutation.isPending ? (
                <><RefreshCw size={14} className="animate-spin" /> Enriching All Artists...</>
              ) : (
                <><RefreshCw size={14} /> Enrich All Artists</>
              )}
            </button>
          </div>

          {enrichMutation.data?.data && (
            <div className="p-3 rounded-xl flex items-start gap-2"
              style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.15)' }}>
              <CheckCircle size={13} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--accent-green)' }} />
              <p className="text-xs" style={{ color: 'var(--accent-green)' }}>
                Enriched {enrichMutation.data.data.enriched} / {enrichMutation.data.data.total} artists
                {enrichMutation.data.data.failed > 0 && ` (${enrichMutation.data.data.failed} failed)`}
              </p>
            </div>
          )}
        </div>

        {/* Platform Sync */}
        <div className="glass-card p-5 animate-fade-up delay-1">
          <h3 className="font-display font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>Platform API Sync</h3>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>Manually trigger a data sync for any connected platform</p>
          <div className="space-y-3">
            {PLATFORMS.map(platform => (
              <div key={platform.key} className="flex items-center justify-between p-3 rounded-xl transition-all duration-200"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold"
                    style={{ background: platform.color }}>
                    {platform.label[0]}
                  </div>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{platform.label}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Last sync: Today 04:00</p>
                  </div>
                </div>
                <button onClick={() => handleSync(platform)} disabled={syncMutation.isPending}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl transition-all duration-200 disabled:opacity-60"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-indigo)'; e.currentTarget.style.color = 'var(--accent-indigo)' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)' }}>
                  <RefreshCw size={12} className={syncMutation.isPending ? 'animate-spin' : ''} />
                  {syncMutation.isPending ? 'Syncing...' : 'Sync Now'}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Concert Scraper */}
      <div className="glass-card p-5 mb-6 animate-fade-up delay-1">
        <h3 className="font-display font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>Concert Scraper</h3>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>Pick DB artists, scrape concerts, validate events, predict revenue and store concerts</p>

        <div className="grid grid-cols-1 sm:grid-cols-6 gap-3 mb-4">
          <div className="sm:col-span-2">
            <label className="text-xs font-semibold uppercase tracking-widest block mb-1"
              style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Artists</label>
            <select multiple value={selectedArtistIds} onChange={e => setSelectedArtistIds(Array.from(e.target.selectedOptions, option => option.value))}
              className="w-full rounded-xl px-3 py-2 text-sm outline-none min-h-[42px]"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
              {artistOptions.map(artist => (
                <option key={artist.id} value={artist.id}>{artist.artistName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-widest block mb-1"
              style={{ color: 'var(--text-muted)', fontSize: '10px' }}>From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="w-full rounded-xl px-3 py-2 text-sm outline-none"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-widest block mb-1"
              style={{ color: 'var(--text-muted)', fontSize: '10px' }}>To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="w-full rounded-xl px-3 py-2 text-sm outline-none"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-widest block mb-1"
              style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Country</label>
            <input type="text" value={scrapeCountry} onChange={e => setScrapeCountry(e.target.value)}
              placeholder="Any"
              className="w-full rounded-xl px-3 py-2 text-sm outline-none"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
          </div>
          <div className="flex items-end gap-2">
            <button onClick={() => scrapeMutation.mutate({
              sources: scrapeSources,
              artistIds: selectedArtistIds,
              dateFrom,
              dateTo,
              country: scrapeCountry.trim(),
            })} disabled={scrapeMutation.isPending || scrapeSources.length === 0 || selectedArtistIds.length === 0}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-60"
              style={{ background: 'linear-gradient(135deg, #6366F1, #818CF8)', color: '#fff' }}>
              {scrapeMutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />}
              {scrapeMutation.isPending ? 'Scraping...' : 'Start Scrape'}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {SCRAPE_SOURCES.map(src => (
            <label key={src.key} className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-xl cursor-pointer select-none transition-all duration-200"
              style={{
                background: scrapeSources.includes(src.key) ? 'rgba(99,102,241,0.12)' : 'var(--bg-secondary)',
                border: `1px solid ${scrapeSources.includes(src.key) ? 'rgba(99,102,241,0.3)' : 'var(--border)'}`,
                color: scrapeSources.includes(src.key) ? 'var(--accent-indigo)' : 'var(--text-muted)',
              }}>
              <input type="checkbox" checked={scrapeSources.includes(src.key)}
                onChange={e => setScrapeSources(e.target.checked ? [...scrapeSources, src.key] : scrapeSources.filter(s => s !== src.key))}
                className="hidden" />
              {src.label}
            </label>
          ))}
        </div>

        {scrapeMutation.data?.data?.data && (
          <div className="mt-3 p-3 rounded-xl flex items-start gap-2"
            style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.15)' }}>
            <CheckCircle size={13} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--accent-indigo)' }} />
            <div className="text-xs" style={{ color: 'var(--accent-indigo)' }}>
              Scraped <strong>{scrapeMutation.data.data.data.scrapedCount}</strong> concerts,
              validated <strong>{scrapeMutation.data.data.data.validatedCount}</strong>,
              predicted <strong>{scrapeMutation.data.data.data.predictedCount}</strong>,
              stored <strong>{scrapeMutation.data.data.data.storedConcertCount}</strong>
              {scrapeMutation.data.data.data.errors?.length > 0 && ` (${scrapeMutation.data.data.data.errors.length} source errors)`}
            </div>
          </div>
        )}
      </div>

      {/* Job Log */}
      <div className="glass-card overflow-hidden animate-fade-up delay-2">
        <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <h3 className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Ingestion Job Log</h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Recent sync and import activity</p>
        </div>
        <table className="w-full text-sm">
          <thead style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>
            <tr>
              {['Job', 'Status', 'Rows', 'Duration', 'Time'].map(h => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-widest"
                  style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const meta = STATUS_META[job.status] || STATUS_META.PENDING
              const Icon = meta.icon
              return (
                <tr key={job.id} style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td className="px-4 py-3 font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                    {job.jobType === 'EXCEL_IMPORT' ? `Excel: ${job.fileName}` : `${job.fileName} Sync`}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full"
                      style={{ background: meta.bg, color: meta.color }}>
                      <Icon size={10} className={job.status === 'RUNNING' ? 'animate-spin' : ''} />
                      {meta.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {job.rowCount > 0 ? `${job.rowCount} rows` : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                    {job.duration ? `${job.duration}s` : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {new Date(job.startedAt).toLocaleString()}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default AdminIngestion

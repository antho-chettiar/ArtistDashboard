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

// Every mutation on this page previously had either no onError at all, or an
// onError that only reset a loading flag -- a real failure (bad Excel sheet
// names, a rejected scrape, a sync error) looked exactly like nothing
// happened, with the button just quietly going back to idle. The backend's
// errorHandler consistently puts the real reason in `message` (see
// backend/src/middleware/errorHandler.ts) for both its own thrown errors and
// ones it forwards from a controller; axios's own `error.message` is the
// fallback for a request that never reached the server at all (network
// down, CORS rejection, etc).
function apiErrorMessage(error) {
  return error?.response?.data?.message || error?.response?.data?.error || error?.message || 'Something went wrong. Please try again.'
}

function ErrorBanner({ message }) {
  if (!message) return null
  return (
    <div className="mt-3 p-3 rounded-xl flex items-start gap-2"
      style={{ background: 'color-mix(in srgb, var(--accent-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-red) 20%, transparent)' }}>
      <AlertCircle size={13} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--accent-red)' }} />
      <p className="text-xs" style={{ color: 'var(--accent-red)' }}>{message}</p>
    </div>
  )
}

const STATUS_META = {
  SUCCESS: { icon: CheckCircle, color: 'var(--accent-green)', bg: 'color-mix(in srgb, var(--accent-green) 12%, transparent)',  label: 'Success' },
  FAILED:  { icon: XCircle,     color: 'var(--accent-red)',   bg: 'color-mix(in srgb, var(--accent-red) 12%, transparent)',   label: 'Failed'  },
  RUNNING: { icon: RefreshCw,   color: 'var(--accent-indigo)',bg: 'color-mix(in srgb, var(--accent-indigo) 12%, transparent)', label: 'Running' },
  PENDING: { icon: Clock,       color: 'var(--accent-gold)',  bg: 'color-mix(in srgb, var(--accent-gold) 12%, transparent)', label: 'Pending' },
}

function AdminIngestion() {
  const queryClient = useQueryClient()
  const [dragOver, setDragOver]     = useState(false)
  const [uploadedFile, setFile]     = useState(null)
  const [uploading, setUploading]   = useState(false)
  const [uploadDone, setUploadDone] = useState(false)
  const fileRef = useRef()

  // Fetch jobs. limit=100 (backend default is 20) so a platform's last real
  // sync job doesn't get pushed out of this list by more-recent Excel
  // imports/enrichment runs -- the per-platform "Last sync" times below read
  // straight out of this same list, so it has to actually contain them.
  const { data: jobsData } = useQuery({
    queryKey: ['ingestionJobs'],
    queryFn: async () => {
      const response = await client.get('/ingestion/jobs?limit=100')
      return response.data.data.jobs
    },
    refetchInterval: 5000, // Poll every 5s while on this page
  })

  const jobs = jobsData || []

  // Real per-platform last-sync time, read from the same ingestion_jobs
  // table the Job Log below renders -- replaces a hardcoded "Today 04:00"
  // that showed for every platform regardless of whether it had ever
  // actually synced. A PLATFORM_SYNC job's `fileName` column holds the
  // platform key (see backend ingestion.controller.ts's syncPlatform).
  const lastSyncByPlatform = jobs
    .filter(j => j.jobType === 'PLATFORM_SYNC')
    .reduce((acc, j) => {
      const existing = acc[j.fileName]
      if (!existing || new Date(j.startedAt) > new Date(existing.startedAt)) acc[j.fileName] = j
      return acc
    }, {})

  // Only Spotify sync is actually wired up server-side today (see
  // backend ingestion.controller.ts's syncPlatform -- every other platform
  // returns a 400 "Unsupported platform"). Showing a live "Sync Now" button
  // for the other four would silently fail if clicked in front of anyone.
  const SUPPORTED_SYNC_PLATFORMS = ['spotify']

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

  // Enrich artists mutation. No onError needed to populate .isError/.error --
  // React Query tracks those regardless; see the ErrorBanner rendered from
  // enrichMutation.isError further below.
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
  // "to" not after "from" previously wasn't checked client-side at all --
  // combined with scrapeMutation having no error surface either, a
  // fat-fingered range just silently produced an empty result with zero
  // explanation. Real validation, not just a fix for the silent failure.
  const dateRangeInvalid = Boolean(dateFrom) && Boolean(dateTo) && new Date(dateTo) <= new Date(dateFrom)

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
    onError: () => setUploading(false) // error text itself rendered via uploadMutation.isError below
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
              background: dragOver ? 'color-mix(in srgb, var(--accent-indigo) 5%, transparent)' : uploadedFile ? 'color-mix(in srgb, var(--accent-green) 5%, transparent)' : 'var(--bg-secondary)'
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
              style={{ background: 'linear-gradient(135deg, var(--accent-indigo), var(--accent-indigo))', color: '#fff', boxShadow: '0 4px 16px color-mix(in srgb, var(--accent-indigo) 30%, transparent)' }}>
              {uploading ? <><RefreshCw size={14} className="animate-spin" /> Processing...</> : <><Upload size={14} /> Upload & Import</>}
            </button>
          )}

          {uploadMutation.isError && <ErrorBanner message={apiErrorMessage(uploadMutation.error)} />}

          <div className="mt-4 p-3 rounded-xl flex items-start gap-2"
            style={{ background: 'color-mix(in srgb, var(--accent-indigo) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-indigo) 15%, transparent)' }}>
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
              style={{ background: 'color-mix(in srgb, var(--accent-green) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-green) 15%, transparent)' }}>
              <CheckCircle size={13} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--accent-green)' }} />
              <p className="text-xs" style={{ color: 'var(--accent-green)' }}>
                Enriched {enrichMutation.data.data.enriched} / {enrichMutation.data.data.total} artists
                {enrichMutation.data.data.failed > 0 && ` (${enrichMutation.data.data.failed} failed)`}
              </p>
            </div>
          )}
          {enrichMutation.isError && <ErrorBanner message={apiErrorMessage(enrichMutation.error)} />}
        </div>

        {/* Platform Sync */}
        <div className="glass-card p-5 animate-fade-up delay-1">
          <h3 className="font-display font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>Platform API Sync</h3>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>Manually trigger a data sync for any connected platform</p>
          <div className="space-y-3">
            {PLATFORMS.map(platform => {
              const isSupported = SUPPORTED_SYNC_PLATFORMS.includes(platform.key)
              const lastJob = lastSyncByPlatform[platform.key]
              const isThisPending = syncMutation.isPending && syncMutation.variables === platform.key
              const thisFailed = syncMutation.isError && syncMutation.variables === platform.key
              return (
              <div key={platform.key} className="flex items-center justify-between p-3 rounded-xl transition-all duration-200"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold"
                    style={{ background: platform.color }}>
                    {platform.label[0]}
                  </div>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{platform.label}</p>
                    <p className="text-xs" style={{ color: thisFailed ? 'var(--accent-red)' : 'var(--text-muted)' }}>
                      {thisFailed
                        ? `Sync failed: ${apiErrorMessage(syncMutation.error)}`
                        : !isSupported
                          ? 'Not connected yet'
                          : lastJob
                            ? `Last sync: ${new Date(lastJob.completedAt || lastJob.startedAt).toLocaleString()}${lastJob.status === 'FAILED' ? ' (failed)' : ''}`
                            : 'Never synced'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleSync(platform)}
                  disabled={!isSupported || syncMutation.isPending}
                  title={!isSupported ? 'This platform sync is not wired up yet' : undefined}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl transition-all duration-200 disabled:opacity-60"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                  onMouseEnter={e => { if (isSupported) { e.currentTarget.style.borderColor = 'var(--accent-indigo)'; e.currentTarget.style.color = 'var(--accent-indigo)' } }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)' }}>
                  <RefreshCw size={12} className={isThisPending ? 'animate-spin' : ''} />
                  {!isSupported ? 'Not available' : isThisPending ? 'Syncing...' : 'Sync Now'}
                </button>
              </div>
              )
            })}
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
              style={{ background: 'var(--bg-secondary)', border: `1px solid ${dateRangeInvalid ? 'var(--accent-red)' : 'var(--border)'}`, color: 'var(--text-primary)' }} />
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
            })} disabled={scrapeMutation.isPending || scrapeSources.length === 0 || selectedArtistIds.length === 0 || dateRangeInvalid}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-60"
              style={{ background: 'linear-gradient(135deg, var(--accent-indigo), var(--accent-indigo))', color: '#fff' }}>
              {scrapeMutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />}
              {scrapeMutation.isPending ? 'Scraping...' : 'Start Scrape'}
            </button>
          </div>
        </div>

        {dateRangeInvalid && (
          <p className="text-xs mb-3" style={{ color: 'var(--accent-red)' }}>
            "To" date must be after "From" date.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {SCRAPE_SOURCES.map(src => (
            <label key={src.key} className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-xl cursor-pointer select-none transition-all duration-200"
              style={{
                background: scrapeSources.includes(src.key) ? 'color-mix(in srgb, var(--accent-indigo) 12%, transparent)' : 'var(--bg-secondary)',
                border: `1px solid ${scrapeSources.includes(src.key) ? 'color-mix(in srgb, var(--accent-indigo) 30%, transparent)' : 'var(--border)'}`,
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
            style={{ background: 'color-mix(in srgb, var(--accent-indigo) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-indigo) 15%, transparent)' }}>
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
        {scrapeMutation.isError && <ErrorBanner message={apiErrorMessage(scrapeMutation.error)} />}
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

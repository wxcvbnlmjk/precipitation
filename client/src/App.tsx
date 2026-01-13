import { useEffect, useMemo, useRef, useState } from 'react'
import { ImageOverlay, MapContainer, TileLayer } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'

type PrecipMeta = {
  hour?: string | null
  var?: string
  gribFile?: string
  updatedAt: number
  bounds: [[number, number], [number, number]]
  source: 'wgrib2' | 'gdal' | 'synthetic'
  message: string
}

type OverlayState = {
  updatedAt: number
  url: string
  bounds: [[number, number], [number, number]]
}

type PrefetchEntry = {
  meta: PrecipMeta
  overlay: OverlayState
}

type MeteoVar = 'CAPE' | 'RPRATE' | 'SPRATE' | 'GPRATE' | 'LCDC' | 'PRES'

const VARS: { key: MeteoVar; label: string; desc: string }[] = [
  { key: 'CAPE', label: 'CAPE', desc: 'Orages, pluie intense' },
  { key: 'RPRATE', label: 'RPRATE', desc: 'Pluie liquide (Cumuls)' },
  { key: 'SPRATE', label: 'SPRATE', desc: 'Neige (Total précip)' },
  { key: 'GPRATE', label: 'GPRATE', desc: 'Grésil (Spécifique)' },
  { key: 'LCDC', label: 'LCDC', desc: 'Nuages bas' },
  { key: 'PRES', label: 'PRES', desc: 'Pression' },
]

const DEFAULT_BOUNDS = [
  [41.0, -5.5],
  [51.5, 9.8],
] as [[number, number], [number, number]]

function nextHourFrom(h: number) {
  return h >= 15 ? 8 : h + 1
}

function pad2(h: number) {
  return String(h).padStart(2, '0')
}

function App() {
  const [meta, setMeta] = useState<PrecipMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<OverlayState | null>(null)
  const [hour, setHour] = useState<number>(8)
  const [meteoVar, setMeteoVar] = useState<MeteoVar>('RPRATE')
  const [isPlaying, setIsPlaying] = useState<boolean>(false)
  const [backendDown, setBackendDown] = useState<boolean>(false)
  const [retryToken, setRetryToken] = useState<number>(0)
  const [fadeFrom, setFadeFrom] = useState<OverlayState | null>(null)
  const [fadeTo, setFadeTo] = useState<OverlayState | null>(null)
  const [fadeT, setFadeT] = useState<number>(0)
  const [fadePhase, setFadePhase] = useState<'in' | 'out' | null>(null)

  const hourStr = useMemo(() => pad2(hour), [hour])
  const varRef = useRef<MeteoVar>(meteoVar)
  useEffect(() => {
    varRef.current = meteoVar
  }, [meteoVar])
  const hourRef = useRef(hour)
  useEffect(() => {
    hourRef.current = hour
  }, [hour])

  const backendDownRef = useRef(backendDown)
  useEffect(() => {
    backendDownRef.current = backendDown
  }, [backendDown])

  const overlayRef = useRef<OverlayState | null>(null)
  useEffect(() => {
    overlayRef.current = overlay
  }, [overlay])

  const fadeFromRef = useRef<OverlayState | null>(null)
  const fadeToRef = useRef<OverlayState | null>(null)
  const fadeTRef = useRef<number>(0)
  const fadePhaseRef = useRef<'in' | 'out' | null>(null)
  const cancelFadeRef = useRef<null | (() => void)>(null)
  useEffect(() => {
    fadeFromRef.current = fadeFrom
  }, [fadeFrom])
  useEffect(() => {
    fadeToRef.current = fadeTo
  }, [fadeTo])
  useEffect(() => {
    fadeTRef.current = fadeT
  }, [fadeT])
  useEffect(() => {
    fadePhaseRef.current = fadePhase
  }, [fadePhase])

  const prefetchCacheRef = useRef<Map<string, PrefetchEntry>>(new Map())
  const prefetchInFlightRef = useRef<Map<string, Promise<PrefetchEntry>>>(new Map())

  const animIntervalMs = 900
  const overlayOpacity = 0.7
  const fadeDurationMs = 300
  const backendOrigin = 'http://localhost:3001'
  const offlineBase = '/local-cache'

  function isBackendDownDetails(details: string) {
    const d = details.toLowerCase()
    return (
      d.includes('econnrefused') ||
      d.includes('failed to proxy') ||
      d.includes('proxy error') ||
      (d.includes('connect') && d.includes('3001')) ||
      d.includes('localhost:3001')
    )
  }

  function backendDownError() {
    return new Error('Backend non démarré. Lance `npm run dev:server` (ou `npm run dev:all`).')
  }

  async function pingBackend() {
    try {
      await fetch(`${backendOrigin}/`, { cache: 'no-store', mode: 'cors' })
      return true
    } catch {
      return false
    }
  }

  async function fetchMetaForHour(h: string, signal?: AbortSignal) {
    const v = varRef.current
    const r = await fetch(`/api/precip/meta?hour=${h}&var=${encodeURIComponent(v)}`, { signal })
    if (!r.ok) {
      let details = ''
      try {
        details = await r.text()
      } catch {}
      if (r.status >= 500) {
    		if (isBackendDownDetails(details)) throw backendDownError()
        const alive = await pingBackend()
        if (!alive) throw backendDownError()
      }
      throw new Error(`HTTP ${r.status}${details ? `: ${details.slice(0, 200)}` : ''}`)
    }
    return (await r.json()) as PrecipMeta
  }

  async function fetchOverlayBlobUrl(h: string, updatedAt: number) {
    const v = varRef.current
    const r = await fetch(
      `/api/precip/overlay.png?hour=${h}&var=${encodeURIComponent(v)}&ts=${updatedAt}`,
      { cache: 'no-store' },
    )
    if (!r.ok) {
      let details = ''
      try {
        details = await r.text()
      } catch {}
      if (r.status >= 500) {
        if (isBackendDownDetails(details)) throw backendDownError()
        const alive = await pingBackend()
        if (!alive) throw backendDownError()
      }
      throw new Error(`HTTP ${r.status}${details ? `: ${details.slice(0, 200)}` : ''}`)
    }
    const blob = await r.blob()
    return URL.createObjectURL(blob)
  }

  async function fetchOfflineOverlayBlobUrl(h: string) {
    const v = varRef.current.toLowerCase()
    const r = await fetch(`${offlineBase}/${v}_${h}H_color.png`, { cache: 'no-store' })
    if (!r.ok) throw new Error(`PNG manquant: server/cache/${v}_${h}H_color.png`)
    const blob = await r.blob()
    return URL.createObjectURL(blob)
  }

  function offlineMetaForHour(h: string) {
    const now = Date.now()
    const v = varRef.current
    const m: PrecipMeta = {
      hour: h,
      gribFile: `${h}H.grib2`,
      updatedAt: now,
      bounds: DEFAULT_BOUNDS,
      source: 'synthetic',
      message: `Mode offline (${v}): PNG depuis server/cache`,
    }
    return m
  }

  function prefetchHour(h: string) {
    const cacheKey = `${varRef.current}_${h}`
    let offline = backendDownRef.current
    const cached = prefetchCacheRef.current.get(cacheKey)
    if (cached) return Promise.resolve(cached)

    const inflight = prefetchInFlightRef.current.get(cacheKey)
    if (inflight) return inflight

    const p = (async () => {
      if (!offline) {
        const alive = await pingBackend()
        if (!alive) {
          offline = true
          setBackendDown(true)
        }
      }

      let m: PrecipMeta | null = null
      let url: string | null = null
      if (!offline) {
        try {
          m = await fetchMetaForHour(h)
          url = await fetchOverlayBlobUrl(h, m.updatedAt)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('Backend non démarré')) {
            offline = true
            setBackendDown(true)
          } else {
            throw e
          }
        }
      }

      if (offline) {
        m = offlineMetaForHour(h)
        url = await fetchOfflineOverlayBlobUrl(h)
      }

      if (!m || !url) {
        throw new Error('Préchargement overlay impossible')
      }

      const entry: PrefetchEntry = {
        meta: m,
        overlay: { updatedAt: m.updatedAt, url, bounds: m.bounds },
      }

      const prev = prefetchCacheRef.current.get(cacheKey)
      if (prev?.overlay?.url && prev.overlay.url.startsWith('blob:') && prev.overlay.url !== url) {
        try {
          URL.revokeObjectURL(prev.overlay.url)
        } catch {}
      }

      prefetchCacheRef.current.set(cacheKey, entry)
      return entry
    })()

    prefetchInFlightRef.current.set(cacheKey, p)
    p.then(
      () => {
        prefetchInFlightRef.current.delete(cacheKey)
      },
      () => {
        prefetchInFlightRef.current.delete(cacheKey)
      },
    )
    return p
  }

  function startOverlayTransition(next: OverlayState) {
    if (cancelFadeRef.current) {
      cancelFadeRef.current()
      cancelFadeRef.current = null
    }

    setFadePhase(null)
    fadePhaseRef.current = null

    const curFadeFrom = fadeFromRef.current
    const curFadeTo = fadeToRef.current
    const curFadeT = fadeTRef.current
    const curStable = overlayRef.current

    const curVisible =
      curFadeFrom && curFadeTo ? (curFadeT >= 0.5 ? curFadeTo : curFadeFrom) : curStable

    if (!curVisible) {
      setOverlay(next)
      setFadeFrom(null)
      setFadeTo(null)
      setFadeT(0)
      setFadePhase(null)
      return
    }

    if (curVisible.url === next.url && curVisible.updatedAt === next.updatedAt) {
      setOverlay(next)
      setFadeFrom(null)
      setFadeTo(null)
      setFadeT(0)
      setFadePhase(null)
      return
    }

    setFadeFrom(curVisible)
    setFadeTo(next)
    setFadeT(0)
    setFadePhase('in')
    fadePhaseRef.current = 'in'

    const phaseStart = performance.now()
    let raf = 0
    const step = (t: number) => {
      const phase = fadePhaseRef.current
      const start = phaseStart
      const p = Math.min(1, (t - start) / fadeDurationMs)
      setFadeT(p)

      if (p >= 1) {
        if (phase === 'in') {
          setFadeT(0)
          setFadePhase('out')
          fadePhaseRef.current = 'out'
          const outStart = performance.now()
          const stepOut = (t2: number) => {
            const p2 = Math.min(1, (t2 - outStart) / fadeDurationMs)
            setFadeT(p2)
            if (p2 >= 1) {
              setOverlay(next)
              setFadeFrom(null)
              setFadeTo(null)
              setFadeT(0)
              setFadePhase(null)
              return
            }
            raf = requestAnimationFrame(stepOut)
          }
          raf = requestAnimationFrame(stepOut)
          return
        }

        setOverlay(next)
        setFadeFrom(null)
        setFadeTo(null)
        setFadeT(0)
        setFadePhase(null)
        return
      }

      raf = requestAnimationFrame(step)
    }

    raf = requestAnimationFrame(step)

    const cancel = () => {
      cancelAnimationFrame(raf)
    }
    cancelFadeRef.current = cancel
    return cancel
  }

  useEffect(() => {
    if (isPlaying) return

    let cancelled = false

    const cached = prefetchCacheRef.current.get(`${meteoVar}_${hourStr}`)
    if (cached) {
      setMeta(cached.meta)
      startOverlayTransition(cached.overlay)
    }

    prefetchHour(hourStr)
      .then((entry) => {
        if (cancelled) return
        setMeta(entry.meta)
        startOverlayTransition(entry.overlay)
        setError(null)
        if (!backendDownRef.current) setBackendDown(false)
      })
      .catch((e) => {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        if (msg.includes('Backend non démarré')) setBackendDown(true)
      })

    return () => {
      cancelled = true
    }
  }, [hourStr, meteoVar, isPlaying, backendDown, retryToken])

  useEffect(() => {
    if (isPlaying) return
    if (backendDown) return
    let cancelled = false
    let timer: number | undefined

    async function poll() {
      let stop = false
      try {
        const entry = await prefetchHour(hourStr)
        if (cancelled) return
        setMeta(entry.meta)
        startOverlayTransition(entry.overlay)
        setError(null)
        setBackendDown(false)
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        if (msg.includes('Backend non démarré')) {
          stop = true
          setBackendDown(true)
        }
      } finally {
        if (cancelled) return
        if (stop || backendDownRef.current) return
        timer = window.setTimeout(poll, 10_000)
      }
    }

    timer = window.setTimeout(poll, 10_000)

    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [hourStr, meteoVar, isPlaying, backendDown, retryToken])

  useEffect(() => {
    if (!isPlaying) return

    let cancelled = false
    let timer: number | undefined

    const tick = async () => {
      let stop = false
      const cur = hourRef.current
      const next = nextHourFrom(cur)
      const nextStr = pad2(next)

      try {
        const entry = await prefetchHour(nextStr)
        if (cancelled) return
        setHour(next)
        setMeta(entry.meta)
        startOverlayTransition(entry.overlay)
        setError(null)
        if (!backendDownRef.current) setBackendDown(false)

        const afterStr = pad2(nextHourFrom(next))
        void prefetchHour(afterStr).catch(() => {})
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        if (msg.includes('Backend non démarré')) setBackendDown(true)
        if (msg.includes('PNG manquant')) stop = true
      }

      if (cancelled) return
      if (stop) return
      timer = window.setTimeout(tick, animIntervalMs)
    }

    void prefetchHour(pad2(nextHourFrom(hourRef.current))).catch(() => {})
    timer = window.setTimeout(tick, animIntervalMs)

    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [isPlaying, meteoVar, backendDown, retryToken])

  useEffect(() => {
    if (!meta?.updatedAt) return
    if (typeof meta.hour === 'string' && meta.hour !== hourStr) return
    const nextStr = pad2(nextHourFrom(hour))
    void prefetchHour(nextStr).catch(() => {})
  }, [meta?.updatedAt, meta?.hour, hour, hourStr, meteoVar, backendDown])

  const overlayUrl = overlay?.url

  const bounds = useMemo(() => {
    const b = overlay?.bounds || meta?.bounds
    return b || DEFAULT_BOUNDS
  }, [overlay?.bounds, meta?.bounds])

  return (
    <div className="app">
      <div className="panel">
        <div className="panel-title">Météo (démo)</div>
        <div className="panel-row">
          Paramètre:{' '}
          <select
            value={meteoVar}
            onChange={(e) => {
              setMeteoVar(e.target.value as MeteoVar)
              setError(null)
            }}
          >
            {VARS.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label} — {v.desc}
              </option>
            ))}
          </select>
        </div>
        <div className="panel-row">
          Heure: <b>{hourStr}H</b>
        </div>
        <div className="panel-row">
          <input
            type="range"
            min={8}
            max={15}
            step={1}
            value={hour}
            onChange={(e) => {
              setHour(Number(e.target.value))
              setError(null)
            }}
          />
        </div>
        <div className="panel-row">
          <button
            onClick={() => {
              setIsPlaying((p) => !p)
              setError(null)
            }}
          >
            {isPlaying ? 'Pause' : 'Play'}
          </button>
        </div>
        {backendDown ? (
          <div className="panel-row">
            <button
              onClick={() => {
                setBackendDown(false)
                setError(null)
                setRetryToken(Date.now())
              }}
            >
              Réessayer
            </button>
          </div>
        ) : null}
        <div className="panel-row">
          Source: <b>{meta?.source || '...'}</b>
        </div>
        <div className="panel-row">
          Dernière maj: <b>{meta?.updatedAt ? new Date(meta.updatedAt).toLocaleString() : '...'}</b>
        </div>
        <div className="panel-row">{meta?.message || 'Chargement...'}</div>
        {error ? <div className="panel-row">Erreur: {error}</div> : null}
        <div className="panel-row">
          Fichier GRIB: <b>{meta?.gribFile || `${hourStr}H.grib2`}</b>
        </div>
      </div>

      <MapContainer className="map" center={[46.6, 2.4]} zoom={6} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {fadeFrom && fadeTo && fadePhase ? (
          <>
            <ImageOverlay
              key={`fade-from-${fadeFrom.url}`}
              url={fadeFrom.url}
              bounds={fadeFrom.bounds}
              opacity={
                fadePhase === 'in'
                  ? overlayOpacity
                  : fadePhase === 'out'
                    ? overlayOpacity * (1 - fadeT)
                    : overlayOpacity
              }
              zIndex={10}
            />
            <ImageOverlay
              key={`fade-to-${fadeTo.url}`}
              url={fadeTo.url}
              bounds={fadeTo.bounds}
              opacity={
                fadePhase === 'in'
                  ? overlayOpacity * fadeT
                  : fadePhase === 'out'
                    ? overlayOpacity
                    : overlayOpacity
              }
              zIndex={11}
            />
          </>
        ) : overlayUrl ? (
          <ImageOverlay url={overlayUrl} bounds={bounds} opacity={overlayOpacity} />
        ) : null}
      </MapContainer>
    </div>
  )
}

export default App

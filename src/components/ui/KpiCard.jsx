import { useEffect, useState } from 'react'
import RoGBadge from './RoGBadge'

// A "/" (e.g. "143 / 233") is a ratio, not a single animatable count -- the
// digit-stripping numeric parser below would otherwise merge both numbers
// into one meaningless value and swallow the separator entirely.
const isRatioValue = (target) => String(target).includes('/')

function useCountUp(target, duration = 1000) {
  const getDisplayValue = () => {
    if (isRatioValue(target)) return target
    const numeric = parseFloat(String(target).replace(/[^0-9.]/g, ''))
    return isNaN(numeric) ? target : 0
  }

  const [value, setValue] = useState(getDisplayValue)

  useEffect(() => {
    if (isRatioValue(target)) {
      setValue(target)
      return
    }
    const numeric = parseFloat(String(target).replace(/[^0-9.]/g, ''))
    if (isNaN(numeric)) {
      const animationFrame = requestAnimationFrame(() => setValue(target))
      return () => cancelAnimationFrame(animationFrame)
    }
    const start     = performance.now()
    const prefix    = String(target).match(/^[^0-9]*/)?.[0] || ''
    const suffix    = String(target).match(/[^0-9.]+$/)?.[0] || ''
    let animationFrame
    const frame = (now) => {
      const progress = Math.min((now - start) / duration, 1)
      const ease     = 1 - Math.pow(1 - progress, 3)
      const current  = Math.round(numeric * ease * 10) / 10
      setValue(`${prefix}${Number.isInteger(numeric) ? Math.round(current) : current.toFixed(1)}${suffix}`)
      if (progress < 1) animationFrame = requestAnimationFrame(frame)
    }
    animationFrame = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(animationFrame)
  }, [target, duration])
  return value
}

function KpiCard({ title, value, subtitle, rog, icon: Icon, accentColor, delay = 0 }) {
  const animated = useCountUp(value)

  return (
    <div
      className="glass-card p-5 animate-fade-up cursor-default group"
      style={{
        animationDelay: `${delay}ms`,
        animationFillMode: 'both',
        opacity: 0,
      }}
    >
      {/* Top row */}
      <div className="flex items-start justify-between mb-3">
        <p className="text-xs font-semibold uppercase tracking-widest"
          style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
          {title}
        </p>
        {Icon && (
          <div className="w-9 h-9 rounded-xl flex items-center justify-center transition-transform duration-300 group-hover:scale-110"
            style={{ background: `${accentColor || 'var(--accent-indigo)'}18`, border: `1px solid ${accentColor || 'var(--accent-indigo)'}30` }}>
            <Icon size={17} style={{ color: accentColor || 'var(--accent-indigo)' }} />
          </div>
        )}
      </div>

      {/* Value */}
      <p className="font-display font-bold text-2xl mb-1 animate-count-up"
        style={{ color: 'var(--text-primary)', animationDelay: `${delay + 100}ms` }}>
        {animated}
      </p>

      {/* Subtitle */}
      {subtitle && (
        <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>
      )}

      {/* RoG */}
      {rog !== undefined && (
        <div className="pt-2" style={{ borderTop: '1px solid var(--border)' }}>
          <RoGBadge value={rog} />
        </div>
      )}

      {/* Accent bar at bottom */}
      <div className="absolute bottom-0 left-6 right-6 h-0.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{ background: `linear-gradient(90deg, transparent, ${accentColor || 'var(--accent-indigo)'}, transparent)` }} />
    </div>
  )
}

export default KpiCard

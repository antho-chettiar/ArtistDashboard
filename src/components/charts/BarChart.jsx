import {
  BarChart as ReBarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell
} from 'recharts'
import { formatNumber } from '../../utils/formatters'

const COLORS = ['#818CF8', '#FBBF24', '#34D399', '#F87171', '#A78BFA', '#38BDF8', '#FB923C', '#4ADE80']

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl p-3 text-xs shadow-2xl"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}>
      <p className="font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>{label}</p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full" style={{ background: entry.fill || entry.color }} />
          <span style={{ color: 'var(--text-secondary)' }}>{entry.name}:</span>
          <span className="font-bold">{formatNumber(entry.value)}</span>
        </div>
      ))}
    </div>
  )
}

function BarChart({ data = [], bars = [], xKey = 'name', layout = 'vertical', height = 280, multiColor = false }) {
  const isHorizontal = layout === 'horizontal'
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReBarChart data={data} layout={layout} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={isHorizontal} horizontal={!isHorizontal} />
        {isHorizontal ? (
          <>
            {/* interval={0} forces every category label to render -- Recharts'
                default auto-skip-for-space logic was silently hiding some
                (including, confusingly, the tallest bar's label). Angled text
                gives 10 city names room without overlapping. */}
            <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: 'var(--text-muted)', fontFamily: 'Satoshi' }}
              axisLine={false} tickLine={false} interval={0} angle={-35} textAnchor="end" height={50} />
            <YAxis tickFormatter={formatNumber} tick={{ fontSize: 11, fill: 'var(--text-muted)', fontFamily: 'Satoshi' }} axisLine={false} tickLine={false} width={48} />
          </>
        ) : (
          <>
            <XAxis type="number" tickFormatter={formatNumber} tick={{ fontSize: 11, fill: 'var(--text-muted)', fontFamily: 'Satoshi' }} axisLine={false} tickLine={false} />
            <YAxis dataKey={xKey} type="category" tick={{ fontSize: 11, fill: 'var(--text-secondary)', fontFamily: 'Satoshi' }} axisLine={false} tickLine={false} width={100} />
          </>
        )}
        <Tooltip content={<CustomTooltip />} />
        {bars.length > 1 && <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '12px', fontFamily: 'Satoshi' }} />}
        {bars.map((bar, i) => (
          <Bar key={bar.key} dataKey={bar.key} name={bar.label || bar.key}
            fill={bar.color || COLORS[i % COLORS.length]}
            radius={isHorizontal ? [4, 4, 0, 0] : [0, 4, 4, 0]} maxBarSize={36}>
            {multiColor && data.map((_, index) => (
              <Cell key={index} fill={COLORS[index % COLORS.length]} />
            ))}
          </Bar>
        ))}
      </ReBarChart>
    </ResponsiveContainer>
  )
}

export default BarChart
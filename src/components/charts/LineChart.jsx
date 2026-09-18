import {
  LineChart as ReLineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts'
import { formatNumber } from '../../utils/formatters'

const COLORS = ['#818CF8', '#FBBF24', '#34D399', '#F87171', '#A78BFA']

function CustomTooltip({ active, payload, label, valueFormatter }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl p-3 text-xs shadow-2xl"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}>
      <p className="font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>{label}</p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full" style={{ background: entry.color }} />
          <span style={{ color: 'var(--text-secondary)' }}>{entry.name}:</span>
          <span className="font-bold">{(valueFormatter || formatNumber)(entry.value, entry)}</span>
        </div>
      ))}
    </div>
  )
}

function LineChart({ data = [], lines = [], xKey = 'date', height = 280, margin = { top: 5, right: 10, left: 0, bottom: 5 }, yDomain, yTickFormatter, tooltipValueFormatter }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReLineChart data={data} margin={margin}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: 'var(--text-muted)', fontFamily: 'Satoshi' }}
          axisLine={false} tickLine={false} />
        <YAxis domain={yDomain} tickFormatter={yTickFormatter || formatNumber} tick={{ fontSize: 11, fill: 'var(--text-muted)', fontFamily: 'Satoshi' }}
          axisLine={false} tickLine={false} width={48} />
        <Tooltip content={<CustomTooltip valueFormatter={tooltipValueFormatter} />} />
        <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '12px', fontFamily: 'Satoshi', color: 'var(--text-secondary)' }} />
        {lines.map((line, i) => (
          <Line key={line.key} type="monotone" dataKey={line.key}
            name={line.label || line.key}
            stroke={line.color || COLORS[i % COLORS.length]}
            strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 0 }} />
        ))}
      </ReLineChart>
    </ResponsiveContainer>
  )
}

export default LineChart
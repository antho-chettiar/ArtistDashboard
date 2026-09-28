import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer, LabelList,
} from 'recharts'

// Back-to-back ("butterfly"/"tornado") bar chart: one shared category axis
// down the middle, left series extending left of a center 0-line, right
// series extending right of it -- built for comparing two things (here, two
// artists) across several categories (platforms) without one side's overall
// scale drowning out the other, the same problem a normal grouped bar chart
// has when the two sides are very different sizes.
//
// data: [{ category: 'Instagram', left: 57.3, right: 23.1 }, ...] -- both
// `left`/`right` are given as plain POSITIVE numbers (the real value); this
// component negates `left` internally only for plotting, so callers never
// have to think in signed numbers.
function CustomTooltip({ active, payload, label, leftLabel, rightLabel, valueSuffix }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl p-3 text-xs shadow-2xl"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}>
      <p className="font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>{label}</p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full" style={{ background: entry.fill }} />
          <span style={{ color: 'var(--text-secondary)' }}>{entry.dataKey === 'leftValue' ? leftLabel : rightLabel}:</span>
          <span className="font-bold">{formatAbs(entry.value)}{valueSuffix}</span>
        </div>
      ))}
    </div>
  )
}

const formatAbs = (v) => Math.round(Math.abs(v) * 10) / 10

function DivergingBarChart({
  data = [], leftLabel, rightLabel, leftColor = '#818CF8', rightColor = '#FBBF24',
  valueSuffix = '', height = 220,
}) {
  const plotData = data.map(d => ({ ...d, leftValue: -Math.abs(d.left) }))
  const maxAbs = Math.max(1, ...data.map(d => Math.max(Math.abs(d.left), Math.abs(d.right))))
  // Round the domain up a bit so a bar's inside label never gets clipped
  // against the plot edge.
  const domainMax = Math.ceil(maxAbs * 1.15)

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={plotData} layout="vertical" margin={{ top: 5, right: 16, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
        <XAxis
          type="number"
          domain={[-domainMax, domainMax]}
          tickFormatter={(v) => `${formatAbs(v)}${valueSuffix}`}
          tick={{ fontSize: 11, fill: 'var(--text-muted)', fontFamily: 'Satoshi' }}
          axisLine={false} tickLine={false}
        />
        <YAxis
          dataKey="category" type="category"
          tick={{ fontSize: 12, fill: 'var(--text-primary)', fontFamily: 'Satoshi', fontWeight: 600 }}
          axisLine={false} tickLine={false} width={80}
        />
        {/* The dividing line the two sides sit against -- the whole point of
            this chart shape. */}
        <ReferenceLine x={0} stroke="var(--border-strong)" strokeWidth={1.5} />
        <Tooltip content={<CustomTooltip leftLabel={leftLabel} rightLabel={rightLabel} valueSuffix={valueSuffix} />} cursor={{ fill: 'var(--bg-secondary)' }} />
        <Bar dataKey="leftValue" name={leftLabel} fill={leftColor} radius={[4, 0, 0, 4]} maxBarSize={28}>
          <LabelList dataKey="leftValue" position="insideLeft" fill="#fff" fontSize={11} fontWeight={700}
            formatter={(v) => `${formatAbs(v)}${valueSuffix}`} />
        </Bar>
        <Bar dataKey="right" name={rightLabel} fill={rightColor} radius={[0, 4, 4, 0]} maxBarSize={28}>
          <LabelList dataKey="right" position="insideRight" fill="#fff" fontSize={11} fontWeight={700}
            formatter={(v) => `${formatAbs(v)}${valueSuffix}`} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export default DivergingBarChart

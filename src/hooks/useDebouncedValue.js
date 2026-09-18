import { useEffect, useState } from 'react'

// Delays reflecting `value` until it stops changing for `delayMs` -- lets a
// controlled input update instantly while whatever consumes the debounced
// value (an API call, a query key) only reacts once typing pauses, instead
// of on every keystroke.
export function useDebouncedValue(value, delayMs = 350) {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}

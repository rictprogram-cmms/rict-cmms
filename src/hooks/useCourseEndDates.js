import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

export function useCourseEndDates() {
  const [endDates, setEndDates] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  const fetchEndDates = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('course_end_dates')
      .select('record_id,status,created_by,created_at,updated_at,courses,reason')
      .order('created_at', { ascending: false })
    if (err) setError(err.message)
    else setEndDates(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchEndDates() }, [fetchEndDates])

  return { endDates, loading, error, refresh: fetchEndDates }
}

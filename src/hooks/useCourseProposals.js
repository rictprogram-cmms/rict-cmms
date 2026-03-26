import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

export function useCourseProposals() {
  const [proposals, setProposals] = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)

  const fetchProposals = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('course_proposals')
      .select('*')
      .order('created_at', { ascending: false })
    if (err) setError(err.message)
    else setProposals(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchProposals() }, [fetchProposals])

  return { proposals, loading, error, refresh: fetchProposals }
}

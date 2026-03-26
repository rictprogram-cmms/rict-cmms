import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

export function useProgramRevisions() {
  const [revisions, setRevisions] = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)

  const fetchRevisions = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [progResult, courseResult] = await Promise.all([
      supabase.from('program_revisions').select('revision_id,course_id,current_program_name,status,created_at,updated_at').order('created_at', { ascending: false }),
      supabase.from('course_outline_revisions').select('revision_id,current_course_num,current_course_title,status,created_at,updated_at').order('created_at', { ascending: false }),
    ])
    if (progResult.error || courseResult.error) {
      setError((progResult.error || courseResult.error).message)
      setLoading(false)
      return
    }
    // Normalize course outline rows to share shape with program revision rows
    const progRows = (progResult.data || []).map(r => ({
      ...r,
      _type: 'program',
    }))
    const courseRows = (courseResult.data || []).map(r => ({
      ...r,
      // Map to common display fields used by the tile
      course_id:            r.current_course_num,
      current_program_name: r.current_course_title,
      _type: 'course',
    }))
    // Merge and sort by updated_at desc
    const merged = [...progRows, ...courseRows].sort((a, b) =>
      new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at)
    )
    setRevisions(merged)
    setLoading(false)
  }, [])

  useEffect(() => { fetchRevisions() }, [fetchRevisions])

  return { revisions, loading, error, refresh: fetchRevisions }
}

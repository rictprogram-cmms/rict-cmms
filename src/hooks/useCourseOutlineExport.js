/**
 * useCourseOutlineExport.js  →  src/hooks/
 *
 * Returns three lists:
 *   courses  — active catalog courses merged with their latest approved revision
 *   drafts   — in-progress course outline revisions (draft status)
 *   proposals — new course proposals not yet approved (draft or submitted)
 */
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { normalizeCatalogRow, normalizeRevisionRow } from '@/pages/courseOutlineDocx'

// ─── Normalize a course_proposals row → outline `d` shape ────────────────────
export function normalizeProposalRow(p) {
  const courseId = [p.course_subject, p.course_number].filter(Boolean).join('')
  return {
    outline_course_num:       courseId || '',
    outline_title:            p.course_title || '',
    outline_lec:              p.lecture_credits != null ? String(p.lecture_credits) : '',
    outline_lab:              p.lab_credits     != null ? String(p.lab_credits)     : '',
    outline_soe:              p.soe_credits     != null ? String(p.soe_credits)     : '',
    outline_min_gpa:          'none',
    outline_prereqs:          p.prerequisites || '',
    outline_coreqs:           '',
    outline_cip_code:         p.cip_code || '',
    outline_major_restricted: false,
    outline_majors:           '',
    outline_suggested_skills: p.suggested_skills || '',
    outline_description:      p.course_description || '',
    outline_slos:             Array.isArray(p.course_outcomes) ? p.course_outcomes : [],
    outline_topics:           Array.isArray(p.course_topics)   ? p.course_topics   : [],
    outline_materials:        p.suggested_materials ? [p.suggested_materials] : [],
    outline_grading:          p.grading_method || 'letter',
    outline_prepared_by:      p.faculty_proposing || '',
    date_submitting:          p.created_at ? p.created_at.substring(0, 10) : '',
  }
}

export function useCourseOutlineExport() {
  const [courses,   setCourses]   = useState([])
  const [drafts,    setDrafts]    = useState([])
  const [proposals, setProposals] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    const [catResult, revResult, draftResult, propResult] = await Promise.all([

      // 1. Active catalog courses
      supabase
        .from('syllabus_courses')
        .select(
          'course_id,course_name,credits_lecture,credits_lab,credits_soe,' +
          'course_description,student_outcomes,prerequisites,cip_code,' +
          'suggested_skills,course_topics,suggested_materials,grading_method'
        )
        .eq('status', 'active')
        .order('course_id'),

      // 2. Approved revisions
      supabase
        .from('course_outline_revisions')
        .select(
          'revision_id,current_course_num,outline_course_num,outline_title,' +
          'outline_lec,outline_lab,outline_soe,outline_min_gpa,outline_prereqs,' +
          'outline_coreqs,outline_cip_code,outline_major_restricted,outline_majors,' +
          'outline_suggested_skills,outline_description,outline_slos,outline_topics,' +
          'outline_materials,outline_grading,outline_prepared_by,date_submitting,' +
          'program,status,approved_at,created_at,updated_at'
        )
        .eq('status', 'approved')
        .order('approved_at', { ascending: false }),

      // 3. Draft revisions (in-progress course outline revisions)
      supabase
        .from('course_outline_revisions')
        .select(
          'revision_id,current_course_num,current_course_title,outline_course_num,' +
          'outline_title,outline_lec,outline_lab,outline_soe,outline_min_gpa,' +
          'outline_prereqs,outline_coreqs,outline_cip_code,outline_major_restricted,' +
          'outline_majors,outline_suggested_skills,outline_description,outline_slos,' +
          'outline_topics,outline_materials,outline_grading,outline_prepared_by,' +
          'date_submitting,program,status,created_at,updated_at'
        )
        .eq('status', 'draft')
        .order('updated_at', { ascending: false }),

      // 4. New course proposals not yet approved
      supabase
        .from('course_proposals')
        .select('*')
        .in('status', ['draft', 'submitted'])
        .order('updated_at', { ascending: false }),
    ])

    if (catResult.error) { setError(catResult.error.message); setLoading(false); return }

    const catalogRows = catResult.data || []

    // ── Index approved revisions by course number ─────────────────────────────
    const revisionMap = {}
    for (const rev of (revResult.data || [])) {
      const key = (rev.outline_course_num || rev.current_course_num || '').toUpperCase()
      if (key && !revisionMap[key]) revisionMap[key] = rev
    }

    // ── Build catalog list ────────────────────────────────────────────────────
    const merged = catalogRows.map(cat => {
      const rev = revisionMap[cat.course_id?.toUpperCase()] || null
      const lec = parseFloat(cat.credits_lecture) || 0
      const lab = parseFloat(cat.credits_lab)     || 0
      const soe = parseFloat(cat.credits_soe)     || 0
      const tot = lec + lab + soe
      const programs = rev?.program
        ? (Array.isArray(rev.program) ? rev.program : [rev.program])
        : []
      return {
        _type:               'catalog',
        course_id:           cat.course_id,
        course_name:         cat.course_name || '',
        creditsStr:          tot > 0 ? `${tot} (${lec}+${lab}+${soe})` : '—',
        programs,
        hasApprovedRevision: !!rev,
        lastRevised:         rev?.approved_at ? rev.approved_at.substring(0, 10) : null,
        outlineData:         rev ? normalizeRevisionRow(rev) : normalizeCatalogRow(cat),
      }
    })

    // ── Build drafts list ─────────────────────────────────────────────────────
    const draftList = (draftResult.data || []).map(rev => {
      const lec = parseFloat(rev.outline_lec) || 0
      const lab = parseFloat(rev.outline_lab) || 0
      const soe = parseFloat(rev.outline_soe) || 0
      const tot = lec + lab + soe
      const programs = rev.program
        ? (Array.isArray(rev.program) ? rev.program : [rev.program])
        : []
      return {
        _type:       'draft-revision',
        _id:         rev.revision_id,
        course_id:   rev.outline_course_num || rev.current_course_num || '',
        course_name: rev.outline_title || rev.current_course_title || '',
        creditsStr:  tot > 0 ? `${tot} (${lec}+${lab}+${soe})` : '—',
        programs,
        draftStatus: 'draft',
        lastUpdated: rev.updated_at ? rev.updated_at.substring(0, 10) : null,
        outlineData: normalizeRevisionRow(rev),
      }
    })

    // ── Build proposals list ──────────────────────────────────────────────────
    const proposalList = (propResult.data || []).map(p => {
      const courseId = [p.course_subject, p.course_number].filter(Boolean).join('')
      const lec = parseFloat(p.lecture_credits) || 0
      const lab = parseFloat(p.lab_credits)     || 0
      const soe = parseFloat(p.soe_credits)     || 0
      const tot = lec + lab + soe
      const programs = p.program
        ? (Array.isArray(p.program) ? p.program : [p.program])
        : []
      return {
        _type:       'proposal',
        _id:         p.proposal_id,
        course_id:   courseId || '(TBD)',
        course_name: p.course_title || '',
        creditsStr:  tot > 0 ? `${tot} (${lec}+${lab}+${soe})` : '—',
        programs,
        draftStatus: p.status, // 'draft' or 'submitted'
        lastUpdated: p.updated_at ? p.updated_at.substring(0, 10) : null,
        outlineData: normalizeProposalRow(p),
      }
    })

    setCourses(merged)
    setDrafts(draftList)
    setProposals(proposalList)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  return { courses, drafts, proposals, loading, error, refresh: load }
}

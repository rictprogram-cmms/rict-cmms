/**
 * RICT CMMS — Class Schedule model (pure functions, no React, no Supabase)
 *
 * Ported from the RICT Term Scheduler artifact so the CMMS page behaves the
 * same way. Everything here works on a plain "doc":
 *
 *   doc = {
 *     scheduleId, semester, startHour, endHour,
 *     courses: [{ id, classId, adhoc, code, title, instructor, hours,
 *                 room, span, color, group, note }],
 *     assign:  { [id]: { A: [[..],[..],[..],[..],[..]], B: [[..]...] } }
 *   }
 *
 * A "slot" is an absolute half-hour of the day, 0..47 (16 = 8:00 AM).
 * A/B are the first / second 8 weeks. A 16-week class ("both") keeps A and
 * B identical; painting writes to every term the class runs in.
 *
 * File: src/lib/scheduleModel.js
 */

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
export const HUES = [
  { k: 'blue',   h: '#3D7CC9' }, { k: 'teal',   h: '#2E9C93' }, { k: 'violet', h: '#8A6FC4' },
  { k: 'slate',  h: '#64788C' }, { k: 'olive',  h: '#87933C' }, { k: 'green',  h: '#4E9A55' },
  { k: 'rose',   h: '#C96380' }, { k: 'amber',  h: '#C8871F' }, { k: 'orange', h: '#D2713F' },
  { k: 'plum',   h: '#A35C9E' },
]
export const hueOf = (k) => (HUES.find(x => x.k === k) || HUES[0]).h
export const SPANS = { first: '1st 8 wk', second: '2nd 8 wk', both: '16 wk' }
export const SPAN_LONG = { first: 'First 8 weeks', second: 'Second 8 weeks', both: 'All 16 weeks (both halves)' }
export const halfName = (t) => (t === 'A' ? '1st 8 wk' : '2nd 8 wk')
export const uid = () => Math.random().toString(36).slice(2, 9)
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
export const SLOT_PX = 22   // grid row height per half-hour, px

// ── time ────────────────────────────────────────────────────────────────────
export function fmt(slot) {
  const h = Math.floor(slot / 2), m = slot % 2 ? '30' : '00'
  const ap = h >= 12 ? 'pm' : 'am', hh = h % 12 === 0 ? 12 : h % 12
  return hh + ':' + m + ap
}
export const fmtRange = (a, b) => fmt(a) + '–' + fmt(b + 1)
export const hrs = (n) => (Math.round(n * 2) / 2).toString()

/** "8:00–10:00am, 1:00–3:00pm" for a set of slots. */
export function runsText(slots) {
  const s = [...slots].sort((a, b) => a - b), out = []
  let i = 0
  while (i < s.length) {
    let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
    out.push(fmtRange(s[i], s[j]))
    i = j + 1
  }
  return out.join(', ')
}

// ── assignment shape ────────────────────────────────────────────────────────
export const emptyWeek = () => [[], [], [], [], []]
export function fixWeek(x) {
  const o = Array.isArray(x) ? x : emptyWeek()
  return DAYS.map((_, i) => [...new Set((o[i] || []).map(Number).filter(n => n >= 0 && n < 48))].sort((p, q) => p - q))
}
export function ensure(doc, id) {
  const a = doc.assign[id] || {}
  doc.assign[id] = { A: fixWeek(a.A), B: fixWeek(a.B) }
  return doc.assign[id]
}
export function normalize(doc) {
  doc.startHour = clamp(+doc.startHour || 8, 0, 22)
  doc.endHour = clamp(+doc.endHour || 18, doc.startHour + 1, 24)
  doc.courses = (doc.courses || []).map(c => ({
    id: c.id || uid(), classId: c.classId || null, adhoc: !!c.adhoc,
    code: c.code || '', title: c.title || '', instructor: c.instructor || '', instructorEmail: c.instructorEmail || '',
    room: c.room || '', hours: +c.hours || 0, span: SPANS[c.span] ? c.span : 'first',
    color: c.color || 'blue', group: c.group || '', note: c.note || '',
    status: c.status || 'Active', delivery: c.delivery || '',   // '' for ad-hoc classes
  }))
  cleanupGroups(doc)
  doc.assign = doc.assign || {}
  for (const c of doc.courses) ensure(doc, c.id)
  // Drop assignments for courses that no longer exist.
  for (const id of Object.keys(doc.assign)) if (!doc.courses.some(c => c.id === id)) delete doc.assign[id]
  return doc
}
export const clone = (o) => JSON.parse(JSON.stringify(o))

// ── combined groups ─────────────────────────────────────────────────────────
export const byId = (doc, id) => doc.courses.find(c => c.id === id)
export const mates = (doc, c) => (c && c.group) ? doc.courses.filter(x => x.group === c.group && x.id !== c.id) : []
export function cleanupGroups(doc) {
  const n = {}
  for (const c of doc.courses) if (c.group) n[c.group] = (n[c.group] || 0) + 1
  for (const c of doc.courses) if (c.group && n[c.group] < 2) c.group = ''
}
export function paintTargets(doc, cid, soloMode) {
  const c = byId(doc, cid); if (!c) return []
  if (!c.group || soloMode) return [cid]
  return [cid, ...mates(doc, c).map(m => m.id)]
}
/** Put cid and everyone picked into one group (or break it up). */
export function setCombined(doc, cid, picked) {
  const c = byId(doc, cid); if (!c) return
  c.group = ''
  if (picked.length) {
    const gid = 'g' + uid()
    c.group = gid
    for (const id of picked) { const m = byId(doc, id); if (m) m.group = gid }
  }
  cleanupGroups(doc)
}
/** Hours of this class that every partner is also meeting. */
export function sharedHours(doc, c) {
  const ms = mates(doc, c); if (!ms.length) return null
  const t = primaryTerm(c)
  let n = 0
  for (let d = 0; d < 5; d++)
    for (const s of ensure(doc, c.id)[t][d])
      if (ms.every(m => termsOf(m).includes(t) && ensure(doc, m.id)[t][d].includes(s))) n++
  return n * 0.5
}

// ── model queries ───────────────────────────────────────────────────────────
export const termsOf = (c) => (c.span === 'both' ? ['A', 'B'] : c.span === 'second' ? ['B'] : ['A'])
export const primaryTerm = (c) => (c.span === 'second' ? 'B' : 'A')

export function segments(doc, term, day) {
  const out = []
  for (const c of doc.courses) {
    if (!termsOf(c).includes(term)) continue
    const slots = ensure(doc, c.id)[term][day]
    let i = 0
    while (i < slots.length) {
      let j = i; while (j + 1 < slots.length && slots[j + 1] === slots[j] + 1) j++
      out.push({ cid: c.id, start: slots[i], end: slots[j] })
      i = j + 1
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end)
}
export function segsAt(doc, term, day, slot) {
  return segments(doc, term, day).filter(s => slot >= s.start && slot <= s.end)
}
export function segAt(doc, term, day, slot, prefer) {
  const all = segsAt(doc, term, day, slot)
  return (prefer && all.find(s => s.cid === prefer)) || all[0] || null
}
export function scheduledHours(doc, c) {
  const t = primaryTerm(c), a = ensure(doc, c.id)[t]
  return a.reduce((n, d) => n + d.length, 0) * 0.5
}
export function placedIn(doc, t) {
  return doc.courses.filter(c => termsOf(c).includes(t) && DAYS.some((_, d) => ensure(doc, c.id)[t][d].length)).length
}

export function meterState(c, sch) {
  const need = c.hours || 0
  const pct = need ? Math.min(100, sch / need * 100) : (sch ? 100 : 0)
  const cls = !need ? '' : sch > need ? 'over' : sch === need ? 'done' : 'short'
  const left = need - sch
  const note = !need ? '' : left > 0 ? `${hrs(left)} left` : left < 0 ? `${hrs(-left)} over` : 'complete'
  return { cls, pct, need, sch, note }
}

/** Overlapping blocks in one day column share the width: lane index / count. */
export function layoutLanes(segs) {
  const map = new Map()
  let i = 0
  const sorted = [...segs].sort((a, b) => a.start - b.start || a.end - b.end)
  while (i < sorted.length) {
    let j = i, far = sorted[i].end
    while (j + 1 < sorted.length && sorted[j + 1].start <= far) { j++; far = Math.max(far, sorted[j].end) }
    const group = sorted.slice(i, j + 1), ends = []
    for (const s of group) {
      let lane = ends.findIndex(e => e < s.start)
      if (lane === -1) { lane = ends.length; ends.push(-1) }
      ends[lane] = s.end
      map.set(s, { i: lane, of: 0 })
    }
    for (const s of group) map.get(s).of = ends.length
    i = j + 1
  }
  return map
}

// ── conflicts ───────────────────────────────────────────────────────────────
export function conflicts(doc) {
  const list = [], flagged = new Set()
  for (const term of ['A', 'B']) for (let d = 0; d < 5; d++) {
    const segs = segments(doc, term, d)
    const bySlot = new Map()
    for (const s of segs) for (let k = s.start; k <= s.end; k++) {
      if (!bySlot.has(k)) bySlot.set(k, [])
      bySlot.get(k).push(s.cid)
    }
    const runs = new Map()
    for (const [slot, cids] of bySlot) {
      for (let i = 0; i < cids.length; i++) for (let j = i + 1; j < cids.length; j++) {
        const A = byId(doc, cids[i]), B = byId(doc, cids[j]); if (!A || !B) continue
        const combined = A.group && A.group === B.group
        const pairs = []
        // One instructor in two places is a clash — unless the classes are
        // deliberately combined, which is exactly that arrangement. Linked
        // classes match by profile email; typed names match by text.
        const sameInstructor = (A.instructorEmail && B.instructorEmail)
          ? A.instructorEmail.trim().toLowerCase() === B.instructorEmail.trim().toLowerCase()
          : (A.instructor && B.instructor && A.instructor.trim().toLowerCase() === B.instructor.trim().toLowerCase())
        if (!combined && sameInstructor)
          pairs.push(['Instructor', A.instructor || A.instructorEmail])
        if (A.room && B.room && A.room.trim().toLowerCase() === B.room.trim().toLowerCase())
          pairs.push([combined ? 'Combined, same room' : 'Room', A.room])
        for (const [kind, who] of pairs) {
          const ids = [A.id, B.id].sort()
          const key = [term, d, kind, who, ids[0], ids[1]].join('|')
          if (!runs.has(key)) runs.set(key, { term, day: d, kind, who, a: byId(doc, ids[0]), b: byId(doc, ids[1]), slots: [] })
          runs.get(key).slots.push(slot)
          flagged.add(term + '|' + d + '|' + A.id + '|' + slot)
          flagged.add(term + '|' + d + '|' + B.id + '|' + slot)
        }
      }
    }
    for (const r of runs.values()) {
      const s = [...new Set(r.slots)].sort((x, y) => x - y)
      let i = 0
      while (i < s.length) {
        let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
        list.push({ ...r, start: s[i], end: s[j] })
        i = j + 1
      }
    }
  }
  list.sort((a, b) => a.term.localeCompare(b.term) || a.day - b.day || a.start - b.start)
  return { list, flagged }
}

/** Combined groups that don't line up yet — a to-do, not a clash. */
export function groupNotes(doc) {
  const out = [], seen = new Set()
  for (const c of doc.courses) {
    if (!c.group || seen.has(c.group)) continue
    seen.add(c.group)
    const ms = doc.courses.filter(x => x.group === c.group)
    if (ms.length < 2) continue
    const who = ms.map(m => m.code).join(' + ')
    const need = Math.min(...ms.map(m => m.hours || 0))
    const sh = sharedHours(doc, ms[0]) || 0
    if (need > 0 && sh < need)
      out.push({ who, text: `${hrs(sh)} of ${hrs(need)} hr scheduled together — ${hrs(need - sh)} hr still has to overlap.` })
    const rooms = ms.map(m => (m.room || '').trim().toLowerCase())
    if (rooms.some((r, i) => r && rooms.indexOf(r) !== i))
      out.push({ who, text: 'These share a room. Combined classes meet at the same time, so each needs its own.' })
  }
  return out
}

// ── edits ───────────────────────────────────────────────────────────────────
/**
 * One calculation drives the preview, the live meter and the commit, so what
 * you see while dragging is exactly what lands. A class never goes past its
 * required hours: slots fill in the direction you drag and stop at the limit,
 * which is also what hands a combined drag over to the longer class once the
 * shorter one is full.
 */
export function dayAfter(doc, c, day, ops) {
  const pt = primaryTerm(c)
  const week = ensure(doc, c.id)[pt]
  const set = new Set(week[day])
  const cap = c.hours > 0 ? Math.round(c.hours * 2) : Infinity
  let capped = false
  for (const op of ops) {
    if (op.erase) {
      const lo = Math.min(op.a, op.b), hi = Math.max(op.a, op.b)
      for (let s = lo; s <= hi; s++) set.delete(s)
      continue
    }
    let used = week.reduce((n, d, i) => n + (i === day ? set.size : d.length), 0)
    const step = op.b >= op.a ? 1 : -1
    for (let s = op.a; ; s += step) {
      if (!set.has(s)) {
        if (used >= cap) { capped = true; break }
        set.add(s); used++
      }
      if (s === op.b) break
    }
  }
  return { slots: [...set].sort((x, y) => x - y), capped }
}
export function dragOps(d) {
  if (d.mode === 'resize') {
    if (d.edge === 'top') {
      const ns = d.newStart == null ? d.start : d.newStart
      return [{ a: d.start, b: d.end, erase: true }, { a: d.end, b: ns, erase: false }]
    }
    const ne = d.newEnd == null ? d.end : d.newEnd
    return [{ a: d.start, b: d.end, erase: true }, { a: d.start, b: ne, erase: false }]
  }
  return [{ a: d.start, b: d.end, erase: !!d.erase }]
}
/** Mutates doc. Returns { slots, capped } or null (with a reason) when the class can't sit in this half. */
export function applyPaint(doc, cid, term, day, ops) {
  const c = byId(doc, cid); if (!c) return null
  const ts = termsOf(c)
  const adds = ops.some(o => !o.erase)
  if (adds && !ts.includes(term)) {
    return { blocked: `${c.code} runs in the ${c.span === 'first' ? 'first' : 'second'} 8 weeks. Change its term to place it here.` }
  }
  const res = dayAfter(doc, c, day, ops)
  for (const t of ts) doc.assign[cid][t][day] = res.slots.slice()
  return res
}
/** Mutates doc. Returns { full: [codes], rest: [codes], blocked: string|null }. */
export function paintAll(doc, targets, term, day, ops, primary) {
  const full = []
  let blocked = null
  for (const id of targets) {
    const r = applyPaint(doc, id, term, day, ops)
    if (r && r.blocked && id === primary) blocked = r.blocked
    if (r && r.capped) full.push(id)
  }
  const rest = targets.filter(id => !full.includes(id)).map(id => byId(doc, id)?.code).filter(Boolean)
  return { full: full.map(id => byId(doc, id)?.code).filter(Boolean), rest, blocked }
}

/** Live hours for a class if the drag in progress were released now. */
export function liveHours(doc, c, drag) {
  let n = 0
  for (let d = 0; d < 5; d++) {
    const inDrag = drag && drag.targets && drag.targets.includes(c.id) && drag.day === d && termsOf(c).includes(drag.term)
    n += inDrag ? dayAfter(doc, c, d, dragOps(drag)).slots.length : ensure(doc, c.id)[primaryTerm(c)][d].length
  }
  return n * 0.5
}

// ── change history text ─────────────────────────────────────────────────────
function shownVal(f, v) {
  if (f === 'span') return SPANS[v] || v
  if (f === 'hours') return hrs(+v || 0) + ' hr'
  if (v === '' || v == null) return '—'
  return String(v)
}
/** Plain-English lines describing how doc b differs from doc a. */
export function diffDocs(a, b) {
  const lines = []
  if (!a) return lines
  const was = new Map((a.courses || []).map(c => [c.id, c]))
  const now = new Map((b.courses || []).map(c => [c.id, c]))
  const label = c => (c.code || c.title || 'class').trim()
  for (const c of b.courses) if (!was.has(c.id))
    lines.push(`Added ${label(c)}${c.title && c.code ? ' — ' + c.title : ''}${c.adhoc ? ' (unlisted class)' : ''}`)
  for (const c of a.courses) if (!now.has(c.id))
    lines.push(`Removed ${label(c)}${c.title && c.code ? ' — ' + c.title : ''}`)

  const FIELDS = [['code', 'number'], ['title', 'name'], ['instructor', 'instructor'], ['room', 'room'],
                  ['hours', 'hours/week'], ['span', 'runs'], ['note', 'notes'], ['color', 'color']]
  for (const c of b.courses) {
    const o = was.get(c.id); if (!o) continue
    for (const [f, nm] of FIELDS)
      if (String(o[f] == null ? '' : o[f]) !== String(c[f] == null ? '' : c[f]))
        lines.push(`${label(c)} ${nm}: ${shownVal(f, o[f])} → ${shownVal(f, c[f])}`)
    if ((o.group || '') !== (c.group || '')) {
      const ms = (b.courses || []).filter(x => x.group && x.group === c.group && x.id !== c.id)
      lines.push(c.group ? `${label(c)} combined with ${ms.map(label).join(' + ') || 'another class'}`
                         : `${label(c)} no longer combined`)
    }
    const t = c.span === 'second' ? 'B' : 'A'
    const oa = (a.assign[c.id] || {})[t] || emptyWeek()
    const na = (b.assign[c.id] || {})[t] || emptyWeek()
    for (let d = 0; d < 5; d++) {
      const A = new Set(oa[d] || []), B = new Set(na[d] || [])
      const add = [...B].filter(s => !A.has(s)), rem = [...A].filter(s => !B.has(s))
      if (add.length) lines.push(`${label(c)} ${DAYS[d]} +${runsText(add)} (${halfName(t)})`)
      if (rem.length) lines.push(`${label(c)} ${DAYS[d]} −${runsText(rem)} (${halfName(t)})`)
    }
  }
  if ((a.startHour !== b.startHour) || (a.endHour !== b.endHour))
    lines.push(`Grid hours: ${fmt((a.startHour || 8) * 2)}–${fmt((a.endHour || 18) * 2)} → ${fmt((b.startHour || 8) * 2)}–${fmt((b.endHour || 18) * 2)}`)
  return lines
}

// ── filter ──────────────────────────────────────────────────────────────────
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
function hay(c) {
  return [c.code, c.title, c.instructor, c.room, SPANS[c.span], c.note, c.room ? 'room ' + c.room : '']
    .filter(Boolean).join(' ').toLowerCase()
}
export function matches(c, query) {
  const t = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!t.length) return true
  const h = hay(c), hs = squash(hay(c))
  return t.every(tok => h.includes(tok) || hs.includes(squash(tok)))
}

// ── Settings ↔ schedule helpers ─────────────────────────────────────────────
/** "Spring 2027" → { term: 'Spring', year: 2027, order: 2027.1, key: 'spring-2027' } */
export function parseSemester(name) {
  const s = String(name || '').trim()
  const m = s.match(/(spring|summer|fall|autumn|winter)\D*(\d{4})|(\d{4})\D*(spring|summer|fall|autumn|winter)/i)
  const termOrder = { spring: 1, summer: 2, fall: 3, autumn: 3, winter: 4 }
  let term = '', year = 0
  if (m) {
    term = (m[1] || m[4] || '').toLowerCase()
    year = parseInt(m[2] || m[3], 10) || 0
  }
  const termLabel = term ? term.charAt(0).toUpperCase() + term.slice(1) : ''
  const order = year + (termOrder[term] || 0) / 10
  const key = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'semester'
  return { name: s, term: termLabel, year, order, key }
}
/** Distinct, non-empty semester names from classes rows, newest first. */
export function semesterList(classes) {
  const seen = new Map()
  for (const c of classes || []) {
    const n = String(c.semester || '').trim()
    if (n && !seen.has(n)) seen.set(n, parseSemester(n))
  }
  return [...seen.values()].sort((a, b) => b.order - a.order || b.name.localeCompare(a.name))
}
/**
 * Which half of the term a class runs in, from its dates. Uses the earliest
 * start / latest end among the semester's classes as the term bounds:
 *   ≤ ~10 weeks long → 'first' if it starts in the opening 3 weeks, else 'second'
 *   longer            → 'both'
 * Falls back to 'both' when dates are missing.
 */
export function deriveSpan(cls, bounds) {
  const s = cls?.start_date ? new Date(String(cls.start_date).substring(0, 10) + 'T00:00:00') : null
  const e = cls?.end_date ? new Date(String(cls.end_date).substring(0, 10) + 'T00:00:00') : null
  if (!s || !e || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 'both'
  const weeks = (e - s) / (7 * 86400000)
  if (weeks > 10.5) return 'both'
  const termStart = bounds?.start && !Number.isNaN(bounds.start.getTime()) ? bounds.start : s
  const offsetWeeks = (s - termStart) / (7 * 86400000)
  return offsetWeeks <= 3 ? 'first' : 'second'
}
export function semesterBounds(classes) {
  let start = null, end = null
  for (const c of classes || []) {
    const s = c.start_date ? new Date(String(c.start_date).substring(0, 10) + 'T00:00:00') : null
    const e = c.end_date ? new Date(String(c.end_date).substring(0, 10) + 'T00:00:00') : null
    if (s && !Number.isNaN(s.getTime()) && (!start || s < start)) start = s
    if (e && !Number.isNaN(e.getTime()) && (!end || e > end)) end = e
  }
  return { start, end }
}

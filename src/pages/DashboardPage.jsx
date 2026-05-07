/**
 * RICT CMMS - Dashboard Page
 * 
 * Welcome section with fun fact & quick actions.
 * 
 * Student / Work Study: Compact 1×4 accountability metrics
 *   - Work Orders (open, assigned to me)
 *   - Weekly Labs (completed this week out of enrolled classes)
 *   - Attendance Score (on-time %)
 *   - Volunteer Hours (approved / required)
 * 
 * Instructors: 1×3 summary tiles + Day View list + Active Temp Access card
 *   - Late Work Orders (click for detail modal)
 *   - Expected Today
 *   - Punched In Now
 *   - Day View: who is here / expected, with date nav arrows
 *   - "Active Temp Access" card with History + Revoke
 * 
 * All pending approvals are handled by NotificationBell, NOT dashboard tiles.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useVolunteerData } from '@/hooks/useVolunteerHours';
import { useStudentLabReport } from '@/hooks/useWeeklyLabs';
import { useWOCRatio, computeStudentScoresForWindows } from '@/hooks/useWOCRatio';
import { generateUserReport } from '@/hooks/useTimeCards';
import { useDialogA11y } from '@/hooks/useDialogA11y';
import {
  useUserPendingAcknowledgments,
  formatCountdown,
} from '@/hooks/useAssetCheckouts';
import PendingAcknowledgmentModal from '@/components/PendingAcknowledgmentModal';
import '@/styles/dashboard.css';

// ─── Fun Facts ──────────────────────────────────────────────────────────
const funFacts = [
  'A single autonomous vehicle generates approximately 4 terabytes of data per day from its cameras, LIDAR, and sensors.',
  'The first industrial robot, Unimate, was installed at a GM plant in 1961 to perform die casting and spot welding.',
  'MQTT, the protocol used by most IoT devices, was invented in 1999 to monitor oil pipelines via satellite.',
  'A typical modern car contains over 100 million lines of code — more than the F-35 fighter jet.',
  'Predictive maintenance can reduce machine downtime by up to 50% and increase machine life by 20-40%.',
  'The term "robot" comes from the Czech word "robota," meaning forced labor, first used in a 1920 play.',
  'A single PLC (Programmable Logic Controller) can replace hundreds of individual relays in industrial control systems.',
  'The average manufacturing facility experiences 800+ hours of downtime per year, costing an average of $22,000/hour.',
  'Ethernet/IP, one of the most common industrial protocols, was adapted from the same Ethernet used in office networks.',
  'Digital twins — virtual replicas of physical systems — can reduce product development time by up to 50%.',
  'The global industrial automation market is expected to exceed $395 billion by 2029.',
  'A modern CNC machine can achieve positioning accuracy of 0.001mm — about 1/70th the width of a human hair.',
  'The International Space Station uses over 350,000 sensors, many similar to those used in industrial automation.',
  'Industry 4.0 combines IoT, AI, and cloud computing to create smart factories that can self-optimize.',
  'Collaborative robots (cobots) are designed to work alongside humans and account for the fastest-growing segment of industrial robotics.',
  'Data lakes in manufacturing can store petabytes of unstructured data from machines, sensors, and quality systems for future AI analysis.',
  'The concept of digital thread connects every phase of a product\'s lifecycle from design through manufacturing, operation, and disposal.',
  'SPI (Serial Peripheral Interface), commonly used in embedded systems and sensors, was developed by Motorola in the 1980s.',
  'A modern semiconductor fab costs over 20 billion dollars to build and uses more electricity than some small cities.',
  'Digital shadow differs from a digital twin — a shadow only mirrors data one-way from physical to digital, while a twin is bidirectional.',
  'The average industrial IoT sensor costs less than 5 dollars today, compared to over 100 dollars just fifteen years ago.',
  'Machine vision systems use algorithms that can detect surface defects as small as 10 micrometers — one-tenth the width of a human hair.',
  'The convergence of IT (Information Technology) and OT (Operational Technology) is the defining challenge of modern industrial automation.'
];

// ─── Helpers ────────────────────────────────────────────────────────────
function formatHoursMin(decimalHours) {
  const totalMin = Math.round((decimalHours || 0) * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1] || '0');
}

function extractDateFromTimestamp(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function extractTimeMinutes(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function getCurrentWeekNumber(startDate) {
  if (!startDate) return 0;
  const parseSafe = (d) => {
    const s = (typeof d === 'string' ? d : d.toISOString()).substring(0, 10).split('-');
    return new Date(+s[0], +s[1] - 1, +s[2]);
  };
  const start = parseSafe(startDate);
  const now = new Date();
  const startDay = start.getDay();
  const startMonday = new Date(start);
  if (startDay !== 1) startMonday.setDate(startMonday.getDate() - ((startDay + 6) % 7));
  const nowDay = now.getDay();
  const nowMonday = new Date(now);
  if (nowDay !== 1) nowMonday.setDate(nowMonday.getDate() - ((nowDay + 6) % 7));
  nowMonday.setHours(0, 0, 0, 0);
  startMonday.setHours(0, 0, 0, 0);
  const diffMs = nowMonday.getTime() - startMonday.getTime();
  const diffWeeks = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
  return Math.max(0, diffWeeks + 1);
}

function toLocalDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatTime12(timeStr) {
  if (!timeStr) return '—';
  const parts = timeStr.split(':');
  let h = parseInt(parts[0]);
  const m = parts[1] || '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m} ${ampm}`;
}

function formatTimestamp12(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  let h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m} ${ampm}`;
}

function formatDateLabel(date) {
  const today = new Date();
  const todayStr = toLocalDateStr(today);
  const dateStr = toLocalDateStr(date);
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
  const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (dateStr === todayStr) return `Today — ${dayName}, ${monthDay}`;
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (dateStr === toLocalDateStr(yesterday)) return `Yesterday — ${dayName}, ${monthDay}`;
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  if (dateStr === toLocalDateStr(tomorrow)) return `Tomorrow — ${dayName}, ${monthDay}`;
  return `${dayName}, ${monthDay}`;
}




// ═════════════════════════════════════════════════════════════════════════
// ─── Compact Accountability Metrics (Students / Work Study) ─────────────
// ═════════════════════════════════════════════════════════════════════════

function AccountabilityMetrics({ navigate }) {
  const { profile } = useAuth();
  const { stats: volStats, loading: volLoading } = useVolunteerData();
  const { report: labReport, loading: labLoading } = useStudentLabReport();
  const { myScore: wocScore, loading: wocLoading } = useWOCRatio();

  const [woCount, setWoCount] = useState(0);
  const [woLoading, setWoLoading] = useState(true);
  const [attendanceScore, setAttendanceScore] = useState(null);
  const [attLoading, setAttLoading] = useState(true);


  useEffect(() => {
    if (!profile?.email) return;
    let cancelled = false;
    const fetchWOs = async () => {
      try {
        const { count, error } = await supabase
          .from('work_orders')
          .select('wo_id', { count: 'exact', head: true })
          .eq('assigned_email', profile.email)
          .neq('status', 'Closed');
        if (!cancelled && !error) setWoCount(count || 0);
      } catch { /* ignore */ }
      if (!cancelled) setWoLoading(false);
    };
    fetchWOs();
    // Unique channel name per mount — prevents collision when dashboard is open in two tabs
    const channel = supabase.channel(`dash-wo-count-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders' }, fetchWOs)
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [profile?.email]);

  useEffect(() => {
    if (!profile?.email || !profile?.user_id) { setAttLoading(false); return; }
    let cancelled = false;
    const fetchAttendance = async () => {
      try {
        const userClasses = (profile.classes || '').split(',').map(c => c.trim()).filter(Boolean);
        if (userClasses.length === 0) { if (!cancelled) { setAttendanceScore(100); setAttLoading(false); } return; }
        // Use local date — toISOString() returns UTC and would shift to tomorrow after ~6 PM CST,
        // causing classes that haven't started yet to be incorrectly included in the filter.
        const todayStr = toLocalDateStr(new Date());
        const { data: classesData } = await supabase.from('classes').select('start_date, end_date').in('course_id', userClasses).eq('status', 'Active').or(`start_date.is.null,start_date.lte.${todayStr}`);
        if (!classesData || classesData.length === 0) { if (!cancelled) { setAttendanceScore(100); setAttLoading(false); } return; }
        let startDate = null, endDate = null;
        classesData.forEach(c => {
          const sd = c.start_date ? c.start_date.split('T')[0] : null;
          const ed = c.end_date ? c.end_date.split('T')[0] : null;
          if (sd && (!startDate || sd < startDate)) startDate = sd;
          if (ed && (!endDate || ed > endDate)) endDate = ed;
        });
        if (!startDate) startDate = `${new Date().getFullYear()}-01-01`;
        // Same TZ fix as todayStr above — local date, not UTC
        if (!endDate) endDate = toLocalDateStr(new Date());
        let gracePeriod = 10;
        try {
          const { data: gs } = await supabase.from('settings').select('setting_value').eq('setting_key', 'grace_period_minutes').maybeSingle();
          if (gs?.setting_value) gracePeriod = parseInt(gs.setting_value) || 10;
        } catch {}
        // IMPORTANT: time_clock stores USR#### in user_id — must use profile.user_id, not profile.id (UUID)
        const { data: tcData } = await supabase.from('time_clock').select('record_id, punch_in, punch_out, status, entry_type').eq('user_id', profile.user_id).gte('punch_in', startDate + 'T00:00:00').lte('punch_in', endDate + 'T23:59:59');
        const records = tcData || [];
        const { data: suData } = await supabase.from('lab_signup').select('date, start_time, end_time').eq('user_email', profile.email).eq('status', 'Confirmed').gte('date', startDate).lte('date', endDate + 'T23:59:59');
        const signupsByDate = {};
        (suData || []).forEach(s => {
          const d = (s.date || '').split('T')[0]; if (!d) return;
          if (!signupsByDate[d]) signupsByDate[d] = { startMin: Infinity, endMin: 0 };
          const sMin = timeToMinutes(s.start_time); const eMin = timeToMinutes(s.end_time);
          if (sMin !== null && sMin < signupsByDate[d].startMin) signupsByDate[d].startMin = sMin;
          if (eMin !== null && eMin > signupsByDate[d].endMin) signupsByDate[d].endMin = eMin;
        });
        let onTimeCount = 0;
        records.forEach(r => {
          if (r.status === 'No Show' || r.entry_type === 'Volunteer') return;
          if (r.entry_type === 'All Done') { onTimeCount++; return; }
          const entryDate = extractDateFromTimestamp(r.punch_in);
          const punchInMin = extractTimeMinutes(r.punch_in);
          const daySignup = entryDate ? signupsByDate[entryDate] : null;
          if (!daySignup || daySignup.startMin === Infinity) return;
          if (punchInMin !== null && (punchInMin - daySignup.startMin) <= gracePeriod) onTimeCount++;
        });
        const nonVol = records.filter(r => r.entry_type !== 'Volunteer');
        const denom = nonVol.length - nonVol.filter(r => r.status === 'No Show').length;
        const score = denom > 0 ? Math.round((onTimeCount / denom) * 100) : 100;
        if (!cancelled) setAttendanceScore(score);
      } catch (err) {
        console.error('Dashboard attendance error:', err);
        if (!cancelled) setAttendanceScore(100);
      }
      if (!cancelled) setAttLoading(false);
    };
    fetchAttendance();
    // Unique channel name per mount — prevents collision when dashboard is open in two tabs
    const channel = supabase.channel(`dash-attendance-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_clock' }, fetchAttendance)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_signup' }, fetchAttendance)
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [profile?.email, profile?.user_id, profile?.classes]);

  const labsThisWeek = useMemo(() => {
    if (!labReport?.classes?.length) return { done: 0, total: 0 };
    let done = 0, total = 0;
    labReport.classes.forEach(cls => {
      const weekNum = getCurrentWeekNumber(cls.classWeeks?.[0]?.startDate || null);
      const totalWeeks = cls.totalWeeks || 0;
      if (weekNum > 0 && weekNum <= totalWeeks) {
        total++;
        const wd = cls.weeks?.[weekNum];
        if (wd?.labComplete) done++;
      }
    });
    return { done, total };
  }, [labReport]);

  const isLoading = volLoading || labLoading || woLoading || attLoading || wocLoading;
  if (isLoading) return null;

  const scoreColor = (v) => v >= 90 ? '#40c057' : v >= 70 ? '#fab005' : '#fa5252';
  const scoreBg = (v) => v >= 90 ? '#d3f9d8' : v >= 70 ? '#fff9db' : '#ffe3e3';
  const score = attendanceScore ?? 100;

  return (
    <div style={{ marginTop: 16 }}>
      <div className="dash-metrics-grid">
        <button type="button" className="dash-metric-tile" onClick={() => navigate('/work-orders')}
          aria-label={`Work Orders: ${woCount}, ${woCount === 0 ? 'none assigned' : 'assigned to me'}`}>
          <span className="material-icons dash-metric-icon" aria-hidden="true" style={{ color: '#228be6', background: '#e7f5ff' }}>assignment</span>
          <div className="dash-metric-value">{woCount}</div>
          <div className="dash-metric-label">Work Orders</div>
          <div className="dash-metric-sub">{woCount === 0 ? 'None assigned' : 'assigned to me'}</div>
        </button>
        <button type="button" className="dash-metric-tile" onClick={() => navigate('/weekly-labs-tracker')}
          aria-label={`Weekly Labs: ${labsThisWeek.total > 0 ? `${labsThisWeek.done} of ${labsThisWeek.total}` : 'none'} ${labsThisWeek.total === 0 ? 'this week' : labsThisWeek.done === labsThisWeek.total ? 'all complete' : 'complete this week'}`}>
          <span className="material-icons dash-metric-icon" aria-hidden="true" style={{ color: '#20c997', background: '#e6fcf5' }}>fact_check</span>
          <div className="dash-metric-value">{labsThisWeek.total > 0 ? `${labsThisWeek.done}/${labsThisWeek.total}` : '—'}</div>
          <div className="dash-metric-label">Weekly Labs</div>
          <div className="dash-metric-sub">{labsThisWeek.total === 0 ? 'No labs this week' : labsThisWeek.done === labsThisWeek.total ? 'All complete ✓' : 'complete this week'}</div>
        </button>
        <button type="button" className="dash-metric-tile" onClick={() => navigate('/time-cards')}
          aria-label={`Attendance: ${score} percent, ${score >= 90 ? 'on track' : score >= 70 ? 'needs improvement' : 'at risk'}`}>
          <span className="material-icons dash-metric-icon" aria-hidden="true" style={{ color: scoreColor(score), background: scoreBg(score) }}>shield</span>
          <div className="dash-metric-value" style={{ color: scoreColor(score) }}>{score}%</div>
          <div className="dash-metric-label">Attendance</div>
          <div className="dash-metric-sub">{score >= 90 ? 'On-time score' : score >= 70 ? 'Needs improvement' : 'At risk'}</div>
        </button>
        <button type="button" className="dash-metric-tile" onClick={() => navigate('/volunteer-hours')}
          aria-label={`Volunteer Hours: ${formatHoursMin(volStats.approvedHours)} of ${formatHoursMin(volStats.totalRequired)} required`}>
          <span className="material-icons dash-metric-icon" aria-hidden="true" style={{ color: '#9333ea', background: '#f3e8ff' }}>volunteer_activism</span>
          <div className="dash-metric-value">{formatHoursMin(volStats.approvedHours)}</div>
          <div className="dash-metric-label">Volunteer Hours</div>
          <div className="dash-metric-sub">of {formatHoursMin(volStats.totalRequired)} required</div>
        </button>
        {(() => {
          const woc = wocScore?.score ?? null;
          const rank = wocScore?.rank ?? null;
          const total = wocScore?.totalRanked ?? null;
          const wocColor = woc === null ? '#868e96' : woc >= 90 ? '#40c057' : woc >= 70 ? '#fab005' : '#fa5252';
          const wocBg   = woc === null ? '#f1f3f5' : woc >= 90 ? '#d3f9d8' : woc >= 70 ? '#fff9db' : '#ffe3e3';
          const wocLabel = woc === null
            ? 'WOC Score: not yet calculated'
            : `WOC Score: ${woc}, ${rank !== null && total !== null ? `rank ${rank} of ${total}` : 'out of 100'}`;
          return (
            <button type="button" className="dash-metric-tile" onClick={() => navigate('/woc-ratio')}
              aria-label={wocLabel}>
              <span className="material-icons dash-metric-icon" aria-hidden="true" style={{ color: wocColor, background: wocBg }}>gpp_good</span>
              <div className="dash-metric-value" style={{ color: wocColor }}>{woc !== null ? woc : '—'}</div>
              <div className="dash-metric-label">WOC Score</div>
              <div className="dash-metric-sub">
                {rank !== null && total !== null ? `Rank ${rank} of ${total}` : 'out of 100'}
              </div>
            </button>
          );
        })()}
      </div>

    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════════
// ─── Grade-Relevant Scores (per-class transparency for students) ────────
// ═════════════════════════════════════════════════════════════════════════
//
// Renders one card per enrolled active class showing:
//   - Attendance %  (per-class, class window, finals excluded)
//   - WOC Ratio    (per-class, same scoring as GB Items)
//   - Volunteer Hours (program-wide, semester window — matches Volunteer Hours page)
//
// Cards are HIDDEN until the class has actually started (today >= start_date).
// Cards FREEZE with a "Final" badge after the class effective end (finals
// week excluded if configured) — soft freeze via effectiveEnd cap, no DB
// snapshot needed.
//
// All numbers are computed using the SAME functions as the instructor's
// GB Items report, so the student and instructor see identical values.

function GradeRelevantScores() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!profile?.user_id || !profile?.email) { setLoading(false); return; }
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        // 1. Resolve enrolled active classes whose start_date has passed.
        //    The .or filter excludes future classes (start_date > today)
        //    so we only show classes the student is currently in.
        const userClasses = (profile.classes || '').split(',').map(c => c.trim()).filter(Boolean);
        if (userClasses.length === 0) {
          if (!cancelled) { setCards([]); setLoading(false); }
          return;
        }
        const todayStr = toLocalDateStr(new Date());
        const { data: classesData } = await supabase
          .from('classes')
          .select('*')
          .in('course_id', userClasses)
          .eq('status', 'Active')
          .or(`start_date.is.null,start_date.lte.${todayStr}`);

        const allActiveClasses = classesData || [];
        const startedClasses = allActiveClasses.filter(c => !c.start_date || c.start_date <= todayStr);

        if (startedClasses.length === 0) {
          if (!cancelled) { setCards([]); setLoading(false); }
          return;
        }

        // 2. Compute each class's grading window.
        //    maxEnd  = finals_start − 1 if configured, else end_date, else null (open-ended)
        //    effEnd  = min(today, maxEnd)         — what the report uses
        //    isFinal = today > maxEnd             — past the gradable window
        //              When isFinal, effEnd is locked at maxEnd so scores freeze.
        const classWindows = startedClasses.map(c => {
          const start = c.start_date;
          let maxEnd = c.end_date || null;
          if (c.finals_start) {
            const fs = new Date(c.finals_start + 'T00:00:00');
            fs.setDate(fs.getDate() - 1);
            maxEnd = toLocalDateStr(fs);
          }
          let effEnd = todayStr;
          if (maxEnd && maxEnd < todayStr) effEnd = maxEnd;
          const isFinal = !!(maxEnd && todayStr > maxEnd);
          return {
            classConfig: c,
            startDate: start,
            endDate: effEnd,
            isFinal,
          };
        });

        // 3. Resolve grace period (matches GB Items / TimeCardsPage convention)
        let gracePeriod = 10;
        try {
          const { data: gs } = await supabase
            .from('settings')
            .select('setting_value')
            .eq('setting_key', 'grace_period_minutes')
            .maybeSingle();
          if (gs?.setting_value) gracePeriod = parseInt(gs.setting_value) || 10;
        } catch { /* default */ }

        // 4. Per-class attendance — call generateUserReport once per class with
        //    its own window. Same call shape GB Items uses, so numbers match.
        const attendanceByCourseId = {};
        for (const w of classWindows) {
          if (!w.startDate || !w.endDate) continue;
          try {
            const r = await generateUserReport(profile, w.startDate, w.endDate, gracePeriod, allActiveClasses);
            const cr = (r.classReports || []).find(x => x.courseId === w.classConfig.course_id);
            if (cr) attendanceByCourseId[w.classConfig.course_id] = cr;
          } catch (e) {
            console.warn(`Grade card: attendance fetch failed for ${w.classConfig.course_id}:`, e);
          }
        }

        // 5. Per-class WOC scores — single batched fetch covers all windows.
        let wocByCourseId = {};
        try {
          const wocWindows = classWindows
            .filter(w => w.startDate && w.endDate)
            .map(w => ({ key: w.classConfig.course_id, startDate: w.startDate, endDate: w.endDate }));
          if (wocWindows.length > 0) {
            wocByCourseId = await computeStudentScoresForWindows(profile, wocWindows);
          }
        } catch (e) {
          console.warn('Grade card: WOC computation failed:', e);
        }

        // 6. Volunteer hours — program-wide semester window with approval_status filter.
        //    Mirrors useVolunteerHours.js semester resolution and the GB Items query
        //    so the same number appears on the dashboard, the Volunteer Hours page,
        //    and the GB Items report.
        let volSemStart = null, volSemEnd = null;
        try {
          const { data: settingsRows } = await supabase
            .from('settings')
            .select('setting_key, setting_value')
            .in('setting_key', ['volunteer_semester_start', 'volunteer_semester_end']);
          const sMap = {};
          (settingsRows || []).forEach(r => { sMap[r.setting_key] = r.setting_value; });
          volSemStart = sMap.volunteer_semester_start || null;
          volSemEnd = sMap.volunteer_semester_end || null;
          const todayDate = new Date();
          const endIsStale = volSemEnd && new Date(volSemEnd + 'T23:59:59') < todayDate;
          if (!volSemStart || !volSemEnd || endIsStale) {
            if (endIsStale) { volSemStart = null; volSemEnd = null; }
            const { data: actClasses } = await supabase
              .from('classes')
              .select('start_date, end_date')
              .eq('status', 'Active')
              .order('start_date', { ascending: true })
              .limit(20);
            if (actClasses && actClasses.length > 0) {
              const starts = actClasses.map(c => c.start_date).filter(Boolean).sort();
              const ends = actClasses.map(c => c.end_date).filter(Boolean).sort();
              if (!volSemStart && starts.length > 0) volSemStart = starts[0];
              if (!volSemEnd && ends.length > 0) volSemEnd = ends[ends.length - 1];
            }
          }
          if (!volSemStart) volSemStart = `${new Date().getFullYear()}-01-01`;
          if (!volSemEnd) volSemEnd = `${new Date().getFullYear()}-12-31`;
        } catch (semErr) {
          console.warn('Grade card: semester window fetch failed, using current year:', semErr);
          volSemStart = `${new Date().getFullYear()}-01-01`;
          volSemEnd = `${new Date().getFullYear()}-12-31`;
        }

        let volunteerHours = 0;
        try {
          const { data: volData } = await supabase
            .from('time_clock')
            .select('total_hours')
            .eq('user_email', profile.email)
            .eq('entry_type', 'Volunteer')
            .eq('approval_status', 'Approved')
            .gte('punch_in', volSemStart + 'T00:00:00')
            .lte('punch_in', volSemEnd + 'T23:59:59');
          (volData || []).forEach(r => { volunteerHours += parseFloat(r.total_hours) || 0; });
        } catch (e) {
          console.warn('Grade card: volunteer hours fetch failed:', e);
        }

        // 7. Build the cards
        const generatedAt = new Date().toISOString();
        const builtCards = classWindows.map(w => {
          const courseId = w.classConfig.course_id;
          const cr = attendanceByCourseId[courseId];
          const wocResult = wocByCourseId[courseId];
          return {
            classConfig: w.classConfig,
            startDate: w.startDate,
            endDate: w.endDate,
            isFinal: w.isFinal,
            asOf: generatedAt,
            attendanceScore: cr ? cr.attendance.attendanceScore : null,
            // Phase 2: keep the full weekly breakdown so the "Why?" expansion
            // can show per-week scores with reasons. Already built by
            // generateUserReport — no extra cost to retain.
            attendanceWeeks: cr ? cr.weeklyBreakdown : [],
            attendanceTotals: cr ? cr.attendance : null,
            wocScore: wocResult ? wocResult.score : null,
            // Phase 3: keep the full WOC result (details + activity factor +
            // deductions + rewards) so the expansion can group by category
            // and show contributing WOs.
            wocResult: wocResult || null,
            volunteerHours: Math.round(volunteerHours * 100) / 100,
          };
        });

        if (!cancelled) {
          setCards(builtCards);
          setLoading(false);
        }
      } catch (e) {
        console.error('GradeRelevantScores load failed:', e);
        if (!cancelled) {
          setError('Could not load your grade-relevant scores. Try refreshing the page.');
          setLoading(false);
        }
      }
    };

    load();

    return () => { cancelled = true; };
    // Reload when profile changes (e.g. classes added/removed). We intentionally
    // do not subscribe to time_clock or work_orders changes here — the cards
    // show "As of [time]" so a snapshot is the expected mental model. Page
    // refresh updates them. Live subscriptions would re-run a heavy multi-call
    // fetch on every clock event; not worth the cost.
  }, [profile?.user_id, profile?.email, profile?.classes]);

  // Quiet during initial load — matches AccountabilityMetrics' pattern
  if (loading) return null;

  // No started classes → don't render anything (e.g. summer break, new student)
  if (!error && cards.length === 0) return null;

  return (
    <section
      aria-labelledby="grade-relevant-heading"
      style={{ marginTop: 24 }}
    >
      <header style={{ marginBottom: 12 }}>
        <h3
          id="grade-relevant-heading"
          style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#1a1a2e' }}
        >
          My Grade-Relevant Scores
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: '#868e96', lineHeight: 1.5 }}>
          The values your instructor uses for your grade. They update as the class
          progresses and freeze with a “Final” badge once the class ends.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          style={{
            padding: '12px 14px',
            background: '#fff4e6',
            border: '1px solid #ffd8a8',
            color: '#a86825',
            borderRadius: 8,
            fontSize: '0.85rem',
          }}
        >
          {error}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 12,
          }}
        >
          {cards.map(c => (
            <GradeCard key={c.classConfig.class_id || c.classConfig.course_id} card={c} navigate={navigate} />
          ))}
        </div>
      )}

      <p
        style={{
          margin: '12px 0 0',
          fontSize: '0.7rem',
          color: '#868e96',
          fontStyle: 'italic',
          lineHeight: 1.5,
        }}
      >
        <strong style={{ fontStyle: 'normal', fontWeight: 600, color: '#495057' }}>Attendance</strong> includes Late, Left Early, and No Show penalties; weeks closed by an All Done are scored 100%.{' '}
        <strong style={{ fontStyle: 'normal', fontWeight: 600, color: '#495057' }}>WOC Ratio</strong> is computed for this class’s date range and may differ from the all-time score on the WOC Ratio page (used for team rankings, not grades).{' '}
        <strong style={{ fontStyle: 'normal', fontWeight: 600, color: '#495057' }}>Volunteer Hours</strong> show your program-wide approved hours across the current semester.
      </p>
    </section>
  );
}

function GradeCard({ card, navigate }) {
  const {
    classConfig, isFinal, asOf,
    attendanceScore, attendanceWeeks,
    wocScore, wocResult,
    volunteerHours, startDate, endDate
  } = card;
  const courseId = classConfig.course_id;
  const titleId = `gc-${classConfig.class_id || courseId}-title`;

  const formatShort = (s) => {
    if (!s) return '';
    const d = new Date(s + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // Score color is paired with bold weight so the meaning is conveyed by more
  // than hue alone (WCAG 2.1 SC 1.4.1 — Use of Color).
  const scoreColor = (v) =>
    v == null ? '#868e96' : v >= 90 ? '#2f9e44' : v >= 70 ? '#e67700' : '#c92a2a';

  const finalsExcludedNote = classConfig.finals_start ? ' · finals excluded' : '';

  // The "Why?" expansion only makes sense if at least one of the metrics has
  // explanatory data attached. If both attendanceWeeks and wocResult.details
  // are empty (e.g. open-ended class with no completed work yet), don't
  // render the disclosure at all.
  const hasAttendanceWhy = Array.isArray(attendanceWeeks) && attendanceWeeks.length > 0;
  const hasWocWhy = !!wocResult && (
    (Array.isArray(wocResult.details) && wocResult.details.length > 0) ||
    (wocResult.activityFactor != null && wocResult.activityFactor < 1)
  );
  const showWhy = hasAttendanceWhy || hasWocWhy;

  return (
    <article
      aria-labelledby={titleId}
      style={{
        background: '#fff',
        borderRadius: 10,
        border: `1px solid ${isFinal ? '#ced4da' : '#e9ecef'}`,
        padding: 14,
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <h4
            id={titleId}
            style={{
              margin: 0,
              fontSize: '0.95rem',
              fontWeight: 700,
              color: '#1a1a2e',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {courseId}
          </h4>
          {classConfig.course_name && (
            <p
              style={{
                margin: '2px 0 0',
                fontSize: '0.72rem',
                color: '#868e96',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {classConfig.course_name}
            </p>
          )}
          <p style={{ margin: '4px 0 0', fontSize: '0.68rem', color: '#adb5bd' }}>
            {formatShort(startDate)} – {formatShort(endDate)}{finalsExcludedNote}
          </p>
        </div>
        {isFinal && (
          <span
            style={{
              flexShrink: 0,
              padding: '2px 8px',
              background: '#e7f5ff',
              color: '#1864ab',
              border: '1px solid #74c0fc',
              borderRadius: 999,
              fontSize: '0.62rem',
              fontWeight: 700,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
            }}
            aria-label="Final score, class has ended"
          >
            Final
          </span>
        )}
      </header>

      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
          margin: 0,
        }}
      >
        <ScoreCell
          label="Attendance"
          value={attendanceScore}
          suffix="%"
          color={scoreColor(attendanceScore)}
        />
        <ScoreCell
          label="WOC Ratio"
          value={wocScore}
          suffix="%"
          color={scoreColor(wocScore)}
        />
        <ScoreCell
          label="Volunteer"
          value={volunteerHours == null ? null : volunteerHours}
          formatter={(v) => formatHoursMin(v)}
          color="#495057"
        />
      </dl>

      {/* Phase 2/3 expansion. Native <details>/<summary> is keyboard-accessible
          and screen-reader-friendly without any aria plumbing — a single tab
          stop, expands on Enter/Space, announces "expanded/collapsed" state
          automatically. Inside, we use a description list for week scores so
          screen readers can navigate "Week 4: 80%, 2 Late". */}
      {showWhy && (
        <details
          style={{
            border: '1px solid #f1f3f5',
            borderRadius: 6,
            padding: 0,
          }}
        >
          <summary
            style={{
              padding: '6px 10px',
              fontSize: '0.74rem',
              fontWeight: 600,
              color: '#495057',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            Why these scores?
          </summary>
          <div style={{ padding: '8px 10px 10px', borderTop: '1px solid #f1f3f5' }}>
            {hasAttendanceWhy && (
              <WhyAttendance weeks={attendanceWeeks} score={attendanceScore} />
            )}
            {hasAttendanceWhy && hasWocWhy && (
              <hr style={{ border: 0, borderTop: '1px dashed #e9ecef', margin: '10px 0' }} />
            )}
            {hasWocWhy && (
              <WhyWOC result={wocResult} score={wocScore} />
            )}
          </div>
        </details>
      )}

      <footer
        style={{
          borderTop: '1px solid #f1f3f5',
          paddingTop: 8,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: '0.66rem', color: '#adb5bd' }}>
          As of {new Date(asOf).toLocaleString()}
        </span>
        <button
          type="button"
          onClick={() => navigate('/time-cards')}
          style={{
            background: 'transparent',
            border: '1px solid #dee2e6',
            borderRadius: 6,
            padding: '3px 8px',
            fontSize: '0.7rem',
            fontWeight: 500,
            color: '#495057',
            cursor: 'pointer',
          }}
        >
          View time cards →
        </button>
      </footer>
    </article>
  );
}

// ─── Phase 2: Attendance Why? — week-by-week breakdown ─────────────────────────
//
// Reads cr.weeklyBreakdown directly. Each week already has its score and a
// pre-computed `attendance` object with late/early/no-show/walk-in counts.
// We just have to render a friendly "reason" string per week. Weeks where
// hours were met and nothing went wrong → "Hours met". Weeks closed by an
// All Done → "All Done given". Weeks with incidents → enumerate them.

function buildWeekReason(wk) {
  const a = wk.attendance || {};
  const reasons = [];
  if (wk.allDone || (wk.entries || []).some(e => e.entry_type === 'All Done')) {
    reasons.push('All Done given');
  }
  if (a.noShows > 0) reasons.push(`${a.noShows} No Show${a.noShows > 1 ? 's' : ''}`);
  if (a.lateArrivals > 0) reasons.push(`${a.lateArrivals} Late`);
  if (a.earlyDepartures > 0) reasons.push(`${a.earlyDepartures} Left Early`);
  if (a.walkIns > 0) reasons.push(`${a.walkIns} Walk-in${a.walkIns > 1 ? 's' : ''}`);
  if (a.wrongClass > 0) reasons.push(`${a.wrongClass} Wrong Class`);
  if (reasons.length === 0) {
    if (wk.metHours || wk.requiredHoursMet) return 'Hours met';
    if (wk.requiredHours > 0 && (wk.hours || 0) < wk.requiredHours) {
      return `${formatHoursMin(wk.hours || 0)} of ${formatHoursMin(wk.requiredHours)}`;
    }
    return wk.isFinals ? 'Finals week' : '—';
  }
  return reasons.join(', ');
}

function WhyAttendance({ weeks, score }) {
  const formatRange = (start, end) => {
    if (!start || !end) return '';
    const s = new Date(start + 'T00:00:00');
    const e = new Date(end + 'T00:00:00');
    const sM = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const eM = e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${sM}–${eM}`;
  };
  const tone = (s) => s == null ? '#868e96' : s >= 90 ? '#2f9e44' : s >= 70 ? '#e67700' : '#c92a2a';

  return (
    <section aria-labelledby="why-attendance-h">
      <h5
        id="why-attendance-h"
        style={{
          margin: '0 0 6px',
          fontSize: '0.72rem',
          fontWeight: 700,
          color: '#1a1a2e',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        Attendance — {score == null ? '—' : `${score}%`}
      </h5>
      <table
        style={{
          width: '100%',
          fontSize: '0.7rem',
          borderCollapse: 'collapse',
        }}
      >
        <caption className="visually-hidden" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          Per-week attendance breakdown showing week number, score, and reason.
        </caption>
        <thead>
          <tr style={{ borderBottom: '1px solid #f1f3f5' }}>
            <th scope="col" style={{ textAlign: 'left', padding: '3px 6px 3px 0', fontWeight: 600, color: '#868e96', fontSize: '0.65rem', textTransform: 'uppercase' }}>Wk</th>
            <th scope="col" style={{ textAlign: 'left', padding: '3px 6px', fontWeight: 600, color: '#868e96', fontSize: '0.65rem', textTransform: 'uppercase' }}>Dates</th>
            <th scope="col" style={{ textAlign: 'right', padding: '3px 6px', fontWeight: 600, color: '#868e96', fontSize: '0.65rem', textTransform: 'uppercase' }}>Score</th>
            <th scope="col" style={{ textAlign: 'left', padding: '3px 0 3px 6px', fontWeight: 600, color: '#868e96', fontSize: '0.65rem', textTransform: 'uppercase' }}>Notes</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map(wk => {
            const wScore = wk.attendance ? wk.attendance.attendanceScore : null;
            return (
              <tr key={wk.weekNumber}>
                <th scope="row" style={{ textAlign: 'left', padding: '3px 6px 3px 0', fontWeight: 600, color: '#495057', whiteSpace: 'nowrap' }}>
                  W{wk.weekNumber}
                </th>
                <td style={{ padding: '3px 6px', color: '#868e96', whiteSpace: 'nowrap' }}>
                  {formatRange(wk.startDate, wk.endDate)}
                </td>
                <td style={{ padding: '3px 6px', textAlign: 'right', fontWeight: 700, color: tone(wScore), whiteSpace: 'nowrap' }}>
                  {wScore == null ? '—' : `${wScore}%`}
                </td>
                <td style={{ padding: '3px 0 3px 6px', color: '#495057' }}>
                  {buildWeekReason(wk)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ─── Phase 3: WOC Why? — category-grouped contributing items ──────────────────
//
// Reads wocResult.details directly from calculateScore. Groups by detail type
// and renders one section per group with the contributing WOs. Activity
// factor is shown as a separate explanation when it scaled the base score
// down (the most common reason for a low WOC that has nothing to do with
// specific WOs).

const WOC_TYPE_META = {
  personal_late: { label: 'Late on assigned work orders',     sign: '−', tone: '#c92a2a' },
  team_late:     { label: 'Team late penalty (any open WO)',  sign: '−', tone: '#e67700' },
  stale:         { label: 'Stale work orders (no updates)',   sign: '−', tone: '#c92a2a' },
  early_share:   { label: 'Early-close bonuses',              sign: '+', tone: '#2f9e44' },
  closer_ack:    { label: 'Closer acknowledgments',           sign: '+', tone: '#2f9e44' },
};

function WhyWOC({ result, score }) {
  const details = Array.isArray(result.details) ? result.details : [];

  // Group by type, summing the per-entry impact.
  const groups = {};
  for (const d of details) {
    if (!groups[d.type]) groups[d.type] = { entries: [], total: 0 };
    groups[d.type].entries.push(d);
    // deduction for negatives, reward for positives
    const impact = (d.deduction || 0) + (d.reward || 0);
    groups[d.type].total += impact;
  }

  // Order: personal first (matters most to student), then stale, team, then bonuses.
  const order = ['personal_late', 'stale', 'team_late', 'early_share', 'closer_ack'];
  const groupKeys = order.filter(k => groups[k]).concat(
    Object.keys(groups).filter(k => !order.includes(k))
  );

  const showActivityNote =
    result.activityFactor != null &&
    result.activityFactor < 1 &&
    result.expectedHours != null;

  return (
    <section aria-labelledby="why-woc-h">
      <h5
        id="why-woc-h"
        style={{
          margin: '0 0 6px',
          fontSize: '0.72rem',
          fontWeight: 700,
          color: '#1a1a2e',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        WOC Ratio — {score == null ? '—' : `${score}%`}
      </h5>

      {/* Activity factor — usually the biggest hidden driver of a low WOC. */}
      {showActivityNote && (
        <div
          style={{
            padding: '6px 8px',
            background: '#fff9db',
            border: '1px solid #ffec99',
            borderRadius: 4,
            fontSize: '0.68rem',
            color: '#5c4a00',
            marginBottom: 8,
            lineHeight: 1.4,
          }}
        >
          <strong style={{ fontWeight: 700 }}>Activity factor: {Math.round(result.activityFactor * 100)}%.</strong>
          {' '}You logged {formatHoursMin(result.activityHours || 0)} of {formatHoursMin(result.expectedHours || 0)} expected this period — your base score was scaled accordingly. Log more hours on work orders to lift this back to 100%.
        </div>
      )}

      {groupKeys.length === 0 ? (
        <p style={{ margin: 0, fontSize: '0.7rem', color: '#868e96', fontStyle: 'italic' }}>
          No specific work orders to flag for this period.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groupKeys.map(key => {
            const meta = WOC_TYPE_META[key] || { label: key, sign: '', tone: '#495057' };
            const grp = groups[key];
            const entries = grp.entries;
            return (
              <div key={key}>
                <div
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    color: meta.tone,
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span>{meta.label}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {meta.sign}{round1(Math.abs(grp.total))}% · {entries.length} WO{entries.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <ul
                  style={{
                    margin: '3px 0 0',
                    padding: 0,
                    listStyle: 'none',
                  }}
                >
                  {entries.map((e, idx) => (
                    <li
                      key={`${e.woId}-${idx}`}
                      style={{
                        fontSize: '0.68rem',
                        color: '#495057',
                        padding: '2px 0 2px 10px',
                        borderLeft: `2px solid ${meta.tone}33`,
                        marginLeft: 4,
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: '0.65rem', color: '#1864ab' }}>
                        {e.woId}
                      </span>
                      {e.description ? (
                        <span style={{ color: '#868e96' }}> — {e.description}</span>
                      ) : null}
                      {/* Per-entry context: days late, days stale, % of work for early-share, etc. */}
                      <WOCDetailExtra entry={e} type={key} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Tiny helper for the per-entry context line. Kept inline as a sub-component
// so each detail type can have its own format without bloating WhyWOC.
function WOCDetailExtra({ entry, type }) {
  let text = '';
  if (type === 'personal_late' || type === 'team_late') {
    if (entry.days != null) text = `${entry.days} day${entry.days !== 1 ? 's' : ''} late`;
  } else if (type === 'stale') {
    if (entry.daysSinceUpdate != null) {
      text = `${entry.daysSinceUpdate} days without update`;
    } else if (entry.days != null) {
      text = `${entry.days} day${entry.days !== 1 ? 's' : ''} over threshold`;
    }
  } else if (type === 'early_share') {
    const parts = [];
    if (entry.days != null) parts.push(`${entry.days} day${entry.days !== 1 ? 's' : ''} early`);
    if (entry.pctOfWork != null) parts.push(`${entry.pctOfWork}% of the work`);
    if (entry.capped) parts.push('capped');
    text = parts.join(', ');
  }
  if (!text) return null;
  return (
    <span style={{ display: 'block', fontSize: '0.62rem', color: '#adb5bd', marginLeft: 0 }}>
      {text}
    </span>
  );
}

// One-decimal rounding helper used in the WOC group totals.
function round1(n) {
  if (n == null || isNaN(n)) return 0;
  return Math.round(n * 10) / 10;
}

function ScoreCell({ label, value, suffix, formatter, color }) {
  let display;
  if (value == null) {
    display = '—';
  } else if (formatter) {
    display = formatter(value);
  } else {
    display = `${value}${suffix || ''}`;
  }
  return (
    <div>
      <dt
        style={{
          fontSize: '0.6rem',
          color: '#868e96',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 600,
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          margin: '2px 0 0',
          fontSize: '1.15rem',
          fontWeight: 700,
          color,
          lineHeight: 1.2,
        }}
      >
        {display}
      </dd>
    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════════
// ─── Instructor Overview (tiles + day view + temp access) ───────────────
// ═════════════════════════════════════════════════════════════════════════

function InstructorOverview({ navigate }) {
  const { profile } = useAuth();

  // ── Dashboard layout defaults (from settings, overridden by localStorage) ──
  const LS_DAY   = 'dash_dayView_expanded';
  const LS_TEMP  = 'dash_tempAccess_expanded';

  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [dayViewExpanded, setDayViewExpanded] = useState(true);        // real init happens after settings load
  const [tempAccessExpanded, setTempAccessExpanded] = useState(false); // real init happens after settings load

  // Load Supabase defaults once, then let localStorage override
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('settings')
          .select('setting_key, setting_value')
          .in('setting_key', ['dashboard_day_view_expanded', 'dashboard_temp_access_expanded']);

        const getVal = (key, fallback) => {
          const row = (data || []).find(r => r.setting_key === key);
          return row ? row.setting_value === 'true' : fallback;
        };

        const dbDayDefault  = getVal('dashboard_day_view_expanded',   true);
        const dbTempDefault = getVal('dashboard_temp_access_expanded', false);

        if (!cancelled) {
          // localStorage wins if the user has ever manually toggled; otherwise use DB default
          const lsDay  = localStorage.getItem(LS_DAY);
          const lsTemp = localStorage.getItem(LS_TEMP);
          setDayViewExpanded(lsDay   !== null ? lsDay  === 'true' : dbDayDefault);
          setTempAccessExpanded(lsTemp !== null ? lsTemp === 'true' : dbTempDefault);
          setSettingsLoaded(true);
        }
      } catch {
        if (!cancelled) setSettingsLoaded(true); // fall back to hardcoded defaults above
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist user toggles to localStorage
  const toggleDayView = () => setDayViewExpanded(prev => {
    const next = !prev;
    localStorage.setItem(LS_DAY, String(next));
    return next;
  });
  const toggleTempAccess = () => setTempAccessExpanded(prev => {
    const next = !prev;
    localStorage.setItem(LS_TEMP, String(next));
    return next;
  });

  // Ref to scroll Day View card into view when activated via tile click
  const dayViewRef = React.useRef(null);
  const expandAndScrollDayView = () => {
    setDayViewExpanded(true);
    localStorage.setItem(LS_DAY, 'true');
    setTimeout(() => dayViewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  // ── State ──
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [signups, setSignups] = useState([]);
  const [clockEntries, setClockEntries] = useState([]);
  const [tcoEmails, setTcoEmails] = useState(new Set());
  const [lateWOs, setLateWOs] = useState([]);
  const [lateModalOpen, setLateModalOpen] = useState(false);
  const [dayLoading, setDayLoading] = useState(true);
  const [woLoading, setWoLoading] = useState(true);

  // Asset checkouts (count of currently-out + overdue)
  const [outCount, setOutCount] = useState(0);
  const [overdueCheckoutCount, setOverdueCheckoutCount] = useState(0);
  const [checkoutLoading, setCheckoutLoading] = useState(true);

  // Temp access state
  const [activeTempAccess, setActiveTempAccess] = useState([]);
  const [tempAccessLoading, setTempAccessLoading] = useState(true);
  const [tempHistoryOpen, setTempHistoryOpen] = useState(false);
  const [tempHistory, setTempHistory] = useState([]);
  const [tempHistoryLoading, setTempHistoryLoading] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  const [toast, setToast] = useState(null);

  // ── A11y: Escape closes + focus trap + focus return for each modal (WCAG 2.1.1, 2.4.3) ──
  const closeLateModal     = useCallback(() => setLateModalOpen(false),  []);
  const closeTempHistory   = useCallback(() => setTempHistoryOpen(false), []);
  const closeConfirmRevoke = useCallback(() => setConfirmRevoke(null),    []);
  const lateModalRef       = useDialogA11y(lateModalOpen,    closeLateModal);
  const tempHistoryRef     = useDialogA11y(tempHistoryOpen,  closeTempHistory);
  const confirmRevokeRef   = useDialogA11y(!!confirmRevoke,  closeConfirmRevoke);

  const showToast = (msg, type = 'info') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };
  const userName = () => profile ? `${profile.first_name} ${profile.last_name}` : '';
  const fmtDate = (d) => { if (!d) return '—'; return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };

  const dateStr = useMemo(() => toLocalDateStr(selectedDate), [selectedDate]);
  const isToday = dateStr === toLocalDateStr(new Date());

  const goBack = () => { const d = new Date(selectedDate); d.setDate(d.getDate() - 1); setSelectedDate(d); };
  const goForward = () => { const d = new Date(selectedDate); d.setDate(d.getDate() + 1); setSelectedDate(d); };
  const goToday = () => setSelectedDate(new Date());

  // ── Swipe gesture support on Day View body (mobile UX) ──
  // Refs (not state) — avoid re-renders during touch tracking.
  // WCAG 2.5.1 (AA) — every swipe action also has an equivalent button (Previous/Next).
  const touchStartX = React.useRef(null);
  const touchStartY = React.useRef(null);
  const touchEndX   = React.useRef(null);
  const touchEndY   = React.useRef(null);
  const SWIPE_THRESHOLD_PX = 50;

  const onDayBodyTouchStart = (e) => {
    if (!e.touches || e.touches.length === 0) return;
    touchEndX.current = null;
    touchEndY.current = null;
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };
  const onDayBodyTouchMove = (e) => {
    if (!e.touches || e.touches.length === 0) return;
    touchEndX.current = e.touches[0].clientX;
    touchEndY.current = e.touches[0].clientY;
  };
  const onDayBodyTouchEnd = () => {
    if (touchStartX.current == null || touchEndX.current == null) return;
    const dx = touchStartX.current - touchEndX.current;
    const dy = touchStartY.current - touchEndY.current;
    // Ignore short or mostly-vertical movement (let page scroll normally)
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (dx > 0) goForward();   // swipe left → next day
    else        goBack();      // swipe right → previous day
  };

  // ── Fetch late WOs ──
  const fetchLateWOs = useCallback(async () => {
    try {
      // Use local-date midnight so WOs due today are NOT considered late —
      // a WO is only late the day AFTER its due date. Using toISOString() (UTC)
      // caused evening CST runs to flag tomorrow's WOs as overdue.
      const t = new Date(); t.setHours(0, 0, 0, 0);
      const todayStr = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      const { data, error } = await supabase
        .from('work_orders')
        .select('wo_id, description, priority, status, assigned_to, due_date, asset_name')
        .lt('due_date', todayStr)
        .not('status', 'in', '("Completed","Cancelled")')
        .order('due_date', { ascending: true });
      if (!error) setLateWOs(data || []);
    } catch { /* ignore */ }
    setWoLoading(false);
  }, []);

  useEffect(() => {
    fetchLateWOs();
    // Unique channel name per mount — prevents collision when dashboard is open in two tabs
    const ch = supabase.channel(`dash-inst-late-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders' }, fetchLateWOs)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [fetchLateWOs]);

  // ── Fetch asset checkouts (open & overdue) ──
  const fetchCheckoutCounts = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('asset_checkouts')
        .select('checkout_id, expected_return')
        .is('returned_at', null);
      const rows = data || [];
      const now = new Date();
      const overdue = rows.filter(r => r.expected_return && new Date(r.expected_return) < now).length;
      setOutCount(rows.length);
      setOverdueCheckoutCount(overdue);
    } catch { /* ignore — table may not yet exist */ }
    setCheckoutLoading(false);
  }, []);

  useEffect(() => {
    fetchCheckoutCounts();
    const ch = supabase.channel(`dash-inst-checkouts-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'asset_checkouts' }, fetchCheckoutCounts)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [fetchCheckoutCounts]);

  // ── Fetch day signups + clock ──
  const fetchDayData = useCallback(async () => {
    setDayLoading(true);
    try {
      const [{ data: su }, { data: tc }, { data: tcoProfiles }] = await Promise.all([
        supabase.from('lab_signup')
          .select('signup_id, user_name, user_email, start_time, end_time, status')
          .eq('date', dateStr).eq('status', 'Confirmed')
          .order('start_time', { ascending: true }),
        supabase.from('time_clock')
          .select('record_id, user_name, user_email, punch_in, punch_out, status, entry_type')
          .gte('punch_in', dateStr + 'T00:00:00').lte('punch_in', dateStr + 'T23:59:59')
          .order('punch_in', { ascending: true }),
        // Fetch TCO emails so Day View can show "Work Study" instead of "Walk-in"
        supabase.from('profiles')
          .select('email, time_clock_only')
          .eq('time_clock_only', 'Yes'),
      ]);
      setSignups(su || []);
      setClockEntries(tc || []);
      const emails = new Set();
      (tcoProfiles || []).forEach(p => { if (p.email) emails.add(p.email.toLowerCase()); });
      setTcoEmails(emails);
    } catch (err) { console.error('Day view fetch error:', err); }
    setDayLoading(false);
  }, [dateStr]);

  useEffect(() => { fetchDayData(); }, [fetchDayData]);

  useEffect(() => {
    // Unique channel name per mount — prevents collision when dashboard is open in two tabs
    const ch = supabase.channel(`dash-inst-day-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_signup' }, fetchDayData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_clock' }, fetchDayData)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [fetchDayData]);



  // ── Fetch temp access ──
  const loadActiveTempAccess = useCallback(async () => {
    setTempAccessLoading(true);
    try {
      const { data, error } = await supabase
        .from('temp_access_requests').select('*')
        .eq('status', 'Active').order('review_date', { ascending: false });
      if (!error && data) setActiveTempAccess(data);
      else setActiveTempAccess([]);
    } catch { setActiveTempAccess([]); }
    setTempAccessLoading(false);
  }, []);

  useEffect(() => { loadActiveTempAccess(); }, [loadActiveTempAccess]);

  useEffect(() => {
    // Unique channel name per mount — prevents collision when dashboard is open in two tabs
    const ch = supabase.channel(`dash-inst-temp-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'temp_access_requests' }, loadActiveTempAccess)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [loadActiveTempAccess]);

  const loadTempHistory = async () => {
    setTempHistoryLoading(true);
    try {
      const { data } = await supabase.from('temp_access_requests').select('*').order('submitted_date', { ascending: false }).limit(50);
      setTempHistory(data || []);
    } catch { setTempHistory([]); }
    setTempHistoryLoading(false);
  };

  const confirmRevokeAction = async () => {
    const req = confirmRevoke;
    if (!req) return;
    setConfirmRevoke(null);
    try {
      const { data: revokeRows, error: revokeErr } = await supabase.from('temp_access_requests')
        .update({ status: 'Revoked', reviewed_by: userName(), reverted_date: new Date().toISOString() })
        .eq('request_id', req.request_id).select();
      if (revokeErr) throw revokeErr;
      if (!revokeRows || revokeRows.length === 0) { showToast('Revoke failed — you may not have permission.', 'error'); return; }
      if (req.request_type !== 'permissions') {
        const originalRole = req.original_role || req.user_current_role;
        if (originalRole && req.user_email) {
          const { data: roleRows, error: roleErr } = await supabase.from('profiles').update({ role: originalRole }).eq('email', req.user_email).select();
          if (roleErr) throw roleErr;
          if (!roleRows || roleRows.length === 0) { showToast('Revoked access request but failed to restore original role.', 'error'); }
        }
      }
      showToast(`Revoked access for ${req.user_name}`, 'success');
      loadActiveTempAccess();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  };

  // ── Build merged people list for day view ──
  const peopleList = useMemo(() => {
    const map = new Map();

    (signups || []).forEach(s => {
      const key = (s.user_email || '').toLowerCase();
      if (!key) return;
      if (!map.has(key)) map.set(key, { user_name: s.user_name, user_email: s.user_email, expectedStart: s.start_time, expectedEnd: s.end_time, signupSlots: [], clockEntries: [] });
      const p = map.get(key);
      p.signupSlots.push({ start: s.start_time, end: s.end_time });
      if (!p.expectedStart || s.start_time < p.expectedStart) p.expectedStart = s.start_time;
      if (!p.expectedEnd || s.end_time > p.expectedEnd) p.expectedEnd = s.end_time;
    });

    (clockEntries || []).forEach(c => {
      const key = (c.user_email || '').toLowerCase();
      if (!key) return;
      if (!map.has(key)) map.set(key, { user_name: c.user_name, user_email: c.user_email, expectedStart: null, expectedEnd: null, signupSlots: [], clockEntries: [] });
      map.get(key).clockEntries.push(c);
    });

    let list = Array.from(map.values());

    // For today: hide people who have punched out — they're done for the day
    if (isToday) {
      list = list.filter(p => {
        const hasPunchedOut = p.clockEntries.some(c => c.status === 'Punched Out');
        const isStillIn = p.clockEntries.some(c => c.status === 'Punched In');
        if (hasPunchedOut && !isStillIn) return false;
        return true;
      });
    }

    // Sort: punched in first, then expected by start time, then recently departed
    list.sort((a, b) => {
      const aIn = a.clockEntries.some(c => c.status === 'Punched In');
      const bIn = b.clockEntries.some(c => c.status === 'Punched In');
      if (aIn && !bIn) return -1;
      if (!aIn && bIn) return 1;
      const aOut = a.clockEntries.some(c => c.status === 'Punched Out');
      const bOut = b.clockEntries.some(c => c.status === 'Punched Out');
      if (!aOut && bOut) return -1;
      if (aOut && !bOut) return 1;
      if (a.expectedStart && b.expectedStart) return a.expectedStart.localeCompare(b.expectedStart);
      if (a.expectedStart) return -1;
      if (b.expectedStart) return 1;
      return 0;
    });

    return list;
  }, [signups, clockEntries, isToday]);

  // Tile counts
  const expectedCount = useMemo(() => {
    // Count unique signed-up users who are still expected (not yet punched out).
    // Mirrors the Day View filter: exclude anyone who has punched out and isn't still punched in.
    const signupEmails = new Set();
    (signups || []).forEach(s => { if (s.user_email) signupEmails.add(s.user_email.toLowerCase()); });

    if (!isToday) return signupEmails.size; // For past/future dates, just count all signups

    // For today, subtract people who have already left
    const punchedOut = new Set();
    const punchedIn = new Set();
    (clockEntries || []).forEach(c => {
      const email = (c.user_email || '').toLowerCase();
      if (!email) return;
      if (c.status === 'Punched Out') punchedOut.add(email);
      if (c.status === 'Punched In') punchedIn.add(email);
    });

    let count = 0;
    signupEmails.forEach(email => {
      const hasPunchedOut = punchedOut.has(email);
      const isStillIn = punchedIn.has(email);
      if (hasPunchedOut && !isStillIn) return; // They've left, don't count
      count++;
    });
    return count;
  }, [signups, clockEntries, isToday]);

  const punchedInCount = useMemo(() => {
    const emails = new Set();
    (clockEntries || []).forEach(c => { if (c.status === 'Punched In' && c.user_email) emails.add(c.user_email.toLowerCase()); });
    return emails.size;
  }, [clockEntries]);

  const daysLate = (dueDateStr) => {
    if (!dueDateStr) return 0;
    // Parse as local midnight to avoid UTC-offset day shifts
    const datePart = typeof dueDateStr === 'string' ? dueDateStr.substring(0, 10) : '';
    const due = /^\d{4}-\d{2}-\d{2}$/.test(datePart)
      ? new Date(datePart + 'T00:00:00')
      : new Date(dueDateStr);
    const tod = new Date(); tod.setHours(0, 0, 0, 0);
    return Math.max(0, Math.floor((tod - due) / 86400000));
  };

  const priorityColor = (p) => {
    switch ((p || '').toLowerCase()) {
      case 'high': return '#fa5252';
      case 'medium': return '#fab005';
      case 'low': return '#228be6';
      default: return '#868e96';
    }
  };

  return (
    <>
      {toast && <div className={`dash-toast dash-toast-${toast.type}`} role="status" aria-live="polite">{toast.msg}</div>}

      {/* ── 1×3 Summary Tiles ── */}
      <div style={{ marginTop: 24 }}>
        <div className="dash-inst-tiles">

          {/* Late WOs tile — clickable */}
          <button
            type="button"
            className="dash-metric-tile"
            onClick={() => { if (lateWOs.length > 0) setLateModalOpen(true); else navigate('/work-orders'); }}
            aria-label={
              woLoading ? 'Late Work Orders, loading'
              : lateWOs.length === 0
                ? 'Late Work Orders: 0, all on track'
                : `Late Work Orders: ${lateWOs.length}, open list`
            }
            aria-haspopup={lateWOs.length > 0 ? 'dialog' : undefined}
            style={lateWOs.length > 0 ? { borderColor: '#ffe3e3' } : {}}
          >
            <span className="material-icons dash-metric-icon" aria-hidden="true" style={{
              color: lateWOs.length > 0 ? '#fa5252' : '#40c057',
              background: lateWOs.length > 0 ? '#ffe3e3' : '#d3f9d8',
            }}>
              {lateWOs.length > 0 ? 'warning' : 'check_circle'}
            </span>
            <div className="dash-metric-value" style={{ color: lateWOs.length > 0 ? '#fa5252' : '#40c057' }}>
              {woLoading ? '—' : lateWOs.length}
            </div>
            <div className="dash-metric-label">Late Work Orders</div>
            <div className="dash-metric-sub">{lateWOs.length === 0 ? 'All on track' : 'tap to view'}</div>
          </button>

          {/* Expected tile */}
          <button type="button" className="dash-metric-tile" onClick={expandAndScrollDayView}
            aria-label={`Expected Today: ${dayLoading ? 'loading' : expectedCount}${expectedCount === 0 ? ', no signups' : ', open day view'}`}>
            <span className="material-icons dash-metric-icon" aria-hidden="true" style={{ color: '#228be6', background: '#e7f5ff' }}>group</span>
            <div className="dash-metric-value">{dayLoading ? '—' : expectedCount}</div>
            <div className="dash-metric-label">Expected Today</div>
            <div className="dash-metric-sub">{expectedCount === 0 ? 'No signups' : 'tap to view'}</div>
          </button>

          {/* Punched In tile */}
          <button type="button" className="dash-metric-tile" onClick={expandAndScrollDayView}
            aria-label={`Punched In: ${dayLoading ? 'loading' : punchedInCount}${punchedInCount === 0 ? ', no one currently' : ', open day view'}`}>
            <span className="material-icons dash-metric-icon" aria-hidden="true" style={{ color: '#40c057', background: '#d3f9d8' }}>login</span>
            <div className="dash-metric-value">{dayLoading ? '—' : punchedInCount}</div>
            <div className="dash-metric-label">Punched In</div>
            <div className="dash-metric-sub">{punchedInCount === 0 ? 'No one currently' : 'tap to view'}</div>
          </button>

          {/* Asset Checkouts tile — clickable */}
          <button
            type="button"
            className="dash-metric-tile"
            onClick={() => navigate('/asset-checkouts')}
            aria-label={
              checkoutLoading ? 'Asset Checkouts, loading'
              : overdueCheckoutCount > 0
                ? `Asset Checkouts: ${outCount} out, ${overdueCheckoutCount} overdue, open list`
                : outCount === 0
                  ? 'Asset Checkouts: nothing out'
                  : `Asset Checkouts: ${outCount} out, all on time, open list`
            }
            style={overdueCheckoutCount > 0 ? { borderColor: '#ffe3e3' } : {}}
          >
            <span className="material-icons dash-metric-icon" aria-hidden="true" style={{
              color: overdueCheckoutCount > 0 ? '#fa5252' : (outCount > 0 ? '#d9480f' : '#40c057'),
              background: overdueCheckoutCount > 0 ? '#ffe3e3' : (outCount > 0 ? '#fff4e6' : '#d3f9d8'),
            }}>
              {overdueCheckoutCount > 0 ? 'warning' : (outCount > 0 ? 'schedule' : 'check_circle')}
            </span>
            <div className="dash-metric-value" style={{
              color: overdueCheckoutCount > 0 ? '#fa5252' : (outCount > 0 ? '#d9480f' : '#40c057'),
            }}>
              {checkoutLoading ? '—' : outCount}
            </div>
            <div className="dash-metric-label">Assets Out</div>
            <div className="dash-metric-sub">
              {checkoutLoading ? '' :
                overdueCheckoutCount > 0
                  ? `${overdueCheckoutCount} overdue`
                  : (outCount > 0 ? 'tap to view' : 'All returned')}
            </div>
          </button>

        </div>
      </div>

      {/* ── Day View ── */}
      <div style={{ marginTop: 16 }} ref={dayViewRef}>
        <div className="dash-card">
          {/*
            Header now contains ONLY the title, summary (when collapsed), and expand chevron.
            Date navigation has been moved to its own row below to fix mobile overflow
            (the previous all-in-one header clipped the "next day" arrow on ~380px viewports).
          */}
          <div
            className="dash-card-header"
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={toggleDayView}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDayView(); } }}
            role="button"
            tabIndex={0}
            aria-expanded={dayViewExpanded}
            aria-controls="dash-day-view-body"
            aria-label={`Day View, ${dayViewExpanded ? 'expanded' : 'collapsed'}`}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
              <span className="material-icons" aria-hidden="true" style={{ color: '#228be6', flexShrink: 0 }}>calendar_today</span>
              <strong>Day View</strong>
              {!dayViewExpanded && !dayLoading && (
                <span style={{ fontSize: '0.78rem', color: '#868e96', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                  {!isToday && `— ${formatDateLabel(selectedDate)}, `}
                  {isToday && peopleList.length > 0 && '— '}
                  {peopleList.length} {peopleList.length === 1 ? 'person' : 'people'}
                  {isToday && peopleList.length === 0 && ''}
                </span>
              )}
            </span>
            <span className="material-icons" aria-hidden="true" style={{ fontSize: '1.3rem', color: '#868e96', marginLeft: 4, flexShrink: 0, transition: 'transform 0.2s', transform: dayViewExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
              expand_more
            </span>
          </div>

          {/* Date navigation row — only when expanded. Replaces the inline cluster
              that used to live in the header. The date label itself is a button:
              when not on today, tapping it returns to today (replaces the old
              separate "Today" button). On today, the button is disabled. */}
          {dayViewExpanded && (
            <div className="dash-day-nav-row">
              <button
                type="button"
                className="dash-day-nav-btn"
                aria-label="Previous day"
                onClick={goBack}
              >
                <span className="material-icons" aria-hidden="true" style={{ fontSize: '1.4rem' }}>chevron_left</span>
              </button>
              <button
                type="button"
                className="dash-day-nav-date"
                onClick={isToday ? undefined : goToday}
                disabled={isToday}
                aria-disabled={isToday || undefined}
              >
                <span className="dash-day-nav-date-text" aria-live="polite" aria-atomic="true">
                  {formatDateLabel(selectedDate)}
                </span>
                {!isToday && (
                  <span className="dash-day-nav-date-hint">
                    <span className="material-icons" aria-hidden="true" style={{ fontSize: '0.85rem' }}>today</span>
                    Tap to return to today
                  </span>
                )}
              </button>
              <button
                type="button"
                className="dash-day-nav-btn"
                aria-label="Next day"
                onClick={goForward}
              >
                <span className="material-icons" aria-hidden="true" style={{ fontSize: '1.4rem' }}>chevron_right</span>
              </button>
            </div>
          )}

          {dayViewExpanded && (
            <div
              id="dash-day-view-body"
              className="dash-card-body"
              onTouchStart={onDayBodyTouchStart}
              onTouchMove={onDayBodyTouchMove}
              onTouchEnd={onDayBodyTouchEnd}
            >
              {dayLoading ? (
                <p style={{ color: '#868e96', textAlign: 'center', padding: 20 }}>Loading...</p>
              ) : peopleList.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px 20px' }}>
                  <span className="material-icons" aria-hidden="true" style={{ fontSize: '2rem', color: '#868e96', display: 'block', marginBottom: 8 }}>event_busy</span>
                  <p style={{ color: '#868e96', margin: 0, fontSize: '0.9rem' }}>No one expected or checked in</p>
                </div>
              ) : (
                peopleList.map((person, idx) => {
                  const isPunchedIn = person.clockEntries.some(c => c.status === 'Punched In');
                  const hasLeft = person.clockEntries.some(c => c.status === 'Punched Out');
                  const hasSignup = person.signupSlots.length > 0;
                  const isWorkStudyPunch = person.clockEntries.some(c => c.entry_type === 'Work Study');
                  const isPersonTCO = tcoEmails.has((person.user_email || '').toLowerCase());
                  const isWorkStudy = isWorkStudyPunch || isPersonTCO;
                  const isWalkIn = !hasSignup && person.clockEntries.length > 0 && !isWorkStudy;
                  const activeEntry = person.clockEntries.find(c => c.status === 'Punched In');
                  const punchInTime = activeEntry ? formatTimestamp12(activeEntry.punch_in) : null;

                  let statusDot;
                  if (isPunchedIn) statusDot = '#40c057';
                  else if (hasLeft) statusDot = '#868e96';
                  else statusDot = '#fab005';

                  return (
                    <div key={person.user_email || idx} className="dash-day-person" style={{ borderLeftColor: statusDot }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusDot, flexShrink: 0 }} />
                        <span style={{ fontSize: '0.88rem', fontWeight: 600, color: '#1a1a2e', flex: 1 }}>{person.user_name}</span>
                        {isWorkStudy && <span className="dash-badge-work-study">Work Study</span>}
                        {isWalkIn && <span className="dash-badge-walk-in">Walk-in</span>}
                        {isPunchedIn && <span className="dash-badge-in">In Lab</span>}
                        {hasLeft && !isPunchedIn && <span className="dash-badge-left">Left</span>}
                        {!isPunchedIn && !hasLeft && hasSignup && <span className="dash-badge-expected">Expected</span>}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 4, marginLeft: 16, fontSize: '0.8rem', color: '#495057' }}>
                        {hasSignup && (
                          <span>{formatTime12(person.expectedStart)} – {formatTime12(person.expectedEnd)}</span>
                        )}
                        {isPunchedIn && punchInTime && (
                          <span style={{ color: '#40c057' }}>In: {punchInTime}</span>
                        )}
                        {isPunchedIn && hasSignup && person.expectedEnd && (
                          <span style={{ color: '#fd7e14' }}>Leaving ~{formatTime12(person.expectedEnd)}</span>
                        )}
                        {hasLeft && !isPunchedIn && (
                          <span style={{ color: '#868e96' }}>Left: {formatTimestamp12(person.clockEntries.find(c => c.status === 'Punched Out')?.punch_out)}</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Active Temp Access Card ── */}
      <div style={{ marginTop: 16 }}>
        <div className="dash-card">
          <div
            className="dash-card-header"
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={() => toggleTempAccess()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTempAccess(); } }}
            role="button"
            tabIndex={0}
            aria-expanded={tempAccessExpanded}
            aria-controls="dash-temp-access-body"
            aria-label={`Active Temp Access${activeTempAccess.length > 0 ? `, ${activeTempAccess.length} active` : ', none active'}, ${tempAccessExpanded ? 'expanded' : 'collapsed'}`}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="material-icons" aria-hidden="true" style={{ color: '#228be6' }}>verified_user</span>
              <strong>Active Temp Access</strong>
              {!tempAccessLoading && activeTempAccess.length > 0 && (
                <span style={{ background: '#d3f9d8', color: '#2b8a3e', padding: '2px 10px', borderRadius: 12, fontSize: '0.78rem', fontWeight: 700 }}>
                  {activeTempAccess.length}
                </span>
              )}
              {!tempAccessExpanded && !tempAccessLoading && activeTempAccess.length === 0 && (
                <span style={{ fontSize: '0.78rem', color: '#868e96', fontWeight: 400 }}>— None active</span>
              )}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {tempAccessExpanded && (
                <button className="dash-btn-sm" onClick={(e) => { e.stopPropagation(); setTempHistoryOpen(true); loadTempHistory(); }}>
                  <span className="material-icons" aria-hidden="true" style={{ fontSize: '0.9rem', verticalAlign: 'middle', marginRight: 4 }}>history</span>History
                </button>
              )}
              <span className="material-icons" aria-hidden="true" style={{ fontSize: '1.3rem', color: '#868e96', transition: 'transform 0.2s', transform: tempAccessExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                expand_more
              </span>
            </div>
          </div>
          {tempAccessExpanded && (
          <div id="dash-temp-access-body" className="dash-card-body">
            {tempAccessLoading ? (
              <p style={{ color: '#868e96', textAlign: 'center', padding: 20 }}>Loading...</p>
            ) : activeTempAccess.length === 0 ? (
              <p style={{ color: '#868e96', textAlign: 'center', padding: 20 }}>No active temp access</p>
            ) : (
              activeTempAccess.map(a => {
                const isPermType = a.request_type === 'permissions';
                const approvedPerms = a.approved_permissions || [];
                return (
                  <div key={a.request_id} className="dash-temp-item" style={{ borderLeftColor: isPermType ? '#7c3aed' : '#40c057' }}>
                    <div style={{ flex: 1 }}>
                      <h4 style={{ margin: 0, fontSize: '0.9rem', color: '#1a1a2e' }}>{a.user_name}</h4>
                      {isPermType ? (
                        <>
                          <p style={{ margin: '4px 0 2px', fontSize: '0.82rem' }}>
                            <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 600, background: '#f3e8ff', color: '#7c3aed' }}>
                              {approvedPerms.length} Permission{approvedPerms.length !== 1 ? 's' : ''}
                            </span>
                            <span style={{ color: '#868e96', fontSize: '0.8rem', marginLeft: 8 }}>(role unchanged: {a.user_current_role})</span>
                          </p>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 }}>
                            {approvedPerms.slice(0, 5).map((p, i) => (
                              <span key={i} style={{ padding: '1px 5px', borderRadius: 3, fontSize: '0.65rem', background: '#f3e8ff', color: '#5f3dc4' }}>
                                {p.page}: {p.feature.replace(/_/g, ' ')}
                              </span>
                            ))}
                            {approvedPerms.length > 5 && <span style={{ fontSize: '0.65rem', color: '#868e96' }}>+{approvedPerms.length - 5} more</span>}
                          </div>
                        </>
                      ) : (
                        <p style={{ margin: '4px 0', fontSize: '0.82rem' }}>
                          <span className={`dash-role-badge ${a.approved_role === 'Instructor' ? 'role-inst' : 'role-ws'}`}>{a.approved_role}</span>
                          <span style={{ color: '#868e96', fontSize: '0.8rem', marginLeft: 8 }}>(was {a.original_role || a.user_current_role})</span>
                        </p>
                      )}
                      <small style={{ color: '#2b8a3e' }}>Expires: {fmtDate(a.expiry_date)}</small>
                    </div>
                    <button className="dash-btn-reject" onClick={() => setConfirmRevoke(a)}>Revoke</button>
                  </div>
                );
              })
            )}
          </div>
          )}
        </div>
      </div>

      {/* ── Late WOs Detail Modal ── */}
      {lateModalOpen && (
        <div className="dash-modal-overlay" onClick={e => e.target === e.currentTarget && setLateModalOpen(false)}>
          <div className="dash-modal" ref={lateModalRef} role="dialog" aria-modal="true" aria-labelledby="late-modal-title" style={{ maxWidth: 560 }}>
            <div className="dash-modal-header">
              <h4 id="late-modal-title">
                <span className="material-icons" aria-hidden="true" style={{ color: '#fa5252', fontSize: '1.1rem' }}>warning</span>
                Late Work Orders ({lateWOs.length})
              </h4>
              <button className="dash-modal-close" aria-label="Close" onClick={() => setLateModalOpen(false)}>&times;</button>
            </div>
            <div className="dash-modal-body" style={{ maxHeight: 420, overflowY: 'auto', padding: 0 }}>
              {lateWOs.map(wo => (
                <button
                  type="button"
                  key={wo.wo_id}
                  className="dash-late-wo-item"
                  onClick={() => { setLateModalOpen(false); navigate('/work-orders'); }}
                  aria-label={`${wo.wo_id}, ${wo.description}, ${wo.priority || 'no priority'} priority, ${daysLate(wo.due_date)} days late, assigned to ${wo.assigned_to || 'no one'}${wo.asset_name ? `, asset ${wo.asset_name}` : ''}`}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                      <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#495057' }}>{wo.wo_id}</span>
                      <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: priorityColor(wo.priority), flexShrink: 0 }} title={wo.priority} />
                      <span style={{ fontSize: '0.72rem', color: '#868e96' }}>{wo.status}</span>
                    </div>
                    <div style={{ fontSize: '0.85rem', color: '#1a1a2e', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {wo.description}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#868e96', marginTop: 2 }}>
                      {wo.assigned_to || 'Unassigned'}{wo.asset_name ? ` · ${wo.asset_name}` : ''}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fa5252' }}>{daysLate(wo.due_date)}d</div>
                    <div style={{ fontSize: '0.68rem', color: '#868e96' }}>late</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Temp Access History Modal ── */}
      {tempHistoryOpen && (
        <div className="dash-modal-overlay" onClick={e => e.target === e.currentTarget && setTempHistoryOpen(false)}>
          <div className="dash-modal" ref={tempHistoryRef} role="dialog" aria-modal="true" aria-labelledby="temp-history-title" style={{ maxWidth: 600 }}>
            <div className="dash-modal-header">
              <h4 id="temp-history-title"><span className="material-icons" aria-hidden="true" style={{ color: '#228be6' }}>history</span> Temp Access History</h4>
              <button className="dash-modal-close" aria-label="Close" onClick={() => setTempHistoryOpen(false)}>&times;</button>
            </div>
            <div className="dash-modal-body" style={{ maxHeight: 400, overflowY: 'auto' }}>
              {tempHistoryLoading ? (
                <p style={{ textAlign: 'center', color: '#868e96', padding: 20 }}>Loading...</p>
              ) : tempHistory.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#868e96', padding: 20 }}>No history found</p>
              ) : (
                <table className="dash-table">
                  <thead>
                    <tr><th scope="col">User</th><th scope="col">Type</th><th scope="col">Access</th><th scope="col">Status</th><th scope="col">Date</th></tr>
                  </thead>
                  <tbody>
                    {tempHistory.map(h => {
                      const isPermType = h.request_type === 'permissions';
                      const permCount = (h.approved_permissions || h.requested_permissions || []).length;
                      return (
                        <tr key={h.request_id}>
                          <td>{h.user_name || h.user_email}</td>
                          <td>
                            <span style={{ display: 'inline-block', padding: '2px 6px', borderRadius: 4, fontSize: '0.65rem', fontWeight: 600, background: isPermType ? '#f3e8ff' : '#fff9db', color: isPermType ? '#7c3aed' : '#664d03' }}>
                              {isPermType ? 'Perms' : 'Role'}
                            </span>
                          </td>
                          <td>
                            {isPermType ? (
                              <span style={{ fontSize: '0.8rem', color: '#7c3aed' }}>{permCount} perm{permCount !== 1 ? 's' : ''}</span>
                            ) : (
                              <span className={`dash-role-badge ${h.approved_role === 'Instructor' || h.requested_role === 'Instructor' ? 'role-inst' : 'role-ws'}`}>{h.approved_role || h.requested_role}</span>
                            )}
                          </td>
                          <td><span className={`dash-status-badge status-${(h.status || '').toLowerCase()}`}>{h.status}</span></td>
                          <td style={{ fontSize: '0.8rem', color: '#868e96' }}>{fmtDate(h.submitted_date || h.created_at)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Revoke Confirm Modal ── */}
      {confirmRevoke && (
        <div className="dash-modal-overlay" onClick={e => e.target === e.currentTarget && setConfirmRevoke(null)}>
          <div className="dash-modal" ref={confirmRevokeRef} role="dialog" aria-modal="true" aria-labelledby="revoke-modal-title" style={{ maxWidth: 400 }}>
            <div className="dash-modal-header">
              <h4 id="revoke-modal-title"><span className="material-icons" aria-hidden="true" style={{ color: '#fa5252', fontSize: '1.2rem' }}>gpp_bad</span> Revoke Access</h4>
              <button className="dash-modal-close" aria-label="Close" onClick={() => setConfirmRevoke(null)}>&times;</button>
            </div>
            <div className="dash-modal-body">
              <p style={{ margin: 0, fontSize: '0.9rem', color: '#495057' }}>
                Revoke temporary access for <strong>{confirmRevoke.user_name}</strong>?
              </p>
              {confirmRevoke.request_type === 'permissions' ? (
                <p style={{ margin: '8px 0 0', fontSize: '0.82rem', color: '#868e96' }}>
                  Their <strong>{(confirmRevoke.approved_permissions || []).length} temporary permission(s)</strong> will be removed immediately. Their role ({confirmRevoke.user_current_role}) stays unchanged.
                </p>
              ) : (
                <p style={{ margin: '8px 0 0', fontSize: '0.82rem', color: '#868e96' }}>
                  Their role will revert from <strong>{confirmRevoke.approved_role}</strong> back to <strong>{confirmRevoke.original_role || confirmRevoke.user_current_role || 'Student'}</strong> immediately.
                </p>
              )}
            </div>
            <div className="dash-modal-footer">
              <button className="dash-btn-cancel" onClick={() => setConfirmRevoke(null)}>Cancel</button>
              <button className="dash-btn-reject" onClick={confirmRevokeAction} style={{ padding: '10px 20px', fontSize: '0.88rem' }}>
                <span className="material-icons" aria-hidden="true" style={{ fontSize: '0.9rem', verticalAlign: 'middle', marginRight: 4 }}>close</span>
                Revoke
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


// ═════════════════════════════════════════════════════════════════════════
// ─── Main Dashboard ─────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════

/* ════════════════════════════════════════════════════════════════════════ */
/*  Pending Asset-Checkout Acknowledgment Banner                            */
/*                                                                          */
/*  Top-of-dashboard nudge for students/staff who have one or more asset    */
/*  checkout requests waiting on their e-signature. Returns null when there */
/*  is nothing pending — zero visual noise for the typical case.            */
/*                                                                          */
/*  WCAG 2.1 AA:                                                            */
/*    - role="region" + aria-label so screen-reader users can navigate to it */
/*    - aria-live="polite" on the headline so urgency changes are announced  */
/*      (urgent < 30m, soon < 2h, expired)                                   */
/*    - Color is paired with an icon + label — never the only signal         */
/*    - Real <button> elements, proper focus rings                           */
/*    - The "Review & Sign" buttons set focus into the dialog automatically  */
/*      via useDialogA11y on the modal                                       */
/* ════════════════════════════════════════════════════════════════════════ */
function PendingAckBanner() {
  const { profile } = useAuth();
  const { pending, now } = useUserPendingAcknowledgments(profile?.email);
  const [target, setTarget] = useState(null);

  if (!pending || pending.length === 0) return null;

  // Headline urgency derived from the SOONEST-expiring pending request.
  // Hook returns rows ordered by expires_at asc, so pending[0] is the most urgent.
  const head = pending[0];
  const cd = formatCountdown(head.expires_at, now);

  // Banner color tier — paired with icon + label, color is never the only signal
  let tier = 'normal'; // amber (informational)
  if (cd?.expired) tier = 'expired';
  else if (cd?.urgent) tier = 'urgent';
  else if (cd?.soon) tier = 'soon';

  const styles = {
    normal:   { bg: '#fff8e1', border: '#fbbf24', fg: '#92400e', accent: '#d97706' },
    soon:     { bg: '#fff4e6', border: '#fb923c', fg: '#9a3412', accent: '#c2410c' },
    urgent:   { bg: '#fef2f2', border: '#f87171', fg: '#991b1b', accent: '#b91c1c' },
    expired:  { bg: '#f5f5f5', border: '#9ca3af', fg: '#374151', accent: '#4b5563' },
  }[tier];

  const headlineText = pending.length === 1
    ? '1 asset checkout needs your signature'
    : `${pending.length} asset checkouts need your signature`;

  return (
    <>
      <section
        role="region"
        aria-label="Pending asset checkout acknowledgments"
        style={{
          background: styles.bg,
          border: `2px solid ${styles.border}`,
          borderRadius: 12,
          padding: '14px 16px',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div
            style={{
              width: 40, height: 40, borderRadius: '50%',
              background: 'white', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `2px solid ${styles.border}`,
            }}
            aria-hidden="true"
          >
            <span className="material-icons" style={{ color: styles.accent, fontSize: '1.3rem' }}>
              {tier === 'expired' ? 'history' : 'verified_user'}
            </span>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div
              aria-live="polite"
              style={{ fontSize: '0.95rem', fontWeight: 700, color: styles.fg, marginBottom: 2 }}
            >
              {headlineText}
            </div>
            <div style={{ fontSize: '0.85rem', color: styles.fg }}>
              {pending.length === 1
                ? <>An asset is reserved for you and is waiting for your e-signature.</>
                : <>Assets are reserved for you and are waiting for your e-signature.</>
              }
              {cd && !cd.expired && (
                <> The most urgent expires in <strong style={{ color: styles.accent }}>{cd.label}</strong>.</>
              )}
              {cd?.expired && (
                <> The earliest one has expired — sign now or it will be released.</>
              )}
            </div>
          </div>
        </div>

        {/* List of pending items — one button per request.
            Single-item case still gets one button (no special-casing). */}
        <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pending.map(p => {
            const itemCd = formatCountdown(p.expires_at, now);
            const itemTier = itemCd?.expired ? 'expired'
              : itemCd?.urgent ? 'urgent'
              : itemCd?.soon ? 'soon'
              : 'normal';
            const itemAccent = {
              normal: '#d97706', soon: '#c2410c', urgent: '#b91c1c', expired: '#4b5563',
            }[itemTier];
            return (
              <li key={p.checkout_id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  background: 'white', borderRadius: 8, padding: '10px 12px',
                  border: `1px solid ${styles.border}`,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.92rem', fontWeight: 600, color: '#1a1a2e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.asset_name || p.asset_id}
                  </div>
                  <div style={{ fontSize: '0.78rem', color: '#6b7280', marginTop: 2 }}>
                    <span style={{ fontFamily: 'monospace' }}>{p.asset_id}</span>
                    {p.asset_serial_number && <> · <span style={{ fontFamily: 'monospace' }}>SN {p.asset_serial_number}</span></>}
                    {itemCd && (
                      <>
                        {' · '}
                        <span style={{ color: itemAccent, fontWeight: 600 }} aria-label={itemCd.ariaLabel}>
                          {itemCd.expired ? 'Expired' : `${itemCd.label} left`}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setTarget(p)}
                  style={{
                    padding: '8px 14px', borderRadius: 8,
                    border: 'none', background: itemAccent, color: 'white',
                    fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    flexShrink: 0,
                  }}
                  aria-label={`Review and sign for ${p.asset_name || p.asset_id}`}
                >
                  <span className="material-icons" aria-hidden="true" style={{ fontSize: '1.05rem' }}>
                    {itemCd?.expired ? 'visibility' : 'verified_user'}
                  </span>
                  {itemCd?.expired ? 'Review' : 'Review & Sign'}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {target && (
        <PendingAcknowledgmentModal
          isOpen={!!target}
          onClose={() => setTarget(null)}
          checkout={target}
          userName={target.user_name || (profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() : '')}
          onAcknowledged={() => setTarget(null)}
          onDeclined={() => setTarget(null)}
        />
      )}
    </>
  );
}

export default function DashboardPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const { hasPerm: hasUserPerm } = usePermissions('Users');
  const isInstructor = hasUserPerm('view_page');
  const isStudentOrWS = profile?.role === 'Work Study' || profile?.role === 'Student';

  const [funFact] = useState(() => funFacts[Math.floor(Math.random() * funFacts.length)]);

  useEffect(() => {
    if (!document.querySelector('link[href*="Material+Icons"]')) {
      const link = document.createElement('link');
      link.href = 'https://fonts.googleapis.com/icon?family=Material+Icons';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
  }, []);

  return (
    <div className="dash-root">
      {/* ── Pending Asset Checkout Acknowledgments (top priority — time-sensitive) ── */}
      <PendingAckBanner />

      {/* ── Welcome Section (compact) ── */}
      <div className="dash-welcome">
        <h2 className="dash-welcome-title">Welcome back, {profile?.first_name || 'there'}!</h2>
        <p className="dash-welcome-text">RICT CMMS — Manage work orders, inventory, assets, and more.</p>

        <div className="dash-funfact">
          <span className="material-icons" aria-hidden="true" style={{ color: '#fab005', fontSize: '1.5rem', flexShrink: 0 }}>tips_and_updates</span>
          <div>
            <div className="dash-funfact-label">DID YOU KNOW?</div>
            <div className="dash-funfact-text">{funFact}</div>
          </div>
        </div>
      </div>

      {/* ── Student / Work Study: Compact Metrics ── */}
      {isStudentOrWS && <AccountabilityMetrics navigate={navigate} />}

      {/* ── Student / Work Study: Per-Class Grade-Relevant Scores ── */}
      {isStudentOrWS && <GradeRelevantScores />}

      {/* ── Instructor: Overview ── */}
      {isInstructor && <InstructorOverview navigate={navigate} />}
    </div>
  );
}

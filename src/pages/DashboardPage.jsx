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
import { useWOCRatio } from '@/hooks/useWOCRatio';

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
    const channel = supabase.channel('dash-wo-count')
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
        const { data: classesData } = await supabase.from('classes').select('start_date, end_date').in('course_id', userClasses).eq('status', 'Active');
        if (!classesData || classesData.length === 0) { if (!cancelled) { setAttendanceScore(100); setAttLoading(false); } return; }
        let startDate = null, endDate = null;
        classesData.forEach(c => {
          const sd = c.start_date ? c.start_date.split('T')[0] : null;
          const ed = c.end_date ? c.end_date.split('T')[0] : null;
          if (sd && (!startDate || sd < startDate)) startDate = sd;
          if (ed && (!endDate || ed > endDate)) endDate = ed;
        });
        if (!startDate) startDate = `${new Date().getFullYear()}-01-01`;
        if (!endDate) endDate = new Date().toISOString().split('T')[0];
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
    const channel = supabase.channel('dash-attendance')
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
        <div className="dash-metric-tile" onClick={() => navigate('/work-orders')} role="button" tabIndex={0}>
          <span className="material-icons dash-metric-icon" style={{ color: '#228be6', background: '#e7f5ff' }}>assignment</span>
          <div className="dash-metric-value">{woCount}</div>
          <div className="dash-metric-label">Work Orders</div>
          <div className="dash-metric-sub">{woCount === 0 ? 'None assigned' : 'assigned to me'}</div>
        </div>
        <div className="dash-metric-tile" onClick={() => navigate('/weekly-labs-tracker')} role="button" tabIndex={0}>
          <span className="material-icons dash-metric-icon" style={{ color: '#20c997', background: '#e6fcf5' }}>fact_check</span>
          <div className="dash-metric-value">{labsThisWeek.total > 0 ? `${labsThisWeek.done}/${labsThisWeek.total}` : '—'}</div>
          <div className="dash-metric-label">Weekly Labs</div>
          <div className="dash-metric-sub">{labsThisWeek.total === 0 ? 'No labs this week' : labsThisWeek.done === labsThisWeek.total ? 'All complete ✓' : 'complete this week'}</div>
        </div>
        <div className="dash-metric-tile" onClick={() => navigate('/time-cards')} role="button" tabIndex={0}>
          <span className="material-icons dash-metric-icon" style={{ color: scoreColor(score), background: scoreBg(score) }}>shield</span>
          <div className="dash-metric-value" style={{ color: scoreColor(score) }}>{score}%</div>
          <div className="dash-metric-label">Attendance</div>
          <div className="dash-metric-sub">{score >= 90 ? 'On-time score' : score >= 70 ? 'Needs improvement' : 'At risk'}</div>
        </div>
        <div className="dash-metric-tile" onClick={() => navigate('/volunteer-hours')} role="button" tabIndex={0}>
          <span className="material-icons dash-metric-icon" style={{ color: '#9333ea', background: '#f3e8ff' }}>volunteer_activism</span>
          <div className="dash-metric-value">{formatHoursMin(volStats.approvedHours)}</div>
          <div className="dash-metric-label">Volunteer Hours</div>
          <div className="dash-metric-sub">of {formatHoursMin(volStats.totalRequired)} required</div>
        </div>
        {(() => {
          const woc = wocScore?.score ?? null;
          const rank = wocScore?.rank ?? null;
          const total = wocScore?.totalRanked ?? null;
          const wocColor = woc === null ? '#868e96' : woc >= 90 ? '#40c057' : woc >= 70 ? '#fab005' : '#fa5252';
          const wocBg   = woc === null ? '#f1f3f5' : woc >= 90 ? '#d3f9d8' : woc >= 70 ? '#fff9db' : '#ffe3e3';
          return (
            <div className="dash-metric-tile" onClick={() => navigate('/woc-ratio')} role="button" tabIndex={0}>
              <span className="material-icons dash-metric-icon" style={{ color: wocColor, background: wocBg }}>gpp_good</span>
              <div className="dash-metric-value" style={{ color: wocColor }}>{woc !== null ? woc : '—'}</div>
              <div className="dash-metric-label">WOC Score</div>
              <div className="dash-metric-sub">
                {rank !== null && total !== null ? `Rank ${rank} of ${total}` : 'out of 100'}
              </div>
            </div>
          );
        })()}
      </div>

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
  const [lateWOs, setLateWOs] = useState([]);
  const [lateModalOpen, setLateModalOpen] = useState(false);
  const [dayLoading, setDayLoading] = useState(true);
  const [woLoading, setWoLoading] = useState(true);

  // Temp access state
  const [activeTempAccess, setActiveTempAccess] = useState([]);
  const [tempAccessLoading, setTempAccessLoading] = useState(true);
  const [tempHistoryOpen, setTempHistoryOpen] = useState(false);
  const [tempHistory, setTempHistory] = useState([]);
  const [tempHistoryLoading, setTempHistoryLoading] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'info') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };
  const userName = () => profile ? `${profile.first_name} ${profile.last_name}` : '';
  const fmtDate = (d) => { if (!d) return '—'; return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };

  const dateStr = useMemo(() => toLocalDateStr(selectedDate), [selectedDate]);
  const isToday = dateStr === toLocalDateStr(new Date());

  const goBack = () => { const d = new Date(selectedDate); d.setDate(d.getDate() - 1); setSelectedDate(d); };
  const goForward = () => { const d = new Date(selectedDate); d.setDate(d.getDate() + 1); setSelectedDate(d); };
  const goToday = () => setSelectedDate(new Date());

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
    const ch = supabase.channel('dash-inst-late')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders' }, fetchLateWOs)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [fetchLateWOs]);

  // ── Fetch day signups + clock ──
  const fetchDayData = useCallback(async () => {
    setDayLoading(true);
    try {
      const [{ data: su }, { data: tc }] = await Promise.all([
        supabase.from('lab_signup')
          .select('signup_id, user_name, user_email, start_time, end_time, status')
          .eq('date', dateStr).eq('status', 'Confirmed')
          .order('start_time', { ascending: true }),
        supabase.from('time_clock')
          .select('record_id, user_name, user_email, punch_in, punch_out, status, entry_type')
          .gte('punch_in', dateStr + 'T00:00:00').lte('punch_in', dateStr + 'T23:59:59')
          .order('punch_in', { ascending: true }),
      ]);
      setSignups(su || []);
      setClockEntries(tc || []);
    } catch (err) { console.error('Day view fetch error:', err); }
    setDayLoading(false);
  }, [dateStr]);

  useEffect(() => { fetchDayData(); }, [fetchDayData]);

  useEffect(() => {
    const ch = supabase.channel('dash-inst-day')
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
    const ch = supabase.channel('dash-inst-temp')
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
      {toast && <div className={`dash-toast dash-toast-${toast.type}`}>{toast.msg}</div>}

      {/* ── 1×3 Summary Tiles ── */}
      <div style={{ marginTop: 24 }}>
        <div className="dash-inst-tiles">

          {/* Late WOs tile — clickable */}
          <div
            className="dash-metric-tile"
            onClick={() => { if (lateWOs.length > 0) setLateModalOpen(true); else navigate('/work-orders'); }}
            role="button" tabIndex={0}
            style={lateWOs.length > 0 ? { borderColor: '#ffe3e3' } : {}}
          >
            <span className="material-icons dash-metric-icon" style={{
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
          </div>

          {/* Expected tile */}
          <div className="dash-metric-tile" onClick={expandAndScrollDayView} role="button" tabIndex={0} style={{ cursor: 'pointer' }}>
            <span className="material-icons dash-metric-icon" style={{ color: '#228be6', background: '#e7f5ff' }}>group</span>
            <div className="dash-metric-value">{dayLoading ? '—' : expectedCount}</div>
            <div className="dash-metric-label">Expected Today</div>
            <div className="dash-metric-sub">{expectedCount === 0 ? 'No signups' : 'tap to view'}</div>
          </div>

          {/* Punched In tile */}
          <div className="dash-metric-tile" onClick={expandAndScrollDayView} role="button" tabIndex={0} style={{ cursor: 'pointer' }}>
            <span className="material-icons dash-metric-icon" style={{ color: '#40c057', background: '#d3f9d8' }}>login</span>
            <div className="dash-metric-value">{dayLoading ? '—' : punchedInCount}</div>
            <div className="dash-metric-label">Punched In</div>
            <div className="dash-metric-sub">{punchedInCount === 0 ? 'No one currently' : 'tap to view'}</div>
          </div>

        </div>
      </div>

      {/* ── Day View ── */}
      <div style={{ marginTop: 16 }} ref={dayViewRef}>
        <div className="dash-card">
          <div
            className="dash-card-header"
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={toggleDayView}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="material-icons" style={{ color: '#228be6' }}>calendar_today</span>
              <strong>Day View</strong>
              {!dayViewExpanded && !dayLoading && (
                <span style={{ fontSize: '0.78rem', color: '#868e96', fontWeight: 400 }}>
                  {!isToday && `— ${formatDateLabel(selectedDate)}, `}
                  {isToday && peopleList.length > 0 && '— '}
                  {peopleList.length} {peopleList.length === 1 ? 'person' : 'people'}
                  {isToday && peopleList.length === 0 && ''}
                </span>
              )}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {dayViewExpanded && !isToday && (
                <button className="dash-btn-sm" onClick={(e) => { e.stopPropagation(); goToday(); }} style={{ marginRight: 4 }}>Today</button>
              )}
              {dayViewExpanded && (
                <>
                  <button className="dash-day-nav-btn" onClick={(e) => { e.stopPropagation(); goBack(); }}><span className="material-icons" style={{ fontSize: '1.2rem' }}>chevron_left</span></button>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#1a1a2e', minWidth: 200, textAlign: 'center' }}>
                    {formatDateLabel(selectedDate)}
                  </span>
                  <button className="dash-day-nav-btn" onClick={(e) => { e.stopPropagation(); goForward(); }}><span className="material-icons" style={{ fontSize: '1.2rem' }}>chevron_right</span></button>
                </>
              )}
              <span className="material-icons" style={{ fontSize: '1.3rem', color: '#868e96', marginLeft: 4, transition: 'transform 0.2s', transform: dayViewExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                expand_more
              </span>
            </div>
          </div>

          {dayViewExpanded && (
            <div className="dash-card-body">
              {dayLoading ? (
                <p style={{ color: '#868e96', textAlign: 'center', padding: 20 }}>Loading...</p>
              ) : peopleList.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px 20px' }}>
                  <span className="material-icons" style={{ fontSize: '2rem', color: '#868e96', display: 'block', marginBottom: 8 }}>event_busy</span>
                  <p style={{ color: '#868e96', margin: 0, fontSize: '0.9rem' }}>No one expected or checked in</p>
                </div>
              ) : (
                peopleList.map((person, idx) => {
                  const isPunchedIn = person.clockEntries.some(c => c.status === 'Punched In');
                  const hasLeft = person.clockEntries.some(c => c.status === 'Punched Out');
                  const hasSignup = person.signupSlots.length > 0;
                  const isWalkIn = !hasSignup && person.clockEntries.length > 0;
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
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="material-icons" style={{ color: '#228be6' }}>verified_user</span>
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
                  <span className="material-icons" style={{ fontSize: '0.9rem', verticalAlign: 'middle', marginRight: 4 }}>history</span>History
                </button>
              )}
              <span className="material-icons" style={{ fontSize: '1.3rem', color: '#868e96', transition: 'transform 0.2s', transform: tempAccessExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                expand_more
              </span>
            </div>
          </div>
          {tempAccessExpanded && (
          <div className="dash-card-body">
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
          <div className="dash-modal" style={{ maxWidth: 560 }}>
            <div className="dash-modal-header">
              <h4>
                <span className="material-icons" style={{ color: '#fa5252', fontSize: '1.1rem' }}>warning</span>
                Late Work Orders ({lateWOs.length})
              </h4>
              <button className="dash-modal-close" onClick={() => setLateModalOpen(false)}>&times;</button>
            </div>
            <div className="dash-modal-body" style={{ maxHeight: 420, overflowY: 'auto', padding: 0 }}>
              {lateWOs.map(wo => (
                <div key={wo.wo_id} className="dash-late-wo-item" onClick={() => { setLateModalOpen(false); navigate('/work-orders'); }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                      <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#495057' }}>{wo.wo_id}</span>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: priorityColor(wo.priority), flexShrink: 0 }} title={wo.priority} />
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
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Temp Access History Modal ── */}
      {tempHistoryOpen && (
        <div className="dash-modal-overlay" onClick={e => e.target === e.currentTarget && setTempHistoryOpen(false)}>
          <div className="dash-modal" style={{ maxWidth: 600 }}>
            <div className="dash-modal-header">
              <h4><span className="material-icons" style={{ color: '#228be6' }}>history</span> Temp Access History</h4>
              <button className="dash-modal-close" onClick={() => setTempHistoryOpen(false)}>&times;</button>
            </div>
            <div className="dash-modal-body" style={{ maxHeight: 400, overflowY: 'auto' }}>
              {tempHistoryLoading ? (
                <p style={{ textAlign: 'center', color: '#868e96', padding: 20 }}>Loading...</p>
              ) : tempHistory.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#868e96', padding: 20 }}>No history found</p>
              ) : (
                <table className="dash-table">
                  <thead>
                    <tr><th>User</th><th>Type</th><th>Access</th><th>Status</th><th>Date</th></tr>
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
          <div className="dash-modal" style={{ maxWidth: 400 }}>
            <div className="dash-modal-header">
              <h4><span className="material-icons" style={{ color: '#fa5252', fontSize: '1.2rem' }}>gpp_bad</span> Revoke Access</h4>
              <button className="dash-modal-close" onClick={() => setConfirmRevoke(null)}>&times;</button>
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
                <span className="material-icons" style={{ fontSize: '0.9rem', verticalAlign: 'middle', marginRight: 4 }}>close</span>
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
      {/* ── Welcome Section (compact) ── */}
      <div className="dash-welcome">
        <h2 className="dash-welcome-title">Welcome back, {profile?.first_name || 'there'}!</h2>
        <p className="dash-welcome-text">RICT CMMS — Manage work orders, inventory, assets, and more.</p>

        <div className="dash-funfact">
          <span className="material-icons" style={{ color: '#fab005', fontSize: '1.5rem', flexShrink: 0 }}>tips_and_updates</span>
          <div>
            <div className="dash-funfact-label">DID YOU KNOW?</div>
            <div className="dash-funfact-text">{funFact}</div>
          </div>
        </div>
      </div>

      {/* ── Student / Work Study: Compact Metrics ── */}
      {isStudentOrWS && <AccountabilityMetrics navigate={navigate} />}

      {/* ── Instructor: Overview ── */}
      {isInstructor && <InstructorOverview navigate={navigate} />}

      <style>{`
        .dash-root { max-width: 800px; margin: 0 auto; }

        .dash-toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: white; z-index: 5000; font-size: 0.9rem; box-shadow: 0 4px 12px rgba(0,0,0,0.15); animation: dashIn 0.3s ease; }
        .dash-toast-success { background: #40c057; }
        .dash-toast-error { background: #fa5252; }
        .dash-toast-info { background: #228be6; }
        @keyframes dashIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

        .dash-welcome { text-align: center; padding: 24px 24px 20px; background: linear-gradient(180deg, #f0f7ff 0%, #ffffff 100%); border-radius: 16px; }
        .dash-welcome-title { font-size: 1.4rem; font-weight: 700; color: #1a1a2e; margin: 0 0 4px; }
        .dash-welcome-text { font-size: 0.95rem; color: #868e96; margin: 0 0 16px; }

        .dash-funfact { display: flex; align-items: flex-start; gap: 14px; text-align: left; background: white; border-left: 4px solid #228be6; border-radius: 0 12px 12px 0; padding: 14px 18px; max-width: 480px; margin: 0 auto; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
        .dash-funfact-label { font-size: 0.7rem; font-weight: 700; color: #fab005; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
        .dash-funfact-text { font-size: 0.88rem; color: #495057; line-height: 1.5; }

        .dash-metrics-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; max-width: 800px; }
        @media (max-width: 600px) { .dash-metrics-grid { grid-template-columns: repeat(3, 1fr); } }
        .dash-inst-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }

        .dash-metric-tile {
          background: white; border: 1px solid #e9ecef; border-radius: 12px;
          padding: 16px; text-align: center; cursor: pointer; transition: all 0.2s;
        }
        .dash-metric-tile:hover { border-color: #228be6; box-shadow: 0 2px 8px rgba(34,139,230,0.12); transform: translateY(-1px); }
        .dash-metric-tile:focus-visible { outline: 2px solid #228be6; outline-offset: 2px; }
        .dash-metric-icon { font-size: 1.3rem; border-radius: 8px; padding: 6px; display: inline-block; margin-bottom: 8px; }
        .dash-metric-value { font-size: 1.6rem; font-weight: 700; color: #1a1a2e; line-height: 1.2; }
        .dash-metric-label { font-size: 0.78rem; font-weight: 600; color: #495057; margin-top: 2px; }
        .dash-metric-sub { font-size: 0.68rem; color: #868e96; margin-top: 2px; }

        .dash-card { background: white; border-radius: 12px; border: 1px solid #e9ecef; overflow: hidden; }
        .dash-card-header { padding: 16px 20px; border-bottom: 1px solid #f1f3f5; display: flex; justify-content: space-between; align-items: center; font-size: 0.9rem; }
        .dash-card-body { padding: 0; }
        .dash-btn-sm { background: #f1f3f5; border: 1px solid #dee2e6; border-radius: 6px; padding: 4px 12px; font-size: 0.75rem; cursor: pointer; color: #495057; display: inline-flex; align-items: center; }
        .dash-btn-sm:hover { background: #e9ecef; }

        .dash-day-nav-btn {
          background: #f1f3f5; border: 1px solid #dee2e6; border-radius: 6px;
          padding: 2px 4px; cursor: pointer; display: inline-flex; align-items: center;
          justify-content: center; color: #495057; transition: all 0.15s;
        }
        .dash-day-nav-btn:hover { background: #e9ecef; color: #228be6; }

        .dash-day-person {
          padding: 10px 20px; border-bottom: 1px solid #f1f3f5; border-left: 3px solid #e9ecef;
        }
        .dash-day-person:last-child { border-bottom: none; }

        .dash-badge-in { font-size: 0.68rem; font-weight: 600; background: #d3f9d8; color: #2b8a3e; padding: 2px 8px; border-radius: 4px; }
        .dash-badge-left { font-size: 0.68rem; font-weight: 600; background: #f1f3f5; color: #868e96; padding: 2px 8px; border-radius: 4px; }
        .dash-badge-expected { font-size: 0.68rem; font-weight: 600; background: #fff9db; color: #664d03; padding: 2px 8px; border-radius: 4px; }
        .dash-badge-walk-in { font-size: 0.65rem; font-weight: 600; background: #fff4e6; color: #d9480f; padding: 1px 6px; border-radius: 4px; }

        .dash-late-wo-item {
          display: flex; align-items: center; gap: 12px;
          padding: 12px 20px; border-bottom: 1px solid #f1f3f5;
          border-left: 3px solid #fa5252; cursor: pointer; transition: background 0.15s;
        }
        .dash-late-wo-item:last-child { border-bottom: none; }
        .dash-late-wo-item:hover { background: #fff5f5; }

        .dash-temp-item { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid #f1f3f5; border-left: 3px solid #40c057; }
        .dash-temp-item:last-child { border-bottom: none; }

        .dash-role-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
        .dash-role-badge.role-ws { background: #e7f5ff; color: #1971c2; }
        .dash-role-badge.role-inst { background: #f3e8ff; color: #7c3aed; }

        .dash-status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
        .dash-status-badge.status-pending { background: #fff3cd; color: #856404; }
        .dash-status-badge.status-active { background: #d3f9d8; color: #2b8a3e; }
        .dash-status-badge.status-approved { background: #d3f9d8; color: #2b8a3e; }
        .dash-status-badge.status-revoked { background: #ffe3e3; color: #c92a2a; }
        .dash-status-badge.status-rejected { background: #ffe3e3; color: #c92a2a; }
        .dash-status-badge.status-expired { background: #f1f3f5; color: #868e96; }

        .dash-btn-reject { background: #fa5252; color: white; border: none; border-radius: 6px; padding: 6px 14px; font-size: 0.78rem; font-weight: 500; cursor: pointer; transition: opacity 0.2s; }
        .dash-btn-reject:hover { opacity: 0.85; }

        .dash-modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2000; padding: 20px; }
        .dash-modal { background: white; border-radius: 12px; width: 100%; max-width: 440px; overflow: hidden; }
        .dash-modal-header { padding: 20px; border-bottom: 1px solid #e9ecef; display: flex; justify-content: space-between; align-items: center; }
        .dash-modal-header h4 { margin: 0; font-size: 1rem; display: flex; align-items: center; gap: 8px; }
        .dash-modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #868e96; }
        .dash-modal-body { padding: 20px; }
        .dash-modal-footer { padding: 16px 20px; border-top: 1px solid #e9ecef; display: flex; justify-content: flex-end; gap: 12px; }

        .dash-label { display: block; font-size: 0.85rem; font-weight: 500; margin: 12px 0 6px; color: #495057; }
        .dash-input { width: 100%; padding: 10px 12px; border: 1px solid #dee2e6; border-radius: 8px; font-size: 0.9rem; box-sizing: border-box; }
        .dash-input:focus { border-color: #228be6; outline: none; box-shadow: 0 0 0 3px rgba(34,139,230,0.1); }
        textarea.dash-input { resize: vertical; font-family: inherit; }

        .dash-btn-primary { background: #228be6; color: white; border: none; border-radius: 8px; padding: 10px 20px; font-size: 0.88rem; font-weight: 500; cursor: pointer; transition: background 0.2s; }
        .dash-btn-primary:hover { background: #1c7ed6; }
        .dash-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .dash-btn-cancel { background: #f1f3f5; color: #495057; border: none; border-radius: 8px; padding: 10px 20px; font-size: 0.88rem; cursor: pointer; }

        .dash-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        .dash-table th { text-align: left; padding: 10px 12px; background: #f8f9fa; font-weight: 600; color: #495057; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.3px; border-bottom: 2px solid #e9ecef; }
        .dash-table td { padding: 10px 12px; border-bottom: 1px solid #f1f3f5; }
        .dash-table tr:hover { background: #f8f9fa; }
      `}</style>
    </div>
  );
}

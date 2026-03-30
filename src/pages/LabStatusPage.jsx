/**
 * RICT CMMS — Lab Status Page  (PUBLIC / no auth required)
 *
 * Optimized for 1280 × 720 LANDSCAPE touch-screen kiosk.
 *
 * Left column  — Unified people list: Here, Expected, Missing, Walk-in, Work Study
 *                (auto-scrolling ticker when list exceeds visible area)
 * Right column — Active help requests (touch-to-acknowledge / touch-to-resolve)
 *
 * Touch interactions (right column):
 *   1st tap on a pending card     → Acknowledges the request (on my way)
 *   2nd tap on acknowledged card  → Resolves / clears the request
 *
 * Audio alarm
 *   • Plays a repeating alert tone every 60 s while ANY request is 'pending'
 *   • Stops automatically once all pending requests are cleared
 *
 * Sound unlock overlay
 *   • Instructor selects their name to unlock audio AND identify themselves
 *   • When acknowledging a help request, the selected instructor's name is
 *     written to acknowledged_by so all kiosks + TV Display show who is responding
 *
 * Weather
 *   • Open-Meteo API (free, no key) — St. Cloud, MN — refreshes every 10 min
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

const SCROLL_THRESHOLD = 6;

// ─── Weather helpers ────────────────────────────────────────────────────────

const WEATHER_EMOJI = {
  0:'☀️', 1:'🌤️', 2:'⛅', 3:'☁️', 45:'🌫️', 48:'🌫️',
  51:'🌦️', 53:'🌦️', 55:'🌦️', 56:'🌦️', 57:'🌦️',
  61:'🌧️', 63:'🌧️', 65:'🌧️', 66:'🌧️', 67:'🌧️',
  71:'🌨️', 73:'🌨️', 75:'🌨️', 77:'🌨️',
  80:'🌧️', 81:'🌧️', 82:'🌧️', 85:'🌨️', 86:'🌨️',
  95:'⛈️', 96:'⛈️', 99:'⛈️',
};
const WEATHER_DESC = {
  0:'Clear sky', 1:'Mainly clear', 2:'Partly cloudy', 3:'Overcast',
  45:'Foggy', 48:'Rime fog',
  51:'Light drizzle', 53:'Drizzle', 55:'Dense drizzle',
  56:'Freezing drizzle', 57:'Freezing drizzle',
  61:'Light rain', 63:'Rain', 65:'Heavy rain',
  66:'Freezing rain', 67:'Freezing rain',
  71:'Light snow', 73:'Snow', 75:'Heavy snow', 77:'Snow grains',
  80:'Light showers', 81:'Showers', 82:'Heavy showers',
  85:'Snow showers', 86:'Heavy snow showers',
  95:'Thunderstorm', 96:'Thunderstorm + hail', 99:'Thunderstorm + hail',
};

// ─── Status config ─────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  missing:   { label: 'Missing',    color: '#ef4444', bg: '#450a0a', border: '#7f1d1d', icon: 'warning',         avatarBg: 'linear-gradient(135deg, #450a0a, #7f1d1d)' },
  expected:  { label: 'Expected',   color: '#fbbf24', bg: '#2d1f0a', border: '#451a03', icon: 'schedule',        avatarBg: 'linear-gradient(135deg, #451a03, #92400e)' },
  good:      { label: 'Here',       color: '#4ade80', bg: '#0d2d1a', border: '#1a4d2e', icon: 'check_circle',    avatarBg: 'linear-gradient(135deg, #1a4d2e, #0d6e35)' },
  walkin:    { label: 'Walk-in',    color: '#f97316', bg: '#2d1f0a', border: '#7c2d12', icon: 'directions_walk', avatarBg: 'linear-gradient(135deg, #7c2d12, #c2410c)' },
  workstudy: { label: 'Work Study', color: '#74c0fc', bg: '#0d1f3a', border: '#1a3a5c', icon: 'work',           avatarBg: 'linear-gradient(135deg, #1a3a5c, #1565a8)' },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function toLocalDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatTimestamp12(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  let h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12; else if (h > 12) h -= 12;
  return `${h}:${m} ${ampm}`;
}

function formatLocalTime(d) {
  if (!d) return '';
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12; else if (h > 12) h -= 12;
  return `${h}:${m} ${ampm}`;
}

function minutesAgo(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const localEquiv = new Date(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()
  );
  const diff = Math.floor((Date.now() - localEquiv.getTime()) / 60000);
  if (diff < 1) return 'just now';
  if (diff === 1) return '1 min ago';
  if (diff < 60) return `${diff} min ago`;
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

function firstLastInit(name) {
  if (!name) return '';
  const parts = name.trim().split(' ');
  let out = parts[0];
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (last.length > 0) out += ' ' + last.charAt(0) + '.';
  }
  return out;
}

// ─── Audio ──────────────────────────────────────────────────────────────────

function useAlarm(hasPending, audioUnlocked) {
  const audioCtxRef = useRef(null);
  const intervalRef = useRef(null);

  const unlockAudio = useCallback(() => {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      else if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    } catch (e) { console.warn('[LabStatus] Audio unlock error:', e); }
  }, []);

  useEffect(() => {
    const fallback = () => {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      else if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    };
    document.addEventListener('click', fallback);
    document.addEventListener('keydown', fallback);
    return () => { document.removeEventListener('click', fallback); document.removeEventListener('keydown', fallback); };
  }, []);

  useEffect(() => { if (audioUnlocked) unlockAudio(); }, [audioUnlocked, unlockAudio]);

  const playAlarm = useCallback(() => {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const ac = audioCtxRef.current;
      if (ac.state === 'suspended') ac.resume();
      if (ac.state === 'closed') return;
      [{ freq: 880, start: 0, duration: 0.12 }, { freq: 880, start: 0.18, duration: 0.12 }, { freq: 1100, start: 0.36, duration: 0.25 }]
        .forEach(({ freq, start, duration }) => {
          const osc = ac.createOscillator(); const gain = ac.createGain();
          osc.connect(gain); gain.connect(ac.destination);
          osc.type = 'square'; osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.18, ac.currentTime + start);
          gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + start + duration);
          osc.start(ac.currentTime + start); osc.stop(ac.currentTime + start + duration + 0.05);
        });
    } catch (e) { console.warn('[LabStatus] Audio error:', e); }
  }, []);

  useEffect(() => {
    clearInterval(intervalRef.current);
    if (!hasPending || !audioUnlocked) return;
    playAlarm();
    intervalRef.current = setInterval(playAlarm, 60000);
    return () => clearInterval(intervalRef.current);
  }, [hasPending, audioUnlocked, playAlarm]);
}

// ─── Auto-scroll hook ──────────────────────────────────────────────────────
// Uses setInterval at 50ms for reliable scrolling on Raspberry Pi FullPageOS.
function useAutoScroll(containerRef, itemCount, audioUnlocked) {
  useEffect(() => {
    if (!audioUnlocked || itemCount === 0 || itemCount <= SCROLL_THRESHOLD) return;
    const PX_PER_TICK = 1;
    const id = setInterval(() => {
      const el = containerRef.current;
      if (!el) return;
      const half = el.scrollHeight / 2;
      if (half <= el.clientHeight + 1) return;
      el.scrollTop += PX_PER_TICK;
      if (el.scrollTop >= half) el.scrollTop -= half;
    }, 50);
    return () => clearInterval(id);
  }, [itemCount, audioUnlocked]);
}

// ─── Sound Unlock Overlay ───────────────────────────────────────────────────

function SoundUnlockOverlay({ instructors, loadingInstructors, onSelectInstructor }) {
  return (
    <div role="dialog" aria-modal="true" aria-label="Select your name to enable alarm sounds" style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(10, 12, 18, 0.94)', backdropFilter: 'blur(8px)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 28, userSelect: 'none',
    }}>
      <div style={{ width: 88, height: 88, borderRadius: '50%', background: 'linear-gradient(135deg, #1e3a5f, #1971c2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'overlayBellPulse 2s ease-in-out infinite' }}>
        <span className="material-icons" style={{ fontSize: '2.8rem', color: '#74c0fc' }}>notifications_active</span>
      </div>
      <div style={{ textAlign: 'center', padding: '0 60px' }}>
        <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#e9ecef', marginBottom: 8 }}>Select your name to enable alarm sounds</div>
        <div style={{ fontSize: '0.88rem', color: '#6c757d', lineHeight: 1.6 }}>
          This kiosk plays an audible alert when a student requests help. Your name will be shown when you respond to requests.
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 420, padding: '0 40px' }}>
        {loadingInstructors ? (
          <div style={{ textAlign: 'center', color: '#6c757d', fontSize: '0.9rem', padding: 20 }}>
            <span className="material-icons" style={{ fontSize: '1.4rem', marginBottom: 6, display: 'block' }}>hourglass_empty</span>Loading instructors…
          </div>
        ) : instructors.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#6c757d', fontSize: '0.9rem', padding: 20 }}>No instructors found.</div>
        ) : instructors.map(inst => (
          <button key={inst.email} onClick={() => onSelectInstructor(inst)} aria-label={`Sign in as ${inst.displayName}`}
            style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', padding: '16px 24px',
              background: '#1c2333', border: '2px solid #2d3748', borderRadius: 14, cursor: 'pointer',
              transition: 'background 0.15s, border-color 0.15s, transform 0.1s',
              WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}
            onPointerDown={e => { e.currentTarget.style.transform = 'scale(0.97)'; e.currentTarget.style.borderColor = '#228be6'; e.currentTarget.style.background = '#1e3a5f'; }}
            onPointerUp={e => { e.currentTarget.style.transform = 'scale(1)'; }}
            onPointerLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.borderColor = '#2d3748'; e.currentTarget.style.background = '#1c2333'; }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', flexShrink: 0, background: 'linear-gradient(135deg, #228be6, #1971c2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '1.1rem', color: '#fff' }}>{inst.initials}</div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <div style={{ fontWeight: 700, fontSize: '1.15rem', color: '#e9ecef' }}>{inst.displayName}</div>
              <div style={{ fontSize: '0.72rem', color: '#6c757d', marginTop: 2 }}>Tap to sign in to this kiosk</div>
            </div>
            <span className="material-icons" style={{ color: '#4a5568', fontSize: '1.4rem' }}>arrow_forward</span>
          </button>
        ))}
      </div>
      <style>{`@keyframes overlayBellPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(34,139,230,0.4); } 50% { box-shadow: 0 0 0 22px rgba(34,139,230,0); } }`}</style>
    </div>
  );
}

// ─── Person Row — unified display for all statuses ─────────────────────────

function PersonRow({ person }) {
  const cfg = STATUS_CONFIG[person.status] || STATUS_CONFIG.good;
  const initials = (person.userName || '?').split(' ').map(p => p[0] || '').join('').toUpperCase().slice(0, 2);
  const displayName = firstLastInit(person.userName);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px',
      borderBottom: '1px solid #1a2030',
      background: person.status === 'missing' ? 'rgba(127,29,29,0.08)' : 'transparent' }}>
      <div style={{ width: 36, height: 36, borderRadius: '50%', flexShrink: 0, background: cfg.avatarBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 700, fontSize: '0.82rem', color: cfg.color, border: `2px solid ${cfg.border}` }}>{initials}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#e9ecef',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 1, flexWrap: 'wrap' }}>
          {person.courseId && <span style={{ fontSize: '0.68rem', color: '#6c757d' }}>{person.courseId}</span>}
          {person.timeRange && <span style={{ fontSize: '0.65rem', color: '#6c757d' }}>{person.timeRange}</span>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: cfg.bg,
        border: `1px solid ${cfg.border}`, borderRadius: 6, padding: '2px 8px', flexShrink: 0 }}>
        <span className="material-icons" style={{ fontSize: '0.75rem', color: cfg.color }}>{cfg.icon}</span>
        <span style={{ fontSize: '0.65rem', fontWeight: 700, color: cfg.color }}>{cfg.label}</span>
      </div>
      <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: cfg.color, boxShadow: `0 0 5px ${cfg.color}80` }} />
    </div>
  );
}

// ─── Help Request Card ─────────────────────────────────────────────────────

function HelpRequestCard({ req, onAcknowledge, onResolve }) {
  const isPending = req.status === 'pending';
  const isAcknowledged = req.status === 'acknowledged';
  const [pressing, setPressing] = useState(false);
  const initials = (req.user_name || '?').split(' ').map(p => p[0] || '').join('').toUpperCase().slice(0, 2);
  const handlePress = () => { if (isPending) onAcknowledge(req.request_id); else if (isAcknowledged) onResolve(req.request_id); };

  return (
    <div style={{ margin: '8px 10px', borderRadius: 12, border: `2px solid ${isPending ? '#b91c1c' : '#166534'}`,
      background: isPending ? 'rgba(127,29,29,0.18)' : 'rgba(13,45,26,0.35)',
      animation: isPending ? 'cardPendingPulse 2s ease-in-out infinite, slideIn 0.3s ease' : 'slideIn 0.3s ease',
      overflow: 'hidden', transition: 'border-color 0.3s, background 0.3s' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px 8px' }}>
        <div style={{ width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
          background: isPending ? 'linear-gradient(135deg, #450a0a, #7f1d1d)' : 'linear-gradient(135deg, #0d2d1a, #1a4d2e)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.9rem',
          color: isPending ? '#fca5a5' : '#4ade80', border: `2px solid ${isPending ? '#7f1d1d' : '#1a4d2e'}` }}>{initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', color: isPending ? '#fca5a5' : '#86efac',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{req.user_name || 'Unknown'}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
            {req.location && (<span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: '0.75rem', color: '#94a3b8' }}>
              <span className="material-icons" style={{ fontSize: '0.8rem', color: '#6c757d' }}>place</span>{req.location}</span>)}
            <span style={{ fontSize: '0.7rem', color: '#4a5568' }}>{minutesAgo(req.requested_at)}</span>
          </div>
          {isAcknowledged && req.acknowledged_by && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4,
              background: '#0d2d1a', border: '1px solid #1a4d2e', borderRadius: 5, padding: '2px 8px' }}>
              <span className="material-icons" style={{ fontSize: '0.8rem', color: '#4ade80' }}>directions_walk</span>
              <span style={{ fontSize: '0.7rem', color: '#86efac', fontWeight: 600 }}>{req.acknowledged_by} is on the way</span>
            </div>
          )}
        </div>
        <div style={{ flexShrink: 0 }}>
          {isPending ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#7f1d1d', color: '#fca5a5',
              padding: '4px 9px', borderRadius: 7, fontSize: '0.68rem', fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.5px', animation: 'pulseAlert 1.4s ease-in-out infinite' }}>
              <span className="material-icons" style={{ fontSize: '0.8rem' }}>pending</span>Waiting</span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#0d2d1a', color: '#4ade80',
              padding: '4px 9px', borderRadius: 7, fontSize: '0.68rem', fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.5px', border: '1px solid #1a4d2e' }}>
              <span className="material-icons" style={{ fontSize: '0.8rem' }}>check</span>On Way</span>
          )}
        </div>
      </div>
      <button onPointerDown={() => setPressing(true)} onPointerUp={() => setPressing(false)}
        onPointerLeave={() => setPressing(false)} onClick={handlePress}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          width: '100%', padding: '13px 16px', border: 'none',
          borderTop: `1px solid ${isPending ? '#7f1d1d' : '#1a4d2e'}`, borderRadius: '0 0 10px 10px',
          background: pressing ? (isPending ? 'rgba(239,68,68,0.45)' : 'rgba(74,222,128,0.25)') : (isPending ? 'rgba(239,68,68,0.18)' : 'rgba(74,222,128,0.10)'),
          cursor: 'pointer', transition: 'background 0.1s', WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation', userSelect: 'none' }}>
        <span className="material-icons" style={{ fontSize: '1.2rem', color: isPending ? '#f87171' : '#4ade80' }}>{isPending ? 'directions_walk' : 'task_alt'}</span>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: isPending ? '#fca5a5' : '#86efac', textTransform: 'uppercase', letterSpacing: '1px' }}>
          {isPending ? "I'm On My Way" : 'Mark Resolved'}</span>
      </button>
    </div>
  );
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function CenterMsg({ icon, text, color = '#4a5568' }) {
  return (<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10 }}>
    <span className="material-icons" style={{ fontSize: '2.2rem', color }}>{icon}</span>
    <p style={{ margin: 0, fontSize: '0.85rem', color, textAlign: 'center' }}>{text}</p>
  </div>);
}

function MaterialIconsLoader() {
  useEffect(() => {
    if (!document.querySelector('link[href*="Material+Icons"]')) {
      const link = document.createElement('link'); link.href = 'https://fonts.googleapis.com/icon?family=Material+Icons'; link.rel = 'stylesheet'; document.head.appendChild(link);
    }
  }, []);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
export default function LabStatusPage() {
  const [peopleList, setPeopleList]     = useState([]);
  const [helpRequests, setHelpRequests] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [lastUpdated, setLastUpdated]   = useState(null);

  const [audioUnlocked, setAudioUnlocked]           = useState(false);
  const [selectedInstructor, setSelectedInstructor]  = useState(null);
  const [instructors, setInstructors]                = useState([]);
  const [loadingInstructors, setLoadingInstructors]  = useState(true);

  const hasPending = helpRequests.some(r => r.status === 'pending');
  useAlarm(hasPending, audioUnlocked);

  // ── Fetch instructor list ──
  useEffect(() => {
    async function loadInstructors() {
      try {
        const { data } = await supabase.from('profiles').select('email, first_name, last_name, role')
          .eq('role', 'Instructor').eq('status', 'Active').neq('email', 'rictprogram@gmail.com')
          .order('first_name', { ascending: true });
        setInstructors((data || []).map(p => {
          const first = (p.first_name || '').trim(); const last = (p.last_name || '').trim();
          return { email: p.email, displayName: `${first} ${last}`.trim() || p.email, initials: (first.charAt(0) + last.charAt(0)).toUpperCase() || '?' };
        }));
      } catch (err) { console.error('[LabStatus] Error loading instructors:', err); }
      setLoadingInstructors(false);
    }
    loadInstructors();
  }, []);

  const handleSelectInstructor = useCallback((inst) => { setSelectedInstructor(inst); setAudioUnlocked(true); }, []);

  // ── Auto-scroll ──
  const namesScrollRef = useRef(null);
  useAutoScroll(namesScrollRef, peopleList.length, audioUnlocked);

  // ── Weather ──
  const [weather, setWeather] = useState({ temp: '—', icon: '🌡️', desc: 'Loading…' });
  const fetchWeather = useCallback(async () => {
    try {
      const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=45.5579&longitude=-94.1632&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America%2FChicago');
      const data = await res.json();
      if (data?.current) setWeather({ temp: Math.round(data.current.temperature_2m) + '°F', icon: WEATHER_EMOJI[data.current.weather_code] ?? '🌡️', desc: WEATHER_DESC[data.current.weather_code] ?? '' });
    } catch (e) { console.warn('[LabStatus] Weather fetch error:', e); }
  }, []);
  useEffect(() => { fetchWeather(); const id = setInterval(fetchWeather, 600_000); return () => clearInterval(id); }, [fetchWeather]);

  // ── Instructor Away Mode ──
  const [instructorAway, setInstructorAway] = useState(false);
  const [awayReturnTime, setAwayReturnTime] = useState('');
  const [awayToggling, setAwayToggling] = useState(false);

  const fetchAwayMode = useCallback(async () => {
    try {
      const { data } = await supabase.from('settings').select('setting_key, setting_value').in('setting_key', ['instructor_away_mode', 'instructor_return_time']);
      const modeRow = (data || []).find(r => r.setting_key === 'instructor_away_mode');
      const timeRow = (data || []).find(r => r.setting_key === 'instructor_return_time');
      setInstructorAway(modeRow?.setting_value === 'true'); setAwayReturnTime(timeRow?.setting_value || '');
    } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { fetchAwayMode(); }, [fetchAwayMode]);

  useEffect(() => {
    const channel = supabase.channel('lab-status-away-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings', filter: 'setting_key=eq.instructor_away_mode' }, p => setInstructorAway(p.new?.setting_value === 'true'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings', filter: 'setting_key=eq.instructor_return_time' }, p => setAwayReturnTime(p.new?.setting_value || ''))
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  const toggleAwayOff = useCallback(async () => {
    setAwayToggling(true);
    try { const { error } = await supabase.rpc('toggle_instructor_away_off'); if (error) throw error; setInstructorAway(false); setAwayReturnTime(''); }
    catch (err) { console.error('[LabStatus] Toggle away off error:', err); }
    setAwayToggling(false);
  }, []);

  // ── Data Fetching — unified people list ──────────────────────────────────

  const fetchData = useCallback(async () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const now = new Date();
    const todayStr = toLocalDateStr(today);

    try {
      const [{ data: clockData }, { data: helpData }, { data: profilesData }, { data: signupData }] = await Promise.all([
        supabase.from('time_clock').select('record_id, user_name, user_email, punch_in, course_id, entry_type')
          .eq('status', 'Punched In').gte('punch_in', todayStr + 'T00:00:00').lte('punch_in', todayStr + 'T23:59:59')
          .order('punch_in', { ascending: true }),
        supabase.from('help_requests').select('request_id, user_name, location, requested_at, status, acknowledged_at, acknowledged_by')
          .in('status', ['pending', 'acknowledged']).order('requested_at', { ascending: true }),
        supabase.from('profiles').select('email, time_clock_only').eq('time_clock_only', 'Yes'),
        supabase.from('lab_signup').select('user_name, user_email, start_time, end_time, status')
          .eq('date', todayStr).neq('status', 'Cancelled'),
      ]);

      // TCO emails
      const tcoEmails = new Set();
      (profilesData || []).forEach(p => { if (p.email) tcoEmails.add(p.email.toLowerCase()); });

      // Punched-in map
      const loggedIn = {};
      const seen = new Set();
      for (const row of (clockData || [])) {
        const email = (row.user_email || '').toLowerCase();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        if (tcoEmails.has(email)) { row.entry_type = 'Work Study'; row.course_id = 'Work Study'; }
        loggedIn[email] = { userName: row.user_name, courseId: row.course_id, entryType: row.entry_type, punchIn: row.punch_in };
      }

      // Signup map with merged sessions
      const signedUp = {};
      for (const row of (signupData || [])) {
        const email = (row.user_email || '').toLowerCase();
        if (!email || tcoEmails.has(email)) continue;
        if (!signedUp[email]) signedUp[email] = { userName: row.user_name, timeBlocks: [] };
        const parseTime = t => { if (!t) return null; const [hh, mm] = String(t).split(':'); const d = new Date(today); d.setHours(parseInt(hh, 10), parseInt(mm || 0, 10), 0, 0); return d; };
        const start = parseTime(row.start_time); const end = parseTime(row.end_time);
        if (start && end) signedUp[email].timeBlocks.push({ start, end });
      }
      for (const email in signedUp) {
        const s = signedUp[email]; s.timeBlocks.sort((a, b) => a.start - b.start);
        const sessions = []; let cur = null;
        for (const b of s.timeBlocks) {
          if (!cur) cur = { start: b.start, end: b.end };
          else if (b.start.getTime() === cur.end.getTime()) cur.end = b.end;
          else { sessions.push(cur); cur = { start: b.start, end: b.end }; }
        }
        if (cur) sessions.push(cur); s.sessions = sessions;
      }

      // Merge
      const allPeople = {};
      for (const email in loggedIn) {
        const li = loggedIn[email];
        allPeople[email] = { userName: li.userName, courseId: li.courseId, entryType: li.entryType, punchIn: li.punchIn, isLoggedIn: true, isSignedUp: false, sessions: [] };
      }
      for (const email in signedUp) {
        const su = signedUp[email];
        if (allPeople[email]) { allPeople[email].isSignedUp = true; allPeople[email].sessions = su.sessions; }
        else allPeople[email] = { userName: su.userName, courseId: '', entryType: '', punchIn: null, isLoggedIn: false, isSignedUp: true, sessions: su.sessions };
      }

      // Assign statuses
      const finalList = [];
      for (const email in allPeople) {
        const p = allPeople[email];
        let status = '', timeRange = '';
        let curSession = null, nextSession = null;
        for (const sess of p.sessions) {
          if (sess.start <= now && sess.end > now) curSession = sess;
          else if (sess.start > now && !nextSession) nextSession = sess;
        }
        const isWorkStudy = p.entryType === 'Work Study' || p.entryType === 'work_study';

        if (p.isLoggedIn) {
          if (isWorkStudy) { status = 'workstudy'; }
          else if (p.isSignedUp) { status = 'good'; if (curSession) timeRange = 'Until ' + formatLocalTime(curSession.end); }
          else { status = 'walkin'; }
        } else if (p.isSignedUp) {
          if (curSession) { status = 'missing'; timeRange = formatLocalTime(curSession.start) + ' – ' + formatLocalTime(curSession.end); }
          else if (nextSession) { status = 'expected'; timeRange = formatLocalTime(nextSession.start) + ' – ' + formatLocalTime(nextSession.end); }
        }
        if (!status) continue;
        finalList.push({ email, userName: p.userName, courseId: p.courseId, status, timeRange, punchIn: p.punchIn,
          earliestStart: p.sessions.length > 0 ? p.sessions[0].start.getTime() : null });
      }

      finalList.sort((a, b) => {
        const aTime = a.earliestStart ?? (a.punchIn ? new Date(a.punchIn).getTime() : Infinity);
        const bTime = b.earliestStart ?? (b.punchIn ? new Date(b.punchIn).getTime() : Infinity);
        return aTime - bTime;
      });

      setPeopleList(finalList);
      setHelpRequests(helpData || []);
      setLastUpdated(new Date());
    } catch (err) { console.error('[LabStatus] Fetch error:', err); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); const poll = setInterval(fetchData, 30000); return () => clearInterval(poll); }, [fetchData]);

  useEffect(() => {
    const channel = supabase.channel('lab-status-rt-' + Date.now())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_clock' }, fetchData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'help_requests' }, fetchData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_signup' }, fetchData)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [fetchData]);

  // ── Touch interactions ──
  const acknowledgeRequest = useCallback(async (requestId) => {
    const responderName = selectedInstructor?.displayName || 'Instructor';
    try {
      await supabase.from('help_requests').update({ status: 'acknowledged', acknowledged_by: responderName, acknowledged_at: new Date().toISOString() }).eq('request_id', requestId).select();
      await fetchData();
    } catch (err) { console.error('[LabStatus] Acknowledge error:', err); }
  }, [fetchData, selectedInstructor]);

  const resolveRequest = useCallback(async (requestId) => {
    try {
      await supabase.from('help_requests').update({ status: 'resolved' }).eq('request_id', requestId).select();
      await fetchData();
    } catch (err) { console.error('[LabStatus] Resolve error:', err); }
  }, [fetchData]);

  // ── Clock ──
  const [clockTime, setClockTime] = useState('');
  useEffect(() => {
    const tick = () => { const now = new Date(); let h = now.getHours(); const m = String(now.getMinutes()).padStart(2, '0'); const ampm = h >= 12 ? 'PM' : 'AM'; if (h === 0) h = 12; else if (h > 12) h -= 12; setClockTime(`${h}:${m} ${ampm}`); };
    tick(); const t = setInterval(tick, 10000); return () => clearInterval(t);
  }, []);

  // ── Midnight auto-reload ──
  useEffect(() => {
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5).getTime() - now.getTime();
    const tid = setTimeout(() => window.location.reload(), ms);
    return () => clearTimeout(tid);
  }, []);

  const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const hereCount = peopleList.filter(p => p.status === 'good' || p.status === 'workstudy' || p.status === 'walkin').length;
  const expectedCount = peopleList.filter(p => p.status === 'expected').length;
  const missingCount = peopleList.filter(p => p.status === 'missing').length;

  // ════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0f1117', color: '#f0f4f8',
      fontFamily: "'Inter', system-ui, sans-serif", display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {!audioUnlocked && <SoundUnlockOverlay instructors={instructors} loadingInstructors={loadingInstructors} onSelectInstructor={handleSelectInstructor} />}

      {/* ══ HEADER 58px ══ */}
      <header style={{ display: 'flex', alignItems: 'center', padding: '0 20px', borderBottom: '1px solid #1e2433', background: '#141824', flexShrink: 0, height: 58, gap: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: 'linear-gradient(135deg, #228be6, #1971c2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="material-icons" style={{ color: 'white', fontSize: '1.1rem' }}>precision_manufacturing</span>
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#e9ecef', letterSpacing: '0.3px', lineHeight: 1.2 }}>RICT Lab Status</div>
            <div style={{ fontSize: '0.62rem', color: '#6c757d' }}>Live · updates automatically</div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#1c2333', border: '1px solid #2d3748', borderRadius: 10, padding: '6px 16px', flexShrink: 0 }}>
          <span style={{ fontSize: '1.5rem', lineHeight: 1 }}>{weather.icon}</span>
          <div>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#e9ecef', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{weather.temp}</div>
            <div style={{ fontSize: '0.62rem', color: '#6c757d' }}>{weather.desc} · St. Cloud, MN</div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {hasPending ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: '#3b0a0a', border: '1px solid #7f1d1d', borderRadius: 8, padding: '6px 14px', flexShrink: 0, marginRight: 20, animation: 'pulseAlert 1.4s ease-in-out infinite' }}>
            <span className="material-icons" style={{ color: '#f87171', fontSize: '1.1rem' }}>notification_important</span>
            <span style={{ color: '#fca5a5', fontWeight: 700, fontSize: '0.8rem', letterSpacing: '0.5px', textTransform: 'uppercase' }}>Help Requested</span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, opacity: 0.4, marginRight: 20, flexShrink: 0 }}>
            <span className="material-icons" style={{ fontSize: '0.95rem', color: audioUnlocked ? '#4ade80' : '#6c757d' }}>{audioUnlocked ? 'volume_up' : 'volume_off'}</span>
            <span style={{ fontSize: '0.68rem', color: '#6c757d' }}>{audioUnlocked ? 'Audio on' : 'Audio off'}</span>
          </div>
        )}
        {instructorAway && (
          <button onClick={toggleAwayOff} disabled={awayToggling} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#dc2626', border: '2px solid #ef4444', borderRadius: 10, padding: '8px 18px', flexShrink: 0, marginRight: 12, cursor: awayToggling ? 'wait' : 'pointer', animation: 'awayPulse 1.6s ease-in-out infinite', WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation', userSelect: 'none' }}>
            <span className="material-icons" style={{ color: 'white', fontSize: '1.2rem' }}>{awayToggling ? 'hourglass_empty' : 'meeting_room'}</span>
            <div style={{ textAlign: 'left' }}>
              <div style={{ color: 'white', fontWeight: 800, fontSize: '0.82rem', letterSpacing: '0.5px', textTransform: 'uppercase', lineHeight: 1.1 }}>AWAY</div>
              <div style={{ color: '#fecaca', fontSize: '0.58rem', fontWeight: 600, lineHeight: 1.2 }}>{awayReturnTime ? `Back at ${awayReturnTime}` : 'Tap to return'}</div>
            </div>
            <span className="material-icons" style={{ color: '#fecaca', fontSize: '0.9rem', marginLeft: 2 }}>close</span>
          </button>
        )}
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#e9ecef', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{clockTime}</div>
          <div style={{ fontSize: '0.62rem', color: '#6c757d' }}>{dateLabel}</div>
        </div>
      </header>

      {/* ══ MAIN ══ */}
      <main style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', overflow: 'hidden', minHeight: 0 }}>

        {/* LEFT: Unified People List */}
        <section style={{ borderRight: '1px solid #1e2433', display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', height: 44, borderBottom: '1px solid #1e2433', background: '#141824', flexShrink: 0 }}>
            <div style={{ width: 28, height: 28, borderRadius: 6, background: '#0d2d1a', border: '1px solid #1a4d2e', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="material-icons" style={{ color: '#4ade80', fontSize: '0.95rem' }}>groups</span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#e9ecef', lineHeight: 1.2 }}>Lab Today</div>
              <div style={{ fontSize: '0.62rem', color: '#6c757d' }}>
                {loading ? 'Loading…' : (
                  <span>
                    <span style={{ color: '#4ade80' }}>{hereCount} here</span>
                    {expectedCount > 0 && <span> · <span style={{ color: '#fbbf24' }}>{expectedCount} expected</span></span>}
                    {missingCount > 0 && <span> · <span style={{ color: '#ef4444' }}>{missingCount} missing</span></span>}
                  </span>
                )}
              </div>
            </div>
            <div style={{ background: '#0d2d1a', border: '1px solid #1a4d2e', borderRadius: 14, padding: '2px 12px', fontSize: '1rem', fontWeight: 700, color: '#4ade80', fontVariantNumeric: 'tabular-nums' }}>{peopleList.length}</div>
          </div>
          <div ref={namesScrollRef} style={{ height: 'calc(100vh - 132px)', overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            {loading ? <CenterMsg icon="hourglass_empty" text="Loading…" />
             : peopleList.length === 0 ? <CenterMsg icon="person_off" text="No one in lab or expected today" />
             : (<>
                {peopleList.map((person, idx) => <PersonRow key={'a-' + (person.email || idx)} person={person} />)}
                {peopleList.length > SCROLL_THRESHOLD && peopleList.map((person, idx) => <PersonRow key={'b-' + (person.email || idx)} person={person} />)}
              </>)}
          </div>
        </section>

        {/* RIGHT: Help Requests */}
        <section style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, background: hasPending ? 'rgba(127,29,29,0.06)' : 'transparent' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', height: 44, borderBottom: '1px solid #1e2433', background: hasPending ? 'rgba(127,29,29,0.28)' : '#141824', flexShrink: 0 }}>
            <div style={{ width: 28, height: 28, borderRadius: 6, background: hasPending ? '#3b0a0a' : '#1e2433', border: `1px solid ${hasPending ? '#7f1d1d' : '#2d3748'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="material-icons" style={{ color: hasPending ? '#f87171' : '#6c757d', fontSize: '0.95rem' }}>help_outline</span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#e9ecef', lineHeight: 1.2 }}>Help Requests</div>
              <div style={{ fontSize: '0.62rem', color: hasPending ? '#fca5a5' : '#6c757d' }}>
                {loading ? 'Loading…' : hasPending ? `${helpRequests.filter(r => r.status === 'pending').length} waiting for instructor` : helpRequests.length === 0 ? 'No active requests' : 'All acknowledged'}
              </div>
            </div>
            {helpRequests.length > 0 && (
              <div style={{ background: hasPending ? '#7f1d1d' : '#1a4d2e', border: `1px solid ${hasPending ? '#b91c1c' : '#1a4d2e'}`, borderRadius: 14, padding: '2px 12px', fontSize: '1rem', fontWeight: 700, color: hasPending ? '#fca5a5' : '#4ade80', fontVariantNumeric: 'tabular-nums' }}>{helpRequests.length}</div>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '2px 0', minHeight: 0 }}>
            {loading ? <CenterMsg icon="hourglass_empty" text="Loading…" />
             : helpRequests.length === 0 ? <CenterMsg icon="check_circle_outline" text="No help requests" color="#4ade80" />
             : helpRequests.map(req => <HelpRequestCard key={req.request_id} req={req} onAcknowledge={acknowledgeRequest} onResolve={resolveRequest} />)}
          </div>
          {hasPending && (
            <div style={{ padding: '6px 12px', background: 'rgba(127,29,29,0.18)', borderTop: '1px solid #3b0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexShrink: 0 }}>
              <span className="material-icons" style={{ fontSize: '0.8rem', color: '#f87171' }}>touch_app</span>
              <span style={{ fontSize: '0.62rem', color: '#fca5a5', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Tap a card to respond</span>
            </div>
          )}
        </section>
      </main>

      {/* ══ FOOTER ══ */}
      <footer style={{ height: 30, padding: '0 20px', background: '#141824', borderTop: '1px solid #1e2433', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <span style={{ fontSize: '0.6rem', color: '#2d3748' }}>RICT CMMS · rict-cmms.vercel.app</span>
        {selectedInstructor ? (
          <span style={{ fontSize: '0.6rem', color: '#228be6', fontWeight: 600 }}>Signed in: {selectedInstructor.displayName}</span>
        ) : (
          <span style={{ fontSize: '0.6rem', color: '#2d3748' }}>{lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : ''}</span>
        )}
        <span style={{ fontSize: '0.6rem', color: '#2d3748' }}>Auto-refreshes every 30 s</span>
      </footer>

      <MaterialIconsLoader />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        div::-webkit-scrollbar { width: 0; }
        div::-webkit-scrollbar-track { background: transparent; }
        div::-webkit-scrollbar-thumb { background: #2d3748; border-radius: 2px; }
        @keyframes pulseAlert { 0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(239,68,68,0); } 50% { opacity: 0.85; box-shadow: 0 0 0 5px rgba(239,68,68,0.15); } }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes cardPendingPulse { 0%, 100% { border-color: #b91c1c; background: rgba(127,29,29,0.18); } 50% { border-color: #ef4444; background: rgba(127,29,29,0.30); } }
        @keyframes awayPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.5); } 50% { box-shadow: 0 0 0 8px rgba(220,38,38,0); } }
      `}</style>
    </div>
  );
}

/**
 * RICT CMMS — Suggestion Box submit animations
 *
 * A short, random, silly send-off for a suggestion after it is SAVED (this
 * component never runs before the database confirms the submit). 15
 * animations, every one under 3 seconds, drawn with CSS + inline SVG — no
 * images to download, no new packages.
 *
 *   explode · shred · burn · throw (sparkle) · trex · veto · robot arm ·
 *   conveyor · pneumatic tube · paper airplane · wastebasket · rocket ·
 *   black hole · pixel dissolve · origami crane
 *
 * pickAnimation() never repeats the previous pick (remembered per browser).
 *
 * Accessibility (WCAG 2.1 AA / Section 508)
 *   • No flashing: the only bright effects fade in and out once (2.3.1).
 *   • prefers-reduced-motion, or the page's "Skip animations" setting, gets
 *     the 'gentle' variant: a quick fade and a check mark.
 *   • Under 3 s and skippable: a real "Skip animation" button (focused on
 *     open, 44px), Escape, or a click on the backdrop (2.2.2 not triggered).
 *   • The drawing itself is aria-hidden; the PAGE announces the caption plus
 *     "Suggestion received." in its live region, so screen-reader users get
 *     the joke and the confirmation without the visuals.
 *
 * The stage is a fixed 400 × 300 px box (same as every SVG viewBox here) and
 * is scaled to fit the screen, so px positions line up across CSS and SVG.
 *
 * File: src/components/suggestionBox/SubmitAnimation.jsx
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import '@/styles/suggestion-box.css'

// ─── Registry ────────────────────────────────────────────────────────────────

export const ANIMATIONS = {
  explode:   { ms: 2500, receivedAt: 1700, caption: 'Kaboom! Your suggestion blew up — in a good way.' },
  shred:     { ms: 2700, receivedAt: 1900, caption: 'Your suggestion went through the Shred-O-Matic. (We kept a copy.)' },
  burn:      { ms: 2700, receivedAt: 1900, caption: 'Your suggestion went up in flames — the Club still got it.' },
  throw:     { ms: 2500, receivedAt: 1800, caption: 'Your suggestion was thrown way off into the distance. Sparkle!' },
  trex:      { ms: 2900, receivedAt: 2100, caption: 'A T-rex ate your suggestion. Delicious — and received.' },
  veto:      { ms: 2700, receivedAt: 1300, caption: 'VETO! (Just kidding — your suggestion was received.)' },
  robot:     { ms: 2900, receivedAt: 2200, caption: 'The robot arm picked up your suggestion and filed it.' },
  conveyor:  { ms: 2800, receivedAt: 2200, caption: 'Your suggestion was processed by the RICT-O-TRON 3000.' },
  tube:      { ms: 2500, receivedAt: 1700, caption: 'Whoosh! Your suggestion took the pneumatic tube to the Club.' },
  airplane:  { ms: 2800, receivedAt: 2000, caption: 'Your suggestion folded into a paper airplane and flew away.' },
  basket:    { ms: 2500, receivedAt: 1900, caption: 'Nothing but net! Your suggestion landed in the box.' },
  rocket:    { ms: 2900, receivedAt: 2200, caption: 'Three, two, one… your suggestion launched into orbit.' },
  blackhole: { ms: 2800, receivedAt: 2000, caption: 'Your suggestion fell into a black hole. It is safe on the other side.' },
  pixels:    { ms: 2600, receivedAt: 1900, caption: 'Your suggestion dissolved into pixels and beamed to the Club.' },
  crane:     { ms: 2900, receivedAt: 2100, caption: 'Your suggestion folded into a paper crane and flew to the Club.' },
}

export const GENTLE = { ms: 1000, receivedAt: 400, caption: 'Your suggestion was sent.' }

const LAST_KEY = 'rict-cmms.suggestion-box.last-animation'

/** Random animation key, never the same as last time on this browser. */
export function pickAnimation() {
  const keys = Object.keys(ANIMATIONS)
  let last = null
  try { last = localStorage.getItem(LAST_KEY) } catch { /* storage unavailable */ }
  const pool = keys.filter(k => k !== last)
  const pick = pool[Math.floor(Math.random() * pool.length)]
  try { localStorage.setItem(LAST_KEY, pick) } catch { /* ignore */ }
  return pick
}

export function captionFor(kind) {
  return (ANIMATIONS[kind] || GENTLE).caption
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

const rand = (a, b) => a + Math.random() * (b - a)

/** The sticky note as students saw it — category + their text. */
function NoteFace({ note }) {
  return (
    <div className="sbx-card">
      <span className="sbx-card-cat">{note.category}</span>
      <p className="sbx-card-text">{note.body}</p>
    </div>
  )
}

/** Card at the centre of the stage; `cls` adds the animation. */
function Card({ note, cls = '', style }) {
  return (
    <div className={`sbx-cardwrap ${cls}`} style={style}>
      <NoteFace note={note} />
    </div>
  )
}

/** Small note used inside the SVG scenes, centred on (0,0). */
function MiniNote({ w = 34, h = 24 }) {
  return (
    <g>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx="2" fill="#fff3bf" stroke="#e0b93a" strokeWidth="1" />
      <line x1={-w / 2 + 5} y1={-h / 2 + 7} x2={w / 2 - 5} y2={-h / 2 + 7} stroke="#b08900" strokeWidth="1.2" />
      <line x1={-w / 2 + 5} y1={-h / 2 + 12} x2={w / 2 - 8} y2={-h / 2 + 12} stroke="#b08900" strokeWidth="1.2" />
      <line x1={-w / 2 + 5} y1={-h / 2 + 17} x2={w / 2 - 12} y2={-h / 2 + 17} stroke="#b08900" strokeWidth="1.2" />
    </g>
  )
}


// ─── Scenes ──────────────────────────────────────────────────────────────────

function Explode({ note }) {
  const frags = useMemo(() => Array.from({ length: 22 }, (_, i) => {
    const ang = (i / 22) * Math.PI * 2 + rand(-0.2, 0.2)
    const dist = rand(120, 230)
    return {
      dx: `${Math.cos(ang) * dist}px`, dy: `${Math.sin(ang) * dist}px`, r: `${rand(-540, 540)}deg`,
      w: rand(10, 26), h: rand(8, 20), delay: rand(0, 60),
    }
  }), [])
  const puffs = useMemo(() => Array.from({ length: 6 }, () => ({ x: rand(-70, 70), y: rand(-50, 50), s: rand(50, 90), d: rand(0, 200) })), [])
  return (
    <>
      <Card note={note} cls="sbx-explode-card" />
      <div className="sbx-burst" />
      {puffs.map((p, i) => (
        <div key={i} className="sbx-puff" style={{ left: 200 + p.x, top: 150 + p.y, width: p.s, height: p.s, animationDelay: `${700 + p.d}ms` }} />
      ))}
      {frags.map((f, i) => (
        <div key={i} className="sbx-frag" style={{ '--dx': f.dx, '--dy': f.dy, '--r': f.r, width: f.w, height: f.h, animationDelay: `${580 + f.delay}ms` }} />
      ))}
      <div className="sbx-bang">BOOM!</div>
    </>
  )
}

function Shred({ note }) {
  const strips = useMemo(() => Array.from({ length: 10 }, (_, i) => ({ r: rand(-14, 14), d: rand(0, 160), i })), [])
  return (
    <>
      <div className="sbx-shred-feed">
        <Card note={note} cls="sbx-shred-card" style={{ top: 85 }} />
      </div>
      <div className="sbx-shred-strips">
        {strips.map(s => (
          <div key={s.i} className="sbx-strip" style={{ left: s.i * 20, '--r': `${s.r}deg`, animationDelay: `600ms, ${1850 + s.d}ms` }} />
        ))}
      </div>
      <div className="sbx-shredder" >
        <div className="sbx-shredder-slot" />
        <span>SHRED-O-MATIC</span>
      </div>
    </>
  )
}

function Burn({ note }) {
  const flames = useMemo(() => Array.from({ length: 9 }, (_, i) => ({ x: i * 24 + rand(-4, 4), s: rand(0.7, 1.25), d: rand(0, 250) })), [])
  const embers = useMemo(() => Array.from({ length: 16 }, () => ({ x: rand(0, 200), d: rand(400, 2000), dx: rand(-30, 30) })), [])
  return (
    <>
      <Card note={note} cls="sbx-burn-card" />
      <div className="sbx-burnline">
        <div className="sbx-char" />
        {flames.map((f, i) => (
          <div key={i} className="sbx-flame" style={{ left: f.x, '--s': f.s, animationDelay: `${f.d}ms` }} />
        ))}
      </div>
      {embers.map((e, i) => (
        <div key={i} className="sbx-ember" style={{ left: 100 + e.x, '--dx': `${e.dx}px`, animationDelay: `${e.d}ms` }} />
      ))}
    </>
  )
}

function Throw({ note }) {
  const sparks = useMemo(() => Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2
    return { dx: `${Math.cos(a) * 34}px`, dy: `${Math.sin(a) * 34}px` }
  }), [])
  return (
    <>
      <Card note={note} cls="sbx-throw-card" />
      <svg className="sbx-twinkle" viewBox="-20 -20 40 40" width="40" height="40" aria-hidden="true">
        <path d="M0,-18 L4,-4 L18,0 L4,4 L0,18 L-4,4 L-18,0 L-4,-4 Z" fill="#ffd43b" stroke="#f59f00" strokeWidth="1" />
      </svg>
      {sparks.map((s, i) => <div key={i} className="sbx-spark" style={{ '--dx': s.dx, '--dy': s.dy }} />)}
    </>
  )
}

function TRex({ note }) {
  const crumbs = useMemo(() => Array.from({ length: 7 }, () => ({ x: rand(-14, 14), d: rand(0, 300), r: rand(-180, 180) })), [])
  return (
    <>
      <Card note={note} cls="sbx-trex-card" />
      {crumbs.map((c, i) => (
        <div key={i} className="sbx-crumb" style={{ left: 182 + c.x, '--r': `${c.r}deg`, animationDelay: `${1150 + c.d}ms` }} />
      ))}
      <div className="sbx-chomp">CHOMP!</div>
      <svg className="sbx-trex" viewBox="0 0 200 140" width="220" height="154" aria-hidden="true">
        <g className="sbx-trex-body">
          {/* tail */}
          <path d="M140,62 Q175,48 198,40 Q178,64 146,90 Z" fill="#4c9a49" stroke="#2f6b2d" strokeWidth="2" strokeLinejoin="round" />
          {/* back leg */}
          <g className="sbx-leg sbx-leg-a">
            <path d="M118,88 L126,118 L116,128 L134,128 L136,118 L130,86 Z" fill="#428a40" stroke="#2f6b2d" strokeWidth="2" strokeLinejoin="round" />
          </g>
          {/* body */}
          <ellipse cx="112" cy="74" rx="40" ry="27" fill="#4c9a49" stroke="#2f6b2d" strokeWidth="2" />
          <ellipse cx="104" cy="84" rx="26" ry="13" fill="#a9d99a" />
          {/* front leg */}
          <g className="sbx-leg sbx-leg-b">
            <path d="M96,90 L100,120 L90,128 L108,128 L110,118 L108,88 Z" fill="#4c9a49" stroke="#2f6b2d" strokeWidth="2" strokeLinejoin="round" />
          </g>
          {/* neck */}
          <path d="M78,52 Q88,46 100,52 L96,74 L80,70 Z" fill="#4c9a49" stroke="#2f6b2d" strokeWidth="2" strokeLinejoin="round" />
          {/* tiny arm */}
          <path d="M86,78 Q76,84 72,92 M74,90 L70,94 M76,92 L74,97" stroke="#2f6b2d" strokeWidth="3" fill="none" strokeLinecap="round" />
          {/* lower jaw (opens) */}
          <g className="sbx-jaw">
            <path d="M22,57 L86,57 L86,63 Q58,76 30,68 Q20,64 22,57 Z" fill="#428a40" stroke="#2f6b2d" strokeWidth="2" strokeLinejoin="round" />
            <path d="M30,57 l3,-6 l3,6 M42,57 l3,-6 l3,6 M54,57 l3,-6 l3,6 M66,57 l3,-6 l3,6" fill="#fff" stroke="#adb5bd" strokeWidth="0.8" />
          </g>
          {/* skull + upper jaw */}
          <path d="M18,40 Q28,16 68,18 Q90,20 92,40 L90,56 L20,56 Q12,50 18,40 Z" fill="#4c9a49" stroke="#2f6b2d" strokeWidth="2" strokeLinejoin="round" />
          <path d="M26,56 l3,6 l3,-6 M38,56 l3,6 l3,-6 M50,56 l3,6 l3,-6 M62,56 l3,6 l3,-6" fill="#fff" stroke="#adb5bd" strokeWidth="0.8" />
          <circle cx="64" cy="32" r="6" fill="#fff" stroke="#2f6b2d" strokeWidth="1.5" />
          <circle cx="62" cy="32" r="3" fill="#212529" />
          <path d="M56,24 L72,22" stroke="#2f6b2d" strokeWidth="3" strokeLinecap="round" />
          <circle cx="24" cy="38" r="1.8" fill="#2f6b2d" />
        </g>
      </svg>
    </>
  )
}

function Veto({ note }) {
  const splats = useMemo(() => Array.from({ length: 9 }, () => ({ x: rand(-110, 110), y: rand(-70, 70), s: rand(4, 11) })), [])
  return (
    <>
    <div className="sbx-veto-group">
      <Card note={note} cls="sbx-veto-card" />
      {splats.map((s, i) => (
        <div key={i} className="sbx-splat" style={{ left: 200 + s.x, top: 150 + s.y, width: s.s, height: s.s }} />
      ))}
      <div className="sbx-stamp">VETO</div>
    </div>
    </>
  )
}

function RobotArm({ note }) {
  return (
    <>
      <Card note={note} cls="sbx-shrink-to" style={{ '--tx': '95px', '--ty': '242px' }} />
      <svg className="sbx-svgstage" viewBox="0 0 400 300" aria-hidden="true">
        {/* floor + bin */}
        <line x1="20" y1="296" x2="380" y2="296" stroke="#adb5bd" strokeWidth="2" />
        <g className="sbx-note-static" transform="translate(95,242)"><MiniNote /></g>
        <g className="sbx-note-drop"><g transform="translate(305,242)"><MiniNote /></g></g>
        <path d="M278,252 L332,252 L326,296 L284,296 Z" fill="#495057" stroke="#212529" strokeWidth="2" />
        <text x="305" y="280" textAnchor="middle" fontSize="9" fontWeight="700" fill="#f8f9fa">IDEAS</text>
        {/* base */}
        <rect x="176" y="282" width="48" height="14" rx="3" fill="#343a40" />
        <rect x="188" y="268" width="24" height="16" fill="#495057" />
        {/* arm, drawn pointing right, rotated about the shoulder */}
        <g transform="translate(200,280)">
          <g className="sbx-arm">
            <rect x="0" y="-9" width="62" height="18" rx="8" fill="#f08c00" stroke="#a35f00" strokeWidth="2" />
            <circle cx="62" cy="0" r="11" fill="#495057" stroke="#212529" strokeWidth="2" />
            <rect x="62" y="-7" width="42" height="14" rx="6" fill="#f08c00" stroke="#a35f00" strokeWidth="2" />
            <circle cx="104" cy="0" r="6" fill="#495057" />
            <path d="M106,-8 L116,-10 L118,-4 M106,8 L116,10 L118,4" stroke="#212529" strokeWidth="3" fill="none" strokeLinecap="round" />
            <g className="sbx-note-carried" transform="translate(112,0)"><MiniNote /></g>
          </g>
          <circle cx="0" cy="0" r="14" fill="#495057" stroke="#212529" strokeWidth="2" />
          <circle cx="0" cy="0" r="5" fill="#ced4da" />
        </g>
      </svg>
    </>
  )
}

function Conveyor({ note }) {
  return (
    <>
      <Card note={note} cls="sbx-shrink-to" style={{ '--tx': '60px', '--ty': '212px' }} />
      <svg className="sbx-svgstage" viewBox="0 0 400 300" aria-hidden="true">
        {/* belt */}
        <rect x="20" y="224" width="280" height="16" rx="8" fill="#343a40" />
        <line className="sbx-belt" x1="28" y1="226" x2="292" y2="226" stroke="#868e96" strokeWidth="2" strokeDasharray="10 8" />
        {[40, 80, 120, 160, 200, 240, 280].map(x => (
          <g key={x} transform={`translate(${x},240)`}>
            <circle r="8" fill="#868e96" stroke="#343a40" strokeWidth="2" />
            <g className="sbx-roller"><line x1="-6" y1="0" x2="6" y2="0" stroke="#343a40" strokeWidth="2" /><line x1="0" y1="-6" x2="0" y2="6" stroke="#343a40" strokeWidth="2" /></g>
          </g>
        ))}
        <rect x="140" y="248" width="10" height="44" fill="#495057" /><rect x="40" y="248" width="10" height="44" fill="#495057" />
        {/* note riding the belt */}
        <g className="sbx-belt-note"><g transform="translate(60,212)"><MiniNote /></g></g>
        {/* machine (drawn after the note so the note disappears inside) */}
        <g className="sbx-machine">
          <rect x="262" y="120" width="120" height="172" rx="8" fill="#1971c2" stroke="#0b4f8a" strokeWidth="3" />
          <rect x="262" y="190" width="18" height="46" fill="#0b2e4f" />
          <text x="326" y="142" textAnchor="middle" fontSize="11" fontWeight="800" fill="#fff">RICT-O-TRON</text>
          <text x="326" y="156" textAnchor="middle" fontSize="10" fontWeight="700" fill="#a5d8ff">3000</text>
          <g transform="translate(326,200)">
            <g className="sbx-gear">
              <circle r="20" fill="#adb5bd" stroke="#495057" strokeWidth="3" strokeDasharray="6 4" />
              <circle r="7" fill="#495057" />
            </g>
          </g>
          <circle className="sbx-led" cx="296" cy="262" r="5" fill="#40c057" />
          <circle className="sbx-led sbx-led-2" cx="314" cy="262" r="5" fill="#fab005" />
          <circle className="sbx-led" cx="332" cy="262" r="5" fill="#fa5252" />
        </g>
        <g className="sbx-ding">
          <rect x="250" y="70" width="140" height="34" rx="17" fill="#2f9e44" />
          <text x="320" y="92" textAnchor="middle" fontSize="14" fontWeight="800" fill="#fff">DING! Processed</text>
        </g>
      </svg>
    </>
  )
}

function Tube({ note }) {
  return (
    <>
      <Card note={note} cls="sbx-shrink-to" style={{ '--tx': '300px', '--ty': '215px' }} />
      <svg className="sbx-svgstage" viewBox="0 0 400 300" aria-hidden="true">
        <g className="sbx-capsule-wrap">
          <g className="sbx-capsule" transform="translate(300,215)">
            <rect x="-15" y="-27" width="30" height="54" rx="15" fill="#4dabf7" stroke="#1864ab" strokeWidth="2" />
            <rect x="-15" y="-6" width="30" height="12" fill="#1864ab" />
            <rect x="-9" y="-22" width="18" height="12" rx="2" fill="#fff3bf" />
          </g>
        </g>
        {/* clear tube in front */}
        <rect x="278" y="-20" width="44" height="270" rx="6" fill="rgba(165,216,255,0.25)" stroke="#74c0fc" strokeWidth="3" />
        <path d="M268,250 Q300,236 332,250 L332,262 L268,262 Z" fill="#868e96" stroke="#495057" strokeWidth="2" />
        <g className="sbx-whoosh" stroke="#74c0fc" strokeWidth="3" strokeLinecap="round">
          <line x1="262" y1="120" x2="262" y2="70" /><line x1="338" y1="140" x2="338" y2="80" /><line x1="254" y1="60" x2="254" y2="30" /><line x1="346" y1="70" x2="346" y2="36" />
        </g>
      </svg>
      <div className="sbx-airpuff" style={{ left: 300, top: 252 }} />
    </>
  )
}

function Airplane({ note }) {
  return (
    <>
      <Card note={note} cls="sbx-fold-card" />
      <svg className="sbx-svgstage" viewBox="0 0 400 300" aria-hidden="true">
        <path className="sbx-trail" d="M200,150 C260,200 340,170 320,100 C300,40 230,60 250,110 C270,160 360,90 440,-40" fill="none" stroke="#adb5bd" strokeWidth="2" strokeDasharray="4 6" pathLength="100" />
        <g className="sbx-plane-show" opacity="0">
          <g transform="scale(1.7)">
            <path d="M18,0 L-14,-12 L-6,0 Z" fill="#fff9db" stroke="#b08900" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M18,0 L-14,12 L-6,0 Z" fill="#ffec99" stroke="#b08900" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M18,0 L-6,0 L-10,5 Z" fill="#fcc419" stroke="#b08900" strokeWidth="1" />
          </g>
          <animateMotion dur="2s" begin="0.55s" fill="freeze" rotate="auto" calcMode="spline" keyTimes="0;1" keySplines="0.4 0 0.6 1"
            path="M200,150 C260,200 340,170 320,100 C300,40 230,60 250,110 C270,160 360,90 440,-40" />
          <set attributeName="opacity" to="1" begin="0.5s" fill="freeze" />
        </g>
      </svg>
    </>
  )
}

function Basket({ note }) {
  return (
    <>
      <Card note={note} cls="sbx-crumple-card" />
      <svg className="sbx-svgstage" viewBox="0 0 400 300" aria-hidden="true">
        <g opacity="0">
          <g className="sbx-ball-spin">
            <circle r="15" fill="#e9ecef" stroke="#868e96" strokeWidth="1.5" />
            <path d="M-9,-6 L-2,-1 L-6,6 M3,-10 L5,-2 L11,2 M-4,9 L2,3 L8,8" stroke="#868e96" strokeWidth="1.2" fill="none" />
          </g>
          <animateMotion dur="0.9s" begin="0.6s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.3 0 0.7 1"
            path="M200,150 Q262,-10 320,236" />
          <set attributeName="opacity" to="1" begin="0.6s" fill="freeze" />
          <set attributeName="opacity" to="0" begin="1.55s" fill="freeze" />
        </g>
        <g className="sbx-bin">
          <path d="M288,206 L352,206 L344,290 L296,290 Z" fill="rgba(73,80,87,0.92)" stroke="#212529" strokeWidth="3" strokeLinejoin="round" />
          <line x1="306" y1="214" x2="310" y2="282" stroke="#868e96" strokeWidth="2" />
          <line x1="320" y1="214" x2="320" y2="282" stroke="#868e96" strokeWidth="2" />
          <line x1="334" y1="214" x2="330" y2="282" stroke="#868e96" strokeWidth="2" />
          <ellipse cx="320" cy="206" rx="32" ry="6" fill="#343a40" stroke="#212529" strokeWidth="2" />
        </g>
      </svg>
      <div className="sbx-swish">Nothing but net!</div>
    </>
  )
}

function Rocket({ note }) {
  const smoke = useMemo(() => Array.from({ length: 8 }, () => ({ x: rand(-60, 60), s: rand(30, 60), d: rand(0, 900) })), [])
  return (
    <>
      {smoke.map((p, i) => (
        <div key={i} className="sbx-puff sbx-puff-ground" style={{ left: 200 + p.x, top: 268, width: p.s, height: p.s, animationDelay: `${1100 + p.d}ms` }} />
      ))}
      <svg className="sbx-svgstage" viewBox="0 0 400 300" aria-hidden="true">
        <line x1="40" y1="290" x2="360" y2="290" stroke="#adb5bd" strokeWidth="2" />
        <g className="sbx-rocket">
          <g className="sbx-rocket-shake">
            <g className="sbx-flame-grp">
              <path d="M188,238 Q200,290 212,238 Z" fill="#ff922b" />
              <path d="M193,238 Q200,272 207,238 Z" fill="#ffe066" />
            </g>
            <path d="M178,215 L160,242 L178,236 Z" fill="#e03131" stroke="#a51111" strokeWidth="1.5" />
            <path d="M222,215 L240,242 L222,236 Z" fill="#e03131" stroke="#a51111" strokeWidth="1.5" />
            <path d="M200,105 C215,120 222,140 222,175 L222,236 L178,236 L178,175 C178,140 185,120 200,105 Z" fill="#f8f9fa" stroke="#495057" strokeWidth="2.5" />
            <circle cx="200" cy="165" r="11" fill="#fff3bf" stroke="#495057" strokeWidth="2.5" />
            <path d="M186,120 Q200,106 214,120" fill="#e03131" />
            <text x="200" y="210" textAnchor="middle" fontSize="9" fontWeight="800" fill="#1971c2">RICT</text>
          </g>
        </g>
      </svg>
      {/* note drawn above the rocket so it visibly shrinks into the window */}
      <Card note={note} cls="sbx-shrink-to" style={{ '--tx': '200px', '--ty': '165px' }} />
      <div className="sbx-count" style={{ animationDelay: '500ms' }}>3</div>
      <div className="sbx-count" style={{ animationDelay: '800ms' }}>2</div>
      <div className="sbx-count" style={{ animationDelay: '1100ms' }}>1</div>
    </>
  )
}

function BlackHole({ note }) {
  const stars = useMemo(() => Array.from({ length: 26 }, () => ({ x: rand(0, 400), y: rand(0, 300), s: rand(1.5, 3) })), [])
  return (
    <>
      <div className="sbx-space">
        {stars.map((s, i) => <div key={i} className="sbx-star" style={{ left: s.x, top: s.y, width: s.s, height: s.s }} />)}
      </div>
      <div className="sbx-hole"><div className="sbx-disk" /><div className="sbx-core" /></div>
      <div className="sbx-orbit">
        <div className="sbx-orbit-arm">
          <Card note={note} cls="sbx-spiral-card" style={{ left: 0, top: 0 }} />
        </div>
      </div>
    </>
  )
}

function Pixels({ note }) {
  const COLS = 8, ROWS = 5, W = 200, H = 130
  const tw = W / COLS, th = H / ROWS
  const tiles = useMemo(() => {
    const out = []
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        out.push({
          r, c,
          delay: 350 + (c / COLS) * 900 + rand(0, 300),
          dx: `${rand(30, 110)}px`, dy: `${rand(-90, -20)}px`, rot: `${rand(-90, 90)}deg`,
        })
      }
    }
    return out
  }, [])
  return (
    <>
      <div className="sbx-tiles" style={{ width: W, height: H }}>
        {tiles.map(t => (
          <div key={`${t.r}-${t.c}`} className="sbx-tile"
            style={{ left: t.c * tw, top: t.r * th, width: tw + 0.5, height: th + 0.5,
              '--dx': t.dx, '--dy': t.dy, '--r': t.rot, animationDelay: `${t.delay}ms` }}>
            <div style={{ position: 'absolute', left: -t.c * tw, top: -t.r * th, width: W, height: H }}>
              <NoteFace note={note} />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function Crane({ note }) {
  return (
    <>
      <Card note={note} cls="sbx-fold-card" />
      <svg className="sbx-svgstage" viewBox="0 0 400 300" aria-hidden="true">
        <g opacity="0">
          <g className="sbx-crane-pop">
            <path className="sbx-wing sbx-wing-back" d="M-2,-2 L-30,-38 L10,-4 Z" fill="#fcc419" stroke="#b08900" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M-26,4 L0,-6 L26,4 L0,12 Z" fill="#ffe066" stroke="#b08900" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M-24,4 L-44,-14 L-40,-12 Z M-40,-12 L-48,-14 L-44,-14 Z" fill="#ffe066" stroke="#b08900" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M22,4 L38,-18 L30,6 Z" fill="#ffe066" stroke="#b08900" strokeWidth="1.5" strokeLinejoin="round" />
            <path className="sbx-wing sbx-wing-front" d="M2,-2 L18,-42 L-8,-2 Z" fill="#fff3bf" stroke="#b08900" strokeWidth="1.5" strokeLinejoin="round" />
          </g>
          <animateMotion dur="1.8s" begin="0.95s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.5 0 0.8 1"
            path="M200,160 C170,120 150,150 120,100 C95,60 60,70 20,10 L-60,-60" />
          <set attributeName="opacity" to="1" begin="0.7s" fill="freeze" />
        </g>
      </svg>
    </>
  )
}

function Gentle({ note }) {
  return (
    <>
      <Card note={note} cls="sbx-gentle-card" />
      <div className="sbx-check" aria-hidden="true">✓</div>
    </>
  )
}

const SCENES = {
  explode: Explode, shred: Shred, burn: Burn, throw: Throw, trex: TRex, veto: Veto,
  robot: RobotArm, conveyor: Conveyor, tube: Tube, airplane: Airplane, basket: Basket,
  rocket: Rocket, blackhole: BlackHole, pixels: Pixels, crane: Crane,
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

/**
 * <SubmitAnimation kind="trex" note={{ body, category }} onDone={fn} />
 * kind 'gentle' (or reduced motion) plays the calm variant.
 */
export default function SubmitAnimation({ kind, note, onDone }) {
  const prefersReduced = useMemo(() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
  }, [])
  const effective = prefersReduced || !SCENES[kind] ? 'gentle' : kind
  const Scene = effective === 'gentle' ? Gentle : SCENES[effective]
  const { ms, receivedAt } = ANIMATIONS[effective] || GENTLE

  const skipRef = useRef(null)
  const doneRef = useRef(false)
  const [scale, setScale] = useState(1)

  const finish = () => {
    if (doneRef.current) return
    doneRef.current = true
    onDone?.()
  }

  // Fit the 400 × 300 stage to the screen.
  useEffect(() => {
    const fit = () => {
      const s = Math.min(1.4, (window.innerWidth * 0.94) / 400, (window.innerHeight * 0.72) / 300)
      setScale(Math.max(0.5, s))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  useEffect(() => {
    skipRef.current?.focus({ preventScroll: true })
    const t = setTimeout(finish, ms + 150)
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish() } }
    document.addEventListener('keydown', onKey)
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms])

  return (
    <div className="sbx-overlay" onClick={finish}>
      {/* Outer box takes the scaled size in layout; inner box is scaled to fill it. */}
      <div className="sbx-stage-box" style={{ width: 400 * scale, height: 300 * scale }} aria-hidden="true">
        <div className="sbx-stage-fit" style={{ transform: `scale(${scale})` }}>
          <div className={`sbx-stage sbx-k-${effective}`}>
            <Scene note={note} />
          </div>
        </div>
      </div>
      <div className="sbx-received" style={{ animationDelay: `${receivedAt}ms` }} aria-hidden="true">Suggestion received ✓</div>
      <button
        ref={skipRef}
        type="button"
        className="sbx-skip"
        onClick={(e) => { e.stopPropagation(); finish() }}
      >
        Skip animation
      </button>
    </div>
  )
}

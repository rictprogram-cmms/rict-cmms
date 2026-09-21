#!/usr/bin/env node
/**
 * RICT CMMS — build-time convention check
 *
 * Runs before `vite build` (see "build" in package.json), so a violation fails
 * the build — locally and on Vercel — with a message naming the file and line,
 * instead of shipping a page that is quietly broken. No dependencies; plain
 * Node. Scans every .js / .jsx under src/.
 *
 *   npm run check                  run the check on its own
 *   npm run check -- --self-test   prove the scanner still catches what it should
 *
 * RULE 1 — no query filter chained onto mustData(...)
 * ───────────────────────────────────────────────────
 *   mustData() returns the ROWS (an array), not the query. A filter written
 *   after its closing parenthesis runs on that array and throws
 *   "TypeError: … .neq is not a function" every single time:
 *
 *       const rows = mustData(await supabase.from('profiles').select('…')
 *         .eq('status', 'Active'), 'profiles.select')
 *         .neq('email', SUPER_ADMIN_EMAIL)            ← WRONG: outside mustData()
 *
 *       const rows = mustData(await supabase.from('profiles').select('…')
 *         .eq('status', 'Active')
 *         .neq('email', SUPER_ADMIN_EMAIL), 'profiles.select')   ← right
 *
 *   Found three of these on 2026-09-21 (class-wide Time Cards report, Assets
 *   "Out" badges, Weekly Labs roster). Each had been failing silently behind a
 *   catch. Only query-builder methods are flagged (.eq .neq .in .order …);
 *   ordinary array code such as mustData(...).map(...) is fine.
 *
 * RULE 2 — no raw supabase.channel(...)
 * ─────────────────────────────────────
 *   A raw channel can die silently after a Wi-Fi drop or laptop sleep and the
 *   page stops updating live until it is reloaded. Table subscriptions go
 *   through subscribeWithReconnect() from src/lib/supabaseRealtime.js, which
 *   rebuilds a dead channel with backoff. All 56 raw channels were converted on
 *   2026-09-21; this keeps them from creeping back.
 *
 *   Allowed: src/lib/supabaseRealtime.js (the helper itself) and
 *   src/contexts/AuthContext.jsx (the presence channel — it must .track()
 *   after every SUBSCRIBED, which the helper does not do).
 *
 *   A genuinely special channel (presence, broadcast) elsewhere can opt out
 *   with this comment on the same line or the line above:
 *       // check-conventions: allow-raw-channel — <why>
 *
 * File: scripts/check-conventions.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'src')

const RAW_CHANNEL_ALLOWED_FILES = new Set([
  'src/lib/supabaseRealtime.js',
  'src/contexts/AuthContext.jsx',
])
const ALLOW_COMMENT = 'check-conventions: allow-raw-channel'

// PostgREST query-builder methods that do NOT exist on a JavaScript array.
// (`filter` is deliberately absent — arrays have it too.)
const BUILDER_METHODS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in',
  'contains', 'containedBy', 'overlaps', 'match', 'not', 'or', 'textSearch',
  'order', 'limit', 'range', 'single', 'maybeSingle', 'select', 'csv',
])

// ─── Masking ──────────────────────────────────────────────────────────────────
// Returns a string of the SAME length where the contents of comments, strings,
// template literals and regex literals are blanked to spaces (newlines kept),
// so the rules below only ever look at real code and line numbers stay true.

const REGEX_MAY_FOLLOW = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])

export function maskNonCode(src) {
  const out = src.split('')
  const n = src.length
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ' }
  let i = 0
  let lastSig = ''      // last significant (non-space) code character
  let lastWord = ''     // identifier/keyword ending at lastSig, if any

  while (i < n) {
    const c = src[i]
    const d = src[i + 1]

    // line comment
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i); if (j < 0) j = n
      blank(i, j); i = j; continue
    }
    // block comment (also covers {/* JSX comments */})
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2
      blank(i, j); i = j; continue
    }
    // '…' and "…" — JS strings cannot span a newline. An unclosed quote on a
    // line is an apostrophe in JSX text (Don't, student's), not a string.
    if (c === "'" || c === '"') {
      let j = i + 1
      let closed = false
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === c) { closed = true; break }
        j++
      }
      if (closed) { blank(i + 1, j); i = j + 1; lastSig = c; lastWord = ''; continue }
      i++; continue
    }
    // `template` — blank everything, including ${expressions} (tracked for nesting)
    if (c === '`') {
      let j = i + 1
      let depth = 0
      while (j < n) {
        const ch = src[j]
        if (ch === '\\') { j += 2; continue }
        if (depth === 0 && ch === '`') break
        if (ch === '$' && src[j + 1] === '{') { depth++; j += 2; continue }
        if (depth > 0 && ch === '{') depth++
        else if (depth > 0 && ch === '}') depth--
        j++
      }
      blank(i + 1, j); i = j + 1; lastSig = '`'; lastWord = ''; continue
    }
    // /regex/ — only where a regex can start, so a/b division is left alone
    if (c === '/' && (lastSig === '' || REGEX_MAY_FOLLOW.has(lastSig) || lastWord === 'return' || lastWord === 'typeof')) {
      let j = i + 1
      let inClass = false
      let ok = false
      while (j < n && src[j] !== '\n') {
        const ch = src[j]
        if (ch === '\\') { j += 2; continue }
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) { ok = true; break }
        j++
      }
      if (ok) { blank(i + 1, j); i = j + 1; lastSig = '/'; lastWord = ''; continue }
    }

    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) lastWord = /[A-Za-z0-9_$]/.test(lastSig) ? lastWord + c : c
      else lastWord = ''
      lastSig = c
    }
    i++
  }
  return out.join('')
}

function lineOf(src, index) {
  let line = 1
  for (let k = 0; k < index; k++) if (src.charCodeAt(k) === 10) line++
  return line
}

function matchingParen(code, openIdx) {
  let depth = 0
  for (let k = openIdx; k < code.length; k++) {
    if (code[k] === '(') depth++
    else if (code[k] === ')') { depth--; if (depth === 0) return k }
  }
  return -1
}

// ─── Rules ────────────────────────────────────────────────────────────────────

/** @returns {Array<{ rule:string, line:number, message:string }>} */
export function checkSource(src, relPath) {
  const problems = []
  const code = maskNonCode(src)
  const lines = src.split('\n')

  // Rule 1 — filter chained onto mustData(...)
  const mustRe = /(^|[^A-Za-z0-9_$.])mustData\s*\(/g
  let m
  while ((m = mustRe.exec(code))) {
    const open = m.index + m[0].length - 1
    const close = matchingParen(code, open)
    if (close < 0) continue
    const after = /^\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(code.slice(close + 1))
    if (after && BUILDER_METHODS.has(after[1])) {
      const at = close + 1 + after[0].indexOf('.')
      problems.push({
        rule: 'mustdata-chain',
        line: lineOf(src, at),
        message: `.${after[1]}(…) is chained onto the RESULT of mustData(), which is an array — this throws "TypeError: .${after[1]} is not a function" every time. Move .${after[1]}(…) inside the query, before the ", 'label')" that closes mustData().`,
      })
    }
  }

  // Rule 2 — raw .channel(
  if (!RAW_CHANNEL_ALLOWED_FILES.has(relPath)) {
    const chRe = /\.\s*channel\s*\(/g
    while ((m = chRe.exec(code))) {
      const line = lineOf(src, m.index)
      const here = lines[line - 1] || ''
      const above = lines[line - 2] || ''
      if (here.includes(ALLOW_COMMENT) || above.includes(ALLOW_COMMENT)) continue
      problems.push({
        rule: 'raw-channel',
        line,
        message: `raw supabase.channel(…) — it can die silently after a Wi-Fi drop and the page stops updating live. Use subscribeWithReconnect(name, ch => ch.on(…), { tag }) from '@/lib/supabaseRealtime' and return it from the useEffect. (Presence/broadcast channel? Add "// ${ALLOW_COMMENT} — <why>" on the line above.)`,
      })
    }
  }

  return problems
}

// ─── Runner ───────────────────────────────────────────────────────────────────

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, files)
    else if (/\.(js|jsx|mjs)$/.test(name)) files.push(full)
  }
  return files
}

function run() {
  const started = Date.now()
  const files = walk(SRC)
  let total = 0
  const byRule = {}
  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/')
    const problems = checkSource(readFileSync(file, 'utf8'), rel)
    for (const p of problems) {
      total++
      byRule[p.rule] = (byRule[p.rule] || 0) + 1
      console.error(`\n  ✖ ${rel}:${p.line}  [${p.rule}]\n    ${p.message}`)
    }
  }
  if (total > 0) {
    const summary = Object.entries(byRule).map(([r, c]) => `${c} ${r}`).join(', ')
    console.error(`\n[check-conventions] FAILED — ${total} problem${total === 1 ? '' : 's'} (${summary}). Build stopped. See scripts/check-conventions.mjs for the rules.\n`)
    process.exit(1)
  }
  console.log(`[check-conventions] OK — ${files.length} files, ${Date.now() - started} ms`)
}

// ─── Self-test ────────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0
  let fail = 0
  const expect = (name, src, want, rel = 'src/pages/X.jsx') => {
    const got = checkSource(src, rel).map(p => `${p.rule}@${p.line}`)
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (ok) pass++
    else { fail++; console.error(`  ✖ ${name}\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`) }
  }
  const BAD = [
    "const rows = mustData(await supabase",
    "  .from('profiles')",
    "  .eq('status', 'Active'), 'profiles.select')",
    "  .neq('email', ADMIN) // utility admin",
  ].join('\n')
  const GOOD = [
    "const rows = mustData(await supabase",
    "  .from('profiles')",
    "  .eq('status', 'Active')",
    "  .neq('email', ADMIN), 'profiles.select')",
  ].join('\n')

  expect('the real bug', BAD, ['mustdata-chain@4'])
  expect('the fix', GOOD, [])
  expect('comment lines between ) and the filter', BAD.replace("\n  .neq", "\n  // The pooled scanner…\n  // …second line\n  .neq"), ['mustdata-chain@6'])
  expect('array code after mustData is fine', "const ids = mustData(await q, 'x').map(r => r.id)\nconst n = (mustData(await q, 'x') || []).length", [])
  expect('.filter is an array method too — not flagged', "mustData(await q, 'x').filter(r => r.ok)", [])
  expect("a ')' inside a string does not end mustData early", "mustData(await supabase.from('t').or('a.eq.1),b.eq.2').eq('x', 1), 'label )')", [])
  expect('template literal with ${} and parens inside', "mustData(await supabase.from('t').or(`start.lte.${fn(a)},end.is.null`), 't')\n  .order('x')", ['mustdata-chain@2'])
  expect('inside a comment is ignored', "// mustData(await q, 'x').eq('a', 1)\n/* mustData(q,'x')\n .neq('a',1) */", [])
  expect('someOther.mustData-like names ignored', "notmustData(q, 'x').eq('a', 1); obj.mustData(q).eq('a', 1)", [])
  expect('semicolon ends the statement', "mustData(await q, 'x');\n[1].map(String)", [])

  expect('raw channel', "const ch = supabase\n  .channel('x')\n  .on('postgres_changes', {}, f)\n  .subscribe()", ['raw-channel@2'])
  expect('raw channel, one line', "supabase.channel(`a-${id}`).subscribe()", ['raw-channel@1'])
  expect('helper usage is fine', "return subscribeWithReconnect('x', ch => ch\n  .on('postgres_changes', {}, f)\n, { tag: 'X' })", [])
  expect('allow-listed file', "supabase.channel('online-users-presence', {})", [], 'src/contexts/AuthContext.jsx')
  expect('the helper itself', "client.channel(`${name}-${Date.now()}`)", [], 'src/lib/supabaseRealtime.js')
  expect('opt-out comment above', "// check-conventions: allow-raw-channel — broadcast cursor positions\nconst c = supabase.channel('cursors')", [])
  expect('opt-out comment, same line', "const c = supabase.channel('cursors') // check-conventions: allow-raw-channel — presence", [])
  expect('mention in a comment or string is ignored', "// raw .channel() could go silently dead\nconst s = 'use supabase.channel(name)'\n{/* .channel( */}", [])
  expect("JSX apostrophes don't swallow code", "<p>Don't worry, the student's hours</p>\nconst c = supabase.channel('x')", ['raw-channel@2'])
  expect('regex literal with quotes does not derail strings', "const re = /['\"]/g\nconst c = supabase.channel('x')", ['raw-channel@2'])
  expect('division is not a regex', "const r = a / b / c\nconst c = supabase.channel('x')", ['raw-channel@2'])
  expect('both rules, right lines', BAD + "\nsupabase.channel('y')", ['mustdata-chain@4', 'raw-channel@5'])

  // masking must never change length or line count
  const sample = BAD + "\n/* x */ `a${b}` 'c' // d\n"
  const masked = maskNonCode(sample)
  if (masked.length === sample.length && masked.split('\n').length === sample.split('\n').length) pass++
  else { fail++; console.error('  ✖ mask changed length or line count') }

  console.log(`[check-conventions] self-test: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  if (process.argv.includes('--self-test')) selfTest()
  else run()
}

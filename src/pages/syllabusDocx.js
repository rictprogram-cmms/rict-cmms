/**
 * syllabusDocx.js
 *
 * Accessible Word (.docx) export for the Syllabus Generator.
 *
 * Why this exists: the browser Print → "Save as PDF" path (Chrome/Chromium)
 * cannot produce a fully tagged PDF — its list items are missing the <Lbl>
 * substructure that accessibility checkers (Anthology Ally in D2L, Adobe
 * Acrobat checker) require, so a print-generated syllabus can never score
 * 100%. Microsoft Word's own "Save As → PDF" export DOES emit complete
 * heading, list, and table tags. This module builds the syllabus as a real
 * Word document with:
 *
 *   - True heading styles (Heading 1–4) for every section level
 *   - Native Word bullet / numbered lists (materials, technology, outcomes,
 *     and any bulleted/numbered lines inside the common policy sections)
 *   - A data table with a marked header row for the assessment points
 *   - Alt text on the college logo and course photo
 *   - A 9pt minimum font size on every visible run (Ally / federal
 *     accessibility checkers flag any text below 9 points). Headings use
 *     allCaps rather than smallCaps because Word renders small-caps
 *     lowercase glyphs at ~80% of the declared size, which pushes them
 *     back under the 9pt floor even when the run size passes.
 *   - Document title / author metadata
 *   - Live hyperlinks (email, Academic Calendar, eServices)
 *   - A post-build "finalize" pass (fflate) that repairs docx-library output:
 *     unique drawing-object and bookmark IDs (the docx package emits every
 *     wp:docPr and w:bookmarkStart with id="1", a spec violation that makes
 *     Acrobat PDFMaker silently DROP image alt text — the direct cause of a
 *     54% Ally score), named inner cNvPr elements, and an en-US document
 *     language declaration in styles.xml.
 *
 * Instructors download the .docx, open it in Word, and use
 * File → Save As → PDF to produce the compliant PDF for D2L. They must NOT
 * use the Acrobat ribbon ("Create PDF" / PDFMaker) or Print → Adobe PDF —
 * both convert through a different engine that strips image alt text.
 *
 * Used by: SyllabusWizard.jsx (Step 8 — "Download Accessible Word (.docx)")
 * Patterns follow courseOutlineDocx.js.
 */
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, WidthType, ShadingType, BorderStyle, HeadingLevel,
  LevelFormat, ExternalHyperlink, InternalHyperlink, Bookmark, ImageRun,
  Footer, PageNumber, TabStopType,
  FrameAnchorType, HorizontalPositionAlign, VerticalPositionAlign, FrameWrap,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
  TextWrappingType, TextWrappingSide,
} from 'docx'
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'

// ─── Layout constants (US Letter, 1" side margins to match the print CSS) ────
const FW     = 9360                                   // content width in DXA
const NAVY   = '1A3A5C'
const LINKBL = '1155CC'
const MARGIN = { top: 1080, right: 1440, bottom: 1296, left: 1440 } // 0.75/1/0.9/1 in

// ─── Run / paragraph helpers (Calibri to match the HTML template) ────────────
const r   = (t, o = {}) => new TextRun({ text: String(t ?? ''), font: 'Calibri', size: 21, ...o })
const rb  = (t, o = {}) => r(t, { bold: true, ...o })
const ri  = (t, o = {}) => r(t, { italics: true, ...o })
const p   = (runs, o = {}) =>
  new Paragraph({ children: Array.isArray(runs) ? runs : [r(runs)], spacing: { after: 100 }, ...o })
const gap = (before = 100) => new Paragraph({ spacing: { before, after: 0 }, children: [r('')] })

const link = (text, url, o = {}) => new ExternalHyperlink({
  link: url,
  children: [new TextRun({ text: String(text), font: 'Calibri', size: 21, color: LINKBL, underline: {}, ...o })],
})

// ─── Heading builders — real Word heading levels, styled like the print CSS ──
const h1 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER,
  spacing: { before: 0, after: 60 },
  children: [new TextRun({ text: t, font: 'Calibri', size: 30, bold: true, allCaps: true, color: '000000' })],
})
const h2 = (t, anchor) => {
  const run = new TextRun({ text: t, font: 'Calibri', size: 23, bold: true, allCaps: true, color: NAVY })
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 260, after: 120 }, keepNext: true,
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: NAVY, space: 2 } },
    // Bookmarked headings are the targets of the clickable navigation line
    children: anchor ? [new Bookmark({ id: anchor, children: [run] })] : [run],
  })
}

// Clickable in-document navigation link (blue + underlined, like the print template)
const navLink = (text, anchor) => new InternalHyperlink({
  anchor,
  children: [new TextRun({ text, font: 'Calibri', size: 18, color: LINKBL, underline: {} })],
})
const h3 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 160, after: 60 }, keepNext: true,
  children: [new TextRun({ text: t, font: 'Calibri', size: 19, bold: true, allCaps: true, color: NAVY, underline: {} })],
})
const h4 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_4,
  spacing: { before: 120, after: 60 }, keepNext: true,
  children: [new TextRun({ text: t, font: 'Calibri', size: 19, bold: true, color: '000000' })],
})

// ─── List item builders (native Word numbering → tagged <L>/<LI>/<Lbl>) ──────
const INDENT = { left: 460 }
const bullet = (t) => new Paragraph({
  numbering: { reference: 'syl-bullets', level: 0 },
  indent: INDENT, spacing: { after: 40 },
  children: [r(t)],
})
const numbered = (t, instance) => new Paragraph({
  numbering: { reference: 'syl-numbers', level: 0, instance },
  indent: INDENT, spacing: { after: 40 },
  children: [r(t)],
})

// ─── Date formatting (mirrors SyllabusWizard.jsx helpers) ────────────────────
function fmtDate(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}
function fmtDateShort(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
}

// ─── Common-section text → docx paragraphs ───────────────────────────────────
// Mirrors renderSection() in SyllabusWizard.jsx: blank lines become spacing,
// "• " lines become native bullets, "1. " lines become native numbered lists
// (each run restarts at 1 via a fresh numbering instance), and ALL-CAPS lines
// become real Heading 4 paragraphs.
function sectionToDocx(text, numCtx) {
  if (!text) return []
  const out = []
  let inNumberList = false
  text.split('\n').forEach(line => {
    const t = line.replace(/\u00a0/g, ' ').trim()
    if (!t) { inNumberList = false; out.push(gap(60)); return }
    if (t.startsWith('\u2022')) { inNumberList = false; out.push(bullet(t.slice(1).trim())); return }
    if (/^\d+\.\s/.test(t)) {
      if (!inNumberList) { numCtx.instance += 1; inNumberList = true }
      out.push(numbered(t.replace(/^\d+\.\s/, ''), numCtx.instance))
      return
    }
    inNumberList = false
    if (t === t.toUpperCase() && t.length > 3) { out.push(h4(t)); return }
    out.push(p(t))
  })
  return out
}

// ─── Image helpers ───────────────────────────────────────────────────────────
// Reads PNG / JPEG pixel dimensions from the byte stream so images keep their
// aspect ratio without hardcoding sizes.
function getImageSize(bytes, type) {
  try {
    if (type === 'png' && bytes.length > 24) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      return { w: dv.getUint32(16), h: dv.getUint32(20) }
    }
    if (type === 'jpg') {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let off = 2
      while (off < bytes.length - 9) {
        if (dv.getUint8(off) !== 0xFF) { off += 1; continue }
        const marker = dv.getUint8(off + 1)
        // SOF0–SOF15 (excluding DHT/DAC/RST markers) carry dimensions
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
          return { h: dv.getUint16(off + 5), w: dv.getUint16(off + 7) }
        }
        off += 2 + dv.getUint16(off + 2)
      }
    }
  } catch { /* fall through to default */ }
  return { w: 1, h: 1 }
}

// Rasterize any browser-decodable image (SVG, GIF, WebP, ...) to PNG via a
// canvas so it can be embedded in the Word document. Word cannot display SVG
// (without a fallback) or WebP at all, and rasterizing GIF is simpler than
// parsing its dimensions. Cross-origin URLs without CORS headers cannot be
// read by canvas either, so those still return null — the caller surfaces a
// warning telling the instructor to upload the image file instead.
// SVGs saved without explicit pixel width/height have no intrinsic size in
// some browsers (naturalWidth reports 0), which makes canvas rasterization
// produce a blank or zero-size image — an invisible logo with no error. This
// injects explicit dimensions (taken from the viewBox when present) into the
// SVG root before rasterizing.
async function normalizeSvgBlob(blob) {
  try {
    const text = await blob.text()
    const m = text.match(/<svg[^>]*>/i)
    if (!m) return blob
    const tag = m[0]
    const hasW = /\swidth\s*=/i.test(tag)
    const hasH = /\sheight\s*=/i.test(tag)
    if (hasW && hasH) return blob
    const vb = tag.match(/viewBox\s*=\s*["']\s*[\d.eE+-]+[\s,]+[\d.eE+-]+[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)/i)
    const w = Math.max(1, Math.round(vb ? parseFloat(vb[1]) : 512)) || 512
    const h = Math.max(1, Math.round(vb ? parseFloat(vb[2]) : 512)) || 512
    const newTag = tag.replace(/<svg/i, `<svg width="${w}" height="${h}"`)
    return new Blob([text.replace(tag, newTag)], { type: 'image/svg+xml' })
  } catch {
    return blob
  }
}

async function rasterizeToPng(blob) {
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Image decode failed'))
      el.src = url
    })
    const w = img.naturalWidth || 512
    const h = img.naturalHeight || 512
    // Render above display size (up to 4x, capped at 1024px) so vector logos
    // stay crisp when Word scales the bitmap for print.
    const scale = Math.min(1024 / w, 1024 / h, 4)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const outBlob = await new Promise(res => canvas.toBlob(res, 'image/png'))
    if (!outBlob || outBlob.size < 100) {
      console.warn('[syllabusDocx] Rasterization produced an empty image')
      return null
    }
    const data = new Uint8Array(await outBlob.arrayBuffer())
    return { data, type: 'png', w, h } // natural dimensions preserve aspect ratio
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Final-resort rasterizer: point an <img> element at the ORIGINAL url string,
// exactly like the wizard preview does, and capture it via canvas. If the
// preview can render the image, this can too (the only exception is a
// cross-origin URL without CORS headers, which taints the canvas).
async function rasterizeFromUrl(url) {
  const img = await new Promise((resolve, reject) => {
    const el = new Image()
    if (!url.startsWith('data:')) el.crossOrigin = 'anonymous'
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('img element could not decode the source'))
    el.src = url
  })
  const w = img.naturalWidth || 512
  const h = img.naturalHeight || 512
  const scale = Math.min(1024 / w, 1024 / h, 4)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
  const outBlob = await new Promise(res => canvas.toBlob(res, 'image/png'))
  if (!outBlob || outBlob.size < 100) throw new Error('canvas produced an empty image')
  const data = new Uint8Array(await outBlob.arrayBuffer())
  return { data, type: 'png', w, h }
}

// Decode a data: URL without fetch() — immune to service-worker interception,
// CSP connect-src restrictions, and any other fetch-layer quirks. Uploaded
// logos and photos are stored as data: URLs, so this is the primary path.
function dataUrlToBlob(url) {
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const header = url.slice(5, comma) // strip "data:"
  const body = url.slice(comma + 1)
  const mime = (header.split(';')[0] || 'application/octet-stream').trim()
  let bytes
  if (/;base64/i.test(header)) {
    // Strip whitespace/newlines — a data URL that was ever copy-pasted or
    // stored with line wrapping will otherwise make atob() throw.
    const bin = atob(body.replace(/\s+/g, ''))
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(body))
  }
  return new Blob([bytes], { type: mime })
}

// Identify the image by its actual BYTES, never by its declared MIME type —
// data URLs can carry a mislabeled type (e.g. SVG markup stored as image/png)
// and the browser <img> tag content-sniffs its way past that, which is why
// the preview can show a logo the Word export chokes on.
function sniffBytes(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png'
  if (bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpg'
  // SVG is XML text: look for an <svg tag near the start (allowing BOM,
  // whitespace, XML declaration, comments)
  try {
    const head = new TextDecoder().decode(bytes.slice(0, 512)).toLowerCase()
    if (head.includes('<svg')) return 'svg'
  } catch { /* binary — not svg */ }
  return null
}

// Returns { image, status }: image is the embeddable { data, type, w, h } (or
// null), status is a short human-readable trail of what happened — surfaced
// in the export toast so failures self-diagnose without needing DevTools.
async function loadImage(rawUrl) {
  const url = String(rawUrl ?? '').trim()
  if (!url) return { image: null, status: 'no image set' }
  const notes = []
  const isDataUrl = /^data:/i.test(url)
  // Lead the status trail with WHAT the source is, so a failure toast
  // immediately reveals whether a stale web/blob URL is in play.
  notes.push(isDataUrl
    ? `source: data URL (${url.length} chars)`
    : `source: "${url.slice(0, 48)}${url.length > 48 ? '\u2026' : ''}"`)
  // ── Path 1: read the bytes and identify them by signature ──────────────────
  try {
    let blob
    if (isDataUrl) {
      try {
        blob = dataUrlToBlob(url)
        if (!blob) throw new Error('malformed data URL')
      } catch (e) {
        // atob can still choke on unusual encodings; fetch() natively decodes
        // data: URLs, so give it one shot before declaring the URL unreadable.
        notes.push(`data-URL decode failed (${e?.message || e}), retrying via fetch`)
        const res = await fetch(url)
        if (!res.ok) throw new Error(`fetch returned ${res.status}`)
        blob = await res.blob()
      }
    } else {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`fetch returned ${res.status}`)
        blob = await res.blob()
      } catch (e) {
        const msg = e?.message || String(e)
        // "Failed to fetch" is the browser's opaque CORS/network error —
        // translate it so the toast tells the instructor what to actually do.
        throw new Error(/failed to fetch/i.test(msg)
          ? 'this is a link to an image on another website, which blocks cross-site access \u2014 upload the image file itself instead of linking to it'
          : msg)
      }
    }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const kind = sniffBytes(bytes)
    notes.push(`${bytes.length} bytes, content: ${kind || 'other'}, declared: ${blob.type || 'none'}`)
    if (kind === 'png' || kind === 'jpg') {
      const size = getImageSize(bytes, kind)
      if (size.w > 1 && size.h > 1) {
        return { image: { data: bytes, type: kind, ...size }, status: `embedded natively (${kind} ${size.w}×${size.h})` }
      }
      notes.push('dimension parse failed')
    }
    let rasterBlob = new Blob([bytes], { type: kind === 'svg' ? 'image/svg+xml' : (blob.type || 'application/octet-stream') })
    if (kind === 'svg') rasterBlob = await normalizeSvgBlob(rasterBlob)
    const raster = await rasterizeToPng(rasterBlob)
    if (raster) return { image: raster, status: `rasterized to PNG (${raster.w}×${raster.h}) — ${notes.join('; ')}` }
    notes.push('blob rasterization failed')
  } catch (e) {
    notes.push(e?.message || String(e))
  }
  // ── Path 2: decode via an <img> element, exactly like the wizard preview ───
  try {
    const raster = await rasterizeFromUrl(url)
    return { image: raster, status: `captured via img element (${raster.w}×${raster.h}) — ${notes.join('; ')}` }
  } catch (e) {
    notes.push(`img-element path: ${e?.message || e}`)
  }
  const status = notes.join('; ')
  console.warn('[syllabusDocx] Image embed failed:', status, String(url).slice(0, 80))
  return { image: null, status }
}

// Scale to a target CSS-pixel width, capping height, preserving aspect ratio
function scaleTo(img, targetW, maxH) {
  const ratio = img.h > 0 && img.w > 0 ? img.h / img.w : 1
  let w = targetW
  let h = Math.round(w * ratio)
  if (maxH && h > maxH) { h = maxH; w = Math.round(h / ratio) }
  return { width: w, height: h }
}

// ─── Assessment table (real header row → tagged <TH> cells in the PDF) ───────
function buildGradeTable(assessments, totalPoints) {
  const CW = [4200, 1230]
  const cellB = { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D8E2F0' }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } }
  const cell = (children, opts = {}) => new TableCell({
    borders: cellB, margins: { top: 60, bottom: 60, left: 140, right: 140 },
    ...opts, children,
  })
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      cell([p([new TextRun({ text: 'Assessment', font: 'Calibri', size: 20, bold: true, allCaps: true, color: 'FFFFFF' })], { spacing: { after: 0 } })], { shading: { fill: NAVY, type: ShadingType.CLEAR }, width: { size: CW[0], type: WidthType.DXA } }),
      cell([p([new TextRun({ text: 'Points', font: 'Calibri', size: 20, bold: true, allCaps: true, color: 'FFFFFF' })], { alignment: AlignmentType.RIGHT, spacing: { after: 0 } })], { shading: { fill: NAVY, type: ShadingType.CLEAR }, width: { size: CW[1], type: WidthType.DXA } }),
    ],
  })
  const rows = (assessments || []).map((a, i) => {
    const shade = i % 2 === 1 ? { fill: 'F2F5FB', type: ShadingType.CLEAR } : undefined
    const nameRuns = [r(a.name, { size: 20 })]
    if (a.description) nameRuns.push(r(' \u2013 ', { size: 20 }), ri(a.description, { size: 20 }))
    return new TableRow({ children: [
      cell([p(nameRuns, { spacing: { after: 0 } })], { shading: shade, width: { size: CW[0], type: WidthType.DXA } }),
      cell([p([r(a.points > 0 ? `${a.points} pts` : '\u2013', { size: 20 })], { alignment: AlignmentType.RIGHT, spacing: { after: 0 } })], { shading: shade, width: { size: CW[1], type: WidthType.DXA } }),
    ]})
  })
  const totalB = { ...cellB, top: { style: BorderStyle.SINGLE, size: 12, color: NAVY } }
  const totalRow = new TableRow({ children: [
    new TableCell({ borders: totalB, margins: { top: 60, bottom: 60, left: 140, right: 140 }, shading: { fill: 'E6ECF7', type: ShadingType.CLEAR }, width: { size: CW[0], type: WidthType.DXA },
      children: [p([rb('Total Points', { size: 20 })], { spacing: { after: 0 } })] }),
    new TableCell({ borders: totalB, margins: { top: 60, bottom: 60, left: 140, right: 140 }, shading: { fill: 'E6ECF7', type: ShadingType.CLEAR }, width: { size: CW[1], type: WidthType.DXA },
      children: [p([rb(`${totalPoints} pts`, { size: 20 })], { alignment: AlignmentType.RIGHT, spacing: { after: 0 } })] }),
  ]})
  return new Table({
    width: { size: CW[0] + CW[1], type: WidthType.DXA },
    columnWidths: CW,
    rows: [headerRow, ...rows, totalRow],
  })
}

// ─── Main builder ────────────────────────────────────────────────────────────
// data:            the wizard's syllabus state object
// commonSections:  rows from syllabus_common_sections (may be empty)
// defaultSections: DEFAULT_COMMON_SECTIONS from SyllabusWizard.jsx (fallbacks)
// images:          { logo, photo } from fetchImage(), either may be null
export function buildSyllabusDoc(data, commonSections, defaultSections, images = {}) {
  const get = (key) => {
    const row = (commonSections || []).find(s => s.section_key === key)
    return row ? row.content : ((defaultSections || {})[key]?.content || '')
  }
  const numCtx = { instance: 0 } // fresh numbering instance per numbered list

  const totalPoints = (data.assessments || []).reduce((sum, a) => sum + (parseInt(a.points) || 0), 0)
  const aMin = Math.round(totalPoints * data.grading_a_min / 100)
  const bMin = Math.round(totalPoints * data.grading_b_min / 100)
  const cMin = Math.round(totalPoints * data.grading_c_min / 100)
  const creditsTotal = (parseInt(data.credits_lecture) || 0) + (parseInt(data.credits_lab) || 0) + (parseInt(data.credits_soe) || 0)
  const creditsStr = `${creditsTotal} credit${creditsTotal !== 1 ? 's' : ''}: Lecture \u2013 ${data.credits_lecture}, Laboratory \u2013 ${data.credits_lab}, SOE \u2013 ${data.credits_soe}`
  const revisedStr = data.revised_date ? fmtDate(data.revised_date) : ''
  const hasInstructor2 = data.instructor2_enabled && data.instructor2_name
  const timeNote = data.time_commitment_notes || `You should expect to spend two hours outside of class for each hour of lecture and one hour outside of class for each hour of lab. For this course, that means a total expectation of ${(parseInt(data.credits_lecture) || 0) * 2 + (parseInt(data.credits_lab) || 0)} hours per week outside of the classroom. If you do not feel you can fulfill this expectation, you should consider whether this class best fits this term for you.`

  const c = []

  // ── Revised date (top right) ───────────────────────────────────────────────
  c.push(p([r(`Revised: ${revisedStr}`, { size: 18, color: '444444' })], { alignment: AlignmentType.RIGHT, spacing: { after: 120 } }))

  // ── Masthead ───────────────────────────────────────────────────────────────
  // Side-by-side layout matching the print template: the college identity
  // block sits in a bordered sidebar frame on the left and the title block
  // flows beside it. Word paragraph FRAMES are used instead of a layout table
  // because frames remain real paragraphs — correct reading order for screen
  // readers, and no headerless-table flag in the tagged PDF. (The college's
  // own official template achieves this layout with floating text boxes;
  // frames are the more accessible equivalent.) Consecutive paragraphs with
  // identical frame settings merge into a single frame in Word.
  const sideFrame = {
    type: 'alignment',
    width: 2100, // ~140px, matching the print CSS sidebar width
    anchor: { horizontal: FrameAnchorType.MARGIN, vertical: FrameAnchorType.TEXT },
    alignment: { x: HorizontalPositionAlign.LEFT, y: VerticalPositionAlign.INLINE },
    wrap: FrameWrap.AROUND,
  }
  const sbLine = { style: BorderStyle.SINGLE, size: 4, color: 'C0CDE0', space: 8 }
  const sbShade = { fill: 'F4F7FC', type: ShadingType.CLEAR }
  const sbFirst = { top: sbLine, left: sbLine, right: sbLine }
  const sbMid = { left: sbLine, right: sbLine }
  const sbLast = { bottom: sbLine, left: sbLine, right: sbLine }
  if (images.logo) {
    const dims = scaleTo(images.logo, 64)
    c.push(new Paragraph({
      frame: sideFrame, shading: sbShade, border: sbFirst, spacing: { after: 40 },
      children: [new ImageRun({
        data: images.logo.data, type: images.logo.type, transformation: dims,
        altText: { title: 'College logo', description: 'St. Cloud Technical & Community College logo', name: 'SCTCC logo' },
      })],
    }))
  }
  c.push(p([rb('St. Cloud Technical & Community College', { size: 19, color: NAVY, allCaps: true })], { frame: sideFrame, shading: sbShade, border: images.logo ? sbMid : sbFirst, spacing: { after: 20 } }))
  c.push(p([ri('A member of Minnesota State', { size: 18, color: '555555' })], { frame: sideFrame, shading: sbShade, border: sbMid, spacing: { after: 40 } }))
  c.push(p([ri('We provide the education, training, and support necessary for equitable participation in our society, economy, and democracy.', { size: 18, color: '555555' })], { frame: sideFrame, shading: sbShade, border: sbLast, spacing: { after: 0 } }))
  c.push(h1(`${data.course_id}: ${data.course_name}`))
  c.push(p([new TextRun({ text: data.semester, font: 'Calibri', size: 21, bold: true, allCaps: true })], { alignment: AlignmentType.CENTER, spacing: { after: 120 } }))
  c.push(p([rb(`This syllabus is the official course document. The instructor${hasInstructor2 ? 's reserve' : ' reserves'} the right to make changes to this document. Students will be notified when changes are made.`, { size: 19 })], { alignment: AlignmentType.CENTER, spacing: { after: 60 } }))
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [
    navLink('Instructor Information', 'sec_instructor'), r(' / ', { size: 18 }),
    navLink('Course Information', 'sec_course'), r(' / ', { size: 18 }),
    navLink('College Policies & Procedures', 'sec_college_policies'), r(' / ', { size: 18 }),
    navLink('Course Policies & Procedures', 'sec_course_policies'), r(' / ', { size: 18 }),
    navLink('Grading', 'sec_grading'),
  ]}))
  // Clear the sidebar frame: spacer so the first section heading starts
  // full-width below the masthead, matching the print layout. The sidebar is
  // taller when a logo is present, so the spacer scales with it.
  c.push(new Paragraph({ spacing: { before: images.logo ? 900 : 200, after: 0 }, children: [r('', { size: 2 })] }))

  // ── Instructor Information ─────────────────────────────────────────────────
  c.push(h2('Instructor Information', 'sec_instructor'))
  c.push(h3('Office & Office Hours'))
  c.push(p(data.instructor_office))
  c.push(p(data.instructor_office_hours))
  c.push(h3('Contact Information'))
  // Course photo floats to the right of the contact block, matching the print
  // layout. Floating anchored images with alt text are exactly how the
  // college's own template places its images — fully accessible.
  const nameChildren = [r(data.instructor_name)]
  if (images.photo) {
    const dims = scaleTo(images.photo, 180, 140)
    // Accessibility: prefer the instructor-written alt text; fall back to a
    // generated description so the image always carries alternative text.
    const photoAlt = (data.course_photo_alt || '').trim() || `Course photo for ${data.course_id}: ${data.course_name}`
    nameChildren.unshift(new ImageRun({
      data: images.photo.data, type: images.photo.type, transformation: dims,
      altText: { title: 'Course photo', description: photoAlt, name: 'Course photo' },
      floating: {
        horizontalPosition: { relative: HorizontalPositionRelativeFrom.MARGIN, align: HorizontalPositionAlign.RIGHT },
        verticalPosition: { relative: VerticalPositionRelativeFrom.PARAGRAPH, offset: 0 },
        wrap: { type: TextWrappingType.SQUARE, side: TextWrappingSide.LEFT },
        margins: { left: 182880, bottom: 91440 }, // 0.2in left, 0.1in below
      },
    }))
  }
  c.push(new Paragraph({ spacing: { after: 100 }, children: nameChildren }))
  if (data.instructor_email) c.push(new Paragraph({ spacing: { after: 100 }, children: [link(data.instructor_email, `mailto:${data.instructor_email}`)] }))
  if (data.instructor_phone) c.push(p(data.instructor_phone))
  c.push(p([r('The best way to contact us is by '), rb('email/telephone/text'), r('.')]))
  c.push(p('You can expect a response to email questions within 24 hours Mondays-Thursdays.'))
  if (hasInstructor2) {
    c.push(h3('Co-Instructor Office & Office Hours'))
    c.push(p(data.instructor2_office || ''))
    c.push(p(data.instructor2_office_hours || ''))
    c.push(h3('Co-Instructor Contact'))
    c.push(p(data.instructor2_name))
    if (data.instructor2_email) c.push(new Paragraph({ spacing: { after: 100 }, children: [link(data.instructor2_email, `mailto:${data.instructor2_email}`)] }))
    if (data.instructor2_phone) c.push(p(data.instructor2_phone))
  }

  // ── Course Information ─────────────────────────────────────────────────────
  c.push(h2('Course Information', 'sec_course'))
  c.push(h3('General Information'))
  c.push(p([rb(`${data.course_id}: ${data.course_name}`)]))
  c.push(p(creditsStr))
  if (data.course_type === 'online') {
    c.push(p('This is a fully online course. All lectures, assignments, and coursework are completed remotely. There are no required on-campus hours unless otherwise stated by the instructor.'))
  } else if (data.course_type === 'hybrid') {
    c.push(p([r('This is a hybrid course that does not have a designated meeting time. Students are responsible for signing up for their lab hours on a weekly basis. Please review the attendance policy for details. This course requires each student to be on campus for '), rb(`${data.required_hours_per_week} hours a week`), r(', unless otherwise stated by instructor.')]))
    c.push(p('The lecture component of this course is online and is expected to be done outside of class time.'))
  } else {
    c.push(p([r('This course meets at the times listed in eServices. Students are expected to attend all scheduled class sessions. Students are required to be on campus for '), rb(`${data.required_hours_per_week} hours a week`), r('.')]))
  }
  c.push(p(`Begin date: ${fmtDateShort(data.begin_date)} - End date: ${fmtDateShort(data.end_date)}`))
  c.push(new Paragraph({ spacing: { before: 60, after: 100 }, children: [
    link('SCTCC Academic Calendar', 'https://www.sctcc.edu/student-resources/registration/academic-calendar'),
    r(' and '),
    link('eServices', 'https://eservices.minnstate.edu'),
  ]}))
  c.push(p(`Last day to drop and receive full refund is ${fmtDate(data.last_drop_date)}.`))
  c.push(p(`Last day to withdraw with a grade of \u201CW\u201D is ${fmtDate(data.last_withdraw_date)}.`))
  c.push(p('Students not attending class during the first week shall be dropped from the course for non-attendance.'))
  c.push(p('Students who do not meet outlined participation requirements in this class for two consecutive weeks during the semester shall be administratively withdrawn from the class; this action is based on federal financial aid regulations.', { spacing: { before: 60, after: 100 } }))
  if (data.spring_break_start && data.spring_break_end) {
    c.push(p([rb('Spring Break: '), r(`${fmtDate(data.spring_break_start)} \u2013 ${fmtDate(data.spring_break_end)}`)]))
  }
  c.push(h3('Materials'))
  c.push(p([rb('Required')]))
  const materials = (data.required_materials || []).map(m => m.replace(/ \(Part #:.*?\)$/i, '').trim())
  if (materials.length > 0) materials.forEach(m => c.push(bullet(m)))
  else c.push(p('None'))
  c.push(p([rb('Required Technology')], { spacing: { before: 80, after: 100 } }))
  ;(data.required_technology || []).forEach(t => c.push(bullet(t)))
  c.push(p([rb('Suggested Technical Skills')], { spacing: { before: 80, after: 100 } }))
  c.push(p('Microsoft Training is available for free at your convenience.'))
  c.push(h3('Pre/Co-Requisites'))
  c.push(p(data.prerequisites || 'None'))
  if (data.restricted_to) c.push(p(`Restricted to the following major(s): ${data.restricted_to}`))
  c.push(h3('Course Description & Outcomes'))
  c.push(p(data.course_description))
  if ((data.student_outcomes || []).length > 0) {
    c.push(p([rb('Student Learning Outcomes:')]))
    numCtx.instance += 1
    data.student_outcomes.forEach(o => c.push(numbered(o, numCtx.instance)))
  }

  // ── College Policies & Procedures ──────────────────────────────────────────
  c.push(h2('College Policies & Procedures', 'sec_college_policies'))
  c.push(h3('Academic Integrity'))
  c.push(...sectionToDocx(get('academic_integrity'), numCtx))
  c.push(h3('Accommodations'))
  c.push(...sectionToDocx(get('accommodations'), numCtx))
  c.push(h3('Nondiscrimination and Title IX'))
  c.push(...sectionToDocx(get('diversity'), numCtx))

  // ── Course Policies & Procedures ───────────────────────────────────────────
  c.push(h2('Course Policies & Procedures', 'sec_course_policies'))
  c.push(h3('Attendance'))
  c.push(...sectionToDocx(get('attendance'), numCtx))
  c.push(h3('Navigating D2L & Technical Support'))
  c.push(...sectionToDocx(get('d2l'), numCtx))
  c.push(h3('Class Environment'))
  c.push(...sectionToDocx(get('class_environment'), numCtx))

  // ── Grading ────────────────────────────────────────────────────────────────
  c.push(h2('Grading', 'sec_grading'))
  c.push(h3('Assignments & Points'))
  if ((parseInt(data.volunteer_hours_required) || 0) > 0) {
    c.push(p([r('All students are expected to put in '), rb(`${data.volunteer_hours_required} hours of volunteer hours`), r('. These hours need to be approved by the instructor. They must support the program. Examples are VEX Robotics tournaments, Ambassador program, Epic, etc.')]))
  }
  c.push(p([r('Weekly attendance \u2013 Your time sheet will need to match up to your signup days for lab. You will need '), rb(`${data.required_hours_per_week} hours a week`), r(' of lab time.')], { spacing: { after: 160 } }))
  c.push(buildGradeTable(data.assessments, totalPoints))
  c.push(p([r('(Subject to change depending on course content)', { size: 18, color: '666666' })], { spacing: { before: 60 } }))
  c.push(h3('Grading Scale'))
  c.push(p(`A = ${data.grading_a_min}\u2013100% = ${aMin}\u2013${totalPoints} points`))
  c.push(p(`B = ${data.grading_b_min}\u2013${data.grading_a_min - 1}% = ${bMin}\u2013${aMin - 1} points`))
  c.push(p(`C = ${data.grading_c_min}\u2013${data.grading_b_min - 1}% = ${cMin}\u2013${bMin - 1} points`))
  c.push(p(`F = ${data.grading_c_min - 1} and below = <${cMin} points`))
  c.push(h3('Grades'))
  c.push(p('You can check your grade through D2L Brightspace ASSESSMENTS/GRADES at any point during the semester.'))
  c.push(p('You can expect to have graded assignments returned within 3\u20135 days of the due date of the assignment.'))
  c.push(p('Your grade will reflect how well you have mastered the material, not how hard you have worked.'))
  c.push(h3('Time Commitment'))
  c.push(p(timeNote))
  c.push(h3('Course Calendar'))
  c.push(p('A detailed schedule is available on D2L. Instructors may adjust or change. Notifications will be given in class prior to change.'))
  if (data.finals_start && data.finals_end) {
    c.push(p(`The Final will be taken the week of ${fmtDateShort(data.finals_start)}\u2013${fmtDateShort(data.finals_end)} during class.`))
  }

  // ── Document footer text (in body, mirroring the print template) ───────────
  const footerLines = String(get('college_footer') || '').split('\n').filter(Boolean)
  c.push(new Paragraph({
    spacing: { before: 320, after: 40 },
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB', space: 4 } },
    children: [r(footerLines[0] || '', { size: 18, color: '444444' })],
  }))
  footerLines.slice(1).forEach(line => c.push(p([r(line, { size: 18, color: '444444' })], { spacing: { after: 40 } })))
  c.push(p([r(`Template Updated ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`, { size: 18, color: '444444' })], { spacing: { after: 0 } }))

  // ── Page footer: running title + page numbers ──────────────────────────────
  const pageFooter = new Footer({
    children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: FW }],
      children: [
        r(`St. Cloud Technical & Community College  ${data.course_id}: ${data.course_name} Course Syllabus`, { size: 18, color: '444444' }),
        new TextRun({ font: 'Calibri', size: 18, color: '444444', children: ['\t', 'Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES] }),
      ],
    })],
  })

  return new Document({
    title: `${data.course_id}: ${data.course_name} \u2013 ${data.semester}`,
    description: `Course syllabus for ${data.course_id}: ${data.course_name}, ${data.semester}, St. Cloud Technical & Community College`,
    creator: data.instructor_name || 'SCTCC RICT Program',
    numbering: {
      config: [
        {
          reference: 'syl-bullets',
          levels: [{
            level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 820, hanging: 360 } } },
          }],
        },
        {
          reference: 'syl-numbers',
          levels: [{
            level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 820, hanging: 360 } } },
          }],
        },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: MARGIN } },
      footers: { default: pageFooter },
      children: c,
    }],
  })
}

// ─── Post-build accessibility finalize pass ────────────────────────────────────────
// The docx npm package (verified through v9.7.1) writes every image's
// wp:docPr AND every bookmarkStart/bookmarkEnd with id="1". OOXML requires
// these IDs to be unique per document. Word itself shrugs, but Acrobat
// PDFMaker maps alt text by drawing ID, so the collision makes it drop the
// alt text from EVERY image in the converted PDF — "Image needs a
// description" is Ally's heaviest penalty, which is how a structurally
// perfect syllabus scored 54%. The library also leaves the inner pic:cNvPr
// name empty and emits no document language.
//
// This pass unzips the finished .docx in memory (fflate, already a project
// dependency), repairs all of the above with targeted string surgery on
// word/document.xml and word/styles.xml, and rezips. It never touches
// content, layout, or paragraph structure — verified byte-for-byte against
// the XSD validator with 0 paragraph changes.
//
// Fail-safe: downloadSyllabusDocx() wraps this in try/catch and falls back
// to the unpatched blob, so a surprise in a future docx version can never
// block an instructor from downloading their syllabus.
async function finalizeDocxAccessibility(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const files = unzipSync(bytes)

  // ── word/document.xml: unique IDs ──
  const DOC = 'word/document.xml'
  if (files[DOC]) {
    let xml = strFromU8(files[DOC])

    // Drawing objects: renumber every wp:docPr sequentially (1, 2, 3, ...)
    let drawingId = 0
    xml = xml.replace(/(<wp:docPr )id="\d+"/g, (_m, pre) => {
      drawingId += 1
      return `${pre}id="${drawingId}"`
    })

    // Inner non-visual picture properties: the library emits
    // <pic:cNvPr id="0" name="" descr=""/> — give each a unique id and a
    // name so strict checkers stop flagging the empty attributes. Alt text
    // itself lives on wp:docPr (set via ImageRun altText) and is untouched.
    let picId = 0
    xml = xml.replace(/<pic:cNvPr id="\d+" name=""( descr="")?\s*\/>/g, () => {
      picId += 1
      return `<pic:cNvPr id="${picId}" name="Image ${picId}"/>`
    })

    // Bookmarks: every Start/End pair shares id="1", which makes the pairing
    // ambiguous and can break the in-document navigation links. Renumber
    // with a stack so each End receives the id of its matching Start (safe
    // even if bookmarks ever nest).
    let bookmarkId = 0
    const openIds = []
    xml = xml.replace(/<w:bookmark(Start|End)\b([^>]*?)w:id="\d+"([^>]*)\/>/g, (_m, kind, pre, post) => {
      let id
      if (kind === 'Start') { bookmarkId += 1; id = bookmarkId; openIds.push(id) }
      else { id = openIds.length ? openIds.pop() : ++bookmarkId }
      return `<w:bookmark${kind}${pre}w:id="${id}"${post}/>`
    })

    // Paragraph borders: the docx library serializes <w:pBdr> children in its
    // own fixed order (top, bottom, left, right), but the OOXML schema
    // requires top, left, bottom, right, between, bar. Word forgives the
    // wrong order; strict validators and some converters do not. Reorder the
    // self-closing child elements of every pBdr block in place.
    const PBDR_ORDER = ['w:top', 'w:left', 'w:bottom', 'w:right', 'w:between', 'w:bar']
    xml = xml.replace(/<w:pBdr>([\s\S]*?)<\/w:pBdr>/g, (_m, inner) => {
      const kids = inner.match(/<w:[a-zA-Z]+\b[^>]*\/>/g) || []
      const rank = (el) => { const i = PBDR_ORDER.indexOf(el.match(/^<(w:[a-zA-Z]+)/)[1]); return i < 0 ? 99 : i }
      kids.sort((a, b) => rank(a) - rank(b))
      return `<w:pBdr>${kids.join('')}</w:pBdr>`
    })

    files[DOC] = strToU8(xml)
  }

  // ── word/styles.xml: declare the document language ──
  // The library emits an empty <w:rPrDefault/>, leaving the document with no
  // language at all. Word, Acrobat, and screen readers derive the proofing /
  // reading language from this default; setting it here also gives the
  // converted PDF its /Lang entry without relying on the converter to guess.
  const STY = 'word/styles.xml'
  if (files[STY]) {
    let sty = strFromU8(files[STY])
    const LANG = '<w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/>'
    if (!/<w:lang[\s/>]/.test(sty)) {
      if (sty.includes('<w:rPrDefault/>')) {
        sty = sty.replace('<w:rPrDefault/>', `<w:rPrDefault><w:rPr>${LANG}</w:rPr></w:rPrDefault>`)
      } else if (/<w:rPrDefault><w:rPr>/.test(sty)) {
        sty = sty.replace('<w:rPrDefault><w:rPr>', `<w:rPrDefault><w:rPr>${LANG}`)
      }
    }
    files[STY] = strToU8(sty)
  }

  const out = zipSync(files)
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
}

// ─── Browser download entry point ────────────────────────────────────────────
// Returns { logoMissing, photoMissing, logoUsedFallback } so the caller can
// warn the instructor when an image URL was set but could not be embedded
// (e.g. a cross-site URL that blocks fetch access).
//
// Logo resolution is a fallback chain: the per-course logo_url is tried
// first; if it cannot be embedded and a shared logo exists in
// syllabus_common_sections (section_key 'shared_logo'), the shared logo is
// embedded instead. A stale per-course value (dead link, revoked blob URL,
// cross-origin link) therefore degrades to the college logo rather than a
// blank box, and logoUsedFallback lets the wizard tell the instructor to
// reset the stale override.
export async function downloadSyllabusDocx(data, commonSections, defaultSections) {
  const sharedLogoUrl = String(
    (commonSections || []).find(s => s.section_key === 'shared_logo')?.content ?? ''
  ).trim()
  const [logoPrimary, photoRes] = await Promise.all([
    loadImage(data.logo_url),
    loadImage(data.course_photo_url),
  ])
  let logoRes = logoPrimary
  let logoUsedFallback = false
  if (!logoPrimary.image && sharedLogoUrl && sharedLogoUrl !== String(data.logo_url ?? '').trim()) {
    const fb = await loadImage(sharedLogoUrl)
    if (fb.image) {
      logoRes = { image: fb.image, status: `course logo failed (${logoPrimary.status}) \u2014 used the shared college logo instead` }
      logoUsedFallback = true
    } else {
      logoRes = { image: null, status: `${logoPrimary.status}; shared-logo fallback also failed (${fb.status})` }
    }
  }
  const logo = logoRes.image
  const photo = photoRes.image
  const doc = buildSyllabusDoc(data, commonSections, defaultSections, { logo, photo })
  let blob = await Packer.toBlob(doc)
  try {
    blob = await finalizeDocxAccessibility(blob)
  } catch (err) {
    // Never block the download — an unpatched file still opens fine in Word;
    // it just reverts to the docx-library duplicate-ID quirks.
    console.warn('[syllabusDocx] Accessibility finalize pass failed — downloading unpatched file', err)
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const sem = String(data.semester || '').replace(/\s+/g, '_')
  a.download = `${data.course_id || 'Course'}_Syllabus_${sem}.docx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return {
    logoMissing: !!data.logo_url && !logo,
    logoUsedFallback,
    photoMissing: !!data.course_photo_url && !photo,
    logoStatus: logoRes.status,
    photoStatus: photoRes.status,
  }
}

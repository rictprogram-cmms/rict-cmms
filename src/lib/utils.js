import { clsx } from 'clsx'

/**
 * Merge class names with clsx
 */
export function cn(...inputs) {
  return clsx(inputs)
}

/**
 * Format a date string for display
 */
export function formatDate(dateStr, options = {}) {
  if (!dateStr) return '—'
  try {
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return '—'
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...options,
    })
  } catch {
    return '—'
  }
}

/**
 * Format a date as relative time (e.g., "2 days ago")
 */
export function formatRelativeDate(dateStr) {
  if (!dateStr) return '—'
  try {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now - date
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return formatDate(dateStr)
  } catch {
    return '—'
  }
}

/**
 * Check if a date is past due
 */
export function isPastDue(dateStr) {
  if (!dateStr) return false
  try {
    return new Date(dateStr) < new Date()
  } catch {
    return false
  }
}

/**
 * Priority color mappings
 */
export const priorityConfig = {
  Critical: { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-200', dot: 'bg-red-500' },
  High:     { bg: 'bg-orange-100', text: 'text-orange-800', border: 'border-orange-200', dot: 'bg-orange-500' },
  Medium:   { bg: 'bg-yellow-100', text: 'text-yellow-800', border: 'border-yellow-200', dot: 'bg-yellow-500' },
  Low:      { bg: 'bg-green-100', text: 'text-green-800', border: 'border-green-200', dot: 'bg-green-500' },
}

/**
 * Status color mappings
 */
export const statusConfig = {
  Open:            { bg: 'bg-blue-100', text: 'text-blue-800', border: 'border-blue-200' },
  'In Progress':   { bg: 'bg-indigo-100', text: 'text-indigo-800', border: 'border-indigo-200' },
  'Awaiting Parts': { bg: 'bg-amber-100', text: 'text-amber-800', border: 'border-amber-200' },
  'On Hold':       { bg: 'bg-surface-100', text: 'text-surface-700', border: 'border-surface-200' },
  Reopened:        { bg: 'bg-purple-100', text: 'text-purple-800', border: 'border-purple-200' },
  Closed:          { bg: 'bg-emerald-100', text: 'text-emerald-800', border: 'border-emerald-200' },
}

/**
 * Get priority config with fallback
 */
export function getPriorityStyle(priority) {
  return priorityConfig[priority] || priorityConfig.Medium
}

/**
 * Get status config with fallback
 */
export function getStatusStyle(status) {
  return statusConfig[status] || { bg: 'bg-surface-100', text: 'text-surface-700', border: 'border-surface-200' }
}

/**
 * Generate display name from user profile
 */
export function displayName(profile) {
  if (!profile) return 'Unknown'
  const first = profile.first_name || profile.firstName || ''
  const last = profile.last_name || profile.lastName || ''
  if (last) return `${first} ${last.charAt(0)}.`
  return first || profile.email || 'Unknown'
}

/**
 * Role permission checks
 */
export function isInstructor(profile) {
  return profile?.role === 'Instructor'
}

export function isWorkStudy(profile) {
  return profile?.role === 'Work Study'
}

export function isStudent(profile) {
  return profile?.role === 'Student'
}

export function canManageWorkOrders(profile) {
  return profile?.role === 'Instructor' || profile?.role === 'Work Study'
}

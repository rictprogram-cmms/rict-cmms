/**
 * RICT CMMS — Shared Network Map Configuration
 *
 * Defines the network topology constants used by the Network Map page,
 * its print view, and the Assets page. Centralised here so subnet and
 * segment definitions can be updated in a single place.
 *
 * Two kinds of address space are tracked:
 *
 *   subnets   — the program's own wired /24s inside 10.171.192.0/22. The
 *               program assigns every address, so the map renders a full
 *               1–254 grid, prints wall sheets, and shows "Available" rows.
 *
 *   segments  — IT-managed address space (currently the secure wireless
 *               access point). IT hands the program specific addresses; we
 *               only record what IT gave us. The map renders a device list
 *               (no empty rows), never prints these, and only users with the
 *               `manage_it_segments` permission can add/edit/delete here.
 *
 * To add another IT-managed segment later, append an entry to `segments`.
 * No database change is required — network_devices.subnet is free text.
 *
 * File: src/lib/networkConfig.js
 */

export const NETWORK_CONFIG = {
  // Overall network
  networkCidr: '10.171.192.0/22',
  subnetMask: '255.255.252.0',
  gateway: '10.171.195.254',

  // DHCP pool (student laptops) — not tracked per-device
  dhcpPool: {
    subnet: '10.171.192.0',
    prefix: '10.171.192.',
    label: 'DHCP — Student Laptops',
    description: 'Automatic (DHCP) for student laptops',
    range: '10.171.192.1 – 10.171.192.254',
  },

  // Reserved per-device subnets (tracked, program-assigned, printed)
  subnets: [
    {
      id: '10.171.193.0',
      name: '10.171.193.0/24',
      prefix: '10.171.193.',
      shortLabel: '.193.0',
      description: 'Reserved — Equipment',
    },
    {
      id: '10.171.194.0',
      name: '10.171.194.0/24',
      prefix: '10.171.194.',
      shortLabel: '.194.0',
      description: 'Reserved — Equipment',
    },
    {
      id: '10.171.195.0',
      name: '10.171.195.0/24',
      prefix: '10.171.195.',
      shortLabel: '.195.0',
      description: 'Reserved — Equipment',
    },
  ],

  // IT-managed segments (tracked, IT-assigned, list mode, never printed)
  segments: [
    {
      id: '10.25.192.0',
      name: '10.25.192.0/24',
      prefix: '10.25.192.',
      shortLabel: 'Wireless',
      kind: 'wireless',
      managedBy: 'SCTCC IT',
      label: 'Wireless — Secure AP',
      description: 'IT-managed secure wireless access point. IT assigns each address; record them here so devices can be linked to assets.',
      subnetMask: '255.255.255.0',
      gateway: '10.25.192.254',
      // Octets that must never be assigned on this segment (gateway etc.)
      doNotUseOctets: [254],
    },
  ],

  // IPs that must never be assigned on the wired network (gateway + reserved tail)
  doNotUse: {
    subnet: '10.171.195.0',
    octets: [250, 251, 252, 253, 254],
    label: 'Do Not Use',
    description: 'Gateway and reserved — do not assign',
  },
}

// ── Segment lookup helpers ──────────────────────────────────────────────────

/**
 * Every tracked address block (wired subnets + IT-managed segments) in one
 * list, each normalised to the same shape. Wired subnets get kind 'wired'
 * and inherit the network-wide mask/gateway. Used by the map for tabs,
 * summary cards, search, and the subnet tag shown during search.
 */
export const ALL_SEGMENTS = [
  ...NETWORK_CONFIG.subnets.map(s => ({
    ...s,
    kind: 'wired',
    managedBy: 'RICT Program',
    label: s.description,
    subnetMask: NETWORK_CONFIG.subnetMask,
    gateway: NETWORK_CONFIG.gateway,
    isManaged: false,
  })),
  ...NETWORK_CONFIG.segments.map(s => ({
    ...s,
    isManaged: true,
  })),
]

/**
 * Look up a subnet or segment by its id (e.g. '10.171.193.0' or '10.25.192.0').
 * Returns the normalised ALL_SEGMENTS entry, or null.
 */
export function getSegment(id) {
  if (!id) return null
  return ALL_SEGMENTS.find(s => s.id === id) || null
}

/**
 * Derive the subnet id ('a.b.c.0') for an IP string. Returns '' if malformed.
 */
export function subnetIdForIp(ip) {
  if (!ip) return ''
  const parts = String(ip).trim().split('.')
  if (parts.length !== 4) return ''
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`
}

/**
 * Find the tracked subnet/segment that contains an IP. Returns null when the
 * IP is outside every tracked block (e.g. the DHCP pool).
 */
export function findSegmentForIp(ip) {
  return getSegment(subnetIdForIp(ip))
}

/**
 * True when the id (or the IP's block) is an IT-managed segment rather than
 * one of the program's wired subnets.
 */
export function isManagedSegmentId(id) {
  return !!getSegment(id)?.isManaged
}

/**
 * Gateway that applies to an IP. Wired subnets share the network-wide
 * gateway; IT-managed segments have their own.
 */
export function gatewayForIp(ip) {
  return findSegmentForIp(ip)?.gateway || NETWORK_CONFIG.gateway
}

/**
 * Subnet mask that applies to an IP. Wired subnets share the network-wide
 * mask; IT-managed segments have their own.
 */
export function subnetMaskForIp(ip) {
  return findSegmentForIp(ip)?.subnetMask || NETWORK_CONFIG.subnetMask
}

/**
 * True when the IP is the gateway for its block (wired or managed).
 */
export function isGatewayIp(ip) {
  if (!ip) return false
  return String(ip).trim() === gatewayForIp(ip)
}

/**
 * Build the full IP string from a subnet/segment id and last octet.
 */
export function buildIp(subnetId, octet) {
  const subnet = getSegment(subnetId)
  if (!subnet) return ''
  return `${subnet.prefix}${octet}`
}

/**
 * Check whether an IP falls inside a "do not use" range — either the wired
 * gateway/reserved tail, or an IT-managed segment's protected octets.
 */
export function isDoNotUseIp(ip) {
  if (!ip) return false
  const parts = String(ip).trim().split('.')
  if (parts.length !== 4) return false
  const subnetId = `${parts[0]}.${parts[1]}.${parts[2]}.0`
  const octet = parseInt(parts[3], 10)
  if (subnetId === NETWORK_CONFIG.doNotUse.subnet) {
    return NETWORK_CONFIG.doNotUse.octets.includes(octet)
  }
  const segment = NETWORK_CONFIG.segments.find(s => s.id === subnetId)
  if (segment) {
    return (segment.doNotUseOctets || []).includes(octet)
  }
  return false
}

/**
 * Validate a MAC address. Accepts XX-XX-XX-XX-XX-XX or XX:XX:XX:XX:XX:XX
 * (6 pairs of hex, separator either - or :).
 * Empty strings are considered valid (MAC is optional).
 */
export const MAC_REGEX = /^([0-9A-Fa-f]{2}[-:]){5}[0-9A-Fa-f]{2}$/

export function isValidMac(mac) {
  if (!mac) return true
  return MAC_REGEX.test(mac.trim())
}

/**
 * Normalise a MAC address to uppercase with hyphen separators.
 */
export function normaliseMac(mac) {
  if (!mac) return ''
  const cleaned = mac.trim().replace(/:/g, '-').toUpperCase()
  return cleaned
}

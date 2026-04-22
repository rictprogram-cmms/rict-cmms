/**
 * RICT CMMS — Shared Network Map Configuration
 *
 * Defines the network topology constants used by the Network Map page
 * and its print view. Centralised here so subnet definitions can be
 * updated in a single place.
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

  // Reserved per-device subnets (tracked)
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

  // IPs that must never be assigned (gateway + reserved tail)
  doNotUse: {
    subnet: '10.171.195.0',
    octets: [250, 251, 252, 253, 254],
    label: 'Do Not Use',
    description: 'Gateway and reserved — do not assign',
  },
}

/**
 * Build the full IP string from a subnet and last octet.
 */
export function buildIp(subnetId, octet) {
  const subnet = NETWORK_CONFIG.subnets.find(s => s.id === subnetId)
  if (!subnet) return ''
  return `${subnet.prefix}${octet}`
}

/**
 * Check whether an IP falls inside the "do not use" range.
 */
export function isDoNotUseIp(ip) {
  if (!ip) return false
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const subnetId = `${parts[0]}.${parts[1]}.${parts[2]}.0`
  const octet = parseInt(parts[3], 10)
  if (subnetId !== NETWORK_CONFIG.doNotUse.subnet) return false
  return NETWORK_CONFIG.doNotUse.octets.includes(octet)
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

import dns from 'node:dns';
import { getAllowedDomains } from './manager.js';

const BLOCKED_PROTOCOLS = new Set(['file:', 'javascript:', 'data:', 'ftp:', 'blob:']);

// Private/internal IP ranges — prevent SSRF
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

// Decimal IP notation: e.g. 2130706433 = 127.0.0.1
const DECIMAL_IP_RE = /^\d{8,10}$/;
// Octal IP notation: e.g. 0177.0.0.1 = 127.0.0.1
const OCTAL_IP_RE = /^0\d+(\.\d+){0,3}$/;

function isBlockedIP(hostname: string): boolean {
  if (BLOCKED_HOSTS.has(hostname)) return true;

  // Block decimal IP notation (e.g. 2130706433)
  if (DECIMAL_IP_RE.test(hostname)) return true;
  // Block octal IP notation (e.g. 0177.0.0.1)
  if (OCTAL_IP_RE.test(hostname)) return true;

  // 10.x.x.x
  if (hostname.startsWith('10.')) return true;
  // 172.16.0.0 – 172.31.255.255
  if (hostname.startsWith('172.')) {
    const second = parseInt(hostname.split('.')[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  // 192.168.x.x
  if (hostname.startsWith('192.168.')) return true;
  // 169.254.x.x (link-local)
  if (hostname.startsWith('169.254.')) return true;
  return false;
}

/**
 * Check if a resolved IP address is in a private/internal range.
 */
function isPrivateIP(ip: string): boolean {
  // IPv4
  if (ip === '127.0.0.1' || ip === '0.0.0.0') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1], 10);
    if (second >= 16 && second <= 31) return true;
  }

  // IPv6 loopback and private
  if (ip === '::1') return true;
  if (ip === '::') return true;
  // IPv4-mapped IPv6: ::ffff:127.0.0.1, ::ffff:10.x.x.x, etc.
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice(7);
    // Could be dotted notation (::ffff:127.0.0.1) or hex (::ffff:7f00:1)
    if (mapped.includes('.')) {
      return isPrivateIP(mapped);
    }
    // Hex form: ::ffff:7f00:1 = 127.0.0.1, ::ffff:a00:1 = 10.0.0.1
    const parts = mapped.split(':');
    if (parts.length === 2) {
      const high = parseInt(parts[0], 16);
      const low = parseInt(parts[1], 16);
      const octet1 = (high >> 8) & 0xff;
      const octet2 = high & 0xff;
      const octet3 = (low >> 8) & 0xff;
      const octet4 = low & 0xff;
      const ipv4 = `${octet1}.${octet2}.${octet3}.${octet4}`;
      return isPrivateIP(ipv4);
    }
  }
  // fe80::/10 link-local
  if (ip.toLowerCase().startsWith('fe80:')) return true;
  // fc00::/7 unique local
  const firstTwo = ip.toLowerCase().slice(0, 2);
  if (firstTwo === 'fc' || firstTwo === 'fd') return true;

  return false;
}

export async function validateUrl(url: string): Promise<{ valid: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: `Invalid URL: ${url}` };
  }

  // Protocol check
  if (BLOCKED_PROTOCOLS.has(parsed.protocol)) {
    return { valid: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: `Unsupported protocol: ${parsed.protocol}` };
  }

  // Internal network check (string-based)
  const hostname = parsed.hostname;
  if (isBlockedIP(hostname)) {
    return { valid: false, reason: `Blocked internal address: ${hostname}` };
  }

  // Domain allowlist (if configured)
  const allowed = getAllowedDomains();
  if (allowed) {
    const matches = allowed.some(
      (d) => hostname === d || hostname.endsWith('.' + d),
    );
    if (!matches) {
      return { valid: false, reason: `Domain not in allowlist: ${hostname}` };
    }
  }

  // DNS rebinding protection: resolve hostname and check resolved IP
  try {
    const { address } = await dns.promises.lookup(hostname);
    if (isPrivateIP(address)) {
      return { valid: false, reason: `DNS resolved to private IP: ${address} (possible DNS rebinding)` };
    }
  } catch {
    return { valid: false, reason: `DNS resolution failed for ${hostname}` };
  }

  return { valid: true };
}

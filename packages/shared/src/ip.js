// Pure-JS IP range matching, so the same SSRF rules run on Node, Workers and Lambda alike
// (net.BlockList is Node-only). Range list matches the forward proxy's.

// loopback, private, CGNAT, link-local (incl. cloud metadata), multicast and reserved
export const PRIVATE_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

// 4, 6 or 0, like net.isIP
export function ipFamily(str) {
  if (parseIPv4(str) !== null) return 4;
  if (parseIPv6(str) !== null) return 6;
  return 0;
}

// dotted quad → unsigned 32-bit number, or null
export function parseIPv4(str) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(str);
  if (!match) return null;

  let value = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(match[i]);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

// textual IPv6 (optionally bracketed, with zone id, with embedded IPv4) → BigInt, or null
export function parseIPv6(str) {
  if (typeof str !== "string") return null;
  let text = str.replace(/^\[|\]$/g, "").split("%")[0];
  if (!text.includes(":")) return null;

  // trailing dotted quad (::ffff:192.0.2.1) becomes two hex groups
  if (text.includes(".")) {
    const cut = text.lastIndexOf(":");
    const embedded = parseIPv4(text.slice(cut + 1));
    if (embedded === null) return null;
    text = `${text.slice(0, cut + 1)}${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  let groups;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...new Array(8 - head.length - tail.length).fill("0"), ...tail];
  }

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

const V4_RANGES = [];
const V6_RANGES = [];
for (const [prefix, bits] of PRIVATE_RANGES) {
  const v4 = parseIPv4(prefix);
  if (v4 !== null) V4_RANGES.push({ start: v4, bits });
  else V6_RANGES.push({ start: parseIPv6(prefix), bits });
}

function inV4Range(address, { start, bits }) {
  const shift = 32 - bits;
  return address >>> shift === start >>> shift;
}

function inV6Range(address, { start, bits }) {
  const shift = BigInt(128 - bits);
  return address >> shift === start >> shift;
}

// true for loopback/private/link-local/multicast/reserved addresses, including IPv4-mapped IPv6
export function isPrivateAddress(ip) {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return V4_RANGES.some((range) => inV4Range(v4, range));

  const v6 = parseIPv6(ip);
  if (v6 === null) return false;

  // ::ffff:a.b.c.d → judge by the IPv4 rules
  if (v6 >> 32n === 0xffffn) return V4_RANGES.some((range) => inV4Range(Number(v6 & 0xffffffffn), range));

  return V6_RANGES.some((range) => inV6Range(v6, range));
}

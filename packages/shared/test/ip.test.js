import test from "node:test";
import assert from "node:assert/strict";
import { ipFamily, parseIPv4, parseIPv6, isPrivateAddress } from "../src/ip.js";

test("parseIPv4 accepts dotted quads and rejects everything else", () => {
  assert.equal(parseIPv4("0.0.0.0"), 0);
  assert.equal(parseIPv4("255.255.255.255"), 0xffffffff);
  assert.equal(parseIPv4("192.168.1.5"), (192 << 24 >>> 0) + (168 << 16) + (1 << 8) + 5);
  for (const bad of ["256.1.1.1", "1.2.3", "1.2.3.4.5", "a.b.c.d", "", " 1.2.3.4", "1.2.3.4 "]) {
    assert.equal(parseIPv4(bad), null, bad);
  }
});

test("parseIPv6 handles compression, brackets, zone ids and embedded IPv4", () => {
  assert.equal(parseIPv6("::"), 0n);
  assert.equal(parseIPv6("::1"), 1n);
  assert.equal(parseIPv6("[::1]"), 1n);
  assert.equal(parseIPv6("fe80::1%eth0"), (0xfe80n << 112n) | 1n);
  assert.equal(parseIPv6("2001:db8::"), 0x20010db8n << 96n);
  assert.equal(parseIPv6("::ffff:192.0.2.1"), (0xffffn << 32n) | 0xc0000201n);
  assert.equal(parseIPv6("1:2:3:4:5:6:7:8"), 0x00010002000300040005000600070008n);
  for (const bad of ["1:::2", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "::g", "1.2.3.4", "", "::ffff:999.1.1.1"]) {
    assert.equal(parseIPv6(bad), null, bad);
  }
});

test("ipFamily mirrors net.isIP", () => {
  assert.equal(ipFamily("10.0.0.1"), 4);
  assert.equal(ipFamily("::1"), 6);
  assert.equal(ipFamily("example.com"), 0);
  assert.equal(ipFamily("[::1]"), 6);
});

test("isPrivateAddress blocks every reserved IPv4 range", () => {
  const blocked = [
    "0.0.0.0", "0.255.255.255",
    "10.0.0.1", "10.255.255.255",
    "100.64.0.1", "100.127.255.255",
    "127.0.0.1", "127.255.255.255",
    "169.254.169.254", "169.254.0.1",
    "172.16.0.1", "172.31.255.255",
    "192.0.0.1",
    "192.168.1.1", "192.168.255.255",
    "198.18.0.1", "198.19.255.255",
    "224.0.0.1", "239.255.255.255",
    "240.0.0.1", "255.255.255.255",
  ];
  for (const ip of blocked) assert.equal(isPrivateAddress(ip), true, ip);
});

test("isPrivateAddress allows public IPv4", () => {
  const allowed = ["1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.0.1.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", "93.184.216.34"];
  for (const ip of allowed) assert.equal(isPrivateAddress(ip), false, ip);
});

test("isPrivateAddress handles IPv6 ranges and IPv4-mapped addresses", () => {
  for (const ip of ["::", "::1", "[::1]", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%lo", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:169.254.169.254"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["2001:db8::1", "2606:4700::1111", "::ffff:8.8.8.8", "fe00::1", "fec0::1"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("isPrivateAddress is false for non-addresses", () => {
  for (const value of ["localhost", "example.com", "", null, undefined, 42]) {
    assert.equal(isPrivateAddress(value), false, String(value));
  }
});

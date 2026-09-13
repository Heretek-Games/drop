// base32 elements
//RFC4648: why include 2? Z and 2 looks similar than 8 and O
const b32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
console.assert(b32.length === 32, b32.length);
//[constants derived from character table size]
//cbit = 5 (as 32 == 2 ** 5), ubit = 8 (as byte)
//ccount = 8 (= cbit / gcd(cbit, ubit)), ucount = 5 (= ubit / gcd(cbit, ubit))
//cmask = 0x1f (= 2 ** cbit - 1), umask = 0xff (= 2 ** ubit - 1)
//const b32pad = [0, 6, 4, 3, 1];
const b32pad = Array.from(
  new Array(5),
  (_, i) => Math.trunc(8 - (i * 8) / 5) % 8,
);

function b32e5(u1, u2 = 0, u3 = 0, u4 = 0, u5 = 0) {
  const u40 = u1 * 2 ** 32 + u2 * 2 ** 24 + u3 * 2 ** 16 + u4 * 2 ** 8 + u5;
  return [
    b32[(u40 / 2 ** 35) & 0x1f],
    b32[(u40 / 2 ** 30) & 0x1f],
    b32[(u40 / 2 ** 25) & 0x1f],
    b32[(u40 / 2 ** 20) & 0x1f],
    b32[(u40 / 2 ** 15) & 0x1f],
    b32[(u40 / 2 ** 10) & 0x1f],
    b32[(u40 / 2 ** 5) & 0x1f],
    b32[u40 & 0x1f],
  ];
}
// base32 encode: Uint8Array => string
export function b32e(u8a) {
  console.assert(u8a instanceof Uint8Array, u8a.constructor);
  const len = u8a.length,
    rem = len % 5;
  const u5s = Array.from(new Array((len - rem) / 5), (_, i) =>
    u8a.subarray(i * 5, i * 5 + 5),
  );
  const pad = b32pad[rem];
  const br = rem === 0 ? [] : b32e5(...u8a.subarray(-rem)).slice(0, 8 - pad);
  return []
    .concat(...u5s.map((u5) => b32e5(...u5)), br, ["=".repeat(pad)])
    .join("");
}

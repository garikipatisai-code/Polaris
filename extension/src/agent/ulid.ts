// 26-char lexicographically sortable ID. Crockford base32 alphabet (no I/L/O/U).
// First 10 chars encode the millisecond timestamp; next 16 chars are random.
// Sortable by creation time, ~80 bits of entropy.

const ALPH = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let t = now;
  const timeStr = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeStr[i] = ALPH[t % 32]!;
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let randStr = '';
  for (let i = 0; i < 16; i++) {
    randStr += ALPH[rand[i]! & 31];
  }
  return timeStr.join('') + randStr;
}

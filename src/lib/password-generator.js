import { randomInt } from "node:crypto";

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghjkmnpqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "#@$%&*";

/** One-time credential suitable for owner temporary passwords. */
export function generateTemporaryPassword(length = 12) {
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const pick = (chars) => chars[randomInt(chars.length)];
  const required = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (required.length < length) required.push(pick(all));
  for (let i = required.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [required[i], required[j]] = [required[j], required[i]];
  }
  return required.join("");
}

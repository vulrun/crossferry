export function splitStr(str, splitBy = ",") {
  return String(str || "")
    .split(splitBy)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parsePositiveInt(value, fallback) {
  const num = parseInt(value, 10);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

// only the literal strings "true"/"false" (any case) change the default
export function parseBool(value, fallback) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return fallback;
}

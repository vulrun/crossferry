// "[YYYY-MM-DD HH:MM:SS]", the same shape the forward proxy logs
export function timestamp(date = new Date()) {
  return `[${date.toISOString().split(".")[0].replace("T", " ")}]`;
}

// access lines go to stdout, error lines to stderr; each is gated by its own flag
export function createLogger({ access = false, errors = false, out = console } = {}) {
  return {
    access(label, ...parts) {
      if (!access) return;
      out.log(timestamp(), `[${String(label || "ACCESS").toUpperCase()}]`, ...parts);
    },
    error(label, ...parts) {
      if (!errors) return;
      out.error(timestamp(), `[${String(label || "ERROR").toUpperCase()}]`, ...parts);
    },
  };
}

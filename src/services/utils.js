const dayjs = require("dayjs");

function nowISO() {
  return new Date().toISOString();
}

function parseTimeHHMM(text) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text || "");
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function weekdayToNum(w) {
  const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  return map[(w || "").toLowerCase()];
}

function parseScheduleArgs(rawArgs) {
  if (!rawArgs || rawArgs.length === 0) return null;

  if (rawArgs.length === 1) {
    const hhmm = parseTimeHHMM(rawArgs[0]);
    if (!hhmm) return null;
    return { type: "daily", time_hhmm: hhmm, weekday: null, run_at: null };
  }

  if ((rawArgs[0] || "").toLowerCase() === "weekly" && rawArgs.length === 3) {
    const weekday = weekdayToNum(rawArgs[1]);
    const hhmm = parseTimeHHMM(rawArgs[2]);
    if (weekday === undefined || !hhmm) return null;
    return { type: "weekly", time_hhmm: hhmm, weekday, run_at: null };
  }

  if ((rawArgs[0] || "").toLowerCase() === "once" && rawArgs.length === 3) {
    const dt = dayjs(`${rawArgs[1]} ${rawArgs[2]}`);
    if (!dt.isValid()) return null;
    return { type: "once", time_hhmm: null, weekday: null, run_at: dt.toISOString() };
  }

  return null;
}

module.exports = { nowISO, parseScheduleArgs };
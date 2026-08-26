import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

/**
 * A JSON-file store. Deliberately not SQLite: this dataset is small (thousands
 * of lots at most), and a native module would make `npm install` fragile on
 * whatever machine you run this from. Writes are atomic via rename.
 */
const DATA_DIR = path.join(ROOT, 'data');
const LOTS_FILE = path.join(DATA_DIR, 'lots.json');
const COMPS_FILE = path.join(DATA_DIR, 'comps.json');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${path.basename(file)}: ${err.message}. Starting fresh.`);
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export class Store {
  constructor() {
    this.lots = readJson(LOTS_FILE, {});     // id -> lot
    this.comps = readJson(COMPS_FILE, {});   // queryKey -> { fetchedAt, result }
    this.runs = readJson(RUNS_FILE, []);     // refresh history
  }

  /**
   * Merge a freshly-scraped lot over what we already knew, keeping a bid
   * history so you can see which lots are heating up.
   */
  upsertLot(lot) {
    const now = new Date().toISOString();
    const prev = this.lots[lot.id];

    if (!prev) {
      this.lots[lot.id] = {
        ...lot,
        firstSeenAt: now,
        lastSeenAt: now,
        bidHistory: lot.currentBid == null ? [] : [{ at: now, bid: lot.currentBid }],
      };
      return { isNew: true, bidChanged: false };
    }

    const bidChanged = lot.currentBid != null && lot.currentBid !== prev.currentBid;
    const bidHistory = prev.bidHistory ?? [];
    if (bidChanged) bidHistory.push({ at: now, bid: lot.currentBid });

    this.lots[lot.id] = {
      ...prev,
      ...lot,
      firstSeenAt: prev.firstSeenAt,
      lastSeenAt: now,
      // Never let a failed re-scrape blank out analysis we already have.
      comps: lot.comps ?? prev.comps,
      valuation: lot.valuation ?? prev.valuation,
      bidHistory,
    };
    return { isNew: false, bidChanged };
  }

  getLot(id) { return this.lots[id]; }
  allLots() { return Object.values(this.lots); }

  getComps(queryKey, maxAgeHours) {
    const hit = this.comps[queryKey];
    if (!hit) return null;
    const ageHours = (Date.now() - new Date(hit.fetchedAt).getTime()) / 3_600_000;
    return ageHours > maxAgeHours ? null : hit.result;
  }

  putComps(queryKey, result) {
    this.comps[queryKey] = { fetchedAt: new Date().toISOString(), result };
  }

  recordRun(run) {
    this.runs.unshift({ ...run, at: new Date().toISOString() });
    this.runs = this.runs.slice(0, 100);
  }

  lastRun() { return this.runs[0] ?? null; }

  /** Drop lots whose auction ended more than `days` ago, to keep the file small. */
  prune(days = 30) {
    const cutoff = Date.now() - days * 86_400_000;
    let removed = 0;
    for (const [id, lot] of Object.entries(this.lots)) {
      const ends = lot.endsAt ? new Date(lot.endsAt).getTime() : null;
      const seen = new Date(lot.lastSeenAt).getTime();
      if ((ends && ends < cutoff) || seen < cutoff) {
        delete this.lots[id];
        removed++;
      }
    }
    return removed;
  }

  save() {
    writeJson(LOTS_FILE, this.lots);
    writeJson(COMPS_FILE, this.comps);
    writeJson(RUNS_FILE, this.runs);
  }
}

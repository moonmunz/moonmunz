/**
 * Turning an estate-sale lot title into a good eBay query, and deciding how
 * much to trust the comps that come back.
 *
 * This is the part most likely to produce garbage, so it's built to be
 * skeptical. A confident-looking $400 spread built on comps for the wrong
 * object is worse than no result at all -- it costs you a drive and a bid.
 */

/** Words that appear in estate listings and only add noise to an eBay query. */
const STOPWORDS = new Set([
  'lot', 'lots', 'box', 'group', 'grouping', 'assorted', 'misc', 'miscellaneous',
  'and', 'the', 'of', 'with', 'in', 'a', 'an', 'or', 'for', 'to', 'set',
  'nice', 'beautiful', 'lovely', 'great', 'estate', 'vintage', 'antique',
  'old', 'large', 'small', 'pair', 'piece', 'pieces', 'approx', 'approximately',
  'various', 'items', 'item', 'collection', 'as', 'is', 'condition', 'see',
  'photos', 'photo', 'pictures', 'more', 'other', 'etc', 'unknown', 'no',
  'damage', 'wear', 'used', 'new', 'style', 'type', 'signed', 'marked',
]);

/**
 * Brand/maker names carry nearly all the pricing signal in this category.
 * If a title contains one, the query is built around it and confidence rises.
 */
const HIGH_SIGNAL_TERMS = [
  'sterling', 'silver', 'gold', '14k', '18k', '10k', '925',
  'tiffany', 'cartier', 'rolex', 'omega', 'seiko', 'hamilton', 'elgin', 'waltham',
  'herman miller', 'eames', 'knoll', 'stickley', 'ethan allen', 'baker',
  'wedgwood', 'limoges', 'meissen', 'royal doulton', 'lenox', 'waterford',
  'lalique', 'baccarat', 'steuben', 'tiffin', 'fenton', 'roseville', 'weller',
  'reed barton', 'gorham', 'towle', 'wallace', 'international silver',
  'louis vuitton', 'gucci', 'hermes', 'chanel', 'coach', 'prada',
  'nikon', 'canon', 'leica', 'hasselblad', 'polaroid',
  'fender', 'gibson', 'martin', 'yamaha', 'steinway',
  'persian', 'oriental', 'heriz', 'tabriz', 'kilim',
  'pyrex', 'le creuset', 'cast iron', 'griswold', 'wagner',
  'pokemon', 'topps', 'panini', 'funko', 'lego',
];

/**
 * Build an eBay query from a lot title.
 * Strategy: keep proper nouns, model numbers, and high-signal terms; drop
 * filler adjectives that make the query match everything and price nothing.
 */
export function buildQuery(title) {
  const lower = title.toLowerCase();

  const matchedBrands = HIGH_SIGNAL_TERMS.filter((t) => lower.includes(t));

  const tokens = title
    .replace(/[^\w\s&'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const kept = tokens.filter((tok) => {
    const t = tok.toLowerCase();
    if (STOPWORDS.has(t)) return false;
    if (t.length < 2) return false;
    // Keep anything with a digit -- model numbers, years, sizes, karat marks.
    if (/\d/.test(t)) return true;
    return true;
  });

  // Cap length: long queries return zero results on eBay.
  const query = kept.slice(0, 7).join(' ').trim();

  return {
    query: query || title.slice(0, 60),
    matchedBrands,
    droppedCount: tokens.length - kept.length,
  };
}

/**
 * How much do we trust this comp set? Returns 0..1.
 *
 * Drivers:
 *  - a recognized brand/maker in the title (the strongest signal)
 *  - enough comps to have a real distribution
 *  - price agreement among comps (tight spread = a real market price)
 *  - token overlap between the lot title and the comp titles
 *  - penalties for "lot of"/"assorted" titles, which never comp cleanly
 */
export function scoreConfidence(lot, queryInfo, comps) {
  if (comps.length === 0) return { score: 0, reasons: ['no comps found'] };

  const reasons = [];
  let score = 0.2;

  if (queryInfo.matchedBrands.length > 0) {
    score += 0.25;
    reasons.push(`recognized maker: ${queryInfo.matchedBrands.join(', ')}`);
  } else {
    reasons.push('no recognized maker in title');
  }

  if (comps.length >= 10) { score += 0.15; reasons.push(`${comps.length} comps`); }
  else if (comps.length >= 5) { score += 0.10; reasons.push(`${comps.length} comps`); }
  else { reasons.push(`only ${comps.length} comps`); }

  // Price agreement: coefficient of variation on the comp prices.
  const prices = comps.map((c) => c.price);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const sd = Math.sqrt(prices.reduce((a, p) => a + (p - mean) ** 2, 0) / prices.length);
  const cv = mean > 0 ? sd / mean : 99;
  if (cv < 0.4) { score += 0.2; reasons.push('comp prices agree closely'); }
  else if (cv < 0.8) { score += 0.1; reasons.push('comp prices vary moderately'); }
  else { score -= 0.1; reasons.push('comp prices vary wildly'); }

  // Title overlap between the lot and its comps.
  const lotTokens = new Set(tokenize(lot.title));
  const overlaps = comps.map((c) => {
    const compTokens = new Set(tokenize(c.title));
    const shared = [...lotTokens].filter((t) => compTokens.has(t)).length;
    return lotTokens.size > 0 ? shared / lotTokens.size : 0;
  });
  const avgOverlap = overlaps.reduce((a, b) => a + b, 0) / overlaps.length;
  if (avgOverlap > 0.5) { score += 0.2; reasons.push('comp titles match well'); }
  else if (avgOverlap > 0.3) { score += 0.1; reasons.push('comp titles partially match'); }
  else { score -= 0.15; reasons.push('comp titles are a weak match'); }

  // Multi-item lots can't be comped against single-item listings.
  if (/\b(lot|group|assorted|collection|box)\b/i.test(lot.title)) {
    score -= 0.2;
    reasons.push('multi-item lot -- single-item comps understate/overstate');
  }

  return { score: clamp(score, 0, 1), reasons };
}

function tokenize(s) {
  return s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

export { HIGH_SIGNAL_TERMS, STOPWORDS };

import { config } from '../config.js';

export interface FilterableJob {
  title?: string | null;
  department?: string | null;
  team?: string | null;
  location?: string | null;
}

export interface TitleFilterOptions {
  include?: string[];
  exclude?: string[];
  /** Require a location that looks US-based. Default true. */
  usOnly?: boolean;
}

// Tokens that reliably indicate a non-US location. Matched as substrings on a
// lowercased location string. Fail-open: if none match, we assume the role is
// US / remote-US / ambiguous (the AI layer makes the final call).
const NON_US_LOCATION_TOKENS = [
  'united kingdom', ' uk', 'london', 'dublin', 'ireland',
  'germany', 'berlin', 'munich',
  'france', 'paris',
  'spain', 'madrid', 'barcelona',
  'netherlands', 'amsterdam',
  'italy', 'milan', 'rome',
  'belgium', 'brussels',
  'switzerland', 'zurich', 'geneva',
  'sweden', 'stockholm',
  'norway', 'oslo',
  'denmark', 'copenhagen',
  'finland', 'helsinki',
  'poland', 'warsaw', 'krakow',
  'portugal', 'lisbon',
  'canada', 'toronto', 'vancouver', 'montreal', 'ottawa',
  'mexico', 'brazil', 'argentina', 'chile', 'colombia',
  'india', 'bangalore', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai',
  'china', 'shanghai', 'beijing', 'shenzhen',
  'hong kong', 'taiwan', 'taipei',
  'japan', 'tokyo',
  'korea', 'seoul',
  'singapore',
  'australia', 'sydney', 'melbourne',
  'new zealand', 'auckland',
  'israel', 'tel aviv',
  'uae', 'dubai',
  'south africa', 'johannesburg', 'cape town',
  'nigeria', 'lagos', 'kenya', 'nairobi',
  'philippines', 'manila',
  'malaysia', 'indonesia', 'vietnam', 'thailand', 'bangkok',
  'emea', 'apac', 'latam', 'europe only', 'remote - europe', 'remote (europe)',
];

// Strong positive US indicators. If any match, accept even if a blacklist
// token also appears (rare, but e.g. "New York, US / London, UK" job boards).
const US_LOCATION_TOKENS = [
  'united states', ' usa', ', us', '(us)', 'u.s.', 'u.s.a',
  'remote - us', 'remote (us)', 'us remote', 'us-only', 'us only',
  // States / common metros — not exhaustive, just high-signal.
  'new york', 'san francisco', 'los angeles', 'seattle', 'boston', 'chicago',
  'austin', 'denver', 'atlanta', 'miami', 'washington, d', 'washington dc',
  ', ca', ', ny', ', tx', ', wa', ', ma', ', il', ', co', ', ga', ', fl',
  ', va', ', md', ', nj', ', pa', ', oh', ', mi', ', nc', ', az', ', or',
  ', mn', ', ut', ', tn', ', in', ', mo', ', wi',
];

function isLikelyNonUSLocation(location: string): boolean {
  const loc = location.toLowerCase();
  if (US_LOCATION_TOKENS.some((t) => loc.includes(t))) return false;
  return NON_US_LOCATION_TOKENS.some((t) => loc.includes(t));
}

/**
 * Fetch-layer filter. Intentionally permissive — the AI layer makes the final
 * new-grad / seniority determination. Three cheap string checks:
 *   1. Exclude: reject on anti-keywords in the title (sales, marketing, senior, etc.)
 *   2. Include: require at least one broad tech keyword in the title
 *   3. Location: reject obviously non-US roles (optional)
 */
export function passesTitleFilter(job: FilterableJob, options: TitleFilterOptions = {}): boolean {
  const title = (job.title || '').toLowerCase();
  if (!title) return false;

  const include = options.include ?? config.ashbyIncludeKeywords;
  const exclude = options.exclude ?? config.ashbyExcludeKeywords;
  const usOnly = options.usOnly ?? config.ashbyUsOnly;

  if (exclude.some((kw) => title.includes(kw))) return false;
  if (include.length && !include.some((kw) => title.includes(kw))) return false;

  if (usOnly && job.location && isLikelyNonUSLocation(job.location)) return false;

  return true;
}

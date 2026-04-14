// Ported verbatim from backend/src/services/job-filter.ts, with the `../config`
// coupling removed — callers must supply include/exclude/usOnly explicitly.
// Keep logic in sync; changes here must be mirrored in legacy backend until
// the legacy pipeline is retired.

export interface FilterableJob {
  title?: string | null;
  department?: string | null;
  team?: string | null;
  location?: string | null;
}

export interface TitleFilterOptions {
  include?: string[];
  exclude?: string[];
  usOnly?: boolean;
}

const NON_US_LOCATION_TOKENS = [
  "united kingdom", " uk", "london", "dublin", "ireland",
  "germany", "berlin", "munich",
  "france", "paris",
  "spain", "madrid", "barcelona",
  "netherlands", "amsterdam",
  "italy", "milan", "rome",
  "belgium", "brussels",
  "switzerland", "zurich", "geneva",
  "sweden", "stockholm",
  "norway", "oslo",
  "denmark", "copenhagen",
  "finland", "helsinki",
  "poland", "warsaw", "krakow",
  "portugal", "lisbon",
  "canada", "toronto", "vancouver", "montreal", "ottawa",
  "mexico", "brazil", "argentina", "chile", "colombia",
  "india", "bangalore", "mumbai", "delhi", "hyderabad", "pune", "chennai",
  "china", "shanghai", "beijing", "shenzhen",
  "hong kong", "taiwan", "taipei",
  "japan", "tokyo",
  "korea", "seoul",
  "singapore",
  "australia", "sydney", "melbourne",
  "new zealand", "auckland",
  "israel", "tel aviv",
  "uae", "dubai",
  "south africa", "johannesburg", "cape town",
  "nigeria", "lagos", "kenya", "nairobi",
  "philippines", "manila",
  "malaysia", "indonesia", "vietnam", "thailand", "bangkok",
  "emea", "apac", "latam", "europe only", "remote - europe", "remote (europe)",
];

const US_SUBSTRING_TOKENS = [
  "united states", " usa", "(us)", "u.s.", "u.s.a",
  "remote - us", "remote (us)", "us remote", "us-only", "us only",
  "new york", "san francisco", "los angeles", "seattle", "boston", "chicago",
  "austin", "denver", "atlanta", "miami", "washington, d", "washington dc",
];

// US state abbreviations matched at a word boundary so we don't false-positive
// on e.g. ", India" matching ", in". Fix for a latent bug in the legacy
// backend filter (see GitHub issue).
const US_STATE_ABBR = [
  "ca", "ny", "tx", "wa", "ma", "il", "co", "ga", "fl",
  "va", "md", "nj", "pa", "oh", "mi", "nc", "az", "or",
  "mn", "ut", "tn", "in", "mo", "wi", "us",
];
const US_STATE_REGEX = new RegExp(
  `,\\s*(?:${US_STATE_ABBR.join("|")})(?![a-z])`,
  "i",
);

export function isLikelyNonUSLocation(location: string): boolean {
  const loc = location.toLowerCase();
  if (US_SUBSTRING_TOKENS.some((t) => loc.includes(t))) return false;
  if (US_STATE_REGEX.test(location)) return false;
  return NON_US_LOCATION_TOKENS.some((t) => loc.includes(t));
}

export const DEFAULT_INCLUDE_KEYWORDS = [
  "engineer", "developer", "data", "ml", "ai", "research", "scientist",
];
export const DEFAULT_EXCLUDE_KEYWORDS = [
  "senior", "staff", "principal", "lead", "director", "manager",
  "vp", "head of", "chief",
];

export function passesTitleFilter(
  job: FilterableJob,
  options: TitleFilterOptions = {},
): boolean {
  const title = (job.title || "").toLowerCase();
  if (!title) return false;

  const include = options.include ?? DEFAULT_INCLUDE_KEYWORDS;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE_KEYWORDS;
  const usOnly = options.usOnly ?? true;

  if (exclude.some((kw) => title.includes(kw))) return false;
  if (include.length && !include.some((kw) => title.includes(kw))) return false;
  if (usOnly && job.location && isLikelyNonUSLocation(job.location)) return false;

  return true;
}

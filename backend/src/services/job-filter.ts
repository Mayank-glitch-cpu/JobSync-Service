import { config } from '../config.js';

export interface FilterableJob {
  title?: string | null;
  department?: string | null;
  team?: string | null;
}

export interface TitleFilterOptions {
  include?: string[];
  exclude?: string[];
  newGradKeywords?: string[];
  newGradOnly?: boolean;
}

/**
 * Three-layer title filter for board fetchers (Ashby, Greenhouse, Lever, Workable,
 * Recruitee, SmartRecruiters). Exclude → Include → (optional) new-grad.
 *
 * Defaults come from config.ashby* fields — originally Ashby-specific, now shared.
 */
export function passesTitleFilter(job: FilterableJob, options: TitleFilterOptions = {}): boolean {
  const title = (job.title || '').toLowerCase();
  if (!title) return false;

  const include = options.include ?? config.ashbyIncludeKeywords;
  const exclude = options.exclude ?? config.ashbyExcludeKeywords;
  const newGradKeywords = options.newGradKeywords ?? config.ashbyNewGradKeywords;
  const newGradOnly = options.newGradOnly ?? config.ashbyNewGradOnly;

  if (exclude.some((kw) => title.includes(kw))) return false;
  if (include.length && !include.some((kw) => title.includes(kw))) return false;
  if (newGradOnly && !newGradKeywords.some((kw) => title.includes(kw))) return false;

  return true;
}

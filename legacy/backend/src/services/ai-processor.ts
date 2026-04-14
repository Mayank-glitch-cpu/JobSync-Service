import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { log } from '../logger.js';
import { readStep, writeStep } from '../store.js';
import { INDUSTRY_LIST, detectIndustry } from '../constants/industries.js';
import type { ScrapedJob, ProcessedJob, JobBoard } from '../types.js';

// Known H1B sponsor companies (sourced from H1B LCA filings data)
const H1B_SPONSOR_COMPANIES: string[] = [
  'amazon', 'google', 'alphabet', 'apple', 'meta platforms', 'meta', 'facebook',
  'microsoft', 'netflix', 'nvidia', 'tesla', 'amazon web services', 'aws',
  'amazon development center', 'amazon data services', 'salesforce', 'oracle',
  'ibm', 'intel', 'cisco systems', 'cisco', 'adobe', 'qualcomm', 'linkedin',
  'paypal', 'intuit', 'servicenow', 'uber technologies', 'uber', 'bytedance',
  'tiktok', 'palo alto networks', 'snowflake', 'databricks', 'stripe', 'airbnb',
  'doordash', 'coinbase', 'spotify', 'pinterest', 'snap', 'x corp', 'twitter',
  'palantir', 'atlassian', 'shopify', 'block', 'square', 'cloudflare',
  'crowdstrike', 'zscaler', 'datadog', 'mongodb', 'elastic', 'hashicorp',
  'confluent', 'twilio', 'okta', 'splunk', 'vmware', 'broadcom', 'amd',
  'micron technology', 'micron', 'texas instruments', 'marvell technology',
  'marvell', 'applied materials', 'lam research', 'kla corporation', 'kla',
  'synopsys', 'cadence design systems', 'cadence', 'arm holdings', 'arm',
  'analog devices', 'on semiconductor', 'onsemi', 'microchip technology',
  'globalfoundries', 'tsmc', 'samsung semiconductor', 'samsung',
  'deloitte consulting', 'deloitte', 'ernst & young', 'ey', 'accenture',
  'pricewaterhousecoopers', 'pwc', 'mckinsey', 'boston consulting group', 'bcg',
  'bain & company', 'bain', 'kpmg', 'capgemini', 'deloitte & touche',
  'deloitte tax', 'booz allen hamilton', 'booz allen', 'oliver wyman',
  'a.t. kearney', 'kearney', 'roland berger', 'cognizant', 'tata consultancy',
  'tcs', 'infosys', 'hcl america', 'hcl', 'wipro', 'ltimindtree',
  'tech mahindra', 'mphasis', 'hexaware', 'persistent systems', 'virtusa',
  'cgi technologies', 'cgi', 'synechron', 'ust global', 'ust',
  'l&t technology', 'compunnel', 'randstad', 'kforce', 'birlasoft',
  'zensar', 'mindtree', 'coforge', 'niit technologies', 'mastech', 'igate',
  'jpmorgan', 'jp morgan', 'goldman sachs', 'morgan stanley', 'citibank',
  'citi', 'bank of america', 'wells fargo', 'capital one', 'american express',
  'amex', 'charles schwab', 'schwab', 'fidelity investments', 'fidelity',
  'blackrock', 'barclays', 'deutsche bank', 'ubs', 'hsbc', 'bny mellon',
  'state street', 'us bank', 'pnc financial', 'pnc', 'visa', 'mastercard',
  'bloomberg', 's&p global', "moody's", 'msci', 'factset', 'cme group',
  'ice', 'citadel', 'citadel securities', 'two sigma', 'd.e. shaw', 'de shaw',
  'jane street', 'renaissance technologies', 'susquehanna', 'sig',
  'jump trading', 'hudson river trading', 'virtu financial', 'virtu',
  'tower research', 'optiver', 'imc trading', 'drw trading', 'drw',
  'akuna capital', 'akuna', 'belvedere trading', 'five rings', 'arrowstreet',
  'aqr capital', 'aqr', 'point72', 'bridgewater', 'millennium management',
  'millennium', 'balyasny', 'voleon', 'worldquant', 'squarepoint',
  'pdt partners', 'old mission', 'wolverine trading', 'wolverine',
  'peak6', 'gts', 'headlands technologies', 'headlands', 'radix trading',
  'xtx markets', 'vatic investments', 'man group', 'ahl',
  'quantitative brokers', 'flow traders', 'cubist systematic',
  'winton group', 'marshall wace', 'schonfeld', 'exoduspoint',
  'graham capital', 'verition', 'capula', 'walmart', 'fedex', 'ups',
  'ford motor', 'ford', 'general motors', 'gm', 'rivian', 'lucid motors',
  'cummins', 't-mobile', 'at&t', 'verizon', 'comcast',
  'charter communications', 'adp', 'fis', 'hpe', 'hp inc', 'hp',
  'dell technologies', 'dell', 'p&g', 'procter & gamble',
  'johnson & johnson', 'j&j', 'eli lilly', 'pfizer', 'merck', 'abbvie',
  'amgen', 'gilead sciences', 'gilead', 'regeneron', 'bristol-myers squibb',
  'bms', 'thermo fisher', 'unitedhealth', 'optum', 'elevance health',
  'cvs health', 'cvs', 'cigna', 'humana', 'medtronic', 'abbott labs',
  'abbott', 'boston scientific', 'intuitive surgical', 'exxon mobil', 'exxon',
  'chevron', 'caterpillar', '3m', 'ge aerospace', 'ge', 'honeywell',
  'rtx', 'raytheon', 'lockheed martin', 'northrop grumman', 'boeing',
  'l3harris', 'general dynamics', 'spacex', 'anduril', 'target', 'home depot',
  'nike', 'pepsico', 'pepsi', 'coca-cola', 'disney', 'ebay',
  'expedia group', 'expedia', 'sap america', 'sap', 'workday', 'hubspot',
  'autodesk', 'fortinet', 'arista networks', 'arista', 'netapp',
  'thomson reuters', 'openai', 'anthropic', 'xai', 'cohere', 'hugging face',
  'perplexity', 'scale ai', 'cerebras', 'together ai', 'weights & biases',
  'wandb', 'glean', 'harvey ai', 'runway', 'elevenlabs', 'cursor',
  'anysphere', 'wiz', 'coreweave', 'applied intuition', 'waymo', 'nuro',
  'zoox', 'character.ai', 'grammarly', 'labelbox', 'sambanova', 'lambda',
  'replit', 'anyscale', 'pinecone', 'cleanlab', 'instacart', 'gusto',
  'brex', 'retool', 'deel', 'flexport', 'faire', 'zapier', 'gitlab',
  'dropbox', 'reddit', 'plaid', 'ramp', 'rippling', 'samsara', 'fivetran',
  'checkr', 'airtable', 'notion', 'figma', 'vercel', 'vanta', 'mercury',
  'whatnot', 'ironclad', 'carta', 'amplitude', 'docker', 'webflow',
  'modern treasury', 'linear', 'supabase', 'posthog', 'mixpanel', 'algolia',
  'ginkgo bioworks', 'ginkgo', 'cockroach labs', 'spring health',
  'color health', 'ro', 'abridge', 'stytch', 'neon', 'chainguard',
  'cal.com', 'planetscale', 'materialize', 'lyft', 'robinhood', 'sofi',
  'chime', 'toast', 'affirm', 'docusign', 'zoom', 'electronic arts', 'ea',
  'epic games', 'roblox', 'unity technologies', 'unity', 'asana', 'zendesk',
  'freshworks', 'uipath', 'informatica', 'veeva systems', 'veeva',
  'sentinelone', 'rubrik', 'nutanix', 'pure storage', 'duolingo', 'coursera',
  'grafana labs', 'grafana', 'dbt labs', 'snyk', 'kong', 'lattice', 'miro',
  'klaviyo', 'celonis', 'neo4j', 'clickhouse', 'cribl', 'strava',
  'genentech', 'roche', 'moderna', 'vertex pharma', 'vertex',
  'illumina', '10x genomics', 'danaher', 'agilent', 'biogen',
  'astrazeneca', 'novartis', 'sanofi', 'takeda', 'novo nordisk',
  'becton dickinson', 'bd', 'dexcom', 'edwards lifesciences', 'stryker',
  'zimmer biomet', 'hologic', 'iqvia', 'veracyte', 'exact sciences',
  'progressive', 'allstate', 'liberty mutual', 'metlife', 'prudential',
  'tiaa', 't. rowe price', 'vanguard', 'northern trust', 'franklin templeton',
  'broadridge', 'morningstar', 'nextera energy', 'enphase', 'first solar',
  'quantumscape', 'form energy', 'commonwealth fusion', 'crusoe energy',
  'leidos', 'saic', 'caci', 'blue origin', 'shield ai', 'rocket lab',
  'relativity space', 'joby aviation', 'boom supersonic', 'emerson electric',
  'emerson', 'rockwell automation', 'parker hannifin', 'corning', 'dow',
  'dupont', 'motorola solutions', 'motorola', 'john deere', 'deere',
  'illinois tool works', 'itw', 'zillow', 'booking.com', 'booking',
  'mathworks', 'ansys', 'sas institute', 'sas', 'epic systems', 'cerner',
  'oracle health', 'applovin', 'tradedesk', 'the trade desk', 'digitalocean',
  'braze', 'tempus', 'oscar health', 'flatiron health', 'relativity',
  'opendoor', 'wayfair', 'etsy', 'starbucks', 'general mills', 'mondelez',
  'colgate-palmolive', 'colgate', 'estee lauder', 'ralph lauren', 'marriott',
  'hilton', 'warner bros', 'nbcuniversal', 'nbc', 'sony',
  'hims & hers', 'noom', 'planet labs', 'aurora innovation', 'aurora',
  'drata', 'launchdarkly', 'canva', 'monday.com', 'monday', 'smartsheet',
  'twitch', 'marqeta', 'bill.com', 'coupa', 'genesys', 'teradata',
  'alteryx', 'jfrog', 'appian', 'pegasystems', 'pega', 'five9', 'nextdoor',
  'angellist',
];

function isKnownH1bSponsor(companyName: string): boolean {
  const name = companyName.toLowerCase();
  return H1B_SPONSOR_COMPANIES.some(
    (known) => name.includes(known) || known.includes(name)
  );
}

const INVALID_VALUES = ['unknown company', 'unknown position', 'unknown', 'n/a', 'none', ''];

function isValidJob(job: ScrapedJob): boolean {
  const company = (job.company || '').trim().toLowerCase();
  const title = (job.positionTitle || '').trim().toLowerCase();
  return !INVALID_VALUES.includes(company) && !INVALID_VALUES.includes(title);
}

interface ExtractedFields {
  workModel: 'Onsite' | 'Remote' | 'Hybrid' | null;
  industry: string | null;
  h1bSponsored: boolean | null;
  isNewGrad: boolean;
  datePosted: string | null;
  qualifications: string | null;
  salary: string | null;
  confidence: number;
}

const SYSTEM_PROMPT = `You are a job posting analyzer. Extract structured information from job postings.

Rules for extraction:
1. workModel: Determine from location field or job description. "Remote" if fully remote, "Hybrid" if mix, "Onsite" if in-office only. Null if unclear.
2. h1bSponsored: Set to true ONLY if explicitly mentions visa sponsorship. Set to false if mentions "no sponsorship", "must be authorized to work", or citizenship requirements. Set to null if not mentioned at all.
3. industry: Choose the BEST matching category from: ${INDUSTRY_LIST.join(', ')}
4. qualifications: Extract key requirements (degree, years of experience, skills) as a brief summary.
5. salary: Extract and normalize salary if mentioned (e.g., "$50/hr" or "$120,000-$150,000/year"). Null if not found.
6. isNewGrad: Determine if the role is a NEW GRAD / ENTRY-LEVEL position. Weight the TITLE heavily — it is the strongest signal.
   Set to true if:
   - Title contains explicit markers: "new grad", "new graduate", "entry level", "entry-level", "junior", "jr.", "associate engineer", "graduate engineer", "campus", "university grad", "early career", "early-in-career", "intern" (if user wants new-grad only, intern is acceptable), "I" or "1" level (e.g., "Software Engineer I", "SWE 1"), "college grad", "recent graduate"
   - OR qualifications clearly indicate 0-2 years of experience, "no prior professional experience required", or bachelor's degree with no extensive experience requirement
   Set to false if:
   - Title contains: "senior", "sr.", "staff", "principal", "lead", "manager", "director", "architect", "II", "III", "IV", "L2+", "L3+", or any level >= 2
   - OR qualifications require 3+ years of experience, or senior-level responsibilities
   When title and qualifications conflict, the TITLE wins. When uncertain with no strong signals either way, set to false.
7. datePosted: Extract the date the job was posted if mentioned in the description (e.g., "Posted on Jan 15, 2025", "Date: 2025-01-15"). Return in YYYY-MM-DD format. Null if not found.
8. confidence: Your confidence in the extraction (0.0 to 1.0).

Emoji indicators to interpret:
- 🛂 = Does NOT offer visa sponsorship (h1bSponsored = false)
- 🇺🇸 = Requires U.S. citizenship (h1bSponsored = false)

Respond with valid JSON only.`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const JOB_BOARD_PATTERNS: Array<{ pattern: RegExp; board: JobBoard }> = [
  { pattern: /lever\.co/i, board: 'Lever' },
  { pattern: /greenhouse\.io/i, board: 'Greenhouse' },
  { pattern: /ashbyhq\.com/i, board: 'Ashby' },
  { pattern: /linkedin\.com/i, board: 'Linkedin' },
  { pattern: /myworkdayjobs\.com|workday\.com/i, board: 'Workday' },
];

function detectJobBoard(applyLink: string | null, description: string | null): JobBoard {
  // Try URL first
  if (applyLink) {
    for (const { pattern, board } of JOB_BOARD_PATTERNS) {
      if (pattern.test(applyLink)) return board;
    }
  }
  // Fallback: check description for board-specific URLs
  if (description) {
    for (const { pattern, board } of JOB_BOARD_PATTERNS) {
      if (pattern.test(description)) return board;
    }
  }
  return null;
}

async function extractFields(
  client: Anthropic,
  job: ScrapedJob
): Promise<ExtractedFields> {
  const userMessage = `Analyze this job posting and extract structured fields:

Title: ${job.positionTitle}
Company: ${job.company}
Location: ${job.location || 'Not specified'}
Apply Link: ${job.applyLink || 'Not available'}
Description: ${job.jobDescription || 'Not available'}

Raw data: ${JSON.stringify(job.rawFields || {})}

Respond with JSON in this exact format:
{
  "workModel": "Remote" | "Hybrid" | "Onsite" | null,
  "industry": "<industry from list>" | null,
  "h1bSponsored": true | false | null,
  "isNewGrad": true | false,
  "datePosted": "YYYY-MM-DD" | null,
  "qualifications": "<brief summary>" | null,
  "salary": "<normalized salary>" | null,
  "confidence": <0.0-1.0>
}`;

  const response = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const textContent = response.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text content in AI response');
  }

  const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in AI response');
  }

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    workModel: parsed.workModel,
    industry: INDUSTRY_LIST.includes(parsed.industry) ? parsed.industry : null,
    h1bSponsored: parsed.h1bSponsored ?? null,
    isNewGrad: parsed.isNewGrad ?? false,
    datePosted: parsed.datePosted || null,
    qualifications: parsed.qualifications,
    salary: parsed.salary,
    confidence: parsed.confidence || 0.5,
  };
}

const FAANG_PLUS = [
  'google', 'alphabet', 'meta', 'facebook', 'apple', 'amazon', 'aws',
  'microsoft', 'netflix', 'nvidia', 'tesla', 'uber', 'lyft', 'airbnb',
  'stripe', 'palantir', 'snowflake', 'databricks', 'coinbase', 'doordash',
  'salesforce', 'adobe', 'oracle', 'intel', 'amd', 'qualcomm', 'ibm',
  'linkedin', 'twitter', 'x corp', 'snap', 'pinterest', 'spotify',
  'samsung', 'sony', 'tiktok', 'bytedance', 'bloomberg', 'cisco',
  'vmware', 'paypal', 'block', 'square', 'robinhood', 'plaid',
];

const QUANT_FIRMS = [
  'citadel', 'two sigma', 'jane street', 'de shaw', 'd.e. shaw',
  'renaissance', 'point72', 'bridgewater', 'millennium', 'aqr',
  'hudson river', 'jump trading', 'tower research', 'sig ', 'susquehanna',
  'virtu', 'imc trading', 'imc financial', 'optiver', 'flow traders',
  'drw', 'five rings', 'headlands', 'akuna', 'wolverine',
  'old mission', 'maven', 'squarepoint', 'balyasny', 'worldquant',
];

const FORTUNE_500 = [
  'walmart', 'exxonmobil', 'chevron', 'berkshire hathaway', 'unitedhealth',
  'jpmorgan', 'jp morgan', 'johnson & johnson', 'procter & gamble', 'bank of america',
  'wells fargo', 'citigroup', 'comcast', 'at&t', 'verizon', 'disney',
  'pfizer', 'merck', 'coca-cola', 'pepsico', 'lockheed martin', 'boeing',
  'general motors', 'ford', 'ge ', 'general electric', 'raytheon', 'rtx',
  'honeywell', 'caterpillar', '3m', 'deloitte', 'pwc', 'kpmg', 'ey ',
  'ernst & young', 'accenture', 'mckinsey', 'goldman sachs', 'morgan stanley',
  'capital one', 'american express', 'amex', 'visa', 'mastercard',
  'nike', 'target', 'costco', 'home depot', "lowe's", 'ups', 'fedex',
  'delta', 'united airlines', 'southwest', 'fiserv', 'intuit', 'servicenow',
];

const UNICORN = [
  'databricks', 'stripe', 'spacex', 'canva', 'checkout.com',
  'ripple', 'plaid', 'instacart', 'figma', 'notion', 'airtable',
  'scale ai', 'anduril', 'brex', 'ramp', 'klarna', 'chime',
  'discord', 'vercel', 'retool', 'linear', 'grammarly',
  'openai', 'anthropic', 'mistral', 'cohere', 'hugging face',
];

const YC_COMPANIES = [
  'airbnb', 'stripe', 'dropbox', 'doordash', 'coinbase', 'instacart',
  'twitch', 'reddit', 'gitlab', 'gusto', 'zapier', 'segment',
  'brex', 'deel', 'ironclad', 'retool', 'rippling', 'scale ai',
  'flexport', 'ginkgo', 'openai', 'pagerduty', 'render',
  'vercel', 'posthog', 'cal.com', 'supabase', 'resend',
];

const CRYPTO_WEB3 = [
  'coinbase', 'binance', 'kraken', 'gemini', 'opensea',
  'ripple', 'circle', 'chainalysis', 'fireblocks', 'alchemy',
  'consensys', 'polygon', 'solana', 'avalanche', 'near',
  'uniswap', 'aave', 'compound', 'dydx', 'anchorage',
  'ledger', 'blockchain.com', 'bitgo', 'paxos', 'immutable',
  'animoca', 'dapper labs', 'sky mavis', 'yuga labs', 'mythical',
];

function detectTags(job: ScrapedJob): string[] {
  const tags: string[] = [];
  const company = job.company.toLowerCase();

  if (FAANG_PLUS.some((c) => company.includes(c))) tags.push('FAANG+');
  if (QUANT_FIRMS.some((c) => company.includes(c))) tags.push('Quant');
  if (FORTUNE_500.some((c) => company.includes(c))) tags.push('Fortune 500');
  if (UNICORN.some((c) => company.includes(c))) tags.push('Unicorn');
  if (YC_COMPANIES.some((c) => company.includes(c))) tags.push('YC');
  if (CRYPTO_WEB3.some((c) => company.includes(c))) tags.push('Crypto/Web3');

  return tags;
}

export async function processWithAI(): Promise<number> {
  if (!config.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY not set. Add it to your .env file.');
  }

  const allJobs = readStep<ScrapedJob[]>('step2-scraped-jobs');
  if (!allJobs || allJobs.length === 0) {
    throw new Error('No jobs found from Step 2. Run Step 2 first.');
  }

  // Filter out invalid jobs (Unknown Company, Unknown Position, etc.)
  const invalidJobs = allJobs.filter((j) => !isValidJob(j));
  const jobs = allJobs.filter((j) => isValidJob(j));

  if (invalidJobs.length > 0) {
    log('ai', 'warn', `Filtered out ${invalidJobs.length} invalid job(s):`);
    for (const j of invalidJobs) {
      log('ai', 'warn', `  Removed: "${j.company}" — "${j.positionTitle}" (invalid company or title)`);
    }
  }

  if (jobs.length === 0) {
    throw new Error('No valid jobs remaining after filtering invalid entries.');
  }

  const todayDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD fallback

  log('ai', 'info', `Starting AI processing for ${jobs.length} jobs (${invalidJobs.length} filtered out)...`);
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const results: ProcessedJob[] = [];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const titleIsNewGrad = /new.?grad|entry.?level|junior/i.test(job.positionTitle);
    const processed: ProcessedJob = {
      ...job,
      workModel: null,
      industry: detectIndustry(job.positionTitle) || null,
      h1bSponsored: isKnownH1bSponsor(job.company),
      qualifications: null,
      jobBoard: detectJobBoard(job.applyLink, job.jobDescription),
      tags: detectTags(job),
      isNewGrad: titleIsNewGrad,
      isInternship: /intern/i.test(job.positionTitle),
      aiConfidence: null,
      aiProcessed: false,
    };

    try {
      log('ai', 'info', `  [${i + 1}/${jobs.length}] Processing ${job.company} — ${job.positionTitle}`);

      const extracted = await extractFields(client, job);

      processed.workModel = extracted.workModel;
      processed.industry = extracted.industry || processed.industry;

      // H1B: AI true → true; AI false/null → check companies.json → fallback false
      if (extracted.h1bSponsored === true) {
        processed.h1bSponsored = true;
      } else if (isKnownH1bSponsor(job.company)) {
        processed.h1bSponsored = true;
        log('ai', 'info', `  [${i + 1}] ${job.company} — H1B: company is a known sponsor (companies.json)`);
      } else {
        processed.h1bSponsored = false;
      }

      processed.isNewGrad = titleIsNewGrad || extracted.isNewGrad;
      processed.qualifications = extracted.qualifications;
      processed.salary = extracted.salary || job.salary;
      processed.aiConfidence = extracted.confidence;
      processed.aiProcessed = true;

      // Fill missing datePosted: prefer source date > AI-extracted date > today's date
      if (!processed.datePosted) {
        if (extracted.datePosted) {
          processed.datePosted = extracted.datePosted;
          log('ai', 'info', `  [${i + 1}] ${job.company} — Date extracted by AI: ${extracted.datePosted}`);
        } else {
          processed.datePosted = todayDate;
          log('ai', 'warn', `  [${i + 1}] ${job.company} — No date found, using today's date: ${todayDate}`);
        }
      }

      log(
        'ai',
        'info',
        `  [${i + 1}] ${job.company} — Done (confidence: ${extracted.confidence}, industry: ${processed.industry})`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('ai', 'error', `  [${i + 1}] ${job.company} — AI failed: ${msg}`);
      // Keep the job with whatever we could fill from keyword detection
    }

    // Ensure datePosted is never null — fallback to today's date
    if (!processed.datePosted) {
      processed.datePosted = todayDate;
      log('ai', 'warn', `  [${i + 1}] ${job.company} — No date found (AI failed or no source date), using today: ${todayDate}`);
    }

    results.push(processed);

    // Rate limiting
    if (i < jobs.length - 1) {
      await sleep(1200);
    }
  }

  const aiProcessed = results.filter((j) => j.aiProcessed).length;
  writeStep('step3-processed-jobs', results);
  log('ai', 'info', `Step 3 complete: ${aiProcessed}/${results.length} jobs processed by AI`);
  return results.length;
}

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { log } from '../logger.js';
import { readStep, writeStep } from '../store.js';
import { INDUSTRY_LIST, detectIndustry } from '../constants/industries.js';
import type { ScrapedJob, ProcessedJob } from '../types.js';

interface ExtractedFields {
  workModel: 'Onsite' | 'Remote' | 'Hybrid' | null;
  industry: string | null;
  h1bSponsored: boolean | null;
  qualifications: string | null;
  salary: string | null;
  confidence: number;
}

const SYSTEM_PROMPT = `You are a job posting analyzer. Extract structured information from job postings.

Rules for extraction:
1. workModel: Determine from location field or job description. "Remote" if fully remote, "Hybrid" if mix, "Onsite" if in-office only. Null if unclear.
2. h1bSponsored: Set to true ONLY if explicitly mentions visa sponsorship. Set to false if mentions "no sponsorship", "must be authorized to work", or citizenship requirements. Set to null if not mentioned.
3. industry: Choose the BEST matching category from: ${INDUSTRY_LIST.join(', ')}
4. qualifications: Extract key requirements (degree, years of experience, skills) as a brief summary.
5. salary: Extract and normalize salary if mentioned (e.g., "$50/hr" or "$120,000-$150,000/year"). Null if not found.
6. confidence: Your confidence in the extraction (0.0 to 1.0).

Emoji indicators to interpret:
- 🛂 = Does NOT offer visa sponsorship (h1bSponsored = false)
- 🇺🇸 = Requires U.S. citizenship (h1bSponsored = false)

Respond with valid JSON only.`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function extractFields(
  client: Anthropic,
  job: ScrapedJob
): Promise<ExtractedFields> {
  const userMessage = `Analyze this job posting and extract structured fields:

Title: ${job.positionTitle}
Company: ${job.company}
Location: ${job.location || 'Not specified'}
Description: ${job.jobDescription || 'Not available'}

Raw data: ${JSON.stringify(job.rawFields || {})}

Respond with JSON in this exact format:
{
  "workModel": "Remote" | "Hybrid" | "Onsite" | null,
  "industry": "<industry from list>" | null,
  "h1bSponsored": true | false | null,
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
    h1bSponsored: parsed.h1bSponsored,
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
  const text = `${job.positionTitle} ${company} ${job.location || ''} ${job.jobDescription || ''}`.toLowerCase();

  if (FAANG_PLUS.some((c) => company.includes(c))) tags.push('FAANG+');
  if (QUANT_FIRMS.some((c) => company.includes(c))) tags.push('Quant');
  if (FORTUNE_500.some((c) => company.includes(c))) tags.push('Fortune 500');
  if (UNICORN.some((c) => company.includes(c))) tags.push('Unicorn');
  if (YC_COMPANIES.some((c) => company.includes(c))) tags.push('YC');
  if (CRYPTO_WEB3.some((c) => company.includes(c))) tags.push('Crypto/Web3');
  if (text.includes('intern')) tags.push('Internship');
  if (text.includes('new grad') || text.includes('entry level') || text.includes('junior')) {
    tags.push('New Grad');
  }
  if (text.includes('remote')) tags.push('Remote');
  if (text.includes('startup')) tags.push('Startup');

  return tags;
}

export async function processWithAI(): Promise<number> {
  if (!config.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY not set. Add it to your .env file.');
  }

  const jobs = readStep<ScrapedJob[]>('step2-scraped-jobs');
  if (!jobs || jobs.length === 0) {
    throw new Error('No jobs found from Step 2. Run Step 2 first.');
  }

  log('ai', 'info', `Starting AI processing for ${jobs.length} jobs...`);
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const results: ProcessedJob[] = [];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const processed: ProcessedJob = {
      ...job,
      workModel: null,
      industry: detectIndustry(job.positionTitle) || null,
      h1bSponsored: null,
      qualifications: null,
      tags: detectTags(job),
      isNewGrad: /new.?grad|entry.?level|junior/i.test(job.positionTitle),
      isInternship: /intern/i.test(job.positionTitle),
      aiConfidence: null,
      aiProcessed: false,
    };

    try {
      log('ai', 'info', `  [${i + 1}/${jobs.length}] Processing ${job.company} — ${job.positionTitle}`);

      const extracted = await extractFields(client, job);

      processed.workModel = extracted.workModel;
      processed.industry = extracted.industry || processed.industry;
      processed.h1bSponsored = extracted.h1bSponsored;
      processed.qualifications = extracted.qualifications;
      processed.salary = extracted.salary || job.salary;
      processed.aiConfidence = extracted.confidence;
      processed.aiProcessed = true;

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

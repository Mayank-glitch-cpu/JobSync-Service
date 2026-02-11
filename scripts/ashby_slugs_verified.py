#!/usr/bin/env python3
"""Generate and optionally verify Ashby slugs.

Usage:
  python scripts/ashby_slugs_verified.py
  python scripts/ashby_slugs_verified.py --verify
"""

from __future__ import annotations
import argparse
import csv
import json
import urllib.request
import urllib.error
from pathlib import Path

# Compact curated seed list; can be extended over time.
SLUGS = [
    'airtable','alan','altura','away','deliveroo','duolingo','flock-safety','hackerone','notion','opendoor',
    'oyster','posthog','ramp','sequoia','sony','vanta','cursor','deel','harvey','modern-treasury','openai',
    'reddit','shopify','snowflake','apify','ashby','buffer','factory','hcompany','jerry.ai','lightning','linear',
    'lottie','lovable','notable','scribd','searchable','silver','tapcheck','blueberrypediatrics','cambly','checkly',
    'cleric','continua','dryft','duck-duck-go','equals','firetiger','homevision','imprint','kombo','legionhealth',
    'livekit','matterworks','meticulous','modal','norm-ai','office-hours','ontic','orb','parabola-io','pear','pear-vc',
    'permitflow','sentilink','sfcompute','steel','tiplink','titan','turnstile','verge-genomics','virtahealth','vitalize',
    'wirescreen','anthropic','benchling','clerk','cohere','dbt-labs','perplexity','replit','runway','watershed'
]


def dedupe(slugs: list[str]) -> list[str]:
    seen = set()
    out = []
    for slug in slugs:
        key = slug.strip().lower()
        if key and key not in seen:
            seen.add(key)
            out.append(key)
    return out


def verify_slug(slug: str) -> tuple[bool, int]:
    url = f'https://jobs.ashbyhq.com/{slug}/jobs.json'
    req = urllib.request.Request(url, headers={'User-Agent': 'JobSync-Service/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status != 200:
                return False, 0
            payload = json.loads(resp.read().decode('utf-8'))
            return True, len(payload.get('jobs', []))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError):
        return False, 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()

    slugs = dedupe(SLUGS)
    out_dir = Path(__file__).resolve().parent
    txt_path = out_dir / 'ashby_slugs_curated.txt'
    csv_path = out_dir / 'ashby_slugs_curated.csv'

    txt_path.write_text('\n'.join(slugs) + '\n')

    with csv_path.open('w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['slug', 'job_board_url', 'jobs_json_url'])
        for slug in slugs:
            w.writerow([slug, f'https://jobs.ashbyhq.com/{slug}', f'https://jobs.ashbyhq.com/{slug}/jobs.json'])

    print(f'Wrote {len(slugs)} slugs to {txt_path} and {csv_path}')

    if args.verify:
        verified_rows = []
        for slug in slugs:
            ok, jobs = verify_slug(slug)
            if ok:
                verified_rows.append((slug, jobs))

        verified_csv = out_dir / 'ashby_slugs_curated_verified.csv'
        with verified_csv.open('w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['slug', 'job_count'])
            for slug, jobs in sorted(verified_rows, key=lambda x: (-x[1], x[0])):
                w.writerow([slug, jobs])

        print(f'Verified {len(verified_rows)}/{len(slugs)} slugs. Output: {verified_csv}')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())

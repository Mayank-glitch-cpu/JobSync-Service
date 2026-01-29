# Airtable Schema for Jobs Table

## How to Create the Airtable Base

1. Go to [Airtable](https://airtable.com) and create a new base
2. Rename the default table to "Jobs"
3. Add the following fields:

## Fields

| Field Name | Field Type | Configuration |
|------------|------------|---------------|
| Position Title | Single line text | Primary field |
| Date | Date | Date format: Local |
| Apply Link | URL | - |
| Work Model | Single select | Options: `Onsite`, `Remote`, `Hybrid` |
| Location | Single line text | - |
| Company | Single line text | - |
| Tags | Multiple select | Options: `FAANG+`, `Quant`, `Unicorn`, `Fortune 500`, `YC`, `Crypto/Web3` |
| Industry | Single select | See industry options below |
| Salary | Single line text | - |
| Job Description | Long text | Enable rich text formatting |
| Qualifications | Long text | Enable rich text formatting |
| H1B Sponsored | Checkbox | - |
| Is New Grad | Checkbox | - |
| Is Internship | Checkbox | - |

## Industry Options

Add these options to the "Industry" single select field:

1. Software Engineering
2. Data Analyst
3. Marketing
4. ML/AI
5. Business Analyst
6. Product Management
7. Creatives/Design
8. Accounting/Finance
9. Consulting
10. Engineering
11. HR
12. Arts/Entertainment
13. Management/Executive
14. Customer Service
15. Legal/Compliance
16. Sales
17. Public Sector
18. Education
19. Cybersecurity
20. Project Manager
21. Healthcare
22. Supply Chain

## Views to Create

### 1. All Jobs (Grid View)
Default view showing all jobs sorted by Date (newest first)

### 2. New Grad Jobs (Grid View)
Filter: `Is New Grad` is checked
Sort: Date (newest first)

### 3. Internships (Grid View)
Filter: `Is Internship` is checked
Sort: Date (newest first)

### 4. H1B Sponsored (Grid View)
Filter: `H1B Sponsored` is checked
Sort: Date (newest first)

### 5. Remote Jobs (Grid View)
Filter: `Work Model` is `Remote`
Sort: Date (newest first)

### 6. FAANG+ Jobs (Grid View)
Filter: `Tags` contains `FAANG+`
Sort: Date (newest first)

### 7. By Industry (Kanban View)
Group by: Industry
Sort: Date (newest first)

## API Key Setup

1. Go to [Airtable Account](https://airtable.com/account)
2. Generate a Personal Access Token with these scopes:
   - `data.records:read`
   - `data.records:write`
   - `schema.bases:read`
3. Copy the token and add it to your `.env` file as `AIRTABLE_API_KEY`

## Base ID

1. Open your base in Airtable
2. Click "Help" in the top right
3. Select "API documentation"
4. Find your Base ID (starts with `app`)
5. Add it to your `.env` file as `AIRTABLE_BASE_ID`

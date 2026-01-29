export const INDUSTRIES = {
  'Software Engineering': { emoji: '💻', keywords: ['software', 'developer', 'engineer', 'swe', 'backend', 'frontend', 'fullstack'] },
  'Data Analyst': { emoji: '📈', keywords: ['data analyst', 'analytics', 'bi analyst', 'business intelligence'] },
  'Marketing': { emoji: '📢', keywords: ['marketing', 'growth', 'brand', 'content', 'seo', 'sem'] },
  'ML/AI': { emoji: '🤖', keywords: ['machine learning', 'ml', 'ai', 'artificial intelligence', 'deep learning', 'nlp', 'computer vision'] },
  'Business Analyst': { emoji: '📊', keywords: ['business analyst', 'ba', 'requirements', 'process analyst'] },
  'Product Management': { emoji: '📦', keywords: ['product manager', 'pm', 'product owner', 'product lead'] },
  'Creatives/Design': { emoji: '🎨', keywords: ['design', 'ui', 'ux', 'graphic', 'creative', 'visual'] },
  'Accounting/Finance': { emoji: '💰', keywords: ['accounting', 'finance', 'financial', 'cpa', 'controller', 'treasury'] },
  'Consulting': { emoji: '💼', keywords: ['consultant', 'consulting', 'advisory', 'strategy'] },
  'Engineering': { emoji: '🛠️', keywords: ['engineering', 'mechanical', 'electrical', 'civil', 'hardware'] },
  'HR': { emoji: '👥', keywords: ['human resources', 'hr', 'recruiting', 'talent', 'people ops'] },
  'Arts/Entertainment': { emoji: '🎭', keywords: ['arts', 'entertainment', 'media', 'music', 'film', 'gaming'] },
  'Management/Executive': { emoji: '🌟', keywords: ['manager', 'director', 'vp', 'executive', 'chief', 'head of', 'lead'] },
  'Customer Service': { emoji: '☎️', keywords: ['customer service', 'support', 'customer success', 'client services'] },
  'Legal/Compliance': { emoji: '⚖️', keywords: ['legal', 'lawyer', 'attorney', 'compliance', 'regulatory', 'paralegal'] },
  'Sales': { emoji: '🛒', keywords: ['sales', 'account executive', 'ae', 'business development', 'bdr', 'sdr'] },
  'Public Sector': { emoji: '🏛️', keywords: ['government', 'public sector', 'federal', 'state', 'municipal', 'nonprofit'] },
  'Education': { emoji: '🎓', keywords: ['education', 'training', 'instructor', 'teacher', 'professor', 'academic'] },
  'Cybersecurity': { emoji: '🛡️', keywords: ['security', 'cybersecurity', 'infosec', 'penetration', 'soc', 'security engineer'] },
  'Project Manager': { emoji: '📝', keywords: ['project manager', 'program manager', 'scrum master', 'agile coach'] },
  'Healthcare': { emoji: '🩺', keywords: ['healthcare', 'medical', 'health', 'clinical', 'pharma', 'biotech'] },
  'Supply Chain': { emoji: '🚚', keywords: ['supply chain', 'logistics', 'operations', 'procurement', 'warehouse'] },
} as const;

export type Industry = keyof typeof INDUSTRIES;
export const INDUSTRY_LIST: Industry[] = Object.keys(INDUSTRIES) as Industry[];

export function detectIndustry(text: string): Industry | null {
  const lowerText = text.toLowerCase();
  for (const [industry, config] of Object.entries(INDUSTRIES)) {
    for (const keyword of config.keywords) {
      if (lowerText.includes(keyword)) {
        return industry as Industry;
      }
    }
  }
  return null;
}

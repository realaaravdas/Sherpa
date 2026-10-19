import { SENIORITY_RANK, canonSkill, slug, extractSkills, detectSeniority } from './scraper/normalize.js';

const STOP = new Set('a an the and or of for to in at with senior junior sr jr staff lead principal i ii iii engineer developer'.split(' '));
const toks = (s) => slug(s).split(' ').filter((w) => w && !STOP.has(w));

// Related-role families, so "Backend Engineer" is recognised as close to "Software Engineer".
const FAMILIES = [
  ['software', 'backend', 'frontend', 'fullstack', 'full', 'stack', 'web', 'platform', 'application', 'engineer', 'developer', 'programmer'],
  ['data', 'analytics', 'analyst', 'bi', 'scientist', 'machine', 'learning', 'ml', 'ai'],
  ['devops', 'sre', 'infrastructure', 'cloud', 'reliability', 'systems'],
  ['product', 'pm', 'program', 'project'], ['design', 'designer', 'ux', 'ui', 'creative'],
  ['marketing', 'growth', 'seo', 'content', 'brand'], ['sales', 'account', 'business', 'development', 'sdr', 'bdr'],
  ['security', 'infosec', 'cybersecurity'], ['support', 'success', 'customer', 'service'],
];
const famOf = (w) => FAMILIES.findIndex((f) => f.includes(w));

export function prepareProfile(p) {
  return {
    skills: [...new Set((p.skills || []).map(canonSkill))],
    roles: (p.targetRoles || []).map(String).filter(Boolean),
    roleToks: (p.targetRoles || []).map(toks),
    exclude: (p.excludeKeywords || []).map((s) => s.toLowerCase()).filter(Boolean),
    companiesBlock: new Set((p.blockedCompanies || []).map(slug)),
    seniority: p.seniority || (p.yearsExperience != null ? yearsToLevel(p.yearsExperience) : null),
    remote: p.workMode || 'any', // remote | hybrid | onsite | any
    locations: (p.locations || []).map((s) => s.toLowerCase()).filter(Boolean),
    countries: (p.countries || []).map((s) => s.toUpperCase()),
    minSalary: Number(p.minSalary) || 0,
    resumeSkills: extractSkills(p.resume || ''),
  };
}
export const yearsToLevel = (y) => (y < 1 ? 'junior' : y < 3 ? 'junior' : y < 6 ? 'mid' : y < 9 ? 'senior' : 'staff');

/** Hard filters the user set (deal-breakers). Returns a reason string if the job is excluded. */
export function hardReject(job, P) {
  const hay = `${job.title} ${job.company}`.toLowerCase();
  if (P.exclude.some((w) => hay.includes(w))) return 'excluded keyword';
  if (P.companiesBlock.has(slug(job.company))) return 'blocked company';
  if (P.remote === 'remote' && job.remote !== 2) return 'not remote';
  if (P.remote === 'onsite' && job.remote === 2) return 'remote only';
  return null;
}

/**
 * Explainable 0-100 score. Components (weights sum to 100):
 *  title 30 · skills 30 · seniority 10 · location/mode 15 · salary 5 · recency 10
 * When an embedding similarity is supplied it is blended in at 30% so semantic matches
 * the keyword rules miss still rise to the top.
 */
export function scoreJob(job, P, { semantic = null, now = Date.now() } = {}) {
  const reasons = [], warn = [];
  const jt = toks(job.title);

  // title / role fit
  let title = 0;
  if (P.roleToks.length) {
    for (const rt of P.roleToks) {
      if (!rt.length) continue;
      const exact = rt.filter((w) => jt.includes(w)).length / rt.length;
      const fam = rt.filter((w) => jt.includes(w) || jt.some((j) => famOf(j) >= 0 && famOf(j) === famOf(w))).length / rt.length;
      title = Math.max(title, exact * 1 + (fam - exact) * 0.55);
    }
    if (title > 0.8) reasons.push('Title matches your target role'); else if (title > 0.4) reasons.push('Role is closely related to your targets');
  } else title = 0.5;

  // skills
  const jobSkills = job.skills || [];
  const mine = new Set([...P.skills, ...P.resumeSkills]);
  const matched = jobSkills.filter((s) => mine.has(s));
  const missing = jobSkills.filter((s) => !mine.has(s));
  let skills;
  if (!mine.size) skills = 0.5;
  else if (!jobSkills.length) skills = 0.35;
  else skills = Math.min(1, matched.length / Math.max(3, Math.min(jobSkills.length, 8)) * 0.8 + (matched.length >= 3 ? 0.2 : 0));
  if (matched.length) reasons.push(`${matched.length} skill${matched.length > 1 ? 's' : ''} match: ${matched.slice(0, 5).join(', ')}`);

  // seniority
  let sen = 0.6;
  if (P.seniority && job.seniority) {
    const d = (SENIORITY_RANK[job.seniority] ?? 2) - (SENIORITY_RANK[P.seniority] ?? 2);
    sen = d === 0 ? 1 : d === 1 ? 0.55 : d === -1 ? 0.7 : d > 1 ? 0.1 : 0.3;
    if (d === 0) reasons.push(`Seniority fits (${job.seniority})`);
    if (d > 1) warn.push(`More senior than you (${job.seniority})`);
    if (d < -1) warn.push(`More junior than you (${job.seniority})`);
  }

  // location / work mode
  let loc = 0.6;
  const jl = (job.location || '').toLowerCase();
  if (P.remote === 'remote') { loc = job.remote === 2 ? 1 : 0; }
  else if (job.remote === 2 && P.remote === 'any') loc = 0.85;
  if (P.locations.length || P.countries.length) {
    const here = P.locations.some((l) => jl.includes(l)) || (job.country && P.countries.includes(job.country));
    if (here) { loc = 1; reasons.push('In your preferred location'); }
    else if (job.remote === 2) { loc = Math.max(loc, 0.7); }
    else { loc = 0.1; warn.push('Outside your preferred locations'); }
  }
  if (job.remote === 2) reasons.push('Remote');

  // salary
  let sal = 0.5;
  if (P.minSalary && job.salary_max) {
    sal = job.salary_max >= P.minSalary ? 1 : job.salary_max >= P.minSalary * 0.85 ? 0.4 : 0;
    if (sal === 0) warn.push('Pay is below your minimum');
    else if (sal === 1) reasons.push('Pay meets your minimum');
  }

  // recency
  const ageDays = job.posted_at ? (now - job.posted_at) / 86_400_000 : 14;
  const rec = ageDays <= 3 ? 1 : ageDays <= 7 ? 0.85 : ageDays <= 14 ? 0.65 : ageDays <= 30 ? 0.4 : 0.15;
  if (ageDays <= 3) reasons.push('Posted in the last few days');

  // Without target roles the title carries no signal, so skills take its weight.
  const wTitle = P.roleToks.length ? 30 : 0, wSkills = P.roleToks.length ? 30 : 55;
  let score = (title * wTitle + skills * wSkills + sen * 10 + loc * 15 + sal * 5 + rec * 10) * (100 / (wTitle + wSkills + 40));
  if (semantic != null) {
    const sem = Math.max(0, Math.min(1, (semantic - 0.15) / 0.5)); // cosine for related text lands ~0.2–0.65
    score = score * 0.7 + sem * 100 * 0.3;
    if (sem > 0.7) reasons.push('Strong semantic match with your resume');
  }
  return { score: Math.round(Math.max(0, Math.min(100, score))), reasons: reasons.slice(0, 5), warnings: warn, matched, missing: missing.slice(0, 8) };
}

export { detectSeniority };

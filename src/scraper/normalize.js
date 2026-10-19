import crypto from 'node:crypto';
import * as cheerio from 'cheerio';

/* ───────── text helpers ───────── */
const decodeEntities = (s) => cheerio.load(`<i>${s}</i>`)('i').text();

/** Convert HTML (possibly entity-escaped, as Greenhouse/Arbeitnow return it) to readable plain text. */
export function htmlToText(input) {
  if (!input) return '';
  let html = String(input);
  if (!/<[a-z][\s\S]*>/i.test(html) && /&lt;[a-z]/i.test(html)) html = decodeEntities(html); // double-escaped
  const $ = cheerio.load(`<body>${html}</body>`);
  $('script,style,noscript').remove();
  $('br').replaceWith('\n');
  $('li').each((_, el) => { $(el).prepend('• '); $(el).append('\n'); });
  $('p,div,h1,h2,h3,h4,h5,h6,ul,ol,tr').each((_, el) => { $(el).append('\n'); });
  return $('body').text().replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

export const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const COMPANY_SUFFIX = /\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|company|plc|ag|sa|bv|pty|labs?)\b/g;
export const companyKey = (c) => slug(c).replace(COMPANY_SUFFIX, '').replace(/\s+/g, ' ').trim() || slug(c);

// Strip noise that makes the same job look different across boards: "(m/w/d)", "- Remote", req ids, etc.
export function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[\(\[]\s*(m\s*\/\s*[wfd]\s*(\/\s*[dxi])?|f\s*\/\s*m(\s*\/\s*[dx])?|all genders|remote|hybrid|on-?site)\s*[\)\]]/gi, '')
    .replace(/\s*[-–—|]\s*(remote|hybrid|on-?site)\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
}

export function fingerprint(company, title, location) {
  const loc = slug(String(location || '').split(/[,/;|(]/)[0]); // city only: "Berlin" and "Berlin, Germany" are the same job
  return crypto.createHash('sha1').update(`${companyKey(company)}|${slug(cleanTitle(title))}|${loc}`).digest('hex').slice(0, 20);
}

/* ───────── remote / location ───────── */
export function detectRemote(...texts) {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  if (/\bhybrid\b/.test(t)) return 1;
  if (/\b(remote|work from home|wfh|anywhere|telecommute|distributed)\b/.test(t) && !/\bnot remote\b|\bno remote\b|\bon-?site only\b/.test(t)) return 2;
  return 0;
}

const COUNTRIES = {
  'united states': 'US', usa: 'US', 'u.s.': 'US', us: 'US', america: 'US', 'united kingdom': 'UK', uk: 'UK', england: 'UK', canada: 'CA', germany: 'DE', deutschland: 'DE',
  france: 'FR', spain: 'ES', netherlands: 'NL', ireland: 'IE', india: 'IN', australia: 'AU', singapore: 'SG', brazil: 'BR', poland: 'PL', portugal: 'PT',
  japan: 'JP', israel: 'IL', mexico: 'MX', sweden: 'SE', switzerland: 'CH', italy: 'IT', europe: 'EU', emea: 'EU', latam: 'LATAM', apac: 'APAC',
};
const US_STATES = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
const US_CITIES = /\b(san francisco|new york|nyc|seattle|austin|boston|chicago|los angeles|denver|atlanta|portland|san jose|palo alto|mountain view|sunnyvale|menlo park|washington)\b/i;
export function detectCountry(location) {
  const l = String(location || '');
  const low = l.toLowerCase();
  for (const [k, v] of Object.entries(COUNTRIES)) if (new RegExp(`(^|[^a-z])${k.replace('.', '\\.')}([^a-z]|$)`).test(low)) return v;
  if (US_STATES.test(l) || US_CITIES.test(l)) return 'US';
  if (/\b(london|manchester|edinburgh)\b/i.test(l)) return 'UK';
  if (/\b(berlin|munich|hamburg)\b/i.test(l)) return 'DE';
  if (/\b(toronto|vancouver|montreal)\b/i.test(l)) return 'CA';
  if (/\bdublin\b/i.test(l)) return 'IE';
  return null;
}

/* ───────── salary ───────── */
const CUR = { '$': 'USD', '€': 'EUR', '£': 'GBP', 'usd': 'USD', 'eur': 'EUR', 'gbp': 'GBP', 'cad': 'CAD', 'aud': 'AUD', 'chf': 'CHF', 'inr': 'INR' };
const toNum = (s, k) => {
  let n = parseFloat(String(s).replace(/[,\s]/g, '').replace(/\.(?=\d{3}\b)/g, ''));
  if (/k/i.test(k || '')) n *= 1000;
  if (/m/i.test(k || '')) n *= 1_000_000;
  return n;
};
/** Pull an annual salary range out of free text such as "$120k - $150k", "€60.000–80.000 / year", "USD 90,000 to 110,000". */
export function parseSalary(text) {
  if (!text) return null;
  const t = String(text).replace(/–|—/g, '-');
  const re = /(\$|€|£|usd|eur|gbp|cad|aud|chf|inr)?\s?(\d{2,3}(?:[.,]\d{3})+|\d{2,3}(?:\.\d)?\s?k|\d{4,7}|\d{2,3}(?:\.\d{1,2})?)\s?(k)?\s?(?:-|to|–|and)\s?(\$|€|£|usd|eur|gbp|cad|aud|chf|inr)?\s?(\d{2,3}(?:[.,]\d{3})+|\d{2,3}(?:\.\d)?\s?k|\d{4,7}|\d{2,3}(?:\.\d{1,2})?)\s?(k)?(?:\s?(usd|eur|gbp|cad|aud|chf|inr))?([^.\n]{0,24})/gi;
  let m;
  while ((m = re.exec(t))) {
    const cur = (m[1] || m[4] || m[7] || '').toLowerCase();
    if (!cur) continue; // require a currency marker to avoid matching years / phone numbers
    let lo = toNum(m[2].replace(/k$/i, ''), m[3] || (/k$/i.test(m[2]) ? 'k' : ''));
    let hi = toNum(m[5].replace(/k$/i, ''), m[6] || (/k$/i.test(m[5]) ? 'k' : ''));
    if (/k$/i.test(m[2]) === false && !m[3] && /k$/i.test(m[5] + (m[6] || ''))) lo *= 1000; // "120 - 150k"
    const tail = (m[8] || '').toLowerCase();
    const mult = /hour|\/hr|\bhr\b|per hour/.test(tail) ? 2080 : /month|\/mo/.test(tail) ? 12 : /week/.test(tail) ? 52 : /day/.test(tail) ? 260 : 1;
    lo *= mult; hi *= mult;
    if (lo > hi) [lo, hi] = [hi, lo];
    if (lo < 15_000 || hi > 2_000_000 || hi / lo > 4) continue; // implausible
    return { min: Math.round(lo), max: Math.round(hi), currency: CUR[cur] || 'USD' };
  }
  return null;
}

/* ───────── seniority / employment ───────── */
export function detectSeniority(title, desc = '') {
  const t = String(title).toLowerCase();
  if (/\b(intern|internship|working student|apprentice|werkstudent)\b/.test(t)) return 'intern';
  if (/\b(junior|jr\.?|entry[- ]level|graduate|associate|new grad)\b/.test(t)) return 'junior';
  if (/\b(principal|distinguished|fellow)\b/.test(t)) return 'principal';
  if (/\b(staff)\b/.test(t)) return 'staff';
  if (/\b(vp|vice president|head of|chief|cto|ceo|coo|cfo|director)\b/.test(t)) return 'director';
  if (/\b(lead|manager|team lead|tech lead)\b/.test(t)) return 'lead';
  if (/\b(senior|sr\.?|iii|iv)\b/.test(t)) return 'senior';
  if (/\b(mid|ii|intermediate)\b/.test(t)) return 'mid';
  const m = String(desc).match(/(\d{1,2})\+?\s*(?:-\s*\d{1,2}\s*)?years?\s+(?:of\s+)?(?:professional\s+|relevant\s+|work\s+)?experience/i);
  if (m) { const y = +m[1]; return y <= 1 ? 'junior' : y <= 4 ? 'mid' : y <= 7 ? 'senior' : 'staff'; }
  return null;
}
export const SENIORITY_RANK = { intern: 0, junior: 1, mid: 2, senior: 3, lead: 4, staff: 4, principal: 5, director: 5 };

export function detectEmployment(...texts) {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  if (/\bcontract(or)?\b|\bfreelance\b|\bfixed[- ]term\b/.test(t)) return 'contract';
  if (/\bpart[- ]time\b/.test(t)) return 'part-time';
  if (/\bintern(ship)?\b/.test(t)) return 'internship';
  if (/\bfull[- ]?time\b|\bpermanent\b/.test(t)) return 'full-time';
  return null;
}

/* ───────── skills ───────── */
const SKILLS = {
  javascript: ['javascript', 'js', 'ecmascript', 'es6'], typescript: ['typescript'], python: ['python'], java: ['java'], 'c++': ['c\\+\\+', 'cpp'], 'c#': ['c#', '\\.net', 'dotnet'],
  go: ['golang', 'go (?:language|developer|engineer)'], rust: ['rust'], ruby: ['ruby'], 'ruby on rails': ['rails', 'ruby on rails'], php: ['php'], laravel: ['laravel'], swift: ['swift'], kotlin: ['kotlin'],
  scala: ['scala'], elixir: ['elixir'], sql: ['sql'], nosql: ['nosql'], react: ['react', 'reactjs', 'react\\.js'], 'react native': ['react native'], vue: ['vue', 'vue\\.js'], angular: ['angular'],
  svelte: ['svelte'], 'next.js': ['next\\.?js'], 'node.js': ['node\\.?js', 'node'], express: ['express\\.?js'], django: ['django'], flask: ['flask'], fastapi: ['fastapi'], spring: ['spring boot', 'spring'],
  graphql: ['graphql'], rest: ['rest', 'restful'], grpc: ['grpc'], html: ['html5?'], css: ['css3?', 'sass', 'scss'], tailwind: ['tailwind'], postgres: ['postgres', 'postgresql'], mysql: ['mysql'],
  mongodb: ['mongo', 'mongodb'], redis: ['redis'], elasticsearch: ['elasticsearch', 'opensearch'], kafka: ['kafka'], rabbitmq: ['rabbitmq'], snowflake: ['snowflake'], bigquery: ['bigquery'],
  spark: ['spark'], airflow: ['airflow'], dbt: ['dbt'], hadoop: ['hadoop'], aws: ['aws', 'amazon web services'], gcp: ['gcp', 'google cloud'], azure: ['azure'], docker: ['docker'],
  kubernetes: ['kubernetes', 'k8s'], terraform: ['terraform'], ansible: ['ansible'], 'ci/cd': ['ci/cd', 'cicd', 'continuous integration', 'github actions', 'jenkins', 'gitlab ci'],
  linux: ['linux'], git: ['git'], devops: ['devops'], sre: ['sre', 'site reliability'], microservices: ['microservices'], 'machine learning': ['machine learning', 'ml'], 'deep learning': ['deep learning'],
  nlp: ['nlp', 'natural language processing'], 'computer vision': ['computer vision'], llm: ['llm', 'llms', 'large language models?', 'generative ai', 'genai'], pytorch: ['pytorch'], tensorflow: ['tensorflow'],
  pandas: ['pandas'], numpy: ['numpy'], 'data science': ['data science'], 'data engineering': ['data engineering'], 'data analysis': ['data analysis', 'data analytics'], tableau: ['tableau'], 'power bi': ['power bi'],
  excel: ['excel'], statistics: ['statistics', 'statistical'], 'a/b testing': ['a/b test(?:ing)?', 'experimentation'], ios: ['ios'], android: ['android'], flutter: ['flutter'], figma: ['figma'],
  'ux design': ['ux', 'user experience'], 'ui design': ['ui design', 'user interface'], 'product management': ['product management', 'product manager'], agile: ['agile', 'scrum'], jira: ['jira'],
  seo: ['seo'], sem: ['sem', 'google ads'], 'content marketing': ['content marketing'], copywriting: ['copywriting'], salesforce: ['salesforce'], hubspot: ['hubspot'], 'customer success': ['customer success'],
  sales: ['sales', 'business development'], accounting: ['accounting', 'gaap'], 'financial modeling': ['financial modeling', 'financial modelling'], recruiting: ['recruiting', 'talent acquisition'],
  security: ['security', 'infosec', 'cybersecurity'], 'penetration testing': ['penetration testing', 'pentest'], blockchain: ['blockchain', 'solidity', 'web3'], 'embedded systems': ['embedded'],
  testing: ['unit testing', 'qa', 'quality assurance', 'test automation', 'selenium', 'cypress', 'playwright'], leadership: ['leadership', 'mentoring', 'people management'],
  'project management': ['project management', 'pmp'], 'technical writing': ['technical writing'], api: ['apis?'],
};
const SKILL_RES = Object.entries(SKILLS).map(([name, pats]) => [name, new RegExp(`(?<![\\w.+#])(?:${pats.join('|')})(?![\\w+#])`, 'i')]);
export const SKILL_NAMES = Object.keys(SKILLS);

export function extractSkills(...texts) {
  const t = texts.filter(Boolean).join('\n');
  return SKILL_RES.filter(([, re]) => re.test(t)).map(([n]) => n);
}
/** Canonicalise user-entered skills ("ReactJS", "k8s") to the same vocabulary used on jobs. */
export function canonSkill(s) {
  const raw = String(s).trim();
  for (const [name, re] of SKILL_RES) { const m = re.exec(raw); if (m && m[0].length === raw.length) return name; }
  return raw.toLowerCase();
}

export const toMs = (v) => {
  if (!v) return null;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/** Build the canonical job object every adapter must return. */
export function buildJob({ source, sourceId, title, company, location, url, applyUrl, description, html, salaryText, salary, employment, department, postedAt, remote, tags = [], seniority }) {
  const desc = (description ?? htmlToText(html ?? '')).slice(0, 20000);
  const cleaned = cleanTitle(title);
  if (!cleaned || !company || !url) return null;
  const sal = salary || parseSalary(salaryText) || parseSalary(desc.slice(0, 6000));
  const loc = (location || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const rem = remote ?? detectRemote(loc, cleaned, tags.join(' '), desc.slice(0, 1500));
  return {
    id: fingerprint(company, cleaned, loc),
    title: cleaned.slice(0, 200),
    company: String(company).trim().slice(0, 120),
    companyKey: companyKey(company),
    location: loc || (rem === 2 ? 'Remote' : ''),
    country: detectCountry(loc),
    remote: rem,
    url, applyUrl: applyUrl || url,
    description: desc,
    salary: sal,
    employment: employment ? detectEmployment(employment) || employment : detectEmployment(cleaned, desc.slice(0, 600)),
    seniority: seniority || detectSeniority(cleaned, desc),
    skills: extractSkills(cleaned, tags.join(' '), desc),
    department: department || null,
    postedAt: toMs(postedAt),
    source: { source, id: String(sourceId ?? url), url },
  };
}

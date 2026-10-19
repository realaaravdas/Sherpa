import * as cheerio from 'cheerio';
import { apiFetch, safeGet, allowedByRobots, pool } from './http.js';
import fs from 'node:fs';
import { buildJob, htmlToText } from './normalize.js';

export const COMPANIES = JSON.parse(fs.readFileSync(new URL('./companies.json', import.meta.url), 'utf8'));

/*
 * Every adapter returns an array of canonical jobs (see buildJob).
 *  - `complete: true`  → the source returns the company's *entire* open-job list, so a job that
 *                         disappears from it is genuinely closed (we expire it immediately).
 *  - `complete: false` → partial/aggregated feed; jobs expire by age instead.
 */
const key = (kind, arg) => (arg ? `${kind}:${arg}` : kind);
const pretty = (slug) => COMPANIES.names[String(slug).toLowerCase()] || String(slug).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/* ───────── ATS company boards (public JSON APIs) ───────── */
export const boards = {
  greenhouse: {
    complete: true,
    async fetch(slug) {
      const d = await apiFetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
      return d.jobs.map((j) => buildJob({
        source: key('greenhouse', slug), sourceId: j.id, title: j.title, company: j.company_name || pretty(slug),
        location: j.location?.name, url: j.absolute_url, html: j.content, department: j.departments?.[0]?.name,
        postedAt: j.first_published || j.updated_at,
      }));
    },
  },
  lever: {
    complete: true,
    async fetch(slug) {
      const d = await apiFetch(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
      return d.map((j) => {
        const sr = j.salaryRange && j.salaryRange.min && j.salaryRange.max
          ? { min: Math.round(j.salaryRange.min * (j.salaryRange.interval === 'per-hour' ? 2080 : 1)), max: Math.round(j.salaryRange.max * (j.salaryRange.interval === 'per-hour' ? 2080 : 1)), currency: j.salaryRange.currency || 'USD' } : null;
        const desc = [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain].filter(Boolean).join('\n\n');
        return buildJob({
          source: key('lever', slug), sourceId: j.id, title: j.text, company: pretty(slug),
          location: j.categories?.allLocations?.join(' / ') || j.categories?.location, url: j.hostedUrl, applyUrl: j.applyUrl,
          description: desc, salary: sr, employment: j.categories?.commitment, department: j.categories?.team || j.categories?.department,
          postedAt: j.createdAt, remote: j.workplaceType === 'remote' ? 2 : j.workplaceType === 'hybrid' ? 1 : undefined,
        });
      });
    },
  },
  ashby: {
    complete: true,
    async fetch(slug) {
      const d = await apiFetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`);
      return d.jobs.filter((j) => j.isListed !== false).map((j) => {
        const comp = j.compensation?.summaryComponents?.find((c) => c.compensationType === 'Salary');
        return buildJob({
          source: key('ashby', slug), sourceId: j.id, title: j.title, company: pretty(slug),
          location: [j.location, ...(j.secondaryLocations || []).map((l) => l.location)].filter(Boolean).join(' / '),
          url: j.jobUrl, applyUrl: j.applyUrl, html: j.descriptionHtml, department: j.department, employment: j.employmentType,
          postedAt: j.publishedAt, remote: j.isRemote ? 2 : j.workplaceType === 'Hybrid' ? 1 : j.workplaceType === 'Remote' ? 2 : undefined,
          salary: comp?.minValue && comp?.maxValue ? { min: Math.round(comp.minValue), max: Math.round(comp.maxValue), currency: comp.currencyCode || 'USD' } : null,
          salaryText: j.compensation?.compensationTierSummary,
        });
      });
    },
  },
  workable: {
    complete: true,
    async fetch(slug) {
      const d = await apiFetch(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`);
      return (d.jobs || []).map((j) => buildJob({
        source: key('workable', slug), sourceId: j.shortcode, title: j.title, company: d.name || pretty(slug),
        location: [j.city, j.state, j.country].filter(Boolean).join(', '), url: j.url || j.shortlink, applyUrl: j.application_url,
        html: j.description, department: j.department, employment: j.employment_type, postedAt: j.published_on || j.created_at,
        remote: j.telecommuting ? 2 : undefined,
      }));
    },
  },
  recruitee: {
    complete: true,
    async fetch(slug) {
      const d = await apiFetch(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`);
      return (d.offers || []).filter((o) => o.status !== 'closed').map((o) => buildJob({
        source: key('recruitee', slug), sourceId: o.id, title: o.title, company: o.company_name || pretty(slug),
        location: [o.city, o.country].filter(Boolean).join(', ') || o.location, url: o.careers_url, applyUrl: o.careers_apply_url,
        html: `${o.description || ''}\n${o.requirements || ''}`, department: o.department, employment: o.employment_type_code,
        postedAt: o.published_at || o.created_at, remote: o.remote ? 2 : o.hybrid ? 1 : undefined,
        salary: o.salary?.min && o.salary?.max ? { min: +o.salary.min, max: +o.salary.max, currency: o.salary.currency || 'EUR' } : null,
      }));
    },
  },
  smartrecruiters: {
    complete: true,
    async fetch(slug) {
      const out = [];
      for (let offset = 0; offset < 600; offset += 100) {
        const d = await apiFetch(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100&offset=${offset}`);
        for (const j of d.content || []) {
          out.push(buildJob({
            source: key('smartrecruiters', slug), sourceId: j.id, title: j.name, company: j.company?.name || pretty(slug),
            location: [j.location?.city, j.location?.region, j.location?.country?.toUpperCase()].filter(Boolean).join(', '),
            url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`, description: `${j.name} at ${j.company?.name || slug}. ${j.function?.label || ''} ${j.industry?.label || ''}`.trim(),
            department: j.department?.label, employment: j.typeOfEmployment?.label, postedAt: j.releasedDate,
            remote: j.location?.remote ? 2 : j.location?.hybrid ? 1 : undefined,
          }));
        }
        if (!d.content?.length || offset + 100 >= d.totalFound) break;
      }
      return out;
    },
  },
};

/* ───────── aggregators / job boards ───────── */
export const aggregators = {
  remotive: {
    complete: false,
    async fetch() {
      const d = await apiFetch('https://remotive.com/api/remote-jobs');
      return d.jobs.map((j) => buildJob({
        source: 'remotive', sourceId: j.id, title: j.title, company: j.company_name, location: j.candidate_required_location || 'Remote',
        url: j.url, html: j.description, salaryText: j.salary, employment: j.job_type?.replace('_', ' '), department: j.category,
        postedAt: j.publication_date, remote: 2, tags: j.tags || [],
      }));
    },
  },
  remoteok: {
    complete: false,
    async fetch() {
      const d = await apiFetch('https://remoteok.com/api');
      return d.filter((j) => j.position).map((j) => buildJob({
        source: 'remoteok', sourceId: j.id, title: j.position, company: j.company, location: j.location || 'Remote', url: j.url || j.apply_url,
        html: j.description, postedAt: j.date, remote: 2, tags: j.tags || [],
        salary: j.salary_min && j.salary_max ? { min: j.salary_min, max: j.salary_max, currency: 'USD' } : null,
      }));
    },
  },
  arbeitnow: {
    complete: false,
    async fetch() {
      const out = [];
      for (let page = 1; page <= 3; page++) {
        const d = await apiFetch(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
        for (const j of d.data || []) out.push(buildJob({
          source: 'arbeitnow', sourceId: j.slug, title: j.title, company: j.company_name, location: j.location, url: j.url, html: j.description,
          postedAt: j.created_at, remote: j.remote ? 2 : undefined, tags: [...(j.tags || []), ...(j.job_types || [])], employment: (j.job_types || []).join(' '),
        }));
        if (!d.links?.next) break;
      }
      return out;
    },
  },
  jobicy: {
    complete: false,
    async fetch() {
      const d = await apiFetch('https://jobicy.com/api/v2/remote-jobs?count=100');
      return (d.jobs || []).map((j) => buildJob({
        source: 'jobicy', sourceId: j.id, title: j.jobTitle, company: j.companyName, location: j.jobGeo || 'Remote', url: j.url, html: j.jobDescription || j.jobExcerpt,
        postedAt: j.pubDate, remote: 2, employment: (j.jobType || []).join(' '), department: (j.jobIndustry || [])[0], seniority: /senior/i.test(j.jobLevel) ? 'senior' : /junior|entry/i.test(j.jobLevel) ? 'junior' : /mid/i.test(j.jobLevel) ? 'mid' : undefined,
        salary: j.annualSalaryMin && j.annualSalaryMax ? { min: +j.annualSalaryMin, max: +j.annualSalaryMax, currency: j.salaryCurrency || 'USD' } : null,
      }));
    },
  },
  weworkremotely: {
    complete: false,
    async fetch() {
      const xml = await apiFetch('https://weworkremotely.com/remote-jobs.rss', { json: false });
      const $ = cheerio.load(xml, { xmlMode: true });
      return $('item').map((_, el) => {
        const $e = $(el);
        const raw = $e.children('title').text();
        const [company, ...rest] = raw.split(': ');
        return buildJob({
          source: 'weworkremotely', sourceId: $e.children('guid').text(), title: rest.join(': ') || raw, company: company, location: $e.children('region').text() || 'Remote',
          url: $e.children('link').text(), html: $e.children('description').text(), postedAt: $e.children('pubDate').text(), remote: 2,
          department: $e.children('category').text(), employment: $e.children('type').text(),
        });
      }).get();
    },
  },
  hackernews: {
    complete: false,
    async fetch() {
      const s = await apiFetch('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=6');
      const thread = s.hits.find((h) => /who is hiring/i.test(h.title) && !/freelancer|wants to be hired/i.test(h.title));
      if (!thread) return [];
      const item = await apiFetch(`https://hn.algolia.com/api/v1/items/${thread.objectID}`, { timeoutMs: 40000 });
      const ROLE = /(engineer|developer|designer|manager|scientist|analyst|architect|lead|researcher|devops|sre|recruiter|marketing|sales|support|writer|director|head of|founder|intern|product|data)/i;
      return (item.children || []).map((c) => {
        if (!c.text) return null;
        const html = c.text.replace(/<p>/g, '<br><br>');
        const text = htmlToText(html);
        const first = text.split('\n')[0];
        const parts = first.split('|').map((p) => p.trim()).filter(Boolean);
        if (parts.length < 2) return null;
        const company = parts[0].replace(/\s*\(.*?\)\s*/g, '').slice(0, 80);
        const title = parts.slice(1).find((p) => ROLE.test(p) && p.length < 120) || null;
        if (!title || !company) return null;
        const loc = parts.slice(1).find((p) => !/^(https?:|www\.)/i.test(p) && /remote|onsite|on-site|hybrid|,|\b(US|UK|EU|NYC|SF)\b/i.test(p) && p !== title && p.length < 80) || '';
        const link = text.match(/https?:\/\/[^\s)]+/);
        return buildJob({
          source: 'hackernews', sourceId: c.id, title, company, location: loc, url: `https://news.ycombinator.com/item?id=${c.id}`, applyUrl: link ? link[0] : undefined,
          description: text, postedAt: c.created_at, remote: /remote/i.test(first) ? 2 : undefined,
        });
      }).filter(Boolean);
    },
  },
  himalayas: {
    complete: false,
    async fetch() {
      const out = [];
      for (let offset = 0; offset < 200; offset += 20) {
        const d = await apiFetch(`https://himalayas.app/jobs/api?limit=20&offset=${offset}`);
        for (const j of d.jobs || []) out.push(buildJob({
          source: 'himalayas', sourceId: j.guid || j.applicationLink, title: j.title, company: j.companyName, url: j.applicationLink || j.guid,
          location: (j.locationRestrictions || []).join(', ') || 'Remote', html: j.description || j.excerpt, postedAt: j.pubDate, remote: 2,
          employment: j.employmentType, seniority: (j.seniority || [])[0]?.toLowerCase(), tags: j.categories || [],
          salary: j.minSalary && j.maxSalary ? { min: j.minSalary, max: j.maxSalary, currency: j.currency || 'USD' } : null,
        }));
        if (!(d.jobs || []).length) break;
      }
      return out;
    },
  },
};

/* ───────── generic career pages (JSON-LD JobPosting, with HTML fallback) ───────── */
function* walkLd(node) {
  if (Array.isArray(node)) { for (const n of node) yield* walkLd(n); return; }
  if (node && typeof node === 'object') {
    yield node;
    if (node['@graph']) yield* walkLd(node['@graph']);
    if (node.itemListElement) yield* walkLd(node.itemListElement);
    if (node.item) yield* walkLd(node.item);
  }
}
const asArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function jobsFromHtml(html, pageUrl, sourceKey) {
  const $ = cheerio.load(html);
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data; try { data = JSON.parse($(el).contents().text()); } catch { return; }
    for (const n of walkLd(data)) {
      if (!asArr(n['@type']).includes('JobPosting') || !n.title) continue;
      const locs = asArr(n.jobLocation).map((l) => {
        const a = l?.address || {};
        return [a.addressLocality, a.addressRegion, typeof a.addressCountry === 'object' ? a.addressCountry?.name : a.addressCountry].filter(Boolean).join(', ');
      }).filter(Boolean);
      const base = n.baseSalary?.value;
      const salary = base && (base.minValue || base.value) ? (() => {
        const unit = String(base.unitText || 'YEAR').toUpperCase();
        const m = unit === 'HOUR' ? 2080 : unit === 'MONTH' ? 12 : unit === 'WEEK' ? 52 : unit === 'DAY' ? 260 : 1;
        return { min: Math.round((base.minValue ?? base.value) * m), max: Math.round((base.maxValue ?? base.value) * m), currency: n.baseSalary.currency || 'USD' };
      })() : null;
      const org = typeof n.hiringOrganization === 'string' ? n.hiringOrganization : n.hiringOrganization?.name;
      out.push(buildJob({
        source: sourceKey, sourceId: n.identifier?.value || n.url || n.title, title: n.title, company: org || new URL(pageUrl).hostname.replace(/^(www|careers|jobs)\./, ''),
        location: locs.join(' / '), url: n.url || pageUrl, applyUrl: n.directApply ? n.url : undefined, html: n.description, employment: asArr(n.employmentType).join(' '),
        postedAt: n.datePosted, remote: n.jobLocationType === 'TELECOMMUTE' ? 2 : undefined, salary, department: n.industry || n.occupationalCategory,
      }));
    }
  });
  return out.filter(Boolean);
}

/** Heuristic: links on a careers/listing page that look like individual job postings. */
export function jobLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);
  const seen = new Set();
  $('a[href]').each((_, a) => {
    let href; try { href = new URL($(a).attr('href'), base).href.split('#')[0]; } catch { return; }
    const text = $(a).text().replace(/\s+/g, ' ').trim();
    const u = new URL(href);
    if (!/^https?:$/.test(u.protocol) || u.hostname !== base.hostname) return;
    if (!/\/(jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|roles?|opportunit(?:y|ies))\/[^/?#]{3,}|[?&](gh_jid|jid|job_?id|req_?id)=/i.test(u.pathname + u.search)) return;
    if (/\.(pdf|png|jpg|css|js)$/i.test(u.pathname) || href === base.href) return;
    if (text.length > 0 && text.length < 4) return;
    seen.add(href);
  });
  return [...seen];
}

export const generic = {
  complete: false,
  async fetch(pageUrl, { maxDetail = 40 } = {}) {
    const sourceKey = `page:${new URL(pageUrl).hostname}`;
    if (!(await allowedByRobots(pageUrl))) throw new Error('Disallowed by robots.txt');
    const page = await safeGet(pageUrl);
    let jobs = jobsFromHtml(page.text, page.url, sourceKey);
    if (jobs.length < 3) { // listing page without structured data → follow links to detail pages
      const links = jobLinks(page.text, page.url).slice(0, maxDetail);
      const detail = await pool(links, 5, async (l) => {
        if (!(await allowedByRobots(l))) return [];
        const p = await safeGet(l);
        const found = jobsFromHtml(p.text, p.url, sourceKey);
        if (found.length) return found;
        const $ = cheerio.load(p.text);
        const title = $('meta[property="og:title"]').attr('content') || $('h1').first().text();
        const company = $('meta[property="og:site_name"]').attr('content') || new URL(l).hostname.replace(/^(www|careers|jobs)\./, '');
        const body = $('main').length ? $('main').html() : $('body').html();
        return [buildJob({ source: sourceKey, sourceId: l, title: String(title).split(/\s[|–-]\s/)[0], company, url: l, html: body })].filter(Boolean);
      });
      jobs = [...jobs, ...detail.flat().filter((j) => j && !j.error)];
    }
    const seen = new Set();
    return jobs.filter((j) => (seen.has(j.id) ? false : seen.add(j.id)));
  },
};

/** Work out which ATS a pasted careers URL belongs to, so users can just paste a link. */
export function detectSource(input) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && !/^https?:/i.test(input)) return null;
  let u;
  try { u = new URL(/^https?:/i.test(input) ? input : `https://${input}`); } catch { return null; }
  const h = u.hostname.toLowerCase(), p = u.pathname.split('/').filter(Boolean);
  const gh = h.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/) && (p[0] || u.searchParams.get('for'));
  if (gh) return { kind: 'greenhouse', arg: gh };
  if (h === 'jobs.lever.co' && p[0]) return { kind: 'lever', arg: p[0] };
  if (h === 'jobs.ashbyhq.com' && p[0]) return { kind: 'ashby', arg: p[0] };
  if (h === 'apply.workable.com' && p[0]) return { kind: 'workable', arg: p[0] };
  if (h.endsWith('.recruitee.com')) return { kind: 'recruitee', arg: h.split('.')[0] };
  if ((h === 'jobs.smartrecruiters.com' || h === 'careers.smartrecruiters.com') && p[0]) return { kind: 'smartrecruiters', arg: p[0] };
  if (h.endsWith('.workable.com') && h !== 'apply.workable.com') return { kind: 'workable', arg: h.split('.')[0] };
  return { kind: 'page', arg: u.href };
}

export async function runAdapter(kind, arg) {
  if (boards[kind]) return boards[kind].fetch(arg);
  if (aggregators[kind]) return aggregators[kind].fetch();
  if (kind === 'page') return generic.fetch(arg);
  throw new Error(`Unknown source kind ${kind}`);
}
export const isComplete = (kind) => (boards[kind] ? boards[kind].complete : kind === 'page' ? false : aggregators[kind]?.complete ?? false);
export { key as sourceKey };

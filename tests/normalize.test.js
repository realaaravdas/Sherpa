import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSalary, detectSeniority, extractSkills, canonSkill, htmlToText, fingerprint, detectRemote, detectCountry, cleanTitle, buildJob } from '../src/scraper/normalize.js';
import { jobsFromHtml, jobLinks, detectSource } from '../src/scraper/adapters.js';

test('salary parsing', () => {
  assert.deepEqual(parseSalary('$120k - $150k a year'), { min: 120000, max: 150000, currency: 'USD' });
  assert.deepEqual(parseSalary('USD 90,000 to 110,000'), { min: 90000, max: 110000, currency: 'USD' });
  assert.deepEqual(parseSalary('€60.000–80.000'), { min: 60000, max: 80000, currency: 'EUR' });
  assert.deepEqual(parseSalary('£45 - £60 per hour'), { min: 93600, max: 124800, currency: 'GBP' });
  assert.equal(parseSalary('Founded 2010 - 2015, call 555 1234'), null);
  assert.equal(parseSalary('between 2020 and 2024'), null);
});
test('seniority', () => {
  assert.equal(detectSeniority('Senior Software Engineer'), 'senior');
  assert.equal(detectSeniority('Staff Engineer'), 'staff');
  assert.equal(detectSeniority('Junior Designer'), 'junior');
  assert.equal(detectSeniority('Engineering Manager'), 'lead');
  assert.equal(detectSeniority('Engineer', 'You have 6+ years of experience'), 'senior');
});
test('skills extraction handles c++, node.js, k8s and avoids false hits', () => {
  const s = extractSkills('We use C++, Node.js and k8s with TypeScript. Go to market with react.');
  for (const k of ['c++', 'node.js', 'kubernetes', 'typescript', 'react']) assert.ok(s.includes(k), k);
  assert.ok(!s.includes('java'));
  assert.equal(canonSkill('ReactJS'), 'react'); assert.equal(canonSkill('K8s'), 'kubernetes'); assert.equal(canonSkill('Postgres'), 'postgres');
});
test('html to text handles double-escaped markup', () => {
  assert.equal(htmlToText('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;/ul&gt;'), 'Hello & welcome\n• One');
  assert.ok(!htmlToText('<script>alert(1)</script><p>Hi</p>').includes('alert'));
});
test('fingerprint dedupes cross-board variants', () => {
  assert.equal(fingerprint('Acme, Inc.', 'Senior Engineer (m/w/d)', 'Berlin, Germany'), fingerprint('ACME', 'Senior Engineer', 'Berlin'));
  assert.notEqual(fingerprint('Acme', 'Senior Engineer', 'Berlin'), fingerprint('Acme', 'Senior Engineer', 'Paris'));
  assert.equal(cleanTitle('Data Analyst - Remote'), 'Data Analyst');
});
test('remote + country detection', () => {
  assert.equal(detectRemote('Remote (US)'), 2); assert.equal(detectRemote('Hybrid - London'), 1); assert.equal(detectRemote('Austin, TX'), 0);
  assert.equal(detectCountry('Austin, TX'), 'US'); assert.equal(detectCountry('Berlin, Germany'), 'DE'); assert.equal(detectCountry('London'), 'UK');
});
test('JSON-LD JobPosting extraction', () => {
  const html = `<html><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'JobPosting', title: 'Data Engineer', description: '<p>Build pipelines with Python and Airflow</p>', datePosted: '2026-10-01', hiringOrganization: { name: 'Initech' }, jobLocationType: 'TELECOMMUTE', jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' } }, baseSalary: { currency: 'USD', value: { minValue: 60, maxValue: 80, unitText: 'HOUR' } }, url: 'https://initech.com/jobs/1' }] })}</script></html>`;
  const [j] = jobsFromHtml(html, 'https://initech.com/careers', 'page:initech.com');
  assert.equal(j.title, 'Data Engineer'); assert.equal(j.company, 'Initech'); assert.equal(j.remote, 2);
  assert.equal(j.salary.min, 124800); assert.ok(j.skills.includes('airflow')); assert.equal(j.country, 'US');
});
test('job link discovery & ATS detection', () => {
  const links = jobLinks('<a href="/jobs/senior-dev-123">Senior Dev</a><a href="/about">About</a><a href="/careers/data-eng">Data</a><a href="https://other.com/jobs/x">x</a>', 'https://acme.com/careers');
  assert.deepEqual(links.sort(), ['https://acme.com/careers/data-eng', 'https://acme.com/jobs/senior-dev-123']);
  assert.deepEqual(detectSource('https://boards.greenhouse.io/stripe'), { kind: 'greenhouse', arg: 'stripe' });
  assert.deepEqual(detectSource('jobs.lever.co/palantir/abc'), { kind: 'lever', arg: 'palantir' });
  assert.deepEqual(detectSource('https://jobs.ashbyhq.com/openai'), { kind: 'ashby', arg: 'openai' });
  assert.equal(detectSource('https://acme.com/careers').kind, 'page');
});
test('buildJob requires title, company, url', () => {
  assert.equal(buildJob({ source: 'x', title: '', company: 'A', url: 'u' }), null);
  const j = buildJob({ source: 'x', title: 'Dev', company: 'A', url: 'https://a/b', description: 'Pay: $100k - $130k. Remote friendly.' });
  assert.equal(j.salary.max, 130000); assert.equal(j.remote, 2);
});

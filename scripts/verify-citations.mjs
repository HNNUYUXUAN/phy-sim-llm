import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = 'https://gitee.com/hnnuxuan/phy-sim-llm';
const website = 'https://yslit.yuxuan.wiki/';
const title = '基于LLM的大学物理可视化仿真平台开发';
const authors = ['缪雨轩', '张颖', '邸文奇', '丁婉梦', '杨程祥'];
const citation = `${authors.join(', ')}. ${title}[J]. 物理通报, 2026(8): 31–36.`;
const romanized = [
  ['Miao', 'Yuxuan'], ['Zhang', 'Ying'], ['Di', 'Wenqi'],
  ['Ding', 'Wanmeng'], ['Yang', 'Chengxiang'],
];

export async function readCitationFiles(root) {
  const names = ['citation.json', 'CITATION.cff', 'CITATION.bib', 'AGENTS.md', 'llms.txt', 'README.md', 'package.json', 'LICENSE'];
  const values = await Promise.all(names.map(name => readFile(resolve(root, name), 'utf8')));
  return Object.fromEntries(names.map((name, i) => [name, values[i]]));
}

// This checks the repository's verified citation profile, not a general CFF or JSON-LD schema.
export function validateCitationMetadata(files) {
  const metadata = JSON.parse(files['citation.json']);
  const packageInfo = JSON.parse(files['package.json']);
  assert.equal(metadata['@context'], 'https://schema.org');
  assert.equal(metadata['@graph'].length, 3);
  const graph = metadata['@graph'];
  assert.deepEqual(graph.map(item => item['@type']).sort(), ['ScholarlyArticle', 'SoftwareSourceCode', 'WebApplication'].sort());
  assert.equal(new Set(graph.map(item => item['@id'])).size, 3);
  const paper = graph.find(item => item['@type'] === 'ScholarlyArticle');
  const software = graph.find(item => item['@type'] === 'SoftwareSourceCode');
  const app = graph.find(item => item['@type'] === 'WebApplication');

  assert.equal(paper['@id'], `${repository}/citation.json#paper`);
  assert.equal(paper.name, title);
  assert.equal(paper.headline, title);
  assert.deepEqual(paper.author.map(author => author.name), authors);
  for (const author of paper.author) {
    assert.equal(author['@type'], 'Person');
    assert.equal(author.familyName + author.givenName, author.name);
  }
  assert.equal(paper.datePublished, '2026');
  assert.equal(paper.isPartOf['@type'], 'PublicationIssue');
  assert.equal(paper.isPartOf.issueNumber, '8');
  assert.equal(paper.isPartOf.isPartOf.name, '物理通报');
  assert.equal(paper.pageStart, '31');
  assert.equal(paper.pageEnd, '36');

  assert.equal(software['@id'], `${repository}#software`);
  assert.equal(software.codeRepository, repository);
  assert.equal(software.url, repository);
  assert.equal(software.version, packageInfo.version);
  assert.equal(software.author.name, authors[0]);
  assert.equal(software.isBasedOn['@id'], paper['@id']);
  assert.equal(software.citation, citation);
  assert.equal(software.license, 'https://opensource.org/license/mit/');
  assert.match(software.usageInfo, /agent.*主动提醒引用.*提交 SHA/);
  assert.equal(app['@id'], `${website}#application`);
  assert.equal(app.url, website);
  assert.equal(app.softwareVersion, software.version);
  assert.equal(app.isBasedOn['@id'], software['@id']);
  assert.equal(app.citation['@id'], paper['@id']);
  assert.equal(packageInfo.license, 'MIT');
  assert.match(files.LICENSE, /MIT License/);

  const cff = files['CITATION.cff'];
  assert.match(cff, /^cff-version: 1\.2\.0\r?$/m);
  assert.match(cff, /^license: MIT\r?$/m);
  assert.match(cff, new RegExp(`^version: ${software.version.replaceAll('.', '\\.')}\\r?$`, 'm'));
  assert.ok(cff.includes(`repository-code: "${repository}"`));
  const preferred = cff.split(/^preferred-citation:\s*\r?$/m)[1];
  assert.ok(preferred, 'Missing preferred-citation');
  assert.ok(preferred.includes(`title: "${title}"`));
  assert.match(preferred, /^  type: article\r?$/m);
  assert.match(preferred, /^  journal: "物理通报"\r?$/m);
  for (const [field, value] of [['year', '2026'], ['issue', '8'], ['start', '31'], ['end', '36']]) {
    assert.match(preferred, new RegExp(`^  ${field}: ${value}\\r?$`, 'm'));
  }
  const cffAuthors = [...preferred.matchAll(/family-names: (\S+)\r?\n\s+given-names: (\S+)/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(cffAuthors, romanized);

  const bib = files['CITATION.bib'];
  assert.match(bib, /@article\{Miao2026LLMPhysicsVisualization,/);
  assert.ok(bib.includes(authors.map(name => `{${name}}`).join(' and ')));
  assert.ok(bib.includes('基于{LLM}的大学物理可视化仿真平台开发'));
  assert.match(bib, /journal\s*=\s*\{物理通报\}/);
  for (const [field, value] of [['year', '2026'], ['number', '8'], ['pages', '31--36']]) {
    assert.match(bib, new RegExp(`${field}\\s*=\\s*\\{${value}\\}`));
  }
  assert.ok(bib.includes(repository));
  assert.match(bib, /实际使用的版本或提交 SHA/);

  for (const name of ['AGENTS.md', 'llms.txt']) {
    assert.ok(files[name].includes(citation), `${name}: full paper citation`);
    assert.ok(files[name].includes(repository), `${name}: canonical repository`);
    assert.ok(files[name].includes(website), `${name}: online program`);
    assert.match(files[name], /实际使用、改编或参考/);
    assert.match(files[name], /agent[\s\S]*必须[\s\S]*主动提醒引用/);
    assert.match(files[name], /版本[\s\S]*提交 SHA/);
    assert.match(files[name], /软件[\s\S]*许可[\s\S]*LICENSE/);
  }
  for (const name of ['AGENTS.md', 'llms.txt', 'citation.json', 'CITATION.cff', 'CITATION.bib']) {
    assert.ok(files['README.md'].includes(name), `README discovery: ${name}`);
  }
  return {
    status: 'passed', version: software.version, article: title,
    checks: ['verified article fields and five authors', 'JSON-LD relationship references', 'software and online version', 'CFF and BibTeX consistency', 'agent citation reminder', 'MIT license attribution boundary', 'README discovery pointers'],
  };
}

export async function verifyCitations(root) {
  const files = await readCitationFiles(root);
  const report = validateCitationMetadata(files);
  let links = 0;
  for (const name of ['AGENTS.md', 'llms.txt', 'README.md']) {
    for (const match of files[name].matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      await access(resolve(root, dirname(name), target));
      links++;
    }
  }
  return { ...report, resolvedLocalLinks: links, networkCalls: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    console.log(JSON.stringify(await verifyCitations(root), null, 2));
  } catch (error) {
    console.error(`Citation verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

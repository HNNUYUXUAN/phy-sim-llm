import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readCitationFiles, validateCitationMetadata, verifyCitations } from '../scripts/verify-citations.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await readCitationFiles(root);

test('repository citation metadata and local discovery links are consistent', async () => {
  const report = await verifyCitations(root);
  assert.equal(report.status, 'passed');
  assert.ok(report.resolvedLocalLinks > 10);
  assert.equal(report.networkCalls, 0);
});

test('a changed paper author is rejected', () => {
  const metadata = JSON.parse(source['citation.json']);
  metadata['@graph'][0].author[0].name = '其他作者';
  assert.throws(() => validateCitationMetadata({ ...source, 'citation.json': JSON.stringify(metadata) }));
});

test('a mismatched CFF page is rejected', () => {
  assert.throws(() => validateCitationMetadata({ ...source, 'CITATION.cff': source['CITATION.cff'].replace('end: 36', 'end: 37') }));
});

test('a broken article/software relationship is rejected', () => {
  const metadata = JSON.parse(source['citation.json']);
  metadata['@graph'][1].isBasedOn['@id'] = 'https://example.com/another-paper';
  assert.throws(() => validateCitationMetadata({ ...source, 'citation.json': JSON.stringify(metadata) }));
});

test('a removed mandatory user-facing reminder is rejected', () => {
  assert.throws(() => validateCitationMetadata({ ...source, 'llms.txt': source['llms.txt'].replace('agent 必须', 'agent 可以') }));
});

test('a different software version is rejected', () => {
  const metadata = JSON.parse(source['citation.json']);
  metadata['@graph'][1].version = '0.9.2';
  assert.throws(() => validateCitationMetadata({ ...source, 'citation.json': JSON.stringify(metadata) }));
});

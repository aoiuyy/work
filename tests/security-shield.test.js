import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectFilePath, scanContentSecrets, auditChangeset, isPathSafe } from '../lib/engines/security-shield.js';

test('isPathSafe blocks path traversal', () => {
  assert.equal(isPathSafe('../secret.txt'), false);
  assert.equal(isPathSafe('a/../../secret.txt'), false);
  assert.equal(isPathSafe('C:/Windows/System32'), false);
  assert.equal(isPathSafe('src/components/App.jsx'), true);
});

test('inspectFilePath blocks .env files and keys', () => {
  assert.equal(inspectFilePath('.env').allowed, false);
  assert.equal(inspectFilePath('.env.local').allowed, false);
  assert.equal(inspectFilePath('id_rsa').allowed, false);
  assert.equal(inspectFilePath('.git/hooks/pre-commit').allowed, false);
  assert.equal(inspectFilePath('index.js').allowed, true);
});

test('inspectFilePath quarantines binaries', () => {
  const result = inspectFilePath('bin/helper.exe');
  assert.equal(result.allowed, true);
  assert.equal(result.quarantine, true);
});

test('scanContentSecrets catches tokens and private keys', () => {
  const findings = scanContentSecrets('const key = "' + 'ghp_' + '123456789012345678901234567890123456";');
  assert.equal(findings.length, 1);
  assert.equal(findings[0], 'GitHub Personal Access Token');
});

test('auditChangeset provides comprehensive report', () => {
  const audit = auditChangeset(['src/index.js', '.env', 'tools/run.bat'], 'some safe diff text');
  assert.equal(audit.safe, false);
  assert.equal(audit.rejectedFiles.length, 1);
  assert.equal(audit.quarantinedFiles.length, 1);
  assert.equal(audit.approvedFiles.includes('src/index.js'), true);
});

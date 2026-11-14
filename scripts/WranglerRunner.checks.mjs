import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { WranglerRunner } from './WranglerRunner.mjs';

function withLocalCLI(bin, callback) {
  const directory = mkdtempSync(join(tmpdir(), 'nuwa-wrangler-cli-'));
  const original = WranglerRunner.packageURL;

  try {
    const manifestPath = join(directory, 'package.json');
    writeFileSync(manifestPath, JSON.stringify({ bin: { wrangler: bin } }));
    mkdirSync(join(directory, 'bin'));
    writeFileSync(join(directory, 'bin', 'wrangler.js'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    WranglerRunner.packageURL = pathToFileURL(manifestPath);

    return callback(directory);
  } finally {
    WranglerRunner.packageURL = original;
    rmSync(directory, { recursive: true, force: true });
  }
}

test('executes Wrangler JavaScript directly with Node, preserving explicit config arguments', () => {
  withLocalCLI('bin/wrangler.js', () => {
    const argumentsValue = [
      'd1', 'execute', 'DB', '--remote', '--config', '.wrangler.deploy.jsonc',
    ];
    const output = WranglerRunner.execute(argumentsValue, { encoding: 'utf8' });

    assert.deepEqual(JSON.parse(output), argumentsValue);
  });
});

test('rejects a Wrangler CLI outside its installed package or without a JS entry', () => {
  for (const entry of ['../outside.js', 'bin/wrangler.cmd', '']) {
    withLocalCLI(entry, () => {
      assert.throws(() => WranglerRunner.executablePath());
    });
  }
});

test('uses the local installed Wrangler executable, not a global shim', () => {
  const manifest = JSON.parse(readFileSync(WranglerRunner.packageURL, 'utf8'));
  const expectedBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.wrangler;
  const executable = WranglerRunner.executablePath();

  assert.equal(typeof expectedBin, 'string');
  assert.ok(existsSync(executable));

  const version = execFileSync(process.execPath, [executable, '--version'], {
    encoding: 'utf8',
  });

  assert.match(version, /\d+\.\d+\.\d+/);
});

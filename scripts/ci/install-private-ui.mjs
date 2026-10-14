#!/usr/bin/env node
import { readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIN, BootstrapError, downloadPinnedArchive, warmCanonicalStore, installCanonicalFrozen } from './ui-auth-bootstrap.mjs';

const requireFact = (ok, code) => { if (!ok) throw new BootstrapError(code); };
export function parseArguments(args) {
  const allowed = new Set(['--repo', '--store-dir', '--staging-root', '--report', '--archive']);
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    requireFact(allowed.has(args[i]) && typeof args[i + 1] === 'string' && args[i + 1].length > 0 && !args[i + 1].startsWith('--'), 'UI_INSTALL_ARGUMENT');
    requireFact(!Object.hasOwn(values, args[i]), 'UI_INSTALL_DUPLICATE_ARGUMENT'); values[args[i]] = args[i + 1];
  }
  for (const key of ['--store-dir', '--staging-root', '--report', '--archive']) requireFact(Boolean(values[key]), 'UI_INSTALL_REQUIRED_ARGUMENT');
  return values;
}
export async function externalOutput(repo, path) {
  const absolute = resolve(path); const parent = await realpath(dirname(absolute)); const actual = resolve(parent, basename(absolute));
  const rel = relative(repo, actual);
  requireFact(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel), 'UI_OUTPUT_INSIDE_SOURCE');
  return actual;
}

export async function installPrivateUi({ args, environment = process.env, fetchImplementation }) {
  const values = parseArguments(args); const repo = await realpath(resolve(values['--repo'] ?? '.'));
  const archivePath = await externalOutput(repo, values['--archive']); const reportPath = await externalOutput(repo, values['--report']);
  requireFact(archivePath !== reportPath, 'UI_OUTPUT_COLLISION');
  const state = JSON.parse(await readFile(resolve(repo, '.workloom-ui.json'), 'utf8'));
  const download = await downloadPinnedArchive({ releaseReadToken: environment.WORKLOOM_UI_RELEASE_READ_TOKEN, state, fetchImplementation });
  // This private original archive stays in runner temporary storage for the
  // following credential-free tests. It is never checked in or uploaded.
  let archiveCreated = false;
  try {
    await writeFile(archivePath, download.bytes, { flag: 'wx', mode: 0o600 }); archiveCreated = true;
    const options = { repoRoot: repo, storeDir: resolve(values['--store-dir']), stagingRoot: resolve(values['--staging-root']), environment };
    const warm = await warmCanonicalStore({ ...options, archiveBytes: download.bytes });
    const installed = await installCanonicalFrozen({ ...options, warmProof: warm });
    const result = { ...installed, download: download.proof, originalArchive: { path: archivePath, mode: '0600', bytes: PIN.bytes, sha256: PIN.sha256, publicArtifactUploaded: false } };
    await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  } catch (error) {
    if (archiveCreated) await rm(archivePath);
    throw error;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  installPrivateUi({ args: process.argv.slice(2) }).then(result => {
    process.stdout.write(JSON.stringify({ frozenInstallPassed: result.frozenInstallPassed, version: result.installedVersion, clients: result.installedClients.length, originalLockSha256: result.originalLockSha256, originalLockUnchanged: result.originalLockUnchanged }) + '\n');
  }).catch(error => {
    process.stderr.write(JSON.stringify({ code: error instanceof BootstrapError ? error.code : 'UI_BOOTSTRAP_FAILED', message: error instanceof BootstrapError ? error.message : 'Bootstrap filesystem/runtime failed' }) + '\n'); process.exitCode = 1;
  });
}

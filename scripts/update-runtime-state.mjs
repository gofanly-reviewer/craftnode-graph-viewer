#!/usr/bin/env node
import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graphPath = path.join(root, 'public/graph.json');
const defaultStatePath = path.join(root, 'public/runtime-state.json');
const VALID = new Set(['READY', 'RUNNING', 'DONE', 'BLOCKED', 'FAILED']);

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/update-runtime-state.mjs --node ID --status READY|RUNNING|DONE|BLOCKED|FAILED [--worker NAME] [--result TEXT] [--commit SHA] [--proof REF] [--expected-revision N] [--no-push]');
      process.exit(0);
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'no-push') values.noPush = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
      if (key === 'expected-revision') values.expectedRevision = Number(value);
      else values[key] = value;
    }
  }
  if (!values.node || !values.status) throw new Error('--node and --status are required');
  if (!VALID.has(values.status)) throw new Error(`Invalid status: ${values.status}`);
  return values;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  return result.stdout.trim();
}

function acquireLock(lockPath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      return () => { closeSync(fd); unlinkSync(lockPath); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
      const stat = statSync(lockPath);
        const text = readFileSync(lockPath, 'utf8');
        const pid = Number(text.trim().split(/\s+/, 1)[0]);
        let ownerAlive = false;
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); ownerAlive = true; }
          catch (signalError) { ownerAlive = signalError.code === 'EPERM'; }
        }
        if (!ownerAlive && Date.now() - stat.mtimeMs > 5 * 60_000) unlinkSync(lockPath);
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    }
  }
  throw new Error('Timed out waiting for another runtime-state update to finish.');
}

function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o644);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

function applyTransition(graph, state, args) {
  if (args.expectedRevision !== undefined && args.expectedRevision !== state.revision) {
    throw new Error(`Stale state revision: expected ${args.expectedRevision}, current ${state.revision}.`);
  }
  const sourceNode = graph.nodes.find((node) => node.id === args.node);
  const target = state.nodes.find((node) => node.id === args.node);
  if (!sourceNode || !target) throw new Error(`Unknown node: ${args.node}`);
  const incoming = graph.edges.filter((edge) => edge.target === args.node).map((edge) => edge.source);
  const dependenciesDone = incoming.every((id) => state.nodes.find((node) => node.id === id)?.status === 'DONE');

  if (args.status === 'READY') {
    if (target.status !== 'BLOCKED' || !dependenciesDone) {
      throw new Error(`${args.node} can become READY only from BLOCKED after every dependency is DONE.`);
    }
    Object.assign(target, { status: 'READY', worker: null, startedAt: null, result: null, commit: null, proof: null });
  } else if (args.status === 'RUNNING') {
    if (target.status !== 'READY' || !dependenciesDone) {
      throw new Error(`${args.node} can become RUNNING only from READY after every dependency is DONE.`);
    }
    if (!args.worker?.trim()) throw new Error('--worker is required when starting a node.');
    Object.assign(target, {
      status: 'RUNNING',
      worker: args.worker.trim(),
      startedAt: new Date().toISOString(),
      result: null,
      commit: args.commit ?? null,
      proof: args.proof ?? null,
    });
  } else if (args.status === 'DONE' || args.status === 'FAILED') {
    if (target.status !== 'RUNNING') throw new Error(`${args.node} can become ${args.status} only from RUNNING.`);
    if (!args.result?.trim() || !args.proof?.trim()) throw new Error('--result and --proof are required to finish a node.');
    Object.assign(target, {
      status: args.status,
      result: args.result.trim(),
      commit: args.commit ?? target.commit,
      proof: args.proof.trim(),
    });
  } else {
    throw new Error('BLOCKED is derived from graph dependencies. Use READY to unblock a node whose dependencies are DONE.');
  }
  state.revision += 1;
  state.updatedAt = new Date().toISOString();
}

function publishState() {
  const branch = run('git', ['branch', '--show-current']);
  if (branch !== 'main') throw new Error(`Publish runtime state from the main branch; current branch is ${branch}.`);
  run('npm', ['run', 'build:pages']);
  const changed = run('git', ['status', '--porcelain', '--', 'public/runtime-state.json', 'docs']);
  if (!changed) throw new Error('Runtime state did not change; no update was published.');
  run('git', ['add', '--', 'public/runtime-state.json', 'docs']);
  run('git', ['-c', 'user.name=Craftnode Runtime', '-c', 'user.email=craftnode-runtime@users.noreply.github.com', 'commit', '-m', 'runtime: update graph state']);
  run('git', ['push', 'origin', 'HEAD:main']);
}

const args = parseArgs(process.argv.slice(2));
const unlock = acquireLock(path.join(root, 'public/.runtime-state.lock'));
let state;
try {
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  state = JSON.parse(readFileSync(defaultStatePath, 'utf8'));
  if (state.schemaVersion !== 1 || !Array.isArray(state.nodes)) throw new Error('Unsupported runtime-state schema.');
  applyTransition(graph, state, args);
  atomicWrite(defaultStatePath, `${JSON.stringify(state, null, 2)}\n`);
  if (!args.noPush) publishState();
} finally {
  unlock();
}

console.log(`${args.node}: ${state.nodes.find((node) => node.id === args.node).status} (revision ${state.revision})`);
if (!args.noPush) {
  console.log('Published. GitHub Pages will redeploy from the new source revision.');
} else {
  console.log('Local source updated; --no-push skipped GitHub publication.');
}

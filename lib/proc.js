// Every ffmpeg / ffprobe the worker runs goes through here (Astra on worker
// #3): under OS-enforced limits, so no flag we forget and no input we didn't
// foresee can make a child write past its budget or burn CPU without end.
//
//   RLIMIT_FSIZE  the most bytes the child may write to ANY file (ulimit -f).
//                 Over it, the kernel stops the write (SIGXFSZ) — the job
//                 fails. Runs that should write no file at all (probes,
//                 counting, decoding to a pipe) get 0.
//   RLIMIT_CPU    the most CPU seconds (ulimit -t). ffmpeg catches SIGXCPU
//                 and exits non-zero — the job fails.
//   cwd           the job's own temp directory.
//   a wall-clock deadline on top (SIGKILL).
//
// Implemented as sh -c 'ulimit -f N && ulimit -t T && exec …' — the limits are
// set in the shell, inherited by the exec'd program, and a failure to set
// them stops the run (&&). `ulimit -f` counts blocks whose size differs
// between shells (dash: 512 bytes, bash/zsh: 1024), so the unit is MEASURED
// once (a 1-block limit, one oversized write) rather than assumed.
const { spawn, execFileSync } = require('child_process');
const { mkdtempSync, statSync, rmSync } = require('fs');
const os = require('os');
const path = require('path');

class OsLimitError extends Error {}
class ProcError extends Error {}

let unit = null;
/** Bytes per `ulimit -f` block in /bin/sh, measured. */
function blockUnit() {
  if (unit) return unit;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mixmi-ulimit-'));
  try {
    const f = path.join(dir, 'probe');
    // the same limits as every other child: CPU (ulimit -t) and a wall-clock deadline
    try { execFileSync('/bin/sh', ['-c', 'ulimit -t 5 && ulimit -f 1 && exec head -c 8192 /dev/zero > "$1"', 'sh', f], { stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL' }); } catch { /* killed by SIGXFSZ, as intended */ }
    const n = statSync(f).size;
    if (n !== 512 && n !== 1024) throw new Error(`unexpected ulimit -f block size: ${n}`);
    unit = n;
    return unit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The closed input rule (lib/inputs), enforced for every ffmpeg / ffprobe:
 * each input is exactly `-protocol_whitelist file -f <allowlisted> -i <path>`,
 * the path absolute and inside `cwd` (the job's directory), and there is at
 * least one. Anything else is refused before a process starts.
 */
function checkInputs(cmd, args, cwd) {
  if (cmd !== 'ffmpeg' && cmd !== 'ffprobe') return;
  const { ALLOWED, InputRefused } = require('./inputs');
  const refuse = (why) => { throw new InputRefused(`refused ${cmd} input: ${why}`); };
  if (!cwd) refuse('no job directory');
  const root = path.resolve(cwd);
  const at = args.reduce((acc, a, i) => (a === '-i' ? [...acc, i] : acc), []);
  if (!at.length) refuse('no -i');
  for (const k of at) {
    const file = args[k + 1];
    if (args[k - 4] !== '-protocol_whitelist' || args[k - 3] !== 'file') refuse('no -protocol_whitelist file');
    if (args[k - 2] !== '-f' || !ALLOWED.has(args[k - 1])) refuse(`container not named from the allowlist (${args[k - 2] === '-f' ? args[k - 1] : 'none'})`);
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file) refuse('not an absolute local path');
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) refuse('outside the job directory');
  }
}

/** Read per call (tests lower it): the CPU-seconds limit for a run with this deadline. */
const cpuFor = (timeoutMs) => Number(process.env.WORKER_CPU_LIMIT_SEC) || Math.max(1, Math.ceil(timeoutMs / 1000));

/**
 * Run `cmd args` under the limits. Resolves { code, stdout, stderr, stopped }.
 * Rejects OsLimitError (a file-size limit), ProcError (non-zero exit — a CPU
 * limit ends this way too), or an Error with .deadline (wall clock).
 *   fsizeBytes   max bytes any file may be written (0: none)
 *   timeoutMs    the wall-clock deadline; the CPU limit follows it
 *   onStdout     (chunk) => true to stop early (the child is killed; resolves stopped)
 *   keepStdout   collect stdout (up to maxStdout bytes)
 */
function run(cmd, args, { fsizeBytes = 0, timeoutMs = 8 * 60 * 1000, cwd, onStdout, keepStdout = false, maxStdout = 64 * 1024 * 1024 } = {}) {
  try {
    checkInputs(cmd, args, cwd);
  } catch (e) {
    return Promise.reject(e);
  }
  const blocks = Math.floor(fsizeBytes / blockUnit());
  const cpu = cpuFor(timeoutMs);
  return new Promise((resolve, reject) => {
    const p = spawn('/bin/sh', ['-c', 'ulimit -f "$1" && ulimit -t "$2" && shift 2 && exec "$@"', 'sh', String(blocks), String(cpu), cmd, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let outBytes = 0, stopped = false, timedOut = false, stderr = '';
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    p.stdout.on('data', (c) => {
      if (stopped) return;
      if (keepStdout && outBytes < maxStdout) { out.push(c); outBytes += c.length; }
      if (onStdout && onStdout(c)) { stopped = true; p.kill('SIGKILL'); }
    });
    p.stderr.on('data', (c) => { if (stderr.length < 4000) stderr += c; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(Object.assign(new Error(`${cmd} timed out`), { deadline: true }));
      if (signal === 'SIGXFSZ') return reject(new OsLimitError(`${cmd} hit its ${fsizeBytes}-byte file-size limit`));
      if (signal === 'SIGXCPU') return reject(new OsLimitError(`${cmd} hit its ${cpu}s CPU limit`));
      if (stopped) return resolve({ code, stdout: Buffer.concat(out), stderr, stopped });
      if (code !== 0) return reject(new ProcError(`${cmd} failed (exit ${code}${signal ? `, ${signal}` : ''}${code === 255 ? '; a CPU-time limit ends it this way' : ''}): ${stderr.trim().split('\n').pop() || ''}`.slice(0, 300)));
      resolve({ code, stdout: Buffer.concat(out), stderr, stopped });
    });
  });
}

module.exports = { run, blockUnit, checkInputs, OsLimitError, ProcError, cpuFor };

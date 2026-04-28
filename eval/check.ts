/**
 * SWE-bench Pro grader — runnable wrapper.
 *
 * Reads eval/metadata.json (written by the importer), captures the
 * agent's diff against origin/main, applies it inside the official
 * SWE-bench Pro Docker image, runs the configured test files, and
 * compares the test outcomes against fail_to_pass / pass_to_pass.
 *
 * Score (out of 5):
 *   1 — diff applies cleanly inside the image
 *   3 — every fail_to_pass test now passes
 *   1 — every pass_to_pass test still passes (regression check)
 *
 * Gemini judging is NOT used here — SWE-bench Pro's grading is
 * deterministic. The Docker image already has the build environment
 * preconfigured; we just exec the test command.
 */
import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileP = promisify(execFile);

interface Metadata {
  instance_id: string;
  repo: string;
  base_commit: string;
  dockerhub_tag: string;
  selected_test_files_to_run: string;
  fail_to_pass: string;
  pass_to_pass: string;
  repo_language: string;
  test_patch: string;
}

interface Gate {
  name: string;
  passed: boolean;
  points: number;
  earned: number;
  detail?: string;
}

async function readMeta(cwd: string): Promise<Metadata> {
  const raw = await fs.readFile(path.join(cwd, 'eval', 'metadata.json'), 'utf-8');
  return JSON.parse(raw) as Metadata;
}

/** Capture the agent's diff against the branch's parent commit. */
async function captureDiff(cwd: string): Promise<string> {
  // Try diff against origin/main first; fall back to HEAD~1 if origin
  // isn't available (e.g. test invocation from a non-cloned dir).
  // Two-dot diff (a..b = changes from a to b) — does not require a
  // merge base, so it works in shallow clones where HEAD and origin/main
  // share no fetched ancestor.
  try {
    await execFileP(
      'git',
      ['fetch', '-q', '--depth=1', 'origin', 'main:refs/remotes/origin/main'],
      { cwd },
    );
    const r = await execFileP(
      'git',
      ['diff', 'origin/main..HEAD', '--no-color', '--', '.', ':(exclude)eval', ':(exclude)TICKET.md', ':(exclude)task.json', ':(exclude)README.md'],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    );
    return r.stdout;
  } catch {
    try {
      const r = await execFileP(
        'git',
        ['diff', 'HEAD~1..HEAD', '--no-color', '--', '.', ':(exclude)eval', ':(exclude)TICKET.md', ':(exclude)task.json', ':(exclude)README.md'],
        { cwd, maxBuffer: 64 * 1024 * 1024 },
      );
      return r.stdout;
    } catch {
      return '';
    }
  }
}

/**
 * Pull the SWE-bench Pro image (cached after first pull) and run the
 * tests with the patch applied inside.
 */
async function runDockerEval(
  patch: string,
  meta: Metadata,
): Promise<{ applied: boolean; testOutput: string; runFailed: boolean }> {
  const tag = `jefzda/sweap-images:${meta.dockerhub_tag}`;
  // Write both patches (test_patch + agent patch) to tempfiles so we
  // can volume-mount them. test_patch sets up the testing scaffolding
  // (the new tests that should pass after the fix); agent.patch is
  // the model's proposed fix.
  //
  // Path must be under $HOME — colima only shares the user's home dir
  // into the VM by default, so /tmp on the host becomes an empty
  // directory inside the container.
  const sharedRoot = path.join(os.homedir(), '.sbpro-tmp');
  await fs.mkdir(sharedRoot, { recursive: true });
  const tmp = await fs.mkdtemp(path.join(sharedRoot, 'run-'));
  const testPatchPath = path.join(tmp, 'test.patch');
  const patchPath = path.join(tmp, 'agent.patch');
  await fs.writeFile(testPatchPath, meta.test_patch ?? '', 'utf-8');
  await fs.writeFile(patchPath, patch, 'utf-8');

  // Determine test invocation. SWE-bench Pro images use different test
  // runners per repo; we read selected_test_files_to_run as a JSON
  // array and dispatch by language convention.
  let testFiles: string[] = [];
  try {
    const parsed = JSON.parse(meta.selected_test_files_to_run);
    if (Array.isArray(parsed)) testFiles = parsed.filter((f) => typeof f === 'string');
  } catch {
    // If not JSON, treat the whole string as one file.
    testFiles = [meta.selected_test_files_to_run];
  }

  // Build the in-container script:
  //  1. run /preprocess.sh (resets repo to base_commit)
  //  2. apply the patch
  //  3. run the test files using the repo's standard runner
  //
  // Test runner detection: tutao/tutanota uses node test/Suite.js;
  // openlibrary uses pytest; etc. We delegate to a per-language helper.
  const runnerCmd = chooseRunnerCommand(meta, testFiles);

  const containerScript = [
    'set -e',
    '/preprocess.sh',
    'cd /app',
    // Apply test_patch first (adds the test files SWE-bench Pro expects).
    'if [ -s /tmp/test.patch ]; then',
    '  if ! git apply --whitespace=nowarn /tmp/test.patch 2>/tmp/test_apply.err; then',
    '    echo "TEST_PATCH_APPLY_FAILED"',
    '    cat /tmp/test_apply.err 1>&2',
    '    exit 90',
    '  fi',
    '  echo "TEST_PATCH_APPLIED"',
    'fi',
    // Then apply the agent's patch on top.
    'if [ -s /tmp/agent.patch ]; then',
    '  if ! git apply --reject --whitespace=nowarn /tmp/agent.patch 2>/tmp/apply.err; then',
    '    echo "PATCH_APPLY_FAILED"',
    '    cat /tmp/apply.err 1>&2',
    '    exit 91',
    '  fi',
    'fi',
    'echo "PATCH_APPLIED"',
    'echo "===== TEST OUTPUT ====="',
    runnerCmd,
  ].join('\n');

  let stdout = '';
  let stderr = '';
  let runFailed = false;
  try {
    const r = await execFileP(
      'docker',
      [
        'run',
        '--rm',
        '--platform=linux/amd64',
        '-v',
        `${testPatchPath}:/tmp/test.patch:ro`,
        '-v',
        `${patchPath}:/tmp/agent.patch:ro`,
        '--entrypoint',
        '/bin/bash',
        tag,
        '-c',
        containerScript,
      ],
      { timeout: 25 * 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    runFailed = true;
  }

  await fs.rm(tmp, { recursive: true, force: true });

  // Check the standalone PATCH_APPLIED marker, not anything ending in
  // it (TEST_PATCH_APPLIED would otherwise false-positive).
  const applied = /^PATCH_APPLIED$/m.test(stdout);
  return { applied, testOutput: stdout + '\n' + stderr, runFailed };
}

function chooseRunnerCommand(meta: Metadata, testFiles: string[]): string {
  if (meta.repo_language === 'python') {
    // -v prints "path::name PASSED/FAILED" lines that checkOneTestName
    // can substring-match. -q hides per-test status, breaking parsing.
    return `python -m pytest --tb=short -v ${testFiles.map((f) => JSON.stringify(f)).join(' ')}`;
  }
  if (meta.repo === 'tutao/tutanota') {
    // Tutanota: package.json has `test:app` → `cd test && node test`.
    // The test entry compiles + runs the whole suite. Run the full
    // suite and rely on output parsing to find our specific test's
    // pass/fail status.
    return 'npm run test:app';
  }
  if (meta.repo === 'NodeBB/NodeBB') {
    return testFiles.map((f) => `npx mocha --reporter spec ${JSON.stringify(f)}`).join(' && ');
  }
  if (meta.repo_language === 'go') {
    return `go test ${testFiles.map((f) => JSON.stringify(f)).join(' ')}`;
  }
  // Generic JS fallback.
  return testFiles.map((f) => `npx mocha ${JSON.stringify(f)}`).join(' && ');
}

/**
 * Parse the test runner output to determine which named tests passed.
 * SWE-bench Pro test names have varying syntax — a pytest test like
 * `path/to/test.py::test_name` and a mocha suite like
 * `test/api/Suite.ts | api tests (3065 assertions)`. We do a coarse
 * substring match.
 */
function checkTestNames(output: string, names: string[]): { pass: number; fail: number; failed: string[] } {
  const failed: string[] = [];
  let pass = 0;
  let fail = 0;
  for (const n of names) {
    // Strip JSON-array bracketing if present.
    const trimmed = n.replace(/^\[|\]$/g, '').replace(/^['"]|['"]$/g, '');
    const ok = checkOneTestName(output, trimmed);
    if (ok) pass++;
    else {
      fail++;
      failed.push(trimmed);
    }
  }
  return { pass, fail, failed };
}

function checkOneTestName(output: string, name: string): boolean {
  // Pytest: `PASSED path::test_name` or trailing `passed`.
  // Mocha: `✓ path` or `passing` lines.
  // Suite-level: `api tests (N assertions)` followed by `0 failing`.
  if (output.includes(`PASSED ${name}`) || output.includes(`PASSED  ${name}`)) return true;
  if (new RegExp(`✓\\s+${escapeRe(name)}`).test(output)) return true;
  // For suite-level identifiers, check that the suite ran AND no failures.
  if (name.includes('|')) {
    const [file] = name.split('|').map((s) => s.trim());
    if (output.includes(file ?? '') && /\b0 failing\b/.test(output)) return true;
    if (output.includes(file ?? '') && /\bpassing\b/.test(output) && !/\bfailing\b/.test(output)) return true;
  }
  // Match by test file path with no failures reported.
  if (output.includes(name) && !/\b1\s*failing\b|\bFAILED\b/.test(output)) {
    // Conservative: only count as pass if we see explicit pass markers near it.
    if (/\bpassing\b|\bpassed\b/.test(output)) return true;
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const meta = await readMeta(cwd);
  const gates: Gate[] = [];

  const patch = await captureDiff(cwd);
  if (!patch || patch.trim().length === 0) {
    process.stdout.write(
      JSON.stringify(
        {
          taskName: process.env.EVAL_TASK_NAME ?? meta.instance_id,
          checks: [
            {
              name: 'agent produced a diff',
              passed: false,
              detail: 'no diff against origin/main; agent did nothing',
              points: 1,
              earned: 0,
            },
          ],
          tscExit: null,
          tscErrors: -1,
          score: 0,
          scoreMax: 5,
        },
        null,
        2,
      ) + '\n',
    );
    process.exit(1);
  }

  console.log(`[sbpro] running docker grader for ${meta.instance_id}`);
  console.log(`[sbpro] patch is ${patch.length} bytes`);
  const result = await runDockerEval(patch, meta);

  gates.push({
    name: 'patch applies cleanly',
    passed: result.applied,
    points: 1,
    earned: result.applied ? 1 : 0,
    detail: result.applied ? 'git apply succeeded' : `git apply failed: ${result.testOutput.slice(-400)}`,
  });

  // Parse fail_to_pass + pass_to_pass.
  const f2pNames: string[] = (() => {
    try {
      const a = JSON.parse(meta.fail_to_pass);
      return Array.isArray(a) ? a.map(String) : [String(meta.fail_to_pass)];
    } catch {
      return [meta.fail_to_pass];
    }
  })();
  const p2pNames: string[] = (() => {
    try {
      const a = JSON.parse(meta.pass_to_pass);
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  })();

  if (result.applied) {
    const f2p = checkTestNames(result.testOutput, f2pNames);
    gates.push({
      name: 'fail_to_pass tests now pass',
      passed: f2p.fail === 0 && f2p.pass > 0,
      points: 3,
      earned: f2p.fail === 0 && f2p.pass > 0 ? 3 : 0,
      detail: `${f2p.pass}/${f2pNames.length} pass${f2p.failed.length ? `; failed: ${f2p.failed.slice(0, 3).join(', ')}` : ''}`,
    });
    if (p2pNames.length > 0) {
      const p2p = checkTestNames(result.testOutput, p2pNames);
      gates.push({
        name: 'pass_to_pass tests still pass',
        passed: p2p.fail === 0,
        points: 1,
        earned: p2p.fail === 0 ? 1 : 0,
        detail: `${p2p.pass}/${p2pNames.length} pass`,
      });
    } else {
      // Free point if the task has no regression suite.
      gates.push({
        name: 'no regression check (no pass_to_pass)',
        passed: true,
        points: 1,
        earned: 1,
        detail: 'task has empty pass_to_pass',
      });
    }
  } else {
    gates.push({ name: 'fail_to_pass tests now pass', passed: false, points: 3, earned: 0, detail: 'skipped — patch did not apply' });
    gates.push({ name: 'pass_to_pass tests still pass', passed: false, points: 1, earned: 0, detail: 'skipped — patch did not apply' });
  }

  const score = gates.reduce((s, g) => s + g.earned, 0);
  const max = gates.reduce((s, g) => s + g.points, 0);
  process.stdout.write(
    JSON.stringify(
      {
        taskName: process.env.EVAL_TASK_NAME ?? meta.instance_id,
        checks: gates,
        tscExit: null,
        tscErrors: -1,
        score,
        scoreMax: max,
        // Append the test runner output for human review.
        testOutputTail: result.testOutput.slice(-2000),
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(score === max ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

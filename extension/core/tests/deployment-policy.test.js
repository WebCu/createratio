'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { readFileSync } = fs;
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const workflow = readFileSync(path.join(__dirname, '../../../.github/workflows/deploy-site.yml'), 'utf8');

test('website deployment is separate from tests and triggered only by completed main CI', () => {
  assert.match(workflow, /^name: Deploy website$/m);
  assert.match(workflow, /^  workflow_run:\n    workflows: \[CI\]\n    types: \[completed\]\n    branches: \[main\]$/m);
  assert.doesNotMatch(workflow, /^  (?:pull_request|push|workflow_dispatch|test):/m);
  assert.doesNotMatch(workflow, /run: (?:npm|pnpm) (?:test|build)|needs: test/);
});

test('deployment requires successful push CI on main from this repository', () => {
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
});

test('deployment gate rejects PRs, other branches, forks, and unsuccessful CI', () => {
  const condition = workflow.match(/    if: >-\n([\s\S]*?)\n    runs-on:/)?.[1];
  assert.ok(condition);
  for (const conclusion of ['success', 'failure', 'cancelled', 'timed_out', 'skipped', 'neutral']) {
    for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
      for (const branch of ['main', 'feature']) {
        for (const repository of ['WebCu/createratio', 'other/createratio']) {
          const github = {
            repository: 'WebCu/createratio',
            event: { workflow_run: {
              conclusion, event, head_branch: branch,
              head_repository: { full_name: repository }
            } }
          };
          const expected = conclusion === 'success' && event === 'push' &&
            branch === 'main' && repository === github.repository;
          assert.equal(vm.runInNewContext(condition, { github }), expected,
            `${conclusion}, ${event}, ${branch}, ${repository}`);
        }
      }
    }
  }
});

function deploymentRepository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-deployment-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, GITHUB_TOKEN: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: directory, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '-b', 'main');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('init', '--bare', 'remote.git');
  git('remote', 'add', 'origin', path.join(directory, 'remote.git'));
  git('commit', '--allow-empty', '-m', 'older tested main');
  const older = git('rev-parse', 'HEAD');
  git('push', 'origin', 'main');
  git('commit', '--allow-empty', '-m', 'newer tested main');
  const newer = git('rev-parse', 'HEAD');
  git('push', 'origin', 'main');
  git('update-ref', 'refs/remotes/origin/main', older);
  const binaries = path.join(directory, 'bin');
  fs.mkdirSync(binaries);
  const guard = path.resolve(__dirname, '../../../bin/deployment-guard.js');
  if (fs.existsSync(guard)) fs.copyFileSync(guard, path.join(binaries, 'deployment-guard.js'));
  fs.writeFileSync(path.join(binaries, 'aws'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AWS_LOG"\nif [ "$1 $2" = "cloudfront create-invalidation" ]; then printf "test-invalidation\\n"; fi\n', { mode: 0o755 });

  function deploy(sha) {
    git('checkout', '--detach', sha);
    const runDirectory = fs.mkdtempSync(path.join(directory, 'run-'));
    const output = path.join(runDirectory, 'output');
    const log = path.join(runDirectory, 'aws');
    fs.writeFileSync(output, '');
    fs.writeFileSync(log, '');
    const github = {
      repository: 'WebCu/createratio',
      event: { workflow_run: {
        conclusion: 'success', event: 'push', head_branch: 'main', head_sha: sha,
        head_repository: { full_name: 'WebCu/createratio' }
      } }
    };
    const condition = workflow.match(/    if: >-\n([\s\S]*?)\n    runs-on:/)?.[1];
    assert.equal(vm.runInNewContext(condition, { github }), true);
    const outputs = {};
    let status = 0;
    let stderr = '';
    for (const step of workflow.split(/^      - name: /m).slice(1)) {
      const freshness = /^        id: freshness$/m.test(step);
      const authenticate = /uses: aws-actions\/configure-aws-credentials@/.test(step);
      const publication = /\baws (?:s3|cloudfront) /.test(step);
      if (!freshness && !authenticate && !publication) continue;
      const enabled = step.match(/^        if: (.+)$/m)?.[1];
      if (enabled && !vm.runInNewContext(enabled, { steps: { freshness: { outputs } } })) continue;
      if (authenticate) {
        fs.appendFileSync(log, 'authenticate\n');
        continue;
      }
      const run = step.match(/^        run: (.+)$/m)?.[1];
      assert.ok(run);
      const command = run === '|' ? step.split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n') : run;
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], {
        cwd: directory,
        env: {
          ...env, PATH: `${binaries}${path.delimiter}${process.env.PATH}`,
          TESTED_SHA: sha, GITHUB_OUTPUT: output, AWS_LOG: log,
          GITHUB_TOKEN: freshness ? 'fake-read-only-job-token' : '',
          RUNNER_TEMP: runDirectory, AWS_S3_BUCKET: 'test-bucket',
          AWS_CLOUDFRONT_DISTRIBUTION_ID: 'test-distribution'
        },
        encoding: 'utf8'
      });
      status = result.status;
      stderr += result.stderr;
      if (status !== 0) break;
      for (const line of fs.readFileSync(output, 'utf8').trim().split('\n')) {
        const [key, value] = line.split('=');
        outputs[key] = value;
      }
    }
    return { status, stderr, publications: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
  }
  return { directory, git, older, newer, deploy };
}

test('a newer deployment followed by older CI completion cannot publish the older site', t => {
  const { git, older, newer, deploy } = deploymentRepository(t);
  const localConfig = git('config', '--local', '--list');
  const latest = deploy(newer);
  assert.equal(latest.status, 0, latest.stderr);
  assert.equal(latest.publications.length, 4);
  const stale = deploy(older);
  assert.equal(stale.status, 0, stale.stderr);
  assert.deepEqual(stale.publications, []);
  assert.equal(git('rev-parse', 'HEAD'), older);
  assert.equal(git('config', '--local', '--list'), localConfig);
});

test('older successful CI cannot publish while newer main is still untested', t => {
  const { git, older, deploy } = deploymentRepository(t);
  const result = deploy(older);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.publications, []);
  assert.equal(git('rev-parse', 'HEAD'), older);
});

test('a missing remote main or unavailable remote prevents every AWS publication side effect', async t => {
  for (const failure of ['missing-main', 'unavailable-remote']) {
    await t.test(failure, t => {
      const { directory, git, newer, deploy } = deploymentRepository(t);
      if (failure === 'missing-main') git('--git-dir=remote.git', 'update-ref', '-d', 'refs/heads/main');
      else fs.rmSync(path.join(directory, 'remote.git'), { recursive: true, force: true });
      const result = deploy(newer);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Cannot determine latest main; refusing deployment/);
      assert.deepEqual(result.publications, []);
    });
  }
});

test('freshness binds the tested SHA and step-scoped token after file preparation and before AWS access', () => {
  const steps = workflow.split(/^      - name: /m).slice(1);
  const preparation = steps.findIndex(step => /\bcp dist\/site\/\*/.test(step));
  const freshness = steps.findIndex(step => /^        id: freshness$/m.test(step));
  const authentication = steps.findIndex(step => /^        uses: aws-actions\/configure-aws-credentials@/m.test(step));
  assert.ok(preparation >= 0);
  assert.ok(freshness > preparation);
  assert.ok(authentication > freshness);
  assert.match(steps[freshness], /^        run: node bin\/deployment-guard\.js$/m);
  assert.match(steps[freshness], /^          TESTED_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}$/m);
  assert.match(steps[freshness], /^          GITHUB_TOKEN: \$\{\{ github\.token \}\}$/m);
  assert.doesNotMatch(workflow.split('    steps:')[0], /GITHUB_TOKEN/);
  assert.equal(steps.filter(step => /^          GITHUB_TOKEN:/m.test(step)).length, 1);
});

test('public legal policies ship through both website deployment and local preview', () => {
  const compose = readFileSync(path.join(__dirname, '../../../docker-compose.yml'), 'utf8');
  const homepage = readFileSync(path.join(__dirname, '../../../site/index.html'), 'utf8');
  const siteBuild = readFileSync(path.join(__dirname, '../../../site/build.js'), 'utf8');
  assert.match(workflow, /run: node site\/build\.js/);
  assert.match(workflow, /cp dist\/site\/\*/);
  assert.ok(workflow.indexOf('run: node site/build.js') < workflow.indexOf('cp dist/site/*'));
  assert.match(siteBuild, /for \(const name of \['privacy\.html', 'terms\.html', 'styles\.css', 'arrival\.js', 'browser-install\.js', 'favicon\.svg'\]\)/);
  assert.match(compose, /\.\/site\/browser-install\.js:\/srv\/www\/browser-install\.js:ro/);
  for (const page of ['privacy', 'terms']) {
    assert.match(compose, new RegExp(`\\./site/${page}\\.html:/srv/www/${page}\\.html:ro`));
    assert.match(homepage, new RegExp(`href="${page}\\.html"`));
  }
});

test('deployment checks out the exact tested commit without persisting credentials', () => {
  assert.match(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /^    environment: production$/m);
});

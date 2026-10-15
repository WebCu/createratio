const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const tested = process.env.TESTED_SHA;
if (!/^[a-f0-9]{40}$/.test(tested || '')) throw new Error('A full tested commit SHA is required.');
if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
if (gitEnv.GITHUB_TOKEN) {
  gitEnv.GIT_CONFIG_COUNT = '1';
  gitEnv.GIT_CONFIG_KEY_0 = `http.${process.env.GITHUB_SERVER_URL || 'https://github.com'}/.extraheader`;
  gitEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${gitEnv.GITHUB_TOKEN}`).toString('base64')}`;
}
delete gitEnv.GITHUB_TOKEN;

const result = spawnSync('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], {
  encoding: 'utf8',
  timeout: 30000,
  env: gitEnv
});
if (result.error || result.status !== 0) throw new Error('Cannot determine latest main; refusing deployment.');
const latest = result.stdout.match(/^([a-f0-9]{40})\trefs\/heads\/main\n?$/)?.[1];
if (!latest) throw new Error('Invalid latest main response; refusing deployment.');

const publish = tested === latest;
appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
process.stdout.write(publish ? 'Tested commit is latest main.\n' : 'Skipping stale tested commit.\n');

import base64
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import uuid

bundle = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "dist/chrome").resolve()
if not (bundle / "manifest.json").is_file():
    raise SystemExit("Build Chrome first; pass a generated extension directory.")
manifest = json.loads((bundle / "manifest.json").read_text())
identity = base64.b64decode(manifest["key"]) if "key" in manifest else str(bundle).encode()
extension_id = "".join(chr(ord("a") + int(value, 16)) for value in hashlib.sha256(identity).hexdigest()[:32])
worker_url = "chrome-extension://" + extension_id + "/" + manifest["background"]["service_worker"]

env = dict(os.environ, BU_NAME="c3-smoke-" + uuid.uuid4().hex, BH_TAB_MARKER="0", BH_RECORD="0")
env.pop("BU_CDP_WS", None)
env.pop("BH_REQUIRE_EXISTING_DAEMON", None)
env.pop("PYTHONOPTIMIZE", None)

script = r'''
import json
import time

deadline = time.monotonic() + 15
while True:
    targets = cdp("Target.getTargets")["targetInfos"]
    workers = [target for target in targets if target["type"] == "service_worker" and target["url"] == worker_url]
    if len(workers) > 1:
        raise RuntimeError("Multiple extension workers match the generated manifest")
    if workers:
        extension = workers[0]["url"].split("/")[2]
        break
    if time.monotonic() > deadline:
        raise RuntimeError("Extension service worker did not start")
    time.sleep(0.1)

new_tab("chrome-extension://" + extension + "/settings.html")
wait_for_load()

def evaluate(expression):
    result = cdp("Runtime.evaluate", expression=expression, awaitPromise=True, returnByValue=True)
    if "exceptionDetails" in result:
        page = cdp("Runtime.evaluate", expression="JSON.stringify({url:location.href,ready:typeof document==='object'?document.readyState:null,scripts:typeof document==='object'?Array.from(document.scripts,script=>script.src):[],catalog:typeof C3Sites,core:typeof C3})", returnByValue=True)["result"].get("value")
        raise RuntimeError({"exception": result["exceptionDetails"], "worker": workers[0]["url"], "page": page})
    return result["result"].get("value")

result = evaluate("""(async () => {
  const sites = C3Sites.sites.filter(site => site.gated);
  if (!sites.length) throw new Error('No gated integrations loaded');
  const history = { [sites[0].id]: { createSec: 10, consumeSec: 5 } };
  const historyDate = '2000-01-01';
  await chrome.storage.local.set({ [historyDate]: history });
  const snapshots = [];
  const fixtures = {
    blocked: { settings: { trackedSites: sites.map(site => site.id) }, _access: {} },
    off: { settings: { trackedSites: [] }, _access: {} },
    session: { settings: { trackedSites: sites.map(site => site.id) }, _access: Object.fromEntries(sites.map(site => [site.id, { remainingMs: 60000, expiresAt: 0, date: C3.localDate(new Date()) }])) },
    expired: { settings: { trackedSites: sites.map(site => site.id) }, _access: Object.fromEntries(sites.map(site => [site.id, { remainingMs: 1000, expiresAt: Date.now() - 1, date: C3.localDate(new Date()) }])) },
  };
  for (const [name, fixture] of Object.entries(fixtures)) {
    await chrome.storage.local.set(fixture);
    const response = await chrome.runtime.sendMessage({ type: 'access-status' });
    if (!response?.ok) throw new Error(response?.error || 'Access status failed');
    const expected = sites.flatMap(site => name === 'off' ? C3Sites.get(site.id).access.unrestrictedRules : name === 'session' ? C3Sites.get(site.id).access.sessionRules : []);
    snapshots.push({ name, expected, rules: await chrome.declarativeNetRequest.getSessionRules(), access: response.access, history: (await chrome.storage.local.get(historyDate))[historyDate] });
  }
  return { sites: sites.map(site => site.id), homes: sites.map(site => ({ id: site.id, url: C3Sites.get(site.id).access.home })), history, snapshots, enabledRulesets: await chrome.declarativeNetRequest.getEnabledRulesets() };
})()""")
assert "site-blocking" in result["enabledRulesets"], result
for snapshot in result["snapshots"]:
    assert sorted(snapshot["rules"], key=lambda rule: rule["id"]) == sorted(snapshot["expected"], key=lambda rule: rule["id"]), snapshot
    assert snapshot["history"] == result["history"], snapshot
    for site in result["sites"]:
        status = snapshot["access"][site]
        assert status["enabled"] == (snapshot["name"] != "off"), snapshot
        assert (status["remainingMs"] > 0) == (snapshot["name"] == "session"), snapshot

for page in ["popup.html", "dashboard.html", "blocked.html?site=" + result["sites"][0]]:
    goto_url("chrome-extension://" + extension + "/" + page)
    wait_for_load()
    assert evaluate("document.readyState === 'complete' && document.body.children.length > 0"), page

for home in result["homes"]:
    goto_url(home["url"])
    wait_for_load()
    expected = "chrome-extension://" + extension + "/blocked.html?site=" + home["id"]
    assert evaluate("location.href") == expected, home

print(json.dumps({"browserSmoke": "passed", "states": len(result["snapshots"]), "pages": 4, "blockedHomes": len(result["homes"]), "liveSiteQA": False}))
'''

with tempfile.TemporaryDirectory(prefix="createratio-chromium-") as directory:
    profile = pathlib.Path(directory)
    arguments = [
        os.environ.get("CHROMIUM", "chromium"),
        "--headless=new", "--remote-debugging-port=0", "--disable-dev-shm-usage",
        "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
        "--disable-sync", "--disable-component-update",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
        "--user-data-dir=" + directory,
        "--disable-extensions-except=" + str(bundle),
        "--load-extension=" + str(bundle), "about:blank",
    ]
    if sys.platform == "darwin":
        arguments.append("--use-mock-keychain")
    if os.environ.get("CHROMIUM_NO_SANDBOX") == "1":
        arguments.append("--no-sandbox")
    with (profile / "chromium.log").open("w+") as log:
        browser = subprocess.Popen(arguments, stdout=log, stderr=log, start_new_session=True)
        try:
            deadline = time.monotonic() + 15
            port_file = profile / "DevToolsActivePort"
            while not port_file.is_file():
                if browser.poll() is not None or time.monotonic() > deadline:
                    log.seek(0)
                    raise RuntimeError("Chromium failed to start: " + log.read()[-4000:])
                time.sleep(0.1)
            env["BU_CDP_URL"] = "http://127.0.0.1:" + port_file.read_text().splitlines()[0]
            subprocess.run(["browser-harness"], input="worker_url = " + repr(worker_url) + "\n" + script, text=True, env=env, check=True, timeout=90)
        finally:
            try:
                subprocess.run(["browser-harness", "--reload"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=10)
            finally:
                if browser.poll() is None:
                    os.killpg(browser.pid, signal.SIGTERM)
                    try:
                        browser.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(browser.pid, signal.SIGKILL)
                        browser.wait()

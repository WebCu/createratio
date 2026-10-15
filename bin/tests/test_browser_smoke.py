import ast
import pathlib
import types
import unittest

source = pathlib.Path(__file__).resolve().parents[1] / "browser-smoke.py"
module = ast.parse(source.read_text())
script = ast.literal_eval(next(node.value for node in module.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "script" for target in node.targets)))
body = ast.parse(script).body
navigation = next(index for index, node in enumerate(body) if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == "new_tab")
setup = compile(ast.Module(body=[node for node in body[:navigation] if not isinstance(node, ast.Import)], type_ignores=[]), str(source), "exec")


def select(targets):
    clock = iter([0, 16])
    namespace = {
        "worker_url": "chrome-extension://createratio/background.js",
        "time": types.SimpleNamespace(monotonic=lambda: next(clock), sleep=lambda _: None),
        "cdp": lambda _: {"targetInfos": targets},
    }
    exec(setup, namespace)
    return namespace["extension"]


class WorkerSelection(unittest.TestCase):
    def test_builtin_worker_does_not_steal_extension_selection(self):
        targets = [
            {"type": "service_worker", "url": "chrome-extension://builtin/thunk.js"},
            {"type": "service_worker", "url": "chrome-extension://builtin/background.js"},
            {"type": "page", "url": "chrome-extension://other/background.js"},
            {"type": "service_worker", "url": "chrome-extension://createratio/background.js"},
        ]
        self.assertEqual(select(targets), "createratio")

    def test_unrelated_workers_do_not_count_as_extension_startup(self):
        with self.assertRaisesRegex(RuntimeError, "service worker did not start"):
            select([{"type": "service_worker", "url": "chrome-extension://builtin/background.js"}])

    def test_ambiguous_matching_workers_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, "Multiple extension workers"):
            select([{"type": "service_worker", "url": "chrome-extension://createratio/background.js", "targetId": name} for name in ["first", "second"]])

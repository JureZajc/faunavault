"""Real console/reloader regression, isolated from pytest and the user's archive."""

import os
import queue
import subprocess
import sys
import threading
import time

import pytest

from tests.test_root_dev import DEV_SCRIPT
from tests.test_root_dev import dev as dev


@pytest.mark.skipif(os.name != "nt", reason="Windows console control events")
@pytest.mark.parametrize("backend_only", [False, True])
def test_uvicorn_reload_preserves_launcher_and_frontend_then_ctrl_c_stops_both(
    dev, tmp_path, backend_only
):
    app_dir = tmp_path / "app"
    app_dir.mkdir()
    (app_dir / "__init__.py").touch()
    app = app_dir / "sample.py"
    app.write_text(
        "import os\n"
        "print('RELOAD_PROBE_STARTED', os.getpid(), flush=True)\n"
        "async def app(scope, receive, send):\n"
        "    await send({'type': 'http.response.start', 'status': 200, 'headers': []})\n"
        "    await send({'type': 'http.response.body', 'body': b'probe'})\n",
        encoding="utf-8",
    )
    next_entry = tmp_path / "node_modules" / "next" / "dist" / "bin" / "next"
    next_entry.parent.mkdir(parents=True)
    next_entry.touch()
    frontend = tmp_path / "frontend.py"
    frontend.write_text(
        "import signal, sys, time\n"
        "signal.signal(signal.SIGBREAK, lambda *_: sys.exit(0))\n"
        "print('FRONTEND_PROBE_STARTED', flush=True)\n"
        "while True: time.sleep(0.05)\n",
        encoding="utf-8",
    )
    launcher = tmp_path / "launcher.py"
    launcher.write_text(
        "import ctypes, importlib.util, sys\n"
        "ctypes.windll.kernel32.SetConsoleCtrlHandler(None, False)\n"
        "from pathlib import Path\n"
        "from types import SimpleNamespace\n"
        f"spec = importlib.util.spec_from_file_location('dev_probe', {str(DEV_SCRIPT)!r})\n"
        "dev = importlib.util.module_from_spec(spec)\n"
        "sys.modules[spec.name] = dev\n"
        "spec.loader.exec_module(dev)\n"
        f"root = Path({str(tmp_path)!r})\n"
        "dev.check_dependencies_installed = lambda: True\n"
        "dev.backend_python = lambda: Path(sys.executable)\n"
        "dev.FRONTEND_DEPENDENCIES_DIR = root / 'node_modules'\n"
        "dev.BACKEND_STEPS = (dev.Step('[backend] development server', 'uv', "
        "('run', '--no-sync', 'uvicorn', 'app.sample:app', '--reload', '--reload-dir', 'app', "
        "'--host', '127.0.0.1', '--port', '0', '--lifespan', 'off'), root),)\n"
        "dev.FRONTEND_STEPS = (dev.Step('[frontend] development server', 'python', "
        "('-u', str(root / 'frontend.py')), root),)\n"
        f"code = dev.run_dev(backend_only={backend_only!r}, which=lambda _: sys.executable, "
        "runner=lambda *a, **k: SimpleNamespace(returncode=0, stdout='v24.12.0'))\n"
        "print('LAUNCHER_EXIT', code, flush=True)\n"
        "sys.exit(code)\n",
        encoding="utf-8",
    )
    # Even a regression that broadcasts Ctrl+C stays inside this outer test
    # console. The outer job cleans up all descendants if an assertion fails.
    job = dev.WindowsJob()
    process = subprocess.Popen(
        [sys.executable, "-u", str(launcher)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        **dev.dev_process_options("backend"),
    )
    lines = []
    messages = queue.Queue()

    def read_output():
        for line in process.stdout:
            lines.append(line.rstrip())
            messages.put(line.rstrip())

    reader = threading.Thread(target=read_output, daemon=True)

    def wait_for(fragment):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                line = messages.get(timeout=0.1)
            except queue.Empty:
                if process.poll() is not None:
                    break
                continue
            if fragment in line:
                return line
        pytest.fail(
            f"Missing {fragment!r}; launcher exit={process.poll()}:\n"
            + "\n".join(lines)
        )

    try:
        job.add(process)
        reader.start()
        first = wait_for("Started server process")
        (tmp_path / "tests").mkdir()
        (tmp_path / "tests" / "test_ignored.py").write_text("# should not reload\n")
        time.sleep(0.8)
        assert sum("Started server process" in line for line in lines) == 1
        workers = {first}
        for reload_number in range(3):
            app.write_text(
                app.read_text(encoding="utf-8")
                + f"\n# trigger real Uvicorn reload {reload_number}\n",
                encoding="utf-8",
            )
            worker = wait_for("Started server process")
            assert worker not in workers, "Reload must start a new worker process"
            workers.add(worker)
            assert process.poll() is None
        assert any("FRONTEND_PROBE_STARTED" in line for line in lines) is (
            not backend_only
        )
        assert not any("Interrupted; stopping" in line for line in lines)
        dev.interrupt_windows_backend(process)
        assert process.wait(timeout=12) == 130
        reader.join(timeout=2)
        assert any("LAUNCHER_EXIT 130" in line for line in lines)
        assert any("Interrupted; stopping" in line for line in lines)
        assert sum("Finished server process" in line for line in lines) == len(workers)
    finally:
        job.close()
        process.wait(timeout=5)
        if reader.ident is not None:
            reader.join(timeout=2)
        process.stdout.close()

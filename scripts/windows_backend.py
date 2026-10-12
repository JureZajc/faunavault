"""Uvicorn development entry point for the launcher's private Windows console."""

import ctypes
import importlib
import signal
import sys

from uvicorn._subprocess import get_subprocess
from uvicorn.supervisors.watchfilesreload import WatchFilesReload


class WindowsConsoleReload(WatchFilesReload):
    def restart(self) -> None:
        # CTRL_C_EVENT cannot target an individual PID/process group reliably.
        # This console contains only the backend reloader and its workers; the
        # launcher puts it in a hidden CREATE_NEW_CONSOLE before running us.
        self.is_restarting = True
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        if not kernel.GenerateConsoleCtrlEvent(signal.CTRL_C_EVENT, 0):
            raise ctypes.WinError(ctypes.get_last_error())
        sys.stdout.write(" ")
        sys.stdout.flush()
        self.process.join()
        self.process = get_subprocess(
            config=self.config, target=self.target, sockets=self.sockets
        )
        self.process.start()


def main() -> None:
    # A terminal/tool may have disabled Ctrl+C for its process group. Enable it
    # in this private console before the reloader spawns inheriting workers.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    if not kernel.SetConsoleCtrlHandler(None, False):
        raise ctypes.WinError(ctypes.get_last_error())
    uvicorn_main = importlib.import_module("uvicorn.main")
    uvicorn_main.ChangeReload = WindowsConsoleReload
    uvicorn_main.main()


if __name__ == "__main__":
    main()

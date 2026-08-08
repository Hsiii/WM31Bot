import base64
import json
import os
import selectors
import subprocess
import sys
import time
from pathlib import Path

MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_PROCESS_OUTPUT_BYTES = 64 * 1024
PROCESS_TIMEOUT_SECONDS = 45
PYTHON = "/opt/minisago-python/bin/python3"


def remove_user_path(path: Path) -> None:
    if path.is_symlink() or not path.is_dir():
        path.unlink(missing_ok=True)
        return
    path.chmod(0o700)
    for child in path.iterdir():
        remove_user_path(child)
    path.rmdir()


def clean_workspace(output_path: str | None) -> None:
    output = Path("/workspace", output_path) if output_path else None
    for path in Path("/workspace").iterdir():
        if path.name in {"inputs", "request.json"}:
            continue
        if output and path == output and path.is_file() and not path.is_symlink():
            path.chmod(0o400)
            continue
        remove_user_path(path)


def run(code: str, environment: dict[str, str]) -> tuple[str, str]:
    process = subprocess.Popen(
        [PYTHON, "-I", "-"],
        cwd="/workspace",
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdin and process.stdout and process.stderr
    process.stdin.write(code.encode())
    process.stdin.close()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    chunks: dict[str, list[bytes]] = {"stdout": [], "stderr": []}
    sizes = {"stdout": 0, "stderr": 0}
    deadline = time.monotonic() + PROCESS_TIMEOUT_SECONDS

    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Python execution exceeded 45 seconds.")
            for key, _ in selector.select(min(remaining, 0.25)):
                chunk = os.read(key.fileobj.fileno(), 16 * 1024)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                name = key.data
                sizes[name] += len(chunk)
                if sizes[name] > MAX_PROCESS_OUTPUT_BYTES:
                    raise RuntimeError("Python output exceeded 64 KB.")
                chunks[name].append(chunk)
        exit_code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
    except Exception:
        process.kill()
        process.wait()
        raise
    if exit_code != 0:
        error = b"".join(chunks["stderr"]).decode(errors="replace").strip()
        raise RuntimeError(error[:2000] or "Python execution failed.")
    return (
        b"".join(chunks["stdout"]).decode(errors="replace").strip()[:8000],
        b"".join(chunks["stderr"]).decode(errors="replace").strip()[:2000],
    )


def main() -> None:
    request = json.loads(Path(sys.argv[1]).read_text())
    output_path = request.get("outputPath")
    environment = {
        "HOME": "/tmp",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "OMP_NUM_THREADS": "2",
        "PATH": "/opt/minisago-python/bin:/usr/bin:/bin",
        "TMPDIR": "/tmp",
        "MINISAGO_INPUTS_JSON": json.dumps(request["attachments"]),
        "U2NET_HOME": "/opt/minisago-models",
    }
    if output_path:
        environment["MINISAGO_OUTPUT_PATH"] = output_path
    try:
        stdout, stderr = run(request["code"], environment)
    finally:
        clean_workspace(output_path)
    result: dict[str, object] = {"stdout": stdout, "stderr": stderr}
    if output_path:
        path = Path("/workspace", output_path).resolve()
        if path.parent != Path("/workspace") or not path.is_file():
            raise RuntimeError("Python did not produce the requested artifact.")
        size = path.stat().st_size
        if size <= 0 or size > MAX_OUTPUT_BYTES:
            raise RuntimeError("Generated artifact exceeds the 8 MB limit.")
        result["artifact"] = {
            "data": base64.b64encode(path.read_bytes()).decode(),
            "size": size,
        }
    print(json.dumps(result, separators=(",", ":")))


try:
    main()
except Exception as error:
    print(str(error)[:2000], file=sys.stderr)
    sys.exit(1)

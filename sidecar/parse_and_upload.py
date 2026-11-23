"""desktop 侧车：调用 builder.listen 完成 faster-whisper 解析，打包并上传到 backend。

stdout 协议：
- 普通解析日志原样输出，供 Tauri 侧转发到界面；
- 结束输出一行 `RESULT {json}`，由 Rust 解析后通知前端。
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlsplit


def emit_result(payload: dict) -> None:
    print("RESULT " + json.dumps(payload, ensure_ascii=False), flush=True)


DESKTOP_ROOT = Path(__file__).resolve().parents[1]
DESKTOP_VENV_PY = DESKTOP_ROOT / ".venv" / "bin" / "python"


def find_uv() -> str | None:
    candidates = [shutil.which("uv")]
    candidates += [
        str(Path.home() / ".local" / "bin" / "uv"),
        "/opt/homebrew/bin/uv",
        "/usr/local/bin/uv",
        str(Path.home() / ".cargo" / "bin" / "uv"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def has_deps(interpreter: str) -> bool:
    probe = subprocess.run(
        [interpreter, "-c", "import numpy, faster_whisper"],
        capture_output=True,
        text=True,
    )
    return probe.returncode == 0


def resolve_runner(args: argparse.Namespace) -> tuple[list[str], Path | None]:
    """挑选运行 builder 的 Python，返回命令与需要加入 PATH 的 venv/bin。

    优先级：设置里的解释器 → desktop/.venv → uv（--project desktop）。
    显式使用 desktop/.venv，避免依赖调用方 shell 的 PATH。
    """
    candidates: list[tuple[str, str]] = []
    if args.python.strip():
        candidates.append(("设置", args.python.strip()))
    if DESKTOP_VENV_PY.is_file():
        candidates.append(("desktop/.venv", str(DESKTOP_VENV_PY)))

    for label, interpreter in candidates:
        if has_deps(interpreter):
            print(f"[desktop] python={interpreter}（{label}）", flush=True)
            return [interpreter, "-m", "builder.listen"], Path(interpreter).parent

    uv = find_uv()
    if uv:
        probe = subprocess.run(
            [
                uv, "run", "--project", str(DESKTOP_ROOT), "--no-sync",
                "python", "-c", "import numpy, faster_whisper",
            ],
            capture_output=True,
            text=True,
        )
        if probe.returncode == 0:
            print(f"[desktop] python={uv} run --project desktop", flush=True)
            return [
                uv, "run", "--project", str(DESKTOP_ROOT), "--no-sync",
                "python", "-m", "builder.listen",
            ], DESKTOP_ROOT / ".venv" / "bin"
        print("[desktop] uv 找到了，但 desktop/.venv 依赖未安装", flush=True)

    raise RuntimeError(
        "未找到可用的 Python 环境。请先在 language_learner_desktop 目录执行 `uv sync` 安装依赖，"
        "或在设置中填写已安装 faster-whisper、numpy 的 Python 解释器路径。"
    )


def run_builder(args: argparse.Namespace, builder_root: Path, work_dir: Path) -> int:
    cmd, venv_bin = resolve_runner(args)
    cmd += [
        "--url", args.url,
        "--exam-id", args.exam_id,
        "--lang", args.lang,
        "--target-lang", args.lang,
        "--model", args.model,
    ]
    if args.profile:
        cmd += ["--profile", args.profile]
    if args.answers:
        cmd += ["--answers", args.answers]
    if args.cookies:
        cmd += ["--cookies", args.cookies]

    env = os.environ.copy()
    env["WORK_DIR"] = str(work_dir)
    env.setdefault("OMP_NUM_THREADS", "1")
    env.setdefault("MKL_NUM_THREADS", "1")
    env.setdefault("OPENBLAS_NUM_THREADS", "1")
    if venv_bin and venv_bin.is_dir():
        env["PATH"] = str(venv_bin) + os.pathsep + env.get("PATH", "")

    # Tauri 从 Finder 启动时 PATH 很短；把常见安装目录补进 PATH，
    # 否则 builder 里的 ffmpeg / yt-dlp / tesseract 探测都会失败。
    common_dirs = [
        Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"),
        Path("/usr/local/ffmpeg/bin"),
        Path.home() / "bin",
    ]
    prefix = [str(d) for d in common_dirs if d.is_dir()]
    if prefix:
        env["PATH"] = os.pathsep.join(prefix) + os.pathsep + env.get("PATH", "")

    for binary in ("ffmpeg", "yt-dlp"):
        if not shutil.which(binary, path=env.get("PATH")):
            if binary == "ffmpeg":
                raise RuntimeError(
                    "未找到 ffmpeg。macOS 可执行 `brew install ffmpeg`，"
                    "或把 ffmpeg 所在目录加入 PATH。"
                )
            raise RuntimeError("未找到 yt-dlp，请先在 desktop 目录执行 `uv sync`")

    proc = subprocess.Popen(
        cmd,
        cwd=str(builder_root),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        print(line.rstrip("\n"), flush=True)
    return proc.wait()


def build_zip(exam_dir: Path, zip_path: Path) -> None:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    base = zip_path.with_suffix("")
    archive = shutil.make_archive(str(base), "zip", root_dir=str(exam_dir))
    if Path(archive) != zip_path:
        Path(archive).replace(zip_path)


def upload(server: str, zip_path: Path, lang: str, level: str, overwrite: bool) -> dict:
    split = urlsplit(server.rstrip("/"))
    if split.scheme not in ("http", "https"):
        raise ValueError("服务端地址必须以 http:// 或 https:// 开头")
    host = split.hostname or "127.0.0.1"
    port = split.port or (443 if split.scheme == "https" else 80)
    path = (split.path or "") + "/api/listening/upload"

    boundary = "----ll-desktop-" + uuid.uuid4().hex
    fields = {
        "lang": lang,
        "level": level,
    }
    if overwrite:
        fields["overwrite"] = "1"

    head = b""
    for key, value in fields.items():
        head += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n"
        ).encode("utf-8")
    file_header = (
        f"--{boundary}\r\n"
        f"Content-Disposition: form-data; name=\"file\"; filename=\"{zip_path.name}\"\r\n"
        "Content-Type: application/zip\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    size = zip_path.stat().st_size
    total = len(head) + len(file_header) + size + len(tail)

    if split.scheme == "https":
        conn = http.client.HTTPSConnection(host, port, timeout=600)
    else:
        conn = http.client.HTTPConnection(host, port, timeout=600)
    conn.putrequest("POST", path)
    conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
    conn.putheader("Content-Length", str(total))
    conn.endheaders()
    conn.send(head)
    conn.send(file_header)
    with zip_path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            conn.send(chunk)
    conn.send(tail)

    response = conn.getresponse()
    raw = response.read().decode("utf-8", errors="replace")
    conn.close()
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        body = {"raw": raw}
    if response.status >= 300:
        message = body.get("error") if isinstance(body, dict) else raw
        raise RuntimeError(f"上传失败（HTTP {response.status}）：{message}")
    return body if isinstance(body, dict) else {"raw": raw}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="parse_and_upload")
    parser.add_argument("--url", required=True)
    parser.add_argument("--exam-id", required=True)
    parser.add_argument("--lang", default="de")
    parser.add_argument("--model", default="small")
    parser.add_argument("--profile", default="")
    parser.add_argument("--level", default="A1")
    parser.add_argument("--answers", default="")
    parser.add_argument("--cookies", default="")
    parser.add_argument("--server", default="http://127.0.0.1:8080")
    parser.add_argument("--builder-root", required=True)
    parser.add_argument("--work-dir", default="")
    parser.add_argument("--python", default="")
    parser.add_argument("--download-dir", default="")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)

    builder_root = Path(args.builder_root).expanduser().resolve()
    if not (builder_root / "builder" / "listen.py").is_file():
        emit_result({"ok": False, "error": f"builder 目录无效：{builder_root}"})
        return 2

    work_dir = Path(args.work_dir).expanduser() if args.work_dir else Path(
        os.environ.get("LL_DESKTOP_WORK_DIR", "")
        or (Path.home() / ".cache" / "language-learner-desktop" / "work")
    )
    work_dir.mkdir(parents=True, exist_ok=True)
    download_dir = Path(args.download_dir).expanduser() if args.download_dir else Path.home() / "Downloads"
    download_dir.mkdir(parents=True, exist_ok=True)

    try:
        print(f"[desktop] work_dir={work_dir}", flush=True)
        print("[desktop] 开始解析（faster-whisper）", flush=True)
        code = run_builder(args, builder_root, work_dir)
        if code != 0:
            emit_result({
                "ok": False,
                "error": f"builder 退出码 {code}",
                "work_dir": str(work_dir),
            })
            return code

        exam_dir = work_dir / "listening" / args.exam_id
        manifest_path = exam_dir / "manifest.json"
        if not manifest_path.is_file():
            emit_result({"ok": False, "error": "解析完成但缺少 manifest.json", "work_dir": str(work_dir)})
            return 3
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        # zip 直接生成到下载目录，上传成功后保留，方便用户留档/手动导入。
        print(
            "STAGE " + json.dumps({"stage": "packaging", "message": "打包素材"}, ensure_ascii=False),
            flush=True,
        )
        print("[desktop] 打包素材", flush=True)
        zip_path = download_dir / f"{args.exam_id}.zip"
        build_zip(exam_dir, zip_path)
        size = zip_path.stat().st_size
        print(f"[desktop] zip 已保存到 {zip_path}", flush=True)
        print(
            "STAGE "
            + json.dumps(
                {"stage": "uploading", "message": f"上传素材 {size / 1024 / 1024:.1f} MB"},
                ensure_ascii=False,
            ),
            flush=True,
        )
        print(f"[desktop] 上传素材 {size / 1024 / 1024:.1f} MB → {args.server}", flush=True)
        result = upload(args.server, zip_path, args.lang, args.level, args.overwrite)
        print("[desktop] 上传完成", flush=True)
        emit_result({
            "ok": True,
            "response": result,
            "zip_path": str(zip_path),
            "title": manifest.get("title"),
            "question_count": len(manifest.get("questions") or []),
            "duration": manifest.get("duration"),
        })
        # 只清理解析产物，保留 .models（Whisper 模型缓存）和下载目录里的 zip。
        shutil.rmtree(exam_dir, ignore_errors=True)
        return 0
    except Exception as exc:  # noqa: BLE001 - 侧车需要把错误完整回传界面
        emit_result({"ok": False, "error": str(exc), "work_dir": str(work_dir)})
        return 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env bash
# 构建并放置 Tauri sidecar 二进制：
#   listen-parser-<triple>   听力解析（复用 backend builder）
#   parse-and-upload-<triple> 解析编排 + 上传
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BACKEND=${BACKEND_ROOT:-"$ROOT/../language_learner_backend"}
PY=${PYTHON:-"$BACKEND/builder/.venv/bin/python"}
TRIPLE=$(rustc -Vv | sed -n 's/^host: //p')
TARGET="$ROOT/src-tauri/binaries"

if [ ! -x "$PY" ]; then
  echo "未找到 Python 环境：$PY" >&2
  echo "请先在 backend/builder 执行 uv sync" >&2
  exit 1
fi

mkdir -p "$TARGET"

echo "==> 构建 listen-parser"
"$BACKEND/builder/scripts/build_listen_parser.sh"
cp "$BACKEND/builder/dist/listen-parser" "$TARGET/listen-parser"
cp "$BACKEND/builder/dist/listen-parser" "$TARGET/listen-parser-$TRIPLE"

if ! "$PY" -c "import PyInstaller" >/dev/null 2>&1; then
  echo "安装 PyInstaller..."
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$PY" "pyinstaller>=6.11"
  else
    "$PY" -m pip install "pyinstaller>=6.11"
  fi
fi

echo "==> 构建 parse-and-upload"
"$PY" -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name parse-and-upload \
  --specpath "$ROOT/src-tauri/pyinstaller-build" \
  --distpath "$TARGET" \
  --workpath "$ROOT/src-tauri/pyinstaller-build" \
  "$ROOT/sidecar/parse_and_upload.py"
cp "$TARGET/parse-and-upload" "$TARGET/parse-and-upload-$TRIPLE"

echo "已生成：$TARGET/listen-parser-$TRIPLE"
echo "已生成：$TARGET/parse-and-upload-$TRIPLE"

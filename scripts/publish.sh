#!/usr/bin/env bash
set -euo pipefail

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    echo "[publish.sh] 已检测到系统 node: $(command -v node) ($(node -v))"
    return 0
  fi
  echo "[publish.sh] 未检测到系统 node，尝试自动安装本地独立版本..."
  mkdir -p .tooling
  NODE_DIR=.tooling/node
  if [ -x "$NODE_DIR/bin/node" ]; then
    export PATH="$PWD/$NODE_DIR/bin:$PATH"
    echo "[publish.sh] 使用已缓存的本地 node."; return 0
  fi
  # 简单架构检测，仅处理 x64
  ARCH=$(uname -m)
  if [ "$ARCH" != "x86_64" ]; then
    echo "[publish.sh] 自动安装仅支持 x86_64，目前: $ARCH，请手动安装 Node." >&2
    return 1
  fi
  # 选择一个稳定 LTS 版本，可根据需要调整
  NODE_VERSION="v20.11.1"
  TARBALL="node-${NODE_VERSION}-linux-x64.tar.xz"
  URL="https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}"
  echo "[publish.sh] 下载 $URL ..."
  curl -fsSL "$URL" -o .tooling/$TARBALL || { echo "[publish.sh] 下载 Node 失败" >&2; return 1; }
  echo "[publish.sh] 解压 Node..."
  tar -xf .tooling/$TARBALL -C .tooling || { echo "[publish.sh] 解压失败" >&2; return 1; }
  mv .tooling/node-${NODE_VERSION}-linux-x64 "$NODE_DIR"
  rm .tooling/$TARBALL
  export PATH="$PWD/$NODE_DIR/bin:$PATH"
  echo "[publish.sh] 本地 Node 已安装: $(node -v)"
}

ensure_node || { echo "[publish.sh] Error: 无法自动安装 node."; exit 2; }

  # 若用户提供 NODE_BIN 则优先使用
  if [ -n "${NODE_BIN:-}" ]; then
    if [ -x "$NODE_BIN" ]; then
      echo "[publish.sh] 使用用户指定 NODE_BIN=$NODE_BIN"
      export PATH="$(dirname "$NODE_BIN"):$PATH"
    else
      echo "[publish.sh] 警告: NODE_BIN 指向的文件不可执行: $NODE_BIN" >&2
    fi
  fi

  echo "[publish.sh] 当前 PATH=$PATH"

BUMP=${1:-}

which node >/dev/null 2>&1 || { echo "[publish.sh] Error: node 不可用" >&2; exit 2; }

if [ -z "${VSCE_PAT:-}" ]; then
  echo "[publish.sh] Error: VSCE_PAT 未设置. 请先 export VSCE_PAT=your_token" >&2
  exit 3
fi

if [ ! -f package.json ]; then
  echo "[publish.sh] Error: 未找到 package.json (运行位置不正确)" >&2
  exit 4
fi

# 确认 vsce 存在
if [ ! -x ./node_modules/.bin/vsce ]; then
  echo "[publish.sh] 未找到本地 vsce, 正在安装 @vscode/vsce..." >&2
  if command -v npm >/dev/null 2>&1; then
    npm install @vscode/vsce --no-audit --no-fund
  else
    echo "[publish.sh] 警告: npm 不可用，尝试使用 npx 失败将无法自动安装 vsce" >&2
    echo "[publish.sh] 请手动安装: npm install @vscode/vsce" >&2
    exit 5
  fi
fi

# 构建源码（若 tsc 不存在则跳过）
if [ -x ./node_modules/.bin/tsc ]; then
  echo "[publish.sh] 编译 TypeScript..."
  ./node_modules/.bin/tsc -p .
fi

# 可选打包步骤：若存在 package 脚本则执行
if grep -q '"package"' package.json; then
  echo "[publish.sh] 运行 npm run package 以生成 VSIX (可选)"
  if npm run package; then
    echo "[publish.sh] package 步骤完成"
  else
    echo "[publish.sh] package 步骤失败，继续尝试直接 publish" >&2
  fi
fi

CMD=("./node_modules/.bin/vsce" "publish")
if [ -n "$BUMP" ]; then
  CMD+=("$BUMP")
fi

echo "[publish.sh] 执行: ${CMD[*]}"
exec "${CMD[@]}"

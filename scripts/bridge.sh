#!/usr/bin/env bash
# bridge.sh — Bridge Server 生命周期管理（幂等、单实例、子 shell 安全）
#
# 用法：
#   scripts/bridge.sh start    # 启动（已运行则 no-op）
#   scripts/bridge.sh stop     # 停止
#   scripts/bridge.sh status   # 检查状态（exit 0 = 在线）
#   scripts/bridge.sh ensure   # 等价 status || start，并阻塞到就绪
#
# 关键设计：
# - 通过 /api/status 探测端口，幂等：start 两次不会撞端口
# - 用 nohup + setsid 双重 detach，主会话 shell 立即返回，不阻塞 agent
# - PID 文件 .bridge.pid（已在 .gitignore 的 *.pid）
# - 日志走 logs/bridge-server.log（追加，不轮转）
# - 跨项目区分：端口从 config.json 解析，避免硬编码

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

PID_FILE="$ROOT/.bridge.pid"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/bridge-server.log"
CONFIG_FILE="$ROOT/config.json"

# 从 config.json 取 host:port
read_endpoint() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "[bridge.sh] config.json 不存在，请先 cp config.example.json config.json" >&2
    return 1
  fi
  HOST=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8')).bridge?.host||'127.0.0.1')")
  PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8')).bridge?.port||0)")
  if [[ "$PORT" == "0" ]]; then
    echo "[bridge.sh] config.json 缺 bridge.port" >&2
    return 1
  fi
}

probe() {
  # 200 = 在线；其它 = 离线。--max-time 2 防止阻塞。
  curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://${HOST}:${PORT}/api/status" 2>/dev/null || true
}

cmd_status() {
  read_endpoint
  local code
  code=$(probe)
  if [[ "$code" == "200" ]]; then
    local pid=""
    [[ -f "$PID_FILE" ]] && pid=$(cat "$PID_FILE" 2>/dev/null || true)
    echo "[bridge.sh] online — http://${HOST}:${PORT} (pid=${pid:-unknown})"
    return 0
  fi
  echo "[bridge.sh] offline — http://${HOST}:${PORT} (curl=${code:-no-response})"
  return 1
}

cmd_start() {
  read_endpoint

  # 已在线：no-op
  local code
  code=$(probe)
  if [[ "$code" == "200" ]]; then
    echo "[bridge.sh] already running on ${HOST}:${PORT}"
    return 0
  fi

  # 旧 PID 文件残留：清理
  if [[ -f "$PID_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      echo "[bridge.sh] PID file points to live process $old_pid but /api/status not responding — refusing to start. Run: scripts/bridge.sh stop" >&2
      return 2
    fi
    rm -f "$PID_FILE"
  fi

  mkdir -p "$LOG_DIR"

  # 双重 detach: setsid 脱离会话组，nohup 忽略 SIGHUP，&> 重定向
  # 主 shell 在拿到 PID 后立刻 return，不会阻塞 agent
  setsid nohup node "$ROOT/server.js" >>"$LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "$PID_FILE"

  # 等待最多 5 秒就绪
  local i=0
  while (( i < 50 )); do
    sleep 0.1
    code=$(probe)
    [[ "$code" == "200" ]] && {
      echo "[bridge.sh] started — http://${HOST}:${PORT} (pid=$pid, log=$LOG_FILE)"
      return 0
    }
    # 进程已死
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[bridge.sh] server.js exited prematurely. Last log lines:" >&2
      tail -n 20 "$LOG_FILE" >&2 || true
      rm -f "$PID_FILE"
      return 3
    fi
    i=$((i + 1))
  done

  echo "[bridge.sh] timed out waiting for /api/status. Process $pid alive but not ready. Log:" >&2
  tail -n 20 "$LOG_FILE" >&2 || true
  return 4
}

cmd_stop() {
  read_endpoint 2>/dev/null || true
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      # 等最多 3 秒
      local i=0
      while (( i < 30 )) && kill -0 "$pid" 2>/dev/null; do
        sleep 0.1
        i=$((i + 1))
      done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
      echo "[bridge.sh] stopped (pid=$pid)"
    else
      echo "[bridge.sh] PID file stale, cleaning"
    fi
    rm -f "$PID_FILE"
    return 0
  fi
  echo "[bridge.sh] no PID file. Not started by this script (or already stopped)."
  return 0
}

cmd_ensure() {
  if cmd_status >/dev/null 2>&1; then
    cmd_status
    return 0
  fi
  cmd_start
}

case "${1:-status}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  ensure) cmd_ensure ;;
  restart) cmd_stop || true; cmd_start ;;
  *)
    echo "Usage: $0 {start|stop|status|ensure|restart}" >&2
    exit 1
    ;;
esac

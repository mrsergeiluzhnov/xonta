#!/usr/bin/env bash
# Автопилот стенда «Сеть оркестраторов». Запускается cron'ом раз в 10 минут на сервере стенда.
# Почтовый ящик — приватный репозиторий с результатами (по умолчанию mrsergeiluzhnov/xonta-runs):
#   queue/next.json  — задание на следующий прогон: {"run_id": "...", "ref": "<коммит xonta>", "env": {...}, "note": "..."}
#   queue/STOP       — если файл есть, новые прогоны не запускаются
#   runs/<id>/       — сюда автопилот кладёт результаты законченного прогона (ключи не попадают)
#   status/server.json — состояние сервера: идёт ли прогон, последние строки лога
#   state/started.log  — какие прогоны и когда запускались (по нему считается предел в сутки)
# Что автопилот НЕ делает: не трогает другие контейнеры и каталоги, не перезагружает сервер, не выполняет команды из
# репозитория — только поднимает compose стенда с проверенными переменными из белого списка.
set -euo pipefail

STAND="${STAND:-/home/xonta/xonta-stand}"        # рабочий каталог стенда (stand-data и stand.env живут здесь)
SRC="${SRC:-/home/xonta/xonta-src}"              # клон публичного репозитория xonta
RUNS="${RUNS:-/home/xonta/xonta-runs}"           # клон приватного репозитория с результатами
CONTAINER="xonta-stand-network"
MAX_PER_DAY="${MAX_PER_DAY:-2}"                  # жёсткий предел: задать в cron, из репозитория не меняется
KEY="${RUNS_KEY:-/root/.ssh/xonta_runs}"
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
LOCK=/tmp/xonta-autopilot.lock
exec 9>"$LOCK"; flock -n 9 || exit 0

log() { echo "$(date -u +%FT%TZ) $*" >> "$RUNS/../xonta-autopilot.log"; }
git_runs() { git -C "$RUNS" "$@"; }
push_runs() {  # коммит и отправка с повтором (параллельно пишет и оркестрирующая сессия)
  git_runs add -A
  git_runs diff --cached --quiet && return 0
  git_runs -c user.name="xonta-stand" -c user.email="stand@localhost" commit -q -m "$1"
  for i in 1 2 3; do git_runs pull -q --rebase && git_runs push -q && return 0; sleep 5; done
  log "не удалось отправить: $1"; return 1
}

git_runs pull -q --rebase || log "pull не прошёл"
mkdir -p "$RUNS/queue" "$RUNS/runs" "$RUNS/status" "$RUNS/state"
touch "$RUNS/state/started.log"

# идёт ли прогон: running, перезапуск после сбоя (restart: on-failure) или только создан — всё считается «идёт»
st=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo none)
case "$st" in running|restarting|created) running=true ;; *) running=false ;; esac
current=$(cat "$RUNS/state/current" 2>/dev/null || true)

# ---------- состояние: раз в 30 минут или когда прогон закончился ----------
minute=$(date +%M)
if [ "$running" != "true" ] || [ $((10#$minute % 30)) -lt 10 ]; then
  python3 - "$RUNS/status/server.json" "$running" "$current" <<'PY'
import json, subprocess, sys, datetime, re
path, running, current = sys.argv[1], sys.argv[2] == "true", sys.argv[3]
try: prev = json.load(open(path))
except Exception: prev = {}
if not running and prev.get("running") is False and prev.get("run_id") == (current or None): sys.exit(0)  # простой — не пишем каждые 10 минут
try: tail = subprocess.run(["docker", "logs", "--tail", "40", "xonta-stand-network"], capture_output=True, text=True, timeout=30)
except Exception: tail = None
lines = [] if tail is None else (tail.stdout + tail.stderr).splitlines()[-40:]
lines = [l for l in lines if not re.search(r"(?i)(auth|key|token|secret|password)\s*[=:]", l)]
json.dump({"at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "running": running, "run_id": current or None, "log_tail": lines}, open(path, "w"), ensure_ascii=False, indent=1)
PY
  push_runs "состояние: ${current:-нет прогона}, идёт: $running" || true
fi

[ "$running" = "true" ] && exit 0

# ---------- прогон закончился: результаты в почтовый ящик ----------
if [ -n "$current" ] && [ ! -d "$RUNS/runs/$current" ]; then
  out="$RUNS/runs/$current"; mkdir -p "$out"
  data="$STAND/stand-data/$current"
  docker logs "$CONTAINER" 2>&1 | grep -viE "(auth|key|token|secret|password)[[:space:]]*[=:]" | gzip > "$out/log.txt.gz" || true
  if [ -f "$data/REPORT.md" ]; then
    cp "$data/REPORT.md" "$out/REPORT.md"
    tar czf "$out/result.tgz" --exclude='*.jwk' --exclude='keys' --exclude='*.env' -C "$STAND/stand-data" "$current" orchestrators
    echo "ok" > "$out/STATUS"
  else
    echo "failed" > "$out/STATUS"
  fi
  git -C "$SRC" rev-parse HEAD > "$out/REF" 2>/dev/null || true
  push_runs "результаты $current: $(cat "$out/STATUS")"
  log "результаты $current: $(cat "$out/STATUS")"
fi

# ---------- следующий прогон ----------
[ -f "$RUNS/queue/STOP" ] && exit 0
[ -f "$RUNS/queue/next.json" ] || exit 0
plan=$(python3 - "$RUNS/queue/next.json" "$RUNS/state/started.log" "$MAX_PER_DAY" <<'PY'
import json, re, sys, datetime, shlex
q = json.load(open(sys.argv[1])); started = open(sys.argv[2]).read().split("\n"); cap = int(sys.argv[3])
rid, ref, env = str(q.get("run_id", "")), str(q.get("ref", "")), q.get("env", {}) or {}
ok = re.fullmatch(r"run-[a-z0-9-]{1,30}", rid) and re.fullmatch(r"[0-9a-f]{7,40}", ref)
done = {l.split(" ")[1] for l in started if l.count(" ") >= 2}
today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
n_today = sum(1 for l in started if l.startswith(today))
allow = re.compile(r"(NET|SUP|ADVICE|GUARD|EXAM|TASKS|TOTAL|AGENT_LLM|SENIOR_LLM|STAND_LLM|CHECKER)_[A-Z0-9_]{1,40}")
bad = [k for k, v in env.items() if not allow.fullmatch(k) or not re.fullmatch(r"[A-Za-z0-9._,:-]{0,64}", str(v))]
why = "" if ok else "неверный run_id или ref"
if not why and rid in done: why = "уже запускался"
if not why and n_today >= cap: why = f"предел {cap} прогонов в сутки"
if not why and bad: why = "переменные вне белого списка: " + ",".join(bad)
print(f"RID={shlex.quote(rid)}; REF={shlex.quote(ref)}; WHY={shlex.quote(why)}")
if not why:
  with open("/tmp/xonta-autopilot.override.yml", "w") as f:
    f.write("services:\n  stand-network:\n    environment:\n")
    for k, v in {**env, "NET_RUN_ID": rid}.items(): f.write(f"      {k}: {json.dumps(str(v))}\n")
PY
) || plan="RID=unknown; REF=; WHY=задание_не_читается"
eval "$plan"
if [ -n "$WHY" ]; then
  [ "$WHY" = "уже запускался" ] || log "задание $RID не запущено: $WHY"
  exit 0
fi

# код нужной версии: из публичного репозитория, без stand-data, stand.env и ключей
[ -d "$SRC/.git" ] || git clone -q https://github.com/mrsergeiluzhnov/xonta "$SRC"
git -C "$SRC" fetch -q origin
git -C "$SRC" cat-file -e "$REF^{commit}" || { log "коммит $REF не найден"; exit 0; }
git -C "$SRC" checkout -q --detach "$REF"
tar -C "$SRC" --exclude=.git --exclude=stand-data --exclude=stand.env --exclude='*.jwk' -cf - . | tar -C "$STAND" -xf -
cp /tmp/xonta-autopilot.override.yml "$STAND/stand/autopilot.override.yml"

cd "$STAND/stand"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
NET_RUN_ID="$RID" docker compose -f docker-compose.network.yml -f autopilot.override.yml up -d --build >> "$RUNS/../xonta-autopilot.log" 2>&1
echo "$RID" > "$RUNS/state/current"
echo "$(date -u +%F) $RID $REF" >> "$RUNS/state/started.log"
push_runs "запущен $RID ($REF)"
log "запущен $RID на $REF"

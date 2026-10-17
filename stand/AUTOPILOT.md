# Автопилот стенда

Стенд сам забирает задания и отдаёт результаты через приватный репозиторий `xonta-runs`. Человеку не нужно ничего копировать между сервером и чатом.

Как это ходит:

1. Оркестрирующая сессия кладёт в `xonta-runs/queue/next.json` задание: имя прогона, коммит этого репозитория и переменные стенда.
2. `stand/autopilot.sh` на сервере раз в 10 минут смотрит почтовый ящик. Если прогон не идёт и задание новое, он берёт код нужного коммита, кладёт его в каталог стенда (не трогая `stand-data` и `stand.env`) и поднимает compose стенда.
3. Когда прогон закончился, автопилот кладёт в `xonta-runs/runs/<имя>/` отчёт стенда, архив результатов и журнал. Ключи (`*.jwk`, `keys/`) и строки с ключами в журнал не попадают.
4. Сессия забирает результаты, пишет отчёт, при необходимости правит код и кладёт следующее задание.

Ограничения прописаны в самом скрипте и из репозитория не меняются:

- не больше `MAX_PER_DAY` прогонов в сутки (задаётся в cron);
- переменные — только из белого списка префиксов (`NET_`, `SUP_`, `ADVICE_`, `GUARD_`, `EXAM_`, `TASKS_`, `TOTAL_` и пределы токенов), значения без пробелов и спецсимволов;
- только контейнер `xonta-stand-network` и каталог стенда; другие сервисы на сервере не трогаются, сервер не перезагружается;
- файл `queue/STOP` останавливает запуск новых прогонов.

Установка на сервере (один раз):

```bash
# 1. ключ только для xonta-runs; публичную часть добавить в GitHub: xonta-runs → Settings → Deploy keys → Add, галочка «Allow write access»
ssh-keygen -t ed25519 -N "" -f /root/.ssh/xonta_runs -C xonta-stand && cat /root/.ssh/xonta_runs.pub

# 2. после добавления ключа
GIT_SSH_COMMAND="ssh -i /root/.ssh/xonta_runs -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git clone git@github.com:mrsergeiluzhnov/xonta-runs.git /home/xonta/xonta-runs
git clone https://github.com/mrsergeiluzhnov/xonta /home/xonta/xonta-src
cp /home/xonta/xonta-src/stand/autopilot.sh /home/xonta/autopilot.sh && chmod +x /home/xonta/autopilot.sh
(crontab -l 2>/dev/null; echo "*/10 * * * * MAX_PER_DAY=2 /home/xonta/autopilot.sh >/dev/null 2>&1") | crontab -
```

Скрипт автопилота запускается из копии `/home/xonta/autopilot.sh`, а не из репозитория: правки в репозитории не меняют его ограничения без человека. Журнал автопилота — `/home/xonta/xonta-autopilot.log`.

#!/bin/sh
# DBのバックアップ（compose.yaml の backup サービスが動かす）。
# 10分ごとに見て、今日（日本時間）の分がまだなく4時を過ぎていれば、/backups に bot-YYYYMMDD.sql.gz を作る。
# まだ1つもなければ（初めて動かしたとき）、時刻に関係なくすぐ作る。
# KEEP_DAYS 日より古いものは消す。接続先は PGHOST などの環境変数で渡す
set -eu
set -o pipefail
umask 077

while true; do
  # postgres の Alpine には日本時間の設定がないので、9時間足して日本時間の日付と時刻を出す
  jst=$(($(date +%s) + 9 * 3600))
  day=$(date -u -d "@$jst" +%Y%m%d)
  hour=$(date -u -d "@$jst" +%H)
  file="/backups/bot-$day.sql.gz"
  first=$(find /backups -name 'bot-*.sql.gz' | head -n 1)
  if [ ! -f "$file" ] && { [ "$hour" -ge 4 ] || [ -z "$first" ]; }; then
    if pg_dump --clean --if-exists --no-owner | gzip > "$file.tmp"; then
      mv "$file.tmp" "$file"
      echo "バックアップを作りました: $file"
    else
      rm -f "$file.tmp"
      echo "バックアップに失敗しました" >&2
    fi
    find /backups -name 'bot-*.sql.gz' -mtime +"${KEEP_DAYS:-14}" -delete
  fi
  sleep 600
done

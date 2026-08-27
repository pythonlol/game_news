#!/bin/bash
# 每日从 GitHub 拉取最新生成的 index.html / feed.xml 到 /opt/game-news/
# GitHub Actions 每天北京时间 09:00 / 13:00 两次触发(互为备份, 09:00 可能被 GitHub 跳过),
# 建议本脚本的计划任务安排在 14:10 之后, 确保总能拉到当天数据; 也可 11:10 / 14:10 各跑一次
set -u
DEST_DIR=/opt/game-news
LOG=$DEST_DIR/update.log
RAW_BASE="https://raw.githubusercontent.com/pythonlol/game_news/main"
# 直连失败时依次尝试加速代理
PROXIES=(
  ""
  "https://ghproxy.net/"
  "https://ghfast.top/"
)

# fetch_one <文件名> <内容校验串>; 成功返回 0
fetch_one() {
  local file="$1" marker="$2" tmp url
  tmp=$(mktemp)
  for p in "${PROXIES[@]}"; do
    url="$p$RAW_BASE/$file"
    if curl -fsL -m 30 "$url" -o "$tmp" && grep -q "$marker" "$tmp"; then
      mv "$tmp" "$DEST_DIR/$file"
      chmod 644 "$DEST_DIR/$file" # mktemp 文件默认 600, 不放开 nginx 读不到会 403
      echo "$(date -Is) $file 更新成功 (来源: $url)" >> "$LOG"
      return 0
    fi
  done
  rm -f "$tmp"
  return 1
}

rc=0
if ! fetch_one "index.html" "每日游戏资讯"; then
  echo "$(date -Is) index.html 更新失败: 所有源均不可用" >> "$LOG"
  rc=1
fi
if ! fetch_one "feed.xml" "<rss"; then
  echo "$(date -Is) feed.xml 更新失败: 所有源均不可用(不影响页面)" >> "$LOG"
fi
exit $rc

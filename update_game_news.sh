#!/bin/bash
# 每日从 GitHub 拉取最新生成的 index.html / feed.xml 到 /opt/game-news/
# GitHub Actions 每天北京时间 09:00 / 13:00 两次触发, 但 GitHub 排队延迟约 4h,
# 实际完成在 13:26 / 17:28 左右; cron 设为 10 14,19,22 * * * (北京时间 14:10/19:10/22:10),
# 在两次 CI 完成后各拉一次, 22:10 兜底, 确保数据延迟不超过 5 小时
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

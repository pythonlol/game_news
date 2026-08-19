@echo off
rem 每日游戏资讯更新: 抓取最新资讯并重新生成 index.html, 日志追加到 data\fetch.log
rem 注意: node 需在 PATH 中(当前安装于 C:\Program Files\nodejs\)
cd /d D:\game_news
echo. >> data\fetch.log
echo ==== %date% %time% ==== >> data\fetch.log
node fetch_news.js >> data\fetch.log 2>&1

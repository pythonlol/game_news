@echo off
rem 每日游戏资讯更新: 抓取最新资讯并重新生成 index.html (日志由脚本自行写入 data\fetch.log)
cd /d D:\game_news
"C:\Users\PC\AppData\Local\Programs\nodejs\node-v24.9.0-win-x64\node.exe" fetch_news.js

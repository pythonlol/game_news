@echo off
rem 每日游戏资讯更新: 抓取最新资讯并重新生成 index.html
cd /d D:\game_news
rem 优先用 PATH 里的 node, 找不到再回退到固定路径(升级 Node 后无需改此文件)
where node >nul 2>&1 && set "NODE=node" || set "NODE=C:\Users\PC\AppData\Local\Programs\nodejs\node-v24.9.0-win-x64\node.exe"
rem 每次运行截断日志, 避免无限增长
type nul > data\fetch.log
%NODE% fetch_news.js >> data\fetch.log 2>&1

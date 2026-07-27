// 游戏资讯每日抓取脚本
// 用法: node fetch_news.js
// 功能: 从官网 RSS 和游戏媒体 RSS 抓取 10 家主流游戏厂商的最新资讯,
//       合并进 data/news.json(去重、保留 60 天),并生成 index.html 静态网页。

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "news.json");
const HTML_FILE = path.join(ROOT, "index.html");
const KEEP_DAYS = 60; // 历史资讯保留天数
const MAX_PER_COMPANY = 50; // 每家公司最多保留条数
const FETCH_TIMEOUT = 20000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ---------- 10 家目标厂商及关键词 ----------
const COMPANIES = [
  { id: "tencent", name: "腾讯游戏", en: "Tencent Games", keywords: ["Tencent", "腾讯", "Level Infinite", "TiMi Studio", "天美", "光子工作室", "WeGame", "王者荣耀", "Honor of Kings", "和平精英", "英雄联盟", "League of Legends", "Valorant", "无畏契约", "穿越火线", "三角洲行动", "Riot Games", "拳头游戏"] },
  { id: "netease", name: "网易游戏", en: "NetEase Games", keywords: ["NetEase", "网易", "梦幻西游", "大话西游", "第五人格", "Identity V", "逆水寒", "永劫无间", "Naraka", "蛋仔派对", "Marvel Rivals", "漫威争锋", "率土之滨", "燕云十六声"] },
  { id: "mihoyo", name: "米哈游", en: "HoYoverse", keywords: ["miHoYo", "HoYoverse", "米哈游", "Genshin", "原神", "Honkai", "崩坏", "Zenless", "绝区零", "Star Rail", "星穹铁道"] },
  { id: "nintendo", name: "任天堂", en: "Nintendo", keywords: ["Nintendo", "任天堂", "Switch 2", "Switch", "Zelda", "塞尔达", "Mario", "马力欧", "马里奥", "Pokémon", "宝可梦", "Metroid", "Kirby"] },
  { id: "sony", name: "索尼 PlayStation", en: "PlayStation", keywords: ["PlayStation", "PS5", "PS4", "PS Plus", "PSVR", "索尼", "Sony Interactive", "Ghost of Tsushima", "God of War"] },
  { id: "xbox", name: "微软 Xbox", en: "Xbox", keywords: ["Xbox", "微软", "Game Pass", "Halo", "光环", "Forza", "Gears of War", "Microsoft Gaming", "Phil Spencer"] },
  { id: "blizzard", name: "暴雪", en: "Blizzard", keywords: ["Blizzard", "暴雪", "Warcraft", "魔兽", "Diablo", "暗黑破坏神", "Overwatch", "守望先锋", "Hearthstone", "炉石传说", "StarCraft", "星际争霸"] },
  { id: "ea", name: "EA", en: "Electronic Arts", keywords: ["Electronic Arts", "EA Sports", "Apex Legends", "Battlefield", "战地", "The Sims", "模拟人生", "EA FC", "FIFA", "Need for Speed", "极品飞车"] },
  { id: "ubisoft", name: "育碧", en: "Ubisoft", keywords: ["Ubisoft", "育碧", "Assassin's Creed", "刺客信条", "Far Cry", "孤岛惊魂", "Rainbow Six", "彩虹六号", "The Division", "全境封锁"] },
  { id: "valve", name: "Valve", en: "Valve", keywords: ["Valve", "Steam Deck", "Steam", "Half-Life", "半条命", "Dota", "Counter-Strike", "CS2", "反恐精英", "Portal", "传送门", "Team Fortress"] },
];

// EA 单独用带词边界的正则,避免误匹配(如 "each" 中的 "ea" 不区分大小写时无碍,主要防 "EA" 缩写过宽)
const COMPANY_REGEX = COMPANIES.map((c) => ({
  ...c,
  regexes: c.keywords.map((k) =>
    c.id === "ea" && k === "EA"
      ? new RegExp("\\bEA\\b")
      : new RegExp(escapeRegExp(k), "i")
  ),
}));
// 给 EA 额外补一个字面 "EA" 关键词的正则已包含在上面逻辑中

// ---------- 资讯来源 ----------
// type=media: 需按关键词匹配厂商; 带 companyId: 直接归属该厂商
const SOURCES = [
  // 官网
  { name: "PlayStation Blog", url: "https://blog.playstation.com/feed/", type: "official", companyId: "sony" },
  { name: "Xbox Wire", url: "https://news.xbox.com/en-us/feed/", type: "official", companyId: "xbox" },
  { name: "Steam 官方新闻", url: "https://store.steampowered.com/feeds/news.xml", type: "official", companyId: "valve" },
  // 按公司检索的必应资讯 RSS(用于国内厂商, 中文媒体覆盖更稳定)
  { name: "必应资讯", url: "https://www.bing.com/search?q=" + encodeURIComponent("腾讯游戏 新闻") + "&format=rss&setlang=zh-CN", type: "search", companyId: "tencent" },
  { name: "必应资讯", url: "https://www.bing.com/search?q=" + encodeURIComponent("网易游戏 新闻") + "&format=rss&setlang=zh-CN", type: "search", companyId: "netease" },
  { name: "必应资讯", url: "https://www.bing.com/search?q=" + encodeURIComponent("米哈游 新闻") + "&format=rss&setlang=zh-CN", type: "search", companyId: "mihoyo" },
  // 游戏媒体
  { name: "IGN", url: "https://feeds.ign.com/ign/all", type: "media" },
  { name: "GameSpot", url: "https://www.gamespot.com/feeds/mashup/", type: "media" },
  { name: "Eurogamer", url: "https://www.eurogamer.net/feed", type: "media" },
  { name: "Gematsu", url: "https://www.gematsu.com/feed", type: "media" },
  { name: "PC Gamer", url: "https://www.pcgamer.com/rss/", type: "media" },
  { name: "Rock Paper Shotgun", url: "https://www.rockpapershotgun.com/feed", type: "media" },
  { name: "机核", url: "https://www.gcores.com/rss", type: "media" },
  { name: "游研社", url: "https://www.yystv.cn/rss/feed", type: "media" },
  // 无 RSS, 直接抓新闻列表页 HTML
  { name: "3DM游戏网", url: "https://www.3dmgame.com/news/", type: "media", format: "html3dm" },
  { name: "3DM厂商新闻", url: "https://www.3dmgame.com/news_38_1/", type: "media", format: "html3dm" },
  { name: "17173", url: "https://news.17173.com/", type: "media", format: "html17173" },
];

// 搜索类来源的导航页垃圾过滤(官网首页/百科/邮箱等非资讯结果)
function isJunkSearchResult(item) {
  if (/首页|百度百科|邮箱|登录|注册|下载|社区/.test(item.title)) return true;
  try {
    const u = new URL(item.link);
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length <= 1 && !/\d{3,}/.test(u.pathname)) return true; // 裸域名或浅层导航页
  } catch {}
  return false;
}

// 所有来源通用: 壁纸/图集类内容不算厂商资讯
function isGlobalJunk(item) {
  return /壁纸|图集|美图/.test(item.title);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripCdata(s) {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : s;
}

function stripHtml(s) {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// 解析日期, 兼容必应中文格式 "周五, 24 7月 2026 07:42:00 GMT"
function toDate(s) {
  s = s.trim();
  const cn = s.match(/(\d{1,2})\s*(\d{1,2})月\s*(\d{4})\s+(\d{1,2}:\d{2}:\d{2})/);
  if (cn) {
    const iso = `${cn[3]}-${String(cn[2]).padStart(2, "0")}-${String(cn[1]).padStart(2, "0")}T${cn[4]}${/GMT|UTC/i.test(s) ? "Z" : ""}`;
    const d = new Date(iso);
    return isNaN(d) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// 简单容错 RSS/Atom 解析: 返回 [{title, link, date, summary}]
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const titleM = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleM ? decodeEntities(stripHtml(stripCdata(titleM[1]))) : "";
    // RSS: <link>url</link> ; Atom: <link href="url" .../>
    let link = "";
    const linkTag = b.match(/<link([^>]*?)\/?>([\s\S]*?)<\/link>/i) || b.match(/<link([^>]*?)\/>/i);
    if (linkTag) {
      const hrefM = (linkTag[1] || "").match(/href\s*=\s*"([^"]+)"/i);
      link = hrefM ? hrefM[1] : decodeEntities((linkTag[2] || "").trim());
    }
    const dateM =
      b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
      b.match(/<published[^>]*>([\s\S]*?)<\/published>/i) ||
      b.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) ||
      b.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i);
    const date = dateM ? toDate(stripCdata(dateM[1])) : null;
    const sumM =
      b.match(/<description[^>]*>([\s\S]*?)<\/description>/i) ||
      b.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) ||
      b.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i);
    const summary = sumM ? decodeEntities(stripHtml(stripCdata(sumM[1]))).slice(0, 200) : "";
    if (title && link) {
      items.push({ title, link, date: date && !isNaN(date) ? date.toISOString() : null, summary });
    }
  }
  return items;
}

// 3DM 新闻列表页抓取: 文章链接形如 /news/202607/3949168.html
function parse3dm(html) {
  const items = [];
  const seen = new Set();
  const re = /<a\s+href="(https:\/\/www\.3dmgame\.com\/news\/\d{6}\/\d+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const link = m[1];
    const title = decodeEntities(stripHtml(m[2])).trim();
    if (seen.has(link) || title.length < 4) continue;
    seen.add(link);
    items.push({ title, link, date: null, summary: "" });
  }
  return items;
}

// 17173 新闻列表页抓取: 链接形如 //news.17173.com/content/07242026/182242404.shtml
// URL 中 MMDDYYYY/HHMMSS 即发布时间
function parse17173(html) {
  const items = [];
  const seen = new Set();
  const re = /<a\s+href="(\/\/news\.17173\.com\/content\/(\d{2})(\d{2})(\d{4})\/(\d{2})(\d{2})(\d{2})\d*\.shtml)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const link = "https:" + m[1];
    const title = decodeEntities(stripHtml(m[8])).trim();
    if (seen.has(link) || title.length < 4) continue;
    seen.add(link);
    const d = new Date(Number(m[4]), Number(m[2]) - 1, Number(m[3]), Number(m[5]), Number(m[6]), Number(m[7]));
    items.push({ title, link, date: isNaN(d) ? null : d.toISOString(), summary: "" });
  }
  return items;
}

async function fetchFeed(source) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(source.url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml,application/xml,text/xml,text/html,*/*" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = await res.text();
    if (source.format === "html3dm") return parse3dm(body);
    if (source.format === "html17173") return parse17173(body);
    return parseFeed(body);
  } finally {
    clearTimeout(timer);
  }
}

function matchCompanies(text) {
  const hits = [];
  for (const c of COMPANY_REGEX) {
    if (c.regexes.some((r) => r.test(text))) hits.push(c.id);
  }
  return hits;
}

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { updatedAt: null, items: [] };
  }
}

function saveData(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ---------- 生成网页 ----------
function renderHtml(data) {
  const byCompany = {};
  for (const c of COMPANIES) byCompany[c.id] = [];
  for (const it of data.items) {
    for (const cid of it.companies) {
      if (byCompany[cid]) byCompany[cid].push(it);
    }
  }
  for (const cid of Object.keys(byCompany)) {
    byCompany[cid].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  };
  const fmtTime = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  };

  // ---------- 今日最新: 最近 24 小时, 不足 10 条放宽到 48 小时 ----------
  const companyName = Object.fromEntries(COMPANIES.map((c) => [c.id, c.name]));
  const now = Date.now();
  const recent = data.items
    .filter((it) => it.date && now - new Date(it.date).getTime() <= 48 * 3600e3)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const todayItems = recent.filter((it) => now - new Date(it.date).getTime() <= 24 * 3600e3);
  const today = todayItems.length >= 10 ? todayItems : recent;
  const todayList = today.length
    ? today
        .map(
          (it) => `
        <li class="news-item">
          <a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>
          <div class="meta"><span class="time">${fmtTime(it.date)}</span><span class="source">${esc(it.source)}</span>${it.companies
            .map((cid) => `<span class="tag">${esc(companyName[cid] || cid)}</span>`)
            .join("")}</div>
          ${it.summary ? `<p class="summary">${esc(it.summary)}</p>` : ""}
        </li>`
        )
        .join("")
    : `<li class="empty">最近 48 小时暂无新资讯</li>`;
  const todaySection = `
      <section class="company today" id="today">
        <h2><span class="badge">★</span> 今日最新 <small>最近更新按时间混排</small></h2>
        <ul>${todayList}</ul>
      </section>`;

  const sections = COMPANIES.map((c, idx) => {
    const items = byCompany[c.id];
    const list = items.length
      ? items
          .map(
            (it) => `
        <li class="news-item">
          <a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>
          <div class="meta"><span class="source">${esc(it.source)}</span><span class="date">${fmtDate(it.date)}</span></div>
          ${it.summary ? `<p class="summary">${esc(it.summary)}</p>` : ""}
        </li>`
          )
          .join("")
      : `<li class="empty">暂无可匹配的资讯</li>`;
    return `
      <section class="company" id="${c.id}">
        <h2><span class="badge">${String(idx + 1).padStart(2, "0")}</span> ${esc(c.name)} <small>${esc(c.en)}</small></h2>
        <ul>${list}</ul>
      </section>`;
  }).join("\n");

  const nav = `<a href="#today">今日最新</a>` + COMPANIES.map((c) => `<a href="#${c.id}">${esc(c.name)}</a>`).join("");
  const updatedAt = data.updatedAt
    ? new Date(data.updatedAt).toLocaleString("zh-CN", { hour12: false })
    : "从未更新";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>每日游戏资讯 · 十大厂商</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #0f1117; color: #e6e6e6; line-height: 1.6; }
  header { padding: 32px 24px 16px; text-align: center; }
  header h1 { font-size: 28px; letter-spacing: 2px; }
  header p { color: #8a8f9e; margin-top: 8px; font-size: 14px; }
  nav { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; padding: 16px 24px; position: sticky; top: 0; background: #0f1117ee; backdrop-filter: blur(6px); z-index: 10; border-bottom: 1px solid #232838; }
  nav a { color: #9ec1ff; text-decoration: none; font-size: 13px; padding: 4px 10px; border: 1px solid #2a3145; border-radius: 14px; }
  nav a:hover { background: #1c2334; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 60px; }
  .company { margin-bottom: 40px; }
  .company h2 { font-size: 20px; padding-bottom: 8px; border-bottom: 2px solid #2a3145; margin-bottom: 12px; display: flex; align-items: baseline; gap: 10px; }
  .company h2 small { color: #8a8f9e; font-size: 13px; font-weight: normal; }
  .badge { color: #4c5a7d; font-size: 14px; font-family: Consolas, monospace; }
  ul { list-style: none; }
  .news-item { padding: 10px 4px; border-bottom: 1px dashed #20263a; }
  .news-item a { color: #d7e3ff; text-decoration: none; font-size: 15px; }
  .news-item a:hover { color: #7fb0ff; text-decoration: underline; }
  .meta { font-size: 12px; color: #8a8f9e; margin-top: 2px; display: flex; gap: 12px; }
  .source { color: #6f9f6f; }
  .summary { font-size: 13px; color: #9aa0ae; margin-top: 4px; }
  .empty { color: #5a6070; font-size: 14px; padding: 8px 4px; list-style: none; }
  .today h2 { border-bottom-color: #3d5a80; }
  .today .badge { color: #e0a458; }
  .tag { color: #7fb0ff; background: #1c2334; border-radius: 8px; padding: 0 6px; font-size: 11px; }
  .time { color: #b7a6d9; }
  footer { text-align: center; color: #5a6070; font-size: 12px; padding: 20px; }
  @media (max-width: 600px) {
    header { padding: 20px 12px 10px; }
    header h1 { font-size: 21px; }
    header p { font-size: 12px; }
    nav { flex-wrap: nowrap; overflow-x: auto; justify-content: flex-start; padding: 10px 12px; -webkit-overflow-scrolling: touch; }
    nav a { flex-shrink: 0; font-size: 12px; }
    main { padding: 16px 10px 48px; }
    .company h2 { font-size: 17px; }
    .news-item { padding: 12px 4px; }
    .news-item a { font-size: 15px; line-height: 1.5; }
    .summary { font-size: 12px; }
  }
</style>
</head>
<body>
<header>
  <h1>每日游戏资讯</h1>
  <p>收录腾讯、网易、米哈游、任天堂、索尼、微软、暴雪、EA、育碧、Valve 十大厂商动态 · 来源: 厂商官网 + 游戏媒体</p>
  <p>最近更新: ${updatedAt}</p>
</header>
<nav>${nav}</nav>
<main>
${todaySection}
${sections}
</main>
<footer>由 fetch_news.js 自动生成 · 数据保留最近 ${KEEP_DAYS} 天</footer>
</body>
</html>`;
}

// ---------- 主流程 ----------
async function main() {
  const data = loadData();
  const existing = new Map(data.items.map((it) => [it.link, it]));
  let added = 0;

  for (const src of SOURCES) {
    let items;
    try {
      items = await fetchFeed(src);
      console.log(`[OK] ${src.name}: ${items.length} 条`);
    } catch (e) {
      console.log(`[FAIL] ${src.name}: ${e.message}`);
      continue;
    }
    for (const it of items) {
      if (isGlobalJunk(it)) continue;
      if (src.type === "search" && isJunkSearchResult(it)) continue;
      const text = it.title + " " + it.summary;
      const companies = src.companyId ? [src.companyId] : matchCompanies(text);
      if (companies.length === 0) continue;
      const key = it.link;
      if (existing.has(key)) {
        // 已有条目: 合并新匹配到的厂商
        const old = existing.get(key);
        for (const cid of companies) if (!old.companies.includes(cid)) old.companies.push(cid);
        continue;
      }
      const rec = { ...it, date: it.date || new Date().toISOString(), source: src.name, companies };
      existing.set(key, rec);
      added++;
    }
  }

  // 清理过期 + 每厂商限量
  const cutoff = Date.now() - KEEP_DAYS * 86400e3;
  let all = [...existing.values()].filter((it) => !it.date || new Date(it.date).getTime() >= cutoff);
  all.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const count = {};
  all = all.filter((it) => {
    // 按"条目主厂商"(第一个)计数限量
    const main = it.companies[0];
    count[main] = (count[main] || 0) + 1;
    return count[main] <= MAX_PER_COMPANY;
  });

  data.items = all;
  data.updatedAt = new Date().toISOString();
  saveData(data);
  fs.writeFileSync(HTML_FILE, renderHtml(data), "utf8");

  console.log(`新增 ${added} 条, 现有共 ${all.length} 条`);
  console.log(`已生成 ${HTML_FILE}`);
}

main().catch((e) => {
  console.error("运行失败:", e);
  process.exit(1);
});

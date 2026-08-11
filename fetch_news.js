// 游戏资讯每日抓取脚本
// 用法: node fetch_news.js
// 功能: 从官网 RSS 和游戏媒体 RSS 抓取 10 家主流游戏厂商的最新资讯,
//       合并进 data/news.json(去重、保留 60 天),非中文条目自动翻译为中文,
//       并生成 index.html 静态网页。

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "news.json");
const HTML_FILE = path.join(ROOT, "index.html");
const KEEP_DAYS = 60; // 历史资讯保留天数
const MAX_PER_COMPANY = 50; // 每家公司最多保留条数
const FETCH_TIMEOUT = 20000;
const FETCH_CONCURRENCY = 5; // 同时抓取的来源数量上限
const FETCH_RETRIES = 2; // 单个来源失败后的重试次数(间隔 1s/2s)

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

// 常用英文单词类关键词强制大小写敏感, 避免把普通词误判为厂商
// (如 "switch to PC" 命中任天堂、"steam rising" 命中 Valve、"ea" 出现在普通文本中)
const CASE_SENSITIVE = new Set(["EA", "Steam", "Switch", "Portal"]);

// 匹配规则: 纯 ASCII 关键词加词边界(防 "Steam" 命中 "steampunk"、"CS2" 命中单词内部),
// CASE_SENSITIVE 中的词额外要求大小写一致; 中文关键词保持子串匹配
const COMPANY_REGEX = COMPANIES.map((c) => ({
  ...c,
  regexes: c.keywords.map((k) => {
    const ascii = /^[\x20-\x7e]+$/.test(k);
    const body = ascii ? `\\b${escapeRegExp(k)}\\b` : escapeRegExp(k);
    return new RegExp(body, CASE_SENSITIVE.has(k) ? "" : "i");
  }),
}));

// ---------- 资讯来源 ----------
// type=media: 需按关键词匹配厂商; 带 companyId: 直接归属该厂商
const SOURCES = [
  // 官网
  { name: "PlayStation Blog", url: "https://blog.playstation.com/feed/", type: "official", companyId: "sony" },
  { name: "Xbox Wire", url: "https://news.xbox.com/en-us/feed/", type: "official", companyId: "xbox" },
  { name: "Steam 官方新闻", url: "https://store.steampowered.com/feeds/news.xml", type: "official", companyId: "valve" },
  // 按公司检索的必应资讯 RSS(用于国内厂商, 中文媒体覆盖更稳定)
  { name: "必应资讯·腾讯", url: "https://www.bing.com/search?q=" + encodeURIComponent("腾讯游戏 新闻") + "&format=rss&setlang=zh-CN", type: "search", companyId: "tencent" },
  { name: "必应资讯·网易", url: "https://www.bing.com/search?q=" + encodeURIComponent("网易游戏 新闻") + "&format=rss&setlang=zh-CN", type: "search", companyId: "netease" },
  { name: "必应资讯·米哈游", url: "https://www.bing.com/search?q=" + encodeURIComponent("米哈游 新闻") + "&format=rss&setlang=zh-CN", type: "search", companyId: "mihoyo" },
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
  if (/首页|百度百科|邮箱|登录|注册|下载|社区|网易云音乐/.test(item.title)) return true;
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
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * attempt));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(source.url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/rss+xml,application/xml,text/xml,text/html,*/*",
          "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
        },
        signal: ctrl.signal,
        redirect: "follow",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const body = await res.text();
      if (source.format === "html3dm") return parse3dm(body);
      if (source.format === "html17173") return parse17173(body);
      return parseFeed(body);
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// 带并发上限的并行映射, 结果顺序与输入一致
async function mapLimit(list, limit, fn) {
  const results = new Array(list.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (i < list.length) {
        const idx = i++;
        results[idx] = await fn(list[idx]);
      }
    })
  );
  return results;
}

// ---------- 翻译: 非中文标题/摘要 -> 中文 ----------
// 主用 Edge 翻译接口(免费/免密钥/支持批量, 国内可直连), 失败回退谷歌免费接口(CI 上可用)
// 译文以 titleZh/summaryZh 写入数据文件持久缓存, 已有译文的条目不会重复请求
const TRANSLATE_BATCH = 20; // 每次请求合并的文本条数

function needsTranslation(s) {
  return !!s && !/[一-鿿]/.test(s);
}

let edgeToken = null;
async function translateViaEdge(texts) {
  if (!edgeToken) {
    const auth = await fetch("https://edge.microsoft.com/translate/auth", { signal: AbortSignal.timeout(15000) });
    if (!auth.ok) throw new Error("HTTP " + auth.status);
    edgeToken = await auth.text();
  }
  const res = await fetch("https://api-edge.cognitive.microsofttranslator.com/translate?to=zh-Hans&api-version=3.0", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + edgeToken },
    body: JSON.stringify(texts.map((t) => ({ Text: t }))),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return data.map((d, i) => (d.translations && d.translations[0] && d.translations[0].text) || texts[i]);
}

async function translateViaGoogle(texts) {
  const out = [];
  for (const t of texts) {
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=" + encodeURIComponent(t);
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    out.push((data[0] || []).map((seg) => seg[0]).join("") || t);
  }
  return out;
}

async function translateChunk(texts) {
  try {
    return await translateViaEdge(texts);
  } catch {
    try {
      return await translateViaGoogle(texts);
    } catch {
      return null;
    }
  }
}

async function translateItems(items) {
  const tasks = [];
  for (const it of items) {
    if (needsTranslation(it.title) && !it.titleZh) tasks.push([it, "titleZh", it.title]);
    if (needsTranslation(it.summary) && !it.summaryZh) tasks.push([it, "summaryZh", it.summary]);
  }
  if (!tasks.length) return;
  const chunks = [];
  for (let i = 0; i < tasks.length; i += TRANSLATE_BATCH) chunks.push(tasks.slice(i, i + TRANSLATE_BATCH));
  let ok = 0;
  await mapLimit(chunks, 3, async (chunk) => {
    const out = await translateChunk(chunk.map((t) => t[2]));
    if (out) chunk.forEach((t, i) => {
      if (out[i] && out[i] !== t[2]) { t[0][t[1]] = out[i]; ok++; }
    });
  });
  console.log(`翻译完成 ${ok}/${tasks.length} 段文本(失败条目保留原文)`);
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
    return d.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  };

  // ---------- 今日最新: 最近 24 小时, 不足 10 条放宽到 48 小时 ----------
  const companyName = Object.fromEntries(COMPANIES.map((c) => [c.id, c.name]));
  const now = Date.now();
  const recent = data.items
    .filter((it) => it.date && now - new Date(it.date).getTime() <= 48 * 3600e3)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const todayItems = recent.filter((it) => now - new Date(it.date).getTime() <= 24 * 3600e3);
  const today = todayItems.length >= 10 ? todayItems : recent;
  // 相对时间: 1 小时内显示分钟, 1 天内显示小时, 7 天内显示天数, 更早显示日期; 悬停看完整时间
  const relTime = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const diff = now - d.getTime();
    if (diff < 0) return fmtDate(iso);
    const min = Math.floor(diff / 60e3);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day} 天前`;
    return fmtDate(iso);
  };
  const fmtFull = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  };
  const isNew = (it) => it.date && now - new Date(it.date).getTime() <= 24 * 3600e3;
  // 单条资讯渲染: showTime 时附带厂商标签(用于"今日最新"混排); 24 小时内的条目带 NEW 标记
  const renderItem = (it, showTime) => `
        <li class="news-item">
          <a href="${esc(it.link)}" target="_blank" rel="noopener"${it.titleZh ? ` title="${esc(it.title)}"` : ""}>${esc(it.titleZh || it.title)}</a>${isNew(it) ? `<span class="new-badge">NEW</span>` : ""}
          <div class="meta">${it.date ? `<span class="time" title="${esc(fmtFull(it.date))}">${relTime(it.date)}</span>` : ""}<span class="source">${esc(it.source)}</span>${
            showTime ? it.companies.map((cid) => `<span class="tag">${esc(companyName[cid] || cid)}</span>`).join("") : ""
          }</div>
          ${it.summary || it.summaryZh ? `<p class="summary">${esc(it.summaryZh || it.summary)}</p>` : ""}
        </li>`;

  // 今日最新默认只展示前 TODAY_VISIBLE 条, 其余折叠, 想看再点开
  const TODAY_VISIBLE = 10;
  const todayHead = today.slice(0, TODAY_VISIBLE).map((it) => renderItem(it, true)).join("");
  const todayRest = today.slice(TODAY_VISIBLE);
  const todayList = today.length
    ? `<ul class="cards">${todayHead}</ul>` +
      (todayRest.length
        ? `<details class="more"><summary>展开其余 ${todayRest.length} 条</summary><ul class="cards">${todayRest.map((it) => renderItem(it, true)).join("")}</ul></details>`
        : "")
    : `<p class="empty">最近 48 小时暂无新资讯</p>`;
  const todaySection = `
      <section class="company today" id="today">
        <h2><span class="badge">★</span> 今日最新 <small>最近更新按时间混排</small></h2>
        ${todayList}
      </section>`;

  // 每家厂商默认展示前 VISIBLE_COUNT 条, 其余折叠, 避免页面过长
  const VISIBLE_COUNT = 5;
  const sections = COMPANIES.map((c, idx) => {
    const items = byCompany[c.id];
    const head = items.slice(0, VISIBLE_COUNT).map((it) => renderItem(it, false)).join("");
    const rest = items.slice(VISIBLE_COUNT);
    const list = items.length
      ? `<ul class="cards">${head}</ul>` +
        (rest.length
          ? `<details class="more"><summary>展开其余 ${rest.length} 条</summary><ul class="cards">${rest.map((it) => renderItem(it, false)).join("")}</ul></details>`
          : "")
      : `<p class="empty">暂无可匹配的资讯</p>`;
    return `
      <section class="company" id="${c.id}">
        <h2><span class="badge">${String(idx + 1).padStart(2, "0")}</span> ${esc(c.name)} <small>${esc(c.en)} · ${items.length} 条</small></h2>
        ${list}
      </section>`;
  }).join("\n");

  const nav = `<a href="#today">今日最新</a>` + COMPANIES.map((c) => `<a href="#${c.id}">${esc(c.name)}</a>`).join("") +
    `<input class="search" id="q" type="search" placeholder="搜索资讯…" aria-label="搜索资讯">`;
  const updatedAt = data.updatedAt
    ? new Date(data.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    : "从未更新";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎮</text></svg>">
<meta property="og:title" content="每日游戏资讯 · 十大厂商">
<meta property="og:description" content="腾讯、网易、米哈游、任天堂、索尼、微软、暴雪、EA、育碧、Valve 最新动态, 每天自动更新">
<meta property="og:type" content="website">
<meta property="og:url" content="https://chichihehe.cc/game/">
<title>每日游戏资讯 · 十大厂商</title>
<script>
// 页面渲染前先应用用户上次选择的主题, 避免切换闪烁
(function(){var t="dark";try{t=localStorage.getItem("gamenews-theme")||"dark"}catch(e){}if(["dark","light","eye"].indexOf(t)<0)t="dark";document.documentElement.setAttribute("data-theme",t);})();
</script>
<style>
  :root {
    --bg: #0e1117; --panel: #171c26; --panel-hover: #1c2230; --text: #e6e9f0; --muted: #8f97a8;
    --accent: #8ab4f8; --accent-soft: rgba(138,180,248,.14); --line: #262d3c;
    --nav-bg: rgba(14,17,23,.9); --visited: #98a0ae;
  }
  /* 亮色主题 */
  html[data-theme="light"] {
    --bg: #f5f6f8; --panel: #ffffff; --panel-hover: #eef2f8; --text: #1c2330; --muted: #667085;
    --accent: #2f6fd0; --accent-soft: rgba(47,111,208,.10); --line: #d8dde6;
    --nav-bg: rgba(245,246,248,.9); --visited: #8a92a6;
  }
  /* 护眼主题(豆沙绿) */
  html[data-theme="eye"] {
    --bg: #e3edcd; --panel: #eef5dd; --panel-hover: #e2eec9; --text: #2f3a28; --muted: #67795a;
    --accent: #2e6b2e; --accent-soft: rgba(46,107,46,.12); --line: #c3d3a8;
    --nav-bg: rgba(227,237,205,.9); --visited: #7d8f6c;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; scroll-padding-top: 60px; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--text); line-height: 1.7; font-size: 16px; transition: background-color .25s ease, color .25s ease; }
  header { max-width: 860px; margin: 0 auto; padding: 36px 20px 18px; }
  header h1 { font-size: 26px; letter-spacing: 1px; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  header h1 .updated { font-size: 12px; font-weight: normal; letter-spacing: 0; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 2px 12px; }
  header p { color: var(--muted); margin-top: 10px; font-size: 13px; }
  nav { display: flex; flex-wrap: wrap; gap: 6px; max-width: 860px; margin: 0 auto; padding: 10px 20px; position: sticky; top: 0; background: var(--nav-bg); backdrop-filter: blur(10px); z-index: 10; border-bottom: 1px solid var(--line); }
  nav a { color: var(--muted); text-decoration: none; font-size: 13px; padding: 4px 12px; border-radius: 999px; transition: color .15s, background .15s; }
  nav a:hover { color: var(--accent); background: var(--accent-soft); }
  .search { margin-left: auto; flex-shrink: 0; border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 999px; padding: 4px 12px; font-size: 13px; width: 130px; outline: none; transition: width .2s, border-color .15s; }
  .search:focus { border-color: var(--accent); width: 190px; }
  .search::placeholder { color: var(--muted); }
  main { max-width: 860px; margin: 0 auto; padding: 8px 20px 64px; }
  .company { margin-top: 40px; }
  .company h2 { font-size: 18px; margin-bottom: 14px; padding-left: 12px; border-left: 3px solid var(--accent); line-height: 1.4; }
  .company h2 small { color: var(--muted); font-size: 12px; font-weight: normal; margin-left: 8px; }
  .badge { color: var(--accent); font-size: 13px; font-family: Consolas, monospace; margin-right: 6px; opacity: .8; }
  ul.cards { list-style: none; display: flex; flex-direction: column; gap: 10px; }
  .news-item { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; transition: border-color .15s, background .15s; }
  .news-item:hover { border-color: var(--accent); background: var(--panel-hover); }
  .news-item a { color: var(--text); text-decoration: none; font-size: 15.5px; font-weight: 600; line-height: 1.55; display: inline-block; }
  .news-item a:hover { color: var(--accent); }
  .news-item a:visited { color: var(--visited); }
  .meta { font-size: 12px; color: var(--muted); margin-top: 6px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .meta .time, .meta .date { font-family: Consolas, monospace; }
  .tag { background: var(--accent-soft); color: var(--accent); border-radius: 999px; padding: 0 8px; font-size: 11px; line-height: 18px; }
  .new-badge { display: inline-block; vertical-align: 3px; margin-left: 6px; background: #e05555; color: #fff; border-radius: 999px; padding: 0 7px; font-size: 10px; line-height: 16px; font-weight: 700; }
  .summary { font-size: 13px; color: var(--muted); margin-top: 6px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .empty { color: var(--muted); font-size: 14px; padding: 6px 0; }
  .more summary { list-style: none; cursor: pointer; text-align: center; color: var(--muted); font-size: 13px; margin-top: 10px; padding: 9px 0; border: 1px dashed var(--line); border-radius: 12px; transition: color .15s, border-color .15s; user-select: none; }
  .more summary::-webkit-details-marker { display: none; }
  .more summary:hover { color: var(--accent); border-color: var(--accent); }
  .more[open] summary { margin-bottom: 10px; }
  .theme-switch { position: fixed; left: 20px; bottom: 24px; display: flex; gap: 6px; z-index: 20; }
  .theme-switch button { cursor: pointer; font-size: 12px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); transition: color .15s, border-color .15s; }
  .theme-switch button:hover { color: var(--accent); border-color: var(--accent); }
  .theme-switch button.active { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
  footer { text-align: center; color: var(--muted); font-size: 12px; padding: 28px 20px; border-top: 1px solid var(--line); }
  footer a { color: var(--accent); text-decoration: none; margin-left: 12px; }
  @media (max-width: 600px) {
    body { font-size: 15px; }
    header { padding: 24px 14px 12px; }
    header h1 { font-size: 21px; }
    header p { font-size: 12px; }
    nav { flex-wrap: nowrap; overflow-x: auto; padding: 8px 14px; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
    nav::-webkit-scrollbar { display: none; }
    nav a { flex-shrink: 0; font-size: 12px; }
    main { padding: 4px 14px 96px; }
    .company { margin-top: 32px; }
    .company h2 { font-size: 16px; margin-bottom: 12px; }
    .news-item { padding: 12px 14px; }
    .news-item a { font-size: 15px; }
    .summary { font-size: 12.5px; }
    /* 小屏: 主题按钮缩小并贴近角落, main 底部留白避免遮挡正文 */
    .theme-switch { left: 12px; bottom: 12px; gap: 4px; }
    .theme-switch button { font-size: 11px; padding: 5px 10px; }
  }
</style>
</head>
<body>
<header id="top">
  <h1>每日游戏资讯 <span class="updated">更新于 ${updatedAt}</span></h1>
  <p>收录腾讯、网易、米哈游、任天堂、索尼、微软、暴雪、EA、育碧、Valve 十大厂商动态 · 来源: 厂商官网 + 游戏媒体 · 英文资讯已自动翻译, 悬停标题可看原文</p>
</header>
<nav>${nav}</nav>
<main>
${todaySection}
${sections}
</main>
<footer>由 fetch_news.js 自动生成 · 数据保留最近 ${KEEP_DAYS} 天<a href="#top">回到顶部 ↑</a></footer>
<div class="theme-switch" role="group" aria-label="主题切换">
  <button type="button" data-set-theme="eye">护眼</button>
  <button type="button" data-set-theme="light">亮色</button>
  <button type="button" data-set-theme="dark">暗色</button>
</div>
<script>
// 左下角主题切换: 护眼 / 亮色 / 暗色, 选择存入 localStorage, 下次打开自动生效
(function(){
  var KEY = "gamenews-theme";
  var btns = document.querySelectorAll(".theme-switch button");
  function apply(t){
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(KEY, t); } catch(e) {}
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i].getAttribute("data-set-theme") === t);
  }
  for (var i = 0; i < btns.length; i++) btns[i].addEventListener("click", function(){ apply(this.getAttribute("data-set-theme")); });
  var cur = "dark";
  try { cur = localStorage.getItem(KEY) || "dark"; } catch(e) {}
  if (["dark","light","eye"].indexOf(cur) < 0) cur = "dark";
  apply(cur);
})();
</script>
<script>
// 导航栏搜索: 输入即过滤(匹配标题/摘要/来源/厂商标签), 搜索时自动展开折叠分区, 清空后恢复
(function(){
  var q = document.getElementById("q");
  if (!q) return;
  var items = document.querySelectorAll(".news-item");
  var sections = document.querySelectorAll("main .company");
  var folds = document.querySelectorAll("details.more");
  q.addEventListener("input", function(){
    var s = q.value.trim().toLowerCase();
    var i, j;
    for (i = 0; i < folds.length; i++) folds[i].open = !!s;
    for (i = 0; i < items.length; i++)
      items[i].style.display = !s || items[i].textContent.toLowerCase().indexOf(s) >= 0 ? "" : "none";
    for (i = 0; i < sections.length; i++) {
      var lis = sections[i].querySelectorAll(".news-item");
      var any = !s;
      for (j = 0; j < lis.length; j++) if (lis[j].style.display !== "none") { any = true; break; }
      sections[i].style.display = any ? "" : "none";
    }
  });
})();
</script>
</body>
</html>`;
}

// ---------- 主流程 ----------
async function main() {
  const data = loadData();
  // 清理历史数据里搜索源混入的噪音(与新增条目同一套过滤规则)
  const searchNames = new Set(SOURCES.filter((s) => s.type === "search").map((s) => s.name));
  searchNames.add("必应资讯"); // 兼容来源改名前的历史数据
  const beforeClean = data.items.length;
  data.items = data.items.filter((it) => {
    if (!searchNames.has(it.source)) return true;
    if (isGlobalJunk(it) || isJunkSearchResult(it)) return false;
    return matchCompanies(it.title + " " + (it.summary || "")).some((cid) => it.companies.includes(cid));
  });
  if (data.items.length < beforeClean) console.log(`清理历史噪音 ${beforeClean - data.items.length} 条`);
  const existing = new Map(data.items.map((it) => [it.link, it]));
  let added = 0;

  // 并发抓取所有来源(上限 FETCH_CONCURRENCY), 再按来源顺序统一处理, 保证去重结果稳定
  const fetched = await mapLimit(SOURCES, FETCH_CONCURRENCY, async (src) => {
    try {
      const items = await fetchFeed(src);
      console.log(`[OK] ${src.name}: ${items.length} 条`);
      return { src, items };
    } catch (e) {
      console.log(`[FAIL] ${src.name}: ${e.message}`);
      return { src, items: [] };
    }
  });

  for (const { src, items } of fetched) {
    for (const it of items) {
      if (isGlobalJunk(it)) continue;
      if (src.type === "search" && isJunkSearchResult(it)) continue;
      const text = it.title + " " + it.summary;
      let companies = src.companyId ? [src.companyId] : matchCompanies(text);
      // 搜索源噪音大: 标题/摘要必须确实命中该公司关键词才收录
      if (src.type === "search" && !matchCompanies(text).includes(src.companyId)) continue;
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

  // 翻译非中文条目(结果写入条目字段, 随数据文件持久缓存)
  await translateItems(all);

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

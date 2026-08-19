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
const TEMPLATE_FILE = path.join(ROOT, "template.html");
const FEED_FILE = path.join(ROOT, "feed.xml");
const SITE_URL = "https://chichihehe.cc/game";
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
  if (/首页|百度百科|维基|邮箱|登录|注册|下载|社区|网易云音乐/.test(item.title)) return true;
  try {
    const u = new URL(item.link);
    if (u.hostname.endsWith("wikipedia.org")) return true; // 百科词条不是资讯
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

// ---------- 同题去重 ----------
// 多家媒体常报道同一条新闻(尤其英文媒体互相编译), 渲染时按标题相似度合并为一组,
// 主条目正常展示, 其余来源折叠成"其他来源"链接。数据文件保持原始条目不变。
// 分词前先归一化别名, 提升同题命中率(如 "战地风云6" 与 "战地6")
const TITLE_ALIASES = [
  [/战地风云/g, "战地"],
  ["over the hill", "越过山丘"],
];
const TITLE_STOPWORDS = /[的了在是和与对为就都而也或被把让使称]/g;
// 发售预告类标题的模板词("将于8月20日登陆/发售"), 不剥离的话两条无关新游预告
// 会因共享模板词被误并
const TITLE_BOILERPLATE = /[将于年月日号发售推出登陆定档官宣正确定]/g;
const EN_STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "will", "its", "it", "this", "that", "from", "at", "by", "as", "be", "your", "you"]);

function titleTokens(title) {
  let s = String(title || "").toLowerCase();
  for (const [re, to] of TITLE_ALIASES) s = s.replace(re, to);
  s = s.replace(/[《》「」『』【】\[\]()（）{}<>：:，,。.！!？?；;、·—~\-_|\\/"'“”‘’…\s]/g, "");
  s = s.replace(TITLE_STOPWORDS, "").replace(TITLE_BOILERPLATE, "");
  const tokens = new Set();
  for (const w of s.match(/[a-z0-9]+/g) || []) if (!EN_STOPWORDS.has(w)) tokens.add(w);
  for (const ch of s.replace(/[a-z0-9]/g, "")) tokens.add(ch); // 中文按单字, 对改写标题更宽容
  return tokens;
}

function isSameStory(a, b) {
  // 时间相距过远的不合并, 避免把几周后的跟进报道误并
  if (a.date && b.date && Math.abs(new Date(a.date) - new Date(b.date)) > 72 * 3600e3) return false;
  const A = titleTokens(a.titleZh || a.title);
  const B = titleTokens(b.titleZh || b.title);
  if (A.size < 5 || B.size < 5) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  // 占比与绝对数量同时达标: 短标题剥离模板词后剩不了几个 token, 防止个别巧合命中
  return inter >= 3 && inter / Math.min(A.size, B.size) >= 0.45;
}

// 输入需按时间降序; 代表条目优先选原文为中文的(可读性好于机翻)
function groupByStory(items) {
  const groups = [];
  for (const it of items) {
    let placed = false;
    for (const g of groups) {
      if (isSameStory(g[0], it)) { g.push(it); placed = true; break; }
    }
    if (!placed) groups.push([it]);
  }
  return groups.map((g) => {
    const zhIdx = g.findIndex((x) => !x.titleZh);
    const repIdx = zhIdx >= 0 ? zhIdx : 0;
    return { item: g[repIdx], others: g.filter((_, i) => i !== repIdx) };
  });
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
  // 单条资讯渲染: showTime 时附带厂商标签(用于"今日最新"混排); 服务端先按构建时间生成
  // 相对时间和 NEW 标记(无 JS 时的兜底), li 上的 data-time 供前端实时重算;
  // others 为同题合并时被折叠的其他来源
  const renderItem = (it, showTime, others) => {
    const seen = new Set();
    const altLinks = [];
    for (const o of others || []) {
      if (seen.has(o.source)) continue; // 同一来源的多条合并显示一次
      seen.add(o.source);
      altLinks.push(`<a href="${esc(o.link)}" target="_blank" rel="noopener">${esc(o.source)}</a>`);
    }
    return `
        <li class="news-item" data-time="${it.date || ""}">
          <a href="${esc(it.link)}" target="_blank" rel="noopener"${it.titleZh ? ` title="${esc(it.title)}"` : ""}>${esc(it.titleZh || it.title)}</a>${isNew(it) ? `<span class="new-badge">NEW</span>` : ""}
          <div class="meta">${it.date ? `<span class="time" title="${esc(fmtFull(it.date))}">${relTime(it.date)}</span>` : ""}<span class="source">${esc(it.source)}</span>${
            showTime ? it.companies.map((cid) => `<span class="tag">${esc(companyName[cid] || cid)}</span>`).join("") : ""
          }${altLinks.length ? `<span class="alt">其他来源: ${altLinks.join(" · ")}</span>` : ""}</div>
          ${it.summary || it.summaryZh ? `<p class="summary">${esc(it.summaryZh || it.summary)}</p>` : ""}
        </li>`;
  };

  // 今日最新默认只展示前 TODAY_VISIBLE 组, 其余折叠, 想看再点开; 同题多来源合并为一组
  const TODAY_VISIBLE = 10;
  const todayGroups = groupByStory(today);
  const todayHead = todayGroups.slice(0, TODAY_VISIBLE).map((g) => renderItem(g.item, true, g.others)).join("");
  const todayRest = todayGroups.slice(TODAY_VISIBLE);
  const todayList = todayGroups.length
    ? `<ul class="cards">${todayHead}</ul>` +
      (todayRest.length
        ? `<details class="more"><summary>展开其余 ${todayRest.length} 条</summary><ul class="cards">${todayRest.map((g) => renderItem(g.item, true, g.others)).join("")}</ul></details>`
        : "")
    : `<p class="empty">最近 48 小时暂无新资讯</p>`;
  const todaySection = `
      <section class="company today" id="today">
        <h2><span class="badge">★</span> 今日最新 <small>最近更新按时间混排</small></h2>
        ${todayList}
      </section>`;

  // 每家厂商默认展示前 VISIBLE_COUNT 组, 其余折叠, 避免页面过长; 分组结果同时供侧边导航计数
  const companyGroups = {};
  for (const c of COMPANIES) companyGroups[c.id] = groupByStory(byCompany[c.id]);
  const VISIBLE_COUNT = 5;
  const sections = COMPANIES.map((c, idx) => {
    const groups = companyGroups[c.id];
    const head = groups.slice(0, VISIBLE_COUNT).map((g) => renderItem(g.item, false, g.others)).join("");
    const rest = groups.slice(VISIBLE_COUNT);
    const list = groups.length
      ? `<ul class="cards">${head}</ul>` +
        (rest.length
          ? `<details class="more"><summary>展开其余 ${rest.length} 条</summary><ul class="cards">${rest.map((g) => renderItem(g.item, false, g.others)).join("")}</ul></details>`
          : "")
      : `<p class="empty">暂无可匹配的资讯</p>`;
    return `
      <section class="company" id="${c.id}">
        <h2><span class="badge">${String(idx + 1).padStart(2, "0")}</span> ${esc(c.name)} <small>${esc(c.en)} · ${groups.length} 条</small></h2>
        ${list}
      </section>`;
  }).join("\n");

  // 桌面宽屏下 nav 渲染为侧边栏, 各链接附带条数角标(小屏由 CSS 隐藏)
  const nav = `<a href="#today">今日最新<span class="count">${todayGroups.length}</span></a>` +
    COMPANIES.map((c) => `<a href="#${c.id}">${esc(c.name)}<span class="count">${companyGroups[c.id].length}</span></a>`).join("") +
    `<input class="search" id="q" type="search" placeholder="搜索资讯…" aria-label="搜索资讯">`;
  const updatedAt = data.updatedAt
    ? new Date(data.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    : "从未更新";

  // 动态内容注入 template.html 骨架; 函数式替换避免替换串中的 $& 等被解释
  return fs
    .readFileSync(TEMPLATE_FILE, "utf8")
    .replace("__UPDATED_ISO__", () => data.updatedAt || "")
    .replace("__UPDATED_TEXT__", () => updatedAt)
    .replace("__KEEP_DAYS__", () => String(KEEP_DAYS))
    .replace("__NAV__", () => nav)
    .replace("__MAIN__", () => todaySection + "\n" + sections);
}

// ---------- 生成 RSS ----------
// 输出最新 60 条供阅读器订阅; 与 index.html 同步更新
function renderRss(data) {
  const escXml = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const companyName = Object.fromEntries(COMPANIES.map((c) => [c.id, c.name]));
  const items = data.items
    .filter((it) => it.date)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 60)
    .map((it) => {
      const desc = [it.summaryZh || it.summary, `来源: ${it.source}`, `厂商: ${it.companies.map((cid) => companyName[cid] || cid).join(", ")}`]
        .filter(Boolean)
        .join(" | ");
      return `    <item>
      <title>${escXml(it.titleZh || it.title)}</title>
      <link>${escXml(it.link)}</link>
      <guid isPermaLink="false">${escXml(it.link)}</guid>
      <pubDate>${new Date(it.date).toUTCString()}</pubDate>
      <description>${escXml(desc)}</description>
    </item>`;
    })
    .join("\n");
  const lastBuild = data.updatedAt ? new Date(data.updatedAt).toUTCString() : new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>每日游戏资讯 · 十大厂商</title>
    <link>${SITE_URL}/</link>
    <description>腾讯、网易、米哈游、任天堂、索尼、微软、暴雪、EA、育碧、Valve 最新动态, 每天自动更新</description>
    <language>zh-CN</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
${items}
  </channel>
</rss>
`;
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
  fs.writeFileSync(FEED_FILE, renderRss(data), "utf8");

  console.log(`新增 ${added} 条, 现有共 ${all.length} 条`);
  console.log(`已生成 ${HTML_FILE} 和 ${FEED_FILE}`);
}

main().catch((e) => {
  console.error("运行失败:", e);
  process.exit(1);
});

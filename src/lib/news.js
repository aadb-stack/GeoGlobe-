// Recent-news helpers.
//
// Live headlines are pulled from the public Google News RSS feed. Browsers
// can't read that feed cross-origin, so we route through a couple of free,
// no-key CORS proxies and fall back gracefully. When every network attempt
// fails (offline, proxy down, etc.) the UI still shows curated "open in a new
// tab" source links so the feature is never a dead end.

const PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];

function googleNewsRss(country) {
  const q = encodeURIComponent(`${country} (politics OR geopolitics OR economy OR government)`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

// Direct, always-available source links for a country.
export function sourceLinks(country) {
  const q = encodeURIComponent(country);
  return [
    { label: 'Google News', url: `https://news.google.com/search?q=${q}&hl=en-US` },
    { label: 'Reuters', url: `https://www.reuters.com/site-search/?query=${q}` },
    { label: 'BBC', url: `https://www.bbc.co.uk/search?q=${q}` },
    { label: 'Al Jazeera', url: `https://www.aljazeera.com/search/${q}` },
    { label: 'Wikipedia', url: `https://en.wikipedia.org/wiki/${q.replace(/%20/g, '_')}` },
  ];
}

function parseRss(xmlText, limit = 6) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return [];
  const items = [...doc.querySelectorAll('item')].slice(0, limit);
  return items.map((item) => {
    const title = item.querySelector('title')?.textContent?.trim() || 'Untitled';
    const link = item.querySelector('link')?.textContent?.trim() || '#';
    const pubDate = item.querySelector('pubDate')?.textContent?.trim() || '';
    // Google News titles look like "Headline - Source"; split out the source.
    const split = title.lastIndexOf(' - ');
    const headline = split > 0 ? title.slice(0, split) : title;
    const source = split > 0 ? title.slice(split + 3) : '';
    return { headline, source, link, pubDate };
  });
}

// Fetch up to `limit` recent headlines for a country. Resolves to an array
// (possibly empty). Never rejects.
export async function fetchHeadlines(country, { limit = 6, signal } = {}) {
  const rssUrl = googleNewsRss(country);
  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy(rssUrl), { signal });
      if (!res.ok) continue;
      const text = await res.text();
      const items = parseRss(text, limit);
      if (items.length) return items;
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // try next proxy
    }
  }
  return [];
}

export function timeAgo(pubDate) {
  if (!pubDate) return '';
  const then = new Date(pubDate).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

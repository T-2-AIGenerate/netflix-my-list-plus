(() => {
  "use strict";
  if (window.__nmlpLoaded) return;
  window.__nmlpLoaded = true;

  const STORE_KEY = "nmlp_items_v1";
  const TITLES_STORE_KEY = "nmlp_collected_titles_v1";
  const SETTINGS_STORE_KEY = "nmlp_settings_v1";
  const HIDDEN_TAG = "非表示";
  const BUILTIN_TAGS = new Set(["あとで見る", "お気に入り", HIDDEN_TAG]);
  const PANEL_ID = "nmlp-panel";
  let items = {};
  let panelOpen = false;
  let scanTimer = null;
  let panelObserver = null;
  const metadataObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const target = entry.target;
      metadataObserver.unobserve(target);
      if (target.__nmlpItem && target.__nmlpData) {
        ensureMetadata(target.__nmlpItem, target.__nmlpData, target);
      }
    }
  }, { rootMargin: "250px 0px" });
  let allTitles = new Map();
  let isBulkScanning = false;
  let settings = { titleLimit: 48, posterSize: 150, ratingMode: "half", showTotalSeasons: true };

  const clean = (v) => (v || "").replace(/\s+/g, " ").trim();
  function formatMetadataForDisplay(value) {
    let text = clean(value);
    if (!settings.showTotalSeasons) {
      text = text
        .replace(/(?:全)?\d+\s*シーズン(?:数)?\s*[・·|｜,、:：—–-]?\s*/gi, "")
        .replace(/\s*[・·|｜,、:：—–-]\s*/g, " ・ ")
        .replace(/^(?:\s*・\s*)+|(?:\s*・\s*)+$/g, "")
        .trim();
    }
    return text;
  }
  function runtimeMinutesFromMetadata(value) {
    const text = clean(value);
    const match = text.match(/上映時間\s*(?:(\d+)\s*時間)?\s*(?:(\d+)\s*分)?/);
    if (!match || (!match[1] && !match[2])) return null;
    return Number(match[1] || 0) * 60 + Number(match[2] || 0);
  }
  function notifyMetadataUpdated() {
    document.dispatchEvent(new Event("nmlp-metadata-updated"));
  }
  const titleFromNode = (node) => {
    if (!node) return "";
    const attrs = [
      node.getAttribute?.("aria-label"),
      node.getAttribute?.("title"),
      node.getAttribute?.("data-title"),
      node.getAttribute?.("alt")
    ];
    for (const a of attrs) {
      const t = clean(a);
      if (t && !/^(play|more info|再生|詳細情報|その他の情報)$/i.test(t)) return t;
    }
    return "";
  };
  const keyFor = (href, title) => {
    try {
      const u = new URL(href, location.origin);
      const m = u.pathname.match(/\/(?:watch|title)\/(\d+)/);
      if (m) return `id:${m[1]}`;
      return `url:${u.pathname}|${title.toLowerCase()}`;
    } catch { return `title:${title.toLowerCase()}`; }
  };

  // Receive candidate titles extracted from Netflix's own My List GraphQL responses.
  // The observer runs in MAIN world; this content script validates the message and
  // stores only normalized title records in chrome.storage.local.
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== "NMLP_NET_OBSERVER" || !/my.?list/i.test(String(message.operationName || ""))) return;
    if (!/\/browse\/my-list(?:\/|$)/i.test(location.pathname)) return;
    const incoming = [];
    const visited = new Set();
    const walk = (value, depth = 0) => {
      if (!value || typeof value !== "object" || depth > 18 || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        for (const child of value) walk(child, depth + 1);
        return;
      }
      const type = String(value.__typename || value.type || "");
      const id = value.videoId ?? value.id;
      const title = clean(value.title || value.displayName || value.name || "");
      const isTitleEntity = /^(Movie|Show|Series|Video|UnifiedEntity|Title)$/i.test(type);
      if (isTitleEntity && id != null && title && title.length < 180 && /^\d+$/.test(String(id))) {
        const videoId = String(id);
        const href = `https://www.netflix.com/browse?jbv=${encodeURIComponent(videoId)}`;
        const key = `id:${videoId}`;
        const artwork = value.boxarts?.[0]?.url || value.boxart?.url || value.artwork?.url || value.image?.url || "";
        incoming.push({ key, title, href, image: typeof artwork === "string" && /^https:\/\//i.test(artwork) ? artwork : "" });
      }
      for (const [key, child] of Object.entries(value)) {
        // Avoid descending into large image/text evidence blobs; title records are elsewhere.
        if (/imageEvidence|textEvidence|trackingInfo|impression/i.test(key)) continue;
        walk(child, depth + 1);
      }
    };
    walk(message.payload);
    if (!incoming.length) return;
    let changed = false;
    for (const item of incoming) {
      if (!allTitles.has(item.key) || JSON.stringify(allTitles.get(item.key)) !== JSON.stringify(item)) {
        allTitles.set(item.key, item);
        changed = true;
      }
      if (!items[item.key]) items[item.key] = { tags: [], status: "unseen", rating: 0, memo: "" };
    }
    if (changed) {
      saveTitles();
      saveItems();
      document.dispatchEvent(new Event("nmlp-auto-collection-updated"));
      const status = document.querySelector("#nmlp-panel .nmlp-bulk-status");
      if (status) status.textContent = `Netflixの通信から自動取得：${allTitles.size}作品`;
      if (panelOpen && document.getElementById(PANEL_ID)) {
        // Let the existing panel render cycle pick up the newly collected items.
        document.dispatchEvent(new Event("nmlp-metadata-updated"));
      }
    }
  });

  async function loadItems() {
    try {
      const result = await chrome.storage.local.get([STORE_KEY, TITLES_STORE_KEY, SETTINGS_STORE_KEY]);
      items = result[STORE_KEY] || {};
      settings = { ...settings, ...(result[SETTINGS_STORE_KEY] || {}) };
      const savedTitles = result[TITLES_STORE_KEY];
      if (Array.isArray(savedTitles)) {
        for (const item of savedTitles) {
          if (item && item.key && item.title && item.href) allTitles.set(item.key, { ...item, image: item.image || "" });
        }
      }
    } catch { items = {}; }
  }
  let titleSaveTimer = null;
  async function saveTitles() {
    clearTimeout(titleSaveTimer);
    titleSaveTimer = setTimeout(async () => {
      try {
        await chrome.storage.local.set({ [TITLES_STORE_KEY]: [...allTitles.values()] });
      } catch (e) {
        console.warn("Netflix マイリスト＋: 作品一覧を保存できませんでした", e);
      }
    }, 250);
  }
  async function saveItems() {
    try { await chrome.storage.local.set({ [STORE_KEY]: items }); } catch {}
  }
  async function saveSettings() {
    try { await chrome.storage.local.set({ [SETTINGS_STORE_KEY]: settings }); } catch {}
  }

  function extractTitle(anchor, img) {
    const direct = [
      titleFromNode(anchor),
      titleFromNode(img),
      titleFromNode(anchor.querySelector("[aria-label], [title], [data-title]")),
      titleFromNode(anchor.parentElement),
      titleFromNode(anchor.parentElement?.parentElement)
    ].find(Boolean);
    if (direct) return direct;

    // Netflix often exposes the title in a nearby card label rather than on the link/image.
    let node = anchor;
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      const label = node.querySelector?.('[data-uia*="title"], [class*="fallback-text"], [class*="title-card"], [class*="titleLabel"]');
      const text = clean(label?.textContent);
      if (text && text.length < 180 && !/^(再生|詳細情報|マイリスト|削除)$/i.test(text)) return text;
    }
    // Fall back to short visible text in the link/card; remove common action labels.
    const raw = clean(anchor.innerText || anchor.textContent ||
      anchor.parentElement?.innerText || anchor.parentElement?.textContent);
    const parts = raw.split(/\n+/).map(clean).filter(t =>
      t && t.length < 120 && !/^(再生|詳細情報|マイリスト|削除|予告編|エピソード)$/i.test(t)
    );
    if (parts.length) return parts[0];
    return "";
  }

  function findTitles(root = document) {
    const found = new Map();
    const anchors = [...root.querySelectorAll(
      'a[href*="/watch/"], a[href*="/title/"], a[href*="/browse?jbv="]'
    )];
    for (const a of anchors) {
      let url;
      try { url = new URL(a.href, location.origin); } catch { continue; }
      if (url.hostname !== "www.netflix.com" && url.hostname !== "netflix.com") continue;

      const img = a.querySelector("img") || a.closest("a")?.querySelector("img");
      // Netflix may lazy-load images or render artwork as a CSS background.
      let card = a;
      for (let i = 0; i < 6 && card && !card.querySelector?.("img") &&
           !card.querySelector?.('[style*="background-image"]'); i++) card = card.parentElement;
      const cardImg = img || card?.querySelector?.("img");
      const imageNode = cardImg || card?.querySelector?.('[style*="background-image"]');
      const image = cardImg
        ? (cardImg.currentSrc || cardImg.getAttribute("src") ||
           cardImg.getAttribute("data-src") || cardImg.getAttribute("data-original") ||
           cardImg.getAttribute("srcset")?.split(",")[0]?.trim().split(/\\s+/)[0] || "")
        : (imageNode ? (
            imageNode.getAttribute("data-image") ||
            (imageNode.getAttribute("style") || "").match(/background-image\\s*:\\s*url\\(["']?(.*?)["']?\\)/i)?.[1] || ""
          ) : "");

      let title = extractTitle(a, cardImg);
      // Do not treat Netflix's generic player/action labels as a real title.
      if (!title || /^(Netflixで作品を開く|再生|詳細情報|マイリスト|削除)$/i.test(title)) {
        // Try nearby card labels before falling back to the poster's alt text.
        let card = a;
        for (let i = 0; i < 6 && card; i++, card = card.parentElement) {
          const candidates = [
            ...card.querySelectorAll('[aria-label], [title], [data-title], [alt], [data-uia*="title"]')
          ];
          const candidate = candidates.map(n =>
            clean(n.getAttribute("aria-label") || n.getAttribute("title") ||
                  n.getAttribute("data-title") || n.getAttribute("alt") || n.textContent)
          ).find(t => t && t.length < 180 &&
            !/^(Netflixで作品を開く|再生|詳細情報|マイリスト|削除)$/i.test(t));
          if (candidate) { title = candidate; break; }
        }
      }
      if (!title || /^(Netflixで作品を開く|再生|詳細情報|マイリスト|削除)$/i.test(title)) {
        // Keep the poster visible without using a misleading generic label.
        const id = url.pathname.match(/\/(?:watch|title)\/(\d+)/)?.[1];
        title = id ? `タイトル名未取得（ID: ${id}）` : "タイトル名未取得";
      }
      const key = keyFor(a.href, title);
      if (!found.has(key)) found.set(key, { key, title, href: a.href, image });
    }
    return [...found.values()];
  }

  const metadataInFlight = new Set();
  const metadataAttempted = new Set();

  function extractRuntimeMetadata(source) {
    // Netflix may serialize embedded page data with JavaScript Unicode escapes
    // (for example \u003A or \u0022). Decode those before searching for metadata.
    // Keep the original source as a fallback because not every backslash sequence
    // in a page is a Unicode escape.
    const decodedSource = String(source).replace(/\\u([0-9a-f]{4})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    source = decodedSource;
    const snippets = [];
    const addRuntime = mins => {
      if (!Number.isFinite(mins) || mins <= 0 || mins > 1000) return;
      const label = mins >= 60
        ? `${Math.floor(mins / 60)}時間${mins % 60 ? ` ${mins % 60}分` : ""}`
        : `${mins}分`;
      const value = `上映時間 ${label}`;
      if (!snippets.includes(value)) snippets.push(value);
    };

    // ISO-8601 duration (JSON-LD and some embedded metadata).
    for (const m of source.matchAll(/"(?:duration|runtime|videoRuntime)"\s*:\s*"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"/gi)) {
      addRuntime(Number(m[1] || 0) * 60 + Number(m[2] || 0) + Math.round(Number(m[3] || 0) / 60));
    }
    // Numeric runtime values are ambiguous; accept only explicit runtime keys and plausible units.
    for (const m of source.matchAll(/"(?:runtimeMinutes|durationMinutes|runtimeInMinutes)"\s*:\s*(\d{1,4})/gi)) addRuntime(Number(m[1]));
    for (const m of source.matchAll(/"(?:runtimeSeconds|durationSeconds|videoRuntime)"\s*:\s*(\d{2,6})/gi)) addRuntime(Math.round(Number(m[1]) / 60));
    for (const m of source.matchAll(/"(?:runtime|duration)"\s*:\s*(\d{2,4})(?=\s*[,}])/gi)) {
      const n = Number(m[1]);
      // A value under 1000 is more likely minutes; very large values are likely seconds.
      if (n >= 15 && n <= 600) addRuntime(n);
      else if (n > 600 && n <= 36000) addRuntime(Math.round(n / 60));
    }
    // Human-readable duration labels in Japanese or English.
    for (const m of source.matchAll(/(?:上映時間|再生時間|runtime|duration)[^<>"']{0,35}?(\d{1,2})\s*(?:時間|hours?|hrs?)\s*(?:(\d{1,2})\s*(?:分|minutes?|mins?))?/gi)) {
      addRuntime(Number(m[1]) * 60 + Number(m[2] || 0));
    }
    for (const m of source.matchAll(/(?:上映時間|再生時間|runtime|duration)[^<>"']{0,35}?(\d{1,3})\s*(?:分|minutes?|mins?)/gi)) {
      addRuntime(Number(m[1]));
    }
    // Season/episode counts may be serialized with different key names.
    const seasonCounts = [];
    const episodeCounts = [];
    for (const m of source.matchAll(/"(?:seasonCount|seasonsCount|season_count|numberOfSeasons|seasonTotal)"\s*:\s*"?(\d{1,3})"?/gi)) seasonCounts.push(Number(m[1]));
    for (const m of source.matchAll(/"(?:episodeCount|episodesCount|episode_count|numberOfEpisodes|episodeTotal)"\s*:\s*"?(\d{1,4})"?/gi)) episodeCounts.push(Number(m[1]));
    // Localized labels sometimes appear in the HTML or embedded JSON.
    for (const m of source.matchAll(/(?:^|[>"'\s])(\d{1,2})\s*(?:シーズン|シーズン数|seasons?)(?=$|[<"'.,\s])/gi)) seasonCounts.push(Number(m[1]));
    for (const m of source.matchAll(/(?:全\s*)?(\d{1,4})\s*(?:話|エピソード|episodes?)(?=$|[<"'.,\s])/gi)) episodeCounts.push(Number(m[1]));
    const seasons = seasonCounts.find(n => n > 0 && n < 100);
    const episodes = episodeCounts.find(n => n > 0 && n < 10000);
    if (seasons) snippets.push(`${seasons}シーズン`);
    if (episodes) snippets.push(`${episodes}話`);

    return snippets.length ? [...new Set(snippets)].join(" ・ ") : "";
  }

  async function fetchGraphQLMetadata(item) {
    const videoId = String(item.href || '').match(/(?:[?&]jbv=|\/(?:watch|title)\/)(\d+)/)?.[1];
    if (!videoId) return '';
    const payload = {
      operationName: 'DetailModal',
      variables: {
        loceEnabled: false,
        playbackRedirectEnabled: false,
        opaqueImageFormat: 'WEBP',
        transparentImageFormat: 'WEBP',
        videoMerchEnabled: false,
        fetchPromoVideoOverride: false,
        hasPromoVideoOverride: false,
        promoVideoId: 0,
        videoMerchContext: 'BROWSE',
        isLiveEpisodic: false,
        includeCroppedLogo: false,
        artworkContext: {},
        textEvidenceUiContext: 'ODP',
        unifiedEntityId: `Video:${videoId}`,
        videoId: Number(videoId),
        checkLinearChannel: true
      },
      extensions: { persistedQuery: { id: '9f5a2a20-f9d6-4dac-8b8f-6a27b675efcb', version: 102 } }
    };
    const response = await fetch('/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Netflix GraphQL unavailable (HTTP ${response.status})`);
    const json = await response.json();
    const entities = json?.data?.unifiedEntities;
    const entity = Array.isArray(entities) ? entities[0] : null;
    if (!entity) return '';
    const parts = [];
    const runtimeSec = Number(entity.displayRuntimeSec || entity.runtimeSec || entity.currentEpisode?.runtimeSec || 0);
    if (entity.__typename === 'Movie' && runtimeSec > 0) {
      const mins = Math.floor(runtimeSec / 60);
      const label = mins >= 60
        ? `${Math.floor(mins / 60)}時間${mins % 60 ? ` ${mins % 60}分` : ''}`
        : `${mins}分`;
      parts.push(`上映時間 ${label}`);
    }
    const seasonCount = Number(entity.seasons?.totalCount || entity.numSeasons || 0);
    const episodeCount = Number(entity.currentEpisode?.parentSeason?.episodes?.totalCount || 0);
    if (seasonCount > 0) parts.push(`${seasonCount}シーズン`);
    if (episodeCount > 0) parts.push(`シーズン${Number(entity.currentEpisode?.parentSeason?.number || 1)} 全${episodeCount}話`);
    return [...new Set(parts)].join(' ・ ');
  }

  async function ensureMetadata(item, data, target) {
    const unavailableLabels = ["上映時間・話数の情報なし", "上映時間・話数の取得不可"];
    if (data.runtimeInfo && !unavailableLabels.includes(data.runtimeInfo)) {
      target.textContent = formatMetadataForDisplay(data.runtimeInfo);
      return;
    }
    if (metadataInFlight.has(item.key) || metadataAttempted.has(item.key)) {
      if (!data.runtimeInfo || unavailableLabels.includes(data.runtimeInfo)) {
        target.textContent = "上映時間・話数を確認できません";
      }
      return;
    }
    metadataInFlight.add(item.key);
    metadataAttempted.add(item.key);
    target.textContent = "上映時間・話数を確認中…";
    try {
      console.info("[NMLP metadata] Request", { title: item.title, href: item.href });
      let extracted = '';
      try {
        extracted = await fetchGraphQLMetadata(item);
        console.info("[NMLP metadata] GraphQL extraction result", { title: item.title, extracted: extracted || null });
      } catch (graphqlError) {
        console.warn("[NMLP metadata] GraphQL request failed; falling back to title HTML", String(graphqlError));
      }
      if (extracted) {
        data.runtimeInfo = extracted;
        await saveItems();
        notifyMetadataUpdated();
        if (target.isConnected) target.textContent = formatMetadataForDisplay(extracted);
        return;
      }
      const response = await fetch(item.href, { credentials: "include" });
      console.info("[NMLP metadata] Response", { status: response.status, ok: response.ok, url: response.url, contentType: response.headers.get("content-type") });
      if (!response.ok) throw new Error(`title page unavailable (HTTP ${response.status})`);
      const html = await response.text();
      console.info("[NMLP metadata] HTML diagnostic", {
        length: html.length,
        hasRuntime: /runtime/i.test(html),
        hasDuration: /duration/i.test(html),
        hasEpisodeCount: /episodeCount|numberOfEpisodes|episodes?/i.test(html),
        hasJsonLd: /application\/ld\+json/i.test(html),
        preview: html.slice(0, 180).replace(/\s+/g, " ")
      });
      extracted = extractRuntimeMetadata(html);
      console.info("[NMLP metadata] Extraction result", { title: item.title, extracted: extracted || null });
      if (!extracted) {
        // Emit short, bounded context snippets around likely metadata keys for diagnosis.
        const decodedForDiagnostics = html.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        const terms = /runtimeMinutes|durationMinutes|runtimeInMinutes|runtimeSeconds|durationSeconds|videoRuntime|episodeCount|numberOfEpisodes|seasonCount|numberOfSeasons|duration|runtime/gi;
        const snippets = [];
        let match;
        while ((match = terms.exec(decodedForDiagnostics)) && snippets.length < 12) {
          const start = Math.max(0, match.index - 100);
          const end = Math.min(decodedForDiagnostics.length, match.index + match[0].length + 180);
          const snippet = decodedForDiagnostics.slice(start, end).replace(/\s+/g, " ");
          if (!snippets.includes(snippet)) snippets.push(snippet);
        }
        console.info("[NMLP metadata] Candidate snippets", { title: item.title, snippets });
        console.info("[NMLP metadata] JSON-LD blocks", { count: [...html.matchAll(/<script[^>]+type=[\"']application\/ld\+json[\"'][^>]*>/gi)].length });
      }

      // Try parsing structured data blocks separately; malformed JSON is ignored.
      if (!extracted) {
        const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
        for (const block of blocks) {
          try {
            const parsed = JSON.parse(block[1]);
            extracted = extractRuntimeMetadata(JSON.stringify(parsed));
            if (extracted) break;
          } catch {}
        }
      }

      if (extracted) {
        data.runtimeInfo = extracted;
        await saveItems();
        notifyMetadataUpdated();
        if (target.isConnected) target.textContent = formatMetadataForDisplay(extracted);
      } else {
        // Do not persist a failed lookup permanently; a future page version or retry can succeed.
        delete data.runtimeInfo;
        if (target.isConnected) target.textContent = "上映時間・話数を確認できません";
      }
    } catch (error) {
      console.error("[NMLP metadata] Error", { title: item.title, href: item.href, message: String(error), stack: error?.stack || "" });
      delete data.runtimeInfo;
      if (target.isConnected) target.textContent = "上映時間・話数を取得できません";
    } finally {
      metadataInFlight.delete(item.key);
    }
  }

  function findMyListCarousel() {
    const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .filter(node => clean(node.textContent) === "マイリスト");
    const heading = headings.find(node => {
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) || headings[0];
    if (!heading) return null;

    let best = null;
    let node = heading;
    for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
      const anchors = [...node.querySelectorAll('a[href*="/watch/"],a[href*="/title/"],a[href*="/browse?jbv="]')]
        .filter(a => {
          const u = new URL(a.href, location.origin);
          return u.hostname === "www.netflix.com" || u.hostname === "netflix.com";
        });
      const buttons = [...node.querySelectorAll("button,[role='button']")].filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (anchors.length >= 2 && buttons.length) {
        best = { root: node, anchors, buttons };
        // Prefer the closest ancestor that contains both poster cards and controls.
        break;
      }
    }
    if (!best) return null;

    const candidates = best.buttons.map(button => {
      const label = clean([
        button.getAttribute("aria-label"), button.getAttribute("title"),
        button.getAttribute("data-uia"), button.innerText, button.textContent
      ].filter(Boolean).join(" ")).toLowerCase();
      const r = button.getBoundingClientRect();
      return { button, label, rect: r };
    });
    let next = candidates.find(x => /next|right|次へ|次の|右|次ページ/.test(x.label))?.button;
    if (!next) {
      // Netflix sometimes uses an unlabeled chevron. Choose the rightmost visible
      // button aligned with the poster row, not controls above/below it.
      const headingRect = heading.getBoundingClientRect();
      const posterRects = best.anchors.map(a => a.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
      const yMin = posterRects.length ? Math.min(...posterRects.map(r => r.top)) - 20 : headingRect.bottom;
      const yMax = posterRects.length ? Math.max(...posterRects.map(r => r.bottom)) + 20 : yMin + 400;
      next = candidates.filter(x => x.rect.left > window.innerWidth * 0.55 &&
          x.rect.top < yMax && x.rect.bottom > yMin)
        .sort((a,b) => b.rect.left - a.rect.left)[0]?.button;
    }
    return next ? { root: best.root, next } : null;
  }

  function carouselSignature(carousel) {
    if (!carousel) return "";
    const anchors = [...carousel.root.querySelectorAll('a[href*="/watch/"],a[href*="/title/"],a[href*="/browse?jbv="]')]
      .filter(a => {
        const r = a.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    return anchors.map(a => {
      try {
        const u = new URL(a.href, location.origin);
        const id = u.pathname.match(/\/(?:watch|title)\/(\d+)/)?.[1];
        return id || u.pathname + u.search;
      } catch { return a.href; }
    }).join("|");
  }

  function isMyListPage() {
    return location.hostname === "www.netflix.com" && /^\/browse\/my-list\/?$/.test(location.pathname);
  }

  function ensureLauncher() {
    // The launcher and panel are available only on Netflix's dedicated My List route.
    if (!isMyListPage()) {
      document.getElementById("nmlp-launcher")?.remove();
      document.getElementById(PANEL_ID)?.remove();
      panelOpen = false;
      panelObserver?.disconnect();
      return;
    }
    if (document.getElementById("nmlp-launcher")) return;
    const btn = document.createElement("button");
    btn.id = "nmlp-launcher";
    btn.type = "button";
    btn.textContent = "マイリスト＋";
    btn.title = "マイリスト＋を開く";
    btn.addEventListener("click", () => {
      if (!isMyListPage()) { ensureLauncher(); return; }
      panelOpen = !panelOpen;
      if (panelOpen) renderPanel();
      else {
        document.getElementById(PANEL_ID)?.remove();
        panelObserver?.disconnect();
      }
    });
    document.documentElement.appendChild(btn);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderPanel() {
    document.getElementById(PANEL_ID)?.remove();
    panelObserver?.disconnect();

    const panel = el("section", "");
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "Netflix マイリスト Plus");

    const head = el("div", "nmlp-head");
    const title = el("div", "nmlp-heading", "Netflix マイリスト＋");
    const headActions = el("div", "nmlp-head-actions");
    const collapseBtn = el("button", "nmlp-collapse", "設定を折りたたむ");
    collapseBtn.type = "button";
    collapseBtn.setAttribute("aria-expanded", "true");
    const close = el("button", "nmlp-close", "×");
    close.setAttribute("aria-label", "閉じる");
    close.onclick = () => {
      panelOpen = false;
      panel.remove();
      panelObserver?.disconnect();
    };
    collapseBtn.onclick = () => {
      const collapsed = toolbar.hidden;
      toolbar.hidden = !collapsed;
      collapseBtn.textContent = collapsed ? "設定を折りたたむ" : "設定を展開する";
      collapseBtn.setAttribute("aria-expanded", String(collapsed));
    };
    head.append(title, headActions);

    const toolbar = el("div", "nmlp-toolbar");
    const note = el("p", "nmlp-note",
      "Netflixのマイリスト通信から自動取得を試みます。取得できない作品は、下のボタンで補完できます。");
    const bulkRow = el("div", "nmlp-bulk-row");
    const bulkScan = el("button", "nmlp-action", "マイリスト全体を読み込む");
    const bulkStatus = el("span", "nmlp-bulk-status", `自動取得待機中：${allTitles.size}作品`);
    bulkRow.append(bulkScan, bulkStatus);

    const search = el("input", "nmlp-search");
    search.type = "search";
    search.placeholder = "作品名を検索…";
    search.setAttribute("aria-label", "作品名を検索");

    const controls = el("div", "nmlp-controls");
    const category = el("select", "nmlp-select");
    category.setAttribute("aria-label", "表示する作品");
    [["all","すべて"],["later","あとで見る"],["favorite","お気に入り"],["unseen","未視聴"],["watching","視聴中"],["watched","視聴済み"]]
      .forEach(([v,t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; category.appendChild(o); });
    const sort = el("select", "nmlp-select");
    sort.setAttribute("aria-label", "並べ替え");
    [["page","Netflixの表示順"],["title","タイトル順（あ→ん）"],["runtime-asc","上映時間が短い順"],["runtime-desc","上映時間が長い順"],["custom","自分の順番"]].forEach(([v,t]) => {
      const o = document.createElement("option"); o.value = v; o.textContent = t; sort.appendChild(o);
    });
    controls.append(category, sort);

    const sizeRow = el("div", "nmlp-size-row");
    const sizeLabel = el("label", "", "ポスターサイズ");
    const size = el("input", "");
    size.type = "range"; size.min = "100"; size.max = "220"; size.value = String(settings.posterSize || 150);
    sizeLabel.appendChild(size);
    sizeRow.appendChild(sizeLabel);

    const titleLimitRow = el("div", "nmlp-title-limit-row");
    const titleLimitLabel = el("label", "", "タイトル表示文字数");
    const titleLimit = el("input", "nmlp-title-limit");
    titleLimit.type = "number"; titleLimit.min = "8"; titleLimit.max = "200";
    titleLimit.value = String(settings.titleLimit || 48);
    titleLimitLabel.append(titleLimit, el("span", "", "文字（0で省略なし）"));
    titleLimitRow.appendChild(titleLimitLabel);

    const ratingModeRow = el("div", "nmlp-rating-mode-row");
    const ratingModeLabel = el("label", "", "評価方式");
    const ratingMode = el("select", "nmlp-select nmlp-rating-mode");
    [["half", "5.0段階（0.5刻み）"], ["whole", "5段階（整数）"]].forEach(([v,t]) => { const o=document.createElement("option"); o.value=v; o.textContent=t; ratingMode.appendChild(o); });
    ratingMode.value = settings.ratingMode || "half";
    ratingModeLabel.appendChild(ratingMode); ratingModeRow.appendChild(ratingModeLabel);

    const seasonDisplayRow = el("div", "nmlp-season-display-row");
    const showTotalSeasons = el("input", "nmlp-show-total-seasons");
    showTotalSeasons.type = "checkbox";
    showTotalSeasons.checked = settings.showTotalSeasons !== false;
    const showTotalSeasonsLabel = el("label", "", "全シーズン数を表示");
    showTotalSeasonsLabel.prepend(showTotalSeasons);
    seasonDisplayRow.appendChild(showTotalSeasonsLabel);

    // One bulk-action dropdown combines watch status changes and hiding selected titles.
    const bulkStatusRow = el("div", "nmlp-bulk-status-row");
    const bulkStatusLabel = el("label", "nmlp-bulk-status-label", "選択作品の状態");
    const bulkStatusSelect = el("select", "nmlp-select nmlp-bulk-status-select");
    [["unseen","未視聴にする"],["watching","視聴中にする"],["watched","視聴済みにする"],["hidden","非表示にする"]].forEach(([v,t]) => {
      const o = document.createElement("option"); o.value = v; o.textContent = t; bulkStatusSelect.appendChild(o);
    });
    const applyBulkStatus = el("button", "nmlp-action", "選択作品に適用");
    bulkStatusLabel.appendChild(bulkStatusSelect);
    bulkStatusRow.append(bulkStatusLabel, applyBulkStatus);

    const addRow = el("div", "nmlp-add-row");
    const customCat = el("input", "nmlp-custom-input");
    customCat.placeholder = "選択した作品にタグを追加…（複数選択可）";
    const addBtn = el("button", "nmlp-action", "タグ追加");
    addRow.append(customCat, addBtn);

    const tagManageRow = el("div", "nmlp-tag-manage-row");
    const deleteTagBtn = el("button", "nmlp-action", "選択中の自作タグを削除");
    const selectionInfo = el("span", "nmlp-selection-info", "選択：0作品");
    tagManageRow.append(deleteTagBtn, selectionInfo);

    const help = el("div", "nmlp-help", "カードの「選択」を押して複数作品を選べます。タグ追加・非表示は選択中の作品すべてに適用されます。非表示作品は「非表示」フィルターから確認・再表示できます。");
    // Compact the four frequently used settings into one horizontal row.
    const compactSettingsRow = el("div", "nmlp-compact-settings-row");
    compactSettingsRow.append(bulkStatusRow, titleLimitRow, ratingModeRow, seasonDisplayRow);

    toolbar.append(note, bulkRow, controls, compactSettingsRow, addRow, tagManageRow, help);
    // Keep exactly one search field and the poster-size control in the header, even when settings are collapsed.
    search.classList.add("nmlp-header-search");
    sizeRow.classList.add("nmlp-header-size");
    headActions.append(search, sizeRow, collapseBtn, close);
    const count = el("div", "nmlp-count", "作品を確認中…");
    const grid = el("div", "nmlp-grid");
    panel.append(head, toolbar, count, grid);
    document.documentElement.appendChild(panel);

    let current = [];
    const selectedKeys = new Set();
    const shortenTitle = title => {
      const limit = Number(settings.titleLimit) || 0;
      if (limit <= 0 || [...title].length <= limit) return title;
      return [...title].slice(0, Math.max(1, limit - 1)).join("") + "…";
    };
    const refreshTagOptions = () => {
      const previous = category.value;
      const base = [["all","すべて"],["later","あとで見る"],["favorite","お気に入り"],["hidden",HIDDEN_TAG],["unseen","未視聴"],["watching","視聴中"],["watched","視聴済み"]];
      const customTags = [...new Set(Object.values(items).flatMap(d => d.tags || []).filter(t => t && !BUILTIN_TAGS.has(t)))].sort((a,b) => a.localeCompare(b,"ja"));
      category.replaceChildren();
      for (const [v,t] of base) { const o=document.createElement("option"); o.value=v; o.textContent=t; category.appendChild(o); }
      if (customTags.length) {
        const group = document.createElement("optgroup"); group.label = "自作タグ";
        for (const tag of customTags) { const o=document.createElement("option"); o.value=`tag:${tag}`; o.textContent=tag; group.appendChild(o); }
        category.appendChild(group);
      }
      if ([...category.options].some(o => o.value === previous)) category.value = previous;
    };
    const refresh = () => {
      const visibleNow = findTitles();
      visibleNow.forEach(item => allTitles.set(item.key, item));
      if (visibleNow.length) saveTitles();
      current = [...allTitles.values()];
      current.forEach((item, i) => {
        if (!items[item.key]) items[item.key] = { tags: [], status: "unseen", customOrder: i };
        if (!Array.isArray(items[item.key].tags)) items[item.key].tags = [];
      });
      refreshTagOptions();
      const q = clean(search.value).toLowerCase();
      const f = category.value;
      let list = current.filter(it => {
        const data = items[it.key] || {};
        const tags = data.tags || [];
        const hidden = tags.includes(HIDDEN_TAG);
        if (f === "hidden" ? !hidden : hidden) return false;
        if (q && !it.title.toLowerCase().includes(q)) return false;
        if (f === "later" && !tags.includes("あとで見る")) return false;
        if (f === "favorite" && !tags.includes("お気に入り")) return false;
        if (f.startsWith("tag:") && !tags.includes(f.slice(4))) return false;
        if (["unseen","watching","watched"].includes(f) && (data.status || "unseen") !== f) return false;
        return true;
      });
      if (sort.value === "title") list.sort((a,b) => a.title.localeCompare(b.title, "ja"));
      if (sort.value === "runtime-asc" || sort.value === "runtime-desc") {
        const direction = sort.value === "runtime-asc" ? 1 : -1;
        list.sort((a, b) => {
          const aMinutes = runtimeMinutesFromMetadata(items[a.key]?.runtimeInfo);
          const bMinutes = runtimeMinutesFromMetadata(items[b.key]?.runtimeInfo);
          // Put titles without a known runtime after titles with a runtime in either direction.
          if (aMinutes == null && bMinutes != null) return 1;
          if (aMinutes != null && bMinutes == null) return -1;
          if (aMinutes == null && bMinutes == null) return a.title.localeCompare(b.title, "ja");
          return (aMinutes - bMinutes) * direction || a.title.localeCompare(b.title, "ja");
        });
      }
      if (sort.value === "custom") list.sort((a,b) => (items[a.key]?.customOrder ?? 0) - (items[b.key]?.customOrder ?? 0));
      grid.replaceChildren();
      count.textContent = `${list.length}作品を表示（保存済み・検出：${current.length}作品）`; 
      selectionInfo.textContent = `選択：${selectedKeys.size}作品`;
      if (!current.length) {
        const empty = el("div", "nmlp-empty",
          "作品を検出できませんでした。Netflixのマイリストを開き、ページを再読み込みしてから、作品カードが表示されるまで少しスクロールしてください。それでも表示されない場合は、このページのスクリーンショットを送ってください。");
        grid.appendChild(empty);
      }
      for (const it of list) {
        const data = items[it.key] || { tags: [], status: "unseen" };
        const isSelected = selectedKeys.has(it.key);
        const card = el("article", "nmlp-card" + (isSelected ? " nmlp-selected" : ""));
        card.draggable = true;
        card.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", it.key); });
        card.addEventListener("dragover", e => { if (sort.value === "custom") e.preventDefault(); });
        card.addEventListener("drop", async e => {
          if (sort.value !== "custom") return;
          e.preventDefault();
          const from = e.dataTransfer.getData("text/plain");
          const a = current.findIndex(x => x.key === from);
          const b = current.findIndex(x => x.key === it.key);
          if (a < 0 || b < 0 || a === b) return;
          const reordered = [...current]; const moved = reordered.splice(a,1)[0]; reordered.splice(b,0,moved);
          reordered.forEach((x,i) => { items[x.key] ||= {tags:[],status:"unseen"}; items[x.key].customOrder = i; });
          await saveItems(); refresh();
        });
        const link = el("a", "nmlp-poster-link");
        link.href = it.href;
        link.title = "Netflixで作品を開く";
        const img = document.createElement("img");
        img.alt = it.title; img.loading = "lazy";
        if (it.image) img.src = it.image;
        else {
          img.classList.add("nmlp-image-missing");
          img.removeAttribute("src");
          img.title = "Netflix側から画像URLを取得できませんでした";
        }
        img.addEventListener("error", () => {
          img.classList.add("nmlp-image-missing");
          img.removeAttribute("src");
        }, { once: true });
        link.appendChild(img);
        const name = el("div", "nmlp-title", shortenTitle(it.title));
        name.title = it.title;
        const tagLine = el("div", "nmlp-tags", (data.tags || []).join(" ・ "));
        const metadata = el("div", "nmlp-metadata", data.runtimeInfo ? formatMetadataForDisplay(data.runtimeInfo) : "上映時間・話数を確認するときは作品カードを表示してください");
        metadata.__nmlpItem = it; metadata.__nmlpData = data;
        if (!data.runtimeInfo) metadataObserver.observe(metadata);

        const ratingSection = el("div", "nmlp-rating-section");
        const ratingStars = el("div", "nmlp-rating-stars");
        const ratingValue = Number(data.rating || 0);
        const ratingStep = settings.ratingMode === "whole" ? 1 : 0.5;
        for (let starIndex = 1; starIndex <= 5; starIndex++) {
          const star = el("button", "nmlp-star", "★"); star.type = "button";
          star.title = settings.ratingMode === "whole" ? `${starIndex}点` : `${starIndex-0.5}点（左半分）／${starIndex}点（右半分）`;
          star.classList.toggle("nmlp-star-active", ratingValue >= starIndex);
          star.classList.toggle("nmlp-star-half", settings.ratingMode !== "whole" && ratingValue >= starIndex-0.5 && ratingValue < starIndex);
          star.onclick = async ev => {
            const rect = star.getBoundingClientRect();
            let next = settings.ratingMode === "whole" ? (ratingValue === starIndex ? 0 : starIndex) : (ev.clientX < rect.left + rect.width/2 ? starIndex-0.5 : starIndex);
            if (next === ratingValue) next = 0;
            items[it.key].rating = next; await saveItems(); refresh();
          };
          ratingStars.appendChild(star);
        }
        const ratingControls = el("div", "nmlp-rating-controls");
        const ratingRange = el("input", "nmlp-rating-range"); ratingRange.type="range"; ratingRange.min="0"; ratingRange.max="5"; ratingRange.step=String(ratingStep); ratingRange.value=String(ratingValue);
        const ratingNumber = el("input", "nmlp-rating-number"); ratingNumber.type="number"; ratingNumber.min="0"; ratingNumber.max="5"; ratingNumber.step=String(ratingStep); ratingNumber.value=ratingValue.toFixed(settings.ratingMode === "whole" ? 0 : 1); ratingNumber.setAttribute("aria-label", `${it.title}の評価（0～5）`);
        const setRating = async raw => { let n=Number(raw); if(!Number.isFinite(n)) n=0; n=Math.max(0,Math.min(5,n)); n=Math.round(n/ratingStep)*ratingStep; items[it.key].rating=n; await saveItems(); refresh(); };
        ratingRange.onchange=()=>setRating(ratingRange.value); ratingNumber.onchange=()=>setRating(ratingNumber.value);
        ratingControls.append(ratingRange,ratingNumber); ratingSection.append(ratingStars,ratingControls);

        const memoWrap = el("div", "nmlp-memo-wrap");
        const memoToggle = el("button", "nmlp-small-btn", data.memoOpen ? "メモを収納" : "メモを開く"); memoToggle.type="button";
        const memo = el("textarea", "nmlp-memo"); memo.placeholder="感想・視聴メモなど…"; memo.value=data.memo || ""; memo.hidden=!data.memoOpen;
        memoToggle.onclick=()=>{ items[it.key].memoOpen=!items[it.key].memoOpen; memo.hidden=!items[it.key].memoOpen; memoToggle.textContent=items[it.key].memoOpen?"メモを収納":"メモを開く"; saveItems(); };
        let memoTimer; memo.addEventListener("input",()=>{ clearTimeout(memoTimer); const value=memo.value; memoTimer=setTimeout(async()=>{ items[it.key].memo=value; await saveItems(); },300); });
        memoWrap.append(memoToggle,memo);
        const actions = el("div", "nmlp-card-actions");
        const selectBtn = el("button", "nmlp-small-btn", isSelected ? "選択解除" : "選択");
        selectBtn.setAttribute("aria-pressed", String(isSelected));
        selectBtn.onclick = () => { if (selectedKeys.has(it.key)) selectedKeys.delete(it.key); else selectedKeys.add(it.key); refresh(); };
        const status = el("select", "nmlp-status");
        [["unseen","未視聴"],["watching","視聴中"],["watched","視聴済み"]].forEach(([v,t]) => {
          const o = document.createElement("option"); o.value = v; o.textContent = t; status.appendChild(o);
        });
        status.value = data.status || "unseen";
        status.setAttribute("aria-label", `${it.title}の視聴状況`);
        status.onchange = async () => { items[it.key].status = status.value; await saveItems(); refresh(); };
        actions.append(selectBtn, status);
        if (f === "hidden") {
          const unhideBtn = el("button", "nmlp-small-btn", "再表示");
          unhideBtn.onclick = async () => {
            items[it.key].tags = (items[it.key].tags || []).filter(t => t !== HIDDEN_TAG);
            selectedKeys.delete(it.key);
            await saveItems(); refresh();
          };
          actions.appendChild(unhideBtn);
        }
        card.append(link, name, tagLine, metadata, ratingSection, memoWrap, actions);
        grid.appendChild(card);
      }
      saveItems();
    };

    bulkScan.onclick = async () => {
      if (isBulkScanning) return;
      isBulkScanning = true;
      bulkScan.disabled = true;
      bulkStatus.textContent = "マイリストの右矢印を操作して作品を収集中…";
      const originalY = window.scrollY;
      const panelWasVisible = panel.style.visibility;
      panel.style.visibility = "hidden";
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      let stopReason = "右矢印が見つからないため停止しました";
      const signatureCounts = new Map();
      let lastSignature = "";
      let steps = 0;

      const collect = root => {
        let changed = false;
        for (const item of findTitles(root || document)) {
          if (!allTitles.has(item.key) || JSON.stringify(allTitles.get(item.key)) !== JSON.stringify(item)) {
            allTitles.set(item.key, item);
            changed = true;
          }
        }
        if (changed) saveTitles();
      };

      try {
        // Locate the actual row titled 「マイリスト」 and interact with its
        // horizontal carousel arrow rather than scrolling the page vertically.
        let carousel = findMyListCarousel();
        if (!carousel) {
          collect(document);
          stopReason = "「マイリスト」のカルーセルまたは右矢印を特定できませんでした";
        } else {
          collect(carousel.root);
          lastSignature = carouselSignature(carousel);
          // Do not count the initial view as a repeat: it commonly overlaps with
          // the page's first batch and must not terminate the first scan.
          let unchangedArrowFailures = 0;
          const maxSteps = 220; // Safety cap for unusually large lists.
          while (steps < maxSteps) {
            // Re-find the row and arrow after every React rerender.
            carousel = findMyListCarousel();
            if (!carousel) {
              stopReason = "一覧の再描画後に右矢印を見つけられませんでした";
              break;
            }
            const before = carouselSignature(carousel);
            const button = carousel.next;
            const br = button.getBoundingClientRect();
            if (button.disabled || button.getAttribute("aria-disabled") === "true" || br.width === 0 || br.height === 0) {
              stopReason = "右矢印が無効になったため、一覧の終端と判断して停止しました";
              break;
            }

            button.click();
            steps++;
            await wait(700);
            carousel = findMyListCarousel();
            if (!carousel) {
              stopReason = "矢印操作後にマイリストの列を再特定できませんでした";
              break;
            }
            collect(carousel.root);
            const after = carouselSignature(carousel);
            if (after && after === before) unchangedArrowFailures++;
            else unchangedArrowFailures = 0;
            if (unchangedArrowFailures >= 3) {
              stopReason = "右矢印を3回操作しても表示が変わらなかったため停止しました";
              break;
            }
            if (after) {
              const seen = (signatureCounts.get(after) || 0) + 1;
              signatureCounts.set(after, seen);
              if (seen >= 2) {
                collect(carousel.root);
                stopReason = "同じ作品の並びを2回検出したため、先頭へのループと判断して停止しました";
                break;
              }
            }
            lastSignature = after || before;
            bulkStatus.textContent = `収集中… ${allTitles.size}作品を検出（矢印操作 ${steps}回）`;
            refresh();
          }
          if (steps >= maxSteps) stopReason = `安全上限（${maxSteps}回）に達したため停止しました`;
        }
      } catch (err) {
        stopReason = "読み込み中にエラーが発生しました。ページを再読み込みして再試行してください";
      } finally {
        window.scrollTo(0, originalY);
        panel.style.visibility = panelWasVisible;
        isBulkScanning = false;
        bulkScan.disabled = false;
        bulkStatus.textContent = `読み込み停止：${allTitles.size}作品を検出。${stopReason}`;
        saveTitles();
        refresh();
      }
    };

    addBtn.onclick = async () => {
      if (!selectedKeys.size) { alert("先に作品カードの「選択」を押して、1作品以上を選択してください。"); return; }
      const tag = clean(customCat.value);
      if (!tag) return;
      for (const key of selectedKeys) {
        items[key] ||= { tags: [], status: "unseen" };
        items[key].tags ||= [];
        if (!items[key].tags.includes(tag)) items[key].tags.push(tag);
      }
      customCat.value = "";
      await saveItems(); refresh();
    };
    applyBulkStatus.onclick = async () => {
      if (!selectedKeys.size) { alert("先に作品カードの「選択」を押して、1作品以上を選択してください。"); return; }
      const action = bulkStatusSelect.value;
      const label = bulkStatusSelect.selectedOptions[0]?.textContent || "選択した状態";
      if (!confirm(`選択した${selectedKeys.size}作品を「${label}」に変更しますか？`)) return;
      for (const key of selectedKeys) {
        items[key] ||= { tags: [], status: "unseen" };
        items[key].tags ||= [];
        if (action === "hidden") {
          if (!items[key].tags.includes(HIDDEN_TAG)) items[key].tags.push(HIDDEN_TAG);
        } else {
          items[key].status = action;
        }
      }
      selectedKeys.clear();
      await saveItems(); refresh();
    };
    deleteTagBtn.onclick = async () => {
      const val = category.value;
      if (!val.startsWith("tag:")) { alert("削除する自作タグを、表示フィルターのプルダウンから選んでください。"); return; }
      const tag = val.slice(4);
      if (!confirm(`自作タグ「${tag}」をすべての作品から削除しますか？`)) return;
      for (const data of Object.values(items)) data.tags = (data.tags || []).filter(t => t !== tag);
      await saveItems();
      category.value = "all";
      refresh();
    };
    search.addEventListener("input", refresh);
    category.addEventListener("change", refresh);
    sort.addEventListener("change", refresh);
    document.addEventListener("nmlp-metadata-updated", refresh);
    size.addEventListener("input", () => {
      panel.style.setProperty("--nmlp-card-width", `${size.value}px`);
      settings.posterSize = Number(size.value);
      saveSettings();
    });
    titleLimit.addEventListener("change", () => {
      const value = Math.max(0, Math.min(200, Number(titleLimit.value) || 0));
      settings.titleLimit = value;
      titleLimit.value = String(value);
      saveSettings(); refresh();
    });
    showTotalSeasons.addEventListener("change", () => {
      settings.showTotalSeasons = showTotalSeasons.checked;
      saveSettings();
      refresh();
    });
    ratingMode.addEventListener("change", () => {
      settings.ratingMode = ratingMode.value;
      if (settings.ratingMode === "whole") {
        for (const data of Object.values(items)) if (typeof data.rating === "number") data.rating = Math.round(data.rating);
        saveItems();
      }
      saveSettings(); refresh();
    });
    size.dispatchEvent(new Event("input"));
    refresh();

    panelObserver = new MutationObserver((mutations) => {
      const changedOutsidePanel = mutations.some(m => {
        const target = m.target;
        if (target instanceof Element && target.closest(`#${PANEL_ID}`)) return false;
        return [...m.addedNodes, ...m.removedNodes].some(n =>
          !(n instanceof Element && (n.id === PANEL_ID || n.closest?.(`#${PANEL_ID}`)))
        );
      });
      if (!changedOutsidePanel) return;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        if (panelOpen && document.getElementById(PANEL_ID)) refresh();
      }, 900);
    });
    panelObserver.observe(document.body, { childList: true, subtree: true });
  }

  loadItems().then(ensureLauncher);
  const syncLauncherToRoute = () => ensureLauncher();
  window.addEventListener("popstate", syncLauncherToRoute);
  window.addEventListener("hashchange", syncLauncherToRoute);
  const routeObserver = new MutationObserver(() => {
    // Netflix is a SPA; DOM changes accompany client-side route changes.
    syncLauncherToRoute();
  });
  routeObserver.observe(document.documentElement, { childList: true, subtree: true });
})();
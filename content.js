
(() => {

/* ===============================
   CONFIG
=================================*/
const MAX_CONCURRENT = 3;
const RATE_LIMIT_COUNT = 10;
const RATE_LIMIT_WINDOW = 5000; // ms
const REQUEST_TIMEOUT = 8000;

/* ===============================
   Rate Limiter
=================================*/
class RateLimiter {
    constructor(limit, windowMs) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.timestamps = [];
    }

    async waitIfNeeded() {
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

        if (this.timestamps.length >= this.limit) {
            const waitTime = this.windowMs - (now - this.timestamps[0]);
            await new Promise(r => setTimeout(r, waitTime));
        }

        this.timestamps.push(Date.now());
    }
}

const rateLimiter = new RateLimiter(RATE_LIMIT_COUNT, RATE_LIMIT_WINDOW);

/* ===============================
   Priority Request Queue
=================================*/
class RequestQueue {
    constructor(limit) {
        this.limit = limit;
        this.active = 0;
        this.queue = [];
    }

    enqueue(task, priority = false) {
        return new Promise((resolve, reject) => {
            const item = { task, resolve, reject };
            priority ? this.queue.unshift(item) : this.queue.push(item);
            this.next();
        });
    }

    next() {
        if (this.active >= this.limit || this.queue.length === 0) return;

        const { task, resolve, reject } = this.queue.shift();
        this.active++;

        task()
            .then(resolve)
            .catch(reject)
            .finally(() => {
                this.active--;
                this.next();
            });
    }
}

const queue = new RequestQueue(MAX_CONCURRENT);

/* ===============================
   LRU Cache
=================================*/
class LRUCache {
    constructor(max = 200) {
        this.max = max;
        this.map = new Map();
    }

    get(k) {
        if (!this.map.has(k)) return null;
        const v = this.map.get(k);
        this.map.delete(k);
        this.map.set(k, v);
        return v;
    }

    set(k, v) {
        if (this.map.has(k)) {
            this.map.delete(k);
        } else if (this.map.size >= this.max) {
            const first = this.map.keys().next().value;
            this.map.delete(first);
        }
        this.map.set(k, v);
    }
}

const cache = new LRUCache();

/* ===============================
   Fetch with Backoff
=================================*/
async function fetchWithBackoff(url, attempt = 1) {

    await rateLimiter.waitIfNeeded();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
        const res = await fetch(url, {
            credentials: "include",
            signal: controller.signal
        });

        if (res.status === 429 && attempt <= 3) {
            const delay = 1000 * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, delay));
            return fetchWithBackoff(url, attempt + 1);
        }

        if (!res.ok) return "";

        return await res.text();

    } catch {
        return "";
    } finally {
        clearTimeout(timeout);
    }
}

/* ===============================
   Image Extraction
=================================*/
async function fetchProductImages(url, priority = false) {

    const cached = cache.get(url);
    if (cached) return cached;

    return queue.enqueue(async () => {

        const html = await fetchWithBackoff(url);
        if (!html) return [];

        const matches = [...html.matchAll(/data-product-photo="([^"]+)"/g)];
        const images = [...new Set(matches.map(m => m[1]))];

        cache.set(url, images);
        return images;

    }, priority);
}

/* ===============================
   Product Links
=================================*/
function getProductLinks() {
    return [...document.querySelectorAll("a[href]")].filter(a => {
        try {
            const u = new URL(a.href);
            return u.hostname === location.hostname && /\/\d+-/.test(u.pathname);
        } catch {
            return false;
        }
    });
}

/* ===============================
   Sticky Popup
=================================*/
let currentPopup = null;
let popupHover = false;

function positionSticky(popup, anchor) {

    const rect = anchor.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();

    let top = rect.bottom + window.scrollY + 8;
    let left = rect.left + window.scrollX;

    if (left + popupRect.width > window.innerWidth + window.scrollX) {
        left = window.innerWidth + window.scrollX - popupRect.width - 10;
    }

    if (top + popupRect.height > window.innerHeight + window.scrollY) {
        top = rect.top + window.scrollY - popupRect.height - 8;
    }

    popup.style.top = top + "px";
    popup.style.left = left + "px";
}

function renderPopup(images, anchor) {

    if (!images.length) return;

    if (currentPopup) {
        currentPopup.remove();
        currentPopup = null;
    }

    const popup = document.createElement("div");

    Object.assign(popup.style, {
        position: "absolute",
        zIndex: 9999,
        background: "#fff",
        border: "1px solid #ccc",
        borderRadius: "12px",
        padding: "12px",
        display: "flex",
        gap: "8px",
        boxShadow: "0 12px 30px rgba(0,0,0,0.3)"
    });

    images.slice(0, 6).forEach(src => {
        const img = document.createElement("img");
        img.src = src;
        img.style.width = "140px";
        img.style.height = "140px";
        img.style.objectFit = "cover";
        img.style.borderRadius = "8px";
        popup.appendChild(img);
    });

    popup.addEventListener("mouseenter", () => popupHover = true);
    popup.addEventListener("mouseleave", () => {
        popupHover = false;
        popup.remove();
        currentPopup = null;
    });

    document.body.appendChild(popup);
    positionSticky(popup, anchor);

    currentPopup = popup;
}

/* ===============================
   Hover + Prefetch
=================================*/
const processed = new WeakSet();

function attachHover(link) {

    let timer = null;

    link.addEventListener("mouseenter", () => {

        timer = setTimeout(async () => {

            const images = await fetchProductImages(link.href, true);

            if (!link.matches(":hover")) return;
            renderPopup(images, link);

        }, 200);
    });

    link.addEventListener("mouseleave", () => {

        clearTimeout(timer);

        setTimeout(() => {
            if (!popupHover && currentPopup) {
                currentPopup.remove();
                currentPopup = null;
            }
        }, 150);
    });
}

const io = new IntersectionObserver(entries => {

    entries.forEach(entry => {
        if (!entry.isIntersecting) return;

        const link = entry.target;
        if (!cache.get(link.href)) {
            fetchProductImages(link.href, false);
        }

        io.unobserve(link);
    });

}, { rootMargin: "500px" });

function init() {

    const links = getProductLinks();

    links.forEach(link => {

        if (processed.has(link)) return;
        processed.add(link);

        attachHover(link);
        io.observe(link);
    });
}

new MutationObserver(init).observe(document.body, {
    childList: true,
    subtree: true
});

init();

})();

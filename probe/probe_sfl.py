"""TEMPORARY probe: how stayforlong.com hotel pages load prices."""
import json, sys, urllib.request
from playwright.sync_api import sync_playwright

def get(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as e:
        return None, repr(e)

st, body = get("https://www.stayforlong.com/robots.txt")
print("ROBOTS", st, body[:3000], sep="\n")
st, body = get("https://www.stayforlong.com/hotel/th/century-park-hotel_bangkok")
print("PLAIN GET hotel page", st, len(body), body[:1500].replace("\n", " "))

pages = [
    "https://www.stayforlong.com/hotel/th/century-park-hotel_bangkok",
    "https://www.stayforlong.com/hotel/th/the-okura-prestige-bangkok_bangkok",
    "https://www.stayforlong.com/hotel/th/eastin-grand-hotel-sathorn_bangkok",
]
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(locale="en-GB", user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")
    for url in pages:
        pg = ctx.new_page()
        seen = []
        def on_resp(r):
            if r.request.resource_type in ("xhr", "fetch"):
                try:
                    t = r.text()[:600]
                except Exception as e:
                    t = repr(e)
                seen.append((r.status, r.request.method, r.url, r.request.post_data and r.request.post_data[:400], t))
        pg.on("response", on_resp)
        try:
            resp = pg.goto(url, wait_until="domcontentloaded", timeout=45000)
            pg.wait_for_timeout(9000)
            print("\n=== PAGE", url, "->", resp and resp.status, pg.url, "title:", pg.title())
            txt = pg.inner_text("body")[:1500].replace("\n", " | ")
            print("TEXT", txt)
            links = pg.eval_on_selector_all("a[href]", "els => els.map(e => e.href).filter(h => /hotel|search|bangkok/i.test(h)).slice(0, 25)")
            print("LINKS", links)
        except Exception as e:
            print("\n=== PAGE", url, "ERROR", e)
        for s in seen:
            print("XHR", s[0], s[1], s[2], "\n   POST:", s[3], "\n   RESP:", (s[4] or "").replace("\n", " "))
        pg.close()
    b.close()

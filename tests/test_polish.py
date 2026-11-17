"""0.8: cached tree, starred notes, backups, find & replace, Harper in the block editor,
compare versions, hover previews, side by side, mobile touches, keyboard and focus."""

import io
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path


def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.headers.get("ETag"), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("ETag"), b""


def run(t):
    s = t.start()
    api, V = s.api, s.vault

    # every module's imports are complete (the helper that keeps them so finds nothing to add)
    r = subprocess.run([sys.executable, str(Path(__file__).parent / "fix_imports.py"), "--check"], capture_output=True, text=True)
    t.ok(r.returncode == 0, f"app modules import everything they use ({r.stdout.strip()})")

    # tree: ETag and 304
    code, tag, body = get(s.url + "/api/tree")
    code2, tag2, body2 = get(s.url + "/api/tree", {"If-None-Match": tag})
    t.ok(code == 200 and tag and code2 == 304 and not body2, "an unchanged tree answers 304 with no body")
    api("POST", "/api/meta", {"path": "Welcome.md", "set": {"starred": True}})
    code3, tag3, _ = get(s.url + "/api/tree", {"If-None-Match": tag})
    t.ok(code3 == 200 and tag3 != tag, "a metadata change gives a new tree")
    (V / "Outside.md").write_text("written by another program")
    code4, tag4, body4 = get(s.url + "/api/tree", {"If-None-Match": tag3})
    t.ok(code4 == 200 and b"Outside.md" in body4, "a file changed on disk gives a new tree")

    # starred
    star = next(n for n in api("GET", "/api/tree")["notes"] if n["path"] == "Welcome.md")["starred"]
    api("POST", "/api/meta", {"path": "Welcome.md", "set": {"starred": True}})
    again = next(n for n in api("GET", "/api/tree")["notes"] if n["path"] == "Welcome.md")["starred"]
    t.ok(isinstance(star, int) and star == again, "starring keeps the time it was first starred")

    # scheduled backups
    c = api("PUT", "/api/config", {"backup": {"enabled": True, "every": "weekly", "day": 9, "hour": 30, "keep": 2}})
    t.ok(c["backup"]["enabled"] and c["backup"]["day"] == 6 and c["backup"]["hour"] == 23, "backup settings are clamped")
    names = []
    for _ in range(3):
        names.append(api("POST", "/api/backups/run")["name"])
        time.sleep(1.05)
    listed = api("GET", "/api/backups")
    t.ok([b["name"] for b in listed["backups"]] == names[:0:-1] and listed["next"], f"only the newest {len(listed['backups'])} backups are kept")
    code, _, raw = get(s.url + f"/api/backups/file?name={names[-1]}")
    t.ok(code == 200 and "Welcome.md" in zipfile.ZipFile(io.BytesIO(raw)).namelist(), "download a backup")
    t.ok(api("GET", "/api/backups/file?name=../../server.py").get("_status") == 400, "backup names can't escape the folder")
    t.ok(not str(listed["folder"]).startswith(str(V)), "backups are kept outside the vault")
    api("DELETE", f"/api/backups?name={names[-1]}")
    t.ok(len(api("GET", "/api/backups")["backups"]) == 1, "delete a backup")
    api("PUT", "/api/config", {"backup": {"enabled": False}})

    api("POST", "/api/note", {"name": "Fruit", "content": "apple Apple pineapple\napple pie\n"})
    api("POST", "/api/note", {"name": "Linker", "content": "Read [[Fruit]] and [[Missing one]].\n"})
    pg = t.page()
    pg.goto(s.url + "/#/Fruit.md"); pg.wait_for_timeout(900)

    # starred panel
    pg.click('.ptab[data-panel="starred"]'); pg.wait_for_timeout(200)
    t.ok(pg.locator("#starredList [data-open='Welcome.md']").count() == 1, "the starred panel lists starred notes")
    pg.keyboard.press("Alt+s"); pg.wait_for_timeout(800)
    t.ok(pg.locator("#starredList [data-open='Fruit.md']").count() == 1 and pg.locator(".row[data-note='Fruit.md'] .star").count() == 1,
         "Alt S stars the open note, and the tree shows it")

    # find & replace
    pg.click("#ta"); pg.keyboard.press("Control+f"); pg.wait_for_timeout(200)
    pg.keyboard.type("apple"); pg.wait_for_timeout(300)
    t.ok(pg.is_visible("#findbar") and pg.text_content("#findCount") == "1 of 4" and pg.locator("#finds mark").count() == 4, "Ctrl F finds every match")
    pg.click('[data-find="case"]'); pg.wait_for_timeout(150)
    case = pg.text_content("#findCount")
    pg.click('[data-find="word"]'); pg.wait_for_timeout(150)
    word = pg.text_content("#findCount")
    t.ok(case.endswith("of 3") and word.endswith("of 2"), f"match case and whole word ({case}, {word})")
    pg.keyboard.press("Enter"); pg.wait_for_timeout(100)
    t.ok(pg.text_content("#findCount") == "2 of 2", "Enter goes to the next match")
    pg.keyboard.press("Control+h"); pg.wait_for_timeout(200)
    pg.fill("#replaceInput", "pear")
    pg.click("#replaceAll"); pg.wait_for_timeout(1500)
    t.ok((V / "Fruit.md").read_text() == "pear Apple pineapple\npear pie\n", "replace all, respecting the options")
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(1300)
    t.ok((V / "Fruit.md").read_text().startswith("apple Apple"), "replace all undoes in one step")
    pg.click('[data-find="regex"]'); pg.fill("#findInput", r"(\w)pple pie"); pg.fill("#replaceInput", "$1pricot tart"); pg.wait_for_timeout(200)
    pg.click("#replaceOne"); pg.wait_for_timeout(1300)
    t.ok("apricot tart" in (V / "Fruit.md").read_text(), "regular expressions with $1 in the replacement")
    pg.fill("#findInput", "(bad"); pg.wait_for_timeout(150)
    t.ok(pg.text_content("#findCount") == "Invalid pattern", "a broken pattern says so")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
    t.ok(not pg.is_visible("#findbar") and pg.evaluate("document.activeElement.id") == "ta" and pg.locator("#finds mark").count() == 0,
         "Esc closes the find bar and goes back to the text")
    pg.click('[data-mode="read"]'); pg.wait_for_timeout(300)
    pg.keyboard.press("Control+f"); pg.keyboard.type("pineapple"); pg.wait_for_timeout(300)
    t.ok(pg.locator("#preview mark.find-hit").count() == 1, "find works in the preview too")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
    t.ok(pg.locator("#preview mark").count() == 0, "and leaves no marks behind")

    # compare versions
    api("PUT", "/api/config", {"history": {"enabled": True, "interval": 1}})
    api("PUT", "/api/note?path=Fruit.md", {"content": "apple Apple pineapple\napple pie with cream\nfour\n"})
    pg.goto(s.url + "/#/Fruit.md"); pg.wait_for_timeout(900)
    pg.keyboard.press("Alt+h"); pg.wait_for_timeout(700)
    if pg.locator(".history-list [data-id]").count():
        pg.click('[data-view="changes"]'); pg.wait_for_timeout(500)
        t.ok(pg.locator(".diff-line.ins").count() >= 2 and pg.locator(".diff ins").count() >= 1, "changes since a version, with the changed words marked")
        pg.select_option(".history-against", "previous"); pg.wait_for_timeout(500)
        t.ok(pg.locator(".diff, .history-empty").count() == 1, "compare with the version before")
        pg.click('[data-view="preview"]'); pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    else:
        t.ok(False, "history has versions to compare")
    diff = pg.evaluate("""async () => {
      const { diffArrays, diffHtml } = await import('/static/diff.js');
      const a = 'a b c d e f'.split(' '), b = 'a x c d f g'.split(' ');
      const ops = diffArrays(a, b);
      const left = ops.filter(o => o[0] !== '+').map(o => o[1]).join(''), right = ops.filter(o => o[0] !== '-').map(o => o[1]).join('');
      const long = Array.from({length: 60}, (_, i) => 'line ' + i).join('\\n');
      const folded = diffHtml(long, long.replace('line 30', 'line thirty')).html;
      return { ok: left === a.join('') && right === b.join(''), folds: (folded.match(/data-fold/g) || []).length };
    }""")
    t.ok(diff["ok"] and diff["folds"] == 2, f"the diff rebuilds both texts and folds long unchanged runs ({diff})")

    # hover previews
    pg.goto(s.url + "/#/Linker.md"); pg.wait_for_timeout(900)
    pg.click('[data-mode="read"]'); pg.wait_for_timeout(300)
    pg.hover('#preview a.wikilink[data-note="Fruit"]'); pg.wait_for_timeout(800)
    t.ok(pg.locator(".hover-card .hover-body").count() == 1 and "with cream" in pg.text_content(".hover-card"), "hovering a link previews the note")
    pg.mouse.move(5, 5); pg.wait_for_timeout(500)
    t.ok(pg.locator(".hover-card").count() == 0, "and the preview goes away")
    pg.hover('#preview a.wikilink[data-note="Missing one"]'); pg.wait_for_timeout(800)
    t.ok("doesn’t exist" in (pg.text_content(".hover-card") or ""), "a missing note says so")
    pg.mouse.move(5, 5); pg.wait_for_timeout(400)

    # side by side
    pg.click('.ptab[data-panel="files"]')
    pg.click(".row[data-note='Fruit.md']", button="right"); pg.wait_for_timeout(200)
    pg.click(".menu button:has-text('Open to the side')"); pg.wait_for_timeout(800)
    t.ok(pg.is_visible("#sidePane") and "with cream" in pg.text_content("#sideBody") and pg.input_value("#titleInput") == "Linker",
         "open a note to the side of the one being edited")
    w0 = pg.evaluate("document.getElementById('sidePane').getBoundingClientRect().width")
    box = pg.locator("#sideDivider").bounding_box()
    pg.mouse.move(box["x"] + 2, box["y"] + 200); pg.mouse.down(); pg.mouse.move(box["x"] - 120, box["y"] + 200, steps=5); pg.mouse.up()
    w1 = pg.evaluate("document.getElementById('sidePane').getBoundingClientRect().width")
    t.ok(w1 > w0 + 80, f"drag the divider to resize ({w0:.0f} → {w1:.0f})")
    api("PUT", "/api/note?path=Fruit.md", {"content": "changed elsewhere\n"})
    pg.evaluate("window.dispatchEvent(new Event('focus'))"); pg.wait_for_timeout(200)
    pg.keyboard.press("Control+s"); pg.wait_for_timeout(1200)
    t.ok("changed elsewhere" in pg.text_content("#sideBody"), "the side note follows changes from the server")
    pg.reload(); pg.wait_for_timeout(1200)
    t.ok(pg.is_visible("#sidePane"), "the side note comes back after a reload")
    pg.click("#sideSwap"); pg.wait_for_timeout(800)
    t.ok(pg.input_value("#titleInput") == "Fruit" and "Missing one" in pg.text_content("#sideBody"), "swap the two notes")
    pg.click("#sideClose"); pg.wait_for_timeout(200)
    t.ok(not pg.is_visible("#sidePane"), "close the side note")

    # keyboard: tree arrows, focus comes back after a menu
    pg.locator(".row[data-note='Fruit.md']").focus()
    pg.keyboard.press("ArrowUp"); pg.wait_for_timeout(100)
    up = pg.evaluate("document.activeElement.dataset.note || document.activeElement.dataset.folder")
    t.ok(up and up != "Fruit.md" and pg.locator(".row[tabindex='0']").count() == 1, f"arrow keys move through the tree ({up})")
    pg.keyboard.press("Shift+F10"); pg.wait_for_timeout(200)
    opened = pg.locator(".menu").count() == 1
    pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
    back = pg.evaluate("document.activeElement.dataset.note || document.activeElement.dataset.folder")
    t.ok(opened and back == up, "Shift F10 opens its menu; Esc gives focus back")
    pg.keyboard.press("Control+o"); pg.wait_for_timeout(200)
    for _ in range(4):
        pg.keyboard.press("Tab")
    t.ok(pg.evaluate("!!document.activeElement.closest('.picker, .dialog, .backdrop')"), "Tab stays inside the open dialog")
    pg.keyboard.press("Escape")
    t.ok(pg.evaluate("[...document.querySelectorAll('button')].filter(b => !b.textContent.trim() && !b.getAttribute('aria-label') && b.offsetParent).length") == 0,
         "every icon button has a name for screen readers")
    pg.context.close()

    # Harper in the block editor
    h = t.page({"spellEngine": "harper", "previewEdit": True})
    api("POST", "/api/note", {"name": "Typos", "content": "A fine paragraph.\n"})
    h.goto(s.url + "/#/Typos.md"); h.wait_for_timeout(1500)
    h.click('[data-mode="read"]'); h.wait_for_timeout(400)
    h.click("#preview > p >> nth=0"); h.wait_for_timeout(200)
    h.keyboard.press("End"); h.keyboard.type(" This sentance is wrong.")
    for _ in range(20):
        h.wait_for_timeout(700)
        if h.locator('.block-lints .lint:text("sentance")').count():
            break
    span = h.locator('.block-lints .lint:text("sentance")')
    if t.ok(span.count() == 1, "Harper checks the block being edited in the preview"):
        b = span.first.bounding_box()
        h.mouse.click(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2, button="right"); h.wait_for_timeout(300)
        h.click(".menu button >> nth=0"); h.wait_for_timeout(300)
        t.ok("This sentence is wrong." in h.input_value(".block-ta"), "and its fix applies inside the block")
    h.context.close()

    # phone: edge swipe, long press, the keyboard-aware layout
    m = t.page(viewport=(390, 760), mobile=True)
    m.goto(s.url + "/#/Fruit.md"); m.wait_for_timeout(900)
    cdp = m.context.new_cdp_session(m)
    def touch(kind, x, y):
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if kind == "touchEnd" else [{"x": x, "y": y}]})
    touch("touchStart", 6, 400)
    for x in (30, 60, 90, 120):
        touch("touchMove", x, 404)
    touch("touchEnd", 120, 404); m.wait_for_timeout(500)
    t.ok(m.evaluate("document.getElementById('app').classList.contains('drawer-open')"), "swipe in from the left edge opens the sidebar")
    m.click('.ptab[data-panel="files"]'); m.wait_for_timeout(200)
    r = m.locator(".row[data-note='Fruit.md']").bounding_box()
    touch("touchStart", r["x"] + 60, r["y"] + 15); m.wait_for_timeout(650); touch("touchEnd", r["x"] + 60, r["y"] + 15); m.wait_for_timeout(300)
    t.ok(m.locator(".menu").count() == 1 and m.evaluate("document.querySelector('.menu button').getBoundingClientRect().height") >= 40,
         "press and hold a note for its menu, with finger-sized items")
    m.keyboard.press("Escape")
    t.ok(m.evaluate("getComputedStyle(document.querySelector('.row')).height") == "40px", "taller rows on a phone")
    t.ok(m.locator("#sidePane").is_hidden() and m.evaluate("!document.querySelector('#sideDivider:not([hidden])')"), "no side pane on a phone")
    m.context.close()

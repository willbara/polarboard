"""Switcher, palette, daily notes, suggestions, outline, backlinks, previews, sharing, git, writing checks."""

import shutil
import urllib.request


def run(t):
    s = t.start()
    s.api("POST", "/api/note", {"folder": "Templates", "name": "Meeting", "content": "# {{title}}\nDate: {{date}}\n\n- {{cursor}}\n"})
    s.api("POST", "/api/note", {"name": "Rich", "content": "```js\nconst x = 1;\n```\n\nMath $e^{i\\pi}+1=0$.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n```mermaid\ngraph TD; A-->B;\n```\n"})
    pg = t.page({"dailyTemplate": "Templates/Meeting.md"})
    pg.goto(s.url + "/#/Welcome.md"); pg.wait_for_timeout(1200)

    pg.keyboard.press("Control+o"); pg.keyboard.type("ide"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    t.ok(pg.input_value("#titleInput") == "Ideas", "Ctrl O opens a note by fuzzy name")
    h = pg.eval_on_selector("#titleInput", "e => e.offsetHeight")
    pg.keyboard.press("Control+Shift+P"); pg.wait_for_timeout(200)
    t.ok(pg.eval_on_selector(".picker-input", "e => e.getBoundingClientRect().height") >= 50, "the palette's input isn't squashed")
    pg.keyboard.type("today"); pg.keyboard.press("Enter"); pg.wait_for_timeout(900)
    title = pg.input_value("#titleInput")
    t.ok(title.startswith("20") and pg.input_value("#ta").startswith(f"# {title}"), "the palette opens today's note from the template")

    pg.click("#ta"); pg.keyboard.press("Control+End"); pg.keyboard.type("\nSee [[Wel"); pg.wait_for_timeout(250)
    pg.keyboard.press("Enter"); pg.keyboard.type(" #ide"); pg.wait_for_timeout(250); pg.keyboard.press("Tab"); pg.wait_for_timeout(200)
    body = pg.input_value("#ta")
    t.ok("See [[Welcome]]" in body and "#ideas " in body, "[[ and # suggestions insert links and tags")

    pg.click('.ptab[data-panel="outline"]'); pg.wait_for_timeout(300)
    t.ok(pg.locator("#outline .outline-item").count() >= 1, "outline lists headings")
    pg.keyboard.press("Control+o"); pg.keyboard.type("Ideas"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    pg.click('.ptab[data-panel="links"]'); pg.wait_for_timeout(800)
    t.ok("Welcome" in pg.inner_text("#backlinks"), "backlinks list notes linking here")

    pg.keyboard.press("Control+o"); pg.keyboard.type("Rich"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    pg.click('[data-mode="read"]'); pg.wait_for_timeout(3500)
    t.ok(pg.locator("#preview code.hljs .hljs-keyword").count() > 0 and pg.locator("#preview .katex").count() >= 2
         and pg.locator("#preview pre.mermaid.rendered svg").count() == 1, "code, math and diagrams render")
    pg.click("#noteMenuBtn"); pg.click(".menu >> text=Share link…"); pg.wait_for_timeout(300)
    pg.click(".dialog [data-create]"); pg.wait_for_timeout(400)
    url = pg.input_value(".dialog .share-row input"); pg.keyboard.press("Escape")
    sp = pg.context.new_page(); sp.goto(url); sp.wait_for_timeout(3000)
    t.ok(sp.inner_text("#title") == "Rich" and sp.locator(".katex").count() >= 2, "a share link shows the note to anyone")
    sp.close()

    if shutil.which("git"):
        s.api("PUT", "/api/config", {"git": {"enabled": True}})
        r = s.api("POST", "/api/git/commit", {})
        t.ok(r.get("committed") and (s.vault / ".git").exists(), "git commits the vault")

    # Harper writing checks (loads the WebAssembly once)
    w = t.page({"spellEngine": "harper"})
    w.goto(s.url + "/#/Ideas/Ideas.md"); w.wait_for_timeout(800)
    w.click("#ta"); w.keyboard.press("Control+End"); w.keyboard.type("\n\nThis sentance is wrong.")
    for _ in range(20):
        w.wait_for_timeout(800)
        if w.locator('#lints .lint:text("sentance")').count():
            break
    span = w.locator('#lints .lint:text("sentance")')
    if t.ok(span.count() == 1, "Harper underlines a misspelling"):
        box = span.first.bounding_box()
        w.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, button="right"); w.wait_for_timeout(300)
        w.click(".menu button >> nth=0"); w.wait_for_timeout(400)
        t.ok("This sentence is wrong." in w.input_value("#ta"), "right-click applies Harper's fix")

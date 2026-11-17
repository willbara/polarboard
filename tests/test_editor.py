"""The editor: caret alignment with the colour layer, lists, formatting, images, checkboxes."""

import io


def run(t):
    from PIL import Image, ImageChops
    s = t.start()
    long = ("# Heading with **bold** and `code`\n\n"
            + "\n".join(f"- item {i} with *italic* text, a #tag, [link](https://example.com/x) and ==mark== " * 2 for i in range(20))
            + "\n\n> a quote long enough to wrap around the measure a couple of times for sure\n\n```js\nconst x = 1;\n\tindented\n```\n"
            + "Ünïcödé — “quotes” emoji 🌙 and CJK 漢字 end.\n\n\n")
    s.api("PUT", "/api/note?path=Align.md", {"content": long})
    flat = "#hl, #hl * { color:#000!important; background:none!important; -webkit-text-stroke:0!important; text-decoration:none!important; }"
    for font in ("sans", "serif", "mono"):
        pg = t.page({"font": font, "theme": "light", "grain": 0}, viewport=(1300, 2800))
        pg.goto(s.url + "/#/Align.md"); pg.wait_for_timeout(800)
        pg.add_style_tag(content=".grain{display:none}")
        a_style = pg.add_style_tag(content=flat + " #ta{-webkit-text-fill-color:transparent!important;caret-color:transparent!important}")
        a = Image.open(io.BytesIO(pg.locator("#editor").screenshot())).convert("L")
        pg.evaluate("s => s.remove()", a_style)
        pg.add_style_tag(content="#hl,#hl *{color:transparent!important;background:none!important;-webkit-text-stroke:0!important;text-decoration:none!important} #ta{-webkit-text-fill-color:#000!important;caret-color:transparent!important}")
        b = Image.open(io.BytesIO(pg.locator("#editor").screenshot())).convert("L")
        # Antialiasing leaves a few scattered pixels; a real misalignment shows up as whole rows of glyphs.
        diff = ImageChops.difference(a, b).point(lambda v: 255 if v > 60 else 0)
        rows = [sum(1 for x in range(diff.width) if diff.getpixel((x, y))) for y in range(diff.height)]
        worst = max(rows)
        t.ok(worst <= 4, f"{font}: colour layer lines up with the text (at most {worst} stray pixels on any row)")
        pg.context.close()

    pg = t.page()
    pg.goto(s.url + "/"); pg.wait_for_timeout(800)
    pg.keyboard.press("Alt+n"); pg.wait_for_timeout(500)
    pg.keyboard.type("Groceries"); pg.keyboard.press("Enter")
    pg.keyboard.type("- [ ] milk\noats\n\nafter")
    pg.keyboard.press("Shift+Home"); pg.keyboard.press("Control+b"); pg.wait_for_timeout(1300)
    body = (s.vault / "Groceries.md").read_text()
    t.ok("- [ ] milk\n- [ ] oats\n**after**" in body, f"lists continue, empty item ends them, Ctrl+B wraps ({body!r})")
    pg.evaluate("""async () => {
      const c = document.createElement('canvas'); c.width = 40; c.height = 20;
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', {type: 'image/png'}));
      document.getElementById('ta').dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
    }""")
    pg.wait_for_timeout(1500)
    t.ok("![](attachments/pasted-" in (s.vault / "Groceries.md").read_text(), "pasting an image uploads and links it")
    pg.click('[data-mode="read"]'); pg.wait_for_timeout(500)
    t.ok(pg.evaluate("document.querySelector('#preview img')?.naturalWidth") == 40, "the image shows in the preview")
    pg.click('#preview input[type=checkbox] >> nth=0'); pg.wait_for_timeout(1200)
    t.ok("- [x] milk" in (s.vault / "Groceries.md").read_text(), "ticking a checkbox in the preview updates the note")

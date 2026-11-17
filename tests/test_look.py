"""Look: neutral blacks, grain strength and no flicker."""

import io


def run(t):
    from PIL import Image, ImageStat
    s = t.start()
    pg = t.page()
    pg.goto(s.url + "/#/Welcome.md"); pg.wait_for_timeout(900)
    bg = pg.evaluate("getComputedStyle(document.querySelector('.main')).backgroundColor")
    r, g, b = [int(x) for x in bg[4:-1].split(",")[:3]]
    t.ok(r == g == b and r < 20, f"dark surfaces are neutral black ({bg})")
    pg.context.close()

    strength = {}
    for grain in (0.8, 1.0):
        p = t.page({"grain": grain, "grainAnim": True})
        p.goto(s.url + "/"); p.wait_for_timeout(900)
        stats = []
        for _ in range(10):
            img = Image.open(io.BytesIO(p.screenshot(clip={"x": 1120, "y": 560, "width": 200, "height": 140}))).convert("L")
            stats.append(ImageStat.Stat(img))
            p.wait_for_timeout(50)
        strength[grain] = stats[0].stddev[0]
        spread = max(x.mean[0] for x in stats) - min(x.mean[0] for x in stats)
        t.ok(spread < 0.5, f"grain at {int(grain * 100)}% doesn't flicker (brightness spread {spread:.2f})")
        p.context.close()
    t.ok(strength[1.0] > strength[0.8] * 1.25, f"grain is stronger at the top of the slider ({strength[0.8]:.2f} → {strength[1.0]:.2f})")

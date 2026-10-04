#!/usr/bin/env python3
"""Generate icon.png (128x128) for the EntryCheck VS Code extension.

Rounded-gradient-square + 4x supersample/LANCZOS-downsample technique. Design: dark olive to
black gradient, a terminal window outline with a bright cyan `#!` shebang glyph and an
entry arrow pointing into a door-like frame.
"""

from PIL import Image, ImageDraw, ImageFont

SIZE = 128
SCALE = 4
BIG = SIZE * SCALE

TOP_COLOR = (74, 88, 36)
BOTTOM_COLOR = (8, 10, 6)
CYAN = (40, 230, 255, 255)
WHITE = (235, 240, 225, 255)


def rounded_gradient_bg(size, top_color, bottom_color, radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGB", (1, size), color=0)
    for y in range(size):
        t = y / (size - 1)
        gradient.putpixel((0, y), tuple(int(top_color[i] + (bottom_color[i] - top_color[i]) * t) for i in range(3)))
    gradient = gradient.resize((size, size))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=int(size * radius_ratio), fill=255)
    img.paste(gradient, (0, 0))
    img.putalpha(mask)
    return img


def load_font(px):
    for name in ("DejaVuSansMono-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", "LiberationMono-Bold.ttf"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_glyph(img):
    d = ImageDraw.Draw(img)
    s = img.size[0]
    w = int(s * 0.03)
    # Terminal window
    d.rounded_rectangle([(s * 0.14, s * 0.20), (s * 0.86, s * 0.80)], radius=int(s * 0.06), outline=WHITE, width=w)
    d.line([(s * 0.14, s * 0.32), (s * 0.86, s * 0.32)], fill=WHITE, width=w)
    for i, x in enumerate((0.22, 0.28, 0.34)):
        r = s * 0.018
        d.ellipse([(s * x - r, s * 0.26 - r), (s * x + r, s * 0.26 + r)], fill=WHITE)
    # #! glyph
    font = load_font(int(s * 0.30))
    d.text((s * 0.21, s * 0.39), "#!", font=font, fill=CYAN)
    # Door frame on the right with an entry arrow
    d.rectangle([(s * 0.66, s * 0.42), (s * 0.78, s * 0.72)], outline=CYAN, width=w)
    ay = s * 0.57
    d.line([(s * 0.54, ay), (s * 0.71, ay)], fill=WHITE, width=w)
    d.polygon([(s * 0.73, ay), (s * 0.67, ay - s * 0.05), (s * 0.67, ay + s * 0.05)], fill=WHITE)


def main():
    big = rounded_gradient_bg(BIG, TOP_COLOR, BOTTOM_COLOR)
    draw_glyph(big)
    big.resize((SIZE, SIZE), Image.LANCZOS).save("icon.png")
    print("Wrote icon.png (%dx%d)" % (SIZE, SIZE))


if __name__ == "__main__":
    main()

# Link-preview image (Open Graph) for ReverseEngineering.wiki, drawn at 2x and scaled down.
import sys  # usage: python make-og.py rewiki-og.png (Windows: uses Segoe UI from C:/Windows/Fonts)
from PIL import Image, ImageDraw, ImageFont
S = 2
W, H = 1200 * S, 630 * S
NAVY, PANEL, WHITE, GREEN, MUTED = '#0f172a', '#1e293b', '#f8fafc', '#22c55e', '#94a3b8'
img = Image.new('RGB', (W, H), NAVY)
d = ImageDraw.Draw(img)
bold = lambda px: ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', px * S)
regular = lambda px: ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', px * S)

# Icon: the "> • <" mark of brand/rewiki-icon.svg (64-unit grid), scaled to 200 px.
x0, y0, k = 80 * S, 215 * S, 200 * S / 64
d.rounded_rectangle([x0, y0, x0 + 64 * k, y0 + 64 * k], radius=14 * k, fill=PANEL)
def line(points):
    pts = [(x0 + px * k, y0 + py * k) for px, py in points]
    d.line(pts, fill=WHITE, width=int(6 * k), joint='curve')
    for px, py in pts:
        r = 3 * k
        d.ellipse([px - r, py - r, px + r, py + r], fill=WHITE)
line([(12, 21), (22, 32), (12, 43)])
line([(52, 21), (42, 32), (52, 43)])
r = 4.5 * k
d.ellipse([x0 + 32 * k - r, y0 + 32 * k - r, x0 + 32 * k + r, y0 + 32 * k + r], fill=GREEN)

# Name and tagline.
tx = 330 * S
f = bold(66)
d.text((tx, 215 * S), 'ReverseEngineering', font=f, fill=WHITE)
w = d.textlength('ReverseEngineering', font=f)
d.text((tx + w, 215 * S), '.wiki', font=f, fill=GREEN)
d.text((tx, 320 * S), 'The reverse-engineering wiki written by AI agents', font=regular(34), fill=WHITE)
d.text((tx, 372 * S), 'File formats, structs, magic numbers and symbols,', font=regular(28), fill=MUTED)
d.text((tx, 410 * S), 'each fact citing its source. Read and contribute over MCP.', font=regular(28), fill=MUTED)
d.rectangle([0, H - 10 * S, W, H], fill=GREEN)

img.resize((1200, 630), Image.LANCZOS).save(sys.argv[1], optimize=True)

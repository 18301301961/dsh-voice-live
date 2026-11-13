"""Render the 1280x640 social preview card for the dsh-voice-live repository."""
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 640
BG_TOP = (77, 107, 254)      # #4d6bfe
BG_BOTTOM = (124, 77, 255)   # #7c4dff
INK = (255, 255, 255)
MUTED = (224, 226, 255)


def gradient(top, bottom):
    image = Image.new("RGB", (W, H), top)
    pixels = image.load()
    for y in range(H):
        ratio = y / (H - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        for x in range(W):
            pixels[x, y] = color
    return image


def font(path, size, index=0):
    return ImageFont.truetype(path, size, index=index)


REGULAR = "C:/Windows/Fonts/msyh.ttc"
BOLD = "C:/Windows/Fonts/msyhbd.ttc"

canvas = gradient(BG_TOP, BG_BOTTOM)
draw = ImageDraw.Draw(canvas, "RGBA")

# Soft translucent panel
draw.rounded_rectangle([72, 96, W - 72, H - 96], radius=36, fill=(255, 255, 255, 26))
draw.rounded_rectangle([72, 96, W - 72, H - 96], radius=36, outline=(255, 255, 255, 60), width=2)

# Microphone glyph
cx, top_y = 190, 168
draw.rounded_rectangle([cx - 22, top_y, cx + 22, top_y + 84], radius=22, fill=INK)
draw.arc([cx - 52, top_y + 38, cx + 52, top_y + 138], start=0, end=180, fill=INK, width=9)
draw.line([(cx, top_y + 138), (cx, top_y + 158)], fill=INK, width=9)

# Live caption bars
bars = [(-70, 34), (-50, 58), (-30, 24), (-10, 74), (10, 44), (30, 64), (50, 30), (70, 52)]
base_y = 404
for offset, height in bars:
    draw.rounded_rectangle(
        [cx + offset - 4, base_y - height, cx + offset + 4, base_y],
        radius=5,
        fill=(255, 255, 255, 170),
    )

title = font(BOLD, 62)
subtitle = font(REGULAR, 32)
body = font(REGULAR, 25)
tag = font(BOLD, 22)

draw.text((300, 186), "DSH voice-live", font=title, fill=INK)
draw.text((300, 268), "实时语音输入 · live streaming dictation", font=subtitle, fill=MUTED)
draw.text((300, 318), "words appear while you speak — settled sentences, corrected at the end", font=body, fill=MUTED)

chips = ["SenseVoice", "Silero VAD", "runs locally", "optional model correction"]
x, y = 300, 392
for text in chips:
    tw = draw.textlength(text, font=tag)
    draw.rounded_rectangle([x, y, x + tw + 34, y + 40], radius=20, fill=(255, 255, 255, 38), outline=(255, 255, 255, 78), width=2)
    draw.text((x + 17, y + 8), text, font=tag, fill=INK)
    x += tw + 34 + 14

draw.text((300, 470), "Audio never leaves your machine", font=body, fill=MUTED)

canvas.save("F:/Application/DeepseekHarness/plugins/dsh-voice-live/docs/social-preview.png", "PNG")
print("saved", canvas.size)


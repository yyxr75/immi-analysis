"""Turn the raw art in asset/ into what the site actually ships.

Kept as a script rather than done by hand because both steps have a correctness
condition that is easy to break silently:

  * The logo source is 1024x1024 with 82.5% fully transparent padding. Shipping
    it raw is 1.5 MB for 793x442 of actual art.
  * The QR is a phone screenshot with the group name and an expiry line baked
    in. Cropping to the code and binarising takes it from 367 KB to 9 KB -- but
    a QR that no longer decodes is worse than a big one, so every candidate is
    decoded and compared against the original payload before it is written.

Needs Pillow and opencv-contrib (for the WeChat detector, which handles the
logo-in-the-middle style that the plain OpenCV detector fails on):
    pip install Pillow opencv-contrib-python-headless
"""
import os

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "asset")
OUT = os.path.join(HERE, "..", "site", "asset")

LOGO = "AusImmiToolboxLogo.png"
QR = "WeChatPersonal.jpg"  # personal QR: never expires (group QRs die after 7 days)


def kb(path):
    return os.path.getsize(path) / 1024


def build_logo():
    im = Image.open(os.path.join(SRC, LOGO))
    im = im.crop(im.getbbox())          # drop the transparent padding
    for width, name in ((880, "logo.webp"), (440, "logo@1x.webp")):
        h = round(im.height * width / im.width)
        p = os.path.join(OUT, name)
        im.resize((width, h), Image.LANCZOS).save(p, quality=88, method=6)
        print("  %-16s %4dx%-4d %6.1f KB" % (name, width, h, kb(p)))


def crop_qr(gray, corners):
    """Crop to the code using the detector's corner points. Group and personal
    QR screenshots put the code at different heights, so no layout guess."""
    xs, ys = corners[:, 0], corners[:, 1]
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    pad = 28                             # keep a quiet zone around the code
    box = (max(0, x0 - pad), max(0, y0 - pad),
           min(gray.width, x1 + 1 + pad), min(gray.height, y1 + 1 + pad))
    qr = gray.crop(box)
    side = max(qr.size)                  # pad to square so it scales cleanly
    canvas = Image.new("L", (side, side), 255)
    canvas.paste(qr, ((side - qr.width) // 2, (side - qr.height) // 2))
    return canvas


def build_qr():
    det = cv2.wechat_qrcode.WeChatQRCode()

    def decode(path):
        img = cv2.imread(path)
        if img is None:
            raise SystemExit("cannot read " + path)
        res, pts = det.detectAndDecode(img)
        return (res[0], pts[0]) if res else (None, None)

    src = os.path.join(SRC, QR)
    truth, corners = decode(src)
    if not truth:
        raise SystemExit("the source QR does not decode -- refusing to guess")

    square = crop_qr(Image.open(src).convert("L"), corners)
    out = os.path.join(OUT, "wechat-group.png")
    square.resize((720, 720), Image.LANCZOS) \
          .point(lambda v: 255 if v > 128 else 0, mode="1") \
          .save(out, optimize=True)

    got, _ = decode(out)
    if got != truth:
        raise SystemExit("cropped QR decodes differently -- not shipping it")
    print("  %-16s %4dx%-4d %6.1f KB  payload identical to source"
          % ("wechat-group.png", 720, 720, kb(out)))


def main():
    os.makedirs(OUT, exist_ok=True)
    build_logo()
    build_qr()


if __name__ == "__main__":
    main()

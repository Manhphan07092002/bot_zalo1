from PIL import Image, ImageEnhance, ImageFilter, ImageOps, ImageChops
import sys

src = sys.argv[1]
dst = sys.argv[2]

img = Image.open(src).convert('RGB')

# remove surrounding blank/chat margins by cropping to non-white content
bg = Image.new(img.mode, img.size, (255, 255, 255))
diff = ImageChops.difference(img, bg)
bbox = diff.getbbox()
if bbox:
    left, top, right, bottom = bbox
    pad = 20
    left = max(0, left - pad)
    top = max(0, top - pad)
    right = min(img.width, right + pad)
    bottom = min(img.height, bottom + pad)
    img = img.crop((left, top, right, bottom))

# upscale 2.5x for small screenshots/tables
resample = getattr(Image, 'Resampling', Image)
img = img.resize((int(img.width * 2.5), int(img.height * 2.5)), resample.LANCZOS)

# grayscale + autocontrast + sharpen
img = ImageOps.grayscale(img)
img = ImageOps.autocontrast(img)
img = img.filter(ImageFilter.MedianFilter(size=3))
img = ImageEnhance.Contrast(img).enhance(1.5)
img = ImageEnhance.Sharpness(img).enhance(2.2)

img.save(dst, format='JPEG', quality=95, optimize=True)
print(dst)

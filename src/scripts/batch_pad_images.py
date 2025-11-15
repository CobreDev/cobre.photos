#!/usr/bin/env python3

import os
import sys
import glob
from PIL import Image

def pad_to_instagram(
    img: Image.Image,
    target_size=(1440, 1800),
    min_whitespace_ratio=0.05,
    background_color=(242, 242, 242)
) -> Image.Image:
    """
    Resize the image to fit within target_size (width, height),
    preserving aspect ratio. Then pad with background color so that
    at least min_whitespace_ratio whitespace exists along each dimension.
    """
    target_w, target_h = target_size
    iw, ih = img.size

    # Calculate minimum total padding for width and height
    pad_total_w = int(target_w * min_whitespace_ratio)
    pad_total_h = int(target_h * min_whitespace_ratio)

    # Determine maximum content dimensions
    max_w = target_w - 2 * pad_total_w
    max_h = target_h - 2 * pad_total_h

    img_ratio = iw / ih
    box_ratio = max_w / max_h

    if img_ratio > box_ratio:
        new_w = max_w
        new_h = int(max_w / img_ratio)
    else:
        new_h = max_h
        new_w = int(max_h * img_ratio)

    resized = img.resize((new_w, new_h), Image.LANCZOS)

    # Create padded canvas
    canvas = Image.new("RGB", (target_w, target_h), background_color)
    x = (target_w - new_w) // 2
    y = (target_h - new_h) // 2
    canvas.paste(resized, (x, y))
    return canvas

def process_directory(input_dir: str):
    output_dir = os.path.join(input_dir, "output")
    os.makedirs(output_dir, exist_ok=True)

    patterns = ["*.jpg", "*.jpeg", "*.png", "*.bmp", "*.tiff", "*.webp"]
    files = []
    for pat in patterns:
        files.extend(glob.glob(os.path.join(input_dir, pat)))

    if not files:
        print("No images found in:", input_dir)
        return

    print(f"Processing {len(files)} images...")
    for f in files:
        try:
            img = Image.open(f)
            padded = pad_to_instagram(img)
            fname = os.path.basename(f)
            save_path = os.path.join(output_dir, fname)
            padded.save(save_path, quality=95)
            print("  →", fname)
        except Exception as e:
            print(f"  ! Error processing {f}: {e}")

    print(f"\nFinished! Edited images are saved in:\n{output_dir}")

def main():
    if len(sys.argv) != 2:
        print("Usage: python batch_pad_images.py /path/to/images/")
        sys.exit(1)
    input_dir = sys.argv[1]
    if not os.path.isdir(input_dir):
        print("Error: Not a valid directory:", input_dir)
        sys.exit(1)
    process_directory(input_dir)

if __name__ == "__main__":
    main()

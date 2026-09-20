#!/usr/bin/env python3
"""Mirror a curated set of Google Fonts onto the AI-Saturn OSS bucket.

fonts.googleapis.com is unreachable from the mainland, and so is Google's own
fonts.googleapis.cn mirror, so the editor's font picker lists 1920 families
that can never load. This copies the ones we actually need onto the bucket the
Whisper weights already live on.

Google serves a per-family stylesheet whose @font-face rules point at woff2
files on fonts.gstatic.com, split by unicode-range. CJK families come back as
90-230 subsets because the glyph set is enormous. We upload every subset, then
upload a rewritten copy of the stylesheet whose URLs point at the CDN.

The stylesheet is fetched through the local proxy because only Google is
blocked; the uploads deliberately bypass it, since OSS is domestic and routing
those through a tunnel only makes them slower.

Credentials come from OSS_AK / OSS_SK in the environment.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from email.utils import formatdate

AK = os.environ["OSS_AK"]
SK = os.environ["OSS_SK"]
BUCKET = "saturndf-oss"
ENDPOINT = "oss-cn-beijing.aliyuncs.com"
CDN = "https://cdn-saturndf.xiaotuxp.com"

FILES_PREFIX = "uploads/fonts/files/"
CSS_PREFIX = "uploads/fonts/css/"

ATLAS = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "public", "fonts",
    "font-atlas.json",
)
# Records every key already pushed, so an interrupted run resumes instead of
# re-uploading the thousands of subsets it got through.
MANIFEST = "/tmp/font_mirror_manifest.json"

# A desktop Chrome UA is required: css2 hands older agents ttf instead of the
# woff2 subsets, which would multiply the transfer size several times over.
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

CJK = [
    "Noto Sans SC", "Noto Serif SC", "Noto Sans TC", "Noto Serif TC",
    "Noto Sans HK", "Noto Sans JP", "Noto Sans KR",
    "LXGW WenKai TC", "LXGW WenKai Mono TC", "LXGW Marker Gothic",
    "ZCOOL KuaiLe", "ZCOOL QingKe HuangYou", "ZCOOL XiaoWei",
    "Ma Shan Zheng", "Zhi Mang Xing", "Liu Jian Mao Cao", "Long Cang",
]

LATIN = [
    "Inter", "Roboto", "Open Sans", "Montserrat", "Lato", "Poppins",
    "Raleway", "Oswald", "Merriweather", "Playfair Display", "Nunito",
    "Source Sans 3", "Ubuntu", "Rubik", "Work Sans", "Bebas Neue", "Anton",
    "Barlow", "Karla", "Manrope", "DM Sans", "Space Grotesk", "Josefin Sans",
    "Quicksand", "Fira Sans", "PT Sans", "Noto Sans", "Noto Serif",
    "Libre Baskerville", "Archivo", "Cormorant Garamond", "Dancing Script",
    "Pacifico", "Lobster", "Caveat",
]

CONTENT_TYPES = {".woff2": "font/woff2", ".css": "text/css; charset=utf-8"}


def sign(*, verb, content_type, date, resource):
    # OSS V1: VERB\nContent-MD5\nContent-Type\nDate\nCanonicalizedResource.
    string_to_sign = f"{verb}\n\n{content_type}\n{date}\n{resource}"
    digest = hmac.new(SK.encode(), string_to_sign.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def put(*, key, body, suffix):
    """PUT bytes to OSS. Content-Type matters here more than usual: a woff2
    served as octet-stream still works, but a stylesheet served as anything
    other than text/css is ignored by the browser outright."""
    content_type = CONTENT_TYPES[suffix]
    date = formatdate(usegmt=True)
    signature = sign(
        verb="PUT", content_type=content_type, date=date,
        resource=f"/{BUCKET}/{key}",
    )
    result = subprocess.run(
        [
            "curl", "-s", "--noproxy", "*", "-T", "-",
            "-H", f"Date: {date}",
            "-H", f"Content-Type: {content_type}",
            "-H", f"Authorization: OSS {AK}:{signature}",
            "-H", "Expect:",
            "-o", "/dev/null", "-w", "%{http_code}",
            "--max-time", "120", "--retry", "2",
            f"https://{BUCKET}.{ENDPOINT}/{key}",
        ],
        input=body, capture_output=True,
    )
    return result.stdout.decode().strip()


def fetch_google(url):
    result = subprocess.run(
        ["curl", "-s", "-m", "60", "--retry", "3", "-A", UA, url],
        capture_output=True,
    )
    return result.stdout


def css_url(family, weights):
    encoded = family.replace(" ", "+")
    if weights:
        return (
            f"https://fonts.googleapis.com/css2?family={encoded}"
            f":wght@{';'.join(weights)}&display=swap"
        )
    return f"https://fonts.googleapis.com/css2?family={encoded}&display=swap"


def mirror(family, weights, done):
    css = fetch_google(css_url(family, weights)).decode("utf-8", "replace")

    # Some atlas weight lists include values css2 rejects for that family; the
    # plain request without a wght axis always resolves.
    if "@font-face" not in css:
        css = fetch_google(css_url(family, None)).decode("utf-8", "replace")
    if "@font-face" not in css:
        return family, 0, 0, "无法获取样式表"

    urls = sorted(set(re.findall(r"https://fonts\.gstatic\.com/s/[^)]+\.woff2", css)))
    if not urls:
        return family, 0, 0, "样式表里没有 woff2"

    total = [0]

    def one(url):
        key = FILES_PREFIX + url.split("/s/", 1)[1]
        if key in done:
            return True
        body = subprocess.run(
            ["curl", "-s", "-m", "120", "--retry", "3", "-A", UA, url],
            capture_output=True,
        ).stdout
        if not body:
            return False
        if put(key=key, body=body, suffix=".woff2") != "200":
            return False
        total[0] += len(body)
        done.add(key)
        return True

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(one, urls))

    if not all(results):
        return family, len(urls), total[0], f"{results.count(False)} 个分片失败"

    rewritten = css.replace("https://fonts.gstatic.com/s/", f"{CDN}/{FILES_PREFIX}")
    # Underscores, not the '+' Google uses: OSS form-decodes '+' in the request
    # path before it checks the signature, so a key containing one is signed as
    # a space on their side and every PUT comes back SignatureDoesNotMatch.
    css_key = CSS_PREFIX + family.replace(" ", "_") + ".css"
    if put(key=css_key, body=rewritten.encode(), suffix=".css") != "200":
        return family, len(urls), total[0], "样式表上传失败"

    return family, len(urls), total[0], "OK"


def main():
    atlas = json.load(open(ATLAS))["fonts"]
    done = set(json.load(open(MANIFEST))) if os.path.exists(MANIFEST) else set()

    families = [f for f in CJK + LATIN if f in atlas]
    missing = [f for f in CJK + LATIN if f not in atlas]
    if missing:
        print(f"不在字体图集里，跳过: {missing}\n")

    hosted, grand = [], 0
    for i, family in enumerate(families, 1):
        weights = atlas[family].get("s") or []
        name, count, size, status = mirror(family, weights, done)
        mark = "OK" if status == "OK" else status
        print(
            f"[{i:>2}/{len(families)}] {name:<24} {count:>4} 片 "
            f"{size / 1048576:>7.2f} MB  {mark}",
            flush=True,
        )
        json.dump(sorted(done), open(MANIFEST, "w"))
        if status == "OK":
            hosted.append(name)
            grand += size

    json.dump(hosted, open("/tmp/hosted_fonts.json", "w"), ensure_ascii=False)
    print(f"\n{len(hosted)}/{len(families)} 个字体族完成，共 {grand / 1048576:.1f} MB")
    print(f"已托管字体列表: /tmp/hosted_fonts.json")


if __name__ == "__main__":
    main()

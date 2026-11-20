"""앱 아이콘(icons/*.png)을 icons/icon.svg에서 그려요.

    python3 tools/make-icons.py      (Playwright 필요: pip install playwright && playwright install chromium)

icon.svg = 둥근 타일(512 기준 모서리 114) 위에 흰 심볼 하나. 심볼은 가운데 288px 안에 두고,
디테일은 타일 색으로 파내요. 그림을 바꾸려면 icon.svg만 고치고 다시 돌려요.
- app-*.png          둥근 사각형 (PC·안드로이드)
- app-maskable-*.png 꽉 찬 사각형 (기기가 알아서 동그랗게·둥글게 자름)
- apple-touch-icon   꽉 찬 사각형, 투명 없음 (아이폰). icons/apple-touch-icon.png가 있는 앱만
"""
import asyncio
import re
from pathlib import Path

from playwright.async_api import async_playwright

ICONS = Path(__file__).resolve().parent.parent / 'icons'
SVG = (ICONS / 'icon.svg').read_text(encoding='utf-8')
SQUARE = re.sub(r'rx="\d+"', 'rx="0"', SVG, count=1)  # 맨 앞 타일만 모서리 없이 (심볼 안 둥근 모서리는 그대로)

JOBS = [
    ('app-192.png', SVG, 192), ('app-512.png', SVG, 512),
    ('app-maskable-192.png', SQUARE, 192), ('app-maskable-512.png', SQUARE, 512),
]
if (ICONS / 'apple-touch-icon.png').exists():
    JOBS.append(('apple-touch-icon.png', SQUARE, 180))


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page()
        for name, svg, size in JOBS:
            await pg.set_viewport_size({'width': size, 'height': size})
            await pg.set_content(f'<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{size}px;height:{size}px}}</style>{svg}')
            await pg.screenshot(path=str(ICONS / name), omit_background=name != 'apple-touch-icon.png')
            print(name)
        await b.close()

asyncio.run(main())

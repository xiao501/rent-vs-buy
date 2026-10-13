"""每月更新公開資料，輸出 data/rent.json 與 data/rate.json。

- 租金：內政部實價登錄開放資料（不動產租賃），只取「整棟(戶)出租」與「分層出租」的住家租約，
  依 縣市 > 行政區 > 房數 彙整最近 6 個月（以租賃日期計）的中位數、平均值與筆數。
- 利率：中央銀行「五大銀行新承做放款金額與利率」表中的購屋貸款利率，取最新一期。

用法：python scripts/update_data.py [輸出資料夾，預設 data]
"""

import csv
import io
import json
import re
import ssl
import statistics
import sys
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

UA = {"User-Agent": "Mozilla/5.0 (rent-vs-buy data updater)"}
TZ = timezone(timedelta(hours=8))

LVR_SEASON_URL = "https://plvr.land.moi.gov.tw/DownloadSeason?season={season}&type=zip&fileName=lvr_landcsv.zip"
LVR_CURRENT_URL = "https://plvr.land.moi.gov.tw/Download?type=zip&fileName=lvr_landcsv.zip"
CBC_PAGE_URL = "https://www.cbc.gov.tw/tw/cp-528-1079-B4682-1.html"

WINDOW_MONTHS = 6
# 租約登錄有 1～2 個月延遲，視窗結束在「本月往前 2 個月」，避免最後一個月筆數不完整
WINDOW_END_LAG = 2
SEASONS_TO_FETCH = 4

COUNTY_BY_LETTER = {
    "a": "臺北市", "b": "臺中市", "c": "基隆市", "d": "臺南市", "e": "高雄市",
    "f": "新北市", "g": "宜蘭縣", "h": "桃園市", "i": "嘉義市", "j": "新竹縣",
    "k": "苗栗縣", "m": "南投縣", "n": "彰化縣", "o": "新竹市", "p": "雲林縣",
    "q": "嘉義縣", "t": "屏東縣", "u": "花蓮縣", "v": "臺東縣", "w": "金門縣",
    "x": "澎湖縣", "z": "連江縣",
}
# 排除獨立套房、分租套房、分租雅房，只留整戶或整層出租
WHOLE_UNIT_TYPES = {"整棟(戶)出租", "分層出租"}
RENTAL_CSV = re.compile(r"^([a-z])_lvr_land_c\.csv$")


# 政府網站憑證缺 Subject Key Identifier，Python 3.13+ 的嚴格模式會拒絕；
# 仍照常驗證憑證鏈與主機名稱，只關掉這個嚴格檢查
SSL_CTX = ssl.create_default_context()
SSL_CTX.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)


def fetch(url, timeout=180):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as resp:
        return resp.read()


def add_months(year, month, delta):
    idx = year * 12 + (month - 1) + delta
    return idx // 12, idx % 12 + 1


def recent_seasons(today, count):
    """回傳民國年季別代碼，由近到遠，例如 ['115S3', '115S2', ...]。"""
    roc = today.year - 1911
    q = (today.month - 1) // 3 + 1
    out = []
    for _ in range(count + 1):  # 多抓一季，因為本季通常還沒發布
        q -= 1
        if q == 0:
            roc, q = roc - 1, 4
        out.append(f"{roc}S{q}")
    return out


def read_rental_rows(zip_bytes):
    """從實價登錄 zip 讀出所有縣市的租賃主表，產生 (縣市, dict) 。"""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            m = RENTAL_CSV.match(name.lower())
            if not m or m.group(1) not in COUNTY_BY_LETTER:
                continue
            text = zf.read(name).decode("utf-8-sig", errors="replace")
            reader = csv.reader(io.StringIO(text))
            header = next(reader, None)
            if not header:
                continue
            next(reader, None)  # 第二列是英文欄名
            for row in reader:
                yield COUNTY_BY_LETTER[m.group(1)], dict(zip(header, row))


def parse_roc_month(value):
    """'1150821' -> (2026, 8)；格式不對回傳 None。"""
    value = (value or "").strip()
    if not re.fullmatch(r"\d{6,7}", value):
        return None
    roc, month = int(value[:-4]), int(value[-4:-2])
    if not 1 <= month <= 12:
        return None
    return roc + 1911, month


def to_int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def build_rent(today):
    zips, sources = [], []
    for season in recent_seasons(today, SEASONS_TO_FETCH):
        if len(zips) >= SEASONS_TO_FETCH:
            break
        try:
            data = fetch(LVR_SEASON_URL.format(season=season))
        except Exception as exc:  # noqa: BLE001
            print(f"  季資料 {season} 下載失敗：{exc}")
            continue
        if not zipfile.is_zipfile(io.BytesIO(data)):
            print(f"  季資料 {season} 尚未發布，略過")
            continue
        print(f"  季資料 {season}：{len(data) // 1024} KB")
        zips.append(data)
        sources.append(season)
    if not zips:
        raise RuntimeError("找不到任何實價登錄季資料，下載網址或格式可能已變更")
    try:
        data = fetch(LVR_CURRENT_URL)
        if zipfile.is_zipfile(io.BytesIO(data)):
            zips.append(data)
            sources.append("本期")
            print(f"  本期資料：{len(data) // 1024} KB")
    except Exception as exc:  # noqa: BLE001
        print(f"  本期資料下載失敗，只用季資料：{exc}")

    end = add_months(today.year, today.month, -WINDOW_END_LAG)
    start = add_months(*end, -(WINDOW_MONTHS - 1))

    seen = set()
    groups = {}
    total = 0
    for data in zips:
        for county, row in read_rental_rows(data):
            serial = row.get("編號", "")
            if serial in seen:
                continue
            seen.add(serial)
            if row.get("出租型態") not in WHOLE_UNIT_TYPES:
                continue
            if "房屋" not in row.get("交易標的", ""):
                continue
            if "住" not in row.get("主要用途", ""):
                continue
            ym = parse_roc_month(row.get("租賃年月日"))
            if not ym or not (start <= ym <= end):
                continue
            rooms = to_int(row.get("建物現況格局-房"))
            if rooms <= 0:
                continue
            # 有含車位的租約，扣掉車位租金，只比較房屋本身
            rent = to_int(row.get("總額元")) - to_int(row.get("車位總額元"))
            if rent < 1000 or rent > 1_000_000:
                continue
            district = row.get("鄉鎮市區", "").strip()
            if not district:
                continue
            key = str(min(rooms, 4))  # 4 代表 4 房以上
            groups.setdefault(county, {}).setdefault(district, {}).setdefault(key, []).append(rent)
            total += 1

    if total == 0:
        raise RuntimeError("篩選後沒有任何租約，欄位名稱或格式可能已變更")

    counties = {}
    for county in COUNTY_BY_LETTER.values():
        if county not in groups:
            continue
        counties[county] = {
            district: {
                rooms: {
                    "median": round(statistics.median(vals)),
                    "mean": round(statistics.fmean(vals)),
                    "n": len(vals),
                }
                for rooms, vals in sorted(by_rooms.items())
            }
            for district, by_rooms in sorted(groups[county].items())
        }

    print(f"  租約共 {total} 筆，{start[0]}-{start[1]:02d} ~ {end[0]}-{end[1]:02d}")
    return {
        "source": "內政部實價登錄開放資料（不動產租賃）",
        "sourceUrl": "https://plvr.land.moi.gov.tw/DownloadOpenData",
        "filter": "整棟(戶)出租與分層出租、住家用途；含車位者扣除車位租金；4 代表 4 房以上",
        "window": {"from": f"{start[0]}-{start[1]:02d}", "to": f"{end[0]}-{end[1]:02d}"},
        "files": sources,
        "updated": datetime.now(TZ).strftime("%Y-%m-%d"),
        "counties": counties,
    }


def build_rate():
    page = fetch(CBC_PAGE_URL).decode("utf-8", errors="replace")
    links = dict(
        (title.lower(), href)
        for href, title in re.findall(r'href="([^"]+)"[^>]*title="([^"]+)"', page)
    )
    ods_url = next((u for t, u in links.items() if t.endswith(".ods")), None)
    if not ods_url:
        raise RuntimeError("央行頁面找不到 ODS 下載連結，頁面格式可能已變更")
    print(f"  央行 ODS：{ods_url}")

    import pandas as pd  # 只有利率需要，延後載入

    df = pd.read_excel(io.BytesIO(fetch(ods_url)), engine="odf", header=None)
    latest = None
    for _, row in df.iterrows():
        m = re.fullmatch(r"\s*(\d{2,3})\s*/\s*(\d{1,2})\s*", str(row[0]))
        if not m:
            continue
        try:
            rate = float(row[2])  # 第 3 欄：購屋貸款利率
        except (TypeError, ValueError):
            continue
        if rate != rate or not 0 < rate < 20:  # NaN 或不合理
            continue
        latest = (int(m.group(1)) + 1911, int(m.group(2)), rate)
    if not latest:
        raise RuntimeError("央行表格解析不到購屋貸款利率，欄位可能已變更")
    year, month, rate = latest
    print(f"  購屋貸款利率 {year}-{month:02d}：{rate}%")
    return {
        "source": "中央銀行・五大銀行新承做購屋貸款平均利率",
        "sourceUrl": CBC_PAGE_URL,
        "month": f"{year}-{month:02d}",
        "rate": rate,
        "updated": datetime.now(TZ).strftime("%Y-%m-%d"),
    }


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "data")
    out.mkdir(parents=True, exist_ok=True)
    today = datetime.now(TZ).date()

    print("更新利率…")
    rate = build_rate()
    (out / "rate.json").write_text(json.dumps(rate, ensure_ascii=False, indent=1), encoding="utf-8")

    print("更新租金…")
    rent = build_rent(today)
    (out / "rent.json").write_text(json.dumps(rent, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("完成")


if __name__ == "__main__":
    main()

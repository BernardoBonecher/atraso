"""Download the raw inputs: ANAC VRA monthly files and the OurAirports airport list.

Usage:
    python pipeline/fetch.py              # last 12 published months (default window below)
    python pipeline/fetch.py 2025-09 2026-08

Files that already exist in data/raw are skipped.
"""

import sys
import urllib.parse
import urllib.request
from pathlib import Path

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"

VRA_BASE = "https://sistemas.anac.gov.br/dadosabertos/Voos e operações aéreas/Voo Regular Ativo (VRA)"
MONTHS_PT = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
             "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]
AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"

DEFAULT_WINDOW = ("2025-09", "2026-08")


def months(start: str, end: str):
    y, m = map(int, start.split("-"))
    end_y, end_m = map(int, end.split("-"))
    while (y, m) <= (end_y, end_m):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def vra_url(year: int, month: int) -> str:
    folder = f"{month:02d} - {MONTHS_PT[month - 1]}"
    path = f"{VRA_BASE}/{year}/{folder}/VRA_{year}{month}.csv"
    return urllib.parse.quote(path, safe=":/")


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"skip  {dest.name}")
        return
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as resp, open(tmp, "wb") as out:
        out.write(resp.read())
    tmp.replace(dest)
    print(f"saved {dest.name} ({dest.stat().st_size / 1e6:.1f} MB)")


def main(argv: list[str]) -> None:
    start, end = argv[1:3] if len(argv) >= 3 else DEFAULT_WINDOW
    RAW.mkdir(parents=True, exist_ok=True)
    for y, m in months(start, end):
        download(vra_url(y, m), RAW / f"VRA_{y}{m}.csv")
    download(AIRPORTS_URL, RAW / "airports.csv")


if __name__ == "__main__":
    main(sys.argv)

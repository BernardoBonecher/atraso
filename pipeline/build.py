"""Turn the raw ANAC VRA files into the small JSON files the site reads.

Usage:
    python pipeline/build.py

Reads  data/raw/VRA_*.csv and data/raw/airports.csv (see fetch.py)
Writes site/data/meta.json, site/data/routes.json, site/data/heat.json

Scope and definitions (also documented in the README):
- Domestic (tipo de linha "N"), regular scheduled flights (DI "0") with a scheduled departure.
- A flight's outcome is measured on ARRIVAL against the scheduled arrival:
  on time (<= 15 min late), late (15-60 min), very late (> 60 min), or cancelled.
- ANAC times are all in Brasília time (UTC-3), whatever the airport. Hours and weekdays shown on
  the site are converted to local time at the origin airport.
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "site" / "data"

COLUMNS = ["airline", "flight", "di", "line_type", "origin", "dest",
           "dep_sched", "dep_actual", "arr_sched", "arr_actual", "status", "reason"]

OUTCOMES = ["on_time", "late", "very_late", "cancelled"]
ON_TIME_LIMIT = 15
VERY_LATE_LIMIT = 60

# Brazil has had no daylight saving time since 2019, so a fixed offset per state is exact
# for the period covered. Default is UTC-3 (Brasília).
UTC_OFFSET_BY_STATE = {"AM": -4, "MT": -4, "MS": -4, "RO": -4, "RR": -4, "AC": -5}
UTC_OFFSET_BY_AIRPORT = {"SBFN": -2, "SWEI": -5}  # Fernando de Noronha, Eirunepé (west Amazonas)

AIRLINE_NAMES = {"TAM": "LATAM", "AZU": "Azul", "GLO": "Gol", "ACN": "Azul Conecta"}
MIN_AIRLINE_FLIGHTS = 5000      # smaller operators are grouped as "Outras"
MIN_HEAT_AIRPORT_FLIGHTS = 3000  # airports with their own heatmap
MIN_ROUTE_FLIGHTS = 30           # below this a route is too thin to say anything


def read_vra(path: Path) -> pd.DataFrame:
    # First line is "Atualizado em: <date>", then the header.
    return pd.read_csv(path, sep=";", skiprows=2, names=COLUMNS, dtype=str,
                       encoding="utf-8-sig", keep_default_na=False, na_values=["", "null"])


def clean(raw: pd.DataFrame) -> pd.DataFrame:
    df = raw[(raw.line_type == "N") & (raw.di == "0") & raw.dep_sched.notna()].copy()
    for col in ["dep_sched", "dep_actual", "arr_sched", "arr_actual"]:
        # Some rows carry milliseconds ("12:25:00.000"); without ISO8601 they would silently become NaT.
        df[col] = pd.to_datetime(df[col], format="ISO8601")
    df = df[df.dep_sched.notna() & df.arr_sched.notna()]
    df = df[df.status.isin(["REALIZADO", "CANCELADO"])]
    df = df.drop_duplicates(["airline", "flight", "origin", "dep_sched"])
    realized = df.status == "REALIZADO"
    df = df[~realized | df.arr_actual.notna()]
    return df.reset_index(drop=True)


def classify(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["arr_delay"] = (df.arr_actual - df.arr_sched).dt.total_seconds() / 60
    outcome = np.select(
        [df.status == "CANCELADO", df.arr_delay <= ON_TIME_LIMIT, df.arr_delay <= VERY_LATE_LIMIT],
        ["cancelled", "on_time", "late"],
        default="very_late",
    )
    df["outcome"] = pd.Categorical(outcome, categories=OUTCOMES)
    return df


def utc_offset(icao: str, state: str | None) -> int:
    if icao in UTC_OFFSET_BY_AIRPORT:
        return UTC_OFFSET_BY_AIRPORT[icao]
    return UTC_OFFSET_BY_STATE.get(state or "", -3)


def tidy_city(name: str) -> str:
    """OurAirports mixes "Rio De Janeiro" and "Rio de Janeiro"; use Portuguese lowercase particles."""
    return " ".join(w.lower() if w.lower() in {"de", "da", "do", "das", "dos"} and i else w
                    for i, w in enumerate(name.split()))


def load_airports(codes: set[str]) -> dict[str, dict]:
    ap = pd.read_csv(RAW / "airports.csv", dtype=str, keep_default_na=False)
    ap = ap[ap.iso_country == "BR"]
    by_code: dict[str, pd.Series] = {}
    for col in ["gps_code", "icao_code", "ident"]:  # later columns win
        for _, row in ap[ap[col].isin(codes)].iterrows():
            by_code[row[col]] = row
    missing = codes - by_code.keys()
    if missing:
        raise SystemExit(f"Airports missing from airports.csv: {sorted(missing)}")
    out = {}
    for code, row in by_code.items():
        state = row.iso_region.removeprefix("BR-")
        out[code] = {
            "iata": row.iata_code or None,
            "name": row["name"],
            "city": tidy_city(row.municipality),
            "uf": state,
            "lat": round(float(row.latitude_deg), 3),
            "lon": round(float(row.longitude_deg), 3),
            "utc": utc_offset(code, state),
        }
    return out


BRASILIA_UTC = -3


def add_local_time(df: pd.DataFrame, airports: dict[str, dict]) -> pd.DataFrame:
    """ANAC reports every time in Brasília time; shift to the origin airport's own time zone."""
    df = df.copy()
    offset_h = df.origin.map({k: v["utc"] - BRASILIA_UTC for k, v in airports.items()})
    local = df.dep_sched + pd.to_timedelta(offset_h, unit="h")
    df["hour"] = local.dt.hour
    df["weekday"] = local.dt.weekday  # 0 = Monday
    df["month"] = local.dt.strftime("%Y-%m")
    return df


def outcome_counts(group: pd.DataFrame) -> list[int]:
    counts = group.outcome.value_counts()
    return [int(counts.get(o, 0)) for o in OUTCOMES]


def delay_percentiles(group: pd.DataFrame) -> list[int] | None:
    delays = group.arr_delay.dropna()
    if len(delays) < MIN_ROUTE_FLIGHTS:
        return None
    return [int(round(v)) for v in delays.quantile([0.5, 0.8, 0.95])]


def build_routes(df: pd.DataFrame) -> dict:
    routes = {}
    for (origin, dest), route in df.groupby(["origin", "dest"], sort=False):
        if len(route) < MIN_ROUTE_FLIGHTS:
            continue
        entry = {"n": len(route), "airlines": {}}
        for airline, g in route.groupby("airline_group", sort=False):
            hours = {int(h): outcome_counts(gh) for h, gh in g.groupby("hour")}
            months = {m: outcome_counts(gm) for m, gm in g.groupby("month")}
            entry["airlines"][airline] = {
                "o": outcome_counts(g),
                "p": delay_percentiles(g),
                "h": hours,
                "m": months,
            }
        routes[f"{origin}-{dest}"] = entry
    return routes


def heat_grid(df: pd.DataFrame) -> list[list[list[int]]]:
    """7 weekdays x 24 hours x [flights, late or cancelled]."""
    bad = df.outcome != "on_time"
    n = pd.crosstab(df.weekday, df.hour).reindex(index=range(7), columns=range(24), fill_value=0)
    b = pd.crosstab(df.weekday[bad], df.hour[bad]).reindex(index=range(7), columns=range(24), fill_value=0)
    return [[[int(n.iat[d, h]), int(b.iat[d, h])] for h in range(24)] for d in range(7)]


def build_heat(df: pd.DataFrame) -> dict:
    heat = {"ALL": heat_grid(df)}
    sizes = df.origin.value_counts()
    for airport in sizes[sizes >= MIN_HEAT_AIRPORT_FLIGHTS].index:
        heat[airport] = heat_grid(df[df.origin == airport])
    return heat


def build_meta(df: pd.DataFrame, airports: dict, airline_names: dict) -> dict:
    by_origin = {a: outcome_counts(g) for a, g in df.groupby("origin")}
    by_airline = {a: outcome_counts(g) for a, g in df.groupby("airline_group")}
    by_airline_month = {a: {m: outcome_counts(gm) for m, gm in g.groupby("month")}
                        for a, g in df.groupby("airline_group")}
    for code, info in airports.items():
        info["dep"] = by_origin.get(code, [0, 0, 0, 0])
    months = sorted(df.month.unique())
    return {
        "source": "ANAC — Voo Regular Ativo (VRA), dados abertos",
        "source_url": "https://www.gov.br/anac/pt-br/assuntos/dados-e-estatisticas/historico-de-voos",
        "window": [months[0], months[-1]],
        "flights": len(df),
        "outcomes": OUTCOMES,
        "limits": {"on_time": ON_TIME_LIMIT, "very_late": VERY_LATE_LIMIT, "min_route": MIN_ROUTE_FLIGHTS},
        "airlines": {code: {"name": airline_names[code], "o": by_airline[code], "m": by_airline_month[code]}
                     for code in by_airline},
        "airports": airports,
    }


def group_airlines(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    sizes = df.airline.value_counts()
    big = set(sizes[sizes >= MIN_AIRLINE_FLIGHTS].index)
    df = df.copy()
    df["airline_group"] = df.airline.where(df.airline.isin(big), "OUT")
    names = {code: AIRLINE_NAMES.get(code, code) for code in big}
    names["OUT"] = "Outras"
    return df, names


def file_months(files: list[Path]) -> tuple[str, str]:
    """VRA_20259.csv -> "2025-09"."""
    months = sorted(f"{f.stem[4:8]}-{int(f.stem[8:]):02d}" for f in files)
    return months[0], months[-1]


def write_json(name: str, data) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e3:.0f} KB)")


def main() -> None:
    files = sorted(RAW.glob("VRA_*.csv"))
    if not files:
        raise SystemExit("No VRA files in data/raw. Run pipeline/fetch.py first.")
    raw = pd.concat([read_vra(f) for f in files], ignore_index=True)
    df = classify(clean(raw))
    airports = load_airports(set(df.origin) | set(df.dest))
    df = add_local_time(df, airports)
    # A flight at 00:30 Brasília time on the 1st is still the previous month in Manaus; keep
    # only local months covered by the files so the edges are not partial months.
    window = file_months(files)
    df = df[df.month.between(*window)]
    df, airline_names = group_airlines(df)
    print(f"{len(raw):,} rows read, {len(df):,} flights kept")

    write_json("meta.json", build_meta(df, airports, airline_names))
    write_json("routes.json", build_routes(df))
    write_json("heat.json", build_heat(df))


if __name__ == "__main__":
    main()

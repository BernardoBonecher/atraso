import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import build  # noqa: E402

HEADER = ('Atualizado em: 2026-10-07\n'
          '"ICAO Empresa Aérea";"Número Voo";"Código Autorização (DI)";"Código Tipo Linha";'
          '"ICAO Aeródromo Origem";"ICAO Aeródromo Destino";"Partida Prevista";"Partida Real";'
          '"Chegada Prevista";"Chegada Real";"Situação Voo";"Código Justificativa"\n')


def row(airline="GLO", flight="1000", di="0", line="N", origin="SBPA", dest="SBGR",
        dep_sched="2026-03-10 12:00:00", dep_actual="2026-03-10 12:00:00",
        arr_sched="2026-03-10 13:30:00", arr_actual="2026-03-10 13:30:00", status="REALIZADO"):
    values = [airline, flight, di, line, origin, dest, dep_sched, dep_actual,
              arr_sched, arr_actual, status, "N/A"]
    return ";".join(f'"{v}"' for v in values) + "\n"


def write_vra(tmp_path, rows) -> Path:
    path = tmp_path / "VRA_20263.csv"
    path.write_text(HEADER + "".join(rows), encoding="utf-8-sig")
    return path


def test_read_vra_skips_update_line_and_header(tmp_path):
    df = build.read_vra(write_vra(tmp_path, [row()]))
    assert list(df.columns) == build.COLUMNS
    assert len(df) == 1
    assert df.loc[0, "reason"] == "N/A"  # not turned into NaN


def test_clean_keeps_only_domestic_regular_scheduled(tmp_path):
    rows = [
        row(flight="1"),
        row(flight="2", line="I"),                                    # international
        row(flight="3", di="6"),                                      # non-regular authorization
        row(flight="4", dep_sched="", arr_sched=""),                  # unscheduled
        row(flight="5", arr_actual=""),                               # realized without arrival time
        row(flight="6", status="CANCELADO", dep_actual="", arr_actual=""),
        row(flight="7", dep_sched="null", arr_sched="null"),                 # literal "null"
        row(flight="1"),                                              # duplicate of flight 1
    ]
    df = build.clean(build.read_vra(write_vra(tmp_path, rows)))
    assert sorted(df.flight) == ["1", "6"]


@pytest.mark.parametrize("minutes_late, expected", [
    (-20, "on_time"), (15, "on_time"), (16, "late"), (60, "late"), (61, "very_late"),
])
def test_classify_boundaries(tmp_path, minutes_late, expected):
    arrival = pd.Timestamp("2026-03-10 13:30:00") + pd.Timedelta(minutes=minutes_late)
    rows = [row(arr_actual=str(arrival))]
    df = build.classify(build.clean(build.read_vra(write_vra(tmp_path, rows))))
    assert df.loc[0, "outcome"] == expected


def test_cancelled_is_its_own_outcome(tmp_path):
    rows = [row(status="CANCELADO", dep_actual="", arr_actual="")]
    df = build.classify(build.clean(build.read_vra(write_vra(tmp_path, rows))))
    assert df.loc[0, "outcome"] == "cancelled"
    assert pd.isna(df.loc[0, "arr_delay"])


@pytest.mark.parametrize("icao, state, expected", [
    ("SBPA", "RS", -3), ("SBEG", "AM", -4), ("SBRB", "AC", -5), ("SBFN", "PE", -2), ("SWEI", "AM", -5),
])
def test_utc_offset(icao, state, expected):
    assert build.utc_offset(icao, state) == expected


def test_local_time_shifts_from_brasilia_to_origin_zone():
    # ANAC reports Brasília time everywhere. 2026-03-02 is a Monday.
    df = pd.DataFrame({
        "origin": ["SBPA", "SBEG", "SBRB", "SBFN"],
        "dep_sched": pd.to_datetime(["2026-03-02 00:30:00"] * 4),
    })
    airports = {"SBPA": {"utc": -3}, "SBEG": {"utc": -4}, "SBRB": {"utc": -5}, "SBFN": {"utc": -2}}
    out = build.add_local_time(df, airports)
    assert list(out.hour) == [0, 23, 22, 1]
    assert list(out.weekday) == [0, 6, 6, 0]     # Manaus and Rio Branco are still on Sunday
    assert list(out.month) == ["2026-03", "2026-03", "2026-03", "2026-03"]


def test_milliseconds_in_timestamps_are_kept(tmp_path):
    rows = [row(flight="1"), row(flight="2", dep_sched="2026-03-10 12:00:00.000", arr_sched="2026-03-10 13:30:00.000")]
    df = build.clean(build.read_vra(write_vra(tmp_path, rows)))
    assert sorted(df.flight) == ["1", "2"]


def test_outcome_counts_order():
    g = pd.DataFrame({"outcome": pd.Categorical(["late", "on_time", "on_time", "cancelled"],
                                                categories=build.OUTCOMES)})
    assert build.outcome_counts(g) == [2, 1, 0, 1]


def test_heat_grid_shape_and_counts():
    df = pd.DataFrame({
        "weekday": [0, 0, 6],
        "hour": [8, 8, 23],
        "outcome": ["on_time", "late", "cancelled"],
    })
    grid = build.heat_grid(df)
    assert len(grid) == 7 and all(len(day) == 24 for day in grid)
    assert grid[0][8] == [2, 1]
    assert grid[6][23] == [1, 1]
    assert grid[3][12] == [0, 0]


def test_file_months():
    files = [Path("VRA_20259.csv"), Path("VRA_202512.csv"), Path("VRA_20268.csv")]
    assert build.file_months(files) == ("2025-09", "2026-08")


@pytest.mark.parametrize("raw, expected", [
    ("Rio De Janeiro", "Rio de Janeiro"), ("São José Dos Campos", "São José dos Campos"), ("Porto Alegre", "Porto Alegre"),
])
def test_tidy_city(raw, expected):
    assert build.tidy_city(raw) == expected

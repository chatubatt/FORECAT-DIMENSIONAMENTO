import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from erlang import erlang_c, calc_sla, calc_asa, calc_occupancy, find_min_agents_for_sla, erlang_b, estimate_abandon_rate

def test_erlang_c_no_agents():
    assert erlang_c(0, 10) == 1.0

def test_erlang_c_overloaded():
    assert erlang_c(5, 10) == 1.0

def test_erlang_c_normal():
    p = erlang_c(10, 5)
    assert 0 < p < 1

def test_calc_sla_no_agents():
    assert calc_sla(1.0, 5, 10, 20, 240) == 0.0

def test_calc_occupancy():
    assert calc_occupancy(5, 10) == 50.0
    assert calc_occupancy(0, 10) == 0.0

def test_calc_asa():
    asa = calc_asa(0.5, 10, 5, 240)
    assert asa > 0

def test_find_min_agents():
    agents = find_min_agents_for_sla(100, 240, 600, 80.0, 20)
    assert agents > 0

def test_erlang_b():
    b = erlang_b(10, 5)
    assert 0 <= b <= 1

def test_estimate_abandon_rate():
    rate = estimate_abandon_rate(10, 5, 240, 60)
    assert 0 <= rate <= 1

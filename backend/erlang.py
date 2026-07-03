import numpy as np

def erlang_c(agents: int, traffic: float) -> float:
    agents = int(agents)
    if agents <= 0 or traffic <= 0:
        return 1.0
    if agents <= traffic:
        return 1.0
    invB = 1.0
    for i in range(1, agents + 1):
        invB = 1.0 + invB * (i / traffic)
    erlangB = 1.0 / invB
    prob_wait = erlangB / (1.0 - (traffic / agents) * (1.0 - erlangB))
    return max(0.0, min(1.0, prob_wait))

def calc_sla(prob_wait: float, agents: int, traffic: float, sla_time: int, tmo: int) -> float:
    if agents <= traffic or tmo <= 0:
        return 0.0
    sla = (1.0 - prob_wait * np.exp(-(agents - traffic) * (sla_time / tmo))) * 100
    return float(max(0.0, min(100.0, sla)))

def calc_asa(prob_wait: float, agents: int, traffic: float, tmo: int) -> float:
    if agents <= traffic or tmo <= 0:
        return 0.0
    asa = (prob_wait * tmo) / (agents - traffic)
    return float(asa)

def calc_occupancy(traffic: float, agents: int) -> float:
    if agents <= 0:
        return 0.0
    return float(min(100.0, (traffic / agents) * 100))

def find_min_agents_for_sla(
    volume: int, tmo: int, interval_seconds: int,
    target_sla: float, sla_time: int, max_agents: int = 500
) -> int:
    traffic = (volume / interval_seconds) * tmo
    lo, hi = 1, max(traffic + 1, 2)
    while hi <= max_agents:
        pw = erlang_c(hi, traffic)
        sla = calc_sla(pw, hi, traffic, sla_time, tmo)
        if sla >= target_sla:
            break
        hi = int(hi * 1.5) + 1
    while lo < hi:
        mid = (lo + hi) // 2
        pw = erlang_c(mid, traffic)
        sla = calc_sla(pw, mid, traffic, sla_time, tmo)
        if sla >= target_sla:
            hi = mid
        else:
            lo = mid + 1
    return lo

def erlang_b(agents: int, traffic: float) -> float:
    if agents <= 0:
        return 1.0
    if traffic <= 0:
        return 0.0
    invB = 1.0
    for i in range(1, agents + 1):
        invB = 1.0 + invB * (i / traffic)
    return 1.0 / invB

def estimate_abandon_rate(agents: int, traffic: float, tmo: int, patience_time: int) -> float:
    if agents <= traffic:
        return 1.0
    pw = erlang_c(agents, traffic)
    return float(min(1.0, max(0.0, pw * np.exp(-(agents - traffic) * (patience_time / tmo)))))

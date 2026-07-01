"""
Gera a curva de distribuição intra-diária hardcoded para fallback.
Cobre 06:00-20:00 com intervalos de 10 minutos (84 intervalos por dia).
Dias 0-4 (seg-sex): operação completa 06:00-20:00
Dia 5 (sáb): operação 06:00-17:50
Dia 6 (dom): fechado
"""

# Valores base por meia-hora (06:00-20:00 = 28 meias-horas)
curve_data_30min = {
    0: [0.4, 0.7, 1.2, 1.8, 2.5, 3.2, 3.8, 4.5, 5.0, 5.3, 5.5, 5.2, 4.8, 4.6, 5.0, 5.2, 5.8, 5.3, 4.5, 4.0, 3.2, 2.8, 2.0, 1.2, 0.8, 0.5, 0.3, 0.1],
    1: [0.5, 0.8, 1.3, 2.0, 2.8, 3.5, 4.0, 4.8, 5.2, 5.5, 5.8, 5.5, 5.0, 4.8, 5.2, 5.5, 5.5, 5.0, 4.2, 3.8, 3.0, 2.5, 1.8, 1.0, 0.6, 0.4, 0.2, 0.1],
    2: [0.4, 0.8, 1.4, 2.2, 3.0, 3.8, 4.2, 5.0, 5.5, 5.8, 5.5, 5.3, 5.0, 5.0, 5.3, 5.0, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0, 2.2, 1.5, 1.0, 0.6, 0.3, 0.1],
    3: [0.5, 0.9, 1.5, 2.3, 3.2, 4.0, 4.5, 5.2, 5.5, 5.5, 5.2, 5.0, 4.8, 4.8, 5.0, 5.3, 5.8, 5.5, 4.8, 4.2, 3.5, 3.0, 2.0, 1.2, 0.8, 0.5, 0.2, 0.1],
    4: [0.5, 0.9, 1.5, 2.5, 3.5, 4.2, 4.8, 5.5, 5.8, 5.5, 5.2, 5.5, 5.3, 4.5, 5.0, 4.8, 5.0, 4.8, 4.2, 3.8, 3.2, 2.8, 2.0, 1.2, 0.8, 0.5, 0.3, 0.1],
    5: [0.5, 1.0, 1.8, 3.0, 4.2, 5.5, 6.0, 6.5, 6.2, 5.8, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0, 2.2, 1.5, 0.8, 0.3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    6: [0.0]*28,
}

out = "HARDCODED_CURVE = {\n"
for day in range(7):
    values = curve_data_30min[day]
    out += f"    {day}: {{\n"

    # Gerar TODOS os intervalos de 10 min de 06:00 a 19:50
    intervals_10 = []
    for h in range(6, 20):
        for m in [0, 10, 20, 30, 40, 50]:
            intervals_10.append(f"{h:02d}:{m:02d}")

    # Normalizar os valores 30-min para somar 1.0
    total = sum(values)
    if total > 0:
        normalized = [v / total for v in values]
    else:
        normalized = [0.0] * len(values)

    # Distribuir cada bloco de 30 min em 3 blocos de 10 min com variação suave
    # Evita efeito "escada" (3 valores idênticos por meia-hora)
    ten_min_values = []
    for i, val in enumerate(normalized):
        # Alternar padrões de micro-variação para suavizar
        phase = i % 4
        if phase == 0:
            factors = (0.30, 0.35, 0.35)
        elif phase == 1:
            factors = (0.33, 0.34, 0.33)
        elif phase == 2:
            factors = (0.35, 0.35, 0.30)
        else:
            factors = (0.32, 0.36, 0.32)
        for f in factors:
            ten_min_values.append(val * f)

    # Renormalizar para garantir soma exata = 1.0
    total_10 = sum(ten_min_values)
    if total_10 > 0:
        ten_min_values = [v / total_10 for v in ten_min_values]

    # Gerar o dicionário Python
    for i, (intervalo, val) in enumerate(zip(intervals_10, ten_min_values)):
        comma = "," if i < len(intervals_10) - 1 else ""
        out += f"        '{intervalo}': {val:.5f}{comma}\n"

    out += "    },\n"
out += "}\n"

# Salvar
import os
script_dir = os.path.dirname(os.path.abspath(__file__))
output_path = os.path.join(script_dir, 'generated_curve.py')
with open(output_path, 'w') as f:
    f.write(out)

# Verificação
exec(open(output_path).read())
print(f"Curva gerada: {output_path}")
print(f"Intervalos por dia: {len(HARDCODED_CURVE[0])}")
print(f"Soma dia 0: {sum(HARDCODED_CURVE[0].values()):.6f}")
print(f"Soma dia 5: {sum(HARDCODED_CURVE[5].values()):.6f}")
print(f"Primeiro intervalo: {list(HARDCODED_CURVE[0].keys())[0]}")
print(f"Último intervalo: {list(HARDCODED_CURVE[0].keys())[-1]}")
import os
import json
import math
import calendar
import datetime
from typing import Optional
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import numpy as np
from io import BytesIO
from forecaster import forecaster

app = FastAPI(title="Forecast API", description="API para previsão de volume e TMO de call center")

# Configuração de CORS para permitir requests do frontend (React/Vite)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174", "http://localhost:5175"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = "data"
if not os.path.exists(DATA_DIR):
    os.makedirs(DATA_DIR)


# ============================================================================
# Funções auxiliares compartilhadas
# ============================================================================

def _erlang_c(agents: int, traffic: float) -> float:
    """Calcula a probabilidade de espera (Erlang C).

    Args:
        agents: Número de agentes
        traffic: Tráfego em Erlangs

    Returns:
        Probabilidade de espera P(Wait > 0)
    """
    if agents <= 0 or traffic <= 0:
        return 1.0
    if agents <= traffic:
        return 1.0
    # Inversão de Erlang B
    invB = 1.0
    for i in range(1, agents + 1):
        invB = 1.0 + invB * (i / traffic)
    erlangB = 1.0 / invB
    prob_wait = erlangB / (1.0 - (traffic / agents) * (1.0 - erlangB))
    return max(0.0, min(1.0, prob_wait))


def _calc_sla(prob_wait: float, agents: int, traffic: float, sla_time: int, tmo: int) -> float:
    """Calcula o SLA percentual usando Erlang C."""
    if agents <= traffic or tmo <= 0:
        return 0.0
    sla = (1.0 - prob_wait * np.exp(-(agents - traffic) * (sla_time / tmo))) * 100
    return float(max(0.0, min(100.0, sla)))


def _calc_asa(prob_wait: float, agents: int, traffic: float, tmo: int) -> float:
    """Calcula o tempo médio de atendimento (ASA) em segundos."""
    if agents <= traffic or tmo <= 0:
        return 0.0
    asa = (prob_wait * tmo) / (agents - traffic)
    return float(asa)


def _calc_occupancy(traffic: float, agents: int) -> float:
    """Calcula a ocupação percentual dos agentes."""
    if agents <= 0:
        return 0.0
    return float(min(100.0, (traffic / agents) * 100))


def _find_min_agents_for_sla(
    volume: int, tmo: int, interval_seconds: int,
    target_sla: float, sla_time: int, max_agents: int = 500
) -> int:
    """Encontra o número mínimo de agentes para atingir o SLA alvo via busca binária."""
    traffic = (volume / interval_seconds) * tmo
    lo, hi = 1, max(traffic + 1, 2)
    # Ajustar limite superior se necessário
    while hi <= max_agents:
        pw = _erlang_c(hi, traffic)
        sla = _calc_sla(pw, hi, traffic, sla_time, tmo)
        if sla >= target_sla:
            break
        hi = int(hi * 1.5) + 1

    # Busca binária
    while lo < hi:
        mid = (lo + hi) // 2
        pw = _erlang_c(mid, traffic)
        sla = _calc_sla(pw, mid, traffic, sla_time, tmo)
        if sla >= target_sla:
            hi = mid
        else:
            lo = mid + 1
    return lo


# ============================================================================
# Eventos de inicialização
# ============================================================================

@app.on_event("startup")
async def startup_event():
    # Auto-treinar se existir histórico salvo
    backup_file = os.path.join(DATA_DIR, "history_backup.csv")
    config_file = os.path.join(DATA_DIR, "history_config.json")

    if os.path.exists(backup_file):
        try:
            df = pd.read_csv(backup_file)
            lista_dias = None
            lista_anos = None

            if os.path.exists(config_file):
                with open(config_file, "r") as f:
                    config = json.load(f)
                    lista_dias = config.get("dias_semana")
                    lista_anos = config.get("anos_selecionados")

            forecaster.train(df, dias_semana=lista_dias, anos_selecionados=lista_anos)
            print("Histórico carregado e modelo auto-treinado com sucesso na inicialização.")
        except Exception as e:
            print(f"Erro ao carregar histórico salvo: {e}")


# ============================================================================
# Endpoints existentes (preservados integralmente)
# ============================================================================

@app.get("/")
def read_root():
    return {"message": "Bem-vindo à API de Forecast do Call Center"}

@app.post("/parse-years")
async def parse_years(file: UploadFile = File(...)):
    if not (file.filename.endswith('.csv') or file.filename.endswith('.xlsx') or file.filename.endswith('.xls') or file.filename.endswith('.xlsm') or file.filename.endswith('.xlsb')):
        raise HTTPException(status_code=400, detail="O arquivo deve ser um CSV ou Excel (.xlsx, .xls, .xlsm, .xlsb).")
    contents = await file.read()
    try:
        if file.filename.endswith('.xlsx') or file.filename.endswith('.xls') or file.filename.endswith('.xlsm') or file.filename.endswith('.xlsb'):
            df = pd.read_excel(BytesIO(contents))
        else:
            try:
                df = pd.read_csv(BytesIO(contents), sep=';', encoding='utf-8')
            except UnicodeDecodeError:
                df = pd.read_csv(BytesIO(contents), sep=';', encoding='latin-1')

            if len(df.columns) < 3:
                try:
                    df = pd.read_csv(BytesIO(contents), sep=',', encoding='utf-8')
                except UnicodeDecodeError:
                    df = pd.read_csv(BytesIO(contents), sep=',', encoding='latin-1')
        # Converter os nomes das colunas para minúsculas e limpar espaços
        df.columns = [str(c).lower().strip() for c in df.columns]

        # Corrigir typos comuns
        df.rename(columns={
            'inrevalo': 'intervalo',
            'interv': 'intervalo',
            'vol': 'volume'
        }, inplace=True)

        if 'data' not in df.columns:
            raise HTTPException(status_code=400, detail="CSV sem coluna 'data'")

        num_dates = pd.to_numeric(df['data'], errors='coerce')
        mask_str = num_dates.isna()
        dates_str = pd.to_datetime(df.loc[mask_str, 'data'], dayfirst=True, errors='coerce')
        dates_num = pd.to_datetime(num_dates.dropna(), origin='1899-12-30', unit='D', errors='coerce')
        df['data'] = dates_str.combine_first(dates_num)
        df = df.dropna(subset=['data'])

        anos = sorted(df['data'].dt.year.unique().tolist())
        return {"anos": anos}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro ao parsear anos: {str(e)}")

@app.post("/upload-history")
async def upload_history(
    file: UploadFile = File(...),
    dias_semana: str = Form(None),
    anos_selecionados: str = Form(None)
):
    """
    Recebe um CSV com o histórico, contendo as colunas: Data, Intervalo, Volume, TMO
    dias_semana: string opcional com dias separados por vírgula (0=Seg...6=Dom)
    anos_selecionados: string opcional com anos separados por vírgula (ex: 2024,2025)
    """
    if not (file.filename.endswith('.csv') or file.filename.endswith('.xlsx') or file.filename.endswith('.xls') or file.filename.endswith('.xlsm') or file.filename.endswith('.xlsb')):
        raise HTTPException(status_code=400, detail="O arquivo deve ser um CSV ou Excel (.xlsx, .xls, .xlsm, .xlsb).")

    contents = await file.read()
    try:
        if file.filename.endswith('.xlsx') or file.filename.endswith('.xls') or file.filename.endswith('.xlsm') or file.filename.endswith('.xlsb'):
            df = pd.read_excel(BytesIO(contents))
        else:
            # Tentar ler com ponto e vírgula primeiro (formato pt-BR)
            try:
                df = pd.read_csv(BytesIO(contents), sep=';', encoding='utf-8')
            except UnicodeDecodeError:
                df = pd.read_csv(BytesIO(contents), sep=';', encoding='latin-1')

            # Se não vieram várias colunas, provável que o separador era vírgula (fallback)
            if len(df.columns) < 3:
                try:
                    df = pd.read_csv(BytesIO(contents), sep=',', encoding='utf-8')
                except UnicodeDecodeError:
                    df = pd.read_csv(BytesIO(contents), sep=',', encoding='latin-1')

        # Converter os nomes das colunas para minúsculas e remover espaços invisíveis
        df.columns = [str(c).lower().strip() for c in df.columns]

        # Corrigir typos comuns de arquivos do cliente
        df.rename(columns={
            'inrevalo': 'intervalo',
            'interv': 'intervalo',
            'vol': 'volume'
        }, inplace=True)

        # Limpar pontos de milhares e converter vírgula decimal para ponto, se for string
        if 'volume' in df.columns and str(df['volume'].dtype) in ['object', 'string', 'str', 'O']:
            df['volume'] = df['volume'].astype(str).str.replace('.', '', regex=False).str.replace(',', '.', regex=False).astype(float)
        if 'tmo' in df.columns and str(df['tmo'].dtype) in ['object', 'string', 'str', 'O']:
            df['tmo'] = df['tmo'].astype(str).str.replace('.', '', regex=False).str.replace(',', '.', regex=False).astype(float)

        # Validar colunas essenciais
        required_columns = {'data', 'volume'}
        if not required_columns.issubset(set(df.columns)):
            raise HTTPException(status_code=400, detail=f"O CSV deve conter pelo menos as colunas: {required_columns}")

        # Se não houver intervalo, cria um dummy para não quebrar todo o pipeline antigo
        if 'intervalo' not in df.columns:
            df['intervalo'] = '00:00'

        # Preparar filtro de dias da semana
        lista_dias = None
        if dias_semana:
            lista_dias = [int(d.strip()) for d in dias_semana.split(',') if d.strip().isdigit()]

        # Preparar filtro de anos
        lista_anos = None
        if anos_selecionados:
            lista_anos = [int(a.strip()) for a in anos_selecionados.split(',') if a.strip().isdigit()]

        # Treina o algoritmo com o histórico enviado
        forecaster.train(df, dias_semana=lista_dias, anos_selecionados=lista_anos)

        # Salva o arquivo e as configurações para recarregar quando o servidor reiniciar
        try:
            df.to_csv(os.path.join(DATA_DIR, "history_backup.csv"), index=False)
            with open(os.path.join(DATA_DIR, "history_config.json"), "w") as f:
                json.dump({
                    "dias_semana": lista_dias,
                    "anos_selecionados": lista_anos
                }, f)
        except Exception as e:
            print(f"Erro ao salvar backup do histórico: {e}")

        # Para o MVP, apenas salvamos um resumo na memória ou retornamos o status
        total_linhas = len(df)
        stats = forecaster.get_stats()

        resumo = {
            "linhas_processadas": total_linhas,
            "data_inicio": stats.get('data_inicio') if stats else None,
            "data_fim": stats.get('data_fim') if stats else None,
            "volume_total": int(pd.to_numeric(df['volume'], errors='coerce').sum()) if 'volume' in df.columns else 0,
            "outliers_removidos": stats.get('outliers_removidos', 0) if stats else 0,
            "dias_treinamento": stats.get('dias_treinamento', 0) if stats else 0,
            "celulas": getattr(forecaster, 'available_celulas', ["Todas"])
        }

        return {"message": "Arquivo processado e modelo treinado com sucesso", "detalhes": resumo}

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao processar arquivo: {str(e)}")

# Endpoint para o algoritmo de forecast
@app.get("/forecast")
def get_forecast(dias: int = 30, celula: str = "Todas"):
    """
    Gera o forecast diário para os próximos X dias, incluindo curva intra-diária.
    """
    try:
        resultados = forecaster.forecast(days_ahead=dias, celula=celula)
        return {"forecast_diario": resultados}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro ao gerar forecast: {str(e)}")
@app.get("/forecast-month")
def get_forecast_month(year: int, month: int, celula: str = "Todas"):
    """
    Gera o forecast diário para um mês específico.
    """
    try:
        resultados = forecaster.forecast_month(year=year, month=month, celula=celula)
        return {"forecast_mensal": resultados}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao gerar forecast mensal: {str(e)}")

@app.get("/stats")
def get_stats(celula: str = "Todas"):
    """
    Retorna estatísticas históricas do call center.
    """
    stats = forecaster.get_stats(celula=celula)
    if not stats:
        return {"stats": None}
    return {"stats": stats}

@app.post("/wfm-cost")
async def calculate_wfm_cost(
    total_monthly_hc: int = Form(...),
    cost_per_agent_month: float = Form(5000.0),
    overhead_percent: float = Form(30.0),
    additional_hours_percent: float = Form(0.0),
    hourly_rate: float = Form(25.0)
):
    """
    Calcula custo operacional do dimensionamento.
    Returns: base_cost, overhead_cost, total_cost, cost_per_call (if volume provided), productivity_metrics
    """
    # Calculate costs
    base_cost = total_monthly_hc * cost_per_agent_month
    overhead_cost = base_cost * (overhead_percent / 100)
    total_cost = base_cost + overhead_cost
    hourly_cost = total_monthly_hc * hourly_rate * 160  # 160 hours/month avg

    return {
        "total_monthly_hc": total_monthly_hc,
        "base_salary_cost": round(base_cost, 2),
        "overhead_cost": round(overhead_cost, 2),
        "total_monthly_cost": round(total_cost, 2),
        "cost_per_agent_month": cost_per_agent_month,
        "hourly_cost_estimate": round(hourly_cost, 2),
        "cost_per_working_hour": round(total_cost / (total_monthly_hc * 160) if total_monthly_hc > 0 else 0, 2)
    }

@app.get("/sla-sensitivity")
def sla_sensitivity(
    base_volume: int = 10000,
    tmo: int = 240,
    interval_seconds: int = 600,
    target_sla_percent: float = 80.0,
    target_sla_time: int = 20,
    shrinkage: float = 18.47
):
    """
    Analisa sensibilidade do SLA a variações de volume (-30% a +30%).
    """
    results = []
    for pct in [-30, -20, -10, 0, 10, 20, 30]:
        vol = int(base_volume * (1 + pct / 100))
        traffic = (vol / interval_seconds) * tmo

        # Find min agents
        agents = max(1, int(traffic) + 1)
        # Simple Erlang C inline
        prob_wait = 1.0
        if agents > traffic:
            invB = 1.0
            for i in range(1, agents + 1):
                invB = 1.0 + invB * (i / traffic)
            erlangB = 1.0 / invB
            prob_wait = erlangB / (1.0 - (traffic / agents) * (1.0 - erlangB))

        sla = 0
        asa = 0
        occupancy = 0
        if agents > traffic:
            sla = (1.0 - prob_wait * np.exp(-(agents - traffic) * (target_sla_time / tmo))) * 100
            asa = (prob_wait * tmo) / (agents - traffic)
            occupancy = (traffic / agents) * 100

        required = max(1, int(np.ceil(agents / (1 - shrinkage / 100))))

        results.append({
            "volume_change_pct": pct,
            "volume": vol,
            "erlangs": round(traffic, 2),
            "base_agents": agents,
            "required_agents": required,
            "sla": round(max(0, min(100, sla)), 1),
            "occupancy": round(min(100, occupancy), 1),
            "asa": round(asa, 1)
        })

    return {"sensitivity": results}

@app.post("/abandon-rate")
def calculate_abandon_rate(
    volume: int = Form(...),
    tmo: int = Form(...),
    agents: int = Form(...),
    sla_time: int = Form(20),
    patience_time: int = Form(60),
    interval_seconds: int = Form(600)
):
    """
    Calcula a taxa de abandono estimada usando Erlang C e tempo médio de paciência.

    Args:
        volume: Volume total de chamadas no intervalo
        tmo: Tempo médio de operação (segundos)
        agents: Número de agentes posicionados
        sla_time: Tempo alvo de SLA em segundos
        patience_time: Tempo médio de paciência do chamador em segundos
        interval_seconds: Duração do intervalo em segundos (default 600 = 10 min)
    """
    if volume <= 0 or tmo <= 0 or agents <= 0:
        raise HTTPException(status_code=400, detail="volume, tmo e agents devem ser maiores que zero.")

    traffic = (volume / interval_seconds) * tmo

    # Get the global model to use the abandon rate calculator
    model = forecaster.get_model("Todas")
    if model and model.is_trained:
        abandon_rate = model._estimate_abandon_rate(agents, traffic, tmo, patience_time)
    else:
        # Fallback: compute inline
        if agents <= traffic:
            abandon_rate = 1.0
        else:
            invB = 1.0
            for i in range(1, agents + 1):
                invB = 1.0 + invB * (i / traffic)
            erlangB = 1.0 / invB
            prob_wait = erlangB / (1.0 - (traffic / agents) * (1.0 - erlangB))
            abandon_rate = prob_wait * np.exp(-(agents - traffic) * (patience_time / tmo))
            abandon_rate = float(min(1.0, max(0.0, abandon_rate)))

    # Also compute SLA for reference
    sla = 0.0
    prob_wait = 0.0
    if agents > traffic:
        invB = 1.0
        for i in range(1, agents + 1):
            invB = 1.0 + invB * (i / traffic)
        erlangB = 1.0 / invB
        prob_wait = erlangB / (1.0 - (traffic / agents) * (1.0 - erlangB))
        sla = (1.0 - prob_wait * np.exp(-(agents - traffic) * (sla_time / tmo))) * 100

    return {
        "volume": volume,
        "tmo": tmo,
        "agents": agents,
        "erlangs": round(traffic, 2),
        "patience_time": patience_time,
        "sla_time": sla_time,
        "prob_wait": round(prob_wait * 100, 2),
        "sla_percent": round(max(0, min(100, sla)), 2),
        "abandon_rate_percent": round(abandon_rate * 100, 2),
        "occupancy_percent": round(min(100, (traffic / agents) * 100), 1) if agents > 0 else 0
    }


# ============================================================================
# NOVOS ENDPOINTS
# ============================================================================

@app.post("/shrinkage-calculator")
async def shrinkage_calculator(
    base_agents: int = Form(...),
    vacation_percent: float = Form(8.0),
    sick_leave_percent: float = Form(3.0),
    training_percent: float = Form(2.0),
    break_percent: float = Form(5.0),
    meeting_percent: float = Form(1.5),
    absenteeism_percent: float = Form(2.0),
    other_percent: float = Form(0.0)
):
    """Calcula o shrinkage configurável com detalhamento por componente.

    Args:
        base_agents: Agentes necessários antes do shrinkage
        vacation_percent: Percentual de férias
        sick_leave_percent: Percentual de licença médica
        training_percent: Percentual de treinamento
        break_percent: Percentual de pausas
        meeting_percent: Percentual de reuniões
        absenteeism_percent: Percentual de absenteísmo
        other_percent: Percentual de outros (personalizado)
    """
    try:
        if base_agents <= 0:
            raise HTTPException(status_code=400, detail="base_agents deve ser maior que zero.")

        # Componentes do shrinkage
        componentes = {
            "ferias": {
                "nome": "Férias",
                "percentual": vacation_percent,
                "agentes_absent": round(base_agents * (vacation_percent / 100), 1)
            },
            "licenca_medica": {
                "nome": "Licença Médica",
                "percentual": sick_leave_percent,
                "agentes_absent": round(base_agents * (sick_leave_percent / 100), 1)
            },
            "treinamento": {
                "nome": "Treinamento",
                "percentual": training_percent,
                "agentes_absent": round(base_agents * (training_percent / 100), 1)
            },
            "pausas": {
                "nome": "Pausas",
                "percentual": break_percent,
                "agentes_absent": round(base_agents * (break_percent / 100), 1)
            },
            "reunioes": {
                "nome": "Reuniões",
                "percentual": meeting_percent,
                "agentes_absent": round(base_agents * (meeting_percent / 100), 1)
            },
            "absenteismo": {
                "nome": "Absenteísmo",
                "percentual": absenteeism_percent,
                "agentes_absent": round(base_agents * (absenteeism_percent / 100), 1)
            },
            "outros": {
                "nome": "Outros",
                "percentual": other_percent,
                "agentes_absent": round(base_agents * (other_percent / 100), 1)
            }
        }

        # Shrinkage total (aditivo — composição percentual)
        total_shrinkage_pct = sum(c["percentual"] for c in componentes.values())

        # Agentes ausentes no total
        total_absent = sum(c["agentes_absent"] for c in componentes.values())

        # Agentes necessários com shrinkage: HC = base / (1 - shrinkage)
        if total_shrinkage_pct >= 100:
            required_agents = float('inf')
        else:
            required_agents = int(np.ceil(base_agents / (1 - total_shrinkage_pct / 100)))

        # Eficiência efetiva (base_agents / required_agents)
        eficiencia_efetiva = round((base_agents / required_agents) * 100, 2) if required_agents > 0 else 0

        # Custo adicional do shrinkage
        agentes_adicionais = required_agents - base_agents
        custo_adicional_pct = round((agentes_adicionais / base_agents) * 100, 2) if base_agents > 0 else 0

        return {
            "base_agents": base_agents,
            "componentes": componentes,
            "total_shrinkage_percent": round(total_shrinkage_pct, 2),
            "total_agentes_ausentes": round(total_absent, 1),
            "required_agents_with_shrinkage": required_agents,
            "agentes_adicionais": agentes_adicionais,
            "eficiencia_efetiva_percent": eficiencia_efetiva,
            "custo_adicional_percent": custo_adicional_pct,
            "formula": f"HC_necessario = {base_agents} / (1 - {total_shrinkage_pct:.2f}%) = {required_agents}"
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro ao calcular shrinkage: {str(e)}")


@app.post("/scenario-whatif")
async def scenario_whatif(
    base_volume: int = Form(...),
    tmo: int = Form(...),
    interval_seconds: int = Form(600),
    target_sla_percent: float = Form(80.0),
    target_sla_time: int = Form(20),
    shrinkage: float = Form(18.47),
    scenarios: str = Form(None)
):
    """Análise de cenários hipotéticos (what-if).

    Args:
        base_volume: Volume base de referência
        tmo: Tempo médio de operação em segundos
        interval_seconds: Duração do intervalo em segundos
        target_sla_percent: SLA alvo em percentual
        target_sla_time: Tempo alvo de SLA em segundos
        shrinkage: Shrinkage em percentual
        scenarios: String JSON com lista de cenários customizados
    """
    try:
        if base_volume <= 0 or tmo <= 0:
            raise HTTPException(status_code=400, detail="base_volume e tmo devem ser maiores que zero.")

        # Parsing dos cenários — usar padrão se não fornecido
        if scenarios:
            try:
                lista_cenarios = json.loads(scenarios)
            except json.JSONDecodeError:
                raise HTTPException(status_code=400, detail="O parâmetro 'scenarios' deve ser um JSON válido.")
        else:
            lista_cenarios = [
                {"name": "Pico +30%", "volume_change": 30, "tmo_change": 0},
                {"name": "Pico +20%", "volume_change": 20, "tmo_change": 0},
                {"name": "Normal", "volume_change": 0, "tmo_change": 0},
                {"name": "Baixa -20%", "volume_change": -20, "tmo_change": 0},
                {"name": "Crise", "volume_change": -30, "tmo_change": 15},
                {"name": "TMO Alto +25%", "volume_change": 0, "tmo_change": 25}
            ]

        # Cenário base para referência de custo
        base_traffic = (base_volume / interval_seconds) * tmo
        base_agents_raw = _find_min_agents_for_sla(
            base_volume, tmo, interval_seconds,
            target_sla_percent, target_sla_time
        )
        base_agents_with_shrink = int(np.ceil(base_agents_raw / (1 - shrinkage / 100))) if shrinkage < 100 else base_agents_raw

        resultados = []

        for cenario in lista_cenarios:
            nome = cenario.get("name", "Sem nome")
            vol_change = cenario.get("volume_change", 0)
            tmo_change = cenario.get("tmo_change", 0)

            # Volume e TMO ajustados
            cenario_volume = int(base_volume * (1 + vol_change / 100))
            cenario_tmo = int(tmo * (1 + tmo_change / 100))

            if cenario_volume <= 0 or cenario_tmo <= 0:
                continue

            # Tráfego em Erlangs
            traffic = (cenario_volume / interval_seconds) * cenario_tmo

            # Encontrar agentes mínimos para SLA
            agents_raw = _find_min_agents_for_sla(
                cenario_volume, cenario_tmo, interval_seconds,
                target_sla_percent, target_sla_time
            )
            agents_with_shrink = int(np.ceil(agents_raw / (1 - shrinkage / 100))) if shrinkage < 100 else agents_raw

            # Métricas com os agentes encontrados
            prob_wait = _erlang_c(agents_raw, traffic)
            sla = _calc_sla(prob_wait, agents_raw, traffic, target_sla_time, cenario_tmo)
            occupancy = _calc_occupancy(traffic, agents_raw)
            asa = _calc_asa(prob_wait, agents_raw, traffic, cenario_tmo)

            # Delta de custo em relação ao cenário base
            cost_delta = ((agents_with_shrink - base_agents_with_shrink) / base_agents_with_shrink * 100) if base_agents_with_shrink > 0 else 0

            # Nível de risco
            if occupancy > 92:
                risco = "Crítico"
            elif occupancy > 85:
                risco = "Alto"
            elif occupancy > 75:
                risco = "Médio"
            else:
                risco = "Baixo"

            resultados.append({
                "name": nome,
                "volume_change_pct": vol_change,
                "tmo_change_pct": tmo_change,
                "volume": cenario_volume,
                "tmo": cenario_tmo,
                "erlangs": round(traffic, 2),
                "agents_raw": agents_raw,
                "agents_with_shrinkage": agents_with_shrink,
                "sla": round(sla, 1),
                "occupancy": round(occupancy, 1),
                "asa_seconds": round(asa, 1),
                "cost_delta_pct": round(cost_delta, 1),
                "risk_level": risco
            })

        return {
            "base_volume": base_volume,
            "base_tmo": tmo,
            "base_agents_with_shrinkage": base_agents_with_shrink,
            "scenarios": resultados
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro na análise de cenários: {str(e)}")


@app.get("/schedule-rotation")
def schedule_rotation(
    year: int,
    month: int,
    total_hc: int,
    shift_types: str = "06:20,08:12",
    exclude_dates: str = ""
):
    """Gera uma escala de rodízio mensal usando algoritmo round-robin.

    Distribui o HC disponível pelos turnos de forma equilibrada,
    garantindo dias de descanso e respeitando datas excluídas.

    Args:
        year: Ano do escalonamento
        month: Mês do escalonamento (1-12)
        total_hc: Headcount total disponível
        shift_types: Turnos separados por vírgula (ex: "06:20,08:12")
        exclude_dates: Datas excluídas separadas por vírgula (ex: "2025-07-15,2025-07-20")
    """
    try:
        if total_hc <= 0:
            raise HTTPException(status_code=400, detail="total_hc deve ser maior que zero.")
        if month < 1 or month > 12:
            raise HTTPException(status_code=400, detail="Mês deve estar entre 1 e 12.")

        _, num_days = calendar.monthrange(year, month)

        # Parsear turnos
        turnos = [s.strip() for s in shift_types.split(",") if s.strip()]
        if not turnos:
            raise HTTPException(status_code=400, detail="Pelo menos um tipo de turno deve ser informado.")

        # Parsear datas excluídas
        datas_excluidas = set()
        if exclude_dates:
            for d in exclude_dates.split(","):
                d = d.strip()
                if d:
                    datas_excluidas.add(d)

        # Distribuir HC pelos turnos
        num_turnos = len(turnos)
        agentes_por_turno = []
        resto = total_hc % num_turnos
        base_por_turno = total_hc // num_turnos
        for i in range(num_turnos):
            agentes_por_turno.append(base_por_turno + (1 if i < resto else 0))

        # Gerar IDs de agentes por turno
        agentes_por_turno_ids = []
        agente_id = 1
        for idx, qtd in enumerate(agentes_por_turno):
            ids = [f"Ag_{agente_id + j}" for j in range(qtd)]
            agentes_por_turno_ids.append(ids)
            agente_id += qtd

        # Gerar escala diária com round-robin
        # Cada agente trabalha 5 dias e folga 2 dias por semana (ciclo de 7 dias)
        escala = []
        total_agentes_dia = 0
        dias_trabalhados = 0
        dias_folga = 0

        for dia in range(1, num_days + 1):
            dt = datetime.date(year, month, dia)
            data_str = dt.isoformat()
            dia_semana = dt.weekday()  # 0=Seg, 6=Dom

            # Verificar se é data excluída
            is_excluido = data_str in datas_excluidas

            if is_excluido or dia_semana >= 6:
                # Domingo ou data excluída — todos de folga
                escala.append({
                    "data": data_str,
                    "dia_semana": ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"][dia_semana],
                    "is_feriado_excluido": is_excluido,
                    "is_fim_de_semana": dia_semana >= 5,
                    "turnos": [],
                    "agentes_trabalhando": 0,
                    "agentes_folga": total_hc,
                    "cobertura_turno": {}
                })
                dias_folga += 1
                continue

            # Sábado — equipe reduzida (50% do HC por turno, round-robin)
            if dia_semana == 5:
                turnos_dia = []
                cobertura = {}
                total_trabalhando = 0
                for t_idx, turno_nome in enumerate(turnos):
                    ids = agentes_por_turno_ids[t_idx]
                    # Metade dos agentes trabalha no sábado (round-robin pela semana do mês)
                    semana_mes = (dia - 1) // 7
                    metade = max(1, len(ids) // 2)
                    offset = (semana_mes * metade) % len(ids)
                    trabalhando = ids[offset:offset + metade]
                    folga_sabado = [a for a in ids if a not in trabalhando]
                    turnos_dia.append({
                        "turno": turno_nome,
                        "agentes": trabalhando,
                        "folga": folga_sabado
                    })
                    cobertura[turno_nome] = len(trabalhando)
                    total_trabalhando += len(trabalhando)

                escala.append({
                    "data": data_str,
                    "dia_semana": ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"][dia_semana],
                    "is_feriado_excluido": False,
                    "is_fim_de_semana": True,
                    "turnos": turnos_dia,
                    "agentes_trabalhando": total_trabalhando,
                    "agentes_folga": total_hc - total_trabalhando,
                    "cobertura_turno": cobertura
                })
                total_agentes_dia += total_trabalhando
                dias_trabalhados += 1
                continue

            # Dia útil (Seg-Sex) — round-robin com folga escalonada
            # Cada agente tem 1 dia de folga por semana (rotativo pelo dia_semana)
            turnos_dia = []
            cobertura = {}
            total_trabalhando = 0

            for t_idx, turno_nome in enumerate(turnos):
                ids = agentes_por_turno_ids[t_idx]
                # O agente cujo índice % 5 == dia_semana fica de folga
                trabalhando = [a for i, a in enumerate(ids) if i % 5 != dia_semana]
                folga_dia = [a for i, a in enumerate(ids) if i % 5 == dia_semana]
                turnos_dia.append({
                    "turno": turno_nome,
                    "agentes": trabalhando,
                    "folga": folga_dia
                })
                cobertura[turno_nome] = len(trabalhando)
                total_trabalhando += len(trabalhando)

            escala.append({
                "data": data_str,
                "dia_semana": ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"][dia_semana],
                "is_feriado_excluido": False,
                "is_fim_de_semana": False,
                "turnos": turnos_dia,
                "agentes_trabalhando": total_trabalhando,
                "agentes_folga": total_hc - total_trabalhando,
                "cobertura_turno": cobertura
            })
            total_agentes_dia += total_trabalhando
            dias_trabalhados += 1

        # Resumo de cobertura
        import holidays
        br_holidays = holidays.Brazil()
        feriados_mes = []
        for dia in range(1, num_days + 1):
            dt = datetime.date(year, month, dia)
            if dt in br_holidays:
                feriados_mes.append(dt.isoformat())

        _, num_dias_uteis = calendar.monthrange(year, month)
        media_agentes_dia = round(total_agentes_dia / max(1, dias_trabalhados), 1)

        return {
            "ano": year,
            "mes": month,
            "total_hc": total_hc,
            "turnos_configurados": turnos,
            "feriados_mes": feriados_mes,
            "datas_excluidas": list(datas_excluidas),
            "resumo": {
                "dias_no_mes": num_days,
                "dias_uteis_trabalhados": dias_trabalhados,
                "dias_folga_ou_excluidos": dias_folga,
                "media_agentes_por_dia": media_agentes_dia,
                "distribuicao_por_turno": {turnos[i]: agentes_por_turno[i] for i in range(num_turnos)}
            },
            "escala": escala
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro ao gerar escala de rodízio: {str(e)}")


@app.post("/forecast-accuracy")
async def forecast_accuracy(
    actual_file: UploadFile = File(...),
    forecast_data: str = Form(...)
):
    """Calcula métricas de acurácia do forecast comparando dados reais vs previstos.

    Args:
        actual_file: CSV com dados reais (colunas: data, volume, tmo)
        forecast_data: String JSON com os resultados do forecast (formato igual ao /forecast ou /forecast-month)
    """
    try:
        # Ler arquivo de dados reais
        contents = await actual_file.read()
        try:
            df_real = pd.read_csv(BytesIO(contents), sep=';', encoding='utf-8')
        except (UnicodeDecodeError, pd.errors.ParserError):
            try:
                df_real = pd.read_csv(BytesIO(contents), sep=';', encoding='latin-1')
            except (UnicodeDecodeError, pd.errors.ParserError):
                try:
                    df_real = pd.read_csv(BytesIO(contents), sep=',', encoding='utf-8')
                except (UnicodeDecodeError, pd.errors.ParserError):
                    df_real = pd.read_csv(BytesIO(contents), sep=',', encoding='latin-1')

        df_real.columns = [str(c).lower().strip() for c in df_real.columns]

        if 'data' not in df_real.columns or 'volume' not in df_real.columns:
            raise HTTPException(status_code=400, detail="O CSV de dados reais deve conter ao menos as colunas: data, volume.")

        # Padronizar datas
        df_real['data'] = pd.to_datetime(df_real['data'], dayfirst=True, errors='coerce')
        df_real = df_real.dropna(subset=['data'])
        df_real['volume'] = pd.to_numeric(df_real['volume'], errors='coerce')

        if 'tmo' in df_real.columns:
            df_real['tmo'] = pd.to_numeric(df_real['tmo'], errors='coerce')
        else:
            df_real['tmo'] = np.nan

        # Agregar por dia (caso tenha múltiplas linhas por dia)
        df_real_agg = df_real.groupby('data').agg(
            volume=('volume', 'sum'),
            tmo=('tmo', 'mean')
        ).reset_index()
        df_real_agg['data_str'] = df_real_agg['data'].dt.strftime('%Y-%m-%d')

        # Parsear dados do forecast
        try:
            forecast_json = json.loads(forecast_data)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="forecast_data deve ser um JSON válido.")

        # Extrair lista de dias do forecast — aceita ambos os formatos
        if 'dias' in forecast_json:
            forecast_days = forecast_json['dias']
        elif 'forecast_diario' in forecast_json:
            forecast_days = forecast_json['forecast_diario']
        else:
            # Assume que é uma lista direta
            forecast_days = forecast_json

        # Criar DataFrame do forecast
        forecast_records = []
        for dia in forecast_days:
            data_str = dia.get('data', '')
            # Ajustar formato da data para comparação
            try:
                dt = datetime.datetime.fromisoformat(data_str).date()
                data_normalizada = dt.isoformat()
            except (ValueError, TypeError):
                continue

            forecast_records.append({
                'data_str': data_normalizada,
                'volume_previsto': float(dia.get('volume_total', 0)),
                'tmo_previsto': float(dia.get('tmo_medio', 0))
            })

        df_forecast = pd.DataFrame(forecast_records)

        if df_forecast.empty:
            raise HTTPException(status_code=400, detail="Nenhum dado de forecast válido encontrado.")

        # Merge real vs previsto
        df_merged = pd.merge(df_real_agg, df_forecast, on='data_str', how='inner')

        if df_merged.empty:
            raise HTTPException(
                status_code=400,
                detail="Nenhuma data em comum entre os dados reais e o forecast. Verifique os períodos."
            )

        # --- Métricas de Volume ---
        real_vol = df_merged['volume'].values.astype(float)
        prev_vol = df_merged['volume_previsto'].values.astype(float)

        # MAPE (Mean Absolute Percentage Error) — ignorar dias com volume zero
        mask_vol = real_vol > 0
        if mask_vol.sum() > 0:
            mape_vol = float(np.mean(np.abs((real_vol[mask_vol] - prev_vol[mask_vol]) / real_vol[mask_vol])) * 100)
        else:
            mape_vol = float('inf')

        # MAE (Mean Absolute Error)
        mae_vol = float(np.mean(np.abs(real_vol - prev_vol)))

        # RMSE (Root Mean Squared Error)
        rmse_vol = float(np.sqrt(np.mean((real_vol - prev_vol) ** 2)))

        # Viés (bias) — positivo = superestima, negativo = subestima
        bias_vol = float(np.mean(prev_vol - real_vol))
        bias_vol_pct = float((np.sum(prev_vol - real_vol) / np.sum(real_vol)) * 100) if np.sum(real_vol) > 0 else 0

        # --- Métricas de TMO (se disponível) ---
        tmo_disponivel = 'tmo' in df_merged.columns and df_merged['tmo'].notna().sum() > 0

        mape_tmo = None
        mae_tmo = None
        rmse_tmo = None
        bias_tmo = None

        if tmo_disponivel:
            real_tmo = df_merged['tmo'].values.astype(float)
            prev_tmo = df_merged['tmo_previsto'].values.astype(float)
            mask_tmo = real_tmo > 0

            if mask_tmo.sum() > 0:
                mape_tmo = float(np.mean(np.abs((real_tmo[mask_tmo] - prev_tmo[mask_tmo]) / real_tmo[mask_tmo])) * 100)
            mae_tmo = float(np.mean(np.abs(real_tmo - prev_tmo)))
            rmse_tmo = float(np.sqrt(np.mean((real_tmo - prev_tmo) ** 2)))
            bias_tmo = float(np.mean(prev_tmo - real_tmo))

        # --- Acurácia por dia da semana ---
        df_merged['dia_semana'] = pd.to_datetime(df_merged['data_str']).dt.dayofweek
        dias_nomes = {0: "Segunda", 1: "Terça", 2: "Quarta", 3: "Quinta", 4: "Sexta", 5: "Sábado", 6: "Domingo"}
        acuracia_por_dia = []

        for dow in range(7):
            df_dow = df_merged[df_merged['dia_semana'] == dow]
            if df_dow.empty:
                continue

            rv = df_dow['volume'].values.astype(float)
            pv = df_dow['volume_previsto'].values.astype(float)
            mask_d = rv > 0

            if mask_d.sum() > 0:
                mape_d = float(np.mean(np.abs((rv[mask_d] - pv[mask_d]) / rv[mask_d])) * 100)
            else:
                mape_d = float('inf')

            mae_d = float(np.mean(np.abs(rv - pv)))
            rmse_d = float(np.sqrt(np.mean((rv - pv) ** 2)))
            acuracia_d = max(0.0, 100.0 - mape_d) if mape_d != float('inf') else 0.0

            acuracia_por_dia.append({
                "dia_semana": dias_nomes[dow],
                "dia_semana_idx": dow,
                "dias_analisados": len(df_dow),
                "volume_medio_real": round(float(np.mean(rv)), 1),
                "volume_medio_previsto": round(float(np.mean(pv)), 1),
                "mape": round(mape_d, 2),
                "mae": round(mae_d, 2),
                "rmse": round(rmse_d, 2),
                "acuracia_percent": round(acuracia_d, 2)
            })

        resultado = {
            "resumo_geral": {
                "dias_comparados": len(df_merged),
                "periodo": f"{df_merged['data_str'].min()} a {df_merged['data_str'].max()}",
                "volume_total_real": int(np.sum(real_vol)),
                "volume_total_previsto": int(np.sum(prev_vol)),
                "diferenca_total_pct": round(((np.sum(prev_vol) - np.sum(real_vol)) / np.sum(real_vol)) * 100, 2) if np.sum(real_vol) > 0 else 0
            },
            "volume": {
                "mape": round(mape_vol, 2),
                "mae": round(mae_vol, 2),
                "rmse": round(rmse_vol, 2),
                "bias": round(bias_vol, 2),
                "bias_percent": round(bias_vol_pct, 2),
                "direcao_bias": "Superestima" if bias_vol_pct > 5 else ("Subestima" if bias_vol_pct < -5 else "Neutro"),
                "acuracia_percent": round(max(0, 100 - mape_vol), 2) if mape_vol != float('inf') else 0
            }
        }

        if tmo_disponivel:
            resultado["tmo"] = {
                "mape": round(mape_tmo, 2) if mape_tmo is not None else None,
                "mae": round(mae_tmo, 2) if mae_tmo is not None else None,
                "rmse": round(rmse_tmo, 2) if rmse_tmo is not None else None,
                "bias": round(bias_tmo, 2) if bias_tmo is not None else None,
                "disponivel": True
            }
        else:
            resultado["tmo"] = {"disponivel": False, "motivo": "Coluna TMO ausente nos dados reais"}

        resultado["acuracia_por_dia_semana"] = acuracia_por_dia

        return resultado

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao calcular acurácia do forecast: {str(e)}")


@app.get("/occupancy-analysis")
def occupancy_analysis(
    year: int,
    month: int,
    max_occupancy_target: float = 85.0,
    interval_seconds: int = 600,
    shrinkage: float = 18.47,
    target_sla_percent: float = 80.0,
    target_sla_time: int = 20
):
    """Análise de ocupação por intervalo ao longo do forecast mensal.

    Args:
        year: Ano do forecast
        month: Mês do forecast
        max_occupancy_target: Ocupação máxima alvo em percentual
        interval_seconds: Duração do intervalo em segundos
        shrinkage: Shrinkage em percentual
        target_sla_percent: SLA alvo
        target_sla_time: Tempo alvo de SLA em segundos
    """
    try:
        if not forecaster.is_trained:
            raise HTTPException(status_code=400, detail="Modelo não treinado. Envie histórico primeiro.")

        # Obter forecast do mês
        forecast_result = forecaster.forecast_month(year=year, month=month)
        dias = forecast_result.get('dias', [])

        if not dias:
            raise HTTPException(status_code=404, detail="Nenhum dado de forecast encontrado para o período.")

        # Coletar dados por intervalo
        intervalos_data = {}  # intervalo -> lista de (volume, tmo, data)

        for dia in dias:
            data_str = dia.get('data', '')
            tmo_dia = dia.get('tmo_medio', 240)
            for interv in dia.get('intervalos', []):
                nome_interv = interv.get('intervalo', '')
                vol = interv.get('volume', 0)
                tmo_interv = interv.get('tmo', tmo_dia)
                if nome_interv not in intervalos_data:
                    intervalos_data[nome_interv] = []
                intervalos_data[nome_interv].append({
                    "volume": vol,
                    "tmo": tmo_interv,
                    "data": data_str
                })

        # Analisar cada intervalo
        analise = []
        total_sobre_target = 0
        total_abaixo_target = 0
        intervalos_risco_burnout = []
        recomendacoes = []

        for nome_interv in sorted(intervalos_data.keys()):
            registros = intervalos_data[nome_interv]
            volumes = np.array([r['volume'] for r in registros], dtype=float)
            tmos = np.array([r['tmo'] for r in registros], dtype=float)

            vol_max = int(np.max(volumes))
            vol_medio = float(np.mean(volumes))
            vol_p95 = float(np.percentile(volumes, 95))
            tmo_medio = float(np.mean(tmos))

            # Calcular tráfego para cenário médio e pico
            traffic_medio = (vol_medio / interval_seconds) * tmo_medio
            traffic_pico = (vol_max / interval_seconds) * tmo_medio

            # Agentes necessários (SLA target)
            if vol_medio > 0 and tmo_medio > 0:
                agents_medio = _find_min_agents_for_sla(
                    int(vol_medio), int(tmo_medio), interval_seconds,
                    target_sla_percent, target_sla_time
                )
                agents_medio_shrink = int(np.ceil(agents_medio / (1 - shrinkage / 100))) if shrinkage < 100 else agents_medio
            else:
                agents_medio = 0
                agents_medio_shrink = 0

            if vol_max > 0 and tmo_medio > 0:
                agents_pico = _find_min_agents_for_sla(
                    vol_max, int(tmo_medio), interval_seconds,
                    target_sla_percent, target_sla_time
                )
                agents_pico_shrink = int(np.ceil(agents_pico / (1 - shrinkage / 100))) if shrinkage < 100 else agents_pico
            else:
                agents_pico = 0
                agents_pico_shrink = 0

            # Ocupação
            occ_medio = _calc_occupancy(traffic_medio, agents_medio)
            occ_pico = _calc_occupancy(traffic_pico, agents_medio)  # Ocupação no pico com agentes médios

            # SLA no pico com agentes médios
            if agents_medio > 0:
                pw_pico = _erlang_c(agents_medio, traffic_pico)
                sla_pico = _calc_sla(pw_pico, agents_medio, traffic_pico, target_sla_time, int(tmo_medio))
            else:
                sla_pico = 0.0

            # Status do intervalo
            sobre_target = occ_pico > max_occupancy_target
            risco_burnout = occ_pico > 92

            if sobre_target:
                total_sobre_target += 1
            else:
                total_abaixo_target += 1

            if risco_burnout:
                intervalos_risco_burnout.append(nome_interv)

            entrada = {
                "intervalo": nome_interv,
                "volume_medio": round(vol_medio, 1),
                "volume_max": vol_max,
                "volume_p95": int(vol_p95),
                "tmo_medio": round(tmo_medio, 1),
                "erlangs_medio": round(traffic_medio, 2),
                "erlangs_pico": round(traffic_pico, 2),
                "agents_recommended": agents_medio_shrink,
                "agents_pico_needed": agents_pico_shrink,
                "occupancy_medio_pct": round(occ_medio, 1),
                "occupancy_pico_pct": round(occ_pico, 1),
                "sla_pico_pct": round(sla_pico, 1),
                "over_target": sobre_target,
                "burnout_risk": risco_burnout
            }
            analise.append(entrada)

        # Gerar recomendações
        if intervalos_risco_burnout:
            recomendacoes.append({
                "tipo": "burnout",
                "prioridade": "Alta",
                "descricao": f"Intervalos com risco de burnout (>92% ocupação no pico): {', '.join(intervalos_risco_burnout)}",
                "acao": "Aumentar HC nesses horários ou redistribuir pausas"
            })

        if total_sobre_target > 0:
            pct_sobre = round(total_sobre_target / max(1, len(analise)) * 100, 1)
            recomendacoes.append({
                "tipo": "sobre_target",
                "prioridade": "Média",
                "descricao": f"{total_sobre_target} intervalos ({pct_sobre}%) ultrapassam a ocupação alvo de {max_occupancy_target}%",
                "acao": "Revisar dimensionamento nesses intervalos"
            })

        # Verificar se há janela onde a ocupação está muito baixa (desperdício)
        intervalos_desperdicio = [a['intervalo'] for a in analise if a['occupancy_medio_pct'] < 50]
        if intervalos_desperdicio:
            recomendacoes.append({
                "tipo": "desperdicio",
                "prioridade": "Baixa",
                "descricao": f"Intervalos com baixa ocupação média (<50%): {', '.join(intervalos_desperdicio[:5])}",
                "acao": "Considerar redução de HC ou uso de multi-skill"
            })

        # Encontrar pico absoluto
        pico = max(analise, key=lambda x: x['occupancy_pico_pct']) if analise else None

        return {
            "periodo": f"{year}-{month:02d}",
            "parametros": {
                "max_occupancy_target": max_occupancy_target,
                "interval_seconds": interval_seconds,
                "shrinkage": shrinkage,
                "target_sla": target_sla_percent
            },
            "resumo": {
                "total_intervalos_analisados": len(analise),
                "intervalos_sobre_target": total_sobre_target,
                "intervalos_abaixo_target": total_abaixo_target,
                "intervalos_risco_burnout": len(intervalos_risco_burnout),
                "pico_absoluto": pico,
                "pct_sobre_target": round(total_sobre_target / max(1, len(analise)) * 100, 1)
            },
            "analise_por_intervalo": analise,
            "recomendacoes": recomendacoes
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro na análise de ocupação: {str(e)}")


@app.get("/wfm-summary")
def wfm_summary(
    year: int,
    month: int,
    cost_per_agent: float = 5000,
    overhead_percent: float = 30,
    shrinkage: float = 18.47,
    target_sla_percent: float = 80.0,
    target_sla_time: int = 20,
    interval_seconds: int = 600
):
    """Resumo completo de WFM combinando forecast + dimensionamento + custo.

    Args:
        year: Ano do forecast
        month: Mês do forecast
        cost_per_agent: Custo mensal por agente
        overhead_percent: Percentual de encargos/overhead
        shrinkage: Shrinkage em percentual
        target_sla_percent: SLA alvo
        target_sla_time: Tempo alvo de SLA em segundos
        interval_seconds: Duração do intervalo em segundos
    """
    try:
        if not forecaster.is_trained:
            raise HTTPException(status_code=400, detail="Modelo não treinado. Envie histórico primeiro.")

        # Obter forecast mensal
        forecast_result = forecaster.forecast_month(year=year, month=month)
        dias = forecast_result.get('dias', [])
        comparacoes = forecast_result.get('comparacoes', {})

        if not dias:
            raise HTTPException(status_code=404, detail="Nenhum dado de forecast encontrado para o período.")

        # --- Volume projetado ---
        volumes = [d['volume_total'] for d in dias]
        tmos = [d.get('tmo_medio', 240) for d in dias]
        total_volume = int(sum(volumes))
        avg_volume = float(np.mean(volumes))
        avg_tmo = float(np.mean(tmos))
        max_volume = int(max(volumes))

        # DMM e HMM do forecast
        dmm_data = comparacoes.get('dmm_data', '')
        dmm_vol = comparacoes.get('dmm_vol', 0)
        hmm_hora = comparacoes.get('hmm_hora', '')
        hmm_vol = comparacoes.get('hmm_vol', 0)

        # --- Dimensionamento por intervalo (usar pico do mês como referência) ---
        # Encontrar o dia de pico
        dia_pico = max(dias, key=lambda x: x['volume_total'])
        intervalos_pico = dia_pico.get('intervalos', [])

        # Agentes necessários por intervalo no dia de pico
        agents_por_intervalo = []
        max_agents_interval = 0
        total_erlangs_dia = 0

        for interv in intervalos_pico:
            vol = interv.get('volume', 0)
            tmo_int = interv.get('tmo', avg_tmo)
            if vol <= 0 or tmo_int <= 0:
                continue

            traffic = (vol / interval_seconds) * tmo_int
            total_erlangs_dia += traffic

            agents_raw = _find_min_agents_for_sla(
                vol, int(tmo_int), interval_seconds,
                target_sla_percent, target_sla_time
            )
            agents_shrink = int(np.ceil(agents_raw / (1 - shrinkage / 100))) if shrinkage < 100 else agents_raw

            pw = _erlang_c(agents_raw, traffic)
            sla = _calc_sla(pw, agents_raw, traffic, target_sla_time, int(tmo_int))
            occ = _calc_occupancy(traffic, agents_raw)

            agents_por_intervalo.append({
                "intervalo": interv.get('intervalo', ''),
                "volume": vol,
                "erlangs": round(traffic, 2),
                "agents_raw": agents_raw,
                "agents_with_shrinkage": agents_shrink,
                "sla": round(sla, 1),
                "occupancy": round(occ, 1)
            })

            if agents_shrink > max_agents_interval:
                max_agents_interval = agents_shrink

        # HC total necessário (máximo de agentes simultâneos no pico + folga)
        hc_necessario = max_agents_interval

        # Média de agentes por dia útil
        import holidays
        br_holidays = holidays.Brazil()
        dias_uteis = 0
        for d in dias:
            dt = datetime.date.fromisoformat(d['data'])
            if dt.weekday() < 5 and dt not in br_holidays:
                dias_uteis += 1

        # Calcular média de HC por dia (não apenas pico)
        hc_por_dia = []
        for dia in dias:
            dt = datetime.date.fromisoformat(dia['data'])
            if dt.weekday() >= 5 or dt in br_holidays:
                continue

            intervalos = dia.get('intervalos', [])
            max_agents_dia = 0
            for interv in intervalos:
                vol = interv.get('volume', 0)
                tmo_int = interv.get('tmo', avg_tmo)
                if vol <= 0 or tmo_int <= 0:
                    continue
                traffic = (vol / interval_seconds) * tmo_int
                agents_raw = _find_min_agents_for_sla(
                    vol, int(tmo_int), interval_seconds,
                    target_sla_percent, target_sla_time
                )
                agents_shrink = int(np.ceil(agents_raw / (1 - shrinkage / 100))) if shrinkage < 100 else agents_raw
                if agents_shrink > max_agents_dia:
                    max_agents_dia = agents_shrink
            hc_por_dia.append(max_agents_dia)

        hc_medio_dia = int(np.mean(hc_por_dia)) if hc_por_dia else 0
        hc_mediano_dia = int(np.median(hc_por_dia)) if hc_por_dia else 0

        # --- Custos ---
        base_cost = hc_necessario * cost_per_agent
        overhead_cost = base_cost * (overhead_percent / 100)
        total_cost = base_cost + overhead_cost
        cost_per_call = total_cost / total_volume if total_volume > 0 else 0
        cost_per_working_hour = total_cost / (hc_necessario * 160) if hc_necessario > 0 else 0

        # Custo da média (cenário realista)
        base_cost_medio = hc_medio_dia * cost_per_agent
        overhead_cost_medio = base_cost_medio * (overhead_percent / 100)
        total_cost_medio = base_cost_medio + overhead_cost_medio

        # --- Impacto do shrinkage ---
        agents_sem_shrink = max_agents_interval  # já com shrinkage
        agents_com_shrink_raw = int(agents_sem_shrink * (1 - shrinkage / 100))  # remover shrinkage
        custo_shrinkage = (agents_sem_shrink - agents_com_shrink_raw) * cost_per_agent

        # --- SLA projetado ---
        # SLA médio do mês
        sla_intervalos = [a['sla'] for a in agents_por_intervalo]
        sla_medio = float(np.mean(sla_intervalos)) if sla_intervalos else 0
        sla_min = float(np.min(sla_intervalos)) if sla_intervalos else 0

        # --- Recomendações ---
        recomendacoes = []

        if sla_min < 70:
            recomendacoes.append({
                "tipo": "sla_critico",
                "descricao": f"SLA mínimo projetado de {sla_min:.1f}% está abaixo de 70%. Risco de multas contratuais.",
                "acao": "Aumentar HC em {hmm_hora} ou revisar contratos de SLA."
            })
        elif sla_min < target_sla_percent:
            recomendacoes.append({
                "tipo": "sla_abaixo",
                "descricao": f"SLA mínimo de {sla_min:.1f}% está abaixo do alvo de {target_sla_percent}%.",
                "acao": "Considerar sobreaviso ou flexibilização de horários."
            })

        if hc_necessario > hc_medio_dia * 1.3:
            recomendacoes.append({
                "tipo": "pico_elevado",
                "descricao": f"HC de pico ({hc_necessario}) é 30%+ superior ao HC médio ({hc_medio_dia}).",
                "acao": "Implementar escala flexível ou horas extras programadas nos dias de pico."
            })

        if custo_shrinkage > base_cost * 0.15:
            recomendacoes.append({
                "tipo": "shrinkage_alto",
                "descricao": f"Custo do shrinkage (R$ {custo_shrinkage:,.2f}) representa mais de 15% da folha.",
                "acao": "Revisar políticas de férias, treinamentos e absenteísmo."
            })

        feriados_mes = comparacoes.get('feriados_mes', [])
        if feriados_mes:
            recomendacoes.append({
                "tipo": "feriados",
                "descricao": f"Mês possui {len(feriados_mes)} feriado(s): {', '.join(feriados_mes)}.",
                "acao": "Planejar escala reduzida nos feriados e redistribuir demanda."
            })

        return {
            "periodo": f"{year}-{month:02d}",
            "volume": {
                "total_projetado": total_volume,
                "media_diaria": round(avg_volume, 1),
                "max_diario": max_volume,
                "tmo_medio": round(avg_tmo, 1),
                "dmm_data": dmm_data,
                "dmm_volume": dmm_vol,
                "hmm_hora": hmm_hora,
                "hmm_volume": hmm_vol
            },
            "dimensionamento": {
                "hc_pico": hc_necessario,
                "hc_medio_dia": hc_medio_dia,
                "hc_mediano_dia": hc_mediano_dia,
                "dias_uteis": dias_uteis,
                "shrinkage_percent": shrinkage,
                "intervalos_pico": agents_por_intervalo
            },
            "custo": {
                "hc_utilizado": hc_necessario,
                "custo_base_mensal": round(base_cost, 2),
                "custo_overhead": round(overhead_cost, 2),
                "custo_total_mensal": round(total_cost, 2),
                "custo_medio_mensal": round(total_cost_medio, 2),
                "custo_por_chamada": round(cost_per_call, 2),
                "custo_por_hora_trabalhada": round(cost_per_working_hour, 2),
                "custo_shrinkage": round(custo_shrinkage, 2),
                "parametros": {
                    "custo_por_agente": cost_per_agent,
                    "overhead_percent": overhead_percent
                }
            },
            "sla_projecao": {
                "sla_medio_pct": round(sla_medio, 1),
                "sla_minimo_pct": round(sla_min, 1),
                "target_sla": target_sla_percent
            },
            "recomendacoes": recomendacoes
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao gerar resumo WFM: {str(e)}")


@app.post("/multi-queue-dimensioning")
async def multi_queue_dimensioning(
    queues_json: str = Form(...),
    target_sla_percent: float = Form(80.0),
    target_sla_time: int = Form(20),
    shrinkage: float = Form(18.47),
    shared_agents_percent: float = Form(20.0),
    interval_seconds: int = Form(600)
):
    """Dimensionamento multi-fila com roteamento baseado em habilidades.

    Calcula o HC necessário para cada fila individualmente, aplica um pool
    compartilhado de agentes multi-skill e compara com o cenário siloed.

    Args:
        queues_json: String JSON com lista de filas
        target_sla_percent: SLA alvo em percentual
        target_sla_time: Tempo alvo de SLA em segundos
        shrinkage: Shrinkage em percentual
        shared_agents_percent: Percentual de agentes que podem atender múltiplas filas
        interval_seconds: Duração do intervalo em segundos
    """
    try:
        # Parsear filas
        try:
            filas = json.loads(queues_json)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="queues_json deve ser um JSON válido.")

        if not filas or not isinstance(filas, list):
            raise HTTPException(status_code=400, detail="queues_json deve conter uma lista de filas.")

        if shared_agents_percent < 0 or shared_agents_percent > 100:
            raise HTTPException(status_code=400, detail="shared_agents_percent deve estar entre 0 e 100.")

        # Dimensionar cada fila individualmente (siloed)
        resultados_filas = []
        total_agents_siloed = 0
        total_erlangs = 0

        for fila in filas:
            nome = fila.get('name', 'Sem nome')
            peso = fila.get('weight', 0)
            volume = int(fila.get('volume', 0))
            tmo = int(fila.get('tmo', 240))

            if volume <= 0 or tmo <= 0:
                resultados_filas.append({
                    "name": nome,
                    "weight": peso,
                    "volume": volume,
                    "tmo": tmo,
                    "erro": "Volume ou TMO inválido"
                })
                continue

            # Calcular tráfego em Erlangs
            traffic = (volume / interval_seconds) * tmo
            total_erlangs += traffic

            # Encontrar agentes mínimos para SLA
            agents_raw = _find_min_agents_for_sla(
                volume, tmo, interval_seconds,
                target_sla_percent, target_sla_time
            )
            agents_with_shrink = int(np.ceil(agents_raw / (1 - shrinkage / 100))) if shrinkage < 100 else agents_raw

            # Métricas
            pw = _erlang_c(agents_raw, traffic)
            sla = _calc_sla(pw, agents_raw, traffic, target_sla_time, tmo)
            occupancy = _calc_occupancy(traffic, agents_raw)
            asa = _calc_asa(pw, agents_raw, traffic, tmo)

            resultados_filas.append({
                "name": nome,
                "weight": peso,
                "volume": volume,
                "tmo": tmo,
                "erlangs": round(traffic, 2),
                "agents_raw": agents_raw,
                "agents_with_shrinkage": agents_with_shrink,
                "sla": round(sla, 1),
                "occupancy": round(occupancy, 1),
                "asa_seconds": round(asa, 1)
            })

            total_agents_siloed += agents_with_shrink

        # Filas válidas (sem erro)
        filas_validas = [f for f in resultados_filas if 'erro' not in f]

        if not filas_validas:
            raise HTTPException(status_code=400, detail="Nenhuma fila válida para dimensionar.")

        # --- Pool compartilhado (skill-based routing) ---
        # Agentes compartilhados podem atender qualquer fila
        # Usamos a soma de erlangs combinada para calcular o pool ótimo
        # O pool compartilhado é mais eficiente porque o tráfego combinado
        # se suaviza (lei dos grandes números)

        # Agentes compartilhados = percentual do total siloed
        total_shared = max(1, int(np.ceil(total_agents_siloed * (shared_agents_percent / 100))))

        # Calcular agentes necessários para o tráfego combinado (eficiência de pooling)
        # Usar volume e TMO ponderados
        total_volume_combined = sum(f['volume'] for f in filas_validas)
        tmo_ponderado = int(sum(f['volume'] * f['tmo'] for f in filas_validas) / total_volume_combined) if total_volume_combined > 0 else 240

        # Agentes otimizados para tráfego combinado
        agents_combined_raw = _find_min_agents_for_sla(
            total_volume_combined, tmo_ponderado, interval_seconds,
            target_sla_percent, target_sla_time
        )
        agents_combined_shrink = int(np.ceil(agents_combined_raw / (1 - shrinkage / 100))) if shrinkage < 100 else agents_combined_raw

        # O pool compartilhado é mais eficiente: usa menos agentes que a soma individual
        economia = total_agents_siloed - agents_combined_shrink
        economia_pct = (economia / total_agents_siloed * 100) if total_agents_siloed > 0 else 0

        # Pool dedicado por fila (HC siloed - pool compartilhado)
        # Distribuir o shared_agents_percent proporcionalmente
        pool_dedicado = []
        for f in filas_validas:
            dedicado = int(np.ceil(f['agents_with_shrinkage'] * (1 - shared_agents_percent / 100)))
            f['agents_dedicados'] = dedicado
            f['agents_no_pool'] = f['agents_with_shrinkage'] - dedicado
            pool_dedicado.append(dedicado)

        # SLA combinado
        traffic_combined = total_erlangs
        pw_combined = _erlang_c(agents_combined_raw, traffic_combined)
        sla_combined = _calc_sla(pw_combined, agents_combined_raw, traffic_combined, target_sla_time, tmo_ponderado)
        occupancy_combined = _calc_occupancy(traffic_combined, agents_combined_raw)

        return {
            "configuracao": {
                "target_sla_percent": target_sla_percent,
                "target_sla_time": target_sla_time,
                "shrinkage": shrinkage,
                "shared_agents_percent": shared_agents_percent,
                "interval_seconds": interval_seconds
            },
            "filas": resultados_filas,
            "dimensionamento": {
                "total_agents_siloed": total_agents_siloed,
                "total_agents_otimizado": agents_combined_shrink,
                "total_erlangs": round(total_erlangs, 2),
                "tmo_ponderado": tmo_ponderado,
                "economia_agents": economia,
                "economia_percent": round(economia_pct, 1),
                "sla_combinado": round(sla_combined, 1),
                "occupancy_combinado": round(occupancy_combined, 1),
                "total_pool_compartilhado": total_shared,
                "total_pool_dedicado": sum(pool_dedicado)
            },
            "analise": {
                "descricao": "O pool compartilhado explora a lei dos grandes números: "
                            "filas com tráfego variável se compensam, reduzindo o HC total necessário.",
                "melhor_caso": f"Com {shared_agents_percent:.0f}% de agentes multi-skill, "
                              f"é possível economizar {economia} agentes ({economia_pct:.1f}%) "
                              f"em relação ao modelo siloed.",
                "recomendacao": "Aumentar o percentual de agentes multi-skill se possível, "
                               "pois a economia cresce não-linearmente com o tamanho do pool."
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro no dimensionamento multi-fila: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
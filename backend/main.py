import os
import json
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

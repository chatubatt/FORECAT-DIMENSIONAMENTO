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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

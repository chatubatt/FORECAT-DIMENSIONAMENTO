import pandas as pd
import numpy as np
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.tree import DecisionTreeRegressor
from sklearn.neighbors import KNeighborsRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.model_selection import train_test_split
import datetime
import calendar
import holidays

# Importação opcional do ExponentialSmoothing (statsmodels pode não estar instalado)
try:
    from statsmodels.tsa.holtwinters import ExponentialSmoothing
    _HAS_EXP_SMOOTH = True
except ImportError:
    _HAS_EXP_SMOOTH = False


class _ExponentialSmoothingWrapper:
    """Wrapper para ExponentialSmoothing compatível com a interface fit/predict do sklearn.

    O ExponentialSmoothing do statsmodels trabalha com séries temporais univariadas,
    então este wrapper extrai o índice temporal e treina internamente.
    """
    def __init__(self):
        self._model = None
        self._last_values = None

    def fit(self, X, y, **kwargs):
        """Treina o modelo ExponentialSmoothing com a série temporal y."""
        try:
            self._model = ExponentialSmoothing(
                y.values,
                trend='add',
                seasonal='add',
                seasonal_periods=7,
                damped_trend=True
            ).fit()
            self._last_values = y.values
        except Exception:
            # Se falhar (poucos dados, etc.), cria um modelo dummy de média
            self._model = None
            self._mean = float(y.mean())
        return self

    def predict(self, X):
        """Prevê usando o modelo treinado. O número de previsões corresponde ao tamanho de X."""
        n = len(X)
        if self._model is not None:
            try:
                forecast = self._model.forecast(n)
                return forecast.values if hasattr(forecast, 'values') else np.array(forecast)
            except Exception:
                pass
        # Fallback: retorna a média dos últimos valores
        if self._last_values is not None:
            return np.full(n, np.mean(self._last_values[-7:]))
        return np.full(n, getattr(self, '_mean', 0))


class CallCenterForecaster:
    def __init__(self):
        # O modelo campeão será escolhido dinamicamente
        self.vol_model = None
        self.tmo_model = None
        # Histórico da curva de distribuição (intervalos de 30 mins)
        self.distribution_curve = {}
        self.history_stats = {}
        self.is_trained = False
        # Ensemble support
        self._use_ensemble = False
        self._ensemble_models = []
        self._ensemble_weights = []
        # Confidence interval support
        self._forecast_std = 0.0
        # Residuais por dia da semana (para intervalos de confiança específicos)
        self._residuals_by_dow = {}
        self._std_by_dow = {}
        # Armazenar dados diários para rolling evaluation e trend detection
        self._df_daily_train = None

    def _extract_features(self, df, add_lags=False):
        """Extrai features de data para o modelo de ML.
        
        Args:
            df: DataFrame com coluna 'data'
            add_lags: Se True, calcula volume_lag_7d (apenas para treino, pois precisa de histórico)
        """
        import holidays
        import calendar
        br_holidays = holidays.Brazil()
        
        df_features = df.copy()
        df_features['data'] = pd.to_datetime(df_features['data'], dayfirst=True)
        
        # Features básicas
        df_features['dia_semana'] = df_features['data'].dt.dayofweek
        df_features['dia_mes'] = df_features['data'].dt.day
        df_features['mes'] = df_features['data'].dt.month

        # Cyclical encoding for seasonal features (sin/cos)
        df_features['dia_semana_sin'] = np.sin(2 * np.pi * df_features['dia_semana'] / 7)
        df_features['dia_semana_cos'] = np.cos(2 * np.pi * df_features['dia_semana'] / 7)
        df_features['mes_sin'] = np.sin(2 * np.pi * df_features['mes'] / 12)
        df_features['mes_cos'] = np.cos(2 * np.pi * df_features['mes'] / 12)
        
        # Feature: Dia Útil do Mês (1º dia útil, 2º dia útil, etc.)
        def get_dia_util_mes(data_obj):
            ano = data_obj.year
            mes = data_obj.month
            dia = data_obj.day
            if data_obj.weekday() >= 5 or data_obj in br_holidays:
                return 0
            dia_util = 0
            for d in range(1, dia + 1):
                dt = datetime.date(ano, mes, d)
                if dt.weekday() < 5 and dt not in br_holidays:
                    dia_util += 1
            return dia_util
            
        df_features['dia_util_mes'] = df_features['data'].apply(get_dia_util_mes)
        
        # Feature: É feriado? (0 ou 1)
        df_features['is_feriado'] = df_features['data'].apply(
            lambda x: 1 if x.date() in br_holidays or x.weekday() >= 5 else 0
        )
        
        # Feature: É véspera de feriado? (0 ou 1)
        df_features['is_vespera_feriado'] = df_features['data'].apply(
            lambda x: 1 if (x.date() + datetime.timedelta(days=1)) in br_holidays else 0
        )
        
        # Feature: É o 5º dia útil do mês? (dia de pagamento — DMM típico)
        df_features['is_5o_dia_util'] = np.where(df_features['dia_util_mes'] == 5, 1, 0)
        
        # Feature: É dia 20 do mês? (vencimento de contas/faturas)
        df_features['is_dia_20'] = np.where(df_features['data'].dt.day == 20, 1, 0)
        
        # Feature: É pós-feriado? (0 ou 1) 
        df_features['is_pos_feriado'] = df_features['data'].apply(
            lambda x: 1 if (x.date() - datetime.timedelta(days=1)) in br_holidays else 0
        )
        
        # Feature: Semana do mês (1 a 5)
        df_features['semana_do_mes'] = ((df_features['data'].dt.day - 1) // 7) + 1
        
        # Feature: Quinzena (1 ou 2)
        df_features['quinzena'] = np.where(df_features['data'].dt.day <= 15, 1, 2)
        
        # Feature: Início do mês (dia <= 5)
        df_features['is_inicio_mes'] = np.where(df_features['data'].dt.day <= 5, 1, 0)
        
        # Feature: Fim do mês (dia >= 25)
        df_features['is_fim_mes'] = np.where(df_features['data'].dt.day >= 25, 1, 0)
        
        # Feature: Dias até o próximo feriado (0 a 7, capped em 7)
        def dias_ate_feriado(data_obj):
            for i in range(1, 8):
                prox = data_obj.date() + datetime.timedelta(days=i)
                if prox in br_holidays:
                    return i
            return 7  # Se não há feriado nos próximos 7 dias
            
        df_features['dias_ate_feriado'] = df_features['data'].apply(dias_ate_feriado)

        # === NOVAS FEATURES DE CALENDÁRIO ===

        # Feature: Semana de pagamento (dias 1-7 do mês — período comum de folha de pagamento no Brasil)
        df_features['is_payday_week'] = np.where(
            (df_features['data'].dt.day >= 1) & (df_features['data'].dt.day <= 7), 1, 0
        )

        # Feature: Progresso do mês (0.0 a 1.0, representando o avanço no mês)
        df_features['mes_progress'] = df_features['data'].apply(
            lambda x: x.day / calendar.monthrange(x.year, x.month)[1]
        )

        # Feature: Período pré-pago (dias 1-5 — padrão de recarga de créditos pré-pagos)
        df_features['is_pre_pago'] = np.where(
            (df_features['data'].dt.day >= 1) & (df_features['data'].dt.day <= 5), 1, 0
        )

        # Feature: Período pós-pago (dias 15-25 — ciclo de faturas pós-pagas)
        df_features['is_pos_pago'] = np.where(
            (df_features['data'].dt.day >= 15) & (df_features['data'].dt.day <= 25), 1, 0
        )

        # Feature: Dias desde o último feriado (0 a 7, capped em 7)
        def dias_desde_feriado(data_obj):
            for i in range(0, 8):
                anterior = data_obj.date() - datetime.timedelta(days=i)
                if anterior in br_holidays:
                    return i
            return 7  # Se não há feriado nos últimos 7 dias

        df_features['dias_desde_ultimo_feriado'] = df_features['data'].apply(dias_desde_feriado)

        # Feature: Início da quinzena (dia <= 15)
        df_features['is_quinzena_inicio'] = np.where(df_features['data'].dt.day <= 15, 1, 0)

        # Feature: Fim da quinzena (dia > 15)
        df_features['is_quinzena_fim'] = np.where(df_features['data'].dt.day > 15, 1, 0)
        
        # Feature: Lag de volume (média dos últimos 7 dias) — apenas durante treino
        if add_lags and 'volume' in df_features.columns:
            df_features = df_features.sort_values('data')
            df_features['volume_lag_7d'] = df_features['volume'].rolling(window=7, min_periods=1).mean().fillna(0).astype(int)
        else:
            df_features['volume_lag_7d'] = 0
        
        return df_features
        
    def train(self, df_history: pd.DataFrame, dias_semana: list = None, anos_selecionados: list = None):
        """
        Treina o modelo com dados históricos.
        df_history deve conter: data, intervalo, volume, tmo
        dias_semana: lista de inteiros (0=Seg a 6=Dom) para filtrar o histórico.
        anos_selecionados: lista de inteiros (ex: [2024, 2025]) para filtrar o histórico.
        """
        # Tratar datas mistas (strings no formato DD/MM/YYYY e números de série do Excel)
        num_dates = pd.to_numeric(df_history['data'], errors='coerce')
        mask_str = num_dates.isna()
        
        dates_str = pd.to_datetime(df_history.loc[mask_str, 'data'], dayfirst=True, errors='coerce')
        dates_num = pd.to_datetime(num_dates.dropna(), origin='1899-12-30', unit='D', errors='coerce')
        
        df_history['data'] = dates_str.combine_first(dates_num)
        
        # Padronizar formato do intervalo para HH:MM
        if 'intervalo' in df_history.columns:
            # Extrair HH:MM e preencher com 0 à esquerda (ex: 7:30 -> 07:30)
            df_history['intervalo'] = df_history['intervalo'].astype(str).str.extract(r'(\d{1,2}:\d{2})')[0]
            df_history['intervalo'] = df_history['intervalo'].apply(lambda x: x.zfill(5) if pd.notna(x) else x)
        
        # Remover linhas com datas nulas se houver
        df_history = df_history.dropna(subset=['data'])
        
        # Filtrar anos se solicitado
        if anos_selecionados is not None and len(anos_selecionados) > 0:
            df_history = df_history[df_history['data'].dt.year.isin(anos_selecionados)]
            
        # Filtrar dias da semana se solicitado
        if dias_semana is not None and len(dias_semana) > 0:
            df_history = df_history[df_history['data'].dt.dayofweek.isin(dias_semana)]
            
        # Ignorar linhas sem volume (NaN ou zero) — dias sem informação não entram no modelo
        df_history['volume'] = pd.to_numeric(df_history['volume'], errors='coerce')
        df_history = df_history[df_history['volume'].notna() & (df_history['volume'] > 0)]
        
        if df_history.empty:
            raise ValueError("Nenhum dado válido encontrado no arquivo para os filtros selecionados.")
            
        # Converter TMO para numérico, pois pode vir como string do CSV
        if 'tmo' in df_history.columns:
            df_history['tmo'] = pd.to_numeric(df_history['tmo'], errors='coerce')
        else:
            df_history['tmo'] = np.nan

        # 1. Agregar por dia para treinar o volume total diário e TMO médio
        df_daily = df_history.groupby('data').agg(
            volume=('volume', 'sum'),
            tmo=('tmo', 'mean')
        ).reset_index()
        
        # Extrair features PRIMEIRO, para sabermos quais dias são eventos de negócio importantes (DMM)
        df_features = self._extract_features(df_daily)

        # 2. Remover outliers por dia da semana usando o método IQR (padrão em forecast)
        # Um outlier é um dia com volume fora dos limites: Q1 - 1.5*IQR e Q3 + 1.5*IQR
        # IMPORTANTE: Nunca remover os dias de DMM (5º dia útil e dia 20) pois o pico é esperado!
        def _iqr_filter(grupo):
            q1 = grupo['volume'].quantile(0.25)
            q3 = grupo['volume'].quantile(0.75)
            iqr = q3 - q1
            lim_inf = q1 - 1.5 * iqr
            lim_sup = q3 + 1.5 * iqr
            
            # Manter se estiver dentro dos limites OU se for um dia de evento conhecido
            cond_limites = (grupo['volume'] >= lim_inf) & (grupo['volume'] <= lim_sup)
            cond_eventos = (grupo['is_5o_dia_util'] == 1) | (grupo['is_dia_20'] == 1)
            
            return grupo[cond_limites | cond_eventos]
        
        n_antes = len(df_features)
        df_features = df_features.groupby('dia_semana', group_keys=False).apply(_iqr_filter).reset_index(drop=True)
        # BUGFIX: pandas `apply` with groupby drops the grouping column when it returns a DataFrame. Re-adicionar:
        df_features['dia_semana'] = df_features['data'].dt.dayofweek
        
        n_depois = len(df_features)
        self.history_stats['outliers_removidos'] = n_antes - n_depois
        self.history_stats['dias_treinamento'] = n_depois

        # Se tmo é todo NaN, usar valor padrão de 240s para não travar o modelo
        if df_features['tmo'].isna().all():
            df_features['tmo'] = 240.0
        else:
            df_features['tmo'] = df_features['tmo'].fillna(df_features['tmo'].median())
        
        # Features compactas e comprovadas (including cyclical encoding + novas features)
        FEATURE_COLS = [
            'dia_semana', 'dia_mes', 'mes', 'dia_util_mes',
            'is_feriado', 'is_vespera_feriado',
            'is_5o_dia_util', 'is_dia_20',
            'dia_semana_sin', 'dia_semana_cos', 'mes_sin', 'mes_cos',
            # Novas features de calendário
            'is_payday_week', 'mes_progress', 'is_pre_pago', 'is_pos_pago',
            'dias_desde_ultimo_feriado', 'is_quinzena_inicio', 'is_quinzena_fim'
        ]
        FEATURE_LABELS = [
            'Dia da Semana', 'Dia do Mês', 'Mês', 'Dia Útil do Mês',
            'É Feriado/FDS', 'Véspera Feriado',
            '5º Dia Útil (Pagamento)', 'Dia 20 (Vencimentos)',
            'Dia Semana (sin)', 'Dia Semana (cos)', 'Mês (sin)', 'Mês (cos)',
            # Labels das novas features
            'Semana Pagamento (1-7)', 'Progresso do Mês', 'Pré-Pago (1-5)', 'Pós-Pago (15-25)',
            'Dias Desde Último Feriado', 'Quinzena Início', 'Quinzena Fim'
        ]
        self._feature_cols = FEATURE_COLS
        
        X = df_features[FEATURE_COLS]

        # Dicionário com os modelos candidatos (inclui XGBoost)
        try:
            from xgboost import XGBRegressor
            has_xgboost = True
        except ImportError:
            has_xgboost = False
            
        modelos_candidatos = {
            "RandomForest": RandomForestRegressor(n_estimators=100, random_state=42),
            "GradientBoosting": GradientBoostingRegressor(random_state=42),
            "DecisionTree": DecisionTreeRegressor(random_state=42),
            "LinearRegression": LinearRegression(),
            "Ridge": Ridge(),
            "KNN": KNeighborsRegressor(n_neighbors=min(5, max(1, len(df_features)-1)))
        }
        if has_xgboost:
            modelos_candidatos["XGBoost"] = XGBRegressor(
                n_estimators=100, learning_rate=0.1, max_depth=4,
                random_state=42, verbosity=0
            )

        # Adicionar ExponentialSmoothing como candidato (se statsmodels disponível)
        if _HAS_EXP_SMOOTH:
            modelos_candidatos["ExponentialSmoothing"] = _ExponentialSmoothingWrapper()

        # Backtesting com TimeSeriesSplit (validação temporal)
        from sklearn.model_selection import TimeSeriesSplit
        
        model_scores = []
        n_splits = min(5, max(2, len(df_features) // 10))
        
        # Armazenar validação detalhada por modelo
        model_validation_detail = {}

        if len(df_features) > 15:
            tscv = TimeSeriesSplit(n_splits=n_splits)
            
            for name, model in modelos_candidatos.items():
                maes = []
                rmses = []
                mapes = []
                train_maes = []
                val_maes = []
                is_exp_smooth = name == "ExponentialSmoothing"

                for fold_i, (train_idx, test_idx) in enumerate(tscv.split(X)):
                    X_train, X_test = X.iloc[train_idx], X.iloc[test_idx]
                    y_train = df_features['volume'].iloc[train_idx]
                    y_test = df_features['volume'].iloc[test_idx]
                    
                    model.fit(X_train, y_train)
                    preds = model.predict(X_test)
                    train_preds = model.predict(X_train)
                    
                    # MAE
                    fold_mae = mean_absolute_error(y_test, preds)
                    maes.append(fold_mae)
                    
                    # RMSE
                    fold_rmse = np.sqrt(mean_squared_error(y_test, preds))
                    rmses.append(fold_rmse)
                    
                    # MAPE
                    mape_fold = np.mean(np.abs((y_test - preds) / np.where(y_test == 0, 1e-8, y_test))) * 100
                    mapes.append(mape_fold)

                    # Erro de treino vs validação (para detectar overfitting)
                    train_mae = mean_absolute_error(y_train, train_preds)
                    train_maes.append(train_mae)
                    val_maes.append(fold_mae)
                
                mae_medio = np.mean(maes)
                rmse_medio = np.mean(rmses)
                mape_medio = np.mean(mapes)
                train_mae_medio = np.mean(train_maes)
                val_mae_medio = np.mean(val_maes)
                # Gap treino-validação (overfitting detection)
                overfit_gap = val_mae_medio - train_mae_medio
                acuracidade = max(0.0, 100 - mape_medio)
                
                model_scores.append({
                    "modelo": name, 
                    "erro_mae": round(mae_medio, 2), 
                    "erro_rmse": round(rmse_medio, 2),
                    "mape": round(mape_medio, 2),
                    "acuracidade": round(acuracidade, 1)
                })

                # Detalhamento por fold para validação aprimorada
                model_validation_detail[name] = {
                    "mae_medio": round(mae_medio, 2),
                    "rmse_medio": round(rmse_medio, 2),
                    "mape_medio": round(mape_medio, 2),
                    "train_mae_medio": round(train_mae_medio, 2),
                    "val_mae_medio": round(val_mae_medio, 2),
                    "overfit_gap": round(overfit_gap, 2),
                    "overfit_risk": "alto" if overfit_gap > mae_medio * 0.3 else ("moderado" if overfit_gap > mae_medio * 0.15 else "baixo"),
                    "folds": [
                        {
                            "fold": fold_i + 1,
                            "mae": round(maes[fold_i], 2),
                            "rmse": round(rmses[fold_i], 2),
                            "mape": round(mapes[fold_i], 2)
                        }
                        for fold_i in range(len(maes))
                    ]
                }
        else:
            for name in modelos_candidatos:
                model_scores.append({"modelo": name, "erro_mae": 0.0, "erro_rmse": 0.0, "mape": 0.0, "acuracidade": 0.0})
                model_validation_detail[name] = {
                    "mae_medio": 0.0, "rmse_medio": 0.0, "mape_medio": 0.0,
                    "train_mae_medio": 0.0, "val_mae_medio": 0.0,
                    "overfit_gap": 0.0, "overfit_risk": "indeterminado", "folds": []
                }

        # Armazenar validação detalhada nos history_stats
        self.history_stats['model_validation'] = model_validation_detail

        # Ensemble ponderado: top 3 modelos por MAE inverso
        model_scores.sort(key=lambda x: x["erro_mae"])
        campeao_nome = model_scores[0]["modelo"]

        # Filter out models with zero MAE (insufficient data case)
        valid_scores = [s for s in model_scores if s["erro_mae"] > 0]
        if len(valid_scores) >= 3:
            top3 = valid_scores[:3]
        elif len(valid_scores) >= 2:
            top3 = valid_scores[:2]
        elif len(valid_scores) >= 1:
            top3 = valid_scores[:1]
        else:
            # Fallback: use champion only
            top3 = model_scores[:1]

        # Calculate inverse-MAE weights
        inv_maes = [1.0 / s["erro_mae"] for s in top3]
        total_inv = sum(inv_maes)
        weights = [w / total_inv for w in inv_maes]

        # Fit top models on full data
        self._ensemble_models = []
        self._ensemble_weights = []
        for score_entry in top3:
            name = score_entry["modelo"]
            model = modelos_candidatos[name]
            model.fit(X, df_features['volume'])
            self._ensemble_models.append(model)

        self._ensemble_weights = weights
        self._use_ensemble = len(self._ensemble_models) > 1

        # Keep champion reference for feature importances etc.
        self.vol_model = self._ensemble_models[0]
        
        # O TMO usará Random Forest por padrão
        self.tmo_model = RandomForestRegressor(n_estimators=100, random_state=42)
        self.tmo_model.fit(X, df_features['tmo'])

        # Calculate forecast standard deviation from training residuals (for confidence intervals)
        # AGORA: calcular residuais POR DIA DA SEMANA para intervalos de confiança específicos
        y_pred_train = self._predict_volume(X)
        residuals = df_features['volume'].values - y_pred_train
        self._forecast_std = float(np.std(residuals))
        self.history_stats['forecast_std'] = round(self._forecast_std, 2)

        # Residuais separados por dia da semana
        self._residuals_by_dow = {}
        self._std_by_dow = {}
        for dow in range(7):
            mask = df_features['dia_semana'].values == dow
            if mask.sum() > 2:
                dow_residuals = residuals[mask]
                self._residuals_by_dow[dow] = dow_residuals
                self._std_by_dow[dow] = float(np.std(dow_residuals))
            else:
                self._residuals_by_dow[dow] = np.array([])
                self._std_by_dow[dow] = self._forecast_std  # Fallback para std global

        # Armazenar dados diários de treino para rolling evaluation e trend detection
        self._df_daily_train = df_features[['data', 'volume', 'tmo', 'dia_semana']].copy()

        # Armazenar metadados da metodologia para exibição no frontend
        tmo_tem_dado = not df_daily['tmo'].eq(240.0).all()
        tem_intervalo = 'intervalo' in df_history.columns and not (
            df_history['intervalo'].isna().all() or
            set(df_history['intervalo'].dropna().unique()) == {'00:00'}
        )
        
        importancias = {}
        if hasattr(self.vol_model, 'feature_importances_'):
            importancias = dict(zip(FEATURE_LABELS, [round(float(v) * 100, 1) for v in self.vol_model.feature_importances_]))
            
        periodo_inicio = df_daily['data'].min().strftime('%d/%m/%Y')
        periodo_fim = df_daily['data'].max().strftime('%d/%m/%Y')
        
        validacao_tipo = f"TimeSeriesSplit ({n_splits} dobras temporais)" if len(df_features) > 15 else "Dados insuficientes para validação cruzada"
        
        ensemble_desc = f"Ensemble ponderado ({len(self._ensemble_models)} modelos)" if self._use_ensemble else campeao_nome
        num_features = len(FEATURE_LABELS)
        sazonalidade_texto = (
            f"A sazonalidade foi calculada cruzando {num_features} variáveis de calendário "
            f"(dia da semana, dia do mês, mês, dia útil, feriado, véspera de feriado, "
            f"semana de pagamento, progresso do mês, ciclo pré/pós-pago, "
            f"e encoding ciclico sin/cos para dia da semana e mês). "
            f"O algoritmo '{ensemble_desc}' mapeou as tendências históricas para projetar o volume."
        )
        flutuacao_texto = (
            f"A flutuação foi tratada com remoção de {self.history_stats.get('outliers_removidos', 0)} "
            f"dias outliers + validação temporal ({validacao_tipo}) que garante que o modelo "
            f"nunca treina com dados do futuro."
        )

        self.history_stats['metodologia'] = {
            'algoritmo_volume': ensemble_desc,
            'modelos_testados': model_scores,
            'sazonalidade_explicacao': sazonalidade_texto,
            'flutuacao_explicacao': flutuacao_texto,
            'algoritmo_tmo': 'RandomForestRegressor',
            'features': FEATURE_LABELS,
            'importancia_features': importancias,
            'outlier_metodo': 'IQR por Dia da Semana (Q1 - 1.5×IQR | Q3 + 1.5×IQR)',
            'outliers_removidos': self.history_stats.get('outliers_removidos', 0),
            'dias_treinamento': self.history_stats.get('dias_treinamento', 0),
            'periodo_historico': f'{periodo_inicio} a {periodo_fim}',
            'validacao': validacao_tipo,
            'curva_diaria_fonte': 'Histórico real de intervalos' if tem_intervalo else 'Distribuição uniforme 08:00–20:00',
            'tmo_fonte': 'Histórico real de TMO' if tmo_tem_dado else 'Valor padrão 240s',
        }
        
        # 2. Calcular a curva de distribuição intra-diária padrão
        if 'intervalo' not in df_history.columns or df_history['intervalo'].isna().all() or set(df_history['intervalo'].dropna().unique()) == {'00:00'}:
            # Sem dados de intervalo: usar curva hardcoded extraída da imagem
            from generated_curve import HARDCODED_CURVE
            for dia in range(7):
                self.distribution_curve[dia] = HARDCODED_CURVE.get(dia, HARDCODED_CURVE[0])
            self.distribution_curve['consolidado'] = HARDCODED_CURVE.get(0, {})
        else:
            df_history = df_history.merge(df_daily[['data', 'volume']], on='data', suffixes=('', '_total'))
            df_history['proporcao'] = df_history['volume'] / df_history['volume_total'].replace(0, np.nan)
            df_history['proporcao'] = df_history['proporcao'].fillna(0)
            
            df_history['dia_semana'] = df_history['data'].dt.dayofweek
            curve = df_history.groupby(['dia_semana', 'intervalo'])['proporcao'].mean().reset_index()
            
            sum_props = curve.groupby('dia_semana')['proporcao'].sum().reset_index(name='sum_prop')
            curve = curve.merge(sum_props, on='dia_semana')
            curve['proporcao'] = curve['proporcao'] / curve['sum_prop'].replace(0, np.nan)
            curve['proporcao'] = curve['proporcao'].fillna(0)
            
            for dia in range(7):
                self.distribution_curve[dia] = {}
                
            for _, row in curve.iterrows():
                dia = int(row['dia_semana'])
                interv = row['intervalo']
                prop = row['proporcao']
                self.distribution_curve[dia][interv] = prop
                
            # Calcular curva consolidada ponderada pelo volume total de cada intervalo
            vol_por_interv = df_history.groupby('intervalo')['volume'].sum()
            soma_total = vol_por_interv.sum()
            if soma_total > 0:
                self.distribution_curve['consolidado'] = (vol_por_interv / soma_total).to_dict()
            else:
                self.distribution_curve['consolidado'] = self.distribution_curve.get(0, {})

            # 1. consolidado_mediana
            vol_mediano_interv = df_history.groupby('intervalo')['volume'].median()
            soma_mediana = vol_mediano_interv.sum()
            if soma_mediana > 0:
                self.distribution_curve['consolidado_mediana'] = (vol_mediano_interv / soma_mediana).to_dict()
            else:
                self.distribution_curve['consolidado_mediana'] = self.distribution_curve.get('consolidado', {})

            # 2. consolidado_desvio (Média + 1 Desvio Padrão)
            agrupamento_interv = df_history.groupby('intervalo')['volume']
            vol_media = agrupamento_interv.mean()
            vol_std = agrupamento_interv.std().fillna(0)
            vol_desvio = vol_media + vol_std
            soma_desvio = vol_desvio.sum()
            if soma_desvio > 0:
                self.distribution_curve['consolidado_desvio'] = (vol_desvio / soma_desvio).to_dict()
            else:
                self.distribution_curve['consolidado_desvio'] = self.distribution_curve.get('consolidado', {})

            # 3. consolidado_sem_outlier
            def soma_sem_outliers(s):
                q1 = s.quantile(0.25)
                q3 = s.quantile(0.75)
                iqr = q3 - q1
                limite_inf = q1 - 1.5 * iqr
                limite_sup = q3 + 1.5 * iqr
                return s[(s >= limite_inf) & (s <= limite_sup)].sum()
            
            vol_sem_outlier = agrupamento_interv.apply(soma_sem_outliers)
            soma_sem_outlier_tot = vol_sem_outlier.sum()
            if soma_sem_outlier_tot > 0:
                self.distribution_curve['consolidado_sem_outlier'] = (vol_sem_outlier / soma_sem_outlier_tot).to_dict()
            else:
                self.distribution_curve['consolidado_sem_outlier'] = self.distribution_curve.get('consolidado', {})
                
            # Calcular matrizes (Pivot Table de Intervalo x Dia da Semana)
            df_history['ano_mes'] = df_history['data'].dt.to_period('M').astype(str)
            matrizes = {}
            matrizes_tmo = {}
            
            # Matriz Completa
            matrizes['completo'] = df_history.pivot_table(
                index='intervalo', columns='dia_semana', values='volume', aggfunc='sum', fill_value=0
            ).to_dict('index')
            
            matrizes_tmo['completo'] = df_history.pivot_table(
                index='intervalo', columns='dia_semana', values='tmo', aggfunc='mean', fill_value=0
            ).to_dict('index')
            
            # Matrizes Mensais e Curvas Consolidadas Mensais
            meses_unicos = df_history['ano_mes'].unique()
            for mes in meses_unicos:
                df_mes = df_history[df_history['ano_mes'] == mes]
                matrizes[mes] = df_mes.pivot_table(
                    index='intervalo', columns='dia_semana', values='volume', aggfunc='sum', fill_value=0
                ).to_dict('index')
                
                matrizes_tmo[mes] = df_mes.pivot_table(
                    index='intervalo', columns='dia_semana', values='tmo', aggfunc='mean', fill_value=0
                ).to_dict('index')
                
                vol_por_interv_mes = df_mes.groupby('intervalo')['volume'].sum()
                soma_total_mes = vol_por_interv_mes.sum()
                if soma_total_mes > 0:
                    self.distribution_curve[f'consolidado_{mes}'] = (vol_por_interv_mes / soma_total_mes).to_dict()
                else:
                    self.distribution_curve[f'consolidado_{mes}'] = self.distribution_curve.get('consolidado', {})
                
                for dia_idx in range(7):
                    df_mes_dia = df_mes[df_mes['dia_semana'] == dia_idx]
                    if not df_mes_dia.empty:
                        vol_por_interv_mes_dia = df_mes_dia.groupby('intervalo')['volume'].sum()
                        soma_total_mes_dia = vol_por_interv_mes_dia.sum()
                        if soma_total_mes_dia > 0:
                            self.distribution_curve[f'{dia_idx}_{mes}'] = (vol_por_interv_mes_dia / soma_total_mes_dia).to_dict()
                    
            self.history_stats['matrizes_intervalo'] = matrizes
            self.history_stats['matrizes_tmo'] = matrizes_tmo
            
        # 3. Calcular estatísticas do histórico (Mensal e Maior Volume)
        # Garantir que df_history_stats seja baseado nos dados diários
        df_daily_stats = df_daily.copy()
        max_vol_idx = df_daily_stats['volume'].idxmax()
        max_vol_row = df_daily_stats.loc[max_vol_idx]
        
        self.history_stats['max_volume_day'] = {
            "data": max_vol_row['data'].strftime('%Y-%m-%d'),
            "volume": int(max_vol_row['volume'])
        }
        
        df_daily['ano_mes'] = df_daily['data'].dt.to_period('M').astype(str)
        df_monthly = df_daily.groupby('ano_mes')['volume'].sum().reset_index()
        # Sort by ano_mes to ensure chronological order
        df_monthly = df_monthly.sort_values('ano_mes')
        self.history_stats['monthly_history'] = df_monthly.to_dict('records')
            
        # 4. Novas visões detalhadas da planilha (Fase 2)
        # Visão por Quinzena
        df_daily_stats['quinzena'] = np.where(df_daily_stats['data'].dt.day <= 15, '1', '2')
        quinzena_stats = df_daily_stats.groupby('quinzena')['volume'].sum().reset_index()
        total_vol = df_daily_stats['volume'].sum()
        quinzena_stats['percentual'] = (quinzena_stats['volume'] / total_vol * 100).round(2)
        self.history_stats['visao_quinzena'] = quinzena_stats.to_dict('records')
        
        # Ranking Top Dias
        df_top_dias = df_daily_stats.sort_values(by='volume', ascending=False).head(10).copy()
        df_top_dias['percentual'] = (df_top_dias['volume'] / total_vol * 100).round(2)
        df_top_dias['data_str'] = df_top_dias['data'].dt.strftime('%d/%m/%Y')
        df_top_dias['dia_semana_str'] = df_top_dias['data'].dt.strftime('%A')
        self.history_stats['ranking_dias'] = df_top_dias[['data_str', 'dia_semana_str', 'volume', 'percentual']].to_dict('records')
        
        # Visão por Semana (Matriz) - Quebrada por Ano e Mês
        df_daily_stats['semana_mes'] = ((df_daily_stats['data'].dt.day - 1) // 7) + 1
        df_daily_stats['dia_semana'] = df_daily_stats['data'].dt.dayofweek # 0=Seg, 6=Dom
        df_daily_stats['ano'] = df_daily_stats['data'].dt.year
        df_daily_stats['mes_num'] = df_daily_stats['data'].dt.month
        
        meses_nomes = {1: 'Jan', 2: 'Fev', 3: 'Mar', 4: 'Abr', 5: 'Mai', 6: 'Jun', 
                       7: 'Jul', 8: 'Ago', 9: 'Set', 10: 'Out', 11: 'Nov', 12: 'Dez'}
                       
        semana_matriz = df_daily_stats.pivot_table(
            index=['ano', 'mes_num', 'semana_mes'], 
            columns='dia_semana', 
            values='volume', 
            aggfunc='sum', 
            fill_value=0
        )
        
        dias_map = {0: 'seg', 1: 'ter', 2: 'qua', 3: 'qui', 4: 'sex', 5: 'sab', 6: 'dom'}
        visao_semana = []
        
        if not semana_matriz.empty:
            for idx, row_data in semana_matriz.iterrows():
                ano, mes_num, sem = idx
                row = {
                    "ano": ano,
                    "mes": meses_nomes.get(mes_num, ""),
                    "semana": sem
                }
                
                for ds in range(7):
                    vol = 0
                    if ds in row_data.index:
                        vol = int(row_data[ds])
                    row[dias_map[ds]] = vol
                    
                row["total"] = sum(row[dias_map[ds]] for ds in range(7))
                visao_semana.append(row)
                
            # Ordenar para garantir cronologia correta: Ano descendente, Mês descendente, Semana
            visao_semana.sort(key=lambda x: (-x['ano'], -list(meses_nomes.keys())[list(meses_nomes.values()).index(x['mes'])], x['semana']))

        self.history_stats['visao_semana'] = visao_semana
        
        # Comparativo de Curvas (M.Geo, Quartil, Desvio) por dia do mês
        df_daily_stats['dia_mes'] = df_daily_stats['data'].dt.day
        curvas = []
        for d in range(1, 32):
            vols = df_daily_stats[df_daily_stats['dia_mes'] == d]['volume'].values
            if len(vols) > 0:
                vols_pos = vols[vols > 0]
                m_geo = int(np.exp(np.mean(np.log(vols_pos)))) if len(vols_pos) > 0 else 0
                quartil = int(np.percentile(vols, 75))
                desvio_p = int(np.mean(vols) + np.std(vols))
                curvas.append({
                    "dia": d,
                    "m_geo": m_geo,
                    "quartil": quartil,
                    "desvio_p": desvio_p
                })
        self.history_stats['comparativo_curvas'] = curvas
            
        # 5. Fase 3: Calendário e Histórico Anual
        # Calendário
        br_holidays = holidays.Brazil()
        anos_meses = df_daily_stats[['data']].copy()
        anos_meses['ano'] = anos_meses['data'].dt.year
        anos_meses['mes'] = anos_meses['data'].dt.month
        anos_meses_unicos = anos_meses[['ano', 'mes']].drop_duplicates()
        
        calendario_stats = []
        for _, row in anos_meses_unicos.iterrows():
            y = int(row['ano'])
            m = int(row['mes'])
            _, num_days = calendar.monthrange(y, m)
            
            # Count weekdays
            counts = {0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0}
            feriados_count = 0
            du_count = 0
            for d in range(1, num_days + 1):
                dt = datetime.date(y, m, d)
                wd = dt.weekday()
                counts[wd] += 1
                
                is_feriado = dt in br_holidays
                if is_feriado:
                    feriados_count += 1
                    
                if wd < 5 and not is_feriado:
                    du_count += 1
                    
            calendario_stats.append({
                "ano": y,
                "mes": m,
                "seg": counts[0],
                "ter": counts[1],
                "qua": counts[2],
                "qui": counts[3],
                "sex": counts[4],
                "sab": counts[5],
                "dom": counts[6],
                "dias": num_days,
                "du": du_count,
                "feriados": feriados_count
            })
        self.history_stats['calendario'] = calendario_stats
        
        # Histórico Anual (Matriz Ano x Mês)
        # Reusar df_monthly: columns 'ano_mes', 'volume'
        # Criar colunas separadas
        df_monthly_split = df_monthly.copy()
        df_monthly_split['ano'] = df_monthly_split['ano_mes'].str[:4].astype(int)
        df_monthly_split['mes'] = df_monthly_split['ano_mes'].str[5:7].astype(int)
        
        matriz_anual = df_monthly_split.pivot_table(index='ano', columns='mes', values='volume', aggfunc='sum', fill_value=0)
        
        historico_anual = []
        max_ano = matriz_anual.index.max() if not matriz_anual.empty else datetime.datetime.now().year
        
        for ano in matriz_anual.index:
            row_ano = {"ano": int(ano)}
            total_ano = 0
            for m in range(1, 13):
                vol_m = float(matriz_anual.loc[ano, m]) if m in matriz_anual.columns else 0.0
                
                # Se for o último ano e o volume for zero, fazemos a reprojeção
                if ano == max_ano and vol_m == 0:
                    try:
                        _, num_days = calendar.monthrange(int(ano), m)
                        datas_mes = pd.date_range(start=f"{ano}-{m:02d}-01", end=f"{ano}-{m:02d}-{num_days}")
                        df_futuro = pd.DataFrame({'data': datas_mes})
                        df_futuro_features = self._extract_features(df_futuro)
                        X_futuro = df_futuro_features[self._feature_cols]
                        
                        preds = self._predict_volume(X_futuro)
                        vol_m = sum(preds)
                        row_ano[f"is_proj_{m}"] = True
                    except:
                        pass
                else:
                    row_ano[f"is_proj_{m}"] = False
                
                row_ano[f"mes_{m}"] = int(vol_m)
                total_ano += vol_m
                
            row_ano["total"] = int(total_ano)
            historico_anual.append(row_ano)
            
        self.history_stats['historico_anual'] = historico_anual
        
        # Variação Mês a Mês (Agora usando historico_anual para incluir projeções)
        variacao_anual = []
        vol_anterior = 0.0
        
        for row_hist in historico_anual:
            row_var = {"ano": row_hist["ano"]}
            for m in range(1, 13):
                vol_atual = float(row_hist.get(f"mes_{m}", 0))
                
                if vol_atual > 0 and vol_anterior > 0:
                    var = ((vol_atual - vol_anterior) / vol_anterior) * 100
                else:
                    var = 0.0
                    
                row_var[f"mes_{m}"] = round(var, 1)
                vol_anterior = vol_atual
                
            variacao_anual.append(row_var)
            
        self.history_stats['variacao_anual'] = variacao_anual
            
        # Fase 4: Baseline Histórico Semanal (Últimos 6 meses)
        df_daily_stats['ano_mes'] = df_daily_stats['data'].dt.to_period('M').astype(str)
        meses_unicos = df_daily_stats['ano_mes'].drop_duplicates().sort_values(ascending=False).head(6).tolist()
        meses_unicos.sort() # Ordenar cronológico
        
        baseline_meses = []
        for am in meses_unicos:
            df_mes = df_daily_stats[df_daily_stats['ano_mes'] == am]
            vol_seg = int(df_mes[df_mes['dia_semana'] == 0]['volume'].mean()) if not df_mes[df_mes['dia_semana'] == 0].empty else 0
            vol_ter = int(df_mes[df_mes['dia_semana'] == 1]['volume'].mean()) if not df_mes[df_mes['dia_semana'] == 1].empty else 0
            vol_qua = int(df_mes[df_mes['dia_semana'] == 2]['volume'].mean()) if not df_mes[df_mes['dia_semana'] == 2].empty else 0
            vol_qui = int(df_mes[df_mes['dia_semana'] == 3]['volume'].mean()) if not df_mes[df_mes['dia_semana'] == 3].empty else 0
            vol_sex = int(df_mes[df_mes['dia_semana'] == 4]['volume'].mean()) if not df_mes[df_mes['dia_semana'] == 4].empty else 0
            vol_sab = int(df_mes[df_mes['dia_semana'] == 5]['volume'].mean()) if not df_mes[df_mes['dia_semana'] == 5].empty else 0
            vol_dom = int(df_mes[df_mes['dia_semana'] == 6]['volume'].mean()) if not df_mes[df_mes['dia_semana'] == 6].empty else 0
            total = int(df_mes['volume'].sum())
            
            baseline_meses.append({
                "ano_mes": am,
                "ano": am[:4],
                "mes": am[5:7],
                "seg": vol_seg,
                "ter": vol_ter,
                "qua": vol_qua,
                "qui": vol_qui,
                "sex": vol_sex,
                "sab": vol_sab,
                "dom": vol_dom,
                "total": total
            })
            
        self.history_stats['baseline_meses'] = baseline_meses

        # WFM Metrics: comprehensive workforce management statistics
        avg_daily_volume = float(df_daily_stats['volume'].mean())
        avg_tmo = float(df_daily_stats['tmo'].mean()) if 'tmo' in df_daily_stats.columns and df_daily_stats['tmo'].notna().any() else 240.0
        std_daily_volume = float(df_daily_stats['volume'].std())
        volatility_index = round(std_daily_volume / avg_daily_volume, 4) if avg_daily_volume > 0 else 0.0

        # Peak hour: hour with highest avg volume (from interval data)
        peak_hour = "N/A"
        if 'intervalo' in df_history.columns and not df_history['intervalo'].isna().all():
            vol_by_interval = df_history.groupby('intervalo')['volume'].mean()
            if not vol_by_interval.empty:
                peak_interval = vol_by_interval.idxmax()
                # Convert interval like "14:00" to hour "14h"
                peak_hour = f"{peak_interval}"

        # Weekday vs weekend ratio
        weekday_vols = df_daily_stats[df_daily_stats['data'].dt.dayofweek < 5]['volume']
        weekend_vols = df_daily_stats[df_daily_stats['data'].dt.dayofweek >= 5]['volume']
        weekday_avg = float(weekday_vols.mean()) if not weekday_vols.empty else 0.0
        weekend_avg = float(weekend_vols.mean()) if not weekend_vols.empty else 1.0
        weekday_weekend_ratio = round(weekday_avg / weekend_avg, 2) if weekend_avg > 0 else 0.0

        self.history_stats['wfm_metrics'] = {
            "avg_daily_volume": round(avg_daily_volume, 1),
            "avg_tmo": round(avg_tmo, 1),
            "peak_hour": peak_hour,
            "volatility_index": volatility_index,
            "weekday_weekend_ratio": weekday_weekend_ratio,
        }

        self.is_trained = True
        return {"status": "Treinamento concluído com sucesso"}
        
    def _predict_volume(self, X):
        """Prediz volume usando Ensemble ponderado ou modelo único."""
        if getattr(self, '_use_ensemble', False):
            preds = np.zeros(len(X))
            for model, weight in zip(self._ensemble_models, self._ensemble_weights):
                preds += model.predict(X) * weight
        else:
            preds = self.vol_model.predict(X)
            
        # Pós-processamento (Regra de Negócio):
        # Como o volume de Segundas-feiras costuma ser muito alto na média, o modelo pode ofuscar
        # o pico do 5º dia útil se o histórico fornecido for curto.
        # Para garantir a premissa de negócio (DMM no 5º dia útil e Dia 20), aplicamos um multiplicador
        # que representa o comportamento real do mercado de Call Center.
        if 'is_5o_dia_util' in X.columns and 'is_dia_20' in X.columns:
            preds = np.where(X['is_5o_dia_util'] == 1, preds * 1.35, preds)
            preds = np.where(X['is_dia_20'] == 1, preds * 1.25, preds)
            
        return preds.astype(int)

    def _distribute_volume(self, total_vol, curva_dia, tmo_previsto, tmo_per_interval=None):
        """Distribui o volume total diário nos intervalos da curva intra-diária.

        Args:
            total_vol: Volume total previsto para o dia.
            curva_dia: Dict {intervalo: proporção} para o dia da semana.
            tmo_previsto: TMO médio previsto para o dia (fallback).
            tmo_per_interval: Optional dict {intervalo: tmo} com TMO específico por intervalo.
        """
        dist_vols = []
        for interv, prop in sorted(curva_dia.items()):
            exact = total_vol * prop
            int_part = int(exact)
            frac = exact - int_part
            # Use per-interval TMO if available, otherwise fall back to daily TMO
            tmo = int(tmo_per_interval.get(interv, tmo_previsto)) if tmo_per_interval else int(tmo_previsto)
            dist_vols.append({"intervalo": interv, "volume": int_part, "frac": frac, "tmo": tmo})
            
        sum_ints = sum(x["volume"] for x in dist_vols)
        rem = int(total_vol) - sum_ints
        
        dist_vols.sort(key=lambda x: x["frac"], reverse=True)
        for i in range(rem):
            if i < len(dist_vols):
                dist_vols[i]["volume"] += 1
                
        dist_vols.sort(key=lambda x: x["intervalo"])
        
        intervalos = []
        for dv in dist_vols:
            intervalos.append({
                "intervalo": dv["intervalo"],
                "volume": dv["volume"],
                "tmo": dv["tmo"]
            })
        return intervalos

    def _estimate_abandon_rate(self, agents, traffic, tmo, avg_patience_time=60):
        """Estimates call abandon rate using Erlang C and average patience time.

        Uses the formula:
            P(abandon) = P(wait) * exp(-(agents - traffic) * (patience_time / tmo))

        Args:
            agents: Number of agents (after shrinkage).
            traffic: Traffic in Erlangs (volume * tmo / interval_seconds).
            tmo: Average handling time in seconds.
            avg_patience_time: Average caller patience time in seconds (default 60s).

        Returns:
            Abandon rate as a float between 0.0 and 1.0.
        """
        if agents <= 0 or traffic <= 0 or tmo <= 0:
            return 0.0

        # If system is overloaded, all callers who wait will eventually abandon
        if agents <= traffic:
            return 1.0

        # Calculate Erlang C probability P(wait > 0)
        # Using Erlang B inversion method
        invB = 1.0
        for i in range(1, agents + 1):
            invB = 1.0 + invB * (i / traffic)
        erlangB = 1.0 / invB

        prob_wait = erlangB / (1.0 - (traffic / agents) * (1.0 - erlangB))

        # Abandon rate formula
        abandon_rate = prob_wait * np.exp(-(agents - traffic) * (avg_patience_time / tmo))

        return float(min(1.0, max(0.0, abandon_rate)))

    def _get_tmo_per_interval(self, dia_semana):
        """Look up per-interval TMO from the historical TMO matrix for a given day_of_week.

        Returns:
            Dict {intervalo: tmo_value} or empty dict if no data available.
        """
        matrizes_tmo = self.history_stats.get('matrizes_tmo', {})
        tmo_matrix = matrizes_tmo.get('completo', {})
        tmo_per_interval = {}
        for interv_key, dow_vals in tmo_matrix.items():
            tmo_val = dow_vals.get(dia_semana, 0)
            if tmo_val and tmo_val > 0:
                tmo_per_interval[interv_key] = tmo_val
        return tmo_per_interval

    def get_stats(self):
        if not self.is_trained:
            return None
        return self.history_stats

    def forecast(self, days_ahead=30):
        """
        Gera previsão diária e a quebra intra-diária.
        """
        if not self.is_trained:
            raise ValueError("Modelo não treinado. Envie histórico primeiro.")
            
        hoje = datetime.date.today()
        datas = [hoje + datetime.timedelta(days=i) for i in range(1, days_ahead + 1)]
        df_pred = pd.DataFrame({'data': datas})
        df_features = self._extract_features(df_pred)
        
        X = df_features[self._feature_cols]
        df_pred['volume_previsto'] = self._predict_volume(X)
        df_pred['tmo_previsto'] = self.tmo_model.predict(X).astype(int)
        
        forecast_std = getattr(self, '_forecast_std', 0.0)
        
        # Gerar a curva intra-diária
        resultados = []
        for _, row in df_pred.iterrows():
            dia_semana = row['data'].weekday()
            curva_dia = self.distribution_curve.get(dia_semana, {})
            
            # Per-interval TMO lookup
            tmo_per_interval = self._get_tmo_per_interval(dia_semana)
            intervalos = self._distribute_volume(
                row['volume_previsto'], curva_dia, row['tmo_previsto'],
                tmo_per_interval=tmo_per_interval
            )

            # Intervalos de confiança específicos por dia da semana
            dow_std = self._std_by_dow.get(dia_semana, forecast_std)
                
            resultados.append({
                "data": row['data'].isoformat(),
                "volume_total": row['volume_previsto'],
                "tmo_medio": row['tmo_previsto'],
                "volume_lower": max(0, int(row['volume_previsto'] - forecast_std)),
                "volume_upper": int(row['volume_previsto'] + forecast_std),
                "volume_lower_dow": max(0, int(row['volume_previsto'] - dow_std)),
                "volume_upper_dow": int(row['volume_previsto'] + dow_std),
                "intervalos": intervalos
            })
            
        return resultados

    def forecast_month(self, year: int, month: int):
        """
        Gera previsão diária para todos os dias de um mês/ano específico.
        """
        if not self.is_trained:
            raise ValueError("Modelo não treinado. Envie histórico primeiro.")
            
        _, num_days = calendar.monthrange(year, month)
        datas = [datetime.date(year, month, day) for day in range(1, num_days + 1)]
        df_pred = pd.DataFrame({'data': datas})
        df_features = self._extract_features(df_pred)
        
        X = df_features[self._feature_cols]
        df_pred['volume_previsto'] = self._predict_volume(X)
        df_pred['tmo_previsto'] = self.tmo_model.predict(X).astype(int)
        
        forecast_std = getattr(self, '_forecast_std', 0.0)
        
        resultados = []
        for _, row in df_pred.iterrows():
            dia_semana = row['data'].weekday()
            curva_dia = self.distribution_curve.get(dia_semana, {})
            
            # Per-interval TMO lookup
            tmo_per_interval = self._get_tmo_per_interval(dia_semana)
            intervalos = self._distribute_volume(
                row['volume_previsto'], curva_dia, row['tmo_previsto'],
                tmo_per_interval=tmo_per_interval
            )

            # Intervalos de confiança específicos por dia da semana
            dow_std = self._std_by_dow.get(dia_semana, forecast_std)
                
            resultados.append({
                "data": row['data'].isoformat(),
                "volume_total": row['volume_previsto'],
                "tmo_medio": row['tmo_previsto'],
                "volume_lower": max(0, int(row['volume_previsto'] - forecast_std)),
                "volume_upper": int(row['volume_previsto'] + forecast_std),
                "volume_lower_dow": max(0, int(row['volume_previsto'] - dow_std)),
                "volume_upper_dow": int(row['volume_previsto'] + dow_std),
                "intervalos": intervalos
            })
            
        # Calcular DMM (Dia de Maior Movimento) e HMM (Hora de Maior Movimento) projetados
        volume_projetado = df_pred['volume_previsto'].sum()
        
        import holidays
        br_holidays = holidays.Brazil()
        feriados = []
        dias_excluidos = []
        
        dmm_vol = 0
        dmm_data = ""
        hmm_vol = 0
        hmm_hora = ""
        hmm_data = ""
        
        for dia in resultados:
            dt = datetime.date.fromisoformat(dia['data'])
            is_holiday = dt in br_holidays
            is_weekend = dt.weekday() >= 5
            
            if is_holiday:
                feriados.append(dia['data'])
                dias_excluidos.append(dia['data'])
            elif is_weekend:
                dias_excluidos.append(dia['data'])
            
            # DMM não pode ser feriado nem final de semana
            if not is_holiday and not is_weekend:
                if dia['volume_total'] > dmm_vol:
                    dmm_vol = dia['volume_total']
                    dmm_data = dia['data']
                
            for interv in dia['intervalos']:
                if interv['volume'] > hmm_vol:
                    hmm_vol = interv['volume']
                    hmm_hora = interv['intervalo']
                    hmm_data = dia['data']
        # Calcular baseline historico para o dia da semana do DMM
        dmm_baseline_vol = 0
        if dmm_data:
            dt_dmm = datetime.date.fromisoformat(dmm_data)
            wd = dt_dmm.weekday()
            wd_str = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'][wd]
            baselines = self.history_stats.get('baseline_meses', [])
            if baselines:
                soma = sum(b.get(wd_str, 0) for b in baselines)
                dmm_baseline_vol = int(soma / len(baselines))
        # Obter comparações históricas adicionais (anos anteriores e últimos 3 meses)
        mensal_historico = self.history_stats.get('monthly_history', [])
        anos_anteriores = []
        ultimos_3_meses = []
        
        if mensal_historico:
            mes_alvo_str = f"-{month:02d}"
            # Meses iguais em anos anteriores
            anos_anteriores = [
                {"ano_mes": m['ano_mes'], "volume": m['volume']}
                for m in mensal_historico
                if m['ano_mes'].endswith(mes_alvo_str) and int(m['ano_mes'][:4]) < year
            ]
            # Últimos 3 meses do histórico
            ultimos_3_meses = [
                {"ano_mes": m['ano_mes'], "volume": m['volume']}
                for m in mensal_historico[-3:]
            ]
            
            # Inverter para mostrar do mais recente pro mais antigo
            anos_anteriores.reverse()
            ultimos_3_meses.reverse()

        # Confidence intervals summary
        avg_daily_forecast = volume_projetado / len(resultados) if resultados else 0
        confidence_intervals = {
            "std_dev": round(forecast_std, 2),
            "avg_daily_volume": round(avg_daily_forecast, 1),
            "avg_lower_1std": max(0, int(avg_daily_forecast - forecast_std)),
            "avg_upper_1std": int(avg_daily_forecast + forecast_std),
            "avg_lower_2std": max(0, int(avg_daily_forecast - 2 * forecast_std)),
            "avg_upper_2std": int(avg_daily_forecast + 2 * forecast_std),
        }

        # Aggregate abandon rate estimate for the month
        # Use average forecasted day parameters for a representative estimate
        avg_tmo_forecast = float(df_pred['tmo_previsto'].mean()) if len(df_pred) > 0 else 240
        avg_volume_forecast = avg_daily_forecast
        # Assume typical 30-min intervals, 08:00-20:00 = 24 intervals, 600s each
        interval_seconds = 600
        num_intervals = 24
        avg_interval_volume = avg_volume_forecast / num_intervals if num_intervals > 0 else 0
        traffic_erlangs = (avg_interval_volume / interval_seconds) * avg_tmo_forecast
        # Assume agents ≈ traffic * 1.3 (typical overstaffing for SLA)
        est_agents = max(1, int(np.ceil(traffic_erlangs * 1.3)))
        est_abandon_rate = self._estimate_abandon_rate(
            est_agents, traffic_erlangs, avg_tmo_forecast, avg_patience_time=60
        )
        
        return {
            "dias": resultados,
            "comparacoes": {
                "volume_projetado": int(volume_projetado),
                "dmm_vol": int(dmm_vol),
                "dmm_data": dmm_data,
                "dmm_baseline_vol": dmm_baseline_vol,
                "hmm_vol": int(hmm_vol),
                "hmm_hora": hmm_hora,
                "hmm_data": hmm_data,
                "anos_anteriores": anos_anteriores,
                "ultimos_3_meses": ultimos_3_meses,
                "feriados_mes": feriados,
                "dias_excluidos": dias_excluidos,
                "data_inicio": self.history_stats.get('data_inicio'),
                "data_fim": self.history_stats.get('data_fim'),
                "curvas_distribuicao": self.distribution_curve,
                "confidence_intervals": confidence_intervals,
                "estimated_abandon_rate": round(est_abandon_rate * 100, 2),
            }
        }

    # =========================================================================
    # NOVO: Previsão por intervalo com dimensionamento de agentes (Erlang)
    # =========================================================================
    def forecast_interval_level(self, year, month, celula="Todas"):
        """Gera previsão detalhada por intervalo com dimensionamento de agentes.

        Para cada dia do mês, prevê o volume diário, distribui nos intervalos,
        e calcula agentes necessários via Erlang básico para cada intervalo.

        Args:
            year: Ano da previsão.
            month: Mês da previsão (1-12).
            celula: Nome da célula (padrão "Todas").

        Returns:
            Dict com 'dias': lista de dias, cada um com 'data', 'intervalos' detalhados
            (volume, tmo, agents_needed, traffic_erlangs, occupancy_estimate).
        """
        if not self.is_trained:
            raise ValueError("Modelo não treinado. Envie histórico primeiro.")

        # Obter previsão mensal padrão
        forecast_data = self.forecast_month(year, month)
        dias = forecast_data['dias']

        # Modelo secundário de regressão para ajustar distribuição por características do dia
        # Treina regressão linear sobre padrões históricos de intervalo vs features do dia
        interval_adjuster = None
        if self._df_daily_train is not None and len(self._df_daily_train) > 30:
            try:
                interval_adjuster = self._train_interval_adjuster()
            except Exception:
                interval_adjuster = None

        resultados = []
        for dia_info in dias:
            dt = datetime.date.fromisoformat(dia_info['data'])
            dia_semana = dt.weekday()
            total_vol = dia_info['volume_total']
            tmo_medio = dia_info['tmo_medio']

            intervalos_base = dia_info['intervalos']

            # Se há modelo ajustador, ajustar a distribuição
            if interval_adjuster is not None:
                try:
                    df_day = pd.DataFrame({'data': [dt]})
                    day_features = self._extract_features(df_day)
                    X_day = day_features[self._feature_cols]
                    adjustment = interval_adjuster.predict(X_day)[0]
                    # Ajustamento suave: blend entre curva original e ajustada
                    blend_factor = 0.15  # 15% de peso para o ajuste
                    for iv in intervalos_base:
                        iv['volume'] = max(0, int(iv['volume'] * (1.0 - blend_factor + blend_factor * adjustment)))
                except Exception:
                    pass  # Fallback para curva original

            # Calcular métricas de dimensionamento por intervalo
            interval_seconds = 600  # 30 minutos = 600 segundos
            shrinkage = 0.75  # Taxa de aderência padrão (75%)

            enriched_intervals = []
            for iv in intervalos_base:
                vol = iv['volume']
                tmo = iv['tmo']

                # Tráfego em Erlangs
                if interval_seconds > 0 and tmo > 0:
                    traffic_erlangs = (vol / interval_seconds) * tmo
                else:
                    traffic_erlangs = 0.0

                # Agentes necessários (Erlang básico: tráfego + margem)
                # Regra simples: agents >= traffic_erlangs, arredondado para cima
                agents_raw = traffic_erlangs
                agents_after_shrinkage = max(1, int(np.ceil(agents_raw / shrinkage))) if agents_raw > 0 else 0

                # Estimativa de ocupação
                occupancy = min(1.0, traffic_erlangs / agents_after_shrinkage) if agents_after_shrinkage > 0 else 0.0

                enriched_intervals.append({
                    "intervalo": iv['intervalo'],
                    "volume": iv['volume'],
                    "tmo": iv['tmo'],
                    "agents_needed": agents_after_shrinkage,
                    "traffic_erlangs": round(traffic_erlangs, 2),
                    "occupancy_estimate": round(occupancy, 4)
                })

            resultados.append({
                "data": dia_info['data'],
                "volume_total": total_vol,
                "tmo_medio": tmo_medio,
                "intervalos": enriched_intervals
            })

        return {"dias": resultados}

    def _train_interval_adjuster(self):
        """Treina modelo secundário de regressão linear para ajustar distribuição por intervalo.

        Usa as features do dia para prever um fator de ajuste da curva intra-diária
        baseado em padrões históricos.

        Returns:
            Modelo LinearRegression treinado ou None se dados insuficientes.
        """
        if self._df_daily_train is None or len(self._df_daily_train) < 30:
            return None

        df = self._df_daily_train.copy()
        df['data'] = pd.to_datetime(df['data'], dayfirst=True)
        df_feat = self._extract_features(df, add_lags=True)

        # Feature adicional: razão entre volume do dia e a média do mesmo dia da semana
        dow_means = df.groupby('dia_semana')['volume'].transform('mean')
        df_feat['volume_ratio'] = df['volume'] / dow_means.replace(0, np.nan).fillna(1.0)

        X = df_feat[self._feature_cols + ['volume_ratio']]
        y = df_feat['volume_ratio']  # Prever o próprio ratio como ajuste

        model = Ridge(alpha=1.0)
        model.fit(X, y)
        return model

    # =========================================================================
    # NOVO: Detecção de Tendências
    # =========================================================================
    def detect_trends(self):
        """Analisa o histórico mensal para detectar tendências de volume.

        Returns:
            Dict com: direction, growth_rate, seasonal_pattern, recommendation.
            Retorna None se o modelo não estiver treinado ou dados insuficientes.
        """
        if not self.is_trained:
            return None

        monthly_history = self.history_stats.get('monthly_history', [])
        if not monthly_history or len(monthly_history) < 3:
            return {
                "direction": "indeterminado",
                "growth_rate": 0.0,
                "seasonal_pattern": {},
                "recommendation": "Dados históricos insuficientes para análise de tendência (mínimo 3 meses)."
            }

        # Extrair volumes mensais em ordem cronológica
        volumes = [m['volume'] for m in monthly_history]
        meses_labels = [m['ano_mes'] for m in monthly_history]

        # Calcular taxa de crescimento mês-a-mês (média dos últimos N meses)
        growth_rates = []
        for i in range(1, len(volumes)):
            if volumes[i - 1] > 0:
                rate = (volumes[i] - volumes[i - 1]) / volumes[i - 1]
                growth_rates.append(rate)

        if growth_rates:
            avg_growth = np.mean(growth_rates)
            # Usar os últimos 3 meses para tendência mais recente
            recent_growth = np.mean(growth_rates[-3:]) if len(growth_rates) >= 3 else avg_growth
        else:
            avg_growth = 0.0
            recent_growth = 0.0

        # Determinar direção
        if recent_growth > 0.03:
            direction = "crescente"
        elif recent_growth < -0.03:
            direction = "decrescente"
        else:
            direction = "estavel"

        # Identificar padrão sazonal (mês com maior/menor volume médio)
        monthly_avg = {}
        for m in monthly_history:
            mes_num = int(m['ano_mes'].split('-')[1])
            if mes_num not in monthly_avg:
                monthly_avg[mes_num] = []
            monthly_avg[mes_num].append(m['volume'])

        seasonal_pattern = {}
        meses_nomes = {
            1: 'Jan', 2: 'Fev', 3: 'Mar', 4: 'Abr', 5: 'Mai', 6: 'Jun',
            7: 'Jul', 8: 'Ago', 9: 'Set', 10: 'Out', 11: 'Nov', 12: 'Dez'
        }

        for mes_num in sorted(monthly_avg.keys()):
            avg_vol = np.mean(monthly_avg[mes_num])
            seasonal_pattern[meses_nomes.get(mes_num, str(mes_num))] = round(avg_vol, 1)

        # Identificar meses consistentemente altos e baixos
        if len(monthly_avg) >= 6:
            avg_geral = np.mean([np.mean(v) for v in monthly_avg.values()])
            meses_altos = []
            meses_baixos = []
            for mes_num, vols in monthly_avg.items():
                avg_m = np.mean(vols)
                if avg_m > avg_geral * 1.1:
                    meses_altos.append(meses_nomes.get(mes_num, str(mes_num)))
                elif avg_m < avg_geral * 0.9:
                    meses_baixos.append(meses_nomes.get(mes_num, str(mes_num)))
        else:
            meses_altos = []
            meses_baixos = []

        # Gerar recomendação
        if direction == "crescente":
            recommendation = (
                f"Tendência de CRESCIMENTO detectada (taxa recente: {recent_growth * 100:+.1f}% a.m.). "
                f"Considere planejar aumento gradativo de quadro. "
            )
            if meses_altos:
                recommendation += f"Meses historicamente acima da média: {', '.join(meses_altos)}. "
        elif direction == "decrescente":
            recommendation = (
                f"Tendência de QUEDA detectada (taxa recente: {recent_growth * 100:+.1f}% a.m.). "
                f"Avaliar possibilidade de otimização de escala. "
            )
            if meses_baixos:
                recommendation += f"Meses historicamente abaixo da média: {', '.join(meses_baixos)}. "
        else:
            recommendation = (
                f"Volume ESTÁVEL (variação recente: {recent_growth * 100:+.1f}% a.m.). "
                f"Manter o dimensionamento atual com ajustes sazonais. "
            )

        if meses_altos:
            recommendation += f"Periodos de pico sazonal: {', '.join(meses_altos)}."
        if meses_baixos:
            recommendation += f" Periodos de baixa sazonal: {', '.join(meses_baixos)}."

        return {
            "direction": direction,
            "growth_rate": round(recent_growth * 100, 2),
            "growth_rate_avg": round(avg_growth * 100, 2),
            "seasonal_pattern": seasonal_pattern,
            "meses_pico": meses_altos,
            "meses_baixa": meses_baixos,
            "recommendation": recommendation.strip(),
            "n_meses_analisados": len(monthly_history)
        }

    # =========================================================================
    # NOVO: Avaliação Rolling da Previsão
    # =========================================================================
    def rolling_forecast_eval(self, horizon_days=7):
        """Simula uma previsão rolling sobre os últimos dias do treino.

        Para cada dia no período de teste, treina com os dados anteriores e prevê esse dia.
        Calcula MAPE, MAE e viés (bias) para avaliar a qualidade real da previsão.

        Args:
            horizon_days: Número de dias finais do treino para usar como teste.

        Returns:
            Dict com mape, mae, bias, detalhes por dia e métricas agregadas.
        """
        if not self.is_trained or self._df_daily_train is None:
            return None

        df = self._df_daily_train.copy()
        df['data'] = pd.to_datetime(df['data'], dayfirst=True)
        df = df.sort_values('data').reset_index(drop=True)

        n_total = len(df)
        if n_total < horizon_days + 30:
            return {
                "status": "dados_insuficientes",
                "message": f"Necessário pelo menos {horizon_days + 30} dias de treino para avaliação rolling. Disponível: {n_total}.",
                "mape": None, "mae": None, "bias": None, "detalhes": []
            }

        # Dividir: treino = tudo exceto os últimos horizon_days
        df_test = df.iloc[-horizon_days:].copy()
        df_train_base = df.iloc[:-horizon_days].copy()

        detalhes = []
        erros_absolutos = []
        erros_pct = []
        diferencas = []  # predito - real (para calcular viés)

        for i in range(len(df_test)):
            dia_teste = df_test.iloc[i]
            data_teste = dia_teste['data']
            volume_real = dia_teste['volume']

            # Combinar treino base + dias de teste anteriores
            df_train_roll = pd.concat([df_train_base, df_test.iloc[:i]], ignore_index=True)

            if len(df_train_roll) < 15:
                continue

            try:
                # Extrair features e treinar modelo rápido (RandomForest com poucas árvores)
                df_train_features = self._extract_features(df_train_roll, add_lags=False)

                # Remover outliers simples
                X_train = df_train_features[self._feature_cols]
                y_train = df_train_features['volume'].values

                # Treinar modelo leve
                model = RandomForestRegressor(n_estimators=50, random_state=42, max_depth=6)
                model.fit(X_train, y_train)

                # Prever o dia de teste
                df_day = pd.DataFrame({'data': [data_teste]})
                df_day_feat = self._extract_features(df_day)
                X_day = df_day_feat[self._feature_cols]
                volume_pred = int(model.predict(X_day)[0])

                # Garantir não-negativo
                volume_pred = max(0, volume_pred)

                erro_abs = abs(volume_real - volume_pred)
                erro_pct = (erro_abs / volume_real * 100) if volume_real > 0 else 0.0
                diferenca = volume_pred - volume_real  # positivo = superestimou

                erros_absolutos.append(erro_abs)
                erros_pct.append(erro_pct)
                diferencas.append(diferenca)

                detalhes.append({
                    "data": data_teste.strftime('%Y-%m-%d'),
                    "volume_real": int(volume_real),
                    "volume_predito": volume_pred,
                    "erro_absoluto": erro_abs,
                    "erro_pct": round(erro_pct, 2),
                    "diferenca": int(diferenca)
                })

            except Exception:
                continue

        if not detalhes:
            return {
                "status": "falha",
                "message": "Não foi possível calcular a avaliação rolling.",
                "mape": None, "mae": None, "bias": None, "detalhes": []
            }

        mape = round(np.mean(erros_pct), 2)
        mae = round(np.mean(erros_absolutos), 2)
        bias = round(np.mean(diferencas), 2)  # Positivo = tendência a superestimar
        bias_pct = round((bias / np.mean([d['volume_real'] for d in detalhes])) * 100, 2) if detalhes else 0.0

        # Classificar qualidade
        if mape < 10:
            qualidade = "excelente"
        elif mape < 20:
            qualidade = "bom"
        elif mape < 30:
            qualidade = "aceitavel"
        else:
            qualidade = "precisa_melhorar"

        return {
            "status": "ok",
            "horizon_days": horizon_days,
            "dias_avaliados": len(detalhes),
            "mape": mape,
            "mae": mae,
            "rmse": round(np.sqrt(np.mean([e ** 2 for e in erros_absolutos])), 2),
            "bias": bias,
            "bias_pct": bias_pct,
            "qualidade": qualidade,
            "bias_interpretacao": (
                "superestima" if bias > 0 else ("subestima" if bias < 0 else "neutro")
            ),
            "detalhes": detalhes
        }


class CallCenterForecasterManager:
    def __init__(self):
        self.models = {}
        self.available_celulas = []
        self.is_trained = False

    def train(self, df_history, dias_semana=None, anos_selecionados=None):
        self.models = {}
        self.available_celulas = ["Todas"]

        global_forecaster = CallCenterForecaster()
        try:
            global_forecaster.train(df_history.copy(), dias_semana, anos_selecionados)
            self.models["Todas"] = global_forecaster
        except Exception as e:
            print(f"Erro ao treinar global: {e}")
            raise e

        if 'célula' in df_history.columns:
            celulas = df_history['célula'].dropna().unique()
            for celula in celulas:
                celula_str = str(celula).strip()
                if not celula_str:
                    continue
                df_celula = df_history[df_history['célula'] == celula].copy()
                if len(df_celula) < 10:
                    continue
                
                celula_forecaster = CallCenterForecaster()
                try:
                    celula_forecaster.train(df_celula, dias_semana, anos_selecionados)
                    self.models[celula_str] = celula_forecaster
                    self.available_celulas.append(celula_str)
                except Exception as e:
                    print(f"Erro ao treinar célula {celula_str}: {e}")

        self.is_trained = True

    def get_model(self, celula="Todas"):
        if celula not in self.models:
            return self.models.get("Todas")
        return self.models[celula]

    def forecast(self, days_ahead=30, celula="Todas"):
        model = self.get_model(celula)
        if model:
            return model.forecast(days_ahead)
        raise ValueError("Modelo não treinado.")

    def forecast_month(self, year, month, celula="Todas"):
        model = self.get_model(celula)
        if model:
            return model.forecast_month(year, month)
        raise ValueError("Modelo não treinado.")

    def get_stats(self, celula="Todas"):
        model = self.get_model(celula)
        if model:
            return model.get_stats()
        return {}

# Instância global (singleton)
forecaster = CallCenterForecasterManager()
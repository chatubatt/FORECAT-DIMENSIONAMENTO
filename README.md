# FORECAST E DIMENSIONAMENTO

Plataforma de **Workforce Management (WFM)** para call centers. Previsão de volume de chamadas, dimensionamento de agentes via Erlang C, alocação de turnos e análise de cenários.

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Frontend | React 19 + TypeScript 6 + Vite 8 + TailwindCSS 4 + Recharts |
| Backend | Python 3.13 + FastAPI + scikit-learn + XGBoost |
| Deploy | Frontend: Netlify / Backend: Render |

## Funcionalidades

- **Forecast ML** — Previsão de volume e TMO usando ensemble de modelos (RandomForest, XGBoost, GradientBoosting, etc.) com validação TimeSeriesSplit
- **Erlang C / Erlang A** — Dimensionamento de agentes com SLA, ocupação, ASA e abandono
- **Distribuição de Escalas** — Algoritmo guloso com turnos 06:20 (6x1), 08:12 (5x2) e 05:15 (4x3)
- **Shrinkage Detalhado** — Férias, licença, treinamento, pausas, reuniões, absenteísmo
- **Cenários What-If** — Simule variações de volume/TMO e veja impacto em HC e custo
- **Análise de Ocupação** — Detecta burnout, subutilização e gera recomendações
- **Calendário de Rotação** — Escala mensal round-robin com folgas rotativas
- **Acurácia do Forecast** — MAPE, MAE, RMSE e viés comparando previsto vs real

## Como Rodar

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Endpoints da API

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/` | Status |
| POST | `/parse-years` | Extrair anos de um CSV/Excel |
| POST | `/upload-history` | Upload de histórico e treino do modelo |
| GET | `/forecast` | Forecast para N dias |
| GET | `/forecast-month` | Forecast para um mês específico |
| GET | `/stats` | Estatísticas históricas |
| POST | `/wfm-cost` | Cálculo de custo operacional |
| GET | `/sla-sensitivity` | Sensibilidade do SLA a variações de volume |
| POST | `/abandon-rate` | Taxa de abandono estimada |
| POST | `/shrinkage-calculator` | Detalhamento de shrinkage |
| POST | `/scenario-whatif` | Análise de cenários what-if |
| GET | `/schedule-rotation` | Calendário de rotação mensal |
| POST | `/forecast-accuracy` | Métricas de acurácia do forecast |
| GET | `/occupancy-analysis` | Análise de ocupação por intervalo |

## Licença

MIT

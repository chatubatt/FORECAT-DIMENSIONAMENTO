---
name: "Memória do Projeto Zeta"
description: "Sempre que estiver trabalhando no Projeto Zeta, consulte esta memória para entender o histórico de decisões, regras de negócio e funcionalidades já implementadas (Forecast e Dimensionamento)."
---

# Memória do Projeto Zeta (Call Center Forecaster)

## 1. Arquitetura e Hospedagem (Cloud)
- **Frontend**: React/Vite com TypeScript e Recharts, hospedado no **Netlify**. Usa `netlify.toml` para regras de roteamento (evitar 404 no React Router). As chamadas de API usam `import.meta.env.VITE_API_URL` definido no arquivo `.env.production`.
- **Backend**: FastAPI (Python), hospedado no **Render**. O CORS no backend (`main.py`) está configurado como `allow_origins=["*"]` para aceitar requisições do Netlify. As dependências do servidor (incluindo `scikit-learn`, `xgboost`, `pandas`) são controladas pelo arquivo `requirements.txt` na raiz da pasta `backend`.

## 2. Regras de Negócio e Aprendizados do Usuário
- **DMM (Dia de Maior Movimento)**: Ocorre consistentemente no **5º Dia Útil** (dia de pagamento) e no **Dia 20** (vencimento de faturas). 
- **Finais de Semana**: Não devem ser considerados para o cálculo do DMM (DMM é sempre um dia útil e não feriado).
- **Problema de Features de Lag**: Não utilizar `volume_lag_X` para treinar os modelos. Durante o treinamento o valor é real, mas na projeção para o futuro o valor é zero, causando uma distorção grave nas previsões.

## 3. Histórico de Modificações no Backend (`forecaster.py`)
- O modelo evoluiu de regressões lineares simples para um ecossistema com **TimeSeriesSplit** e algoritmos avançados (XGBoost, RandomForest, GradientBoosting, Huber, ElasticNet, Poisson).
- As *features* utilizadas para treinamento foram cirurgicamente reduzidas:
  - `dia_semana`, `dia_mes`, `mes`, `dia_util_mes`
  - `is_feriado`, `is_vespera_feriado`
  - `is_5o_dia_util`, `is_dia_20` (features binárias inseridas para capturar as regras de negócio explicitamente)
- O algoritmo treina 6 modelos e escolhe automaticamente o de menor erro (MAE).
- Leitura de Excel suporta `.xlsx` e `.xls` usando `openpyxl` e `xlrd`.

## 4. Histórico de Modificações no Frontend (`Dashboard.tsx` e Módulos WFM)
- **Engine WFM Completa**: O sistema suporta Erlang C, Erlang A (com abandono), Análise de Ocupação, Shrinkage dinâmico, Cenários What-If, Rotações de Turno, Smooth Forecasting e Previsão de Precisão.
- **Shrinkage Detalhado e NR17**: O Fator de Perda foi dividido em componentes (ABS, NR17, Treinamento, Turnover, Outros). A porcentagem de NR17 é dinâmica e baseada nas escalas (ex: Turnos de 06:20 exigem 10.5%; 07:12 exigem 18.5%).
- **Estratégias de SLA (Otimização Mensal)**: 
  - *Média Ponderada*: Sacrifica intencionalmente o HC no DMM para reduzir custo mensal. Nunca sobrepõe headcount em sábados e domingos para gerar SLA artificial.
  - A métrica "DIM B" (Dimensionadas Base) lê sempre o `shiftRes.coverage` (escala distribuída), e não a necessidade pura do Erlang.
- **Ocupação Máxima vs SLA**: A Ocupação Máxima age como trava dura no Erlang C, impedindo a queda de HC se o teto configurado for atingido (mesmo com SLA baixo).

## 5. Algoritmo de Distribuição de Escalas (`shifts.ts`)
- **Resolução de 10 minutos**: A interface e o motor do algoritmo trabalham em intervalos exatos de 10 em 10 minutos. Gráficos podem ser agrupados em 30 min por estética, mas as tabelas mantêm granularidade de 10 min.
- **Cálculo de Escala Guloso (Staggering)**: Os algoritmos `calculateShifts` e `allocateShifts612_812` usam uma lógica baseada no cálculo de *Useful Coverage* (cobertura útil). O algoritmo não empilha todos os turnos no mesmo horário, mas escalona os turnos pontuando onde os intervalos exigem mais agentes (sem sobreposição inútil).
- **Vazamento de Turnos**: Turnos alocados jamais podem estourar o horário final de fechamento da operação (`opEndIdx`).

## Instruções para o Agente
1. Ao sugerir novos recursos preditivos, nunca reintroduza dependência de `lag` (atraso de dias) para o futuro.
2. Não altere o motor de Erlang C sem testes cuidadosos; ele já considera a probabilidade de fila corretamente.
3. Para compilação na nuvem (Netlify), preste rigorosa atenção às tipagens do TypeScript. Não deixe variáveis ou imports ociosos se os arquivos de configuração (ex: `tsconfig`) estiverem restritivos.
4. Se o usuário questionar a alocação de horários ("todo mundo entrando de manhã"), verifique as penalidades de desperdício (`wasted * penalty`) no score da distribuição em `shifts.ts`.
5. Evite criar dependências que forcem configuração manual no Netlify ou Render; automatize com scripts ou variáveis como `.env.production`.

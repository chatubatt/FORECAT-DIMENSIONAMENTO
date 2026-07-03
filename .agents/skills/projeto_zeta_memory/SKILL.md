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
- **Shrinkage Detalhado e NR17**: O Fator de Perda foi dividido em componentes (ABS, NR17, Treinamento, Turnover, Outros). A porcentagem de NR17 é dinâmica e baseada nas escalas (ex: Turnos de 06:20 exigem 10.5%; 08:12 exigem 16.3%).
- **Pausas NR17 por Intervalo (Jun/2026)**: O desconto de NR17 deixou de ser um percentual flat `scheduled * (1 - total%)`. Agora as pausas são modeladas por intervalo via `breakCountsPerInterval[]`:
  - 6x1 (6h20): Descanso 1 (10min) + Lanche (20min) + Descanso 2 (10min) = 40min
  - 5x2 (8h12): Descanso 1 (10min) + Almoço (60min) + Descanso 2 (10min) = 80min  
  - JA (5h15): Pausa única de 30min
  - NR17: Sem pausas na 1ª hora após login e na 1ª hora antes do fim da jornada
  - `nonNR17ShrinkageAvg` calcula média apenas de ABS+Treinamento+Turnover+Outros (exclui NR17)
  - Fórmula nos 3 pontos de SLA: `netAgents = (scheduled - breakCounts[intervalo]) × (1 - nonNR17/100)`
- **Estratégias de SLA (Otimização Mensal)**: 
  - *Média Ponderada*: Sacrifica intencionalmente o HC no DMM para reduzir custo mensal. Nunca sobrepõe headcount em sábados e domingos para gerar SLA artificial.
  - A métrica "DIM B" (Dimensionadas Base) lê sempre o `shiftRes.coverage` (escala distribuída), e não a necessidade pura do Erlang.
- **Ocupação Máxima vs SLA**: A Ocupação Máxima age como trava dura no Erlang C, impedindo a queda de HC se o teto configurado for atingido (mesmo com SLA baixo).

## 5. Algoritmo de Distribuição de Escalas (`shifts.ts`)
- **Resolução de 10 minutos**: A interface e o motor do algoritmo trabalham em intervalos exatos de 10 em 10 minutos. Gráficos podem ser agrupados em 30 min por estética, mas as tabelas mantêm granularidade de 10 min.
- **Cálculo de Escala Guloso (Staggering)**: Os algoritmos `calculateShifts` e `allocateShifts612_812` usam uma lógica baseada no cálculo de *Useful Coverage* (cobertura útil). O algoritmo não empilha todos os turnos no mesmo horário, mas escalona os turnos pontuando onde os intervalos exigem mais agentes (sem sobreposição inútil).
  - **Atenção (Torres Artificiais):** O algoritmo guloso nunca deve dar bônus excessivos para reutilizar horários de entrada, senão ele empilha dezenas de PAs no mesmo horário, gerando enormes desperdícios só para reduzir a quantidade de turnos. A podagem final (trim) nunca deve permitir criar déficits, senão a cobertura cai, o SLA despenca e o "binary search" do DMM infla a escala absurdamente para compensar.
- **Scoring do Algoritmo (Jun/2026)**:
  - `useful` conta apenas intervalos com déficit REAL (`coverage[j] < required[j]`), não `required[j] > 0`
  - `reduction` soma o déficit real `required[j] - coverage[j]`, não o `required[j]` bruto
  - Penalidade de desperdício: `wasted * 3` (antes `* 0.5`). Turno precisa de `useful > 1.5 × wasted` para score positivo
  - Bônus de consolidação: `+5` para entrada existente, `-1` para nova (moderado, não extremo como +50/-8)
  - `ShiftScheduleResult.breakCountsPerInterval[]`: agentes em pausa NR17 por intervalo
- **Distribuição 6x1 no FDS (Jun/2026)**:
  - Saturday e Sunday usam schedule COMBINADO (max element-wise dos required agents)
  - calculateShifts roda uma única vez para o perfil de FDS combinado
  - 6x1 rateado proporcional ao volume de tráfego: `sat6x1 = total6x1 × (satVol / weekendVol)`
  - `weekendMinDailyHC6x1` usa média ponderada em vez de `Math.max`
- **ForcedEntries reduzidas (Jun/2026)**: `{00:00, count: 2}` e `{17:40, count: 2}` (eram 4 cada)
- **Simulação de SLA vs Qtd. Telas:** Ao calcular o Erlang (NEC Pico), o volume deve ser dividido por `numTelas` se maior que 1. **MUITO IMPORTANTE:** Ao rodar a simulação reversa (pegar a escala e ver qual SLA ela entrega), o tráfego também DEVE ser recalculado com o volume dividido por `numTelas`. Se a simulação tentar passar o volume total (multiplicado) pelas PAs reduzidas, o SLA vai para 0% e o algoritmo de escala (Busca Binária) explodirá a quantidade de pessoas para compensar um tráfego 3x maior.
- **Trava Absoluta de Entradas**: A visualização de intervalos (ex: gráficos operando 24h a partir das 00:00) foi totalmente desacoplada da regra de entrada de agentes. Para o algoritmo guloso, existe uma **trava inegociável de 06:00 (360 minutos)** como horário mínimo para início de qualquer turno, independentemente de haver demanda ou configuração visual de 24h para exibição.
- **Vazamento de Turnos**: Turnos alocados jamais podem estourar o horário final de fechamento da operação (`opEndIdx`).

## 6. Bugs Críticos Corrigidos (Jun/2026)
- **findMinAgents SLA comparison** (`erlang.ts`): `serviceLevel (0-100)` comparado com `targetSlaPercent (0-1)` — parava em ~1% SLA. Corrigido: `* 100`.
- **Binary search no Dashboard.tsx**: mesma escala mismatch — SLA real (0-100) vs target/100 (0.7). SLA mínimo era 0.72% em vez de 72%.
- **Dupla inflação de shrinkage**: `inflateReq` removido pois `requiredAgents` do `findMinAgents` já inclui shrinkage.
- **Fallback loop allocateShifts612_812**: `reduction` nunca era computado (variável não atualizada).
- **CORS**: adicionado `https://dimensionamentott.netlify.app` às origens permitidas.

## 7. Design System (Jun/2026)
- Tema escuro refinado: fundo `#05070e`, `.glass` com gradiente, `.kpi-card` com label/value/sub
- Classes: `.section-header` (barra gradiente), `.mgt-table`, `.metric-badge` (+/-/warning), `.gantt-chart` (timeline animada)
- Gráficos Recharts com gradientes SVG, `animationDuration` escalonado, botão replay, tooltip customizado
- Gantt timeline horizontal para alocação de turnos

## Instruções para o Agente
1. Ao sugerir novos recursos preditivos, nunca reintroduza dependência de `lag` (atraso de dias) para o futuro.
2. Não altere o motor de Erlang C sem testes cuidadosos; ele já considera a probabilidade de fila corretamente.
3. Para compilação na nuvem (Netlify), preste rigorosa atenção às tipagens do TypeScript. Não deixe variáveis ou imports ociosos se os arquivos de configuração (ex: `tsconfig`) estiverem restritivos.
4. Se o usuário questionar a alocação de horários ("todo mundo entrando de manhã"), verifique as penalidades de desperdício (`wasted * penalty`) no score da distribuição em `shifts.ts`.
5. Evite criar dependências que forcem configuração manual no Netlify ou Render; automatize com scripts ou variáveis como `.env.production`.
6. Pausas NR17 são modeladas por intervalo (`breakCountsPerInterval[]`), não como shrinkage flat. NR17 passou a ser 0. O Shrinkage não-NR17 (ABS, Treinamento, TO, Outros) continua flat. Fórmula: `netAgents = (scheduled - breakCounts[idx]) * (1 - nonNR17/100)`.
7. O algoritmo de shifts agora só conta como "útil" intervalos com déficit real (`coverage[j] < required[j]`). Penalidade de desperdício é `wasted * 3` (não `* 0.5`). Se o excesso de PA no pico persistir, aumente esta penalidade.
8. FDS: schedule combinado (max element-wise entre Sáb e Dom), 6x1 rateado por proporção de tráfego.

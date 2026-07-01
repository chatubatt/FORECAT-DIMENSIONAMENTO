---
name: "Memória do Projeto Zeta"
description: "Sempre que estiver trabalhando no Projeto Zeta, consulte esta memória para entender o histórico de decisões, regras de negócio e funcionalidades já implementadas (Forecast e Dimensionamento)."
---

# Memória do Projeto Zeta (Call Center Forecaster)

## 1. Regras de Negócio e Aprendizados do Usuário
- **DMM (Dia de Maior Movimento)**: Ocorre consistentemente no **5º Dia Útil** (dia de pagamento) e no **Dia 20** (vencimento de faturas). 
- **Finais de Semana**: Não devem ser considerados para o cálculo do DMM (DMM é sempre um dia útil e não feriado).
- **Problema de Features de Lag**: Não utilizar `volume_lag_X` para treinar os modelos. Durante o treinamento o valor é real, mas na projeção para o futuro o valor é zero, causando uma distorção grave nas previsões.

## 2. Histórico de Modificações no Backend (`forecaster.py`)
- O modelo evoluiu de regressões lineares simples para um ecossistema com **TimeSeriesSplit** (validação honesta de séries temporais) e algoritmos avançados (XGBoost, RandomForest, GradientBoosting, Huber, ElasticNet, Poisson).
- As *features* utilizadas para treinamento foram cirurgicamente reduzidas para não gerar ruído com poucos dados:
  - `dia_semana`, `dia_mes`, `mes`, `dia_util_mes`
  - `is_feriado`, `is_vespera_feriado`
  - `is_5o_dia_util`, `is_dia_20` (features binárias inseridas para capturar as regras de negócio explicitamente)
- O algoritmo treina 6 modelos e escolhe automaticamente o de menor erro (MAE).

## 3. Histórico de Modificações no Frontend (`Dashboard.tsx` e `erlang.ts`)
- O Frontend é construído em React/Vite com TypeScript e Recharts.
- Adicionada aba **Dimensionamento (Erlang C)** que roda cálculos complexos 100% no cliente sem depender do servidor, garantindo interatividade instantânea.
- O usuário possui sliders/inputs para testar cenários estressantes:
  - Nível de Serviço Alvo (%) e Tempo Alvo SLA.
  - Shrinkage (Fator de Perda - ex: pausas, faltas).
  - Ocupação Máxima e "Forçar Máx PAs" (travar vagas para ver queda no SLA).
- O texto explicativo do DMM na interface reflete de forma explícita que a Inteligência Artificial reconheceu os gatilhos do 5º Dia Útil e Dia 20 ensinados pelo usuário.

- **Otimização Mensal (Média do Mês e DMM)**: 
  - Ao rodar a busca binária para bater o SLA do mês (`evaluateMonthSla`), nunca sobrepor a escala (headcount) de dias úteis sobre sábados e domingos. O baixo volume do fim de semana com excesso de pessoas geraria um SLA irreal de 100%, distorcendo a média geral e prejudicando os resultados dos dias úteis.
  - A métrica "DIM B" (Dimensionadas Base / `avgPAs`) exibida na tabela consolidada (UI e exportação) precisa sempre ler o dado de `shiftRes.coverage` (que é a escala já distribuída e otimizada), e **não** o dado cru do Erlang (`requiredAgents`). Do contrário, o usuário altera as premissas, mas a tabela parece travada e não reflete as quedas de Headcount.
- **Shrinkage Detalhado e NR17**: O Fator de Perda foi dividido em componentes (ABS, NR17, Treinamento, Turnover, Outros). A porcentagem de NR17 é dinâmica e calculada por média ponderada com base nas escalas ativas escolhidas: Turnos de 06:20 exigem 00:40 de pausas (10.5%); turnos de 07:12 exigem 01:20 (18.5%).

## 4. Aprendizados Recentes de Dimensionamento e Erlang
- **Vazamento de Turnos (Algoritmo Guloso)**: Os algoritmos geradores de escala (`calculateShifts` e `allocateShifts612_812`) foram corrigidos para **nunca extrapolar o horário de fechamento** da operação. Eles agora puxam a entrada do operador para trás ou filtram candidatos que terminam após `opEndIdx`.
- **Ocupação Máxima vs SLA**: A Ocupação Máxima (Max Occupancy) é uma trava dura no Erlang C. Reduzir a meta de SLA só reduzirá o Headcount se a ocupação resultante não ultrapassar o teto configurado. Se o usuário questionar por que o HC não caiu, verifique se a *Ocupação Máx* está travando a redução.
- **Estratégias de SLA**: A estratégia *Média Ponderada do Mês (Trade-off DMM)* existe para sacrificar intencionalmente o DMM e economizar HC. Se o cliente exigir que o DMM cumpra rigorosamente a meta estipulada no painel, ele deve ser instruído a usar a estratégia *Meta Diária Fixa (Flat SLA)*.
- **Leitura de Excel**: O Backend agora suporta nativamente `.xlsx` e `.xls` usando `openpyxl` e `xlrd` (`pd.read_excel`), dispensando conversões manuais para `.csv`.

## Instruções para o Agente
1. Ao sugerir novos recursos preditivos, nunca reintroduza dependência de `lag` (atraso de dias) caso seja impossível prever isso no mês seguinte.
2. Não altere o motor de Erlang C sem realizar testes cuidadosos; ele já considera a probabilidade de fila corretamente baseada na fórmula padrão de Erlang C.
3. Se o usuário relatar que a precisão (assertividade) piorou, prefira simplificar e podar as *features* em vez de adicionar mais complexidade.
4. Caso precise modificar a exibição de resultados do dimensionamento, atente-se sempre à diferença entre *Necessidade Pura* (saída direta da fórmula de Erlang, fixa para o volume) e *Escala Efetiva Dimensionada* (após distribuição nos turnos e eventual busca binária, variável conforme otimização de custo/SLA).
5. Se o algoritmo de distribuição de turnos (escala) precisar ser reescrito, garanta sempre que os turnos nunca terminem após o fechamento da operação (`opEndIdx`).

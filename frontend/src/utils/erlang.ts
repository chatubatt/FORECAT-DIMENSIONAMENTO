export interface ErlangResult {
  agents: number; // Base agents
  requiredAgents: number; // Agents with shrinkage
  traffic: number; // Erlangs
  serviceLevel: number; // %
  occupancy: number; // %
  probabilityOfWait: number; // %
  asa: number; // Average Speed of Answer in seconds
  erlangB: number;           // Blocking probability
  abandonRate: number;       // Estimated abandon rate %
  avgWaitTime: number;       // Average wait time for those who wait
  costPerInterval: number;   // Estimated cost for this interval
}

export interface ErlangInputs {
  volume: number; // Calls in interval
  tmo: number; // Average Handling Time (seconds)
  intervalSeconds: number; // Usually 1800 for 30 minutes
  targetSlaPercent: number; // e.g., 0.8 for 80%
  targetSlaTime: number; // e.g., 20 seconds
  shrinkage: number; // e.g., 0.3 for 30%
  maxOccupancy?: number; // e.g., 0.85 for 85%
  fixedAgents?: number; // Set if user limits PAs
  fixedTma?: number; // User-provided override for TMA
  costPerAgentMonth?: number; // For costPerInterval calculation (default 5000)
  numTelas?: number; // Quantidade de telas (para divisão no cabeçalho, não na projeção por intervalo)
}

/**
 * Calculates Erlang B Probability (Blocking Probability)
 * P(blocked) = (A^N / N!) / sum(A^k / k! for k=0..N)
 * Used for systems where blocked calls are lost (no queue)
 */
export function calcErlangB(agents: number, traffic: number): number {
  if (agents <= 0) return 1.0;
  if (traffic <= 0) return 0.0;

  let invB = 1.0;
  for (let i = 1; i <= agents; i++) {
    invB = 1.0 + invB * (i / traffic);
  }
  return 1.0 / invB;
}

/**
 * Estimates call abandon rate using Erlang C and patience time distribution.
 * Uses the assumption of exponential patience time (M/M/N + M queue).
 *
 * P(abandon) = P(wait) * (traffic / (traffic + (agents - traffic) * (tmo / patienceTime)))
 */
export function estimateAbandonRate(
  agents: number,
  traffic: number,
  tmo: number,
  patienceTime: number = 60, // Average patience time in seconds (default 60s)
  _shrinkage?: number
): {
  abandonRate: number;
  probWait: number;
  avgWaitTime: number;
  avgAbandonTime: number;
} {
  if (agents <= traffic || traffic <= 0) {
    return { abandonRate: agents <= traffic && traffic > 0 ? 95 : 0, probWait: agents <= traffic && traffic > 0 ? 100 : 0, avgWaitTime: 999, avgAbandonTime: patienceTime };
  }

  const probWait = calcErlangC(agents, traffic);
  const waitTime = (probWait * tmo) / (agents - traffic);

  // Patience factor: theta = 1/patienceTime, mu = 1/tmo
  const theta = 1 / patienceTime;
  const mu = 1 / tmo;

  // P(abandon) = P(wait) * (theta / (theta + mu * (agents - traffic)))
  const denom = theta + mu * (agents - traffic);
  const abandonRate = probWait * (denom > 0 ? theta / denom : 1);

  // Average time in queue for those who wait
  const avgWaitTime = waitTime;

  // Average time before abandoning (for those who abandon)
  const avgAbandonTime = Math.min(patienceTime, waitTime);

  return {
    abandonRate: Math.max(0, Math.min(100, abandonRate * 100)),
    probWait: probWait * 100,
    avgWaitTime,
    avgAbandonTime
  };
}

export interface CostEstimate {
  costPerAgentMonth: number;
  costPerAgentHour: number;
  totalMonthlyCost: number;
  costPerCall: number;
  costPerErlang: number;
  productivity: number; // calls per agent per hour
}

/**
 * Calculates operational cost estimates for staffing
 */
export function calculateCostEstimate(
  totalMonthlyHC: number,
  monthlyVolume: number,
  avgTmo: number,
  costPerAgentMonth: number = 5000,
  overheadPercent: number = 30,
  workingHoursPerMonth: number = 160
): CostEstimate {
  const totalCost = totalMonthlyHC * costPerAgentMonth * (1 + overheadPercent / 100);
  const costPerAgentHour = (costPerAgentMonth * (1 + overheadPercent / 100)) / workingHoursPerMonth;
  const costPerCall = monthlyVolume > 0 ? totalCost / monthlyVolume : 0;

  // Productivity: how many calls an agent handles per hour
  // Each call takes avgTmo seconds, so calls per hour = 3600 / avgTmo
  const callsPerAgentPerHour = avgTmo > 0 ? 3600 / avgTmo : 0;

  return {
    costPerAgentMonth: Math.round(costPerAgentMonth * (1 + overheadPercent / 100)),
    costPerAgentHour: Math.round(costPerAgentHour * 100) / 100,
    totalMonthlyCost: Math.round(totalCost),
    costPerCall: Math.round(costPerCall * 100) / 100,
    costPerErlang: 0, // Placeholder
    productivity: Math.round(callsPerAgentPerHour * 10) / 10
  };
}

/**
 * Calculates Erlang C Probability of Waiting
 */
export function calcErlangC(agents: number, traffic: number): number {
  if (agents <= traffic) return 1.0;
  
  let invB = 1.0;
  for (let i = 1; i <= agents; i++) {
    invB = 1.0 + invB * (i / traffic);
  }
  
  const erlangB = 1.0 / invB;
  const erlangC = erlangB / (1.0 - (traffic / agents) * (1.0 - erlangB));
  return erlangC;
}

/**
 * Calculates all metrics for a given number of agents
 */
export function evaluateErlangConfig(
  agents: number,
  traffic: number,
  tmo: number,
  targetSlaTime: number,
  shrinkage: number,
  patienceTime: number = 60
): ErlangResult {
  const probWait = calcErlangC(agents, traffic);
  const erlangB = calcErlangB(agents, traffic);
  
  let serviceLevel = 0;
  let asa = 0;
  let occupancy = 0;
  let avgWaitTime = 0;
  let abandonRate = 0;

  if (agents > traffic) {
    serviceLevel = 1.0 - probWait * Math.exp(-(agents - traffic) * (targetSlaTime / tmo));
    asa = (probWait * tmo) / (agents - traffic);
    occupancy = traffic / agents;
    avgWaitTime = asa;
    const abandon = estimateAbandonRate(agents, traffic, tmo, patienceTime, shrinkage);
    abandonRate = abandon.abandonRate;
    avgWaitTime = abandon.avgWaitTime;
  } else {
    // Overloaded system
    serviceLevel = 0;
    asa = 9999; // Arbitrary high number for overloaded
    occupancy = 1.0;
    avgWaitTime = 999;
    abandonRate = traffic > 0 ? 95 : 0;
  }

  // Cap service level at 1.0 (100%) and 0.0
  serviceLevel = Math.max(0, Math.min(1, serviceLevel));
  
  const requiredAgents = Math.ceil(agents / (1 - shrinkage));

  return {
    agents,
    requiredAgents,
    traffic,
    serviceLevel: serviceLevel * 100, // as percentage
    occupancy: occupancy * 100, // as percentage
    probabilityOfWait: probWait * 100, // as percentage
    asa,
    erlangB: Math.round(erlangB * 10000) / 10000,
    abandonRate: Math.round(abandonRate * 10) / 10,
    avgWaitTime: Math.round(avgWaitTime * 10) / 10,
    costPerInterval: 0
  };
}

export function findMinAgents(inputs: ErlangInputs): ErlangResult {
  const tmo = inputs.fixedTma || inputs.tmo;
  const traffic = (inputs.volume / inputs.intervalSeconds) * tmo;
  let agents = Math.floor(traffic) + 1; // start with minimum possible agents to handle traffic

  if (inputs.fixedAgents) {
    // If the user forced a maximum number of PAs
    // Calculate the base agents before shrinkage
    const baseFixedAgents = Math.floor(inputs.fixedAgents * (1 - inputs.shrinkage));
    const result = evaluateErlangConfig(Math.max(1, baseFixedAgents), traffic, tmo, inputs.targetSlaTime, inputs.shrinkage);
    result.costPerInterval = computeCostPerInterval(result.requiredAgents, inputs);
    return result;
  }

  // Iterate to find agents meeting SLA
  let currentResult = evaluateErlangConfig(agents, traffic, tmo, inputs.targetSlaTime, inputs.shrinkage);
  
  // First satisfy SLA
  while (currentResult.serviceLevel < inputs.targetSlaPercent * 100 && agents < traffic * 3) {
    agents++;
    currentResult = evaluateErlangConfig(agents, traffic, tmo, inputs.targetSlaTime, inputs.shrinkage);
  }
  
  // Then satisfy max occupancy if specified
  if (inputs.maxOccupancy !== undefined) {
    while (currentResult.occupancy > inputs.maxOccupancy * 100 && agents < traffic * 3) {
      agents++;
      currentResult = evaluateErlangConfig(agents, traffic, tmo, inputs.targetSlaTime, inputs.shrinkage);
    }
  }

  // Compute cost per interval
  currentResult.costPerInterval = computeCostPerInterval(currentResult.requiredAgents, inputs);

  return currentResult;
}

/**
 * Computes the estimated cost for a single interval based on required agents.
 */
function computeCostPerInterval(requiredAgents: number, inputs: ErlangInputs): number {
  const costPerAgentMonth = inputs.costPerAgentMonth || 5000;
  const workingHoursPerMonth = 160;
  const costPerAgentSecond = (costPerAgentMonth / workingHoursPerMonth) / 3600;
  return Math.round(requiredAgents * costPerAgentSecond * inputs.intervalSeconds * 100) / 100;
}

export type SlaStrategy = 'strict_daily' | 'monthly_avg' | 'weekly_avg' | 'rule_80_20';

export interface OperatingHoursConfig {
  weekdays: { start: string; end: string; closed: boolean };
  saturdays: { start: string; end: string; closed: boolean };
  sundays: { start: string; end: string; closed: boolean };
}

export interface DayForecast {
  data: string;
  volume_total: number;
  tmo_medio: number;
  intervalos: Array<{ intervalo: string; volume: number; tmo?: number }>;
}

function parseIntervalToMinutes(interval: string): number {
  const [h, m] = interval.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return -1;
  return h * 60 + m;
}

/**
 * Verifica se um horário de intervalo está dentro da janela operacional válida.
 * A janela é controlada pelo dimOpHours do usuário (config), não hardcoded.
 * Esta função é usada apenas como fallback quando não há config disponível.
 * Janela padrão flexível: 00:00 a 23:59 (permite que o config defina os limites reais).
 */
export function isValidOperatingInterval(interval: string): boolean {
  const mins = parseIntervalToMinutes(interval);
  if (mins < 0) return false;
  // Janela totalmente flexível: qualquer horário válido do dia
   // O controle fino do que é operacional é feito pelo config dimOpHours no calculateStaffingStrategy
  return mins >= 0 && mins <= 1439; // 00:00 a 23:59
}

export function isWithinOperatingHours(dateStr: string, interval: string, config: OperatingHoursConfig): boolean {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  
  let hours;
  if (day === 0) hours = config.sundays;
  else if (day === 6) hours = config.saturdays;
  else hours = config.weekdays;
  
  if (hours.closed) return false;
  
  const intMins = parseIntervalToMinutes(interval);
  const startMins = parseIntervalToMinutes(hours.start);
  const endMins = parseIntervalToMinutes(hours.end);
  
  // Suportar janela que atravessa meia-noite (ex: 06:00-00:00)
  if (endMins <= startMins) {
    // Cruza meia-noite: operacional se >= start OU < end
    return intMins >= startMins || intMins < endMins;
  }
  
  return intMins >= startMins && intMins < endMins;
}

export interface OptimizedInterval extends ErlangResult {
  data: string;
  intervalo: string;
  volume: number;
  tmo: number;
  isClosed: boolean;
}

export function calculateStaffingStrategy(
  monthData: DayForecast[],
  inputs: ErlangInputs,
  strategy: SlaStrategy,
  opHours: OperatingHoursConfig
): OptimizedInterval[] {
  let allIntervals: OptimizedInterval[] = [];

  // Detectar a largura real dos intervalos a partir dos dados
  // Se os intervalos são 00:00, 00:30, 01:00... → 30 min (1800s)
  // Se são 08:00, 08:10, 08:20... → 10 min (600s)
  let detectedIntervalSeconds = inputs.intervalSeconds;
  if (monthData.length > 0 && monthData[0].intervalos.length > 1) {
    const sortedIntervals = monthData[0].intervalos
      .map(i => i.intervalo)
      .filter(i => parseIntervalToMinutes(i) >= 0)
      .sort();
    if (sortedIntervals.length >= 2) {
      const first = parseIntervalToMinutes(sortedIntervals[0]);
      const second = parseIntervalToMinutes(sortedIntervals[1]);
      const diff = second - first;
      if (diff > 0 && diff <= 120) {
        detectedIntervalSeconds = diff * 60;
      }
    }
  }

  // Determinar a janela operacional a partir da config do usuário (sem caps hardcoded)
  const getEffectiveOpWindow = (dateStr: string): { startMins: number; endMins: number } | null => {
    const d = new Date(dateStr + "T00:00:00");
    const day = d.getDay();
    let hours;
    if (day === 0) hours = opHours.sundays;
    else if (day === 6) hours = opHours.saturdays;
    else hours = opHours.weekdays;

    if (hours.closed) return null;

    const cfgStart = parseIntervalToMinutes(hours.start);
    const cfgEnd = parseIntervalToMinutes(hours.end);

    // Suportar janela que atravessa meia-noite (ex: 06:00-00:00)
    // Se endMins <= startMins, a janela cruza meia-noite
    if (cfgEnd <= cfgStart) {
      // Janela cruza meia-noite: qualquer horário >= start OU < end
      return { startMins: cfgStart, endMins: cfgEnd, crossesMidnight: true } as any;
    }

    return { startMins: cfgStart, endMins: cfgEnd };
  };

  // 1. Calculate baseline strictly for each interval
  for (const day of monthData) {
    const opWindow = getEffectiveOpWindow(day.data);
    
    for (const interval of day.intervalos) {
      const intMins = parseIntervalToMinutes(interval.intervalo);
      const intMinsValid = intMins >= 0;

      // Determinar se está dentro do horário de operação
      let isClosed = false;
      if (!intMinsValid || !opWindow) {
        isClosed = true;
      } else if ((opWindow as any).crossesMidnight) {
        // Janela cruza meia-noite: operacional se >= start OU < end
        isClosed = !(intMins >= opWindow.startMins || intMins < opWindow.endMins);
      } else {
        isClosed = !(intMins >= opWindow.startMins && intMins < opWindow.endMins);
      }
      
      let res: ErlangResult;
      const effectiveTmo = inputs.fixedTma || interval.tmo || inputs.tmo;
      
      // Usar o intervalSeconds detectado (não o hardcodado de 600)
      const effectiveIntervalSeconds = detectedIntervalSeconds;

      // Dividir volume por telas para cálculo de staffing (Erlang C)
      // A projeção por intervalo mantém o volume original
      const numTelas = inputs.numTelas && inputs.numTelas > 1 ? inputs.numTelas : 1;
      const staffingVolume = interval.volume / numTelas;
      
      if (isClosed || staffingVolume === 0) {
        // Fechado ou sem volume
        res = {
          agents: 0, requiredAgents: 0, traffic: 0,
          serviceLevel: interval.volume > 0 ? 0 : 100,
          occupancy: 0, probabilityOfWait: interval.volume > 0 ? 100 : 0, asa: interval.volume > 0 ? 9999 : 0,
          erlangB: 0, abandonRate: interval.volume > 0 ? 95 : 0, avgWaitTime: interval.volume > 0 ? 999 : 0, costPerInterval: 0
        };
      } else {
        res = findMinAgents({
          ...inputs,
          volume: staffingVolume,
          tmo: effectiveTmo,
          intervalSeconds: effectiveIntervalSeconds
        });
      }
      
      allIntervals.push({
        ...res,
        data: day.data,
        intervalo: interval.intervalo,
        volume: interval.volume,  // Volume ORIGINAL para projeção/gráficos
        tmo: effectiveTmo,
        isClosed
      });
    }
  }

  // Se a estratégia for diária estrita, não mexemos (o Erlang clássico já faz isso)
  if (strategy === 'strict_daily') {
    return allIntervals;
  }
  
  // Para estratégias agregadas, tentar remover PAs dos picos mantendo a meta agregada
  // TODO: (Lógica complexa) Para simplificar no MVP e responder em tempo real no JS:
  // Vamos apenas aplicar um fator de relaxamento de -1 PA nos intervalos onde occup < maxOccupancy
  // ou onde a remoção não joga o SL do intervalo para baixo de 60% (Regra 80/20)
  
  if (strategy === 'rule_80_20') {
    // Para regra 80/20, podemos abaixar os picos até o SL do intervalo atingir 60%,
    // DESDE QUE 80% do volume total mensal esteja em intervalos >= target SLA.
    // (Simplificação computacional para o frontend rodar rápido)
    const targetSla = inputs.targetSlaPercent * 100;
    
    // Ordena os intervalos pelo volume decrescente (tirar PAs de onde tem mais volume poupa mais)
    const sorted = [...allIntervals].sort((a, b) => b.volume - a.volume);
    
    let volOk = allIntervals.reduce((sum, i) => sum + (i.serviceLevel >= targetSla ? i.volume : 0), 0);
    const totalVol = allIntervals.reduce((sum, i) => sum + i.volume, 0);
    
    for (const item of sorted) {
      if (item.isClosed || item.agents <= 1) continue;
      
      // Simula -1 agent
      const traffic = (item.volume / detectedIntervalSeconds) * item.tmo;
      const sim = evaluateErlangConfig(item.agents - 1, traffic, item.tmo, inputs.targetSlaTime, inputs.shrinkage);
      
      // Se abaixar esse intervalo que antes tava OK
      if (item.serviceLevel >= targetSla && sim.serviceLevel < targetSla) {
        const newVolOk = volOk - item.volume;
        if (newVolOk / totalVol >= 0.8 && sim.serviceLevel >= 60) {
          // Aprova a redução
          volOk = newVolOk;
          Object.assign(item, sim);
        }
      } else if (sim.serviceLevel >= 60) {
        // Se já não tava OK, mas não afunda abaixo de 60, ou se continua OK
        Object.assign(item, sim);
      }
    }
  } else if (strategy === 'monthly_avg') {
    // A otimização real de Trade-off (Média Ponderada) agora é feita 
    // diretamente no Dashboard.tsx através de Busca Binária usando as escalas (Shifts) reais.
    // Aqui retornamos o baseline rigoroso para que a Busca Binária tenha espaço de manobra.
  }

  // Atualiza as propriedades base
  return allIntervals;
}

export interface SensitivityResult {
  volumeChangePct: number;
  volume: number;
  erlangs: number;
  baseAgents: number;
  requiredAgents: number;
  sla: number;
  occupancy: number;
  asa: number;
  abandonRate: number;
}

export function calculateSLASensitivity(
  baseVolume: number,
  tmo: number,
  intervalSeconds: number,
  targetSlaPercent: number,
  targetSlaTime: number,
  shrinkage: number,
  variations: number[] = [-30, -20, -10, 0, 10, 20, 30]
): SensitivityResult[] {
  return variations.map(pct => {
    const vol = Math.round(baseVolume * (1 + pct / 100));
    const inputs: ErlangInputs = {
      volume: vol,
      tmo,
      intervalSeconds,
      targetSlaPercent: targetSlaPercent / 100,
      targetSlaTime,
      shrinkage: shrinkage / 100
    };
    const result = findMinAgents(inputs);
    const abandon = estimateAbandonRate(result.agents, result.traffic, tmo, 60, shrinkage / 100);
    return {
      volumeChangePct: pct,
      volume: vol,
      erlangs: Math.round(result.traffic * 100) / 100,
      baseAgents: result.agents,
      requiredAgents: result.requiredAgents,
      sla: Math.round(result.serviceLevel * 10) / 10,
      occupancy: Math.round(result.occupancy * 10) / 10,
      asa: Math.round(result.asa * 10) / 10,
      abandonRate: Math.round(abandon.abandonRate * 10) / 10
    };
  });
}

// =============================================================================
// NOVAS FUNÇÕES
// =============================================================================

// ---------------------
// 1. Shrinkage Breakdown
// ---------------------

export interface ShrinkageComponent {
  name: string;
  percent: number;
  agentsAbsent: number;
  description: string;
}

export interface ShrinkageResult {
  components: ShrinkageComponent[];
  totalShrinkagePercent: number;
  requiredWithShrinkage: number;
  baseAgents: number;
  additionalAgents: number;
  efficiencyLoss: number; // % do tempo pago perdido com shrinkage
}

/** Componentes padrão de shrinkage para call center */
const DEFAULT_SHRINKAGE_COMPONENTS: Array<{ name: string; percent: number; description: string }> = [
  { name: 'Férias', percent: 8, description: 'Licença remunerada anual conforme CLT' },
  { name: 'Licença médica', percent: 3, description: 'Afastamentos por atestados médicos' },
  { name: 'Treinamento', percent: 2, description: 'Capacitações, reciclagens e integrações' },
  { name: 'Pausas', percent: 5, description: 'Intervalos obrigatórios durante a jornada' },
  { name: 'Reuniões', percent: 1.5, description: 'Alinhamentos de equipe e briefing diário' },
  { name: 'Absentismo', percent: 2, description: 'Faltas não justificadas e atrasos' },
  { name: 'Outros', percent: 0, description: 'Eventos variados (RH, benefícios, etc.)' },
];

/**
 * Calcula o detalhamento do shrinkage por componente.
 * Recebe o número base de agentes necessários e retorna a composição do shrinkage.
 *
 * @param baseAgents - Número de agentes necessários sem shrinkage (linha de frente)
 * @param overrides - Percentuais personalizados por componente (nome -> percentual)
 * @param customComponents - Componentes adicionais ou substitutos
 */
export function calculateShrinkageBreakdown(
  baseAgents: number,
  overrides?: Partial<Record<string, number>>,
  customComponents?: Array<{ name: string; percent: number; description: string }>
): ShrinkageResult {
  const rawComponents = (customComponents || DEFAULT_SHRINKAGE_COMPONENTS).map(comp => {
    const pct = overrides?.[comp.name] !== undefined ? (overrides[comp.name] as number) : comp.percent;
    return { ...comp, percent: pct };
  });

  const totalShrinkagePercent = rawComponents.reduce((sum, c) => sum + c.percent, 0);

  // Agentes ausentes por componente
  const components: ShrinkageComponent[] = rawComponents.map(c => ({
    ...c,
    agentsAbsent: Math.ceil((c.percent / 100) * baseAgents),
  }));

  // Total de agentes necessários incluindo shrinkage
  const requiredWithShrinkage = totalShrinkagePercent > 0
    ? Math.ceil(baseAgents / (1 - totalShrinkagePercent / 100))
    : baseAgents;

  const additionalAgents = requiredWithShrinkage - baseAgents;

  // Eficiência perdida: % do tempo pago que não é produtivo
  const efficiencyLoss = requiredWithShrinkage > 0
    ? ((requiredWithShrinkage - baseAgents) / requiredWithShrinkage) * 100
    : 0;

  return {
    components: components,
    totalShrinkagePercent: Math.round(totalShrinkagePercent * 100) / 100,
    requiredWithShrinkage,
    baseAgents,
    additionalAgents,
    efficiencyLoss: Math.round(efficiencyLoss * 100) / 100,
  };
}

// ---------------------
// 2. Erlang A (M/M/N+M)
// ---------------------

export interface ErlangAResult {
  agents: number;
  serviceLevel: number;
  occupancy: number;
  abandonRate: number;
  avgWaitTime: number;
  probWait: number;
  traffic: number;
}

/**
 * Implementa o modelo Erlang A (M/M/N+M) — fila com abandono.
 * Usa a aproximação de Palm-Jackson para modelar clientes que desistem.
 *
 * Fórmula principal:
 *   P(abandon) ≈ P(wait|ErlangC) × λ / (λ + N × θ)
 *   onde θ = 1 / patienceTime (taxa de desistência)
 *   λ = volume / intervalSeconds (taxa de chegada)
 *
 * Após calcular P(abandon), a taxa efetiva de chegada é reduzida:
 *   λ_efetiva = λ × (1 - P(abandon))
 * E o tráfego efetivo é recalculado para obter as métricas finais.
 *
 * @param volume - Chamadas no intervalo
 * @param tmo - Tempo Médio de Operação (segundos)
 * @param intervalSeconds - Duração do intervalo (segundos)
 * @param targetSlaPercent - Meta de SLA (ex: 0.80 para 80%)
 * @param targetSlaTime - Tempo alvo de SLA (segundos)
 * @param patienceTime - Tempo médio de paciência do cliente (segundos, padrão 60)
 * @param shrinkage - Fator de shrinkage (ex: 0.25 para 25%)
 */
export function calculateErlangA(
  volume: number,
  tmo: number,
  intervalSeconds: number,
  targetSlaPercent: number,
  targetSlaTime: number,
  patienceTime: number = 60,
  _shrinkage?: number
): ErlangAResult {
  if (volume <= 0 || tmo <= 0) {
    return {
      agents: 0, serviceLevel: 100, occupancy: 0,
      abandonRate: 0, avgWaitTime: 0, probWait: 0, traffic: 0
    };
  }

  // Taxa de chegada (chamadas por segundo)
  const lambda = volume / intervalSeconds;
  // Taxa de serviço (chamadas atendidas por segundo por agente)
  const mu = 1 / tmo;
  // Taxa de abandono (1 / tempo de paciência)
  const theta = 1 / patienceTime;

  // Tráfego inicial (erlangs)
  const initialTraffic = lambda / mu;

  // Busca iterativa do número mínimo de agentes
  // Começamos pelo mínimo teórico e iteramos até atingir o SLA
  let agents = Math.max(1, Math.ceil(initialTraffic));

  let bestResult: ErlangAResult | null = null;

  // Limitamos a busca para evitar loops infinitos
  const maxAgents = Math.max(agents * 4, 200);

  for (let n = agents; n <= maxAgents; n++) {
    const traffic = lambda / mu;
    const probWait = calcErlangC(n, traffic);

    // Aproximação de Palm-Jackson para probabilidade de abandono
    const denominator = lambda + n * theta;
    const pAbandon = denominator > 0
      ? probWait * (lambda / denominator)
      : 0;

    // Taxa efetiva de chegada (após abandono)
    const effectiveLambda = lambda * (1 - pAbandon);

    // Tráfego efetivo
    const effectiveTraffic = effectiveLambda / mu;

    // Recalcula métricas com tráfego efetivo
    let serviceLevel = 0;
    let occupancy = 0;
    let avgWaitTime = 0;
    let effectiveProbWait = 0;

    if (n > effectiveTraffic && effectiveTraffic > 0) {
      effectiveProbWait = calcErlangC(n, effectiveTraffic);
      occupancy = effectiveTraffic / n;
      serviceLevel = 1.0 - effectiveProbWait * Math.exp(-(n - effectiveTraffic) * (targetSlaTime / tmo));
      avgWaitTime = (effectiveProbWait * tmo) / (n - effectiveTraffic);
    } else if (effectiveTraffic <= 0) {
      serviceLevel = 1;
      occupancy = 0;
      avgWaitTime = 0;
    } else {
      // Sistema sobrecarregado mesmo com abandono
      serviceLevel = 0;
      occupancy = 1;
      avgWaitTime = 999;
    }

    serviceLevel = Math.max(0, Math.min(1, serviceLevel));

    bestResult = {
      agents: n,
      serviceLevel: Math.round(serviceLevel * 1000) / 10,
      occupancy: Math.round(occupancy * 1000) / 10,
      abandonRate: Math.round(pAbandon * 1000) / 10,
      avgWaitTime: Math.round(avgWaitTime * 10) / 10,
      probWait: Math.round(effectiveProbWait * 1000) / 10,
      traffic: Math.round(effectiveTraffic * 100) / 100,
    };

    // Verifica se atingiu o SLA e ocupação razoável
    if (serviceLevel >= targetSlaPercent && occupancy < 0.95) {
      break;
    }
  }

  // Se não encontrou resultado, retorna o último calculado
  return bestResult || {
    agents, serviceLevel: 0, occupancy: 100,
    abandonRate: 95, avgWaitTime: 999, probWait: 100, traffic: initialTraffic
  };
}

// -------------------------
// 3. Análise de Cenários
// -------------------------

export interface ScenarioResult {
  name: string;
  volume: number;
  tmo: number;
  erlangs: number;
  baseAgents: number;
  requiredAgents: number;
  sla: number;
  occupancy: number;
  asa: number;
  costDelta: number;
  riskLevel: 'Baixo' | 'Médio' | 'Alto' | 'Crítico';
}

export interface ScenarioInput {
  name: string;
  volumeDeltaPct?: number; // % de variação de volume em relação ao base
  tmoDeltaPct?: number;    // % de variação de TMO em relação ao base
  volume?: number;         // Override absoluto de volume
  tmo?: number;            // Override absoluto de TMO
}

/**
 * Calcula o impacto de múltiplos cenários sobre o dimensionamento.
 * Cada cenário pode variar volume e/ou TMO em relação a um cenário base.
 *
 * @param baseVolume - Volume base (chamadas por intervalo)
 * @param baseTmo - TMO base (segundos)
 * @param intervalSeconds - Duração do intervalo (segundos)
 * @param targetSlaPercent - Meta de SLA (0-1)
 * @param targetSlaTime - Tempo alvo de SLA (segundos)
 * @param shrinkage - Fator de shrinkage (0-1)
 * @param costPerAgentMonth - Custo mensal por agente (padrão 5000)
 * @param scenarios - Lista de cenários para comparar
 */
export function calculateScenarioImpact(
  baseVolume: number,
  baseTmo: number,
  intervalSeconds: number,
  targetSlaPercent: number,
  targetSlaTime: number,
  shrinkage: number,
  costPerAgentMonth: number = 5000,
  scenarios: ScenarioInput[]
): ScenarioResult[] {
  // Calcula o cenário base como referência de custo
  const baseInputs: ErlangInputs = {
    volume: baseVolume,
    tmo: baseTmo,
    intervalSeconds,
    targetSlaPercent,
    targetSlaTime,
    shrinkage,
    costPerAgentMonth,
  };
  const baseResult = findMinAgents(baseInputs);
  const baseCost = baseResult.requiredAgents * costPerAgentMonth;

  return scenarios.map(scenario => {
    // Calcula volume e TMO do cenário
    const volume = scenario.volume !== undefined
      ? scenario.volume
      : Math.round(baseVolume * (1 + (scenario.volumeDeltaPct || 0) / 100));

    const tmo = scenario.tmo !== undefined
      ? scenario.tmo
      : Math.round(baseTmo * (1 + (scenario.tmoDeltaPct || 0) / 100));

    const scenarioInputs: ErlangInputs = {
      volume,
      tmo,
      intervalSeconds,
      targetSlaPercent,
      targetSlaTime,
      shrinkage,
      costPerAgentMonth,
    };

    const result = findMinAgents(scenarioInputs);
    const scenarioCost = result.requiredAgents * costPerAgentMonth;
    const costDelta = scenarioCost - baseCost;

    // Classificação de risco baseada no SLA e ocupação
    let riskLevel: 'Baixo' | 'Médio' | 'Alto' | 'Crítico';
    if (result.serviceLevel >= targetSlaPercent * 100 && result.occupancy < 85) {
      riskLevel = 'Baixo';
    } else if (result.serviceLevel >= targetSlaPercent * 90 && result.occupancy < 92) {
      riskLevel = 'Médio';
    } else if (result.serviceLevel >= targetSlaPercent * 70) {
      riskLevel = 'Alto';
    } else {
      riskLevel = 'Crítico';
    }

    return {
      name: scenario.name,
      volume,
      tmo,
      erlangs: Math.round(result.traffic * 100) / 100,
      baseAgents: result.agents,
      requiredAgents: result.requiredAgents,
      sla: Math.round(result.serviceLevel * 10) / 10,
      occupancy: Math.round(result.occupancy * 10) / 10,
      asa: Math.round(result.asa * 10) / 10,
      costDelta: Math.round(costDelta),
      riskLevel,
    };
  });
}

// -------------------------
// 4. Multi-Queue (Skill-Based Routing)
// -------------------------

export interface QueueInput {
  name: string;
  weight: number;   // Peso relativo (1-10) — habilidade do agente nesta fila
  volume: number;   // Chamadas por intervalo
  tmo: number;      // Tempo médio de operação (segundos)
}

export interface MultiQueueResult {
  queues: Array<{
    name: string;
    volume: number;
    tmo: number;
    erlangs: number;
    dedicatedAgents: number;
    sharedAgents: number;
    totalAgents: number;
    sla: number;
    occupancy: number;
  }>;
  sharedPoolSize: number;
  totalSiloHC: number;
  totalOptimizedHC: number;
  savingsAgents: number;
  savingsPercent: number;
}

/**
 * Calcula dimensionamento multi-fila com roteamento baseado em habilidades.
 * Compara o modelo silo (filas independentes) com o modelo compartilhado
 * onde um pool de agentes qualificados atende overflow de todas as filas.
 *
 * Abordagem:
 * 1. Calcula agentes dedicados por fila (modelo silo)
 * 2. Agrega o tráfego excedente (pesado por peso de habilidade) em um pool compartilhado
 * 3. Calcula a economia entre os modelos
 *
 * @param queues - Lista de filas com volume, TMO e peso de habilidade
 * @param intervalSeconds - Duração do intervalo (segundos)
 * @param targetSlaPercent - Meta de SLA (0-1)
 * @param targetSlaTime - Tempo alvo de SLA (segundos)
 * @param shrinkage - Fator de shrinkage (0-1)
 */
export function calculateMultiQueue(
  queues: QueueInput[],
  intervalSeconds: number,
  targetSlaPercent: number,
  targetSlaTime: number,
  shrinkage: number = 0
): MultiQueueResult {
  if (queues.length === 0) {
    return {
      queues: [],
      sharedPoolSize: 0,
      totalSiloHC: 0,
      totalOptimizedHC: 0,
      savingsAgents: 0,
      savingsPercent: 0,
    };
  }

  // Passo 1: Calcula agentes dedicados para cada fila (modelo silo)
  const queueResults = queues.map(q => {
    const traffic = (q.volume / intervalSeconds) * q.tmo;
    const inputs: ErlangInputs = {
      volume: q.volume,
      tmo: q.tmo,
      intervalSeconds,
      targetSlaPercent,
      targetSlaTime,
      shrinkage,
    };
    const result = findMinAgents(inputs);
    return {
      name: q.name,
      volume: q.volume,
      tmo: q.tmo,
      erlangs: Math.round(traffic * 100) / 100,
      dedicatedAgents: result.requiredAgents,
      sharedAgents: 0,
      totalAgents: result.requiredAgents,
      sla: result.serviceLevel,
      occupancy: result.occupancy,
    };
  });

  // Passo 2: Calcula tráfego agregado para o pool compartilhado
  const totalWeight = queues.reduce((sum, q) => sum + q.weight, 0);

  // Tráfego excedente ponderado (tráfego total * peso / peso_total)
  // Agentes no modelo otimizado: cada fila recebe proporcional ao seu peso
  queues.reduce((sum, q) => sum + (q.volume / intervalSeconds) * q.tmo, 0);

  // Agentes base para tráfego total
  const totalInputs: ErlangInputs = {
    volume: queues.reduce((sum, q) => sum + q.volume, 0),
    tmo: Math.round(queues.reduce((sum, q) => sum + q.tmo * q.volume, 0) / queues.reduce((sum, q) => sum + q.volume, 0)),
    intervalSeconds,
    targetSlaPercent,
    targetSlaTime,
    shrinkage,
  };
  const totalResult = findMinAgents(totalInputs);

  // Distribui os agentes otimizados proporcionalmente ao peso de cada fila
  const totalOptimized = totalResult.requiredAgents;

  queueResults.forEach((qr, idx) => {
    const weightRatio = queues[idx].weight / totalWeight;
    qr.sharedAgents = Math.round(qr.dedicatedAgents * (1 - weightRatio * 0.3));
    qr.totalAgents = Math.max(1, qr.dedicatedAgents - Math.floor(qr.sharedAgents * 0.15));
  });

  // Tamanho do pool compartilhado
  const sharedPoolSize = Math.max(0, totalOptimized - queueResults.reduce((sum, qr) => sum + qr.totalAgents, 0) + Math.floor(totalOptimized * 0.1));

  // Total no modelo silo
  const totalSiloHC = queueResults.reduce((sum, qr) => sum + qr.dedicatedAgents, 0);

  // Total no modelo otimizado
  const totalOptimizedHC = queueResults.reduce((sum, qr) => sum + qr.totalAgents, 0) + sharedPoolSize;

  // Economia
  const savingsAgents = Math.max(0, totalSiloHC - totalOptimizedHC);
  const savingsPercent = totalSiloHC > 0 ? (savingsAgents / totalSiloHC) * 100 : 0;

  return {
    queues: queueResults,
    sharedPoolSize: Math.max(0, Math.round(sharedPoolSize)),
    totalSiloHC,
    totalOptimizedHC: Math.round(totalOptimizedHC),
    savingsAgents: Math.round(savingsAgents),
    savingsPercent: Math.round(savingsPercent * 10) / 10,
  };
}

// -----------------------------------
// 5. Análise de Ocupação por Intervalo
// -----------------------------------

export interface OccupancyInterval {
  interval: string;
  volume: number;
  tmo: number;
  erlangs: number;
  agents: number;
  occupancy: number;
  status: 'normal' | 'alto' | 'burnout' | 'subutilizado';
  recommendation: string;
}

export interface OccupancyAnalysis {
  intervals: OccupancyInterval[];
  avgOccupancy: number;
  maxOccupancy: number;
  burnoutIntervals: number;
  underUtilizedIntervals: number;
  riskLevel: 'Baixo' | 'Médio' | 'Alto';
  recommendations: string[];
}

/**
 * Analisa a ocupação por intervalo ao longo do dia, detectando
 * situações de burnout (>92%), alta ocupação (85-92%), normal (50-85%)
 * e subutilização (<50%).
 *
 * Gera recomendações automáticas para cada intervalo e para o dia como um todo.
 *
 * @param intervalData - Dados por intervalo (nome do intervalo, volume, TMO)
 * @param intervalSeconds - Duração de cada intervalo (segundos)
 * @param maxOccupancyTarget - Ocupação máxima alvo (padrão 0.85)
 */
export function generateOccupancyAnalysis(
  intervalData: Array<{ interval: string; volume: number; tmo: number }>,
  intervalSeconds: number,
  maxOccupancyTarget: number = 0.85
): OccupancyAnalysis {
  const intervals: OccupancyInterval[] = intervalData.map(data => {
    const traffic = (data.volume / intervalSeconds) * data.tmo;
    const agents = data.volume > 0 ? Math.max(1, Math.ceil(traffic / maxOccupancyTarget)) : 0;
    const occupancy = agents > 0 ? (traffic / agents) * 100 : 0;

    // Classifica o status do intervalo
    let status: OccupancyInterval['status'];
    let recommendation: string;

    if (occupancy > 92) {
      status = 'burnout';
      recommendation = `Risco crítico de burnout (${occupancy.toFixed(1)}%). Aumentar equipe em pelo menos ${Math.ceil((occupancy - 85) / 10)} agentes ou redistribuir volume.`;
    } else if (occupancy > 85) {
      status = 'alto';
      recommendation = `Ocupação elevada (${occupancy.toFixed(1)}%). Considerar adicionar 1-2 agentes para reduzir fila e tempo de espera.`;
    } else if (occupancy < 50 && agents > 0 && data.volume > 0) {
      status = 'subutilizado';
      recommendation = `Ocupação baixa (${occupancy.toFixed(1)}%). Possibilidade de reduzir ${Math.max(1, Math.floor(agents * (1 - occupancy / 75)))} agentes ou alocar em outras atividades.`;
    } else {
      status = 'normal';
      recommendation = 'Ocupação dentro da faixa ideal. Manter dimensionamento atual.';
    }

    return {
      interval: data.interval,
      volume: data.volume,
      tmo: data.tmo,
      erlangs: Math.round(traffic * 100) / 100,
      agents,
      occupancy: Math.round(occupancy * 10) / 10,
      status,
      recommendation,
    };
  });

  // Estatísticas globais
  const activeIntervals = intervals.filter(i => i.agents > 0);
  const avgOccupancy = activeIntervals.length > 0
    ? activeIntervals.reduce((sum, i) => sum + i.occupancy, 0) / activeIntervals.length
    : 0;
  const maxOccupancy = activeIntervals.length > 0
    ? Math.max(...activeIntervals.map(i => i.occupancy))
    : 0;

  const burnoutIntervals = intervals.filter(i => i.status === 'burnout').length;
  const underUtilizedIntervals = intervals.filter(i => i.status === 'subutilizado').length;

  // Classificação de risco geral
  let riskLevel: 'Baixo' | 'Médio' | 'Alto';
  if (burnoutIntervals === 0 && avgOccupancy < 85) {
    riskLevel = 'Baixo';
  } else if (burnoutIntervals <= 2 && avgOccupancy < 90) {
    riskLevel = 'Médio';
  } else {
    riskLevel = 'Alto';
  }

  // Recomendações gerais
  const recommendations: string[] = [];

  if (burnoutIntervals > 0) {
    recommendations.push(
      `${burnoutIntervals} intervalo(s) com risco de burnout (>92%). Priorizar reforço nesses horários.`
    );
  }

  if (underUtilizedIntervals > 0) {
    recommendations.push(
      `${underUtilizedIntervals} intervalo(s) subutilizados (<50%). Avaliar redistribuição de equipe ou atividades secundárias.`
    );
  }

  if (avgOccupancy > 88) {
    recommendations.push(
      `Ocupação média elevada (${avgOccupancy.toFixed(1)}%). Considerar aumentar o headcount total para reduzir o risco de absenteísmo.`
    );
  }

  if (maxOccupancy - (activeIntervals.length > 0
    ? Math.min(...activeIntervals.map(i => i.occupancy))
    : 0) > 40) {
    recommendations.push(
      'Grande variância de ocupação entre intervalos. Considerar escalas flexíveis ou jornadas partidas.'
    );
  }

  if (recommendations.length === 0) {
    recommendations.push('O dimensionamento está bem equilibrado. Continue monitorando as métricas regularmente.');
  }

  return {
    intervals,
    avgOccupancy: Math.round(avgOccupancy * 10) / 10,
    maxOccupancy: Math.round(maxOccupancy * 10) / 10,
    burnoutIntervals,
    underUtilizedIntervals,
    riskLevel,
    recommendations,
  };
}

// -------------------------
// 6. Exportar para CSV
// -------------------------

/**
 * Exporta um array de objetos como arquivo CSV, acionando o download no navegador.
 *
 * @param data - Array de objetos com chaves como cabeçalhos das colunas
 * @param filename - Nome do arquivo (será adicionada extensão .csv se necessário)
 */
export function exportToCSV(data: Record<string, unknown>[], filename: string): void {
  if (!data || data.length === 0) return;

  const headers = Object.keys(data[0]);
  const csvRows: string[] = [];

  // Cabeçalho
  csvRows.push(headers.map(h => `"${h}"`).join(';'));

  // Linhas de dados
  for (const row of data) {
    const values = headers.map(header => {
      const val = row[header];
      // Formata números com ponto decimal e vírgula como separador de milhar (padrão BR)
      if (typeof val === 'number') {
        return val.toString().replace('.', ',');
      }
      // Escapa aspas duplas em strings
      const str = String(val ?? '');
      return `"${str.replace(/"/g, '""')}"`;
    });
    csvRows.push(values.join(';'));
  }

  const csvContent = '\uFEFF' + csvRows.join('\n'); // BOM para UTF-8
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename.endsWith('.csv') ? filename : `${filename}.csv`);
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// -------------------------
// 7. Exportar para JSON
// -------------------------

/**
 * Exporta dados como arquivo JSON formatado, acionando o download no navegador.
 *
 * @param data - Dados a serem exportados (qualquer tipo serializável)
 * @param filename - Nome do arquivo (será adicionada extensão .json se necessário)
 */
export function exportToJSON(data: unknown, filename: string): void {
  const jsonContent = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename.endsWith('.json') ? filename : `${filename}.json`);
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
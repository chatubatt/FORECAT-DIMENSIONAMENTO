export interface ErlangResult {
  agents: number; // Base agents
  requiredAgents: number; // Agents with shrinkage
  traffic: number; // Erlangs
  serviceLevel: number; // %
  occupancy: number; // %
  probabilityOfWait: number; // %
  asa: number; // Average Speed of Answer in seconds
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
  shrinkage: number
): ErlangResult {
  const probWait = calcErlangC(agents, traffic);
  
  let serviceLevel = 0;
  let asa = 0;
  let occupancy = 0;

  if (agents > traffic) {
    serviceLevel = 1.0 - probWait * Math.exp(-(agents - traffic) * (targetSlaTime / tmo));
    asa = (probWait * tmo) / (agents - traffic);
    occupancy = traffic / agents;
  } else {
    // Overloaded system
    serviceLevel = 0;
    asa = 9999; // Arbitrary high number for overloaded
    occupancy = 1.0;
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
    asa
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
    return evaluateErlangConfig(Math.max(1, baseFixedAgents), traffic, tmo, inputs.targetSlaTime, inputs.shrinkage);
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

  return currentResult;
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
  return h * 60 + m;
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
  
  // if endMins <= startMins, it crosses midnight. (For simplicity assume it doesn't)
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
  
  // 1. Calculate baseline strictly for each interval
  for (const day of monthData) {
    for (const interval of day.intervalos) {
      const isClosed = !isWithinOperatingHours(day.data, interval.intervalo, opHours);
      
      let res: ErlangResult;
      const effectiveTmo = inputs.fixedTma || interval.tmo || inputs.tmo;
      
      if (isClosed || interval.volume === 0) {
        // Fechado ou sem volume
        res = {
          agents: 0, requiredAgents: 0, traffic: 0,
          serviceLevel: interval.volume > 0 ? 0 : 100, // Se fechado mas tem vol = abandono total
          occupancy: 0, probabilityOfWait: interval.volume > 0 ? 100 : 0, asa: interval.volume > 0 ? 9999 : 0
        };
      } else {
        res = findMinAgents({
          ...inputs,
          volume: interval.volume,
          tmo: effectiveTmo
        });
      }
      
      allIntervals.push({
        ...res,
        data: day.data,
        intervalo: interval.intervalo,
        volume: interval.volume,
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
      const traffic = (item.volume / inputs.intervalSeconds) * item.tmo;
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

export type ShiftType = '06:20' | '08:12' | '05:15' | '07:12' | '08:48' | '04:00' | '06:00' | '12x36' | '09:00';

export interface ShiftDefinition {
  type: ShiftType;
  label: string;
  durationMinutes: number;
  intervalsCovered: number; // In 10-min blocks
  daysOffFactor: number; // e.g., 7/6 for 6x1, 7/5 for 5x2
  recommended?: boolean;
}

export const AVAILABLE_SHIFTS: ShiftDefinition[] = [
  { type: '06:20', label: '6h20 (6x1)', durationMinutes: 380, intervalsCovered: 38, daysOffFactor: 7/6, recommended: true },
  { type: '08:12', label: '8h12 (5x2)', durationMinutes: 492, intervalsCovered: 49, daysOffFactor: 7/5, recommended: true },
  { type: '07:12', label: '7h12 (6x1)', durationMinutes: 432, intervalsCovered: 43, daysOffFactor: 7/6 },
  { type: '08:48', label: '8h48 (5x2)', durationMinutes: 528, intervalsCovered: 53, daysOffFactor: 7/5 },
  { type: '06:00', label: '6h00 (6x1)', durationMinutes: 360, intervalsCovered: 36, daysOffFactor: 7/6 },
  { type: '09:00', label: '9h00 (4x3)', durationMinutes: 540, intervalsCovered: 54, daysOffFactor: 7/4 },
  { type: '12x36', label: '12h00 (12x36)', durationMinutes: 720, intervalsCovered: 72, daysOffFactor: 2 },
  { type: '04:00', label: 'Part-time 4h (6x1)', durationMinutes: 240, intervalsCovered: 24, daysOffFactor: 7/6 },
  { type: '05:15', label: 'Jovem Aprendiz (5x2)', durationMinutes: 315, intervalsCovered: 32, daysOffFactor: 7/5 }
];

export interface ScheduledShift {
  shift: ShiftDefinition;
  startTime: string;
  startIndex: number;
  count: number;
}

export interface ShiftScheduleResult {
  schedules: ScheduledShift[];
  totalDailyHC: number;
  totalMonthlyHC: number;
  hcPerShiftType: Record<string, number>;
  entradasPerInterval: Record<string, number>[];
  activePerInterval: Record<string, number>[];
  coverage: number[]; // resulting coverage per interval
  costScore: number;
}

/**
 * Greedy algorithm to schedule shifts to cover the required Erlang agents.
 */
export function calculateShifts(
  requiredAgentsPerInterval: number[],
  intervalLabels: string[],
  enabledShiftTypes: ShiftType[],
  operatingDays: number = 7
): ShiftScheduleResult {
  
  // Clone to avoid mutating original, and update daysOffFactor dynamically
  const enabledShifts = AVAILABLE_SHIFTS.filter(s => enabledShiftTypes.includes(s.type)).map(s => {
    const daysWorked = 7 / s.daysOffFactor;
    return { ...s, daysOffFactor: Math.max(1.0, operatingDays / daysWorked) };
  });
  if (enabledShifts.length === 0 || requiredAgentsPerInterval.length === 0) {
    return { 
      schedules: [], totalDailyHC: 0, totalMonthlyHC: 0, 
      hcPerShiftType: {}, entradasPerInterval: [], 
      activePerInterval: [],
      coverage: [], costScore: 0 
    };
  }

  // Ordenar por duração decrescente para priorizar turnos longos
  enabledShifts.sort((a, b) => b.intervalsCovered - a.intervalsCovered);

  const numIntervals = requiredAgentsPerInterval.length;
  const coverage = new Array(numIntervals).fill(0);
  const required = [...requiredAgentsPerInterval];
  
  const scheduleMap = new Map<string, ScheduledShift>(); // key: "type-startIndex"

  const maxIterations = numIntervals * 500;
  for (let iter = 0; iter < maxIterations; iter++) {
    const totalDeficit = required.reduce((s, v) => s + Math.max(0, v), 0);
    if (totalDeficit === 0) break;

    let peakIdx = 0;
    let peakVal = 0;
    for (let i = 0; i < numIntervals; i++) {
      if (required[i] > peakVal) { peakVal = required[i]; peakIdx = i; }
    }

    let bestShift = enabledShifts[0];
    let bestScore = -Infinity;
    let bestStartIndex = 0;

    for (const shift of enabledShifts) {
      const minStart = Math.max(0, peakIdx - shift.intervalsCovered + 1);
      const effectiveMaxStart = Math.min(peakIdx, Math.max(0, numIntervals - shift.intervalsCovered));
      
      const startIter = minStart <= effectiveMaxStart ? minStart : 0;
      const endIter = minStart <= effectiveMaxStart ? effectiveMaxStart : Math.max(0, numIntervals - shift.intervalsCovered);
      
      for (let s = startIter; s <= endIter; s++) {
        let reduction = 0;
        let zeroDeficit = 0;
        const limit = Math.min(s + shift.intervalsCovered, numIntervals);
        for (let j = s; j < limit; j++) {
          if (required[j] > 0) reduction += required[j];
          else zeroDeficit++;
        }
        
        const validDuration = Math.max(1, limit - s);
        let score = reduction / validDuration;
        
        const wasted = shift.intervalsCovered - validDuration;
        score += (validDuration * 0.0001) - (wasted * 0.0001);
        
        score -= (zeroDeficit * 0.01);
        
        const shiftCenter = s + (validDuration / 2);
        const distanceToPeak = Math.abs(shiftCenter - peakIdx);
        score -= (distanceToPeak * 0.0001);

        if (score > bestScore) {
          bestScore = score;
          bestShift = shift;
          bestStartIndex = s;
        }
      }
    }

    if (bestScore === -Infinity) break;

    const key = `${bestShift.type}-${bestStartIndex}`;
    if (!scheduleMap.has(key)) {
      scheduleMap.set(key, {
        shift: bestShift,
        startTime: intervalLabels[bestStartIndex],
        startIndex: bestStartIndex,
        count: 0
      });
    }
    scheduleMap.get(key)!.count++;

    const limit = Math.min(bestStartIndex + bestShift.intervalsCovered, numIntervals);
    for (let j = bestStartIndex; j < limit; j++) {
      required[j]--;
      coverage[j]++;
    }
  }

  let totalDaily = 0;
  let totalMonthly = 0;
  const hcPerShiftType: Record<string, number> = {};
  const entradasPerInterval: Record<string, number>[] = Array.from({ length: numIntervals }, () => ({}));
  const activePerInterval: Record<string, number>[] = Array.from({ length: numIntervals }, () => ({}));
  
  const schedules = Array.from(scheduleMap.values());
  schedules.sort((a, b) => a.startIndex - b.startIndex);

  schedules.forEach(s => {
    totalDaily += s.count;
    totalMonthly += (s.count * s.shift.daysOffFactor);
    
    // Agg HC per shift type
    hcPerShiftType[s.shift.type] = (hcPerShiftType[s.shift.type] || 0) + s.count;
    
    // Agg Entradas per interval
    if (!entradasPerInterval[s.startIndex][s.shift.type]) {
      entradasPerInterval[s.startIndex][s.shift.type] = 0;
    }
    entradasPerInterval[s.startIndex][s.shift.type] += s.count;

    // Agg Active per interval
    const limit = Math.min(s.startIndex + s.shift.intervalsCovered, numIntervals);
    for (let j = s.startIndex; j < limit; j++) {
      if (!activePerInterval[j][s.shift.type]) {
        activePerInterval[j][s.shift.type] = 0;
      }
      activePerInterval[j][s.shift.type] += s.count;
    }
  });

  return {
    schedules,
    totalDailyHC: totalDaily,
    totalMonthlyHC: Math.ceil(totalMonthly),
    hcPerShiftType,
    entradasPerInterval,
    activePerInterval,
    coverage,
    costScore: 0
  };
}

// ===========================================================================
// ALOCAÇÃO AUTOMÁTICA RESTRITA A 06:20 E 08:12
// ===========================================================================

export interface AllocationEntry {
  startTime: string;
  endTime: string;
  shiftType: '06:20' | '08:12';
  durationMinutes: number;
  count: number;
}

export interface ShiftAllocationResult {
  allocations: AllocationEntry[];
  coveragePerInterval: number[];
  necPerInterval: number[];
  total_0620: number;
  total_0812: number;
  totalHC: number;
  peakCoverage: number;
  peakNec: number;
}

/**
 * Algoritmo guloso especializado para alocar apenas turnos de 06:20 e 08:12.
 * Baseado no TurnoOptimizer (Python) fornecido pelo usuário.
 *
 * 1. Gera candidatos (início, fim) para cada tipo dentro da janela de operação.
 * 2. A cada passo, encontra o intervalo com maior déficit.
 * 3. Escolhe o candidato com melhor score, priorizando eficiência de cobertura e evitando ociosidade.
 * 4. Adiciona 1 agente e atualiza cobertura. Repete até zerar déficit.
 */
export function allocateShifts612_812(
  nec: number[],
  intervalLabels: string[],
  opStart: string,
  opEnd: string
): ShiftAllocationResult {
  const INTERVAL_MINUTES = 10;

  const getHHMM = (startStr: string, offsetIntervals: number): string => {
    if (!startStr) return "00:00";
    const [h, m] = startStr.split(':').map(Number);
    const totalMin = h * 60 + m + offsetIntervals * INTERVAL_MINUTES;
    const endH = Math.floor(totalMin / 60) % 24;
    const endM = totalMin % 60;
    return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
  };

  const n = nec.length;

  const DURATION_0620 = 38; // 380 min
  const DURATION_0812 = 49; // 492 min

  let opStartIdx = intervalLabels.indexOf(opStart);
  if (opStartIdx === -1) opStartIdx = 0;
  
  let opEndIdx = intervalLabels.indexOf(opEnd);
  if (opEndIdx === -1) opEndIdx = n;

  type Candidate = { start: number; end: number; type: '06:20' | '08:12'; duration: number };
  const candidates: Candidate[] = [];

  for (let s = opStartIdx; s < opEndIdx; s++) {
    const end0620 = s + DURATION_0620;
    if (end0620 <= opEndIdx) {
      candidates.push({ start: s, end: end0620, type: '06:20', duration: DURATION_0620 });
    }
    
    const end0812 = s + DURATION_0812;
    if (end0812 <= opEndIdx) {
      candidates.push({ start: s, end: end0812, type: '08:12', duration: DURATION_0812 });
    }
  }

  const coverage = new Array(n).fill(0);
  const allocationMap = new Map<string, { start: number; end: number; type: '06:20' | '08:12'; duration: number; count: number }>();

  const maxIterations = n * 500;

  for (let iter = 0; iter < maxIterations; iter++) {
    const deficit = nec.map((req, i) => Math.max(0, req - coverage[i]));
    const totalDeficit = deficit.reduce((s, v) => s + v, 0);
    if (totalDeficit === 0) break;

    let peakIdx = 0;
    let peakVal = 0;
    for (let i = 0; i < n; i++) {
      if (deficit[i] > peakVal) { peakVal = deficit[i]; peakIdx = i; }
    }

    let bestCand: Candidate | null = null;
    let bestScore = -Infinity;

    for (const cand of candidates) {
      if (cand.start > peakIdx || cand.end <= peakIdx) continue;
      let reduction = 0;
      let zeroDeficit = 0;
      const limit = Math.min(cand.end, n);
      for (let j = cand.start; j < limit; j++) {
        reduction += deficit[j];
        if (deficit[j] === 0) zeroDeficit++;
      }
      const validDuration = Math.max(1, limit - cand.start);
      let score = reduction / validDuration;
      
      // Tie breaker: reward longer useful work (reduces HC) but penalize wasted intervals outside operating window
      const wasted = cand.duration - validDuration;
      score += (validDuration * 0.0001) - (wasted * 0.0001);
      
      // Penalize overstaffing (zero deficit intervals)
      score -= (zeroDeficit * 0.01);
      
      // Center shift around peak to break ties and avoid pushing shifts too early
      const shiftCenter = (cand.start + limit) / 2;
      const distanceToPeak = Math.abs(shiftCenter - peakIdx);
      score -= (distanceToPeak * 0.0001);

      if (score > bestScore) { bestScore = score; bestCand = cand; }
    }

    if (!bestCand) break;

    const key = `${bestCand.type}-${bestCand.start}`;
    if (!allocationMap.has(key)) {
      allocationMap.set(key, { ...bestCand, count: 0 });
    }
    allocationMap.get(key)!.count++;

    const limit = Math.min(bestCand.end, n);
    for (let j = bestCand.start; j < limit; j++) {
      coverage[j]++;
    }
  }

  const allocations: AllocationEntry[] = [];
  let total_0620 = 0;
  let total_0812 = 0;

  for (const entry of allocationMap.values()) {
    const startTime = intervalLabels[entry.start] || "00:00";
    const endTime = getHHMM(startTime, entry.duration);
    allocations.push({
      startTime,
      endTime,
      shiftType: entry.type,
      durationMinutes: entry.duration * INTERVAL_MINUTES,
      count: entry.count
    });
    if (entry.type === '06:20') total_0620 += entry.count;
    else total_0812 += entry.count;
  }

  allocations.sort((a, b) => {
    const cmp = a.startTime.localeCompare(b.startTime);
    return cmp !== 0 ? cmp : a.shiftType.localeCompare(b.shiftType);
  });

  return {
    allocations,
    coveragePerInterval: coverage,
    necPerInterval: [...nec],
    total_0620,
    total_0812,
    totalHC: total_0620 + total_0812,
    peakCoverage: Math.max(0, ...coverage),
    peakNec: Math.max(0, ...nec)
  };
}

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
  efficiency: number;        // coverage / required ratio (ideal = 1.0)
  overstaffedIntervals: number;  // intervals where coverage > required * 1.2
  understaffedIntervals: number; // intervals where coverage < required
  maxOverstaff: number;     // max excess agents in any interval
  totalWastedMinutes: number; // total minutes of overstaffing
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
      coverage: [], costScore: 0,
      efficiency: 0, overstaffedIntervals: 0, understaffedIntervals: 0,
      maxOverstaff: 0, totalWastedMinutes: 0
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
        let useful = 0;
        let wasted = 0;
        let reduction = 0;
        const limit = Math.min(s + shift.intervalsCovered, numIntervals);
        for (let j = s; j < limit; j++) {
          if (required[j] > 0) {
            useful++;
            reduction += required[j];
          } else {
            wasted++;
          }
        }
// Penalize wasted coverage outside operating hours
        const overflow = shift.intervalsCovered - (limit - s);
        wasted += overflow;
        
        // Primary Score: useful coverage minus wasted coverage
        let score = useful - (wasted * 1.5);
        
        // Secondary Score (Tie-breaker 1): favor covering the highest deficits (centers shift around peak)
        score += (reduction * 0.001);
        
        // Tie-breaker 2: prefer shifts naturally centered on the peak to avoid breaking ties badly
        const shiftCenter = s + (shift.intervalsCovered / 2);
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

  // Compute efficiency metrics
  let overstaffedIntervals = 0;
  let understaffedIntervals = 0;
  let maxOverstaff = 0;
  let totalWastedMinutes = 0;
  let totalCoverage = 0;
  let totalRequired = 0;

  for (let i = 0; i < numIntervals; i++) {
    const cov = coverage[i];
    const req = requiredAgentsPerInterval[i];
    totalCoverage += cov;
    totalRequired += req;

    if (req > 0) {
      if (cov > req * 1.2) {
        overstaffedIntervals++;
        const excess = cov - req;
        if (excess > maxOverstaff) maxOverstaff = excess;
        totalWastedMinutes += excess * 10; // each interval is 10 minutes
      }
      if (cov < req) {
        understaffedIntervals++;
      }
    }
  }

  const efficiency = totalRequired > 0 ? totalCoverage / totalRequired : 0;

  return {
    schedules,
    totalDailyHC: totalDaily,
    totalMonthlyHC: Math.ceil(totalMonthly),
    hcPerShiftType,
    entradasPerInterval,
    activePerInterval,
    coverage,
    costScore: 0,
    efficiency: Math.round(efficiency * 100) / 100,
    overstaffedIntervals,
    understaffedIntervals,
    maxOverstaff,
    totalWastedMinutes
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
      let useful = 0;
      let wasted = 0;
      let reduction = 0;
      const limit = Math.min(cand.end, n);
      for (let j = cand.start; j < limit; j++) {
        if (deficit[j] > 0) {
          useful++;
          reduction += deficit[j];
        } else {
          wasted++;
        }
      }
      
      const overflow = cand.duration - (limit - cand.start);
      wasted += overflow;
      
      let score = useful - (wasted * 1.5);
      
      score += (reduction * 0.001);
      
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

export interface ShiftCombinationCost {
  shifts: ShiftType[];
  totalMonthlyHC: number;
  totalDailyHC: number;
  estimatedCost: number;
  efficiency: number;
  costPerAgent: number;
}

export function compareShiftCombinations(
  requiredAgentsPerInterval: number[],
  intervalLabels: string[],
  costPerAgentMonth: number = 5000,
  overheadPercent: number = 30,
  operatingDays: number = 7
): ShiftCombinationCost[] {
  // Test common combinations
  const combinations: ShiftType[][] = [
    ['06:20'],
    ['08:12'],
    ['06:20', '08:12'],
    ['06:20', '07:12'],
    ['07:12', '08:12'],
    ['06:00', '06:20', '08:12'],
    ['06:20', '07:12', '08:12'],
    ['06:20', '08:12', '04:00'],
    ['06:20', '08:12', '05:15'],
    ['06:20', '08:12', '12x36'],
  ];

  return combinations.map(shifts => {
    const result = calculateShifts(requiredAgentsPerInterval, intervalLabels, shifts, operatingDays);
    const totalCost = result.totalMonthlyHC * costPerAgentMonth * (1 + overheadPercent / 100);
    return {
      shifts,
      totalMonthlyHC: result.totalMonthlyHC,
      totalDailyHC: result.totalDailyHC,
      estimatedCost: Math.round(totalCost),
      efficiency: result.efficiency,
      costPerAgent: result.totalMonthlyHC > 0 ? Math.round(totalCost / result.totalMonthlyHC) : 0
    };
  }).sort((a, b) => a.estimatedCost - b.estimatedCost);
}

// ===========================================================================
// FERIADOS NACIONAIS BRASILEIROS 2024-2026
// ===========================================================================

export const BRAZILIAN_HOLIDAYS_2024_2026: Record<string, string[]> = {
  '2024': [
    '2024-01-01', '2024-02-12', '2024-02-13', '2024-03-29',
    '2024-04-21', '2024-05-01', '2024-05-30', '2024-09-07',
    '2024-10-12', '2024-11-02', '2024-11-15', '2024-12-25'
  ],
  '2025': [
    '2025-01-01', '2025-03-03', '2025-03-04', '2025-04-18',
    '2025-04-21', '2025-05-01', '2025-06-19', '2025-09-07',
    '2025-10-12', '2025-11-02', '2025-11-15', '2025-12-25'
  ],
  '2026': [
    '2026-01-01', '2026-02-16', '2026-02-17', '2026-04-03',
    '2026-04-21', '2026-05-01', '2026-06-11', '2026-09-07',
    '2026-10-12', '2026-11-02', '2026-11-15', '2026-12-25'
  ]
};

/**
 * Mapa interno de data -> nome do feriado para consulta rápida.
 * Inclui Confraternização, Carnaval, Sexta-feira Santa, Tiradentes,
 * Dia do Trabalho, Corpus Christi, Independência, Nossa Sra. Aparecida,
 * Finados, Proclamação da República e Natal.
 */
const HOLIDAY_NAME_MAP: Record<string, string> = {
  // --- 2024 ---
  '2024-01-01': 'Confraternização Universal',
  '2024-02-12': 'Carnaval',
  '2024-02-13': 'Carnaval',
  '2024-03-29': 'Sexta-feira Santa',
  '2024-04-21': 'Tiradentes',
  '2024-05-01': 'Dia do Trabalho',
  '2024-05-30': 'Corpus Christi',
  '2024-09-07': 'Independência do Brasil',
  '2024-10-12': 'Nossa Sra. Aparecida',
  '2024-11-02': 'Finados',
  '2024-11-15': 'Proclamação da República',
  '2024-12-25': 'Natal',
  // --- 2025 ---
  '2025-01-01': 'Confraternização Universal',
  '2025-03-03': 'Carnaval',
  '2025-03-04': 'Carnaval',
  '2025-04-18': 'Sexta-feira Santa',
  '2025-04-21': 'Tiradentes',
  '2025-05-01': 'Dia do Trabalho',
  '2025-06-19': 'Corpus Christi',
  '2025-09-07': 'Independência do Brasil',
  '2025-10-12': 'Nossa Sra. Aparecida',
  '2025-11-02': 'Finados',
  '2025-11-15': 'Proclamação da República',
  '2025-12-25': 'Natal',
  // --- 2026 ---
  '2026-01-01': 'Confraternização Universal',
  '2026-02-16': 'Carnaval',
  '2026-02-17': 'Carnaval',
  '2026-04-03': 'Sexta-feira Santa',
  '2026-04-21': 'Tiradentes',
  '2026-05-01': 'Dia do Trabalho',
  '2026-06-11': 'Corpus Christi',
  '2026-09-07': 'Independência do Brasil',
  '2026-10-12': 'Nossa Sra. Aparecida',
  '2026-11-02': 'Finados',
  '2026-11-15': 'Proclamação da República',
  '2026-12-25': 'Natal'
};

/**
 * Verifica se uma data é feriado nacional brasileiro.
 * @param dateStr String no formato "YYYY-MM-DD"
 */
export function isBrazilianHoliday(dateStr: string): { isHoliday: boolean; holidayName: string } {
  const name = HOLIDAY_NAME_MAP[dateStr];
  return { isHoliday: !!name, holidayName: name || '' };
}

// ===========================================================================
// CALENDÁRIO DE ROTAÇÃO DE ESCALAS
// ===========================================================================

export interface RotationDay {
  date: string;
  dayOfWeek: number;
  dayName: string;
  isHoliday: boolean;
  isWeekend: boolean;
  shifts: Array<{
    shiftType: ShiftType;
    count: number;
    agents: string[]; // IDs dos agentes alocados neste turno
  }>;
  totalAgents: number;
  coverage: number; // total de agente-minutos de cobertura no dia
  notes: string;
}

export interface RotationCalendar {
  days: RotationDay[];
  summary: {
    totalDays: number;
    workingDays: number;
    weekendDays: number;
    holidays: number;
    totalAgentDays: number;
    avgDailyHC: number;
    peakDayHC: number;
    minDayHC: number;
    shiftDistribution: Record<string, number>;
  };
}

/** Nomes dos dias da semana em português (índice = getDay()) */
const DAY_NAMES_PT: string[] = [
  'Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira',
  'Quinta-feira', 'Sexta-feira', 'Sábado'
];

/**
 * Gera um calendário de rotação mensal para o call center.
 *
 * - Cada agente recebe 1 folga semanal (seg-sex), rotativa por semana.
 * - Sábados operam com 50% do efetivo.
 * - Domingos são folga geral.
 * - Feriados nacionais brasileiros são respeitados.
 *
 * @param year       Ano (ex: 2025)
 * @param month      Mês (1-12)
 * @param totalHC    Número total de agentes
 * @param shiftTypes Tipos de turno habilitados para distribuição
 * @param excludeDates  Datas extras a considerar como folga ("YYYY-MM-DD")
 */
export function generateRotationCalendar(
  year: number,
  month: number,
  totalHC: number,
  shiftTypes: ShiftType[],
  excludeDates: string[] = []
): RotationCalendar {
  const daysInMonth = new Date(year, month, 0).getDate();
  const excludeSet = new Set(excludeDates);
  const shiftDefs = shiftTypes
    .map(t => AVAILABLE_SHIFTS.find(s => s.type === t))
    .filter((s): s is ShiftDefinition => !!s);

  // Ordenar por duração decrescente para distribuição proporcional estável
  shiftDefs.sort((a, b) => b.durationMinutes - a.durationMinutes);

  // Gerar IDs de agentes: A1, A2, ..., A{totalHC}
  const allAgentIds: string[] = Array.from({ length: totalHC }, (_, i) => `A${i + 1}`);

  const days: RotationDay[] = [];
  let totalAgentDays = 0;
  let peakDayHC = 0;
  let minDayHC = Infinity;
  const shiftDistribution: Record<string, number> = {};

  for (let day = 1; day <= daysInMonth; day++) {
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const dateStr = `${year}-${mm}-${dd}`;
    const dateObj = new Date(year, month - 1, day);
    const dayOfWeek = dateObj.getDay(); // 0=Domingo, 6=Sábado
    const dayName = DAY_NAMES_PT[dayOfWeek];
    const _isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const holidayInfo = isBrazilianHoliday(dateStr);
    const isHoliday = holidayInfo.isHoliday || excludeSet.has(dateStr);
    const holidayName = holidayInfo.holidayName || (excludeSet.has(dateStr) ? 'Folga extra' : '');

    // Domingo = folga geral; Feriado = folga geral
    if (dayOfWeek === 0 || isHoliday) {
      const notes = dayOfWeek === 0
        ? 'Domingo - folga geral'
        : `Feriado: ${holidayName}`;
      days.push({
        date: dateStr, dayOfWeek, dayName,
        isHoliday, isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
        shifts: [], totalAgents: 0, coverage: 0, notes
      });
      // Domingos e feriados não entram nas estatísticas de HC mínimo/máximo de trabalho
      continue;
    }

    // Determinar agentes disponíveis
    let availableAgents: string[];

    if (dayOfWeek === 6) {
      // Sábado: 50% do efetivo total
      const saturdayCount = Math.round(totalHC / 2);
      availableAgents = allAgentIds.slice(0, saturdayCount);
    } else {
      // Dia útil (seg-sex): aplicar rotação de folga semanal
      // Semana do mês (0-indexada)
      const weekOfMonth = Math.floor((day - 1) / 7);
      // Índice do dia útil (Seg=0, Ter=1, Qua=2, Qui=3, Sex=4)
      const weekdayIdx = (dayOfWeek + 6) % 7; // getDay(): 1->0, 2->1, ..., 6->5

      // Agente A_i está de folga se (i + semana) % 5 === weekdayIdx
      availableAgents = allAgentIds.filter((_, i) => (i + weekOfMonth) % 5 !== weekdayIdx);
    }

    const totalAgentsToday = availableAgents.length;
    totalAgentDays += totalAgentsToday;

    // Distribuir agentes proporcionalmente à duração dos turnos
    const totalDurationWeight = shiftDefs.reduce((sum, s) => sum + s.durationMinutes, 0);
    const shiftAssignments: RotationDay['shifts'] = [];
    let agentsUsed = 0;

    for (let si = 0; si < shiftDefs.length; si++) {
      const isLast = si === shiftDefs.length - 1;
      let count: number;

      if (isLast) {
        // Último turno recebe os agentes restantes
        count = totalAgentsToday - agentsUsed;
      } else {
        const proportion = shiftDefs[si].durationMinutes / totalDurationWeight;
        count = Math.round(totalAgentsToday * proportion);
        // Limitar para não ultrapassar o disponível
        count = Math.min(count, totalAgentsToday - agentsUsed);
      }

      if (count > 0) {
        const agents = availableAgents.slice(agentsUsed, agentsUsed + count);
        shiftAssignments.push({
          shiftType: shiftDefs[si].type,
          count,
          agents
        });
        shiftDistribution[shiftDefs[si].type] = (shiftDistribution[shiftDefs[si].type] || 0) + count;
        agentsUsed += count;
      }
    }

    // Calcular cobertura em agente-minutos
    const coverage = shiftAssignments.reduce(
      (sum, sa) => {
        const def = shiftDefs.find(s => s.type === sa.shiftType);
        return sum + sa.count * (def ? def.durationMinutes : 0);
      }, 0
    );

    // Notas do dia
    let notes = '';
    if (dayOfWeek === 6) {
      notes = 'Sábado - 50% do efetivo';
    } else {
      notes = `${totalAgentsToday} agentes (com folga rotativa)`;
    }

    if (totalAgentsToday > peakDayHC) peakDayHC = totalAgentsToday;
    if (totalAgentsToday < minDayHC) minDayHC = totalAgentsToday;

    days.push({
      date: dateStr,
      dayOfWeek,
      dayName,
      isHoliday: false,
      isWeekend: dayOfWeek === 6,
      shifts: shiftAssignments,
      totalAgents: totalAgentsToday,
      coverage,
      notes
    });
  }

  // Estatísticas apenas dos dias trabalhados
  const workingDaysList = days.filter(d => !d.isHoliday && d.dayOfWeek !== 0);
  const weekendDays = days.filter(d => d.isWeekend && !d.isHoliday);
  const holidays = days.filter(d => d.isHoliday);
  const workingDays = workingDaysList.length;
  const avgDailyHC = workingDays > 0
    ? Math.round((workingDaysList.reduce((s, d) => s + d.totalAgents, 0) / workingDays) * 100) / 100
    : 0;

  // Se não houver dias úteis, minDayHC deve ser 0
  if (minDayHC === Infinity) minDayHC = 0;

  return {
    days,
    summary: {
      totalDays: daysInMonth,
      workingDays,
      weekendDays: weekendDays.length,
      holidays: holidays.length,
      totalAgentDays,
      avgDailyHC,
      peakDayHC,
      minDayHC,
      shiftDistribution
    }
  };
}

// ===========================================================================
// EFICIÊNCIA POR TIPO DE TURNO
// ===========================================================================

export interface ShiftEfficiencyMetric {
  shiftType: ShiftType;
  totalAgents: number;
  totalIntervals: number;
  usefulIntervals: number;    // intervalos onde agentes foram realmente necessários
  wastedIntervals: number;    // intervalos onde agentes ficaram ociosos
  efficiency: number;         // useful / total
  costPerUsefulMinute: number;
  costPerTotalMinute: number;
  recommendation: string;
}

/**
 * Analisa a eficiência de cada tipo de turno com base no resultado de calculateShifts.
 *
 * Compara a cobertura de cada turno contra a demanda real (requiredAgentsPerInterval).
 * Um intervalo é "útil" quando a demanda original é > 0.
 *
 * @param shiftResult            Resultado retornado por calculateShifts
 * @param requiredAgentsPerInterval  Demanda original por intervalo (agente-Erlang)
 * @param costPerAgentMonth      Custo mensal por agente (padrão R$ 5.000)
 */
export function calculateShiftEfficiency(
  shiftResult: ShiftScheduleResult,
  requiredAgentsPerInterval: number[],
  costPerAgentMonth: number = 5000
): ShiftEfficiencyMetric[] {
  const { schedules, activePerInterval } = shiftResult;
  const numIntervals = requiredAgentsPerInterval.length;

  // Agrupar por tipo de turno
  const byType = new Map<ShiftType, ScheduledShift[]>();
  for (const sched of schedules) {
    if (!byType.has(sched.shift.type)) {
      byType.set(sched.shift.type, []);
    }
    byType.get(sched.shift.type)!.push(sched);
  }

  const metrics: ShiftEfficiencyMetric[] = [];

  for (const [shiftType, entries] of byType) {
    const shiftDef = AVAILABLE_SHIFTS.find(s => s.type === shiftType);
    const daysOffFactor = shiftDef ? shiftDef.daysOffFactor : 7 / 6;

    // HC diário total deste tipo
    const totalAgents = entries.reduce((sum, e) => sum + e.count, 0);
    // HC mensal estimado
    const monthlyHC = Math.ceil(totalAgents * daysOffFactor);
    const monthlyCost = monthlyHC * costPerAgentMonth;

    let totalIntervals = 0;
    let usefulIntervals = 0;

    for (let i = 0; i < numIntervals; i++) {
      const agentsAtInterval = (activePerInterval[i] && activePerInterval[i][shiftType]) || 0;
      if (agentsAtInterval === 0) continue;

      totalIntervals += agentsAtInterval;
      if (requiredAgentsPerInterval[i] > 0) {
        usefulIntervals += agentsAtInterval;
      }
    }

    const wastedIntervals = totalIntervals - usefulIntervals;
    const efficiency = totalIntervals > 0 ? usefulIntervals / totalIntervals : 0;

    const usefulMinutes = usefulIntervals * 10; // cada intervalo = 10 minutos
    const totalMinutes = totalIntervals * 10;
    const costPerUsefulMinute = usefulMinutes > 0 ? Math.round((monthlyCost / usefulMinutes) * 100) / 100 : 0;
    const costPerTotalMinute = totalMinutes > 0 ? Math.round((monthlyCost / totalMinutes) * 100) / 100 : 0;

    // Gerar recomendação em português
    let recommendation: string;
    if (efficiency >= 0.9) {
      recommendation = 'Excelente eficiência. Manter este turno na escala.';
    } else if (efficiency >= 0.75) {
      recommendation = 'Boa eficiência. Turno bem aproveitado na cobertura.';
    } else if (efficiency >= 0.5) {
      recommendation = 'Eficiência moderada. Considerar ajustar horário de início para reduzir ociosidade.';
    } else if (efficiency >= 0.3) {
      recommendation = 'Eficiência baixa. Avaliar necessidade deste turno ou redimensionar quantidade.';
    } else {
      recommendation = 'Eficiência crítica. Recomendar remover este turno da escala ou realocar agentes.';
    }

    metrics.push({
      shiftType,
      totalAgents,
      totalIntervals,
      usefulIntervals,
      wastedIntervals,
      efficiency: Math.round(efficiency * 1000) / 1000,
      costPerUsefulMinute,
      costPerTotalMinute,
      recommendation
    });
  }

  // Ordenar por eficiência decrescente
  metrics.sort((a, b) => b.efficiency - a.efficiency);

  return metrics;
}

// ===========================================================================
// OTIMIZAÇÃO AUTOMÁTICA DE MIX DE TURNOS
// ===========================================================================

export interface OptimizationResult {
  bestCombination: ShiftType[];
  totalMonthlyHC: number;
  estimatedCost: number;
  efficiency: number;
  overstaffedPercent: number;
  understaffedPercent: number;
  allResults: Array<{
    combination: ShiftType[];
    monthlyHC: number;
    cost: number;
    efficiency: number;
  }>;
}

/**
 * Gera todas as combinações possíveis de k elementos a partir de um array.
 * @param arr  Array de entrada
 * @param k    Tamanho de cada combinação
 */
function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map(c => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

/**
 * Testa todas as combinações razoáveis de turnos (1 a 3 tipos por combinação)
 * e retorna a mais custo-eficiente.
 *
 * O critério principal de ordenação é custo mensal estimado (menor = melhor).
 * Em caso de empate, desempata por maior eficiência.
 *
 * @param requiredAgentsPerInterval  Demanda por intervalo (agente-Erlang)
 * @param intervalLabels            Rótulos dos intervalos (ex: ["06:00", "06:10", ...])
 * @param costPerAgentMonth         Custo mensal por agente (padrão R$ 5.000)
 * @param overheadPercent           Percentual de encargos sobre o salário (padrão 30%)
 * @param operatingDays             Dias de operação por semana (padrão 7)
 * @param maxShiftsPerCombo         Máximo de turnos por combinação (padrão 3)
 */
export function optimizeShiftMix(
  requiredAgentsPerInterval: number[],
  intervalLabels: string[],
  costPerAgentMonth: number = 5000,
  overheadPercent: number = 30,
  operatingDays: number = 7,
  maxShiftsPerCombo: number = 3
): OptimizationResult {
  const allShiftTypes = AVAILABLE_SHIFTS.map(s => s.type);

  // Gerar combinações de 1 a maxShiftsPerCombo turnos
  const combos: ShiftType[][] = [];
  for (let k = 1; k <= maxShiftsPerCombo; k++) {
    combos.push(...combinations(allShiftTypes, k));
  }

  const totalIntervalsWithNeed = requiredAgentsPerInterval.filter(r => r > 0).length;

  const allResults: OptimizationResult['allResults'] = [];

  for (const combo of combos) {
    const result = calculateShifts(requiredAgentsPerInterval, intervalLabels, combo, operatingDays);
    const monthlyCost = Math.round(result.totalMonthlyHC * costPerAgentMonth * (1 + overheadPercent / 100));

    allResults.push({
      combination: combo,
      monthlyHC: result.totalMonthlyHC,
      cost: monthlyCost,
      efficiency: result.efficiency
    });
  }

  // Ordenar por custo (menor primeiro), desempatando por eficiência (maior primeiro)
  allResults.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost;
    return b.efficiency - a.efficiency;
  });

  if (allResults.length === 0) {
    return {
      bestCombination: [],
      totalMonthlyHC: 0,
      estimatedCost: 0,
      efficiency: 0,
      overstaffedPercent: 0,
      understaffedPercent: 0,
      allResults: []
    };
  }

  // Recalcular o melhor para obter métricas detalhadas de sobre/subdimensionamento
  const best = allResults[0];
  const bestResult = calculateShifts(
    requiredAgentsPerInterval,
    intervalLabels,
    best.combination,
    operatingDays
  );

  const overstaffedPercent = totalIntervalsWithNeed > 0
    ? Math.round((bestResult.overstaffedIntervals / totalIntervalsWithNeed) * 10000) / 100
    : 0;
  const understaffedPercent = totalIntervalsWithNeed > 0
    ? Math.round((bestResult.understaffedIntervals / totalIntervalsWithNeed) * 10000) / 100
    : 0;

  return {
    bestCombination: best.combination,
    totalMonthlyHC: best.monthlyHC,
    estimatedCost: best.cost,
    efficiency: bestResult.efficiency,
    overstaffedPercent,
    understaffedPercent,
    allResults
  };
}
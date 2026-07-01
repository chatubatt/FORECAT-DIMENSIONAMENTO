import { useState, useRef, useMemo, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, BarChart, Bar, ComposedChart, Area } from 'recharts';
import { UploadCloud, Activity, Clock, CalendarDays, TrendingUp, Users } from 'lucide-react';
import { evaluateErlangConfig, type SlaStrategy, type OperatingHoursConfig, type ErlangResult, calculateCostEstimate, calculateSLASensitivity, type SensitivityResult, estimateAbandonRate, calcErlangB, calculateShrinkageBreakdown, type ShrinkageResult, calculateScenarioImpact, type ScenarioResult, generateOccupancyAnalysis, type OccupancyAnalysis, calculateErlangA, type ErlangAResult, exportToCSV, exportToJSON } from './utils/erlang';
import { calculateShifts, type ShiftType, AVAILABLE_SHIFTS, allocateShifts612_812, type ShiftAllocationResult, compareShiftCombinations, type ShiftCombinationCost, generateRotationCalendar, type RotationCalendar, calculateShiftEfficiency, type ShiftEfficiencyMetric, optimizeShiftMix, type OptimizationResult, isBrazilianHoliday } from './utils/shifts';

interface IntervalForecast {
  intervalo: string;
  volume: number;
  tmo?: number;
}

interface DailyForecast {
  data: string;
  volume_total: number;
  tmo_medio: number;
  intervalos: IntervalForecast[];
}

interface HistoricoVolume {
  ano_mes: string;
  volume: number;
}

interface ForecastComparisons {
  volume_projetado: number;
  dmm_vol: number;
  dmm_data: string;
  dmm_baseline_vol?: number;
  hmm_vol: number;
  hmm_hora: string;
  hmm_data: string;
  anos_anteriores: HistoricoVolume[];
  ultimos_3_meses: HistoricoVolume[];
  feriados_mes?: string[];
  dias_excluidos?: string[];
}

interface CalendarioStat {
  ano: number; mes: number; seg: number; ter: number; qua: number; qui: number; sex: number; sab: number; dom: number; dias: number; du: number; feriados: number;
}
interface HistoricoAnualStat {
  ano: number;
  mes_1: number; mes_2: number; mes_3: number; mes_4: number; mes_5: number; mes_6: number;
  mes_7: number; mes_8: number; mes_9: number; mes_10: number; mes_11: number; mes_12: number;
  total: number;
  is_proj_1?: boolean; is_proj_2?: boolean; is_proj_3?: boolean; is_proj_4?: boolean;
  is_proj_5?: boolean; is_proj_6?: boolean; is_proj_7?: boolean; is_proj_8?: boolean;
  is_proj_9?: boolean; is_proj_10?: boolean; is_proj_11?: boolean; is_proj_12?: boolean;
}
interface VariacaoAnualStat {
  ano: number; mes_1: number; mes_2: number; mes_3: number; mes_4: number; mes_5: number; mes_6: number; mes_7: number; mes_8: number; mes_9: number; mes_10: number; mes_11: number; mes_12: number;
}
interface BaselineMesStat {
  ano_mes: string; ano: string; mes: string; seg: number; ter: number; qua: number; qui: number; sex: number; sab: number; dom: number; total: number;
}


interface OptimizedMonthErlangItem extends ErlangResult {
  data: string;
  intervalo: string;
  volume: number;
  tmo: number;
  coverage: string;
  isClosed?: boolean;
}

interface ModeloTestado {
  modelo: string;
  erro_mae: number;
  acuracidade?: number;
}

interface Metodologia {
  algoritmo_volume: string;
  modelos_testados: ModeloTestado[];
  sazonalidade_explicacao: string;
  flutuacao_explicacao: string;
  algoritmo_tmo: string;
  features: string[];
  importancia_features: Record<string, number>;
  outlier_metodo: string;
  outliers_removidos: number;
  dias_treinamento: number;
  periodo_historico: string;
  curva_diaria_fonte: string;
  tmo_fonte: string;
}

interface SavedScenario {
  id: string;
  name: string;
  date: string;
  year: number;
  month: number;
  flutuacao: number;
  incremento: number;
  volume: number;
  tmo: number;
  diasTreinamento: number;
  anosSelecionados: number[];
}

export interface SavedStaffingScenario {
  id: string;
  name: string;
  date: string;
  targetDate: string;
  strategy: SlaStrategy;
  totalDailyHC: number;
  totalMonthlyHC: number;
  peakPAs: number;
  avgPAs: number;
  finalSla: number;
  shiftsUsed: ShiftType[];
}

interface HistoryStats {
  max_volume_day: { data: string; volume: number };
  monthly_history: { ano_mes: string; volume: number }[];
  visao_quinzena: { quinzena: string; volume: number; percentual: number }[];
  ranking_dias: { data_str: string; dia_semana_str: string; volume: number; percentual: number }[];
  visao_semana: { semana: number; seg: number; ter: number; qua: number; qui: number; sex: number; sab: number; dom: number; total: number }[];
  comparativo_curvas: { dia: number; m_geo: number; quartil: number; desvio_p: number }[];
  calendario: CalendarioStat[];
  historico_anual: HistoricoAnualStat[];
  variacao_anual: VariacaoAnualStat[];
  baseline_meses: BaselineMesStat[];
  metodologia?: Metodologia;
  curvas_distribuicao?: Record<string, Record<string, number>>;
  matrizes_intervalo?: Record<string, Record<string, Record<string, number>>>;
  matrizes_tmo?: Record<string, Record<string, Record<string, number>>>;
  wfm_metrics?: any;
}

const computeMGeo = (vals: number[]) => {
  if (vals.length === 0) return 0;
  const prod = vals.reduce((acc, v) => acc * (v > 0 ? v : 1), 1);
  return Math.round(Math.pow(prod, 1 / vals.length));
};

const computePond = (vals: number[]) => {
  if (vals.length === 0) return 0;
  const weights = vals.map((_, i) => i + 1);
  const sumWeights = weights.reduce((a, b) => a + b, 0);
  return Math.round(vals.reduce((acc, v, i) => acc + (v * weights[i]), 0) / sumWeights);
};

const computeMean = (vals: number[]) => {
  if (vals.length === 0) return 0;
  return Math.round(vals.reduce((acc, v) => acc + v, 0) / vals.length);
};

const getWorkdays = (year: number, month: number) => {
  let count = 0;
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(year, month - 1, d).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
};

export const defaultShrinkage = { abs: 0, nr17: 8.63, treinamento: 0, turnover: 0, outros: 0 };

const rawApiUrl = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000';
const API_URL = rawApiUrl.replace(/\/+$/, '');

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

export default function Dashboard() {
  const [forecastData, setForecastData] = useState<DailyForecast[]>([]);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'forecast' | 'calendario' | 'historico' | 'baseline' | 'previsao_mensal' | 'dimensionamento' | 'metodologia' | 'cenarios' | 'shrinkage' | 'whatif' | 'rotacao'>('forecast');
  const [selectedMonths, setSelectedMonths] = useState<string[]>([]);
  const [flutuacao, setFlutuacao] = useState<number>(0);
  const [incremento, setIncremento] = useState<number>(0);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [monthForecastData, setMonthForecastData] = useState<DailyForecast[]>([]);
  const [monthComparisons, setMonthComparisons] = useState<ForecastComparisons | null>(null);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1);
  const [selectedWeekday, setSelectedWeekday] = useState<string>('all');
  const [selectedMonthDay, setSelectedMonthDay] = useState<string | null>(null);
  const [selectedTrainDays, setSelectedTrainDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [rationaleBase, setRationaleBase] = useState<'anos_anteriores' | 'ultimos_3_meses'>('anos_anteriores');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  const [selectedTrainYears, setSelectedTrainYears] = useState<number[]>([]);
  const [selectedVisaoSemanaMonth, setSelectedVisaoSemanaMonth] = useState<string>('all');

  const [availableCelulas, setAvailableCelulas] = useState<string[]>(['Todas']);
  const [selectedCelula, setSelectedCelula] = useState<string>('Todas');

  const [dimTargetSlaPercent, setDimTargetSlaPercent] = useState<number>(80);
  const [dimCurveType, setDimCurveType] = useState<string>('padrao');
  const [dimTargetDmmSlaPercent, setDimTargetDmmSlaPercent] = useState<number>(30); // Target for DMM
  const [dimDmmRank, setDimDmmRank] = useState<number>(1); // Qual DMM usar como base (1 a 5)
  const [dimTargetSlaTime, setDimTargetSlaTime] = useState<number>(20);

  const [dimShrinkageConfig, setDimShrinkageConfig] = useState<Record<string, typeof defaultShrinkage>>(() => {
    const initial: Record<string, typeof defaultShrinkage> = {};
    AVAILABLE_SHIFTS.forEach(s => {
      initial[s.type] = { ...defaultShrinkage };
    });
    return initial;
  });


  const [dimFixedAgents, setDimFixedAgents] = useState<number | ''>('');
  const [dimTma, setDimTma] = useState<number | ''>('');
  const [dimFixedVolume, setDimFixedVolume] = useState<number | ''>('');
  const [dimSelectedDay, setDimSelectedDay] = useState<string>(''); // Data selecionada para o dimensionamento
  const [dimShowConsolidated, setDimShowConsolidated] = useState<boolean>(true);

  const [dimStrategy, setDimStrategy] = useState<SlaStrategy>('monthly_avg');
  const [dimOpHours, setDimOpHours] = useState<OperatingHoursConfig>({
    weekdays: { start: '08:00', end: '20:00', closed: false },
    saturdays: { start: '09:00', end: '15:00', closed: false },
    sundays: { start: '00:00', end: '23:59', closed: true }
  });

  const [dimEnabledShifts, setDimEnabledShifts] = useState<ShiftType[]>(['06:20', '07:12']);

  // Calcula a média do shrinkage total para os turnos habilitados (usado na estimativa inicial)
  const dimShrinkage = useMemo(() => {
    if (dimEnabledShifts.length === 0) return Object.values(defaultShrinkage).reduce((sum, val) => sum + val, 0);
    let total = 0;
    dimEnabledShifts.forEach(shiftType => {
      const conf = dimShrinkageConfig[shiftType] || defaultShrinkage;
      total += Object.values(conf).reduce((sum, val) => sum + val, 0);
    });
    return total / dimEnabledShifts.length;
  }, [dimShrinkageConfig, dimEnabledShifts]);
  const [staffingScenarios, setStaffingScenarios] = useState<SavedStaffingScenario[]>([]);
  const [dimSubTab, setDimSubTab] = useState<'escala' | 'alocacao_automatica'>('escala');

  // Cost Configuration States
  const [costPerAgent, setCostPerAgent] = useState<number>(5000);
  const [overheadPercent, setOverheadPercent] = useState<number>(30);
  const [patienceTime, setPatienceTime] = useState<number>(60);
  const [showSensitivity, setShowSensitivity] = useState<boolean>(false);

  // Matrix View States
  const [matrixPeriod, setMatrixPeriod] = useState<string>('completo');
  const [matrixViewType, setMatrixViewType] = useState<'volume' | 'peso' | 'tmo'>('volume');
  
  // Chart View States
  const [chartPeriods, setChartPeriods] = useState<string[]>(['completo']);
  const [chartMetric, setChartMetric] = useState<'volume' | 'peso' | 'tmo'>('peso');
  const [chartDayView, setChartDayView] = useState<string>('consolidado');

  // Optimization States
  const [isOptModalOpen, setIsOptModalOpen] = useState<boolean>(false);
  const [optResults, setOptResults] = useState<any[]>([]);

  // Cenários
  const [scenarios, setScenarios] = useState<SavedScenario[]>([]);
  const [scenarioName, setScenarioName] = useState('');
  const [showSavePrompt, setShowSavePrompt] = useState(false);

  // Shrinkage Tab States
  const [shrinkBaseAgents, setShrinkBaseAgents] = useState<number>(100);
  const [shrinkVacation, setShrinkVacation] = useState<number>(8.0);
  const [shrinkSickLeave, setShrinkSickLeave] = useState<number>(3.0);
  const [shrinkTraining, setShrinkTraining] = useState<number>(2.0);
  const [shrinkBreaks, setShrinkBreaks] = useState<number>(5.0);
  const [shrinkMeetings, setShrinkMeetings] = useState<number>(1.5);
  const [shrinkAbsenteeism, setShrinkAbsenteeism] = useState<number>(2.0);
  const [shrinkOther, setShrinkOther] = useState<number>(0.0);

  // What-If Tab States
  const [whatifBaseVolume, setWhatifBaseVolume] = useState<number>(10000);
  const [whatifTmo, setWhatifTmo] = useState<number>(240);
  const [whatifIntervalSec, setWhatifIntervalSec] = useState<number>(600);
  const [whatifTargetSla, setWhatifTargetSla] = useState<number>(80);
  const [whatifSlaTime, setWhatifSlaTime] = useState<number>(20);
  const [whatifShrinkage, setWhatifShrinkage] = useState<number>(18.47);
  const [whatifResults, setWhatifResults] = useState<ScenarioResult[]>([]);

  // Rotation Tab States
  const [rotYear, setRotYear] = useState<number>(new Date().getFullYear());
  const [rotMonth, setRotMonth] = useState<number>(new Date().getMonth() + 1);
  const [rotHC, setRotHC] = useState<number>(50);
  const [rotShiftTypes, setRotShiftTypes] = useState<ShiftType[]>(['06:20', '08:12']);
  const [rotCalendar, setRotCalendar] = useState<RotationCalendar | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('forecast_scenarios');
    if (saved) {
      try {
        setScenarios(JSON.parse(saved));
      } catch (e) {
        console.error("Erro ao ler cenários do localStorage", e);
      }
    }
    const savedStaffing = localStorage.getItem('staffing_scenarios');
    if (savedStaffing) {
      try {
        setStaffingScenarios(JSON.parse(savedStaffing));
      } catch (e) {
        console.error("Erro ao ler cenários de staffing do localStorage", e);
      }
    }
  }, []);

  useEffect(() => {
    if (dimEnabledShifts.length === 0) return;

    // Map de minutos de pausa NR17 por turno
    const nr17Pauses: Record<string, number> = {
      '06:20': 40,
      '07:12': 60,
      '08:12': 80,
      '08:48': 80,
      '06:00': 40,
      '04:00': 20,
      '05:15': 30,
      '09:00': 90,
      '12x36': 120
    };

    setDimShrinkageConfig(prev => {
      const next = { ...prev };
      dimEnabledShifts.forEach(shiftType => {
        const shiftDef = AVAILABLE_SHIFTS.find(s => s.type === shiftType);
        const pauseMin = nr17Pauses[shiftType] || 40;
        if (shiftDef && shiftDef.durationMinutes > 0) {
          const nr17Perc = Number(((pauseMin / shiftDef.durationMinutes) * 100).toFixed(2));
          next[shiftType] = { ...(next[shiftType] || defaultShrinkage), nr17: nr17Perc };
        }
      });
      return next;
    });
  }, [dimEnabledShifts]);

  const saveScenario = () => {
    if (!scenarioName.trim() || !monthComparisons) return;

    const newScenario: SavedScenario = {
      id: Date.now().toString(),
      name: scenarioName.trim(),
      date: new Date().toLocaleString('pt-BR'),
      year: selectedYear,
      month: selectedMonth,
      flutuacao: flutuacao,
      incremento: incremento,
      volume: monthComparisons.volume_projetado,
      tmo: stats?.metodologia?.dias_treinamento || 0, // Fallback if tmo logic is missing
      diasTreinamento: stats?.metodologia?.dias_treinamento || 0,
      anosSelecionados: selectedTrainYears
    };

    // Atualizar stats com tmo correto se existir no array mensal (opcional)
    const avgTmo = monthForecastData.length > 0 ? computeMean(monthForecastData.map(d => d.tmo_medio)) : 0;
    newScenario.tmo = avgTmo;

    const updated = [...scenarios, newScenario];
    setScenarios(updated);
    localStorage.setItem('forecast_scenarios', JSON.stringify(updated));
    setShowSavePrompt(false);
    setScenarioName('');
    alert("Cenário salvo com sucesso!");
  };

  const deleteScenario = (id: string) => {
    if (!confirm("Tem certeza que deseja excluir este cenário?")) return;
    const updated = scenarios.filter(s => s.id !== id);
    setScenarios(updated);
    localStorage.setItem('forecast_scenarios', JSON.stringify(updated));
  };

  const loadScenario = (scenario: SavedScenario) => {
    setSelectedYear(scenario.year);
    setSelectedMonth(scenario.month);
    setFlutuacao(scenario.flutuacao);
    setIncremento(scenario.incremento);
    // Aqui avisamos o usuário para reprocessar
    alert(`Cenário "${scenario.name}" carregado!\nParâmetros aplicados: Ano ${scenario.year}, Mês ${scenario.month}, Flutuação ${scenario.flutuacao}%, Incremento ${scenario.incremento}%.\n\nPor favor, recarregue os dados clicando em 'Calcular Previsão Mensal' para ver a curva completa.`);
    setActiveTab('previsao_mensal');
  };

  const generateAutoScenarios = () => {
    if (!monthComparisons) {
      alert("Por favor, gere uma previsão mensal primeiro antes de sugerir cenários.");
      return;
    }

    const baseId = Date.now();
    const avgTmo = monthForecastData.length > 0 ? computeMean(monthForecastData.map(d => d.tmo_medio)) : 0;
    const baseVolume = monthComparisons.volume_projetado;

    // Calcula volumes simulados apenas para referência visual se necessário
    const estresseVol = Math.round(baseVolume * 1.15);
    const otimistaVol = Math.round(baseVolume * 0.90);

    const autoScenarios: SavedScenario[] = [
      {
        id: (baseId + 1).toString(),
        name: "Cenário Otimista (Queda Volume)",
        date: new Date().toLocaleString('pt-BR'),
        year: selectedYear,
        month: selectedMonth,
        flutuacao: -10,
        incremento: -10,
        volume: otimistaVol,
        tmo: avgTmo,
        diasTreinamento: stats?.metodologia?.dias_treinamento || 0,
        anosSelecionados: selectedTrainYears
      },
      {
        id: (baseId + 2).toString(),
        name: "Cenário Base (Padrão IA)",
        date: new Date().toLocaleString('pt-BR'),
        year: selectedYear,
        month: selectedMonth,
        flutuacao: 0,
        incremento: 0,
        volume: baseVolume,
        tmo: avgTmo,
        diasTreinamento: stats?.metodologia?.dias_treinamento || 0,
        anosSelecionados: selectedTrainYears
      },
      {
        id: (baseId + 3).toString(),
        name: "Cenário de Estresse (Pico)",
        date: new Date().toLocaleString('pt-BR'),
        year: selectedYear,
        month: selectedMonth,
        flutuacao: 20,
        incremento: 15,
        volume: estresseVol,
        tmo: avgTmo,
        diasTreinamento: stats?.metodologia?.dias_treinamento || 0,
        anosSelecionados: selectedTrainYears
      }
    ];

    const updated = [...scenarios, ...autoScenarios];
    setScenarios(updated);
    localStorage.setItem('forecast_scenarios', JSON.stringify(updated));
    alert("3 Cenários sugeridos (Otimista, Base, Estresse) foram gerados e salvos com sucesso!");
  };

  const loadStaffingScenario = (scenario: SavedStaffingScenario) => {
    setDimSelectedDay(scenario.targetDate);
    setDimStrategy(scenario.strategy);
    setDimEnabledShifts(scenario.shiftsUsed);
    setActiveTab('dimensionamento');
  };

  const deleteStaffingScenario = (id: string) => {
    const updated = staffingScenarios.filter(s => s.id !== id);
    setStaffingScenarios(updated);
    localStorage.setItem('staffing_scenarios', JSON.stringify(updated));
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadStatus("Extraindo anos disponíveis no histórico...");
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${API_URL}/parse-years`, {
        method: 'POST',
        body: formData,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Erro ao ler anos do CSV");

      const yearsArray = result.anos || [];
      setAvailableYears(yearsArray);
      setSelectedTrainYears(yearsArray);
      setStagedFile(file);
      setUploadStatus("Arquivo selecionado. Por favor, escolha os parâmetros e clique em Treinar.");
    } catch (error) {
      console.error(error);
      setUploadStatus(`Erro ao processar arquivo: ${error instanceof Error ? error.message : "Erro desconhecido"}`);
    }
  };

  const confirmUpload = async () => {
    if (!stagedFile) return;

    setLoading(true);
    setUploadStatus("Processando arquivo e treinando modelo...");

    const formData = new FormData();
    formData.append('file', stagedFile);
    formData.append('dias_semana', selectedTrainDays.join(','));
    formData.append('anos_selecionados', selectedTrainYears.join(','));

    try {
      const response = await fetch(`${API_URL}/upload-history`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error("Erro no upload");

      const result = await response.json();
      const detalhes = result.detalhes || {};
      const outlierMsg = detalhes.outliers_removidos > 0
        ? ` ⚠️ ${detalhes.outliers_removidos} dia(s) outlier removido(s) por IQR (${detalhes.dias_treinamento} dias usados no treino).`
        : ` ✅ Nenhum outlier detectado (${detalhes.dias_treinamento} dias usados no treino).`;

      if (detalhes.celulas && detalhes.celulas.length > 0) {
        setAvailableCelulas(detalhes.celulas);
        setSelectedCelula("Todas"); // Reset ao fazer upload
      }

      setUploadStatus(`Modelo treinado com sucesso!${outlierMsg} Gerando forecast...`);
      setStagedFile(null); // Limpa o arquivo após sucesso
      await loadForecast();

    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const resetDashboard = () => {
    setForecastData([]);
    setStats(null);
    setStagedFile(null);
    setAvailableYears([]);
    setSelectedTrainYears([]);
    setUploadStatus(null);
    setMonthForecastData([]);
    setMonthComparisons(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const loadForecast = async () => {
    try {
      const response = await fetch(`${API_URL}/forecast?dias=7&celula=${encodeURIComponent(selectedCelula)}`);
      const data = await response.json();
      if (data.forecast_diario) {
        setForecastData(data.forecast_diario);
      }

      const statsRes = await fetch(`${API_URL}/stats?celula=${encodeURIComponent(selectedCelula)}`);
      const statsData = await statsRes.json();
      if (statsData.stats) {
        setStats(statsData.stats);
        if (statsData.stats.baseline_meses) {
          const defaultMonths = statsData.stats.baseline_meses.slice(-3).map((b: BaselineMesStat) => b.ano_mes);
          setSelectedMonths(defaultMonths);
        }
      }
      setUploadStatus(null);
    } catch (error) {
      console.error("Erro ao carregar forecast:", error);
    }
  };

  useEffect(() => {
    if (availableCelulas.length > 0) {
      loadForecast();
      if (activeTab === 'previsao_mensal' || activeTab === 'dimensionamento') {
        loadMonthForecast();
      }
    }
  }, [selectedCelula]);

  const loadMonthForecast = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/forecast-month?year=${selectedYear}&month=${selectedMonth}&celula=${encodeURIComponent(selectedCelula)}`);
      const data = await response.json();
      if (data.forecast_mensal) {
        if (Array.isArray(data.forecast_mensal)) {
          setMonthForecastData(data.forecast_mensal);
          setMonthComparisons(null);
          if (data.forecast_mensal.length > 0) setSelectedMonthDay(data.forecast_mensal[0].data);
        } else {
          setMonthForecastData(data.forecast_mensal.dias || []);
          setMonthComparisons(data.forecast_mensal.comparacoes || null);
          if (data.forecast_mensal.dias?.length > 0) setSelectedMonthDay(data.forecast_mensal.dias[0].data);
        }
      }
    } catch (error) {
      console.error("Erro ao carregar forecast mensal:", error);
    } finally {
      setLoading(false);
    }
  };

  const filteredMonthForecastData = activeTab === 'previsao_mensal' ? (
    selectedWeekday === 'all'
      ? monthForecastData
      : monthForecastData.filter(d => {
        const dateObj = new Date(d.data + "T00:00:00");
        return dateObj.getDay() === parseInt(selectedWeekday);
      })
  ) : [];

  const aggregatedCurve = useMemo(() => {
    if (filteredMonthForecastData.length === 0) return [];

    const intervalMap: Record<string, number> = {};
    const tmoMap: Record<string, { sum: number; count: number }> = {};

    filteredMonthForecastData.forEach(dayData => {
      if (dayData.intervalos) {
        dayData.intervalos.forEach(interval => {
          if (!intervalMap[interval.intervalo]) intervalMap[interval.intervalo] = 0;
          intervalMap[interval.intervalo] += interval.volume;

          if (interval.tmo != null) {
            if (!tmoMap[interval.intervalo]) tmoMap[interval.intervalo] = { sum: 0, count: 0 };
            tmoMap[interval.intervalo].sum += interval.tmo;
            tmoMap[interval.intervalo].count += 1;
          }
        });
      }
    });

    const numDays = filteredMonthForecastData.length;
    let totalVolSum = 0;
    Object.values(intervalMap).forEach(v => totalVolSum += v);

    const curve = Object.keys(intervalMap).map(intervalo => {
      const avgVol = Math.round(intervalMap[intervalo] / numDays);
      const peso = totalVolSum > 0 ? Number(((intervalMap[intervalo] / totalVolSum) * 100).toFixed(2)) : 0;
      return {
        intervalo,
        volume: avgVol,
        volume_soma: intervalMap[intervalo],
        peso,
        tmo: tmoMap[intervalo] ? Math.round(tmoMap[intervalo].sum / tmoMap[intervalo].count) : undefined,
      };
    });

    curve.sort((a, b) => a.intervalo.localeCompare(b.intervalo));
    return curve;
  }, [filteredMonthForecastData]);

  const downloadAggregatedCurveCSV = () => {
    if (aggregatedCurve.length === 0) return;
    const header = "Intervalo;Volume_Medio_Diario;Volume_Soma_Mes\n";
    const csvContent = aggregatedCurve.map(row => `${row.intervalo};${row.volume};${row.volume_soma}`).join("\n");
    const blob = new Blob([header + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `Curva_Pronta_${selectedMonth}_${selectedYear}_filtro_${selectedWeekday}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const selectedMonthDayData = monthForecastData.find(d => d.data === selectedMonthDay) || null;
  const selectedMonthDayDataWithPeso = useMemo(() => {
    if (!selectedMonthDayData || !selectedMonthDayData.intervalos) return [];
    const totalVol = selectedMonthDayData.intervalos.reduce((acc, curr) => acc + curr.volume, 0);
    return selectedMonthDayData.intervalos.map(interval => ({
      ...interval,
      peso: totalVol > 0 ? Number(((interval.volume / totalVol) * 100).toFixed(2)) : 0
    }));
  }, [selectedMonthDayData]);

  const currentDayForecast = forecastData[0];
  const currentDayForecastWithPeso = useMemo(() => {
    if (!currentDayForecast || !currentDayForecast.intervalos) return [];
    const totalVol = currentDayForecast.intervalos.reduce((acc, curr) => acc + curr.volume, 0);
    return currentDayForecast.intervalos.map(interval => ({
      ...interval,
      peso: totalVol > 0 ? Number(((interval.volume / totalVol) * 100).toFixed(2)) : 0
    }));
  }, [currentDayForecast]);

  // Cálculos dinâmicos da Fase 4
  const selectedBaselineData = stats?.baseline_meses.filter(b => selectedMonths.includes(b.ano_mes)) || [];

  const getVals = (dayKey: keyof BaselineMesStat) => selectedBaselineData.map(b => b[dayKey] as number);

  const mGeoBase = {
    seg: computeMGeo(getVals('seg')), ter: computeMGeo(getVals('ter')), qua: computeMGeo(getVals('qua')),
    qui: computeMGeo(getVals('qui')), sex: computeMGeo(getVals('sex')), sab: computeMGeo(getVals('sab')),
    dom: computeMGeo(getVals('dom')), total: 0
  };
  mGeoBase.total = mGeoBase.seg + mGeoBase.ter + mGeoBase.qua + mGeoBase.qui + mGeoBase.sex + mGeoBase.sab + mGeoBase.dom;

  const pondBase = {
    seg: computePond(getVals('seg')), ter: computePond(getVals('ter')), qua: computePond(getVals('qua')),
    qui: computePond(getVals('qui')), sex: computePond(getVals('sex')), sab: computePond(getVals('sab')),
    dom: computePond(getVals('dom')), total: 0
  };
  pondBase.total = pondBase.seg + pondBase.ter + pondBase.qua + pondBase.qui + pondBase.sex + pondBase.sab + pondBase.dom;

  const mDuBase = {
    seg: computeMean(getVals('seg')), ter: computeMean(getVals('ter')), qua: computeMean(getVals('qua')),
    qui: computeMean(getVals('qui')), sex: computeMean(getVals('sex')), sab: computeMean(getVals('sab')),
    dom: computeMean(getVals('dom')), total: 0
  };
  mDuBase.total = mDuBase.seg + mDuBase.ter + mDuBase.qua + mDuBase.qui + mDuBase.sex + mDuBase.sab + mDuBase.dom;

  const eCalendBase = { ...mDuBase }; // Simplificação até o usuário definir

  const getPercent = (val: number, tot: number) => tot > 0 ? ((val / tot) * 100).toFixed(2) + '%' : '0.00%';

  const applyFactors = (val: number) => {
    return Math.round(val * (1 + (flutuacao / 100)) * (1 + (incremento / 100)));
  };

  // --- Dimensionamento (Erlang) Logic ---
  
  const erlangInputs = useMemo(() => ({
    activeTab, monthForecastData, dimTargetSlaPercent, dimTargetSlaTime, 
    dimShrinkage, dimFixedAgents, dimTma, dimStrategy, dimOpHours, 
    dimFixedVolume, dimCurveType, stats
  }), [activeTab, monthForecastData, dimTargetSlaPercent, dimTargetSlaTime, 
       dimShrinkage, dimFixedAgents, dimTma, dimStrategy, dimOpHours, 
       dimFixedVolume, dimCurveType, stats]);

  const debouncedErlangInputs = useDebounce(erlangInputs, 300);

  const [optimizedMonthErlang, setOptimizedMonthErlang] = useState<OptimizedMonthErlangItem[]>([]);
  const [isCalculatingErlang, setIsCalculatingErlang] = useState<boolean>(false);
  const erlangWorkerRef = useRef<Worker | null>(null);

  useEffect(() => {
    erlangWorkerRef.current = new Worker(new URL('./workers/erlangWorker.ts', import.meta.url), { type: 'module' });
    
    erlangWorkerRef.current.onmessage = (event) => {
      if (event.data.success) {
        setOptimizedMonthErlang(event.data.result);
      } else {
        console.error("Worker error:", event.data.error);
      }
      setIsCalculatingErlang(false);
    };

    return () => {
      erlangWorkerRef.current?.terminate();
    };
  }, []);

  useEffect(() => {
    const { activeTab, monthForecastData, dimTargetSlaPercent, dimTargetSlaTime, 
            dimShrinkage, dimFixedAgents, dimTma, dimStrategy, dimOpHours, 
            dimFixedVolume, dimCurveType, stats } = debouncedErlangInputs;

    if (activeTab !== 'dimensionamento' || monthForecastData.length === 0) {
      setOptimizedMonthErlang([]);
      return;
    }

    setIsCalculatingErlang(true);

    let forecastToUse = monthForecastData;
    if (dimCurveType !== 'padrao' && stats?.curvas_distribuicao?.[dimCurveType]) {
      const curve = stats?.curvas_distribuicao?.[dimCurveType] || {};
      forecastToUse = forecastToUse.map(day => {
        const totalVol = day.intervalos.reduce((s, i) => s + i.volume, 0);
        const totalTmo = day.intervalos.reduce((s, i) => s + (i.volume * (i.tmo || 240)), 0);
        const tmoAvg = totalVol > 0 ? Math.round(totalTmo / totalVol) : 240;

        const withIdx = day.intervalos.map((orig, idx) => {
          const prop = (curve[orig.intervalo] as number) || 0;
          const exact = totalVol * prop;
          return { ...orig, exact, volume: Math.floor(exact), frac: exact - Math.floor(exact), idx, tmo: tmoAvg };
        });

        let sumInts = withIdx.reduce((s, i) => s + i.volume, 0);
        const rem = Math.round(totalVol) - sumInts;
        withIdx.sort((a, b) => b.frac - a.frac);
        for (let i = 0; i < rem; i++) {
          if (i < withIdx.length) withIdx[i].volume += 1;
        }
        withIdx.sort((a, b) => a.idx - b.idx);

        return {
          ...day,
          intervalos: withIdx.map(d => ({ intervalo: d.intervalo, volume: d.volume, tmo: d.tmo }))
        };
      });
    }

    if (dimFixedVolume !== '') {
      const fixedVolMonth = Number(dimFixedVolume);

      // Calculate total forecast for the month
      const totalForecastMonth = forecastToUse.reduce((sum, day) =>
        sum + day.intervalos.reduce((s, i) => s + i.volume, 0), 0);

      if (totalForecastMonth > 0) {
        const scaleFactor = fixedVolMonth / totalForecastMonth;

        forecastToUse = forecastToUse.map(day => {
          return {
            ...day,
            intervalos: day.intervalos.map((interval: any) => ({
              ...interval,
              volume: Math.round(interval.volume * scaleFactor)
            }))
          };
        });
      }
    }

    const inputs = {
      volume: 0,
      tmo: dimTargetSlaTime,
      intervalSeconds: 600,
      targetSlaPercent: dimTargetSlaPercent / 100,
      targetSlaTime: dimTargetSlaTime,
      shrinkage: dimShrinkage / 100,
      maxOccupancy: 0.85,
      fixedAgents: dimFixedAgents === '' ? undefined : Number(dimFixedAgents),
      fixedTma: dimTma === '' ? undefined : Number(dimTma)
    };

    erlangWorkerRef.current?.postMessage({
      forecastToUse,
      inputs,
      dimStrategy,
      dimOpHours
    });
  }, [debouncedErlangInputs]);

  const erlangData = useMemo(() => {
    if (optimizedMonthErlang.length === 0) return [];

    // Pick the selected day, or fallback to DMM, or fallback to first day
    let targetDate = dimSelectedDay;
    if (!targetDate && monthComparisons?.dmm_data) {
      targetDate = monthComparisons.dmm_data;
    }
    if (!targetDate) {
      targetDate = monthForecastData[0].data;
    }

    return optimizedMonthErlang.filter(item => item.data === targetDate);
  }, [optimizedMonthErlang, dimSelectedDay, monthComparisons, monthForecastData]);

  const monthlyShiftSchedules = useMemo(() => {
    if (optimizedMonthErlang.length === 0 || dimEnabledShifts.length === 0) return [];

    // Group by data
    const byDay = optimizedMonthErlang.reduce((acc, curr) => {
      if (!acc[curr.data]) acc[curr.data] = [];
      acc[curr.data].push(curr);
      return acc;
    }, {} as Record<string, any[]>);

    // Determine total volume for each day to find DMMs
    const dayVolumes: { data: string, vol: number, dayOfWeek: number }[] = [];
    for (const [data, intervals] of Object.entries(byDay)) {
      const vol = intervals.reduce((sum, i) => sum + i.volume, 0);
      const dateObj = new Date(data + "T00:00:00");
      dayVolumes.push({ data, vol, dayOfWeek: dateObj.getDay() });
    }

    // Find DMMs
    const weekdays = dayVolumes.filter(d => d.dayOfWeek >= 1 && d.dayOfWeek <= 5).sort((a, b) => b.vol - a.vol);
    const saturdays = dayVolumes.filter(d => d.dayOfWeek === 6).sort((a, b) => b.vol - a.vol);
    const sundays = dayVolumes.filter(d => d.dayOfWeek === 0).sort((a, b) => b.vol - a.vol);

    // Pick the selected rank (1-based), bounded by the array length
    const dmmWeekday = weekdays[Math.min(dimDmmRank - 1, Math.max(0, weekdays.length - 1))]?.data;
    const dmmSat = saturdays[Math.min(dimDmmRank - 1, Math.max(0, saturdays.length - 1))]?.data;
    const dmmSun = sundays[Math.min(dimDmmRank - 1, Math.max(0, sundays.length - 1))]?.data;

    const opDays = 7 - (dimOpHours.sundays.closed ? 1 : 0) - (dimOpHours.saturdays.closed ? 1 : 0);

    // Pre-calculate shiftRes for these DMMs
    let baseSchedules: Record<string, any> = {};
    if (dmmWeekday) {
      const req = byDay[dmmWeekday].map(d => d.requiredAgents);
      const lbl = byDay[dmmWeekday].map(d => d.intervalo);
      baseSchedules.weekday = calculateShifts(req, lbl, dimEnabledShifts, opDays);
    }
    if (dmmSat) {
      const req = byDay[dmmSat].map(d => d.requiredAgents);
      const lbl = byDay[dmmSat].map(d => d.intervalo);
      baseSchedules.saturday = calculateShifts(req, lbl, dimEnabledShifts, opDays);
    }
    if (dmmSun) {
      const req = byDay[dmmSun].map(d => d.requiredAgents);
      const lbl = byDay[dmmSun].map(d => d.intervalo);
      baseSchedules.sunday = calculateShifts(req, lbl, dimEnabledShifts, opDays);
    }

    if (dimStrategy === 'monthly_avg' && dmmWeekday && baseSchedules.weekday) {
      const evaluateMonthSla = (testBaseSchedules: Record<string, any>) => {
        let totalMonthVol = 0;
        let totalMonthVolOk = 0;

        for (const [data, intervals] of Object.entries(byDay)) {
          const dateObj = new Date(data + "T00:00:00");
          const dayOfWeek = dateObj.getDay();

          let baseRes;
          if (dayOfWeek > 0 && dayOfWeek < 6) {
            baseRes = testBaseSchedules.weekday;
          } else if (dayOfWeek === 0) {
            baseRes = testBaseSchedules.sunday;
          } else if (dayOfWeek === 6) {
            baseRes = testBaseSchedules.saturday;
          }

          if (!baseRes) continue;

          for (let idx = 0; idx < (intervals as any[]).length; idx++) {
            const interval = (intervals as any[])[idx];
            if (interval.volume === 0 || interval.isClosed) continue;
            const scheduledAgents = baseRes.coverage[idx] || 0;
            const netAgents = Math.floor(scheduledAgents * (1 - (dimShrinkage / 100)));
            const effectiveTmo = dimTma !== '' ? Number(dimTma) : interval.tmo;
            const traffic = (interval.volume / 600) * effectiveTmo;
            const evalRes = evaluateErlangConfig(netAgents, traffic, effectiveTmo, dimTargetSlaTime, dimShrinkage / 100);

            totalMonthVol += interval.volume;
            totalMonthVolOk += (evalRes.serviceLevel || 0) * interval.volume;
          }
        }
        return totalMonthVol > 0 ? (totalMonthVolOk / totalMonthVol) : 0;
      };

      const evaluateDaySla = (testBaseSchedules: Record<string, any>, dayStr: string) => {
        const intervals = byDay[dayStr];
        if (!intervals) return 0;
        let totalVol = 0;
        let totalVolOk = 0;

        let baseRes = testBaseSchedules.weekday; // DMM weekday always uses weekday schedule
        if (!baseRes) return 0;

        for (let idx = 0; idx < (intervals as any[]).length; idx++) {
          const interval = (intervals as any[])[idx];
          if (interval.volume === 0 || interval.isClosed) continue;

          let netAgents = 0;
          if (baseRes.activePerInterval && baseRes.activePerInterval[idx]) {
            const activeShifts = baseRes.activePerInterval[idx];
            for (const [shiftType, count] of Object.entries(activeShifts)) {
              const conf = dimShrinkageConfig[shiftType] || defaultShrinkage;
              const shiftShrinkage = Object.values(conf).reduce((sum, val) => sum + val, 0);
              netAgents += (count as number) * (1 - (shiftShrinkage / 100));
            }
          } else {
            const scheduledAgents = baseRes.coverage[idx] || 0;
            netAgents = scheduledAgents * (1 - (dimShrinkage / 100));
          }
          netAgents = Math.floor(netAgents);

          const effectiveTmo = dimTma !== '' ? Number(dimTma) : interval.tmo;
          const traffic = (interval.volume / 600) * effectiveTmo;
          const evalRes = evaluateErlangConfig(netAgents, traffic, effectiveTmo, dimTargetSlaTime, 0);

          totalVol += interval.volume;
          totalVolOk += (evalRes.serviceLevel || 0) * interval.volume;
        }
        return totalVol > 0 ? (totalVolOk / totalVol) : 0;
      };

      let currentMonthSla = evaluateMonthSla(baseSchedules);

      const absoluteFirstDmm = weekdays.length > 0 ? weekdays[0].data : dmmWeekday;
      let currentFirstDmmSla = evaluateDaySla(baseSchedules, absoluteFirstDmm);

      // Keep references to satisfy TS unused vars
      void currentMonthSla;
      void currentFirstDmmSla;

      let bestSchedules = { ...baseSchedules };

      if (dmmWeekday && byDay[dmmWeekday]) {
        const origReq = [...byDay[dmmWeekday].map((d: any) => d.requiredAgents)];

        let low = 0.01;
        let high = 5.0; // Allow up to 5x scale if the chosen DMM is much smaller than the 1st DMM

        for (let iter = 0; iter < 15; iter++) { // 15 iterations for better precision
          const mid = (low + high) / 2;
          const scaledReq = origReq.map(r => Math.round(r * mid));

          const newWeekdaySchedule = calculateShifts(scaledReq, byDay[dmmWeekday].map((d: any) => d.intervalo), dimEnabledShifts, opDays);

          const testSchedules = { ...baseSchedules, weekday: newWeekdaySchedule };
          const firstDmmSla = evaluateDaySla(testSchedules, absoluteFirstDmm);
          const monthSla = evaluateMonthSla(testSchedules);

          if (firstDmmSla >= dimTargetDmmSlaPercent && monthSla >= dimTargetSlaPercent) {
            bestSchedules = testSchedules;
            high = mid; // SLAs are met, try to reduce HC more (lower K)
          } else {
            low = mid; // SLAs are NOT met, need MORE HC (higher K)
          }
        }
      }
      baseSchedules = bestSchedules;
    }

    const result: any[] = [];

    for (const [data, intervals] of Object.entries(byDay)) {
      const dateObj = new Date(data + "T00:00:00");
      const dayOfWeek = dateObj.getDay();

      let baseRes;
      if (dayOfWeek > 0 && dayOfWeek < 6) {
        baseRes = baseSchedules.weekday;
      } else if (dayOfWeek === 0) {
        baseRes = baseSchedules.sunday;
      } else if (dayOfWeek === 6) {
        baseRes = baseSchedules.saturday;
      }

      if (!baseRes) {
        const req = intervals.map(d => d.requiredAgents);
        const lbl = intervals.map(d => d.intervalo);
        baseRes = calculateShifts(req, lbl, dimEnabledShifts, opDays);
      }

      const shiftRes = baseRes; // Fixed schedule for this day type

      const isDayClosed = intervals.every(i => i.isClosed);
      const totalVol = isDayClosed ? 0 : Math.round(intervals.reduce((sum, i) => sum + i.volume, 0));

      // Calculate Fixed Hired Headcount based on the DMM (weekday)
      const fixedHiredHC: Record<string, number> = {};
      if (baseSchedules.weekday) {
        AVAILABLE_SHIFTS.forEach(s => {
          const dailyCount = baseSchedules.weekday.hcPerShiftType[s.type] || 0;
          const daysWorked = 7 / s.daysOffFactor;
          const dynamicFactor = Math.max(1.0, opDays / daysWorked);
          fixedHiredHC[s.type] = isDayClosed ? 0 : Math.ceil(dailyCount * dynamicFactor);
        });
      }
      const tmoAvg = Math.round(totalVol > 0 ? (intervals.reduce((sum, i) => sum + i.volume * i.tmo, 0) / totalVol) : 0);

      // Recalculate SLA and Occupancy for this day using the fixed schedule (shiftRes.coverage)
      const newIntervals = intervals.map((interval, idx) => {
        if (interval.volume === 0 || interval.isClosed) return interval;

        let netAgents = 0;
        if (shiftRes.activePerInterval && shiftRes.activePerInterval[idx]) {
          const activeShifts = shiftRes.activePerInterval[idx];
          for (const [shiftType, count] of Object.entries(activeShifts)) {
            const conf = dimShrinkageConfig[shiftType] || defaultShrinkage;
            const shiftShrinkage = Object.values(conf).reduce((sum, val) => sum + val, 0);
            netAgents += (count as number) * (1 - (shiftShrinkage / 100));
          }
        } else {
          const scheduledAgents = shiftRes.coverage[idx] || 0;
          netAgents = scheduledAgents * (1 - (dimShrinkage / 100));
        }
        netAgents = Math.floor(netAgents);

        const effectiveTmo = dimTma !== '' ? Number(dimTma) : interval.tmo;
        const traffic = (interval.volume / 600) * effectiveTmo; // 600 seconds = 10 min
        const evalRes = evaluateErlangConfig(netAgents, traffic, effectiveTmo, dimTargetSlaTime, 0);
        return {
          ...interval,
          serviceLevel: evalRes.serviceLevel,
          occupancy: evalRes.occupancy,
          tmo: effectiveTmo
        };
      });

      // Calculate SLA only for open intervals (business hours)
      const openIntervals = newIntervals.filter(i => !i.isClosed);
      const openVol = openIntervals.reduce((sum, d) => sum + d.volume, 0);
      const volOk = openIntervals.reduce((sum, d) => sum + ((d.serviceLevel || 0) * d.volume), 0);

      const finalSla = openVol > 0 ? (volOk / openVol) : (isDayClosed ? null : 100);

      const maxPAs = Math.max(...newIntervals.map(i => i.requiredAgents));

      let totalCoverage = 0;
      let activeCount = 0;
      newIntervals.forEach((d, idx) => {
        if (!d.isClosed && d.volume > 0) {
          totalCoverage += (shiftRes.coverage[idx] || 0);
          activeCount++;
        }
      });
      const avgPAs = activeCount > 0 ? Math.round(totalCoverage / activeCount) : 0;

      const activeIntervals = newIntervals.filter(d => !d.isClosed && d.volume > 0);
      const avgOccupancy = activeIntervals.length > 0
        ? Math.round(activeIntervals.reduce((sum, d) => sum + (d.occupancy || 0), 0) / activeIntervals.length)
        : 0;

      const totalTraffic = (totalVol * tmoAvg);

      result.push({
        data,
        totalVol,
        totalTraffic,
        tmoAvg: tmoAvg.toFixed(0),
        finalSla: finalSla === null ? null : Math.round(finalSla),
        maxPAs,
        avgPAs: Math.round(avgPAs),
        avgOccupancy: Math.round(avgOccupancy),
        shiftRes,
        fixedHiredHC,
        intervals: newIntervals
      });
    }

    const totalMonthTraffic = result.reduce((sum, r) => sum + r.totalTraffic, 0) || 1;
    result.sort((a, b) => b.totalTraffic - a.totalTraffic);
    result.forEach((r, idx) => {
      r.dmmRank = idx + 1;
      r.percDmm = (r.totalTraffic / totalMonthTraffic) * 100;
    });
    result.sort((a, b) => a.data.localeCompare(b.data));

    return result;
  }, [optimizedMonthErlang, dimEnabledShifts, dimTargetSlaPercent, dimTargetDmmSlaPercent, dimDmmRank, dimStrategy]);

  const consolidatedSchedules = useMemo(() => {
    if (monthlyShiftSchedules.length === 0) return [];

    const groups: Record<string, any> = {
      'Seg-Sex': { days: 0, totalVol: 0, totalTraffic: 0, tmoSum: 0, maxPAsSum: 0, avgPAsSum: 0, fixedHiredHC: {}, finalSlaSum: 0, avgOccupancySum: 0, maxCoverage: 0, dmmRank: '-', percDmm: 0, shiftRes: { coverage: [] } },
      'Sábado': { days: 0, totalVol: 0, totalTraffic: 0, tmoSum: 0, maxPAsSum: 0, avgPAsSum: 0, fixedHiredHC: {}, finalSlaSum: 0, avgOccupancySum: 0, maxCoverage: 0, dmmRank: '-', percDmm: 0, shiftRes: { coverage: [] } },
      'Domingo': { days: 0, totalVol: 0, totalTraffic: 0, tmoSum: 0, maxPAsSum: 0, avgPAsSum: 0, fixedHiredHC: {}, finalSlaSum: 0, avgOccupancySum: 0, maxCoverage: 0, dmmRank: '-', percDmm: 0, shiftRes: { coverage: [] } }
    };

    monthlyShiftSchedules.forEach(row => {
      const dateObj = new Date(row.data + "T00:00:00");
      const dayOfWeek = dateObj.getDay();
      const type = dayOfWeek === 0 ? 'Domingo' : dayOfWeek === 6 ? 'Sábado' : 'Seg-Sex';

      const g = groups[type];
      g.days++;
      g.totalVol += row.totalVol;
      g.totalTraffic += row.totalTraffic || 0;
      g.tmoSum += row.totalVol * Number(row.tmoAvg); // For weighted avg
      g.maxPAsSum += row.maxPAs;
      g.avgPAsSum += row.avgPAs;
      g.finalSlaSum += (row.finalSla || 0) * row.totalVol; // For weighted avg
      g.avgOccupancySum += row.avgOccupancy;

      // Fixed Hired HC is MAX across the group
      Object.keys(row.fixedHiredHC).forEach(shiftType => {
        g.fixedHiredHC[shiftType] = Math.max(g.fixedHiredHC[shiftType] || 0, row.fixedHiredHC[shiftType]);
      });

      const maxCov = row.shiftRes?.coverage?.length > 0 ? Math.max(...row.shiftRes.coverage) : 0;
      g.maxCoverage = Math.max(g.maxCoverage, maxCov);

      if (!g.shiftRes.coverage.length && row.shiftRes?.coverage?.length) {
        g.shiftRes.coverage = row.shiftRes.coverage;
      }
    });

    return Object.keys(groups).filter(k => groups[k].days > 0).map(k => {
      const g = groups[k];
      return {
        data: k === 'Seg-Sex' ? '2099-01-01' : k === 'Sábado' ? '2099-01-02' : '2099-01-03', // Dummy dates for sorting
        tipo: k,
        dmmRank: dimDmmRank,
        percDmm: (g.totalTraffic / (monthlyShiftSchedules.reduce((sum, r) => sum + r.totalTraffic, 0) || 1)) * 100,
        totalVol: Math.round(g.totalVol / g.days), // Average daily volume for this type
        totalTraffic: g.totalTraffic / g.days,
        tmoAvg: g.totalVol > 0 ? (g.tmoSum / g.totalVol).toFixed(0) : 0,
        maxPAs: Math.round(g.maxPAsSum / g.days),
        avgPAs: Math.round(g.avgPAsSum / g.days),
        fixedHiredHC: g.fixedHiredHC,
        finalSla: g.totalVol > 0 ? (g.finalSlaSum / g.totalVol) : 0,
        avgOccupancy: Math.round(g.avgOccupancySum / g.days),
        maxCoverage: g.maxCoverage,
        shiftRes: g.shiftRes,
        isConsolidated: true
      };
    });
  }, [monthlyShiftSchedules, dimDmmRank]);
  const dimSummary = useMemo(() => {
    if (erlangData.length === 0) return null;

    if (dimStrategy === 'monthly_avg' && monthlyShiftSchedules.length > 0) {
      const targetDate = dimSelectedDay || monthComparisons?.dmm_data || monthForecastData[0]?.data;
      const selectedMonthlyDay = monthlyShiftSchedules.find(d => d.data === targetDate);
      if (selectedMonthlyDay && selectedMonthlyDay.shiftRes) {
        const maxCoverage = selectedMonthlyDay.shiftRes.coverage?.length > 0 ? Math.max(...selectedMonthlyDay.shiftRes.coverage) : 0;
        return {
          maxPAs: maxCoverage,
          avgPAs: selectedMonthlyDay.avgPAs,
          finalSla: selectedMonthlyDay.finalSla,
          totalMonthVol: optimizedMonthErlang.reduce((sum, d) => sum + d.volume, 0)
        };
      }
    }

    const maxPAs = Math.max(...erlangData.map(d => d.requiredAgents));

    const activeIntervals = erlangData.filter(d => !d.isClosed && d.volume > 0);
    const avgPAs = activeIntervals.length > 0
      ? Math.round(activeIntervals.reduce((sum, d) => sum + d.requiredAgents, 0) / activeIntervals.length)
      : 0;

    const totalVol = erlangData.reduce((sum, d) => sum + d.volume, 0);
    const weightedSla = totalVol > 0
      ? erlangData.reduce((sum, d) => sum + ((d.serviceLevel || 0) * d.volume), 0) / totalVol
      : 0;

    const totalMonthVol = optimizedMonthErlang.reduce((sum, d) => sum + d.volume, 0);

    return { maxPAs, avgPAs, finalSla: weightedSla, totalMonthVol };
  }, [erlangData, optimizedMonthErlang, dimStrategy, monthlyShiftSchedules, dimSelectedDay, monthComparisons, monthForecastData]);

  const shiftSchedule = useMemo(() => {
    if (erlangData.length === 0 || dimEnabledShifts.length === 0) return null;

    if (dimStrategy === 'monthly_avg' && monthlyShiftSchedules.length > 0) {
      const targetDate = dimSelectedDay || monthComparisons?.dmm_data || monthForecastData[0]?.data;
      const selectedMonthlyDay = monthlyShiftSchedules.find(d => d.data === targetDate);
      if (selectedMonthlyDay && selectedMonthlyDay.shiftRes) {
        return selectedMonthlyDay.shiftRes;
      }
    }

    // Pegar o array de requiredAgents
    const requiredAgents = erlangData.map(d => d.requiredAgents);
    const intervalLabels = erlangData.map(d => d.intervalo);

    const opDays = 7 - (dimOpHours.sundays.closed ? 1 : 0) - (dimOpHours.saturdays.closed ? 1 : 0);
    return calculateShifts(requiredAgents, intervalLabels, dimEnabledShifts, opDays);
  }, [erlangData, dimEnabledShifts, dimStrategy, monthlyShiftSchedules, dimSelectedDay, monthComparisons, monthForecastData]);

  // ---- Alocação Automática 06:20 | 08:12 ----
  const shiftAllocation612_812 = useMemo((): ShiftAllocationResult | null => {
    if (erlangData.length === 0) return null;

    const required = erlangData.map(d => d.requiredAgents);
    const labels = erlangData.map(d => d.intervalo);

    // Determinar janela de operação do dia selecionado
    const targetDate = dimSelectedDay || monthComparisons?.dmm_data || monthForecastData[0]?.data || '';
    const d = targetDate ? new Date(targetDate + 'T00:00:00') : new Date();
    const dow = d.getDay();
    let opCfg = dimOpHours.weekdays;
    if (dow === 0) opCfg = dimOpHours.sundays;
    else if (dow === 6) opCfg = dimOpHours.saturdays;

    if (opCfg.closed) return null;

    return allocateShifts612_812(required, labels, opCfg.start, opCfg.end);
  }, [erlangData, dimOpHours, dimSelectedDay, monthComparisons, monthForecastData]);

  // WFM Cost Estimate
  const wfmCostEstimate = useMemo(() => {
    if (monthlyShiftSchedules.length === 0) return null;
    const totalMonthlyHC = monthlyShiftSchedules[0]?.shiftRes?.totalMonthlyHC || 0;
    const totalMonthVol = optimizedMonthErlang.reduce((sum, d) => sum + d.volume, 0);
    const avgTmo = erlangData.length > 0 
      ? Math.round(erlangData.reduce((sum, d) => sum + d.tmo, 0) / erlangData.length) 
      : 240;
    return calculateCostEstimate(totalMonthlyHC, totalMonthVol, avgTmo, costPerAgent, overheadPercent);
  }, [monthlyShiftSchedules, optimizedMonthErlang, erlangData, costPerAgent, overheadPercent]);

  // SLA Sensitivity Analysis
  const slaSensitivityData = useMemo((): SensitivityResult[] => {
    if (erlangData.length === 0) return [];
    const totalVol = erlangData.reduce((sum, d) => sum + d.volume, 0);
    const avgTmo = Math.round(erlangData.reduce((sum, d) => sum + d.tmo, 0) / erlangData.length);
    return calculateSLASensitivity(
      totalVol, avgTmo, 600,
      dimTargetSlaPercent, dimTargetSlaTime, dimShrinkage
    );
  }, [erlangData, dimTargetSlaPercent, dimTargetSlaTime, dimShrinkage]);

  // Shift Combination Comparison
  const shiftComparisonData = useMemo((): ShiftCombinationCost[] => {
    if (erlangData.length === 0) return [];
    const required = erlangData.map(d => d.requiredAgents);
    const labels = erlangData.map(d => d.intervalo);
    return compareShiftCombinations(required, labels, costPerAgent, overheadPercent);
  }, [erlangData, costPerAgent, overheadPercent]);

  // WFM Metrics from backend stats
  const wfmMetrics = stats?.wfm_metrics || null;

  const runOptimization = () => {
    if (erlangData.length === 0) return;

    const combinations: ShiftType[][] = [];
    const numShifts = AVAILABLE_SHIFTS.length;

    // bitwise subset generation (1 to 2^n - 1)
    for (let i = 1; i < (1 << numShifts); i++) {
      const subset: ShiftType[] = [];
      for (let j = 0; j < numShifts; j++) {
        if (i & (1 << j)) {
          subset.push(AVAILABLE_SHIFTS[j].type);
        }
      }
      combinations.push(subset);
    }

    const requiredAgents = erlangData.map(d => d.requiredAgents);
    const intervalLabels = erlangData.map(d => d.intervalo);

    const results = combinations.map(combo => {
      const opDays = 7 - (dimOpHours.sundays.closed ? 1 : 0) - (dimOpHours.saturdays.closed ? 1 : 0);
      const sim = calculateShifts(requiredAgents, intervalLabels, combo, opDays);
      return {
        combo,
        totalMonthlyHC: sim.totalMonthlyHC,
        totalDailyHC: sim.totalDailyHC,
        schedules: sim.schedules,
        hcPerShiftType: sim.hcPerShiftType
      };
    });

    // Sort by lowest Monthly HC, then Daily HC
    results.sort((a, b) => {
      if (a.totalMonthlyHC !== b.totalMonthlyHC) return a.totalMonthlyHC - b.totalMonthlyHC;
      return a.totalDailyHC - b.totalDailyHC;
    });

    setOptResults(results);
    setIsOptModalOpen(true);
  };

  const coverageChartData = useMemo(() => {
    if (!shiftSchedule || erlangData.length === 0) return [];

    const chunked = [];
    for (let i = 0; i < erlangData.length; i += 3) {
      const chunk = erlangData.slice(i, i + 3);
      if (chunk.length === 0) continue;

      const sumVol = chunk.reduce((sum: number, r: any) => sum + r.volume, 0);
      const maxReqAgents = Math.max(...chunk.map((r: any) => r.requiredAgents));
      let maxCoverage = 0;
      let peakIdx = 0;
      for (let idx = 0; idx < chunk.length; idx++) {
        const cov = shiftSchedule.coverage[i + idx] || 0;
        if (cov >= maxCoverage) {
          maxCoverage = cov;
          peakIdx = idx;
        }
      }

      const activeSum: Record<string, number> = {};
      AVAILABLE_SHIFTS.forEach(s => {
        activeSum[s.type] = shiftSchedule.activePerInterval[i + peakIdx]?.[s.type] || 0;
      });

      chunked.push({
        intervalo: chunk[0].intervalo,
        required: maxReqAgents,
        coverage: maxCoverage,
        volume: sumVol,
        ...activeSum
      });
    }
    return chunked;
  }, [erlangData, shiftSchedule]);

  const erlangChartData = useMemo(() => {
    if (erlangData.length === 0) return [];

    const chunked = [];
    for (let i = 0; i < erlangData.length; i += 3) {
      const chunk = erlangData.slice(i, i + 3);
      if (chunk.length === 0) continue;

      const maxReqAgents = Math.max(...chunk.map((r: any) => r.requiredAgents));
      const avgOccupancy = chunk.reduce((sum: number, r: any) => sum + (r.occupancy || 0), 0) / chunk.length;
      const avgSla = chunk.reduce((sum: number, r: any) => sum + (r.serviceLevel || 0), 0) / chunk.length;

      chunked.push({
        intervalo: chunk[0].intervalo,
        requiredAgents: maxReqAgents,
        occupancy: avgOccupancy,
        serviceLevel: avgSla
      });
    }
    return chunked;
  }, [erlangData]);


  const exportMonthlyCSV = () => {
    if (monthlyShiftSchedules.length === 0) return;
    const headers = ['DIA', 'TIPO', 'DMM', '% DMM', 'VOLUME', 'TMO', 'NEC B', 'DIM B', 'GAP B'];
    // Add columns for each enabled shift type
    AVAILABLE_SHIFTS.forEach(s => headers.push(`HC ${s.label.split(' ')[0]}`));
    headers.push('HE DIM', 'NS (%)', 'NS C/ HE', 'PA LOG', 'PA LOG+HE', 'TX OCUP', 'ABS', 'TO', 'NR17', 'TREIN.', 'OUTROS', 'INDISP TOTAL', 'AD. NOT');

    const rows = monthlyShiftSchedules.map(day => {
      const dateObj = new Date(day.data + "T00:00:00");
      const dayName = dateObj.toLocaleDateString('pt-BR', { weekday: 'short' });
      const maxCoverage = Math.max(...day.shiftRes.coverage);
      const row = [
        dateObj.toLocaleDateString('pt-BR'),
        dayName,
        day.dmmRank.toString(),
        (day.percDmm?.toFixed(2) || '0') + '%',
        day.totalVol.toString(),
        day.tmoAvg.toString(),
        day.maxPAs.toString(),
        day.avgPAs.toString(),
        (day.avgPAs - day.maxPAs).toString()
      ];

      AVAILABLE_SHIFTS.forEach(s => {
        row.push((day.fixedHiredHC[s.type] || 0).toString());
      });

      const avgShrinkage = { abs: 0, turnover: 0, nr17: 0, treinamento: 0, outros: 0 };
      if (dimEnabledShifts.length > 0) {
        dimEnabledShifts.forEach(s => {
          const conf = dimShrinkageConfig[s] || defaultShrinkage;
          avgShrinkage.abs += conf.abs;
          avgShrinkage.turnover += conf.turnover;
          avgShrinkage.nr17 += conf.nr17;
          avgShrinkage.treinamento += conf.treinamento;
          avgShrinkage.outros += conf.outros;
        });
        avgShrinkage.abs /= dimEnabledShifts.length;
        avgShrinkage.turnover /= dimEnabledShifts.length;
        avgShrinkage.nr17 /= dimEnabledShifts.length;
        avgShrinkage.treinamento /= dimEnabledShifts.length;
        avgShrinkage.outros /= dimEnabledShifts.length;
      }

      row.push(
        '0', // HE DIM
        (day.finalSla || 0).toFixed(2).replace('.', ','), // NS
        (day.finalSla || 0).toFixed(2).replace('.', ','), // NS C/ HE
        maxCoverage.toString(), // PA LOG
        maxCoverage.toString(), // PA LOG+HE
        day.avgOccupancy.toString(), // TX OCUP
        avgShrinkage.abs.toFixed(2).replace('.', ','),
        avgShrinkage.turnover.toFixed(2).replace('.', ','),
        avgShrinkage.nr17.toFixed(2).replace('.', ','),
        avgShrinkage.treinamento.toFixed(2).replace('.', ','),
        avgShrinkage.outros.toFixed(2).replace('.', ','),
        dimShrinkage.toFixed(2).replace('.', ','), // INDISP TOTAL
        '0,0%' // AD. NOT
      );
      return row;
    });

    const csvContent = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `visao_mensal_escalas_${new Date().getTime()}.csv`;
    link.click();
  };

  const exportIntradayCSV = () => {
    if (erlangData.length === 0 || !shiftSchedule) return;
    const headers = ['INTERVALO', 'VOLUME', 'TMO', 'PAs NECESSARIAS', 'OCUPACAO', 'NS (%)', 'COBERTURA (DIM)'];
    AVAILABLE_SHIFTS.forEach(s => headers.push(`ENTRADAS ${s.label}`));

    const rows = erlangData.map((d, index) => {
      const row = [
        d.intervalo,
        Math.round(d.volume).toString(),
        Math.round(d.tmo).toString(),
        d.requiredAgents.toString(),
        Math.round(d.occupancy).toString(),
        Math.round(d.serviceLevel).toString(),
        (shiftSchedule.coverage[index] || 0).toString()
      ];
      AVAILABLE_SHIFTS.forEach(s => {
        const entradas = shiftSchedule.entradasPerInterval[index]?.[s.type] || 0;
        row.push(entradas.toString());
      });
      return row;
    });

    const csvContent = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `visao_intradiaria_${dimSelectedDay}_${new Date().getTime()}.csv`;
    link.click();
  };
  // --- Fim Dimensionamento ---

  return (
    <div className="space-y-6">
      {/* Upload Area */}
      <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold mb-1">Atualizar Histórico</h2>
            <p className="text-slate-400 text-sm">Faça upload de um CSV para recalibrar o modelo preditivo.</p>
          </div>

          <input
            type="file"
            accept=".csv, .xlsx, .xls, .xlsm, .xlsb, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel, application/vnd.ms-excel.sheet.macroEnabled.12, application/vnd.ms-excel.sheet.binary.macroEnabled.12"
            ref={fileInputRef}
            className="hidden"
            onChange={handleFileUpload}
          />

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white px-6 py-2.5 rounded-lg font-medium transition-all disabled:opacity-50"
            >
              <UploadCloud size={20} />
              {stagedFile ? "Trocar CSV" : "Selecionar CSV"}
            </button>
            
            {stagedFile && (
              <button
                onClick={confirmUpload}
                disabled={loading}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-6 rounded-lg shadow-lg hover:shadow-blue-500/20 transition-all flex items-center gap-2"
              >
                {loading ? "Processando..." : "🚀 Processar e Treinar IA"}
              </button>
            )}
            {(forecastData.length > 0 || stagedFile || availableYears.length > 0) && (
              <button
                onClick={resetDashboard}
                disabled={loading}
                className="flex items-center gap-2 bg-slate-700/50 hover:bg-red-900/50 text-slate-300 hover:text-red-400 px-4 py-2.5 rounded-lg font-medium transition-all border border-transparent hover:border-red-900"
              >
                Resetar
              </button>
            )}
          </div>
        </div>

        {availableCelulas.length > 1 && (
          <div className="mt-4 pt-4 border-t border-slate-700/50 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-blue-400 mb-1">Filtrar por Célula:</p>
              <select
                value={selectedCelula}
                onChange={(e) => setSelectedCelula(e.target.value)}
                className="bg-slate-900 border border-slate-600 text-slate-200 rounded px-3 py-2 outline-none focus:border-blue-500 w-full md:w-64"
              >
                {availableCelulas.map(cel => (
                  <option key={cel} value={cel}>{cel}</option>
                ))}
              </select>
            </div>
          </div>
        )}
            
        {/* Nova Seção: Matriz de Volume Intradiário */}
        {stats?.matrizes_intervalo && stats.matrizes_intervalo[matrixPeriod] && (
          <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 mt-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 gap-4">
              <h3 className="text-lg font-semibold text-pink-400 flex items-center gap-2">
                <span>📊</span> Matriz de Distribuição Intradiária
              </h3>
              
              <div className="flex items-center gap-3">
                <div className="bg-slate-900 rounded-lg p-1 flex">
                  <button
                    onClick={() => setMatrixViewType('volume')}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${matrixViewType === 'volume' ? 'bg-pink-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                  >
                    Volume Bruto
                  </button>
                  <button
                    onClick={() => setMatrixViewType('peso')}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${matrixViewType === 'peso' ? 'bg-pink-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                  >
                    Pesos (%)
                  </button>
                  <button
                    onClick={() => setMatrixViewType('tmo')}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${matrixViewType === 'tmo' ? 'bg-pink-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                  >
                    TMA (s)
                  </button>
                </div>

                <select
                  value={matrixPeriod}
                  onChange={(e) => setMatrixPeriod(e.target.value)}
                  className="bg-slate-900 border border-slate-600 text-slate-200 rounded px-3 py-2 outline-none focus:border-pink-500 text-sm"
                >
                  <option value="completo">Histórico Completo</option>
                  {Object.keys(stats.matrizes_intervalo).filter(k => k !== 'completo').sort((a,b) => b.localeCompare(a)).map(mes => {
                    const [ano, m] = mes.split('-');
                    const nomeMes = new Date(parseInt(ano), parseInt(m) - 1, 1).toLocaleString('pt-BR', { month: 'short' });
                    return <option key={mes} value={mes}>{`${nomeMes.charAt(0).toUpperCase() + nomeMes.slice(1)} ${ano}`}</option>;
                  })}
                </select>
              </div>
            </div>
            
            <p className="text-sm text-slate-400 mb-4">
              {matrixViewType === 'volume' 
                ? "Soma de todos os intervalos do período selecionado por dia da semana." 
                : matrixViewType === 'peso'
                  ? "Percentual de volume alocado para cada intervalo no período selecionado."
                  : "Tempo Médio de Atendimento (em segundos) por intervalo."}
            </p>
            
            <div className="overflow-x-auto max-h-[500px] custom-scrollbar">
              <table className="w-full text-sm text-center text-slate-300">
                <thead className="text-xs text-slate-400 bg-slate-700/50 sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-2 text-left bg-slate-800">Intervalo</th>
                    <th className="px-3 py-2 bg-slate-800">Dom</th>
                    <th className="px-3 py-2 bg-slate-800">Seg</th>
                    <th className="px-3 py-2 bg-slate-800">Ter</th>
                    <th className="px-3 py-2 bg-slate-800">Qua</th>
                    <th className="px-3 py-2 bg-slate-800">Qui</th>
                    <th className="px-3 py-2 bg-slate-800">Sex</th>
                    <th className="px-3 py-2 bg-slate-800">Sáb</th>
                    <th className="px-3 py-2 text-pink-300 bg-slate-800">Total Geral</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(stats.matrizes_intervalo[matrixPeriod] || {})
                    .sort((a, b) => a.localeCompare(b))
                    .map(intervalo => {
                      const rowData = matrixViewType === 'tmo' 
                        ? (stats.matrizes_tmo?.[matrixPeriod]?.[intervalo] || {})
                        : stats.matrizes_intervalo![matrixPeriod][intervalo];
                      
                      const vals = [6, 0, 1, 2, 3, 4, 5].map(d => rowData[d.toString()] || 0); // Dom, Seg, Ter, Qua, Qui, Sex, Sab
                      const rowTotal = matrixViewType === 'tmo'
                        ? Math.round(vals.filter(v => v > 0).reduce((a,b)=>a+b, 0) / (vals.filter(v=>v>0).length || 1))
                        : vals.reduce((a, b) => a + b, 0);
                      
                      // Para calcular % corretamente, precisamos do total de cada dia.
                      // O backend fornece a curva consolidada em stats.curvas_distribuicao, mas a tabela exibe a % *daquele dia*?
                      // Se for Peso, vamos calcular com base na soma da coluna para aquele dia.
                      
                      return (
                        <tr key={intervalo} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                          <td className="px-3 py-1 text-left font-bold">{intervalo}</td>
                          {vals.map((val, idx) => {
                            const originalDayIdx = [6, 0, 1, 2, 3, 4, 5][idx];
                            // Se view type == peso, buscamos em stats.curvas_distribuicao se o período for 'completo', 
                            // Mas para não complicar, calcularemos o peso total no frontend ou mostramos o volume.
                            let displayVal = matrixViewType === 'tmo' 
                              ? Math.round(val).toString() 
                              : (Number.isInteger(val) ? val.toString() : val.toFixed(2));
                            if (matrixViewType === 'peso') {
                              // calcular a soma total daquela coluna
                              let colTotal = 0;
                              Object.values(stats.matrizes_intervalo![matrixPeriod]).forEach(r => colTotal += (r[originalDayIdx.toString()] || 0));
                              displayVal = colTotal > 0 ? ((val / colTotal) * 100).toFixed(2) + '%' : '0.00%';
                            }
                            return <td key={idx} className="px-3 py-1">{displayVal}</td>;
                          })}
                          <td className="px-3 py-1 font-bold text-pink-300">
                            {matrixViewType === 'peso' 
                              ? (() => {
                                  let grandTotal = 0;
                                  Object.values(stats.matrizes_intervalo![matrixPeriod]).forEach(r => {
                                    const sum = [0,1,2,3,4,5,6].reduce((acc, d) => acc + (r[d.toString()] || 0), 0);
                                    grandTotal += sum;
                                  });
                                  return grandTotal > 0 ? ((rowTotal / grandTotal) * 100).toFixed(2) + '%' : '0.00%';
                                })()
                              : (Number.isInteger(rowTotal) ? rowTotal : Number(rowTotal).toFixed(2))}
                          </td>
                        </tr>
                      );
                  })}
                  {/* Linha de Total Geral */}
                  {matrixViewType === 'volume' && (
                    <tr className="bg-slate-700/50 font-bold sticky bottom-0">
                      <td className="px-3 py-2 text-left">Total Geral</td>
                      {[6, 0, 1, 2, 3, 4, 5].map(day => {
                        let colTotal = 0;
                        Object.values(stats.matrizes_intervalo![matrixPeriod]).forEach(r => colTotal += (r[day.toString()] || 0));
                        return <td key={day} className="px-3 py-2 text-emerald-400">{Number.isInteger(colTotal) ? colTotal : colTotal.toFixed(2)}</td>;
                      })}
                      <td className="px-3 py-2 text-pink-400">
                        {(() => {
                          let grandTotal = 0;
                          Object.values(stats.matrizes_intervalo![matrixPeriod]).forEach(r => {
                            grandTotal += [0,1,2,3,4,5,6].reduce((acc, d) => acc + (r[d.toString()] || 0), 0);
                          });
                          return Number.isInteger(grandTotal) ? grandTotal : grandTotal.toFixed(2);
                        })()}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Gráfico Comparativo de Curvas Intradiárias */}
        {stats?.matrizes_intervalo && (
          <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 mt-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
              <h3 className="text-lg font-semibold text-blue-400 flex items-center gap-2">
                <span>📈</span> Comparativo de Curvas Intradiárias
              </h3>
              
              <div className="flex flex-col md:flex-row items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-400 font-semibold">Métrica:</span>
                  <div className="bg-slate-900 rounded-lg p-1 flex">
                    <button
                      onClick={() => setChartMetric('volume')}
                      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${chartMetric === 'volume' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                      Chamadas
                    </button>
                    <button
                      onClick={() => setChartMetric('peso')}
                      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${chartMetric === 'peso' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                      Pesos (%)
                    </button>
                    <button
                      onClick={() => setChartMetric('tmo')}
                      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${chartMetric === 'tmo' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                      TMA (s)
                    </button>
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-400 font-semibold">Dia da Semana:</span>
                  <select
                    value={chartDayView}
                    onChange={(e) => setChartDayView(e.target.value)}
                    className="bg-slate-900 border border-slate-600 text-slate-200 rounded px-3 py-1.5 outline-none focus:border-blue-500 text-sm"
                  >
                    <option value="consolidado">Consolidado (Geral)</option>
                    <option value="0">Segunda-feira</option>
                    <option value="1">Terça-feira</option>
                    <option value="2">Quarta-feira</option>
                    <option value="3">Quinta-feira</option>
                    <option value="4">Sexta-feira</option>
                    <option value="5">Sábado</option>
                    <option value="6">Domingo</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="mb-6 bg-slate-900/50 p-4 rounded-lg border border-slate-700/50">
              <p className="text-sm text-slate-400 font-semibold mb-3">Selecione os períodos para comparar:</p>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm cursor-pointer hover:text-blue-300 transition-colors">
                  <input 
                    type="checkbox" 
                    checked={chartPeriods.includes('completo')}
                    onChange={(e) => {
                      if (e.target.checked) setChartPeriods([...chartPeriods, 'completo']);
                      else setChartPeriods(chartPeriods.filter(p => p !== 'completo'));
                    }}
                    className="rounded border-slate-600 text-blue-500 focus:ring-blue-500 bg-slate-800"
                  />
                  <span>Histórico Completo</span>
                </label>
                {Object.keys(stats.matrizes_intervalo).filter(k => k !== 'completo').sort((a,b)=>b.localeCompare(a)).map(mes => {
                  const [ano, m] = mes.split('-');
                  const nomeMes = new Date(parseInt(ano), parseInt(m) - 1, 1).toLocaleString('pt-BR', { month: 'short' });
                  const label = `${nomeMes.charAt(0).toUpperCase() + nomeMes.slice(1)} ${ano}`;
                  return (
                    <label key={mes} className="flex items-center gap-2 text-sm cursor-pointer hover:text-blue-300 transition-colors">
                      <input 
                        type="checkbox" 
                        checked={chartPeriods.includes(mes)}
                        onChange={(e) => {
                          if (e.target.checked) setChartPeriods([...chartPeriods, mes]);
                          else setChartPeriods(chartPeriods.filter(p => p !== mes));
                        }}
                        className="rounded border-slate-600 text-blue-500 focus:ring-blue-500 bg-slate-800"
                      />
                      <span>{label}</span>
                    </label>
                  );
                })}
              </div>
              {chartPeriods.length === 0 && (
                <p className="text-xs text-red-400 mt-2">Selecione ao menos um período para exibir o gráfico.</p>
              )}
            </div>

            {chartPeriods.length > 0 && (
              <div className="h-96">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart 
                    data={(() => {
                      const allIntervals = new Set<string>();
                      chartPeriods.forEach(p => {
                        Object.keys(stats?.matrizes_intervalo?.[p] || {}).forEach(i => allIntervals.add(i));
                        if (stats?.matrizes_tmo) {
                          Object.keys(stats.matrizes_tmo[p] || {}).forEach(i => allIntervals.add(i));
                        }
                      });
                      
                      const intervals = Array.from(allIntervals).sort((a,b)=>a.localeCompare(b));
                      
                      return intervals.map(interv => {
                        const dataPoint: any = { intervalo: interv };
                        chartPeriods.forEach(p => {
                          if (chartMetric === 'tmo') {
                            const rowData = stats.matrizes_tmo?.[p]?.[interv] || {};
                            if (chartDayView === 'consolidado') {
                              const vals = [6,0,1,2,3,4,5].map(d => rowData[d.toString()] || 0);
                              const mean = vals.filter(v=>v>0).length > 0 ? vals.filter(v=>v>0).reduce((a,b)=>a+b,0) / vals.filter(v=>v>0).length : 0;
                              dataPoint[p] = Math.round(mean);
                            } else {
                              dataPoint[p] = Math.round(rowData[chartDayView] || 0);
                            }
                          } else if (chartMetric === 'volume') {
                            const rowData = stats.matrizes_intervalo?.[p]?.[interv] || {};
                            if (chartDayView === 'consolidado') {
                              const sum = [6,0,1,2,3,4,5].map(d => rowData[d.toString()] || 0).reduce((a,b)=>a+b, 0);
                              dataPoint[p] = sum;
                            } else {
                              dataPoint[p] = rowData[chartDayView] || 0;
                            }
                          } else if (chartMetric === 'peso') {
                            const rowData = stats.matrizes_intervalo?.[p]?.[interv] || {};
                            if (chartDayView === 'consolidado') {
                              const rowSum = [6,0,1,2,3,4,5].map(d => rowData[d.toString()] || 0).reduce((a,b)=>a+b, 0);
                              let grandTotal = 0;
                              Object.values(stats.matrizes_intervalo?.[p] || {}).forEach(r => {
                                grandTotal += [0,1,2,3,4,5,6].reduce((acc, d) => acc + ((r as any)[d.toString()] || 0), 0);
                              });
                              dataPoint[p] = grandTotal > 0 ? Number(((rowSum / grandTotal) * 100).toFixed(2)) : 0;
                            } else {
                              const rowVal = rowData[chartDayView] || 0;
                              let colTotal = 0;
                              Object.values(stats.matrizes_intervalo?.[p] || {}).forEach(r => {
                                colTotal += ((r as any)[chartDayView] || 0);
                              });
                              dataPoint[p] = colTotal > 0 ? Number(((rowVal / colTotal) * 100).toFixed(2)) : 0;
                            }
                          }
                        });
                        return dataPoint;
                      });
                    })()}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                    <XAxis
                      dataKey="intervalo"
                      stroke="#94a3b8"
                      fontSize={12}
                      tickMargin={10}
                    />
                    <YAxis
                      stroke="#94a3b8"
                      fontSize={12}
                      tickFormatter={(value) => chartMetric === 'peso' ? `${value}%` : `${value}`}
                    />
                    <RechartsTooltip
                      contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '0.5rem' }}
                      itemStyle={{ color: '#e2e8f0' }}
                    />
                    <Legend />
                    {chartPeriods.map((period, index) => {
                      const isCompleto = period === 'completo';
                      const label = isCompleto ? 'Histórico Completo' : (() => {
                        const [ano, m] = period.split('-');
                        const nm = new Date(parseInt(ano), parseInt(m) - 1, 1).toLocaleString('pt-BR', { month: 'short' });
                        return `${nm.charAt(0).toUpperCase() + nm.slice(1)} ${ano}`;
                      })();
                      
                      // Usar uma paleta de cores baseada no índice
                      const colors = ['#3b82f6', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899'];
                      const color = isCompleto ? '#3b82f6' : colors[(index % (colors.length - 1)) + 1];

                      return (
                        <Line
                          key={period}
                          type="monotone"
                          dataKey={period}
                          name={label}
                          stroke={color}
                          strokeWidth={isCompleto ? 3 : 2}
                          strokeDasharray={isCompleto ? "" : "5 5"}
                          dot={{ fill: color, strokeWidth: 2, r: 3 }}
                          activeDot={{ r: 6 }}
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}


      <div className="mt-4 pt-4 border-t border-slate-700/50">
        <p className="text-sm text-slate-400 mb-2">Considerar no histórico os seguintes dias da semana:</p>
        <div className="flex flex-wrap gap-3">
          {[
            { id: 0, label: 'Segunda' },
            { id: 1, label: 'Terça' },
            { id: 2, label: 'Quarta' },
            { id: 3, label: 'Quinta' },
            { id: 4, label: 'Sexta' },
            { id: 5, label: 'Sábado' },
            { id: 6, label: 'Domingo' }
          ].map(day => (
            <label key={day.id} className="flex items-center gap-2 cursor-pointer bg-slate-700/30 px-3 py-1.5 rounded-md hover:bg-slate-700/50 transition-colors">
              <input
                type="checkbox"
                className="rounded bg-slate-900 border-slate-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-800"
                checked={selectedTrainDays.includes(day.id)}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelectedTrainDays([...selectedTrainDays, day.id]);
                  } else {
                    setSelectedTrainDays(selectedTrainDays.filter(d => d !== day.id));
                  }
                }}
              />
              <span className="text-sm font-medium text-slate-300">{day.label}</span>
            </label>
          ))}
        </div>
      </div>

      {availableYears.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold mb-3 text-slate-300">Anos para Treinamento da Inteligência Artificial</h3>
          <div className="flex flex-wrap gap-3">
            {availableYears.map(year => (
              <label key={year} className="flex items-center gap-2 cursor-pointer bg-slate-700/30 px-3 py-1.5 rounded-md hover:bg-slate-700/50 transition-colors">
                <input
                  type="checkbox"
                  className="rounded bg-slate-900 border-slate-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-800"
                  checked={selectedTrainYears.includes(year)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedTrainYears([...selectedTrainYears, year].sort());
                    } else {
                      setSelectedTrainYears(selectedTrainYears.filter(y => y !== year));
                    }
                  }}
                />
                <span className="text-sm font-medium text-slate-300">{year}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-2">
            Desmarque anos muito antigos ou atípicos para evitar que distorçam a projeção atual.
          </p>
        </div>
      )}



      {uploadStatus && (
        <div className="mt-4 text-sm text-blue-400 bg-blue-900/20 p-3 rounded-lg border border-blue-800/50">
          {uploadStatus}
        </div>
      )}
    </div>

      {
    forecastData.length > 0 && (
      <>
        {/* TABS NAVIGATION */}
        <div className="flex space-x-2 border-b border-slate-700 mb-6">
          <button
            onClick={() => setActiveTab('forecast')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${activeTab === 'forecast' ? 'border-blue-500 text-blue-500' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            Forecast & Curvas
          </button>
          <button
            onClick={() => setActiveTab('calendario')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${activeTab === 'calendario' ? 'border-blue-500 text-blue-500' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            Motor de Calendário
          </button>
          <button
            onClick={() => setActiveTab('historico')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${activeTab === 'historico' ? 'border-blue-500 text-blue-500' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            Histórico Anual & Variação
          </button>
          <button
            onClick={() => setActiveTab('baseline')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${activeTab === 'baseline' ? 'border-blue-500 text-blue-500' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            Baseline & Fatores
          </button>
          <button
            onClick={() => setActiveTab('previsao_mensal')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${activeTab === 'previsao_mensal' ? 'border-blue-500 text-blue-500' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            Previsão Mensal
          </button>
          <button
            onClick={() => setActiveTab('dimensionamento')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${activeTab === 'dimensionamento' ? 'border-orange-500 text-orange-500' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            Dimensionamento (Erlang)
          </button>
          <button
            onClick={() => setActiveTab('metodologia')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${activeTab === 'metodologia' ? 'border-blue-500 text-blue-500' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            Metodologia de Forecast
          </button>
          <button
            onClick={() => setActiveTab('cenarios')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${activeTab === 'cenarios' ? 'border-emerald-500 text-emerald-500' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            Cenários Salvos
          </button>
          <button
            onClick={() => setActiveTab('shrinkage')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${activeTab === 'shrinkage' ? 'border-rose-500 text-rose-500' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            Shrinkage
          </button>
          <button
            onClick={() => setActiveTab('whatif')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${activeTab === 'whatif' ? 'border-cyan-500 text-cyan-500' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            What-If
          </button>
          <button
            onClick={() => setActiveTab('rotacao')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${activeTab === 'rotacao' ? 'border-violet-500 text-violet-500' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            Rotação
          </button>
        </div>

        {activeTab === 'cenarios' && (
          <>
            <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
              <div className="flex justify-between items-center mb-6 border-b border-slate-700/50 pb-4">
                <h2 className="text-xl font-bold text-emerald-400 flex items-center gap-2">
                  <span>💾</span> Meus Cenários Salvos
                </h2>
                <button
                  onClick={generateAutoScenarios}
                  className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg font-medium shadow-lg transition-colors flex items-center gap-2"
                >
                  ✨ Sugerir Cenários (IA)
                </button>
              </div>
              {scenarios.length === 0 ? (
                <p className="text-slate-400 text-center py-10">Você ainda não salvou nenhum cenário.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-700 text-slate-400 text-sm">
                        <th className="py-3 px-4">Nome do Cenário</th>
                        <th className="py-3 px-4">Salvo em</th>
                        <th className="py-3 px-4">Mês Projetado</th>
                        <th className="py-3 px-4">Flutuação / Incremento</th>
                        <th className="py-3 px-4">Volume Projetado</th>
                        <th className="py-3 px-4 text-right">Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scenarios.map(s => (
                        <tr key={s.id} className="border-b border-slate-700/50 hover:bg-slate-700/20 transition-colors">
                          <td className="py-4 px-4 font-medium text-slate-200">{s.name}</td>
                          <td className="py-4 px-4 text-sm text-slate-400">{s.date}</td>
                          <td className="py-4 px-4 text-sm text-blue-300">{s.month}/{s.year}</td>
                          <td className="py-4 px-4 text-sm text-slate-300">
                            {s.flutuacao > 0 ? `+${s.flutuacao}` : s.flutuacao}% / {s.incremento > 0 ? `+${s.incremento}` : s.incremento}%
                          </td>
                          <td className="py-4 px-4 font-bold text-emerald-400">{s.volume.toLocaleString()}</td>
                          <td className="py-4 px-4 text-right">
                            <div className="flex justify-end gap-2">
                              <button onClick={() => loadScenario(s)} className="px-3 py-1 bg-blue-600/20 text-blue-400 hover:bg-blue-600/40 rounded text-xs font-medium transition-colors">
                                Carregar
                              </button>
                              <button onClick={() => deleteScenario(s.id)} className="px-3 py-1 bg-red-600/20 text-red-400 hover:bg-red-600/40 rounded text-xs font-medium transition-colors">
                                Excluir
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 mt-6">
              <div className="flex justify-between items-center mb-6 border-b border-slate-700/50 pb-4">
                <h2 className="text-xl font-bold text-orange-400 flex items-center gap-2">
                  <span>👥</span> Cenários de Dimensionamento (Erlang)
                </h2>
              </div>
              {staffingScenarios.length === 0 ? (
                <p className="text-slate-400 text-center py-10">Você ainda não salvou nenhum cenário de dimensionamento.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-700 text-slate-400 text-sm">
                        <th className="py-3 px-4">Nome do Cenário</th>
                        <th className="py-3 px-4">Data Alvo</th>
                        <th className="py-3 px-4">Estratégia SLA</th>
                        <th className="py-3 px-4 text-center">HC Total</th>
                        <th className="py-3 px-4 text-center">PAs Máx</th>
                        <th className="py-3 px-4 text-right">Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {staffingScenarios.map(s => (
                        <tr key={s.id} className="border-b border-slate-700/50 hover:bg-slate-700/20 transition-colors">
                          <td className="py-4 px-4 font-medium text-slate-200">{s.name}</td>
                          <td className="py-4 px-4 text-sm text-blue-300">{new Date(s.targetDate + "T00:00:00").toLocaleDateString('pt-BR')}</td>
                          <td className="py-4 px-4 text-sm text-emerald-400 font-semibold">{s.strategy}</td>
                          <td className="py-4 px-4 text-center font-bold text-amber-400">{s.totalMonthlyHC}</td>
                          <td className="py-4 px-4 text-center font-bold text-slate-300">{s.peakPAs}</td>
                          <td className="py-4 px-4 text-right">
                            <div className="flex justify-end gap-2">
                              <button onClick={() => loadStaffingScenario(s)} className="px-3 py-1 bg-orange-600/20 text-orange-400 hover:bg-orange-600/40 rounded text-xs font-medium transition-colors">
                                Carregar
                              </button>
                              <button onClick={() => deleteStaffingScenario(s.id)} className="px-3 py-1 bg-red-600/20 text-red-400 hover:bg-red-600/40 rounded text-xs font-medium transition-colors">
                                Excluir
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === 'forecast' && (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                <div className="flex items-center gap-4">
                  <div className="p-3 bg-blue-500/10 rounded-lg text-blue-500">
                    <CalendarDays size={24} />
                  </div>
                  <div>
                    <p className="text-slate-400 text-sm">Data Base</p>
                    <p className="text-2xl font-bold">{currentDayForecast.data}</p>
                  </div>
                </div>
              </div>

              <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                <div className="flex items-center gap-4">
                  <div className="p-3 bg-purple-500/10 rounded-lg text-purple-500">
                    <Activity size={24} />
                  </div>
                  <div>
                    <p className="text-slate-400 text-sm">Volume Projetado (Dia)</p>
                    <p className="text-2xl font-bold">{currentDayForecast.volume_total.toLocaleString()}</p>
                  </div>
                </div>
              </div>

              <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                <div className="flex items-center gap-4">
                  <div className="p-3 bg-emerald-500/10 rounded-lg text-emerald-500">
                    <Clock size={24} />
                  </div>
                  <div>
                    <p className="text-slate-400 text-sm">TMO Médio</p>
                    <p className="text-2xl font-bold">{currentDayForecast.tmo_medio} seg</p>
                  </div>
                </div>
              </div>

              {stats && (
                <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                  <div className="flex items-center gap-4">
                    <div className="p-3 bg-amber-500/10 rounded-lg text-amber-500">
                      <TrendingUp size={24} />
                    </div>
                    <div>
                      <p className="text-slate-400 text-sm">Maior Dia Histórico</p>
                      <p className="text-2xl font-bold">{stats.max_volume_day.volume.toLocaleString()}</p>
                      <p className="text-xs text-slate-500">{stats.max_volume_day.data}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Curva Intra-diária */}
              <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                <h3 className="text-lg font-semibold mb-6">Curva Diária (Intervalos)</h3>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={currentDayForecastWithPeso}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                      <XAxis
                        dataKey="intervalo"
                        stroke="#94a3b8"
                        fontSize={12}
                        tickMargin={10}
                      />
                      <YAxis
                        stroke="#94a3b8"
                        fontSize={12}
                        tickFormatter={(value) => `${value}%`}
                      />
                      <RechartsTooltip
                        contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '0.5rem' }}
                        itemStyle={{ color: '#e2e8f0' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="peso"
                        name="Peso do Volume (%)"
                        stroke="#8b5cf6"
                        strokeWidth={3}
                        dot={{ fill: '#8b5cf6', strokeWidth: 2, r: 4 }}
                        activeDot={{ r: 6 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Previsão dos Próximos 7 Dias */}
              <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                <h3 className="text-lg font-semibold mb-6">Volume Previsto (Próximos Dias)</h3>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={forecastData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                      <XAxis
                        dataKey="data"
                        stroke="#94a3b8"
                        fontSize={12}
                        tickMargin={10}
                        tickFormatter={(val) => {
                          const date = new Date(val);
                          return `${date.getDate()}/${date.getMonth() + 1}`;
                        }}
                      />
                      <YAxis
                        stroke="#94a3b8"
                        fontSize={12}
                      />
                      <RechartsTooltip
                        contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '0.5rem' }}
                        cursor={{ fill: '#334155', opacity: 0.4 }}
                      />
                      <Bar
                        dataKey="volume_total"
                        fill="#3b82f6"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Análises Históricas Detalhadas (Planilha) */}
            {stats && (
              <div className="space-y-6 mt-8">
                <h2 className="text-2xl font-bold border-b border-slate-700 pb-2">Análises Históricas da Planilha</h2>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

                  {/* Tabela: Visão por Semana */}
                  <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 overflow-x-auto">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-lg font-semibold text-slate-200">Visão por Semana</h3>
                      <select
                        className="bg-slate-900 border border-slate-700 text-slate-300 rounded-lg px-3 py-1.5 text-sm focus:ring-blue-500 focus:border-blue-500 outline-none"
                        value={selectedVisaoSemanaMonth}
                        onChange={(e) => setSelectedVisaoSemanaMonth(e.target.value)}
                      >
                        <option value="all">Todos os Meses</option>
                        {Array.from(new Set(stats.visao_semana.map((r: any) => `${r.ano} - ${r.mes}`))).map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    </div>
                    <table className="w-full text-sm text-left text-slate-300">
                      <thead className="text-xs text-slate-400 bg-slate-700/50">
                        <tr>
                          <th className="px-4 py-2">Ano</th>
                          <th className="px-4 py-2">Mês</th>
                          <th className="px-4 py-2 text-center">Semana</th>
                          <th className="px-4 py-2">Seg</th>
                          <th className="px-4 py-2">Ter</th>
                          <th className="px-4 py-2">Qua</th>
                          <th className="px-4 py-2">Qui</th>
                          <th className="px-4 py-2">Sex</th>
                          <th className="px-4 py-2">Sáb</th>
                          <th className="px-4 py-2">Dom</th>
                          <th className="px-4 py-2 font-bold text-white">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.visao_semana
                          .filter((row: any) => selectedVisaoSemanaMonth === 'all' || `${row.ano} - ${row.mes}` === selectedVisaoSemanaMonth)
                          .map((row: any, i: number) => (
                            <tr key={i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                              <td className="px-4 py-2 font-bold">{row.ano}</td>
                              <td className="px-4 py-2 font-medium">{row.mes}</td>
                              <td className="px-4 py-2 font-medium text-center">{row.semana}</td>
                              <td className="px-4 py-2">{row.seg.toLocaleString()}</td>
                              <td className="px-4 py-2">{row.ter.toLocaleString()}</td>
                              <td className="px-4 py-2">{row.qua.toLocaleString()}</td>
                              <td className="px-4 py-2">{row.qui.toLocaleString()}</td>
                              <td className="px-4 py-2">{row.sex.toLocaleString()}</td>
                              <td className="px-4 py-2">{row.sab.toLocaleString()}</td>
                              <td className="px-4 py-2">{row.dom.toLocaleString()}</td>
                              <td className="px-4 py-2 font-bold text-white bg-slate-700/20">{row.total.toLocaleString()}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Tabela: Ranking Dias */}
                    <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 overflow-x-auto">
                      <h3 className="text-lg font-semibold mb-4 text-slate-200">Visão por Semana (Ranking)</h3>
                      <table className="w-full text-sm text-left text-slate-300">
                        <thead className="text-xs text-slate-400 bg-slate-700/50">
                          <tr>
                            <th className="px-3 py-2">#</th>
                            <th className="px-3 py-2">Data</th>
                            <th className="px-3 py-2">Sem.</th>
                            <th className="px-3 py-2">Volume</th>
                            <th className="px-3 py-2">%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.ranking_dias.map((row, i) => (
                            <tr key={i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                              <td className="px-3 py-2">{i + 1}</td>
                              <td className="px-3 py-2">{row.data_str}</td>
                              <td className="px-3 py-2 capitalize">{row.dia_semana_str.slice(0, 3)}</td>
                              <td className="px-3 py-2 font-medium">{row.volume.toLocaleString()}</td>
                              <td className="px-3 py-2 text-slate-400">{row.percentual}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Tabela: Visão por Quinzena */}
                    <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 overflow-x-auto">
                      <h3 className="text-lg font-semibold mb-4 text-slate-200">Visão por Quinzena</h3>
                      <table className="w-full text-sm text-left text-slate-300">
                        <thead className="text-xs text-slate-400 bg-slate-700/50">
                          <tr>
                            <th className="px-4 py-2">Quinzena</th>
                            <th className="px-4 py-2">Volume</th>
                            <th className="px-4 py-2">%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.visao_quinzena.map((row, i) => (
                            <tr key={i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                              <td className="px-4 py-2">{row.quinzena}</td>
                              <td className="px-4 py-2 font-medium">{row.volume.toLocaleString()}</td>
                              <td className="px-4 py-2 text-slate-400">{row.percentual}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                </div>

                {/* Gráfico Comparativo Curvas */}
                <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 mt-6">
                  <h3 className="text-lg font-semibold mb-6">Comparativo de Curvas</h3>
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={stats.comparativo_curvas}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                        <XAxis dataKey="dia" stroke="#94a3b8" fontSize={12} tickMargin={10} />
                        <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={(val) => `${(val / 1000).toFixed(1)}k`} />
                        <RechartsTooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '0.5rem' }} />
                        <Legend />
                        <Line type="monotone" dataKey="m_geo" name="M. Geo" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                        <Line type="monotone" dataKey="quartil" name="Quartil" stroke="#10b981" strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                        <Line type="monotone" dataKey="desvio_p" name="Desvio P" stroke="#94a3b8" strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'calendario' && stats && (
          <div className="space-y-6 mt-8">
            <h2 className="text-2xl font-bold border-b border-slate-700 pb-2">Motor de Calendário e Dias Úteis</h2>
            <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 overflow-x-auto">
              <table className="w-full text-sm text-left text-slate-300">
                <thead className="text-xs text-slate-400 bg-slate-700/50">
                  <tr>
                    <th className="px-4 py-2">Ano</th>
                    <th className="px-4 py-2">Mês</th>
                    <th className="px-3 py-2 text-center">Dias</th>
                    <th className="px-3 py-2 text-center">Dias Úteis</th>
                    <th className="px-3 py-2 text-center">Feriados</th>
                    <th className="px-3 py-2 text-center">Seg</th>
                    <th className="px-3 py-2 text-center">Ter</th>
                    <th className="px-3 py-2 text-center">Qua</th>
                    <th className="px-3 py-2 text-center">Qui</th>
                    <th className="px-3 py-2 text-center">Sex</th>
                    <th className="px-3 py-2 text-center">Sáb</th>
                    <th className="px-3 py-2 text-center">Dom</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.calendario.map((row, i) => (
                    <tr key={i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                      <td className="px-4 py-2 font-medium">{row.ano}</td>
                      <td className="px-4 py-2">{row.mes}</td>
                      <td className="px-3 py-2 text-center font-bold text-slate-200">{row.dias}</td>
                      <td className="px-3 py-2 text-center text-blue-400 font-bold">{row.du}</td>
                      <td className="px-3 py-2 text-center text-red-400 font-bold">{row.feriados}</td>
                      <td className="px-3 py-2 text-center">{row.seg}</td>
                      <td className="px-3 py-2 text-center">{row.ter}</td>
                      <td className="px-3 py-2 text-center">{row.qua}</td>
                      <td className="px-3 py-2 text-center">{row.qui}</td>
                      <td className="px-3 py-2 text-center">{row.sex}</td>
                      <td className="px-3 py-2 text-center text-slate-500">{row.sab}</td>
                      <td className="px-3 py-2 text-center text-slate-500">{row.dom}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'historico' && stats && (
          <div className="space-y-6 mt-8">
            <h2 className="text-2xl font-bold border-b border-slate-700 pb-2">Histórico Anual (Volume Total)</h2>
            <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 overflow-x-auto">
              <table className="w-full text-sm text-center text-slate-300">
                <thead className="text-xs text-slate-400 bg-slate-700/50">
                  <tr>
                    <th className="px-3 py-2 text-left">Ano</th>
                    <th className="px-2 py-2">Jan</th><th className="px-2 py-2">Fev</th><th className="px-2 py-2">Mar</th>
                    <th className="px-2 py-2">Abr</th><th className="px-2 py-2">Mai</th><th className="px-2 py-2">Jun</th>
                    <th className="px-2 py-2">Jul</th><th className="px-2 py-2">Ago</th><th className="px-2 py-2">Set</th>
                    <th className="px-2 py-2">Out</th><th className="px-2 py-2">Nov</th><th className="px-2 py-2">Dez</th>
                    <th className="px-3 py-2 font-bold text-white text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.historico_anual.map((row, i) => (
                    <tr key={i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                      <td className="px-3 py-2 text-left font-bold">{row.ano}</td>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => {
                        const val = row[`mes_${m}` as keyof typeof row] as number;
                        const isProj = row[`is_proj_${m}` as keyof typeof row] as boolean;
                        return (
                          <td key={m} className={`px-2 py-2 ${isProj ? 'text-emerald-400 font-semibold' : ''}`} title={isProj ? "Projeção do Algoritmo Campeão" : ""}>
                            {val > 0 ? (
                              <>
                                {val.toLocaleString()}
                                {isProj && <span className="ml-1 text-[10px] opacity-75">*</span>}
                              </>
                            ) : 0}
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-right font-bold text-blue-400 bg-slate-700/20">{row.total.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2 className="text-2xl font-bold border-b border-slate-700 pb-2 mt-8">Variação Mês a Mês (% Desv.)</h2>
            <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 overflow-x-auto mt-4">
              <table className="w-full text-sm text-center text-slate-300">
                <thead className="text-xs text-slate-400 bg-slate-700/50">
                  <tr>
                    <th className="px-3 py-2 text-left">Ano</th>
                    <th className="px-2 py-2">Jan</th><th className="px-2 py-2">Fev</th><th className="px-2 py-2">Mar</th>
                    <th className="px-2 py-2">Abr</th><th className="px-2 py-2">Mai</th><th className="px-2 py-2">Jun</th>
                    <th className="px-2 py-2">Jul</th><th className="px-2 py-2">Ago</th><th className="px-2 py-2">Set</th>
                    <th className="px-2 py-2">Out</th><th className="px-2 py-2">Nov</th><th className="px-2 py-2">Dez</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.variacao_anual.map((row, i) => (
                    <tr key={i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                      <td className="px-3 py-2 text-left font-bold">{row.ano}</td>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => {
                        const val = row[`mes_${m}` as keyof typeof row] as number;
                        const colorClass = val > 0 ? 'text-emerald-400' : val < 0 ? 'text-red-400' : 'text-slate-500';
                        return (
                          <td key={m} className={`px-2 py-2 ${colorClass} font-medium`}>
                            {val !== 0 ? `${val > 0 ? '+' : ''}${val.toFixed(1)}%` : '-'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'baseline' && stats && (
          <div className="space-y-6 mt-8">
            <h2 className="text-2xl font-bold border-b border-slate-700 pb-2">Histórico Semanal - Absoluto & Fatores</h2>
            <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 overflow-x-auto">
              <p className="text-red-400 font-bold mb-4">Escolha os meses para calcular o Baseline de Forecast.</p>
              <table className="w-full text-sm text-center text-slate-300">
                <thead className="text-xs text-slate-400 bg-slate-700/50">
                  <tr>
                    <th className="px-3 py-2 text-left">Dia</th>
                    {stats.baseline_meses.map(b => (
                      <th key={b.ano_mes} className="px-3 py-2">
                        <label className="flex flex-col items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedMonths.includes(b.ano_mes)}
                            onChange={(e) => {
                              if (e.target.checked) setSelectedMonths([...selectedMonths, b.ano_mes]);
                              else setSelectedMonths(selectedMonths.filter(m => m !== b.ano_mes));
                            }}
                            className="mb-1"
                          />
                          {b.mes}/{b.ano}
                        </label>
                      </th>
                    ))}
                    <th className="px-3 py-2 border-l border-slate-600">M. Geo</th>
                    <th className="px-3 py-2">Pond.</th>
                    <th className="px-3 py-2">M. DU</th>
                    <th className="px-3 py-2">E. Calend.</th>
                    <th className="px-3 py-2 border-l border-slate-600">M. Geo %</th>
                    <th className="px-3 py-2">Pond. %</th>
                    <th className="px-3 py-2">M. DU %</th>
                    <th className="px-3 py-2">E. Calend. %</th>
                  </tr>
                </thead>
                <tbody>
                  {['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].map((dayKey) => {
                    const dayLabel = dayKey === 'seg' ? 'Seg' : dayKey === 'ter' ? 'Ter' : dayKey === 'qua' ? 'Qua' : dayKey === 'qui' ? 'Qui' : dayKey === 'sex' ? 'Sex' : dayKey === 'sab' ? 'Sáb' : 'Dom';
                    return (
                      <tr key={dayKey} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                        <td className="px-3 py-2 text-left font-bold">{dayLabel}</td>
                        {stats.baseline_meses.map(b => (
                          <td key={b.ano_mes} className="px-3 py-2">{(b as any)[dayKey].toLocaleString()}</td>
                        ))}
                        <td className="px-3 py-2 font-medium border-l border-slate-600">{(mGeoBase as any)[dayKey].toLocaleString()}</td>
                        <td className="px-3 py-2 font-medium">{(pondBase as any)[dayKey].toLocaleString()}</td>
                        <td className="px-3 py-2 font-medium">{(mDuBase as any)[dayKey].toLocaleString()}</td>
                        <td className="px-3 py-2 font-medium">{(eCalendBase as any)[dayKey].toLocaleString()}</td>
                        <td className="px-3 py-2 text-blue-300 border-l border-slate-600">{getPercent((mGeoBase as any)[dayKey], mGeoBase.total)}</td>
                        <td className="px-3 py-2 text-blue-300">{getPercent((pondBase as any)[dayKey], pondBase.total)}</td>
                        <td className="px-3 py-2 text-blue-300">{getPercent((mDuBase as any)[dayKey], mDuBase.total)}</td>
                        <td className="px-3 py-2 text-blue-300">{getPercent((eCalendBase as any)[dayKey], eCalendBase.total)}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-b border-slate-700/50 bg-slate-700/20 font-bold text-white">
                    <td className="px-3 py-2 text-left">Total</td>
                    {stats.baseline_meses.map(b => {
                      const sumDays = b.seg + b.ter + b.qua + b.qui + b.sex + b.sab + b.dom;
                      return <td key={b.ano_mes} className="px-3 py-2">{sumDays.toLocaleString()}</td>;
                    })}
                    <td className="px-3 py-2 border-l border-slate-600">{mGeoBase.total.toLocaleString()}</td>
                    <td className="px-3 py-2">{pondBase.total.toLocaleString()}</td>
                    <td className="px-3 py-2">{mDuBase.total.toLocaleString()}</td>
                    <td className="px-3 py-2">{eCalendBase.total.toLocaleString()}</td>
                    <td className="px-3 py-2 border-l border-slate-600">100%</td>
                    <td className="px-3 py-2">100%</td>
                    <td className="px-3 py-2">100%</td>
                    <td className="px-3 py-2">100%</td>
                  </tr>
                </tbody>
              </table>

              <div className="mt-8 flex flex-col lg:flex-row gap-8">
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <label className="text-sm font-medium w-60">Flutuação do Volume Histórico (%)</label>
                    <input
                      type="number"
                      value={flutuacao}
                      onChange={(e) => setFlutuacao(Number(e.target.value))}
                      className="bg-slate-700 border border-slate-600 rounded px-3 py-1 w-24 text-right"
                    />
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="text-sm font-medium w-60 text-red-400">Incremento de Fatores Históricos (%)</label>
                    <input
                      type="number"
                      value={incremento}
                      onChange={(e) => setIncremento(Number(e.target.value))}
                      className="bg-slate-700 border border-slate-600 rounded px-3 py-1 w-24 text-right text-red-400"
                    />
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-bold text-center mb-2">Absoluto + % Var. (Resultado Forecast Mês Alvo)</h4>
                  <table className="text-sm text-center bg-slate-900 border border-slate-600 w-full">
                    <thead>
                      <tr>
                        <th className="px-4 py-2 border border-slate-600 text-left">Dia</th>
                        <th className="px-4 py-2 border border-slate-600">M. Geo</th>
                        <th className="px-4 py-2 border border-slate-600">Pond.</th>
                        <th className="px-4 py-2 border border-slate-600">M. DU</th>
                        <th className="px-4 py-2 border border-slate-600">E. Calend.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].map((dayKey) => {
                        const dayLabel = dayKey === 'seg' ? 'Seg' : dayKey === 'ter' ? 'Ter' : dayKey === 'qua' ? 'Qua' : dayKey === 'qui' ? 'Qui' : dayKey === 'sex' ? 'Sex' : dayKey === 'sab' ? 'Sáb' : 'Dom';
                        return (
                          <tr key={dayKey} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                            <td className="px-4 py-2 border border-slate-600 text-left font-bold">{dayLabel}</td>
                            <td className="px-4 py-2 border border-slate-600">{applyFactors((mGeoBase as any)[dayKey]).toLocaleString()}</td>
                            <td className="px-4 py-2 border border-slate-600">{applyFactors((pondBase as any)[dayKey]).toLocaleString()}</td>
                            <td className="px-4 py-2 border border-slate-600">{applyFactors((mDuBase as any)[dayKey]).toLocaleString()}</td>
                            <td className="px-4 py-2 border border-slate-600">{applyFactors((eCalendBase as any)[dayKey]).toLocaleString()}</td>
                          </tr>
                        );
                      })}
                      <tr className="font-bold text-blue-400 bg-slate-700/20">
                        <td className="px-4 py-2 border border-slate-600 text-left">Total</td>
                        <td className="px-4 py-2 border border-slate-600">
                          {['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].reduce((acc, d) => acc + applyFactors((mGeoBase as any)[d]), 0).toLocaleString()}
                        </td>
                        <td className="px-4 py-2 border border-slate-600">
                          {['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].reduce((acc, d) => acc + applyFactors((pondBase as any)[d]), 0).toLocaleString()}
                        </td>
                        <td className="px-4 py-2 border border-slate-600">
                          {['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].reduce((acc, d) => acc + applyFactors((mDuBase as any)[d]), 0).toLocaleString()}
                        </td>
                        <td className="px-4 py-2 border border-slate-600">
                          {['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].reduce((acc, d) => acc + applyFactors((eCalendBase as any)[d]), 0).toLocaleString()}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'previsao_mensal' && (
          <div className="space-y-6 mt-8">
            <h2 className="text-2xl font-bold border-b border-slate-700 pb-2">Previsão Mensal</h2>

            <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 flex flex-col md:flex-row items-end gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Mês</label>
                <select
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(Number(e.target.value))}
                  className="bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white w-full md:w-40"
                >
                  {[...Array(12)].map((_, i) => (
                    <option key={i + 1} value={i + 1}>{new Date(0, i).toLocaleString('pt-BR', { month: 'long' })}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Ano</label>
                <input
                  type="number"
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(Number(e.target.value))}
                  className="bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white w-full md:w-32"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Dia da Semana</label>
                <select
                  value={selectedWeekday}
                  onChange={(e) => setSelectedWeekday(e.target.value)}
                  className="bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white w-full md:w-40"
                >
                  <option value="all">Todos os Dias</option>
                  <option value="1">Segunda-feira</option>
                  <option value="2">Terça-feira</option>
                  <option value="3">Quarta-feira</option>
                  <option value="4">Quinta-feira</option>
                  <option value="5">Sexta-feira</option>
                  <option value="6">Sábado</option>
                  <option value="0">Domingo</option>
                </select>
              </div>
              <button
                onClick={loadMonthForecast}
                disabled={loading}
                className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded-lg font-medium transition-all disabled:opacity-50 h-10"
              >
                {loading ? "Calculando..." : "Gerar Previsão"}
              </button>
            </div>

            {monthForecastData.length > 0 && stats?.metodologia && (
              <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-indigo-700/40">
                <h3 className="text-lg font-semibold mb-4 text-indigo-300 flex items-center gap-2">
                  <span>📋</span> Regras Aplicadas na Projeção
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
                  <div className="space-y-3">
                    <div>
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Algoritmo (Volume)</p>
                      <p className="text-slate-200 font-medium">{stats.metodologia.algoritmo_volume}</p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Algoritmo (TMO)</p>
                      <p className="text-slate-200 font-medium">{stats.metodologia.algoritmo_tmo}</p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Variáveis Preditoras</p>
                      <div className="flex flex-wrap gap-2">
                        {stats.metodologia.features.map(f => (
                          <span key={f} className="bg-indigo-900/50 text-indigo-300 px-2 py-0.5 rounded text-xs">{f}</span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Importância das Variáveis</p>
                      {Object.entries(stats.metodologia.importancia_features).map(([feat, pct]) => (
                        <div key={feat} className="flex items-center gap-2 mb-1">
                          <span className="text-slate-400 w-28">{feat}</span>
                          <div className="flex-1 bg-slate-700 rounded-full h-2">
                            <div className="bg-indigo-500 h-2 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-indigo-300 w-10 text-right">{pct}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Período Histórico</p>
                      <p className="text-slate-200 font-medium">{stats.metodologia.periodo_historico}</p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Dias Treinados / Outliers Removidos</p>
                      <p className="text-slate-200 font-medium">
                        <span className="text-emerald-400">{stats.metodologia.dias_treinamento} dias</span>
                        <span className="text-slate-500 mx-2">/</span>
                        <span className="text-amber-400">{stats.metodologia.outliers_removidos} removidos</span>
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Remoção de Outliers</p>
                      <p className="text-slate-200 font-medium">{stats.metodologia.outlier_metodo}</p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Curva Intra-diária</p>
                      <p className="text-slate-200 font-medium">{stats.metodologia.curva_diaria_fonte}</p>
                    </div>
                    <div>
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Fonte do TMO</p>
                      <p className="text-slate-200 font-medium">{stats.metodologia.tmo_fonte}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {filteredMonthForecastData.length > 0 && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 flex flex-col justify-between">
                    <div>
                      <div className="flex justify-between items-start">
                        <p className="text-slate-400 text-sm">Volume Previsto ({selectedWeekday === 'all' ? 'Mês' : 'Filtro'})</p>
                        <button
                          onClick={() => setShowSavePrompt(true)}
                          className="text-xs bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/40 px-2 py-1 rounded transition-colors border border-emerald-600/30"
                          title="Salvar este cenário"
                        >
                          💾 Salvar Cenário
                        </button>
                      </div>
                      <p className="text-3xl font-bold text-blue-400 mt-2">
                        {filteredMonthForecastData.reduce((acc, curr) => acc + curr.volume_total, 0).toLocaleString()}
                      </p>
                    </div>

                    {showSavePrompt && (
                      <div className="mt-4 p-3 bg-slate-900 rounded border border-emerald-500/30">
                        <p className="text-xs text-slate-300 mb-2">Nome do Cenário:</p>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={scenarioName}
                            onChange={e => setScenarioName(e.target.value)}
                            placeholder="Ex: Pessimista 2026..."
                            className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-emerald-500"
                          />
                          <button onClick={saveScenario} className="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 rounded text-sm transition-colors">
                            Salvar
                          </button>
                          <button onClick={() => setShowSavePrompt(false)} className="bg-slate-700 hover:bg-slate-600 text-white px-3 py-1 rounded text-sm transition-colors">
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                    <p className="text-slate-400 text-sm">TMO Médio Projetado (Mês)</p>
                    <p className="text-3xl font-bold text-purple-400">
                      {filteredMonthForecastData.length > 0
                        ? Math.round(filteredMonthForecastData.reduce((acc, curr) => acc + curr.tmo_medio, 0) / filteredMonthForecastData.length).toLocaleString()
                        : 0} seg
                    </p>
                  </div>
                  <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                    <p className="text-slate-400 text-sm">TMO Máx. Projetado (Mês)</p>
                    <p className="text-3xl font-bold text-amber-400">
                      {filteredMonthForecastData.length > 0
                        ? Math.max(...filteredMonthForecastData.map(d => d.tmo_medio)).toLocaleString()
                        : 0} seg
                    </p>
                  </div>
                </div>

                {monthComparisons && selectedWeekday === 'all' && (
                  <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                    <h3 className="text-lg font-semibold mb-4 text-emerald-400 flex items-center gap-2">
                      <span>📊</span> Justificativa do Volume Projetado (Picos)
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="bg-slate-700/30 p-4 rounded-lg border-l-4 border-blue-500">
                        <p className="text-slate-400 text-xs uppercase mb-1">Volume Total Projetado</p>
                        <p className="text-2xl font-bold text-white">{monthComparisons.volume_projetado.toLocaleString()}</p>
                        <p className="text-sm mt-1 font-medium text-slate-400">Total previsto para {selectedMonth}/{selectedYear}</p>
                        {monthComparisons.anos_anteriores && monthComparisons.anos_anteriores.length > 0 && (
                          <div className="mt-4 pt-3 border-t border-slate-600/50">
                            <div className="flex justify-between items-center mb-2">
                              <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">Racional de Cálculo IA</p>
                              <select
                                value={rationaleBase}
                                onChange={(e) => setRationaleBase(e.target.value as 'anos_anteriores' | 'ultimos_3_meses')}
                                className="text-[9px] bg-slate-800 text-slate-300 border border-slate-600 rounded px-1 py-0.5 outline-none cursor-pointer"
                              >
                                <option value="anos_anteriores">Anos Anteriores (Sazonal)</option>
                                <option value="ultimos_3_meses">Últimos 3 Meses (Tendência)</option>
                              </select>
                            </div>
                            <div className="space-y-3 text-[11px] text-slate-300">
                              {(() => {
                                const baseData = rationaleBase === 'anos_anteriores' ? monthComparisons.anos_anteriores : (monthComparisons.ultimos_3_meses || []);
                                let baseVol = 0;
                                let baseDU = 0;

                                if (baseData && baseData.length > 0) {
                                  const totalVol = baseData.reduce((acc, curr) => acc + curr.volume, 0);
                                  baseVol = Math.round(totalVol / baseData.length);

                                  const totalDU = baseData.reduce((acc, curr) => {
                                    const [y, m] = curr.ano_mes.split('-');
                                    return acc + getWorkdays(parseInt(y), parseInt(m));
                                  }, 0);
                                  baseDU = totalDU / baseData.length;
                                }

                                const projVol = monthComparisons.volume_projetado;
                                const projDU = getWorkdays(selectedYear, selectedMonth);

                                const baseVolDU = baseDU > 0 ? baseVol / baseDU : 0;
                                const projVolDU = projDU > 0 ? projVol / projDU : 0;
                                const diffVol = projVol - baseVol;
                                const pctVolDU = baseVolDU > 0 ? ((projVolDU - baseVolDU) / baseVolDU) * 100 : 0;

                                return (
                                  <>
                                    <div className="space-y-1">
                                      <p className="text-slate-400 border-b border-slate-700/50 pb-1 mb-1">1. Média Base ({rationaleBase === 'anos_anteriores' ? 'Sazonal' : 'Recente'})</p>
                                      <div className="flex justify-between"><span className="text-slate-500 pl-2">Volume Total:</span><span className="font-medium">{baseVol.toLocaleString()}</span></div>
                                      <div className="flex justify-between"><span className="text-slate-500 pl-2">Dias Úteis (DU):</span><span className="font-medium">{baseDU.toFixed(1)}</span></div>
                                      <div className="flex justify-between"><span className="text-slate-500 pl-2">Média Volume / DU:</span><span className="font-medium">{baseVolDU.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span></div>
                                    </div>

                                    <div className="space-y-1">
                                      <p className="text-slate-400 border-b border-slate-700/50 pb-1 mb-1">2. Cenário Projetado ({selectedMonth}/{selectedYear})</p>
                                      <div className="flex justify-between text-white"><span className="text-slate-500 pl-2">Volume Total:</span><span className="font-bold">{projVol.toLocaleString()}</span></div>
                                      <div className="flex justify-between"><span className="text-slate-500 pl-2">Dias Úteis (DU):</span><span className="font-medium text-emerald-400">{projDU}</span></div>
                                      <div className="flex justify-between">
                                        <span className="text-slate-500 pl-2">Média Volume / DU:</span>
                                        <span className="font-medium text-blue-400">
                                          {projVolDU.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                                          <span className={`ml-1 text-[9px] ${pctVolDU >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                                            ({pctVolDU >= 0 ? '+' : ''}{pctVolDU.toFixed(1)}%)
                                          </span>
                                        </span>
                                      </div>
                                    </div>

                                    <div className="bg-slate-900/50 p-2 rounded border border-slate-700/50 mt-2">
                                      <div className="flex justify-between text-xs">
                                        <span className="text-slate-400" title="Ajuste fino da IA considerando calendário e tendência">Ajuste Total da IA:</span>
                                        <span className={`font-bold ${diffVol >= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                                          {diffVol > 0 ? '+' : ''}{diffVol.toLocaleString()} chamadas
                                        </span>
                                      </div>
                                    </div>

                                    <div className="mt-3 text-[10px] text-slate-500 leading-tight border-t border-slate-700/50 pt-2">
                                      {rationaleBase === 'anos_anteriores' ? (
                                        <p><strong className="text-slate-400">Por que comparar com Anos Anteriores?</strong> Serve como linha de base (baseline). Mostra o quanto a IA ajustou a média normal considerando as particularidades do calendário atual (dias úteis a mais/menos, feriados, DMM).</p>
                                      ) : (
                                        <p><strong className="text-slate-400">Por que comparar com os Últimos 3 Meses?</strong> Isola a tendência de crescimento recente ("calor do momento"). Útil se a sua operação sofreu mudanças bruscas de volume recentemente que o ano passado não refletiria.</p>
                                      )}
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="bg-slate-700/30 p-4 rounded-lg border-l-4 border-amber-500">
                        <div className="flex justify-between items-start">
                          <p className="text-slate-400 text-xs uppercase mb-1" title="Dia de Maior Movimento">DMM (Dia de Maior Movimento)</p>
                          <span className="text-[10px] bg-amber-500/10 text-amber-400 px-2 py-0.5 rounded border border-amber-500/20">Pico Máximo</span>
                        </div>
                        <p className="text-2xl font-bold text-slate-300">{monthComparisons.dmm_vol.toLocaleString()}</p>
                        <p className="text-sm mt-1 font-medium text-amber-400">
                          Previsto para {new Date(monthComparisons.dmm_data + "T00:00:00").toLocaleDateString('pt-BR')}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                          O modelo de Inteligência Artificial identificou este dia como o pico do mês (DMM), cruzando a tendência histórica com gatilhos específicos de alto impacto que você nos ensinou, como o 5º Dia Útil (Pagamento) e o Dia 20 (Vencimentos).
                          {monthComparisons.dmm_baseline_vol ? (
                            <strong className="block mt-1 text-slate-400">
                              (Média histórica para este dia da semana: {monthComparisons.dmm_baseline_vol.toLocaleString()})
                            </strong>
                          ) : null}
                        </p>
                      </div>
                      <div className="bg-slate-700/30 p-4 rounded-lg border-l-4 border-purple-500">
                        <p className="text-slate-400 text-xs uppercase mb-1" title="Hora de Maior Movimento">HMM (Hora de Maior Movimento)</p>
                        <p className="text-2xl font-bold text-slate-300">{monthComparisons.hmm_vol.toLocaleString()}</p>
                        <p className="text-sm mt-1 font-medium text-purple-400">
                          No dia {new Date(monthComparisons.hmm_data + "T00:00:00").toLocaleDateString('pt-BR')} às {monthComparisons.hmm_hora}
                        </p>
                      </div>
                    </div>

                    <div className="bg-slate-700/30 p-4 rounded-lg border-l-4 border-emerald-500 mt-6">
                      <h4 className="text-sm font-semibold mb-2 text-slate-300">Feriados e Dias Excluídos da Análise</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <p className="text-xs text-slate-400 mb-1">Feriados no Mês Projetado:</p>
                          {monthComparisons.feriados_mes && monthComparisons.feriados_mes.length > 0 ? (
                            <ul className="text-sm text-slate-300 list-disc list-inside">
                              {monthComparisons.feriados_mes.map((d: string) => (
                                <li key={d}>{new Date(d + "T00:00:00").toLocaleDateString('pt-BR')}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-sm text-slate-500">Nenhum feriado neste mês.</p>
                          )}
                        </div>
                        <div>
                          <p className="text-xs text-slate-400 mb-1">Finais de Semana e Feriados (Fora do DMM):</p>
                          <p className="text-sm text-slate-300">
                            {monthComparisons.dias_excluidos ? monthComparisons.dias_excluidos.length : 0} dias no total não são elegíveis para Dia de Maior Movimento e não entram na média de Dias Úteis.
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="mt-6 pt-6 border-t border-slate-700/50">
                      <h4 className="text-sm font-semibold mb-3 text-slate-300 flex justify-between items-end">
                        <span>Comparativo Histórico</span>
                      </h4>

                      {(() => {
                        const projVol = monthComparisons.volume_projetado;
                        const projDU = getWorkdays(selectedYear, selectedMonth);
                        const projVolDU = projDU > 0 ? projVol / projDU : 0;

                        return (
                          <>
                            <div className="bg-blue-900/20 p-3 rounded-lg border border-blue-800/40 mb-4 flex justify-between items-center">
                              <span className="text-blue-300 text-sm font-medium">Projeção {selectedMonth}/{selectedYear}</span>
                              <div className="flex gap-6 text-sm">
                                <span>Total: <strong className="text-white">{projVol.toLocaleString()}</strong></span>
                                <span className="text-emerald-400">Vol/DU: <strong>{projVolDU.toLocaleString(undefined, { maximumFractionDigits: 1 })}</strong> <span className="text-slate-500 text-xs">({projDU} DU)</span></span>
                              </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div className="bg-slate-700/20 p-4 rounded-lg border border-slate-700/50">
                                <p className="text-xs text-slate-400 uppercase mb-3 font-medium">Mesmo mês (Anos Anteriores)</p>
                                {monthComparisons.anos_anteriores.length > 0 ? (
                                  monthComparisons.anos_anteriores.map((hist, idx) => {
                                    const diff = ((monthComparisons.volume_projetado / hist.volume) - 1) * 100;
                                    const [y, m] = hist.ano_mes.split('-');
                                    const du = getWorkdays(parseInt(y), parseInt(m));
                                    const volDu = du > 0 ? hist.volume / du : 0;
                                    const diffDu = projVolDU > 0 ? ((projVolDU / volDu) - 1) * 100 : 0;

                                    return (
                                      <div key={idx} className="flex justify-between items-center text-sm py-2 border-b border-slate-700/30 last:border-0">
                                        <div className="flex flex-col">
                                          <span className="font-medium text-slate-300">{hist.ano_mes}</span>
                                          <span className="text-[10px] text-slate-500">{du} Dias Úteis</span>
                                        </div>
                                        <div className="flex flex-col items-end">
                                          <div className="flex items-center gap-3">
                                            <span className="font-bold text-white">{hist.volume.toLocaleString()}</span>
                                            <span className={`text-xs font-semibold w-12 text-right ${diff > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                              {diff > 0 ? '▲' : '▼'} {Math.abs(diff).toFixed(1)}%
                                            </span>
                                          </div>
                                          <span className="text-[11px] text-slate-400 mt-0.5 flex gap-2">
                                            Vol/DU: {volDu.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                                            <span className={diffDu > 0 ? 'text-emerald-500/70' : 'text-rose-500/70'}>({diffDu > 0 ? '+' : ''}{diffDu.toFixed(1)}%)</span>
                                          </span>
                                        </div>
                                      </div>
                                    );
                                  })
                                ) : (
                                  <p className="text-sm text-slate-500 italic mt-2">Sem histórico de anos anteriores</p>
                                )}
                              </div>

                              <div className="bg-slate-700/20 p-4 rounded-lg border border-slate-700/50">
                                <p className="text-xs text-slate-400 uppercase mb-3 font-medium">Últimos 3 Meses</p>
                                {monthComparisons.ultimos_3_meses.length > 0 ? (
                                  monthComparisons.ultimos_3_meses.map((hist, idx) => {
                                    const diff = ((monthComparisons.volume_projetado / hist.volume) - 1) * 100;
                                    const [y, m] = hist.ano_mes.split('-');
                                    const du = getWorkdays(parseInt(y), parseInt(m));
                                    const volDu = du > 0 ? hist.volume / du : 0;
                                    const diffDu = projVolDU > 0 ? ((projVolDU / volDu) - 1) * 100 : 0;

                                    return (
                                      <div key={idx} className="flex justify-between items-center text-sm py-2 border-b border-slate-700/30 last:border-0">
                                        <div className="flex flex-col">
                                          <span className="font-medium text-slate-300">{hist.ano_mes}</span>
                                          <span className="text-[10px] text-slate-500">{du} Dias Úteis</span>
                                        </div>
                                        <div className="flex flex-col items-end">
                                          <div className="flex items-center gap-3">
                                            <span className="font-bold text-white">{hist.volume.toLocaleString()}</span>
                                            <span className={`text-xs font-semibold w-12 text-right ${diff > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                              {diff > 0 ? '▲' : '▼'} {Math.abs(diff).toFixed(1)}%
                                            </span>
                                          </div>
                                          <span className="text-[11px] text-slate-400 mt-0.5 flex gap-2">
                                            Vol/DU: {volDu.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                                            <span className={diffDu > 0 ? 'text-emerald-500/70' : 'text-rose-500/70'}>({diffDu > 0 ? '+' : ''}{diffDu.toFixed(1)}%)</span>
                                          </span>
                                        </div>
                                      </div>
                                    );
                                  })
                                ) : (
                                  <p className="text-sm text-slate-500 italic mt-2">Sem histórico recente</p>
                                )}
                              </div>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                )}

                <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                  <h3 className="text-lg font-semibold mb-6">Volume e TMO Diário ({selectedMonth}/{selectedYear})</h3>
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={filteredMonthForecastData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                        <XAxis
                          dataKey="data"
                          stroke="#94a3b8"
                          fontSize={12}
                          tickFormatter={(val) => {
                            const date = new Date(val);
                            return `${date.getDate()}/${date.getMonth() + 1}`;
                          }}
                        />
                        <YAxis yAxisId="vol" stroke="#10b981" fontSize={12} />
                        <YAxis yAxisId="tmo" orientation="right" stroke="#a78bfa" fontSize={12} unit="s" />
                        <RechartsTooltip
                          contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '0.5rem' }}
                          cursor={{ fill: '#334155', opacity: 0.4 }}
                        />
                        <Legend />
                        <Bar
                          yAxisId="vol"
                          dataKey="volume_total"
                          name="Volume"
                          fill="#10b981"
                          radius={[4, 4, 0, 0]}
                          onClick={(data: any) => {
                            if (data && data.payload) {
                              setSelectedMonthDay(data.payload.data);
                            }
                          }}
                          cursor="pointer"
                        />
                        <Line
                          yAxisId="tmo"
                          type="monotone"
                          dataKey="tmo_medio"
                          name="TMO (seg)"
                          stroke="#a78bfa"
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 5 }}
                        />
                        {monthComparisons && (monthComparisons as any).confidence_intervals && (
                          <Area 
                            type="monotone" 
                            dataKey="volume_upper" 
                            stroke="none" 
                            fill="#3b82f6" 
                            fillOpacity={0.1}
                            name="Limite Superior"
                          />
                        )}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="text-xs text-slate-500 mt-2 text-center">Clique em uma barra para ver a curva intra-diária desse dia.</p>
                </div>

                {aggregatedCurve.length > 0 && (
                  <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 mt-6">
                    <div className="flex justify-between items-center mb-6">
                      <div>
                        <h3 className="text-lg font-semibold">Curva Pronta (Volume + TMO Consolidado)</h3>
                        <p className="text-sm text-slate-400">
                          Média de volume e TMO intra-diário para os dias filtrados ({filteredMonthForecastData.length} dias analisados)
                        </p>
                      </div>
                      <button
                        onClick={downloadAggregatedCurveCSV}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg font-medium transition-all text-sm flex items-center gap-2"
                      >
                        Baixar Curva (CSV)
                      </button>
                    </div>
                    <div className="h-80">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={aggregatedCurve}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                          <XAxis
                            dataKey="intervalo"
                            stroke="#94a3b8"
                            fontSize={12}
                            tickMargin={10}
                          />
                          <YAxis yAxisId="vol" stroke="#f59e0b" fontSize={12} unit="%" />
                          <YAxis yAxisId="tmo" orientation="right" stroke="#a78bfa" fontSize={12} unit="s" />
                          <RechartsTooltip
                            contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '0.5rem' }}
                            itemStyle={{ color: '#e2e8f0' }}
                          />
                          <Legend />
                          <Line
                            yAxisId="vol"
                            type="monotone"
                            dataKey="peso"
                            name="Peso do Volume (%)"
                            stroke="#f59e0b"
                            strokeWidth={3}
                            dot={{ fill: '#f59e0b', strokeWidth: 2, r: 3 }}
                            activeDot={{ r: 6 }}
                          />
                          <Line
                            yAxisId="tmo"
                            type="monotone"
                            dataKey="tmo"
                            name="TMO (seg)"
                            stroke="#a78bfa"
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 5 }}
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {selectedMonthDayData && selectedMonthDayData.intervalos && (
                  <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                    <div className="flex justify-between items-center mb-6">
                      <h3 className="text-lg font-semibold">Curva Intra-diária do Dia Específico</h3>
                      <span className="text-sm font-medium bg-blue-500/20 text-blue-400 px-3 py-1 rounded-full">
                        {new Date(selectedMonthDayData.data + "T00:00:00").toLocaleDateString('pt-BR')}
                      </span>
                    </div>
                    <div className="h-80">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={selectedMonthDayDataWithPeso}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                          <XAxis
                            dataKey="intervalo"
                            stroke="#94a3b8"
                            fontSize={12}
                            tickMargin={10}
                          />
                          <YAxis yAxisId="vol" stroke="#8b5cf6" fontSize={12} unit="%" />
                          <YAxis yAxisId="tmo" orientation="right" stroke="#f59e0b" fontSize={12} unit="s" />
                          <RechartsTooltip
                            contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '0.5rem' }}
                            itemStyle={{ color: '#e2e8f0' }}
                          />
                          <Legend />
                          <Line
                            yAxisId="vol"
                            type="monotone"
                            dataKey="peso"
                            name="Peso do Volume (%)"
                            stroke="#8b5cf6"
                            strokeWidth={3}
                            dot={{ fill: '#8b5cf6', strokeWidth: 2, r: 4 }}
                            activeDot={{ r: 6 }}
                          />
                          <Line
                            yAxisId="tmo"
                            type="monotone"
                            dataKey="tmo"
                            name="TMO (seg)"
                            stroke="#f59e0b"
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 5 }}
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {activeTab === 'metodologia' && stats && stats.metodologia && (
          <div className="space-y-6 mt-8">
            <h2 className="text-2xl font-bold border-b border-slate-700 pb-2 flex items-center gap-2">
              <span>🤖</span> Metodologia e Modelos (IA)
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                <h3 className="text-lg font-semibold mb-4 text-emerald-400">Modelos de IA Testados (Volume)</h3>
                <p className="text-sm text-slate-400 mb-4">
                  O sistema treinou simultaneamente 6 algoritmos diferentes para o seu volume de chamadas e escolheu automaticamente aquele com a menor margem de erro absoluta (MAE).
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left text-slate-300">
                    <thead className="text-xs text-slate-400 bg-slate-700/50 uppercase">
                      <tr>
                        <th className="px-4 py-2">Algoritmo (Modelo)</th>
                        <th className="px-4 py-2 text-right">Acurácia</th>
                        <th className="px-4 py-2 text-right">Margem Erro (MAE)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.metodologia.modelos_testados?.map((m, i) => (
                        <tr key={i} className={`border-b border-slate-700/50 hover:bg-slate-700/30 ${m.modelo === stats.metodologia?.algoritmo_volume ? 'bg-emerald-500/10' : ''}`}>
                          <td className="px-4 py-2 font-medium">
                            {m.modelo} {m.modelo === stats.metodologia?.algoritmo_volume && <span className="ml-2 text-emerald-400" title="Cenário Aconselhado / Modelo Campeão">🏆 Campeão</span>}
                          </td>
                          <td className="px-4 py-2 text-right font-bold text-blue-400">{m.acuracidade ? `${m.acuracidade}%` : '-'}</td>
                          <td className="px-4 py-2 text-right font-bold">{m.erro_mae}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="space-y-6">
                <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                  <h3 className="text-lg font-semibold mb-3 text-blue-400 flex items-center gap-2">
                    <CalendarDays size={20} /> Sazonalidade
                  </h3>
                  <p className="text-sm text-slate-300 leading-relaxed">
                    {stats.metodologia.sazonalidade_explicacao}
                  </p>
                </div>

                <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                  <h3 className="text-lg font-semibold mb-3 text-amber-400 flex items-center gap-2">
                    <TrendingUp size={20} /> Flutuação e Outliers
                  </h3>
                  <p className="text-sm text-slate-300 leading-relaxed">
                    {stats.metodologia.flutuacao_explicacao}
                  </p>
                </div>

                <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                  <h3 className="text-lg font-semibold mb-3 text-purple-400">Outros Metadados</h3>
                  <ul className="text-sm text-slate-300 space-y-2">
                    <li><strong>Modelo de TMO:</strong> {stats?.metodologia?.algoritmo_tmo}</li>
                    <li><strong>Dias de Treinamento:</strong> {stats?.metodologia?.dias_treinamento}</li>
                    <li><strong>Período Base:</strong> {stats?.metodologia?.periodo_historico}</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'dimensionamento' && (
          <div className="space-y-6 mt-8">
            <div className="flex justify-between items-end border-b border-slate-700 pb-2">
              <h2 className="text-2xl font-bold flex items-center gap-2 text-orange-400">
                <Users size={28} /> Dimensionamento Erlang C
                {isCalculatingErlang && (
                  <span className="ml-4 flex items-center gap-2 text-sm text-amber-400 bg-amber-500/10 px-3 py-1 rounded-full animate-pulse border border-amber-500/20">
                    <Activity size={16} className="animate-spin" /> Processando matemática pesada...
                  </span>
                )}
              </h2>

              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-400">Dia Projetado:</label>
                <select
                  value={dimSelectedDay || (monthComparisons?.dmm_data || (monthForecastData[0] ? monthForecastData[0].data : ''))}
                  onChange={(e) => setDimSelectedDay(e.target.value)}
                  className="bg-slate-800 border border-slate-600 text-slate-200 rounded px-3 py-1 outline-none focus:border-blue-500"
                >
                  {monthForecastData.map(d => (
                    <option key={d.data} value={d.data}>
                      {new Date(d.data + "T00:00:00").toLocaleDateString('pt-BR')}
                      {d.data === monthComparisons?.dmm_data ? ' (DMM 🔥)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Sub-abas do Dimensionamento */}
            <div className="flex gap-1 border-b border-slate-700/60 mb-2">
              <button
                onClick={() => setDimSubTab('escala')}
                className={`px-5 py-2 text-sm font-semibold rounded-t transition-colors ${dimSubTab === 'escala' ? 'bg-orange-500/20 text-orange-300 border-b-2 border-orange-400' : 'text-slate-400 hover:text-slate-200'}`}
              >
                📊 Erlang C & Escala
              </button>
              <button
                onClick={() => setDimSubTab('alocacao_automatica')}
                className={`px-5 py-2 text-sm font-semibold rounded-t transition-colors ${dimSubTab === 'alocacao_automatica' ? 'bg-emerald-500/20 text-emerald-300 border-b-2 border-emerald-400' : 'text-slate-400 hover:text-slate-200'}`}
              >
                🤖 Alocação Automática 06:20 | 08:12
              </button>
            </div>

            {/* WFM KPI Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
              {wfmMetrics && (
                <>
                  <div className="bg-slate-800/80 rounded-lg p-3 border border-slate-700/50">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Vol. Médio/Dia</p>
                    <p className="text-lg font-bold text-blue-400">{wfmMetrics.avg_daily_volume?.toLocaleString()}</p>
                  </div>
                  <div className="bg-slate-800/80 rounded-lg p-3 border border-slate-700/50">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">TMO Médio</p>
                    <p className="text-lg font-bold text-purple-400">{wfmMetrics.avg_tmo?.toFixed(0)}s</p>
                  </div>
                  <div className="bg-slate-800/80 rounded-lg p-3 border border-slate-700/50">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Hora Pico</p>
                    <p className="text-lg font-bold text-orange-400">{wfmMetrics.peak_hour || '-'}</p>
                  </div>
                  <div className="bg-slate-800/80 rounded-lg p-3 border border-slate-700/50">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Índice Volatilidade</p>
                    <p className="text-lg font-bold text-yellow-400">{wfmMetrics.volatility_index?.toFixed(2) || '-'}</p>
                  </div>
                  <div className="bg-slate-800/80 rounded-lg p-3 border border-slate-700/50">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Ratio Semana/FDS</p>
                    <p className="text-lg font-bold text-emerald-400">{wfmMetrics.weekday_weekend_ratio?.toFixed(1) || '-'}</p>
                  </div>
                  <div className="bg-slate-800/80 rounded-lg p-3 border border-slate-700/50">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Produtividade</p>
                    <p className="text-lg font-bold text-cyan-400">
                      {wfmCostEstimate ? wfmCostEstimate.productivity + ' cham/h' : '-'}
                    </p>
                  </div>
                </>
              )}
            </div>

            {dimSubTab === 'escala' && (<>
              <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                <div className="grid grid-cols-2 md:grid-cols-6 gap-6 mb-6">
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Curva de Distribuição</label>
                    <select
                      value={dimCurveType}
                      onChange={e => setDimCurveType(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white"
                    >
                      <option value="padrao">Padrão (Dia a Dia)</option>
                      <optgroup label="Visões Gerais">
                        <option value="consolidado">Consolidada (Geral)</option>
                        <option value="consolidado_sem_outlier">Consolidada (Sem Outliers)</option>
                        <option value="consolidado_desvio">Consolidada (Média + Desvio Padrão)</option>
                        <option value="consolidado_mediana">Consolidada (Mediana)</option>
                        <option value="0">Segunda-feira</option>
                        <option value="1">Terça-feira</option>
                        <option value="2">Quarta-feira</option>
                        <option value="3">Quinta-feira</option>
                        <option value="4">Sexta-feira</option>
                        <option value="5">Sábado</option>
                        <option value="6">Domingo</option>
                      </optgroup>
                      <optgroup label="Consolidadas por Mês">
                        {Object.keys(stats?.curvas_distribuicao || {})
                          .filter(k => k.startsWith('consolidado_') && !['consolidado_sem_outlier', 'consolidado_desvio', 'consolidado_mediana'].includes(k))
                          .sort((a,b) => b.localeCompare(a)) // Mais recentes primeiro
                          .map(k => {
                            const [_, ano, m] = k.split(/_|-/);
                            const nomeMes = new Date(parseInt(ano), parseInt(m) - 1, 1).toLocaleString('pt-BR', { month: 'short' });
                            const label = `Consolidada - ${nomeMes.charAt(0).toUpperCase() + nomeMes.slice(1)}/${ano}`;
                            return <option key={k} value={k}>{label}</option>;
                          })
                        }
                      </optgroup>
                      <optgroup label="Curvas Específicas (Dia e Mês)">
                        {Object.keys(stats?.curvas_distribuicao || {})
                          .filter(k => /^[0-6]_/.test(k))
                          .sort((a,b) => b.split('_')[1].localeCompare(a.split('_')[1]) || a.split('_')[0].localeCompare(b.split('_')[0])) // Ordenar por mês desc, depois por dia asc
                          .map(k => {
                            const [diaStr, anoMes] = k.split('_');
                            const [ano, m] = anoMes.split('-');
                            const diasLabel = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
                            const nomeMes = new Date(parseInt(ano), parseInt(m) - 1, 1).toLocaleString('pt-BR', { month: 'short' });
                            return <option key={k} value={k}>{diasLabel[parseInt(diaStr)]} - {nomeMes.charAt(0).toUpperCase() + nomeMes.slice(1)}/{ano}</option>;
                          })
                        }
                      </optgroup>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">SLA Alvo (%)</label>
                    <input type="number" min="10" max="100" value={dimTargetSlaPercent === 0 ? '' : dimTargetSlaPercent} onChange={e => setDimTargetSlaPercent(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white" />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Tempo Alvo (s)</label>
                    <input type="number" min="5" max="300" value={dimTargetSlaTime === 0 ? '' : dimTargetSlaTime} onChange={e => setDimTargetSlaTime(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white" />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">TMA (s)</label>
                    <input type="number" min="0" placeholder="Auto" value={dimTma} onChange={e => setDimTma(e.target.value === '' ? '' : Number(e.target.value))} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white placeholder-slate-600" />
                  </div>
                  <div>
                    <label className="block text-sm text-amber-400 mb-1" title="Forçar um volume total para o mês mantendo a curva">Vol. Fixo</label>
                    <input type="number" min="0" placeholder="Auto" value={dimFixedVolume} onChange={e => setDimFixedVolume(e.target.value === '' ? '' : Number(e.target.value))} className="w-full bg-amber-900/20 border border-amber-600/50 rounded p-2 text-amber-100 placeholder-amber-700/50" />
                  </div>
                  <div>
                    <label className="block text-sm text-amber-400 mb-1" title="Travar quantidade de operadores e ver o que acontece com o Nível de Serviço">Forçar PAs</label>
                    <input type="number" min="0" placeholder="Livre" value={dimFixedAgents} onChange={e => setDimFixedAgents(e.target.value === '' ? '' : Number(e.target.value))} className="w-full bg-amber-900/20 border border-amber-600/50 rounded p-2 text-amber-100 placeholder-amber-700/50" />
                  </div>
                </div>

                <div className="bg-slate-900/40 p-4 rounded-lg border border-slate-600/50">
                  <label className="block text-sm text-slate-300 font-semibold mb-3 flex justify-between border-b border-slate-700/50 pb-2">
                    <span>Fator de Perda (Shrinkage) por Turno</span>
                    <span className="text-rose-400 text-xs">Média Geral: {dimShrinkage.toFixed(2)}%</span>
                  </label>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {dimEnabledShifts.map(shiftType => {
                      const shiftDef = AVAILABLE_SHIFTS.find(s => s.type === shiftType);
                      const conf = dimShrinkageConfig[shiftType] || defaultShrinkage;
                      const totalShift = Object.values(conf).reduce((sum, val) => sum + val, 0);
                      return (
                        <div key={shiftType} className="bg-slate-800/80 p-3 rounded-lg border border-slate-700 shadow-sm">
                          <div className="flex justify-between items-center mb-3">
                            <span className="text-sm font-bold text-emerald-400">{shiftDef?.label}</span>
                            <span className="text-xs font-bold text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded">{totalShift.toFixed(2)}%</span>
                          </div>
                          <div className="grid grid-cols-5 gap-1.5">
                            <div>
                              <label className="block text-[9px] text-slate-400 uppercase text-center font-semibold mb-0.5" title="Absenteísmo">ABS</label>
                              <input type="number" step="0.1" value={conf.abs === 0 ? '' : conf.abs} onChange={e => setDimShrinkageConfig(prev => ({ ...prev, [shiftType]: { ...prev[shiftType], abs: Number(e.target.value) } }))} className="w-full bg-slate-900 border border-slate-600 rounded p-1 text-white text-xs outline-none focus:border-blue-500 text-center" />
                            </div>
                            <div>
                              <label className="block text-[9px] text-slate-400 uppercase text-center font-semibold mb-0.5" title="Pausa NR17">NR17</label>
                              <input type="number" step="0.1" value={conf.nr17 === 0 ? '' : conf.nr17} onChange={e => setDimShrinkageConfig(prev => ({ ...prev, [shiftType]: { ...prev[shiftType], nr17: Number(e.target.value) } }))} className="w-full bg-slate-900 border border-slate-600 rounded p-1 text-white text-xs outline-none focus:border-blue-500 text-center" />
                            </div>
                            <div>
                              <label className="block text-[9px] text-slate-400 uppercase text-center font-semibold mb-0.5" title="Treinamento">TRN</label>
                              <input type="number" step="0.1" value={conf.treinamento === 0 ? '' : conf.treinamento} onChange={e => setDimShrinkageConfig(prev => ({ ...prev, [shiftType]: { ...prev[shiftType], treinamento: Number(e.target.value) } }))} className="w-full bg-slate-900 border border-slate-600 rounded p-1 text-white text-xs outline-none focus:border-blue-500 text-center" />
                            </div>
                            <div>
                              <label className="block text-[9px] text-slate-400 uppercase text-center font-semibold mb-0.5" title="Turnover">TO</label>
                              <input type="number" step="0.1" value={conf.turnover === 0 ? '' : conf.turnover} onChange={e => setDimShrinkageConfig(prev => ({ ...prev, [shiftType]: { ...prev[shiftType], turnover: Number(e.target.value) } }))} className="w-full bg-slate-900 border border-slate-600 rounded p-1 text-white text-xs outline-none focus:border-blue-500 text-center" />
                            </div>
                            <div>
                              <label className="block text-[9px] text-slate-400 uppercase text-center font-semibold mb-0.5">OUTR</label>
                              <input type="number" step="0.1" value={conf.outros === 0 ? '' : conf.outros} onChange={e => setDimShrinkageConfig(prev => ({ ...prev, [shiftType]: { ...prev[shiftType], outros: Number(e.target.value) } }))} className="w-full bg-slate-900 border border-slate-600 rounded p-1 text-white text-xs outline-none focus:border-blue-500 text-center" />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Cost Estimation Configuration */}
              <div className="bg-slate-800 rounded-xl p-5 shadow-xl border border-slate-700/50 mb-4">
                <h3 className="text-base font-semibold mb-4 text-emerald-400 flex items-center gap-2">
                  <span>💰</span> Custo Operacional
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Custo/Agente/Mês (R$)</label>
                    <input type="number" value={costPerAgent} onChange={e => setCostPerAgent(Number(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Overhead (%)</label>
                    <input type="number" value={overheadPercent} onChange={e => setOverheadPercent(Number(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Tempo Paciência (s)</label>
                    <input type="number" value={patienceTime} onChange={e => setPatienceTime(Number(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm" />
                  </div>
                  <div className="flex items-end">
                    <button onClick={() => setShowSensitivity(!showSensitivity)}
                      className="w-full bg-amber-600/20 hover:bg-amber-600/40 text-amber-400 font-medium py-2 px-4 rounded-lg text-sm transition-colors border border-amber-600/30">
                      {showSensitivity ? 'Ocultar Sensibilidade' : 'Análise Sensibilidade'}
                    </button>
                  </div>
                </div>
                
                {wfmCostEstimate && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
                    <div className="bg-slate-900/50 rounded-lg p-3">
                      <p className="text-[10px] text-slate-500 uppercase">Custo Total Mensal</p>
                      <p className="text-xl font-bold text-emerald-400">R$ {wfmCostEstimate.totalMonthlyCost.toLocaleString()}</p>
                    </div>
                    <div className="bg-slate-900/50 rounded-lg p-3">
                      <p className="text-[10px] text-slate-500 uppercase">Custo/Agente (c/ overhead)</p>
                      <p className="text-xl font-bold text-blue-400">R$ {wfmCostEstimate.costPerAgentMonth.toLocaleString()}</p>
                    </div>
                    <div className="bg-slate-900/50 rounded-lg p-3">
                      <p className="text-[10px] text-slate-500 uppercase">Custo/Hora Trabalhada</p>
                      <p className="text-xl font-bold text-purple-400">R$ {wfmCostEstimate.costPerAgentHour.toFixed(2)}</p>
                    </div>
                    <div className="bg-slate-900/50 rounded-lg p-3">
                      <p className="text-[10px] text-slate-500 uppercase">Custo/Chamada</p>
                      <p className="text-xl font-bold text-orange-400">R$ {wfmCostEstimate.costPerCall.toFixed(2)}</p>
                    </div>
                  </div>
                )}
              </div>

              {showSensitivity && slaSensitivityData.length > 0 && (
                <div className="bg-slate-800 rounded-xl p-5 shadow-xl border border-amber-700/50 mb-4">
                  <h3 className="text-base font-semibold mb-4 text-amber-400 flex items-center gap-2">
                    <span>📊</span> Análise de Sensibilidade SLA
                  </h3>
                  <p className="text-xs text-slate-400 mb-3">Impacto da variação de volume no dimensionamento e SLA</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-slate-400 text-xs border-b border-slate-700">
                          <th className="py-2 px-2 text-left">Var. Volume</th>
                          <th className="py-2 px-2 text-right">Volume</th>
                          <th className="py-2 px-2 text-right">Erlangs</th>
                          <th className="py-2 px-2 text-right">PAs Base</th>
                          <th className="py-2 px-2 text-right">PAs c/ Shr.</th>
                          <th className="py-2 px-2 text-right">SLA (%)</th>
                          <th className="py-2 px-2 text-right">Ocupação (%)</th>
                          <th className="py-2 px-2 text-right">Abandono (%)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {slaSensitivityData.map(row => (
                          <tr key={row.volumeChangePct} className="border-b border-slate-800 hover:bg-slate-700/30">
                            <td className={`py-2 px-2 font-medium ${row.volumeChangePct > 0 ? 'text-rose-400' : row.volumeChangePct < 0 ? 'text-emerald-400' : 'text-white'}`}>
                              {row.volumeChangePct > 0 ? '+' : ''}{row.volumeChangePct}%
                            </td>
                            <td className="py-2 px-2 text-right">{row.volume.toLocaleString()}</td>
                            <td className="py-2 px-2 text-right text-slate-300">{row.erlangs}</td>
                            <td className="py-2 px-2 text-right">{row.baseAgents}</td>
                            <td className="py-2 px-2 text-right font-bold text-blue-400">{row.requiredAgents}</td>
                            <td className={`py-2 px-2 text-right font-bold ${row.sla >= dimTargetSlaPercent ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {row.sla}%
                            </td>
                            <td className="py-2 px-2 text-right text-yellow-400">{row.occupancy}%</td>
                            <td className={`py-2 px-2 text-right ${row.abandonRate > 5 ? 'text-rose-400' : 'text-emerald-400'}`}>
                              {row.abandonRate}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {shiftComparisonData.length > 0 && (
                <div className="bg-slate-800 rounded-xl p-5 shadow-xl border border-slate-700/50 mb-4">
                  <h3 className="text-base font-semibold mb-4 text-cyan-400 flex items-center gap-2">
                    <span>⚖️</span> Comparativo de Combinações de Turnos
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-slate-400 text-xs border-b border-slate-700">
                          <th className="py-2 px-2 text-left">Turnos</th>
                          <th className="py-2 px-2 text-right">HC Diário</th>
                          <th className="py-2 px-2 text-right">HC Mensal</th>
                          <th className="py-2 px-2 text-right">Custo Mensal</th>
                          <th className="py-2 px-2 text-right">Custo/Agente</th>
                          <th className="py-2 px-2 text-right">Eficiência</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shiftComparisonData.map((row, idx) => {
                          const isCurrent = JSON.stringify(row.shifts.sort()) === JSON.stringify(dimEnabledShifts.sort());
                          return (
                            <tr key={idx} className={`border-b border-slate-800 ${isCurrent ? 'bg-blue-900/20' : 'hover:bg-slate-700/30'}`}>
                              <td className="py-2 px-2 font-medium">
                                {row.shifts.map(s => AVAILABLE_SHIFTS.find(a => a.type === s)?.label?.split(' ')[0] || s).join(' + ')}
                                {isCurrent && <span className="ml-2 text-xs text-blue-400">(Atual)</span>}
                              </td>
                              <td className="py-2 px-2 text-right">{row.totalDailyHC}</td>
                              <td className="py-2 px-2 text-right font-bold text-blue-400">{row.totalMonthlyHC}</td>
                              <td className="py-2 px-2 text-right text-emerald-400">R$ {row.estimatedCost.toLocaleString()}</td>
                              <td className="py-2 px-2 text-right text-slate-300">R$ {row.costPerAgent.toLocaleString()}</td>
                              <td className={`py-2 px-2 text-right font-bold ${(row.efficiency * 100) >= 95 ? 'text-emerald-400' : (row.efficiency * 100) >= 85 ? 'text-yellow-400' : 'text-rose-400'}`}>
                                {(row.efficiency * 100).toFixed(1)}%
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                <h3 className="text-lg font-semibold mb-4 text-emerald-400">Configuração Avançada WFM (Escalas e Turnos)</h3>

                <div className="mb-6 border-b border-slate-700/50 pb-6">
                  <div className="flex justify-between items-center mb-3">
                    <label className="block text-sm text-slate-300 font-semibold">Turnos Disponíveis para Simulação de Escala</label>
                    <button onClick={runOptimization} className="bg-amber-600 hover:bg-amber-500 text-white px-3 py-1.5 rounded shadow text-sm font-semibold transition flex items-center gap-2">
                      ✨ Auto-Otimizar Mix
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-4">
                    {AVAILABLE_SHIFTS.map(shift => (
                      <label key={shift.type} className={`flex items-center gap-2 cursor-pointer px-4 py-2 rounded-lg border ${dimEnabledShifts.includes(shift.type) ? 'bg-emerald-900/30 border-emerald-500/50 text-emerald-200' : 'bg-slate-900 border-slate-700 text-slate-400 hover:bg-slate-800'}`}>
                        <input
                          type="checkbox"
                          className="rounded bg-slate-900 border-slate-600 text-emerald-500 focus:ring-emerald-500"
                          checked={dimEnabledShifts.includes(shift.type)}
                          onChange={(e) => {
                            if (e.target.checked) setDimEnabledShifts([...dimEnabledShifts, shift.type]);
                            else setDimEnabledShifts(dimEnabledShifts.filter(t => t !== shift.type));
                          }}
                        />
                        <span className="font-semibold">{shift.label}</span>
                        {shift.recommended && (
                          <span className="bg-amber-500/20 text-amber-300 text-[10px] px-1.5 py-0.5 rounded ml-1 font-bold whitespace-nowrap">
                            ⭐ MELHOR OPÇÃO
                          </span>
                        )}
                        <span className="text-xs opacity-60 ml-2 whitespace-nowrap">
                          ({(shift.durationMinutes / 60).toFixed(1)}h líquidas)
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <div className="flex flex-col gap-4">
                    <div>
                      <label className="block text-sm text-slate-400 mb-1" title="Flexibiliza a exigência de SLA em alguns picos se a média agregada do período bater a meta">Estratégia de SLA (Otimização)</label>
                      <select
                        value={dimStrategy}
                        onChange={e => setDimStrategy(e.target.value as SlaStrategy)}
                        className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white outline-none"
                      >
                        <option value="monthly_avg">Média Ponderada do Mês (Trade-off DMM)</option>
                      </select>
                    </div>
                    {dimStrategy === 'monthly_avg' && (
                      <div className="animate-in fade-in slide-in-from-top-2 duration-300 space-y-4">
                        <div>
                          <label className="block text-sm text-blue-400 mb-1" title="Qual dia de maior movimento usar como base para a escala de todos os dias.">DMM Base para a Escala</label>
                          <select
                            value={dimDmmRank}
                            onChange={e => setDimDmmRank(Number(e.target.value))}
                            className="w-full bg-blue-900/20 border border-blue-600/50 rounded p-2 text-blue-100 outline-none focus:border-blue-500"
                          >
                            <option value={1}>1º DMM (Dia Mais Crítico)</option>
                            <option value={2}>2º DMM</option>
                            <option value={3}>3º DMM</option>
                            <option value={4}>4º DMM</option>
                            <option value={5}>5º DMM</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm text-blue-400 mb-1" title="Nível de Serviço mínimo aceitável para o DMM. Impede que o dia fique sem atendimento.">NS Mínimo no DMM (%)</label>
                          <input type="number" min="10" max="100" value={dimTargetDmmSlaPercent} onChange={e => setDimTargetDmmSlaPercent(Number(e.target.value))} className="w-full bg-blue-900/20 border border-blue-600/50 rounded p-2 text-blue-100 outline-none focus:border-blue-500" />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="col-span-1 md:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="p-3 bg-slate-700/30 rounded border border-slate-600/50">
                      <div className="flex justify-between items-center text-sm text-slate-300 mb-2 font-semibold">
                        Seg-Sex
                        <div className="flex items-center gap-3">
                          <label className="flex items-center gap-1 text-xs font-normal cursor-pointer text-blue-300 hover:text-blue-200">
                            <input
                              type="checkbox"
                              checked={dimOpHours.weekdays.start === '00:00' && dimOpHours.weekdays.end === '23:59' && !dimOpHours.weekdays.closed}
                              onChange={e => {
                                if (e.target.checked) setDimOpHours({ ...dimOpHours, weekdays: { start: '00:00', end: '23:59', closed: false } });
                                else setDimOpHours({ ...dimOpHours, weekdays: { start: '08:00', end: '20:00', closed: false } });
                              }}
                              className="rounded bg-slate-900 border-slate-600 text-blue-500 focus:ring-blue-500"
                            />
                            24h
                          </label>
                          <label className="flex items-center gap-1 text-xs font-normal cursor-pointer hover:text-slate-200">
                            <input type="checkbox" checked={dimOpHours.weekdays.closed} onChange={e => setDimOpHours({ ...dimOpHours, weekdays: { ...dimOpHours.weekdays, closed: e.target.checked } })} className="rounded bg-slate-900 border-slate-600" />
                            Fechado
                          </label>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <input type="time" disabled={dimOpHours.weekdays.closed || (dimOpHours.weekdays.start === '00:00' && dimOpHours.weekdays.end === '23:59')} value={dimOpHours.weekdays.start} onChange={e => setDimOpHours({ ...dimOpHours, weekdays: { ...dimOpHours.weekdays, start: e.target.value } })} className="w-full bg-slate-900 border border-slate-600 rounded p-1 text-white text-sm disabled:opacity-50" />
                        <span className="text-slate-500 mt-1">às</span>
                        <input type="time" disabled={dimOpHours.weekdays.closed || (dimOpHours.weekdays.start === '00:00' && dimOpHours.weekdays.end === '23:59')} value={dimOpHours.weekdays.end} onChange={e => setDimOpHours({ ...dimOpHours, weekdays: { ...dimOpHours.weekdays, end: e.target.value } })} className="w-full bg-slate-900 border border-slate-600 rounded p-1 text-white text-sm disabled:opacity-50" />
                      </div>
                    </div>

                    <div className="p-3 bg-slate-700/30 rounded border border-slate-600/50">
                      <div className="flex justify-between items-center text-sm text-slate-300 mb-2 font-semibold">
                        Sábados
                        <div className="flex items-center gap-3">
                          <label className="flex items-center gap-1 text-xs font-normal cursor-pointer text-blue-300 hover:text-blue-200">
                            <input
                              type="checkbox"
                              checked={dimOpHours.saturdays.start === '00:00' && dimOpHours.saturdays.end === '23:59' && !dimOpHours.saturdays.closed}
                              onChange={e => {
                                if (e.target.checked) setDimOpHours({ ...dimOpHours, saturdays: { start: '00:00', end: '23:59', closed: false } });
                                else setDimOpHours({ ...dimOpHours, saturdays: { start: '09:00', end: '15:00', closed: false } });
                              }}
                              className="rounded bg-slate-900 border-slate-600 text-blue-500 focus:ring-blue-500"
                            />
                            24h
                          </label>
                          <label className="flex items-center gap-1 text-xs font-normal cursor-pointer hover:text-slate-200">
                            <input type="checkbox" checked={dimOpHours.saturdays.closed} onChange={e => setDimOpHours({ ...dimOpHours, saturdays: { ...dimOpHours.saturdays, closed: e.target.checked } })} className="rounded bg-slate-900 border-slate-600" />
                            Fechado
                          </label>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <input type="time" disabled={dimOpHours.saturdays.closed || (dimOpHours.saturdays.start === '00:00' && dimOpHours.saturdays.end === '23:59')} value={dimOpHours.saturdays.start} onChange={e => setDimOpHours({ ...dimOpHours, saturdays: { ...dimOpHours.saturdays, start: e.target.value } })} className="w-full bg-slate-900 border border-slate-600 rounded p-1 text-white text-sm disabled:opacity-50" />
                        <span className="text-slate-500 mt-1">às</span>
                        <input type="time" disabled={dimOpHours.saturdays.closed || (dimOpHours.saturdays.start === '00:00' && dimOpHours.saturdays.end === '23:59')} value={dimOpHours.saturdays.end} onChange={e => setDimOpHours({ ...dimOpHours, saturdays: { ...dimOpHours.saturdays, end: e.target.value } })} className="w-full bg-slate-900 border border-slate-600 rounded p-1 text-white text-sm disabled:opacity-50" />
                      </div>
                    </div>

                    <div className="p-3 bg-slate-700/30 rounded border border-slate-600/50">
                      <div className="flex justify-between items-center text-sm text-slate-300 mb-2 font-semibold">
                        Domingos
                        <div className="flex items-center gap-3">
                          <label className="flex items-center gap-1 text-xs font-normal cursor-pointer text-blue-300 hover:text-blue-200">
                            <input
                              type="checkbox"
                              checked={dimOpHours.sundays.start === '00:00' && dimOpHours.sundays.end === '23:59' && !dimOpHours.sundays.closed}
                              onChange={e => {
                                if (e.target.checked) setDimOpHours({ ...dimOpHours, sundays: { start: '00:00', end: '23:59', closed: false } });
                                else setDimOpHours({ ...dimOpHours, sundays: { start: '00:00', end: '23:59', closed: true } });
                              }}
                              className="rounded bg-slate-900 border-slate-600 text-blue-500 focus:ring-blue-500"
                            />
                            24h
                          </label>
                          <label className="flex items-center gap-1 text-xs font-normal cursor-pointer hover:text-slate-200">
                            <input type="checkbox" checked={dimOpHours.sundays.closed} onChange={e => setDimOpHours({ ...dimOpHours, sundays: { ...dimOpHours.sundays, closed: e.target.checked } })} className="rounded bg-slate-900 border-slate-600" />
                            Fechado
                          </label>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <input type="time" disabled={dimOpHours.sundays.closed || (dimOpHours.sundays.start === '00:00' && dimOpHours.sundays.end === '23:59')} value={dimOpHours.sundays.start} onChange={e => setDimOpHours({ ...dimOpHours, sundays: { ...dimOpHours.sundays, start: e.target.value } })} className="w-full bg-slate-900 border border-slate-600 rounded p-1 text-white text-sm disabled:opacity-50" />
                        <span className="text-slate-500 mt-1">às</span>
                        <input type="time" disabled={dimOpHours.sundays.closed || (dimOpHours.sundays.start === '00:00' && dimOpHours.sundays.end === '23:59')} value={dimOpHours.sundays.end} onChange={e => setDimOpHours({ ...dimOpHours, sundays: { ...dimOpHours.sundays, end: e.target.value } })} className="w-full bg-slate-900 border border-slate-600 rounded p-1 text-white text-sm disabled:opacity-50" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {erlangData.length > 0 && dimSummary && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                    <div className="bg-gradient-to-br from-indigo-900/50 to-slate-800 rounded-xl p-6 shadow-xl border border-indigo-500/20">
                      <p className="text-slate-400 text-sm font-medium mb-1">Volume Mensal Consolidado</p>
                      <div className="flex items-baseline gap-2">
                        <h4 className="text-3xl font-bold text-indigo-400">{dimSummary.totalMonthVol.toLocaleString('pt-BR')}</h4>
                        <span className="text-sm text-slate-500">ligações no mês</span>
                      </div>
                    </div>

                    <div className="bg-gradient-to-br from-emerald-900/50 to-slate-800 rounded-xl p-6 shadow-xl border border-emerald-500/20">
                      <p className="text-slate-400 text-sm font-medium mb-1">Pico de Posições (PAs Simultâneas)</p>
                      <div className="flex items-baseline gap-2">
                        <h4 className="text-3xl font-bold text-emerald-400">{dimSummary.maxPAs}</h4>
                        <span className="text-sm text-slate-500">operadores no maior pico</span>
                      </div>
                    </div>

                    <div className="bg-gradient-to-br from-blue-900/50 to-slate-800 rounded-xl p-6 shadow-xl border border-blue-500/20">
                      <p className="text-slate-400 text-sm font-medium mb-1">Média de PAs (Horário Aberto)</p>
                      <div className="flex items-baseline gap-2">
                        <h4 className="text-3xl font-bold text-blue-400">{dimSummary.avgPAs}</h4>
                        <span className="text-sm text-slate-500">operadores logados em média</span>
                      </div>
                    </div>

                    <div className="bg-gradient-to-br from-purple-900/50 to-slate-800 rounded-xl p-6 shadow-xl border border-purple-500/20">
                      <p className="text-slate-400 text-sm font-medium mb-1">SLA Ponderado do Mês</p>
                      <div className="flex items-baseline gap-2">
                        <h4 className={`text-3xl font-bold ${(monthlyShiftSchedules.reduce((sum, r) => sum + (r.totalVol * (r.finalSla || 0)), 0) / (monthlyShiftSchedules.reduce((sum, r) => sum + r.totalVol, 0) || 1)) >= dimTargetSlaPercent ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {(monthlyShiftSchedules.reduce((sum, r) => sum + (r.totalVol * (r.finalSla || 0)), 0) / (monthlyShiftSchedules.reduce((sum, r) => sum + r.totalVol, 0) || 1)).toFixed(1)}%
                        </h4>
                        <span className="text-sm text-slate-500">de atendimento na meta</span>
                      </div>
                    </div>
                  </div>

                  {shiftSchedule && (
                    <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 mb-6">
                      <div className="flex justify-between items-center mb-6">
                        <h3 className="text-lg font-semibold text-emerald-400">Escala Simulada (Algoritmo Guloso)</h3>
                        <button
                          className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded shadow transition font-semibold"
                          onClick={() => {
                            if (!dimSummary) return;
                            const newScenario: SavedStaffingScenario = {
                              id: Date.now().toString(),
                              name: `Simulação ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR')}`,
                              date: new Date().toISOString(),
                              targetDate: dimSelectedDay || '',
                              strategy: dimStrategy,
                              totalDailyHC: shiftSchedule.totalDailyHC,
                              totalMonthlyHC: shiftSchedule.totalMonthlyHC,
                              peakPAs: dimSummary.maxPAs,
                              avgPAs: dimSummary.avgPAs,
                              finalSla: dimSummary.finalSla,
                              shiftsUsed: dimEnabledShifts
                            };
                            const updated = [...staffingScenarios, newScenario];
                            setStaffingScenarios(updated);
                            localStorage.setItem('staffing_scenarios', JSON.stringify(updated));
                            alert('Cenário Salvo com Sucesso!');
                          }}
                        >
                          Salvar Cenário (HC)
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                        <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700">
                          <p className="text-slate-400 text-sm font-medium mb-1">Headcount Diário (Base)</p>
                          <h4 className="text-3xl font-bold text-white">{shiftSchedule.totalDailyHC} <span className="text-sm font-normal text-slate-500">pessoas/dia</span></h4>
                        </div>
                        <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700">
                          <p className="text-slate-400 text-sm font-medium mb-1">Headcount Mensal Estimado (c/ Folgas)</p>
                          <h4 className="text-3xl font-bold text-blue-400">{shiftSchedule.totalMonthlyHC} <span className="text-sm font-normal text-slate-500">pessoas na folha</span></h4>
                        </div>
                      </div>

                      <div className="overflow-x-auto custom-scrollbar">
                        <table className="w-full text-sm text-left text-slate-300">
                          <thead className="text-xs text-slate-400 bg-slate-700/50">
                            <tr>
                              <th className="px-4 py-2 rounded-tl">Turno</th>
                              <th className="px-4 py-2">Horário de Entrada</th>
                              <th className="px-4 py-2 rounded-tr">Qtd de Pessoas</th>
                            </tr>
                          </thead>
                          <tbody>
                            {shiftSchedule.schedules.map((s: any, idx: number) => (
                              <tr key={idx} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                                <td className="px-4 py-2 font-medium text-emerald-400">{s.shift.label}</td>
                                <td className="px-4 py-2">{s.startTime}</td>
                                <td className="px-4 py-2 text-white font-bold">{s.count}</td>
                              </tr>
                            ))}
                            {shiftSchedule.schedules.length === 0 && (
                              <tr>
                                <td colSpan={3} className="px-4 py-4 text-center text-slate-500">Nenhum turno simulado para este dia</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {coverageChartData.length > 0 && (
                    <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                      <h3 className="text-lg font-semibold mb-6 text-purple-400">Cobertura de Escala vs PAs Necessárias</h3>
                      <div className="h-80">
                        <ResponsiveContainer width="100%" height="100%">
                          <ComposedChart data={coverageChartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                            <XAxis dataKey="intervalo" stroke="#94a3b8" fontSize={12} tickMargin={10} />
                            <YAxis yAxisId="left" stroke="#3b82f6" fontSize={12} orientation="left" />
                            <YAxis yAxisId="right" stroke="#64748b" fontSize={12} orientation="right" hide />
                            <RechartsTooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '0.5rem' }} />
                            <Legend />
                            {AVAILABLE_SHIFTS.map((shift: any, idx: number) => {
                              if (!dimEnabledShifts.includes(shift.type)) return null;
                              const colors = ['#fde047', '#3b82f6', '#10b981', '#a855f7', '#ec4899', '#f97316', '#14b8a6', '#6366f1', '#eab308'];
                              const color = colors[idx % colors.length];
                              return (
                                <Bar key={shift.type} yAxisId="left" dataKey={shift.type} name={`HC ${shift.label.split(' ')[0]}`} stackId="1" fill={color} opacity={0.9} radius={0} />
                              );
                            })}
                            <Line yAxisId="left" type="stepAfter" dataKey="required" name="NEC BR. (PAs Erlang)" stroke="#000000" strokeWidth={3} dot={false} />
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}

                  <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                    <h3 className="text-lg font-semibold mb-6">Projeção Intra-diária: PAs x Ocupação</h3>
                    <div className="h-80">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={erlangChartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                          <XAxis dataKey="intervalo" stroke="#94a3b8" fontSize={12} tickMargin={10} />
                          <YAxis yAxisId="left" stroke="#3b82f6" fontSize={12} orientation="left" />
                          <YAxis yAxisId="right" stroke="#orange-400" fontSize={12} orientation="right" domain={[0, 100]} />
                          <RechartsTooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '0.5rem' }} />
                          <Legend />
                          <Bar yAxisId="left" dataKey="requiredAgents" name="PAs Necessárias" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                          <Line yAxisId="right" type="monotone" dataKey="occupancy" name="Ocupação (%)" stroke="#f59e0b" strokeWidth={3} dot={{ r: 3 }} />
                          <Line yAxisId="right" type="monotone" dataKey="serviceLevel" name="Nível de Serviço (%)" stroke="#10b981" strokeWidth={2} strokeDasharray="5 5" dot={false} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50 mb-6">
                    <div className="flex justify-between items-center mb-4">
                      <div className="flex items-center gap-4">
                        <h3 className="text-lg font-semibold">Visão Mensal de Escalas</h3>
                        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer bg-slate-700/50 px-3 py-1.5 rounded border border-slate-600 hover:bg-slate-700 transition">
                          <input
                            type="checkbox"
                            checked={dimShowConsolidated}
                            onChange={e => setDimShowConsolidated(e.target.checked)}
                            className="rounded bg-slate-900 border-slate-600 text-blue-500 focus:ring-blue-500"
                          />
                          Visão Consolidada
                        </label>
                      </div>
                      <button
                        onClick={exportMonthlyCSV}
                        className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded text-sm transition"
                      >
                        📥 Exportar CSV Mensal
                      </button>
                    </div>
                    <div className="overflow-x-auto h-[400px] custom-scrollbar">
                      <table className="w-full text-sm text-left text-slate-300">
                        <thead className="text-[11px] text-white bg-blue-900 sticky top-0 z-10 text-center font-bold">
                          <tr>
                            <th className="px-2 py-2 border-r border-blue-800">DIA</th>
                            <th className="px-2 py-2 border-r border-blue-800">TIPO</th>
                            <th className="px-2 py-2 border-r border-blue-800">DMM</th>
                            <th className="px-2 py-2 border-r border-blue-800">% DMM</th>
                            <th className="px-2 py-2 border-r border-blue-800">VOLUME</th>
                            <th className="px-2 py-2 border-r border-blue-800">TRÁFEGO</th>
                            <th className="px-2 py-2 border-r border-blue-800">TMO</th>
                            <th className="px-2 py-2 border-r border-blue-800">NEC B</th>
                            <th className="px-2 py-2 border-r border-blue-800">DIM B</th>
                            <th className="px-2 py-2 border-r border-blue-800">GAP B</th>
                            {AVAILABLE_SHIFTS.filter(s => dimEnabledShifts.includes(s.type)).map(s => (
                              <th key={s.type} className="px-2 py-2 border-r border-blue-800 text-yellow-300" title="Quadro Fixo Contratado">QUADRO {s.label.split(' ')[0]}</th>
                            ))}
                            <th className="px-2 py-2 border-r border-blue-800">HE DIM</th>
                            <th className="px-2 py-2 border-r border-blue-800 text-orange-300">NS</th>
                            <th className="px-2 py-2 border-r border-blue-800 text-orange-300">NS C/ HE</th>
                            <th className="px-2 py-2 border-r border-blue-800">PA LOG</th>
                            <th className="px-2 py-2 border-r border-blue-800">PA LOG+HE</th>
                            <th className="px-2 py-2 border-r border-blue-800">TX OCUP</th>
                            <th className="px-2 py-2 border-r border-blue-800">INDISP</th>
                            <th className="px-2 py-2">AD. NOT</th>
                          </tr>
                        </thead>
                        <tbody className="text-center bg-white text-slate-800 text-[11px]">
                          {(dimShowConsolidated ? consolidatedSchedules : monthlyShiftSchedules).map((row, i) => (
                            <tr key={i} className={`border-b border-slate-200 hover:bg-slate-50 ${row.data === dimSelectedDay ? 'bg-blue-50 font-bold' : ''} ${row.isConsolidated ? 'bg-slate-100 font-medium' : ''}`}>
                              <td className="px-2 py-1 border-r border-slate-200 whitespace-nowrap">
                                {row.isConsolidated ? row.tipo : new Date(row.data + "T00:00:00").toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                              </td>
                              <td className="px-2 py-1 border-r border-slate-200 lowercase">
                                {new Date(row.data + "T00:00:00").toLocaleDateString('pt-BR', { weekday: 'short' })}
                              </td>
                              <td className="px-2 py-1 border-r border-slate-200">{row.dmmRank}</td>
                              <td className="px-2 py-1 border-r border-slate-200">{row.percDmm?.toFixed(2)}%</td>
                              <td className="px-2 py-1 border-r border-slate-200">{row.totalVol}</td>
                              <td className="px-2 py-1 border-r border-slate-200 text-blue-600 font-medium">{Math.round(row.totalTraffic || 0).toLocaleString('pt-BR')}</td>
                              <td className="px-2 py-1 border-r border-slate-200">{row.tmoAvg}</td>
                              <td className="px-2 py-1 border-r border-slate-200 text-slate-600">{row.maxPAs}</td>
                              <td className="px-2 py-1 border-r border-slate-200 text-slate-600">{row.avgPAs}</td>
                              <td className="px-2 py-1 border-r border-slate-200">{row.avgPAs - row.maxPAs}</td>
                              {AVAILABLE_SHIFTS.filter(s => dimEnabledShifts.includes(s.type)).map(s => (
                                <td key={s.type} className="px-2 py-1 border-r border-slate-200 font-semibold text-slate-700">
                                  {row.fixedHiredHC[s.type] || 0}
                                </td>
                              ))}
                              <td className="px-2 py-1 border-r border-slate-200">0</td>
                              <td className={`px-2 py-1 border-r border-slate-200 font-bold ${row.finalSla === null ? 'bg-slate-200 text-slate-400' : row.finalSla < dimTargetSlaPercent ? 'bg-red-400 text-white' : row.finalSla > 85 ? 'bg-emerald-400 text-white' : 'bg-yellow-300 text-slate-800'}`}>
                                {row.finalSla === null ? '-' : `${row.finalSla.toFixed(1)}%`}
                              </td>
                              <td className={`px-2 py-1 border-r border-slate-200 font-bold ${row.finalSla === null ? 'bg-slate-200 text-slate-400' : row.finalSla < dimTargetSlaPercent ? 'bg-red-400 text-white' : row.finalSla > 85 ? 'bg-emerald-400 text-white' : 'bg-yellow-300 text-slate-800'}`}>
                                {row.finalSla === null ? '-' : `${row.finalSla.toFixed(1)}%`}
                              </td>
                              <td className="px-2 py-1 border-r border-slate-200 font-bold text-blue-600">{row.shiftRes?.coverage?.length > 0 ? Math.max(...row.shiftRes.coverage) : 0}</td>
                              <td className="px-2 py-1 border-r border-slate-200 font-bold text-blue-600">{row.shiftRes?.coverage?.length > 0 ? Math.max(...row.shiftRes.coverage) : 0}</td>
                              <td className="px-2 py-1 border-r border-slate-200">{row.avgOccupancy}%</td>
                              <td className="px-2 py-1 border-r border-slate-200">{dimShrinkage.toFixed(2)}%</td>
                              <td className="px-2 py-1">0,0%</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-slate-700/80 font-bold border-t-2 border-blue-500">
                          <tr>
                            <td colSpan={4} className="px-2 py-2 text-right border-r border-slate-600">TOTAL / MÉDIA</td>
                            <td className="px-2 py-2 border-r border-slate-600">{monthlyShiftSchedules.reduce((sum, r) => sum + r.totalVol, 0)}</td>
                            <td className="px-2 py-2 border-r border-slate-600 text-blue-400">{Math.round(monthlyShiftSchedules.reduce((sum, r) => sum + r.totalTraffic, 0)).toLocaleString('pt-BR')}</td>
                            <td className="px-2 py-2 border-r border-slate-600">
                              {monthlyShiftSchedules.reduce((sum, r) => sum + r.totalVol, 0) > 0
                                ? Math.round(monthlyShiftSchedules.reduce((sum, r) => sum + (r.totalVol * Number(r.tmoAvg)), 0) / monthlyShiftSchedules.reduce((sum, r) => sum + r.totalVol, 0))
                                : 0}
                            </td>
                            <td className="px-2 py-2 border-r border-slate-600 text-slate-300">-</td>
                            <td className="px-2 py-2 border-r border-slate-600 text-slate-300">-</td>
                            <td className="px-2 py-2 border-r border-slate-600">-</td>
                            {AVAILABLE_SHIFTS.filter(s => dimEnabledShifts.includes(s.type)).map(s => (
                              <td key={s.type} className="px-2 py-2 border-r border-slate-600 text-blue-300">
                                {Math.max(0, ...monthlyShiftSchedules.map(r => r.fixedHiredHC[s.type] || 0))}
                              </td>
                            ))}
                            <td className="px-2 py-2 border-r border-slate-600">0</td>
                            <td className="px-2 py-2 border-r border-slate-600 text-yellow-300">
                              {(monthlyShiftSchedules.reduce((sum, r) => sum + (r.totalVol * (r.finalSla || 0)), 0) / (monthlyShiftSchedules.reduce((sum, r) => sum + r.totalVol, 0) || 1)).toFixed(1)}%
                            </td>
                            <td className="px-2 py-2 border-r border-slate-600 text-yellow-300">
                              {(monthlyShiftSchedules.reduce((sum, r) => sum + (r.totalVol * (r.finalSla || 0)), 0) / (monthlyShiftSchedules.reduce((sum, r) => sum + r.totalVol, 0) || 1)).toFixed(1)}%
                            </td>
                            <td className="px-2 py-2 border-r border-slate-600 text-blue-400">-</td>
                            <td className="px-2 py-2 border-r border-slate-600 text-blue-400">-</td>
                            <td className="px-2 py-2 border-r border-slate-600">
                              {Math.round(monthlyShiftSchedules.reduce((sum, r) => sum + r.avgOccupancy, 0) / (monthlyShiftSchedules.length || 1))}%
                            </td>
                            <td className="px-2 py-2 border-r border-slate-600">{dimShrinkage}%</td>
                            <td className="px-2 py-2">0,0%</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>

                  <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-lg font-semibold">Detalhamento por Intervalo</h3>
                      <button
                        onClick={exportIntradayCSV}
                        className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded text-sm transition"
                      >
                        📥 Exportar CSV Intervalos
                      </button>
                    </div>
                    <div className="overflow-x-auto h-[600px] custom-scrollbar">
                      <table className="w-full text-sm text-left text-slate-300">
                        <thead className="text-[11px] text-white bg-blue-900 sticky top-0 z-10 text-center font-bold">
                          <tr>
                            <th className="px-2 py-2 border-r border-blue-800">DIA</th>
                            <th className="px-2 py-2 border-r border-blue-800">INTERVALO</th>
                            <th className="px-2 py-2 border-r border-blue-800">VOLUME</th>
                            <th className="px-2 py-2 border-r border-blue-800">TMO (s)</th>
                            <th className="px-2 py-2 border-r border-blue-800">NEC B</th>
                            <th className="px-2 py-2 border-r border-blue-800">TX OCUP</th>
                            <th className="px-2 py-2 border-r border-blue-800 text-orange-300">NS (%)</th>
                            <th className="px-2 py-2 border-r border-blue-800 text-emerald-300">PA DIM</th>
                            {AVAILABLE_SHIFTS.map(s => (
                              <th key={s.type} className="px-2 py-2 border-r border-blue-800 text-yellow-300">ENT {s.label.split(' ')[0]}</th>
                            ))}
                            <th className="py-2 px-2 text-right text-xs border-r border-blue-800">Abandono (%)</th>
                            <th className="py-2 px-2 text-right text-xs">Erlang B (%)</th>
                          </tr>
                        </thead>
                        <tbody className="text-center bg-white text-slate-800 text-[11px]">
                          {monthlyShiftSchedules.flatMap(daySchedule => {
                            const shiftSchedule = daySchedule.shiftRes;
                            const chunkedRows = [];

                            for (let i = 0; i < daySchedule.intervals.length; i += 1) {
                              const chunk = daySchedule.intervals.slice(i, i + 1);
                              if (chunk.length === 0) continue;

                              const sumVol = chunk.reduce((sum: number, r: any) => sum + r.volume, 0);
                              const avgTmo = sumVol > 0 ? chunk.reduce((sum: number, r: any) => sum + (r.tmo * r.volume), 0) / sumVol : chunk[0].tmo;
                              const maxReqAgents = Math.max(...chunk.map((r: any) => r.requiredAgents));
                              const avgOccupancy = chunk.reduce((sum: number, r: any) => sum + (r.occupancy || 0), 0) / chunk.length;
                              const avgSla = chunk.reduce((sum: number, r: any) => sum + (r.serviceLevel || 0), 0) / chunk.length;
                              const avgCoverage = Math.round(chunk.reduce((sum: number, _: any, idx: number) => sum + (shiftSchedule?.coverage[i + idx] || 0), 0) / chunk.length);
                              const avgAbandonRate = chunk.reduce((sum: number, r: any) => sum + (r.abandonRate || 0), 0) / chunk.length;
                              const avgErlangB = chunk.reduce((sum: number, r: any) => sum + (r.erlangB || 0), 0) / chunk.length;

                              const entradasSum: Record<string, number> = {};
                              AVAILABLE_SHIFTS.forEach(s => {
                                let sum = 0;
                                for (let idx = 0; idx < chunk.length; idx++) {
                                  sum += shiftSchedule?.entradasPerInterval[i + idx]?.[s.type] || 0;
                                }
                                entradasSum[s.type] = sum;
                              });

                              chunkedRows.push({
                                intervalo: chunk[0].intervalo,
                                volume: sumVol,
                                tmo: avgTmo,
                                requiredAgents: maxReqAgents,
                                occupancy: avgOccupancy,
                                serviceLevel: avgSla,
                                coverage: avgCoverage,
                                abandonRate: avgAbandonRate,
                                erlangB: avgErlangB,
                                entradasSum
                              });
                            }

                            return chunkedRows.map((row, chunkIdx) => (
                              <tr key={`${daySchedule.data}-${chunkIdx}`} className={`border-b border-slate-200 hover:bg-slate-50 ${daySchedule.data === dimSelectedDay ? 'bg-blue-50/30' : ''}`}>
                                <td className="px-2 py-1 border-r border-slate-200 text-slate-500 font-medium">
                                  {new Date(daySchedule.data + "T00:00:00").toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                                </td>
                                <td className="px-2 py-1 border-r border-slate-200 font-semibold">{row.intervalo}</td>
                                <td className="px-2 py-1 border-r border-slate-200">{Math.round(row.volume)}</td>
                                <td className="px-2 py-1 border-r border-slate-200">{Math.round(row.tmo)}</td>
                                <td className="px-2 py-1 border-r border-slate-200 font-bold text-slate-600 bg-slate-100/50">{row.requiredAgents}</td>
                                <td className="px-2 py-1 border-r border-slate-200">
                                  <span className={row.occupancy > 85 ? 'text-red-600 font-bold' : ''}>
                                    {row.occupancy.toFixed(1)}%
                                  </span>
                                </td>
                                <td className={`px-2 py-1 border-r border-slate-200 font-bold ${row.serviceLevel < dimTargetSlaPercent ? 'bg-red-400 text-white' : row.serviceLevel > 85 ? 'bg-emerald-400 text-white' : 'bg-yellow-300 text-slate-800'}`}>
                                  {row.serviceLevel.toFixed(1)}%
                                </td>
                                <td className="px-2 py-1 border-r border-slate-200 font-bold text-emerald-700 bg-emerald-50">
                                  {row.coverage}
                                </td>
                                {AVAILABLE_SHIFTS.map(s => {
                                  const entradas = row.entradasSum[s.type];
                                  return (
                                    <td key={s.type} className={`px-2 py-1 border-r border-slate-200 ${entradas > 0 ? 'bg-purple-600 text-white font-bold' : 'text-slate-300'}`}>
                                      {entradas > 0 ? entradas : '-'}
                                    </td>
                                  );
                                })}
                                <td className={`px-2 py-1 border-r border-slate-200 text-xs ${(row.abandonRate || 0) > 5 ? 'text-rose-400 font-bold' : 'text-emerald-400'}`}>
                                  {(row.abandonRate || 0).toFixed(1)}%
                                </td>
                                <td className="px-2 py-1 text-xs text-slate-400">
                                  {(row.erlangB || 0).toFixed(2)}%
                                </td>
                              </tr>
                            ));
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </>
            )}

            {/* ======================================================
                  ALOCAÇÃO AUTOMÁTICA 06:20 | 08:12
                  ====================================================== */}
            {dimSubTab === 'alocacao_automatica' && (
              <div className="space-y-6">
                {/* Controles */}
                <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-emerald-500/20">
                  <h3 className="text-lg font-semibold text-emerald-400 mb-4 flex items-center gap-2">
                    ⚙️ Configuração da Alocação
                  </h3>
                  <div className="grid grid-cols-1 gap-4">
                    <div className="flex items-end">
                      <div className="bg-slate-900/60 rounded p-3 text-xs text-slate-400 leading-relaxed">
                        <p>📌 <strong className="text-slate-300">Janela de operação:</strong> usada do horário configurado no painel.</p>
                        <p>📌 <strong className="text-slate-300">NEC base:</strong> <code className="text-emerald-400">requiredAgents</code> do Erlang C (com shrinkage).</p>
                      </div>
                    </div>
                  </div>
                </div>

                {!shiftAllocation612_812 ? (
                  <div className="bg-slate-800 rounded-xl p-10 text-center text-slate-400 border border-slate-700/50">
                    {erlangData.length === 0
                      ? '⚠️ Carregue o forecast e acesse a aba Dimensionamento para calcular.'
                      : '⚠️ A operação está fechada no dia selecionado.'}
                  </div>
                ) : (
                  <>
                    {/* KPIs */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="bg-gradient-to-br from-emerald-900/40 to-slate-800 rounded-xl p-5 border border-emerald-500/20 shadow-lg">
                        <p className="text-slate-400 text-xs mb-1 uppercase tracking-wide">Total HC</p>
                        <p className="text-3xl font-bold text-emerald-400">{shiftAllocation612_812.totalHC}</p>
                        <p className="text-slate-500 text-xs mt-1">operadores únicos</p>
                      </div>
                      <div className="bg-gradient-to-br from-blue-900/40 to-slate-800 rounded-xl p-5 border border-blue-500/20 shadow-lg">
                        <p className="text-slate-400 text-xs mb-1 uppercase tracking-wide">Turnos 06:20</p>
                        <p className="text-3xl font-bold text-blue-400">{shiftAllocation612_812.total_0620}</p>
                        <p className="text-slate-500 text-xs mt-1">6h20 (6x1)</p>
                      </div>
                      <div className="bg-gradient-to-br from-purple-900/40 to-slate-800 rounded-xl p-5 border border-purple-500/20 shadow-lg">
                        <p className="text-slate-400 text-xs mb-1 uppercase tracking-wide">Turnos 08:12</p>
                        <p className="text-3xl font-bold text-purple-400">{shiftAllocation612_812.total_0812}</p>
                        <p className="text-slate-500 text-xs mt-1">8h12 (5x2)</p>
                      </div>
                      <div className="bg-gradient-to-br from-amber-900/40 to-slate-800 rounded-xl p-5 border border-amber-500/20 shadow-lg">
                        <p className="text-slate-400 text-xs mb-1 uppercase tracking-wide">Pico Coberto</p>
                        <p className={`text-3xl font-bold ${shiftAllocation612_812.peakCoverage >= shiftAllocation612_812.peakNec ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {shiftAllocation612_812.peakCoverage}
                        </p>
                        <p className="text-slate-500 text-xs mt-1">NEC pico: {shiftAllocation612_812.peakNec}</p>
                      </div>
                    </div>

                    {/* Gráfico NEC vs Cobertura */}
                    <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                      <h3 className="text-base font-semibold text-slate-300 mb-4">📈 NEC Bruta vs Cobertura por Intervalo</h3>
                      <ResponsiveContainer width="100%" height={240}>
                        <ComposedChart data={shiftAllocation612_812.necPerInterval.map((nec, i) => ({
                          intervalo: erlangData[i]?.intervalo || i,
                          nec,
                          cobertura: shiftAllocation612_812.coveragePerInterval[i] || 0,
                          gap: Math.max(0, nec - (shiftAllocation612_812.coveragePerInterval[i] || 0))
                        }))}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                          <XAxis dataKey="intervalo" stroke="#94a3b8" fontSize={10} interval={5} tickMargin={6} />
                          <YAxis stroke="#94a3b8" fontSize={11} />
                          <RechartsTooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '0.5rem' }} />
                          <Legend />
                          <Bar dataKey="nec" name="NEC Bruta" fill="#f59e0b" opacity={0.7} radius={[2, 2, 0, 0]} />
                          <Bar dataKey="cobertura" name="Cobertura" fill="#10b981" opacity={0.85} radius={[2, 2, 0, 0]} />
                          <Bar dataKey="gap" name="Déficit" fill="#ef4444" opacity={0.6} radius={[2, 2, 0, 0]} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Tabela de Escala */}
                    <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                      <h3 className="text-base font-semibold text-slate-300 mb-4">📋 Escala Gerada pelo Algoritmo Guloso</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-sm">
                          <thead>
                            <tr className="border-b border-slate-700 text-slate-400 text-xs uppercase">
                              <th className="py-2 px-4">Entrada</th>
                              <th className="py-2 px-4">Saída</th>
                              <th className="py-2 px-4">Tipo</th>
                              <th className="py-2 px-4">Duração</th>
                              <th className="py-2 px-4 text-center">Qtd Agentes</th>
                              <th className="py-2 px-4 text-center">Horas-Operador</th>
                            </tr>
                          </thead>
                          <tbody>
                            {shiftAllocation612_812.allocations.map((alloc, idx) => (
                              <tr key={idx} className={`border-b border-slate-700/40 hover:bg-slate-700/20 transition-colors ${alloc.shiftType === '08:12' ? 'bg-purple-900/10' : 'bg-blue-900/10'}`}>
                                <td className="py-3 px-4 font-mono font-semibold text-white">{alloc.startTime}</td>
                                <td className="py-3 px-4 font-mono text-slate-300">{alloc.endTime}</td>
                                <td className="py-3 px-4">
                                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${alloc.shiftType === '08:12' ? 'bg-purple-500/20 text-purple-300' : 'bg-blue-500/20 text-blue-300'}`}>
                                    {alloc.shiftType}
                                  </span>
                                </td>
                                <td className="py-3 px-4 text-slate-400">{alloc.durationMinutes}min</td>
                                <td className="py-3 px-4 text-center font-bold text-emerald-400">{alloc.count}</td>
                                <td className="py-3 px-4 text-center text-amber-400 font-semibold">
                                  {(alloc.count * alloc.durationMinutes / 60).toFixed(1)}h
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot className="border-t-2 border-slate-600">
                            <tr className="font-bold text-sm">
                              <td className="py-3 px-4 text-slate-300" colSpan={4}>TOTAL</td>
                              <td className="py-3 px-4 text-center text-emerald-400">{shiftAllocation612_812.totalHC}</td>
                              <td className="py-3 px-4 text-center text-amber-400">
                                {shiftAllocation612_812.allocations.reduce((sum, a) => sum + a.count * a.durationMinutes / 60, 0).toFixed(1)}h
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* ==================== SHRINKAGE TAB ==================== */}
        {activeTab === 'shrinkage' && (() => {
          const shrinkResult = useMemo(() => calculateShrinkageBreakdown(shrinkBaseAgents, {
            'Férias': shrinkVacation, 'Licença médica': shrinkSickLeave, 'Treinamento': shrinkTraining,
            'Pausas': shrinkBreaks, 'Reuniões': shrinkMeetings, 'Absentismo': shrinkAbsenteeism, 'Outros': shrinkOther
          }), [shrinkBaseAgents, shrinkVacation, shrinkSickLeave, shrinkTraining, shrinkBreaks, shrinkMeetings, shrinkAbsenteeism, shrinkOther]);
          return (
            <div className="space-y-6">
              <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
                <h2 className="text-xl font-bold text-rose-400 flex items-center gap-2 mb-6">
                  <Users className="w-5 h-5" /> Calculadora de Shrinkage
                </h2>
                <p className="text-slate-400 mb-6">Configure os componentes de shrinkage para entender o impacto real no dimensionamento de pessoas. O shrinkage representa a diferença entre agentes pagos e agentes efetivamente disponíveis para atendimento.</p>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                  <div className="col-span-full">
                    <label className="block text-sm font-medium text-slate-300 mb-2">Agentes Necessários (antes do shrinkage)</label>
                    <input type="number" value={shrinkBaseAgents} onChange={e => setShrinkBaseAgents(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg px-4 py-2.5 text-white text-lg font-bold" />
                  </div>
                  {[
                    { label: 'Férias (%)', value: shrinkVacation, setter: setShrinkVacation, desc: 'Licença remunerada anual' },
                    { label: 'Afastamento Saúde (%)', value: shrinkSickLeave, setter: setShrinkSickLeave, desc: 'Atestados médicos e licenças saúde' },
                    { label: 'Treinamento (%)', value: shrinkTraining, setter: setShrinkTraining, desc: 'Capacitação e desenvolvimento' },
                    { label: 'Pausas (%)', value: shrinkBreaks, setter: setShrinkBreaks, desc: 'NR17, café, banheiro' },
                    { label: 'Reuniões (%)', value: shrinkMeetings, setter: setShrinkMeetings, desc: 'Reuniões operacionais e coaching' },
                    { label: 'Absenteísmo (%)', value: shrinkAbsenteeism, setter: setShrinkAbsenteeism, desc: 'Faltas não justificadas' },
                    { label: 'Outros (%)', value: shrinkOther, setter: setShrinkOther, desc: 'Outras ausências programadas' },
                  ].map(item => (
                    <div key={item.label}>
                      <label className="block text-sm font-medium text-slate-300 mb-1">{item.label}</label>
                      <input type="number" step="0.5" min="0" max="50" value={item.value} onChange={e => item.setter(parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white" />
                      <p className="text-xs text-slate-500 mt-1">{item.desc}</p>
                    </div>
                  ))}
                </div>

                {/* Shrinkage Results */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                  <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700 text-center">
                    <p className="text-sm text-slate-400">Shrinkage Total</p>
                    <p className="text-3xl font-bold text-rose-400">{shrinkResult.totalShrinkagePercent.toFixed(1)}%</p>
                  </div>
                  <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700 text-center">
                    <p className="text-sm text-slate-400">Agentes Necessários (com shrinkage)</p>
                    <p className="text-3xl font-bold text-amber-400">{shrinkResult.requiredWithShrinkage}</p>
                  </div>
                  <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700 text-center">
                    <p className="text-sm text-slate-400">Eficiência do Tempo Pago</p>
                    <p className="text-3xl font-bold text-emerald-400">{(100 - shrinkResult.efficiencyLoss).toFixed(1)}%</p>
                  </div>
                </div>

                {/* Breakdown Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-700">
                        <th className="text-left py-3 px-4 text-slate-400">Componente</th>
                        <th className="text-center py-3 px-4 text-slate-400">%</th>
                        <th className="text-center py-3 px-4 text-slate-400">Agentes Ausentes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shrinkResult.components.map((c, i) => (
                        <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/50">
                          <td className="py-3 px-4 text-white">{c.name}</td>
                          <td className="py-3 px-4 text-center text-rose-300 font-medium">{c.percent.toFixed(1)}%</td>
                          <td className="py-3 px-4 text-center text-amber-300 font-medium">{c.agentsAbsent}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t-2 border-slate-600 font-bold">
                      <tr>
                        <td className="py-3 px-4 text-white">TOTAL</td>
                        <td className="py-3 px-4 text-center text-rose-400">{shrinkResult.totalShrinkagePercent.toFixed(1)}%</td>
                        <td className="py-3 px-4 text-center text-amber-400">+{shrinkResult.additionalAgents} agentes</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                <button onClick={() => exportToCSV(shrinkResult.components.map(c => ({
                  Componente: c.name, Percentual: c.percent, 'Agentes Ausentes': c.agentsAbsent
                })), `shrinkage_${shrinkBaseAgents}agentes.csv`)}
                  className="mt-4 bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                  Exportar CSV
                </button>
              </div>
            </div>
          );
        })()}

        {/* ==================== WHAT-IF TAB ==================== */}
        {activeTab === 'whatif' && (
          <div className="space-y-6">
            <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
              <h2 className="text-xl font-bold text-cyan-400 flex items-center gap-2 mb-6">
                <TrendingUp className="w-5 h-5" /> Análise de Cenários (What-If)
              </h2>
              <p className="text-slate-400 mb-6">Simule diferentes cenários operacionais para entender o impacto no dimensionamento. Ideal para planejamento de contingência eCapacity planning.</p>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Volume Base (por intervalo)</label>
                  <input type="number" value={whatifBaseVolume} onChange={e => setWhatifBaseVolume(parseInt(e.target.value) || 0)}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">TMO (seg)</label>
                  <input type="number" value={whatifTmo} onChange={e => setWhatifTmo(parseInt(e.target.value) || 1)}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Intervalo (seg)</label>
                  <input type="number" value={whatifIntervalSec} onChange={e => setWhatifIntervalSec(parseInt(e.target.value) || 1)}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">SLA Alvo (%)</label>
                  <input type="number" value={whatifTargetSla} onChange={e => setWhatifTargetSla(parseFloat(e.target.value) || 1)}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Tempo SLA (seg)</label>
                  <input type="number" value={whatifSlaTime} onChange={e => setWhatifSlaTime(parseInt(e.target.value) || 1)}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Shrinkage (%)</label>
                  <input type="number" step="0.01" value={whatifShrinkage} onChange={e => setWhatifShrinkage(parseFloat(e.target.value) || 0)}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm" />
                </div>
              </div>

              <button onClick={() => {
                const results = calculateScenarioImpact(
                  whatifBaseVolume, whatifTmo, whatifIntervalSec,
                  whatifTargetSla, whatifSlaTime, whatifShrinkage / 100,
                  [
                    { name: 'Pico Extremo (+30%)', volumeDeltaPct: 30, tmoDeltaPct: 0 },
                    { name: 'Pico Moderado (+20%)', volumeDeltaPct: 20, tmoDeltaPct: 0 },
                    { name: 'Operação Normal', volumeDeltaPct: 0, tmoDeltaPct: 0 },
                    { name: 'Baixa Demanda (-20%)', volumeDeltaPct: -20, tmoDeltaPct: 0 },
                    { name: 'Crise (+30% vol, +15% TMO)', volumeDeltaPct: 30, tmoDeltaPct: 15 },
                    { name: 'TMO Alto (+25% TMO)', volumeDeltaPct: 0, tmoDeltaPct: 25 },
                    { name: 'Black Friday (+50% vol)', volumeDeltaPct: 50, tmoDeltaPct: -10 },
                  ]
                );
                setWhatifResults(results);
              }}
                className="bg-cyan-600 hover:bg-cyan-500 text-white px-6 py-3 rounded-lg font-semibold shadow-lg transition-colors mb-6">
                Simular Cenários
              </button>

              {whatifResults.length > 0 && (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-700">
                          <th className="text-left py-3 px-3 text-slate-400">Cenário</th>
                          <th className="text-center py-3 px-3 text-slate-400">Volume</th>
                          <th className="text-center py-3 px-3 text-slate-400">TMO</th>
                          <th className="text-center py-3 px-3 text-slate-400">Erlangs</th>
                          <th className="text-center py-3 px-3 text-slate-400">PA Base</th>
                          <th className="text-center py-3 px-3 text-slate-400">PA c/ Shrinkage</th>
                          <th className="text-center py-3 px-3 text-slate-400">SLA</th>
                          <th className="text-center py-3 px-3 text-slate-400">Ocupação</th>
                          <th className="text-center py-3 px-3 text-slate-400">ASA (s)</th>
                          <th className="text-center py-3 px-3 text-slate-400">Delta Custo</th>
                          <th className="text-center py-3 px-3 text-slate-400">Risco</th>
                        </tr>
                      </thead>
                      <tbody>
                        {whatifResults.map((r, i) => (
                          <tr key={i} className={`border-b border-slate-800 hover:bg-slate-800/50 ${r.riskLevel === 'Crítico' ? 'bg-red-900/20' : r.riskLevel === 'Alto' ? 'bg-amber-900/20' : ''}`}>
                            <td className="py-3 px-3 text-white font-medium">{r.name}</td>
                            <td className="py-3 px-3 text-center text-slate-300">{r.volume.toLocaleString()}</td>
                            <td className="py-3 px-3 text-center text-slate-300">{r.tmo}s</td>
                            <td className="py-3 px-3 text-center text-blue-300">{r.erlangs.toFixed(1)}</td>
                            <td className="py-3 px-3 text-center text-white font-bold">{r.baseAgents}</td>
                            <td className="py-3 px-3 text-center text-amber-400 font-bold">{r.requiredAgents}</td>
                            <td className={`py-3 px-3 text-center font-medium ${r.sla >= 80 ? 'text-emerald-400' : r.sla >= 60 ? 'text-amber-400' : 'text-red-400'}`}>{r.sla.toFixed(1)}%</td>
                            <td className={`py-3 px-3 text-center ${r.occupancy > 90 ? 'text-red-400' : r.occupancy > 80 ? 'text-amber-400' : 'text-emerald-400'}`}>{r.occupancy.toFixed(1)}%</td>
                            <td className="py-3 px-3 text-center text-slate-300">{r.asa.toFixed(0)}s</td>
                            <td className={`py-3 px-3 text-center font-medium ${r.costDelta > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                              {r.costDelta > 0 ? '+' : ''}{r.costDelta.toLocaleString()}
                            </td>
                            <td className="py-3 px-3 text-center">
                              <span className={`px-2 py-1 rounded-full text-xs font-bold ${
                                r.riskLevel === 'Baixo' ? 'bg-emerald-900/50 text-emerald-400' :
                                r.riskLevel === 'Médio' ? 'bg-amber-900/50 text-amber-400' :
                                r.riskLevel === 'Alto' ? 'bg-orange-900/50 text-orange-400' :
                                'bg-red-900/50 text-red-400'
                              }`}>{r.riskLevel}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* What-If Visualization */}
                  <div className="mt-6 bg-slate-900/50 rounded-xl p-6">
                    <h3 className="text-lg font-bold text-cyan-400 mb-4">Comparativo Visual</h3>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={whatifResults.map(r => ({ name: r.name, agentes: r.requiredAgents, sla: r.sla, ocupacao: r.occupancy }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 10 }} angle={-30} textAnchor="end" height={80} />
                        <YAxis tick={{ fill: '#94a3b8' }} />
                        <RechartsTooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }} />
                        <Legend />
                        <Bar dataKey="agentes" fill="#818cf8" name="PA Necessários" />
                        <Bar dataKey="sla" fill="#34d399" name="SLA %" />
                        <Bar dataKey="ocupacao" fill="#fbbf24" name="Ocupação %" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <button onClick={() => exportToCSV(whatifResults.map(r => ({
                    Cenário: r.name, Volume: r.volume, TMO: r.tmo, Erlangs: r.erlangs,
                    'PA Base': r.baseAgents, 'PA c/ Shrinkage': r.requiredAgents,
                    'SLA (%)': r.sla, 'Ocupação (%)': r.occupancy, 'ASA (s)': r.asa,
                    'Delta Custo': r.costDelta, Risco: r.riskLevel
                  })), 'whatif_analysis.csv')}
                    className="mt-4 bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                    Exportar Análise CSV
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* ==================== ROTATION TAB ==================== */}
        {activeTab === 'rotacao' && (
          <div className="space-y-6">
            <div className="bg-slate-800 rounded-xl p-6 shadow-xl border border-slate-700/50">
              <h2 className="text-xl font-bold text-violet-400 flex items-center gap-2 mb-6">
                <CalendarDays className="w-5 h-5" /> Escala de Rotação Mensal
              </h2>
              <p className="text-slate-400 mb-6">Gere uma escala de rotação mensal com distribuição automática de turnos, folgas rotativas e respeito a feriados nacionais. Cada operador recebe 1 dia de folga por semana.</p>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Ano</label>
                  <input type="number" value={rotYear} onChange={e => setRotYear(parseInt(e.target.value) || 2025)}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Mês</label>
                  <select value={rotMonth} onChange={e => setRotMonth(parseInt(e.target.value))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white">
                    {Array.from({length: 12}, (_, i) => <option key={i+1} value={i+1}>{new Date(2025, i).toLocaleString('pt-BR', {month: 'long'})}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Headcount Total</label>
                  <input type="number" value={rotHC} onChange={e => setRotHC(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Turnos</label>
                  <div className="flex flex-wrap gap-1">
                    {AVAILABLE_SHIFTS.filter(s => s.recommended || ['12x36', '04:00'].includes(s.type)).map(s => (
                      <button key={s.type} onClick={() => setRotShiftTypes(prev =>
                        prev.includes(s.type) ? prev.filter(t => t !== s.type) : [...prev, s.type]
                      )}
                        className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                          rotShiftTypes.includes(s.type) ? 'bg-violet-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                        }`}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <button onClick={() => {
                const cal = generateRotationCalendar(rotYear, rotMonth, rotHC, rotShiftTypes);
                setRotCalendar(cal);
              }}
                className="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-lg font-semibold shadow-lg transition-colors mb-6">
                Gerar Escala de Rotação
              </button>

              {rotCalendar && (
                <>
                  {/* Summary Cards */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700 text-center">
                      <p className="text-sm text-slate-400">HC Médio/Dia</p>
                      <p className="text-2xl font-bold text-violet-400">{rotCalendar.summary.avgDailyHC}</p>
                    </div>
                    <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700 text-center">
                      <p className="text-sm text-slate-400">HC Pico</p>
                      <p className="text-2xl font-bold text-amber-400">{rotCalendar.summary.peakDayHC}</p>
                    </div>
                    <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700 text-center">
                      <p className="text-sm text-slate-400">Dias Úteis</p>
                      <p className="text-2xl font-bold text-emerald-400">{rotCalendar.summary.workingDays}</p>
                    </div>
                    <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700 text-center">
                      <p className="text-sm text-slate-400">Feriados</p>
                      <p className="text-2xl font-bold text-rose-400">{rotCalendar.summary.holidays}</p>
                    </div>
                  </div>

                  {/* Shift Distribution */}
                  <div className="mb-6">
                    <h3 className="text-sm font-bold text-slate-300 mb-2">Distribuição por Turno</h3>
                    <div className="flex gap-3 flex-wrap">
                      {Object.entries(rotCalendar.summary.shiftDistribution).map(([type, count]) => {
                        const shift = AVAILABLE_SHIFTS.find(s => s.type === type);
                        return (
                          <div key={type} className="bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2">
                            <p className="text-xs text-slate-400">{shift?.label || type}</p>
                            <p className="text-lg font-bold text-violet-300">{count as number}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Calendar Grid */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-700">
                          <th className="text-left py-2 px-2 text-slate-400">Data</th>
                          <th className="text-left py-2 px-2 text-slate-400">Dia</th>
                          <th className="text-center py-2 px-2 text-slate-400">Status</th>
                          <th className="text-center py-2 px-2 text-slate-400">Turnos</th>
                          <th className="text-center py-2 px-2 text-slate-400">HC Dia</th>
                          <th className="text-left py-2 px-2 text-slate-400">Obs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rotCalendar.days.map((day, i) => (
                          <tr key={i} className={`border-b border-slate-800 ${day.isHoliday ? 'bg-red-900/10' : day.isWeekend ? 'bg-slate-900/30' : ''}`}>
                            <td className="py-2 px-2 text-white font-medium">{day.date}</td>
                            <td className="py-2 px-2 text-slate-400">{day.dayName}</td>
                            <td className="py-2 px-2 text-center">
                              {day.isHoliday ? <span className="text-red-400 font-bold">Feriado</span> :
                               day.isWeekend ? <span className="text-amber-400">FDS</span> :
                               <span className="text-emerald-400">Útil</span>}
                            </td>
                            <td className="py-2 px-2 text-center">
                              {day.shifts.length > 0 ? day.shifts.map((s, j) => (
                                <span key={j} className="inline-block bg-violet-900/50 text-violet-300 px-1.5 py-0.5 rounded mr-1 mb-0.5">
                                  {s.shiftType}x{s.count}
                                </span>
                              )) : <span className="text-slate-600">-</span>}
                            </td>
                            <td className="py-2 px-2 text-center text-white font-medium">{day.totalAgents}</td>
                            <td className="py-2 px-2 text-slate-500">{day.notes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <button onClick={() => exportToCSV(rotCalendar.days.map(d => ({
                    Data: d.date, Dia: d.dayName, Feriado: d.isHoliday ? 'Sim' : 'Não',
                    'HC Total': d.totalAgents, Turnos: d.shifts.map(s => `${s.shiftType}x${s.count}`).join(', '),
                    Observação: d.notes
                  })), `rotacao_${rotYear}_${String(rotMonth).padStart(2,'0')}.csv`)}
                    className="mt-4 bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                    Exportar Escala CSV
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </>
    )
  }

  {
    forecastData.length === 0 && !loading && (
      <div className="text-center py-20 text-slate-500">
        <p>Faça upload de um histórico CSV para gerar os primeiros forecasts.</p>
      </div>
    )
  }

  {
    isOptModalOpen && (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
        <div className="bg-slate-800 rounded-xl p-6 shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto border border-amber-500/30">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-amber-400 flex items-center gap-2">✨ Otimização Inteligente de Escalas</h2>
            <button onClick={() => setIsOptModalOpen(false)} className="text-slate-400 hover:text-white text-2xl">&times;</button>
          </div>

          <p className="text-slate-300 mb-6">
            O algoritmo testou matematicamente <strong>{optResults.length} combinações</strong> possíveis com as jornadas cadastradas.
            Abaixo está o Top 3 das distribuições que geram o <strong>menor custo mensal</strong> (Headcount necessário para cobrir folgas) e cobrem o volume projetado do Dia de Maior Movimento.
          </p>

          <div className="space-y-4">
            {optResults.slice(0, 3).map((res, idx) => (
              <div key={idx} className={`p-4 rounded-lg border ${idx === 0 ? 'bg-amber-900/20 border-amber-500/50' : 'bg-slate-900/50 border-slate-700'}`}>
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="font-bold text-lg text-white flex items-center gap-2">
                      {idx === 0 && <span className="text-xl">🏆</span>}
                      Opção {idx + 1}
                    </h3>
                    <div className="flex gap-2 mt-2">
                      {res.combo.map((c: string) => (
                        <span key={c} className="bg-slate-700 text-slate-300 text-xs px-2 py-1 rounded">
                          {AVAILABLE_SHIFTS.find(s => s.type === c)?.label}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-slate-400">Headcount Mensal</p>
                    <p className={`text-2xl font-bold ${idx === 0 ? 'text-amber-400' : 'text-blue-400'}`}>{res.totalMonthlyHC} <span className="text-sm font-normal text-slate-500">pessoas</span></p>
                    <p className="text-xs text-slate-500 mt-1">HC Diário (Físico): {res.totalDailyHC}</p>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-slate-700/50 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                  <div className="text-sm text-slate-400">
                    <strong>Distribuição Sugerida:</strong>{' '}
                    {Object.entries(res.hcPerShiftType).map(([type, count]) => (
                      <span key={type} className="inline-block mr-3 mb-1">
                        {count as number}x ({AVAILABLE_SHIFTS.find(s => s.type === type)?.label})
                      </span>
                    ))}
                  </div>

                  {idx === 0 && (
                    <button
                      onClick={() => {
                        setDimEnabledShifts(res.combo);
                        setIsOptModalOpen(false);
                      }}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded font-semibold transition text-sm flex-shrink-0"
                    >
                      Aplicar esta escala
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }
    </div >
  );
}

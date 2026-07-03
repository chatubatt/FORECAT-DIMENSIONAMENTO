import { 
  BarChart3, CalendarDays, History, Layers, TrendingUp, 
  Users, FlaskConical, Save, Minimize2, RotateCcw, Zap
} from 'lucide-react';

export type TabKey = 'forecast' | 'calendario' | 'historico' | 'baseline' | 'previsao_mensal' | 'dimensionamento' | 'metodologia' | 'cenarios' | 'shrinkage' | 'rotacao';

interface NavItem {
  key: TabKey;
  label: string;
  icon: React.ReactNode;
  color: string;
  group: string;
}

const navItems: NavItem[] = [
  { key: 'forecast', label: 'Forecast (7 dias)', icon: <BarChart3 size={18} />, color: 'var(--color-primary)', group: 'Previsão' },
  { key: 'calendario', label: 'Calendário', icon: <CalendarDays size={18} />, color: 'var(--color-primary)', group: 'Previsão' },
  { key: 'historico', label: 'Histórico Anual', icon: <History size={18} />, color: 'var(--color-primary)', group: 'Previsão' },
  { key: 'baseline', label: 'Baseline & Fatores', icon: <Layers size={18} />, color: 'var(--color-primary)', group: 'Previsão' },
  { key: 'previsao_mensal', label: 'Previsão Mensal', icon: <TrendingUp size={18} />, color: 'var(--color-accent-cyan)', group: 'Previsão' },
  { key: 'dimensionamento', label: 'Dimensionamento', icon: <Users size={18} />, color: 'var(--color-accent-orange)', group: 'WFM' },
  { key: 'metodologia', label: 'Metodologia', icon: <FlaskConical size={18} />, color: 'var(--color-accent-violet)', group: 'WFM' },
  { key: 'cenarios', label: 'Cenários Salvos', icon: <Save size={18} />, color: 'var(--color-accent-emerald)', group: 'Análise' },
  { key: 'shrinkage', label: 'Shrinkage', icon: <Minimize2 size={18} />, color: 'var(--color-accent-amber)', group: 'Análise' },
  { key: 'rotacao', label: 'Rotação', icon: <RotateCcw size={18} />, color: 'var(--color-accent-cyan)', group: 'Análise' },
];

interface SidebarProps {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  isOpen: boolean;
  onToggle: () => void;
  hasData: boolean;
}

export default function Sidebar({ activeTab, onTabChange, isOpen, onToggle, hasData }: SidebarProps) {
  const groups = ['Previsão', 'WFM', 'Análise'];

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div className="mobile-overlay md:hidden" onClick={onToggle} />
      )}

      <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
        {/* Logo */}
        <div className="px-5 py-5 flex items-center gap-3 border-b border-[rgba(99,102,241,0.08)]">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center flex-shrink-0">
            <Zap size={18} className="text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold tracking-tight text-[var(--color-text-primary)] truncate">FORECAT</h1>
            <p className="text-[0.625rem] text-[var(--color-text-muted)] uppercase tracking-widest">WFM Intelligence</p>
          </div>
        </div>

        {/* Status indicator */}
        <div className="px-5 py-3 border-b border-[rgba(99,102,241,0.08)]">
          <div className="flex items-center gap-2">
            <div className={`pulse-dot ${hasData ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span className="text-[0.75rem] text-[var(--color-text-secondary)]">
              {hasData ? 'Modelo ativo' : 'Aguardando dados'}
            </span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-3 overflow-y-auto px-1">
          {groups.map(group => (
            <div key={group} className="mb-4">
              <p className="px-4 mb-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                {group}
              </p>
              {navItems.filter(n => n.group === group).map(item => (
                <div
                  key={item.key}
                  className={`sidebar-item ${activeTab === item.key ? 'active' : ''}`}
                  onClick={() => { onTabChange(item.key); if (window.innerWidth < 768) onToggle(); }}
                >
                  <span style={{ color: activeTab === item.key ? item.color : undefined }}>{item.icon}</span>
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-[rgba(99,102,241,0.08)]">
          <div className="text-[0.625rem] text-[var(--color-text-muted)]">
            <p>Erlang C/A &bull; ML Ensemble</p>
            <p className="mt-0.5 opacity-60">v2.0 &mdash; WFM Platform</p>
          </div>
        </div>
      </aside>
    </>
  );
}

export { navItems };
export type { NavItem };
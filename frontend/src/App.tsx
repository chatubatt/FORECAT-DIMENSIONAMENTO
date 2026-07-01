import { useState, useEffect } from 'react';
import { Menu, X } from 'lucide-react';
import Sidebar, { type TabKey } from './components/layout/Sidebar';
import Dashboard from './Dashboard';

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('forecast');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [hasData, setHasData] = useState(false);

  // Listen for data load events from Dashboard
  useEffect(() => {
    const handler = () => setHasData(true);
    window.addEventListener('forecat:data-loaded', handler);
    // Check if data already exists
    if (localStorage.getItem('forecast_scenarios') || localStorage.getItem('staffing_scenarios')) {
      setHasData(true);
    }
    return () => window.removeEventListener('forecat:data-loaded', handler);
  }, []);

  return (
    <div className="flex h-screen bg-[var(--color-bg-deep)] overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        hasData={hasData}
      />

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden main-content bg-grid">
        {/* Top Bar */}
        <header className="flex items-center justify-between px-4 md:px-6 py-3 border-b border-[rgba(99,102,241,0.08)] bg-[var(--color-glass-bg)] backdrop-blur-xl flex-shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="md:hidden w-9 h-9 rounded-lg flex items-center justify-center hover:bg-[var(--color-glass-hover)] transition-colors text-[var(--color-text-secondary)]"
            >
              {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
                {activeTab === 'forecast' && 'Forecast (7 dias)'}
                {activeTab === 'calendario' && 'Calendário'}
                {activeTab === 'historico' && 'Histórico Anual'}
                {activeTab === 'baseline' && 'Baseline & Fatores'}
                {activeTab === 'previsao_mensal' && 'Previsão Mensal'}
                {activeTab === 'dimensionamento' && 'Dimensionamento (Erlang)'}
                {activeTab === 'metodologia' && 'Metodologia de Forecast'}
                {activeTab === 'cenarios' && 'Cenários Salvos'}
                {activeTab === 'shrinkage' && 'Shrinkage'}
                {activeTab === 'whatif' && 'What-If'}
                {activeTab === 'rotacao' && 'Rotação'}
              </h2>
              <p className="text-[0.6875rem] text-[var(--color-text-muted)]">
                Workforce Management Platform
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-bg-surface)] border border-[rgba(99,102,241,0.08)]">
              <div className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-[0.6875rem] text-[var(--color-text-secondary)]">Online</span>
            </div>
          </div>
        </header>

        {/* Dashboard Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-4 md:p-6 lg:p-8">
            <Dashboard activeTab={activeTab} onTabChange={setActiveTab} />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
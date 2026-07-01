import Dashboard from './Dashboard';

function App() {
  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 sm:p-8 font-sans">
      <header className="mb-8">
        <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
          Call Center Forecaster
        </h1>
        <p className="text-slate-400 mt-2">Previsão e Dimensionamento Inteligente</p>
      </header>
      <Dashboard />
    </div>
  );
}

export default App;

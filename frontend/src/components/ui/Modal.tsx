import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
}

export default function Modal({ isOpen, onClose, title, children, maxWidth = 'max-w-2xl' }: ModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div 
        className={`modal-content glass glow-primary w-full ${maxWidth} mx-4 max-h-[85vh] flex flex-col`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[rgba(99,102,241,0.08)]">
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">{title}</h2>
          <button 
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[var(--color-glass-hover)] transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
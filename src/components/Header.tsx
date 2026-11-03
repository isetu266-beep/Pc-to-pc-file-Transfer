import React from 'react';
import { Wifi, Globe } from 'lucide-react';
import { Language, translations } from '../translations';

interface HeaderProps {
  lang: Language;
  onToggleLang: () => void;
  onlineCount?: number;
  isConnected?: boolean;
  pairedPeerName?: string | null;
  onOpenNetworkModal?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  lang,
  onToggleLang,
}) => {
  const t = translations[lang];

  return (
    <header className="flex items-center justify-between gap-6 px-6 py-3.5 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md sticky top-0 z-30">
      {/* Zone 1: Brand title, single element */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-600/30">
          <Wifi className="w-4 h-4 stroke-[2.5]" />
        </div>
        <span className="text-base sm:text-lg font-bold tracking-tight text-white whitespace-nowrap">
          {t.appTitle}
        </span>
      </div>

      {/* Navigation & Controls */}
      <nav className="flex items-center gap-3 text-sm font-medium text-slate-400">
        <button
          onClick={onToggleLang}
          className="hover:text-slate-100 transition-colors whitespace-nowrap flex items-center gap-1.5 text-xs text-slate-300 px-2.5 py-1.5 rounded-lg border border-slate-800 hover:border-slate-700 bg-slate-950/60 cursor-pointer"
          title="Switch Language"
        >
          <Globe className="w-3.5 h-3.5 text-indigo-400" />
          <span>{lang === 'bn' ? 'English' : 'বাংলা'}</span>
        </button>
      </nav>

    </header>
  );
};

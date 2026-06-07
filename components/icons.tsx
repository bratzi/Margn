// Lucide-Stil Inline-SVGs (kein Emoji). stroke=currentColor, erben die Textfarbe.
type P = { size?: number; className?: string };
const S = ({ size = 16, className, children }: P & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    {children}
  </svg>
);

export const Lock = (p: P) => <S {...p}><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></S>;
export const LockOpen = (p: P) => <S {...p}><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></S>;
export const Video = (p: P) => <S {...p}><path d="m16 13 5.2 3.2a.5.5 0 0 0 .8-.4V8.2a.5.5 0 0 0-.8-.4L16 11" /><rect x="2" y="6" width="14" height="12" rx="2" /></S>;
export const Clock = (p: P) => <S {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></S>;
export const FileText = (p: P) => <S {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v5h5" /><path d="M9 13h6M9 17h4" /></S>;
export const ArrowLeft = (p: P) => <S {...p}><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></S>;
export const ArrowRight = (p: P) => <S {...p}><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></S>;
export const External = (p: P) => <S {...p}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></S>;
export const Sun = (p: P) => <S {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></S>;
export const Moon = (p: P) => <S {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></S>;
export const Plus = (p: P) => <S {...p}><circle cx="12" cy="12" r="10" /><path d="M8 12h8M12 8v8" /></S>;
export const Pencil = (p: P) => <S {...p}><path d="M21.2 5.4a2 2 0 0 0-2.6-2.6L4 11.4V20h8.6L21.2 5.4Z" /></S>;
export const Network = (p: P) => <S {...p}><rect x="9" y="2" width="6" height="6" rx="1" /><rect x="2" y="16" width="6" height="6" rx="1" /><rect x="16" y="16" width="6" height="6" rx="1" /><path d="M12 8v4M12 12H5v4M12 12h7v4" /></S>;
export const Folder = (p: P) => <S {...p}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></S>;

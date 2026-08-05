// Ambient declarations for Pulse's incremental checkJs adoption.
// Legacy vanilla-JS code reaches for these DOM/platform APIs without casts;
// these augmentations let tsc --noEmit pass while still type-checking the
// actual logic (string literals, argument types, async flows, etc.).

interface Window {
  Capacitor?: any;
  adsbygoogle?: any[];
  __adsenseScriptLoaded?: boolean;
}

// videoCompress.js tags the returned placeholder File with the Cloudinary URL
interface File {
  _cloudinaryUrl?: string;
}

// --- Legacy DOM usage patterns -------------------------------------------
// The untyped codebase does `querySelector(...).style` / `.value` / `.dataset`
// and `e.target.closest(...)` without narrowing. These optional members make
// that legal without weakening the real DOM lib types (HTMLElement/Element
// keep their full standard definitions).

interface Element {
  style?: CSSStyleDeclaration;
  dataset?: DOMStringMap;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  src?: string;
  currentSrc?: string;
  type?: string;
  files?: FileList | null;
  autocomplete?: string;
  selectionStart?: number | null;
  setSelectionRange?: (start: number, end: number, direction?: string) => void;
  target?: string;
  rel?: string;
  href?: string;
}

interface EventTarget {
  closest?: (selectors: string) => Element | null;
  dataset?: DOMStringMap;
  value?: string;
  files?: FileList | null;
  tagName?: string;
  querySelector?: (selectors: string) => Element | null;
}

// main.js intentionally exposes a few helpers on window for inline onclick
// handlers rendered inside HTML strings (openFullImage, clearReply, …).
interface Window {
  openFullImage?: (url: string) => void;
  openFullMedia?: (url: string, isVideo: boolean) => void;
  clearReply?: () => void;
  openAccountModal?: () => void;
}

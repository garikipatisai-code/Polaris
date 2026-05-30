// Set-of-Marks overlay content script.
//
// Injected on every page. Draws numbered bounding boxes over interactive
// elements on request and returns a marker map for the agent.
//
// Communication:
//   chrome.runtime.onMessage:
//     - { type: 'som.generate' } -> { markers: Marker[] }
//     - { type: 'som.clear' }    -> removes overlay

interface Marker {
  id: number;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
}

interface SomGenerateMessage {
  type: 'som.generate';
}

interface SomClearMessage {
  type: 'som.clear';
}

type SomMessage = SomGenerateMessage | SomClearMessage;

interface SomGenerateResponse {
  ok: true;
  markers: Marker[];
}

interface SomClearResponse {
  ok: true;
}

type SomResponse = SomGenerateResponse | SomClearResponse;

let overlay: HTMLDivElement | null = null;

const PALETTE = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
];

function getUniqueSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parent = el.parentElement;
  if (!parent) return el.tagName.toLowerCase();
  const idx = Array.from(parent.children).indexOf(el as HTMLElement) + 1;
  return `${getUniqueSelector(parent)} > ${el.tagName.toLowerCase()}:nth-child(${idx})`;
}

function clearOverlay(): void {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}

function createOverlay(markers: Marker[]): void {
  clearOverlay();
  overlay = document.createElement('div');
  overlay.id = 'polaris-som-overlay';
  overlay.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';
  document.body.appendChild(overlay);

  for (const m of markers) {
    const box = document.createElement('div');
    const color = PALETTE[m.id % PALETTE.length];
    box.style.cssText =
      `position:absolute;left:${m.rect.x}px;top:${m.rect.y}px;width:${m.rect.width}px;height:${m.rect.height}px;border:2px solid ${color};box-sizing:border-box;`;
    const label = document.createElement('span');
    label.style.cssText =
      `position:absolute;top:-14px;left:-2px;background:${color};color:#000;font:bold 11px/14px monospace;padding:0 3px;border-radius:2px;`;
    label.textContent = String(m.id);
    box.appendChild(label);
    overlay.appendChild(box);
  }
}

chrome.runtime.onMessage.addListener(
  (msg: unknown, _sender, sendResponse: (response: SomResponse) => void) => {
    const message = msg as SomMessage;
    if (message.type === 'som.clear') {
      clearOverlay();
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'som.generate') {
      const elements = document.querySelectorAll<HTMLElement>(
        'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"], [role="link"], [role="checkbox"], [role="combobox"]',
      );
      const markers: Marker[] = [];
      const seen = new WeakSet<Element>();

      elements.forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.width > window.innerWidth || rect.height > window.innerHeight) return;
        markers.push({
          id: markers.length,
          selector: getUniqueSelector(el),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      });

      createOverlay(markers);
      sendResponse({ ok: true, markers });
      return true;
    }
    return false;
  },
);

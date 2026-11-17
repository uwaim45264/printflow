/**
 * Direct printing through QZ Tray (https://qz.io), a free program the shop installs once on its computer.
 * The web page sends the print file plus the customer's settings (copies, paper size, colour, sides) to QZ Tray,
 * which prints on the chosen printer with exactly those settings — no browser print dialog.
 *
 * Settings are kept per computer (this browser), because printers belong to the computer, not the shop account.
 */
import type { ColorMode, PaperSize, Sides } from '../shared/types';

const ENABLED_KEY = 'printflow:direct-print';
const PRINTER_KEY = 'printflow:direct-printer';

export const QZ_DOWNLOAD_URL = 'https://qz.io/download/';

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
};

export interface DirectPrintSettings {
  enabled: boolean;
  printer: string | null;
}

export function getDirectPrintSettings(): DirectPrintSettings {
  return { enabled: read(ENABLED_KEY) === '1', printer: read(PRINTER_KEY) };
}

export function saveDirectPrintSettings(s: DirectPrintSettings) {
  write(ENABLED_KEY, s.enabled ? '1' : null);
  write(PRINTER_KEY, s.printer);
}

/** True when direct printing is switched on and a printer is chosen on this computer. */
export const directPrintReady = () => {
  const s = getDirectPrintSettings();
  return s.enabled && !!s.printer;
};

type Qz = typeof import('qz-tray').default;
let qzLoad: Promise<Qz> | null = null;

async function qz(): Promise<Qz> {
  qzLoad ??= import('qz-tray').then((m) => {
    const q = ((m as unknown as { default?: Qz }).default ?? (m as unknown as Qz)) as Qz;
    // No signing certificate: QZ Tray asks the shop to allow PrintFlow (it can remember the choice once trusted).
    q.security.setCertificatePromise((resolve) => resolve());
    q.security.setSignaturePromise(() => (resolve) => resolve());
    return q;
  });
  return qzLoad;
}

/** Connects to QZ Tray on this computer. Throws a readable error if it is not installed or not running. */
export async function connect(): Promise<Qz> {
  const q = await qz();
  if (!q.websocket.isActive()) {
    try {
      await q.websocket.connect({ retries: 1, delay: 1 });
    } catch {
      throw new Error('QZ Tray is not running on this computer. Install it (qz.io/download) and start it, then try again.');
    }
  }
  return q;
}

export async function listPrinters(): Promise<{ printers: string[]; defaultPrinter: string | null }> {
  const q = await connect();
  const found = await q.printers.find();
  const printers = (Array.isArray(found) ? found : [found]).filter(Boolean);
  const defaultPrinter = await q.printers.getDefault().catch(() => null);
  return { printers, defaultPrinter };
}

// Paper sizes in millimetres.
const PAPER_MM: Record<PaperSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A3: { width: 297, height: 420 },
  Legal: { width: 215.9, height: 355.6 },
};

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export interface DirectJob {
  printer: string;
  pdf: Blob;
  copies: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: Sides;
  jobName: string;
}

/** Prints the PDF on the printer with the customer's settings. */
export async function printDirect(job: DirectJob): Promise<void> {
  const q = await connect();
  const config = q.configs.create(job.printer, {
    copies: Math.max(1, Math.round(job.copies)),
    colorType: job.colorMode === 'bw' ? 'grayscale' : 'color',
    duplex: job.sides === 'double' ? 'long-edge' : 'one-sided',
    size: PAPER_MM[job.paperSize] ?? PAPER_MM.A4,
    units: 'mm',
    orientation: 'portrait',
    scaleContent: true,
    jobName: job.jobName,
  });
  await q.print(config, [{ type: 'pixel', format: 'pdf', flavor: 'base64', data: await toBase64(job.pdf) }]);
}

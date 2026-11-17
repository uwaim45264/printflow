import { useEffect, useState } from 'react';
import { ExternalLink, Printer, RefreshCw } from 'lucide-react';
import { Alert, Badge, Button, Card, CardHeader, Field, Select } from '../../components/ui';
import { useToast } from '../../components/toast';
import { getDirectPrintSettings, listPrinters, QZ_DOWNLOAD_URL, saveDirectPrintSettings } from '../../lib/directPrint';

/** Shop Settings: print straight to a printer with the customer's settings, through QZ Tray on this computer. */
export function DirectPrintCard() {
  const toast = useToast();
  const [settings, setSettings] = useState(getDirectPrintSettings);
  const [printers, setPrinters] = useState<string[] | null>(null);
  const [status, setStatus] = useState<'idle' | 'checking' | 'connected' | 'missing'>('idle');
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setStatus('checking');
    setError(null);
    try {
      const { printers: list, defaultPrinter } = await listPrinters();
      setPrinters(list);
      setStatus('connected');
      if (!settings.printer && (defaultPrinter || list[0])) update({ ...settings, printer: defaultPrinter || list[0] });
    } catch (err) {
      setStatus('missing');
      setError(err instanceof Error ? err.message : 'Could not reach QZ Tray.');
    }
  };

  const update = (next: typeof settings) => {
    setSettings(next);
    saveDirectPrintSettings(next);
  };

  useEffect(() => {
    if (settings.enabled) void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card className="h-fit">
      <CardHeader
        title="Direct printing"
        description="Print orders straight to your printer with the customer’s copies, paper size, colour and sides — no print dialog."
        action={
          status === 'connected' ? <Badge tone="success">Connected</Badge> : status === 'missing' ? <Badge tone="danger">Not found</Badge> : undefined
        }
      />
      <div className="space-y-4 p-5 sm:p-6">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
          <li>
            Install the free <strong className="text-ink">QZ Tray</strong> program on this computer and start it.{' '}
            <a href={QZ_DOWNLOAD_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-gold-ink hover:underline">
              Download <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </li>
          <li>Turn on direct printing below and choose your printer.</li>
          <li>When QZ Tray asks, allow PrintFlow (tick “Remember this decision” if offered).</li>
        </ol>

        <label className="flex items-center gap-3 text-sm font-semibold text-ink">
          <input
            type="checkbox"
            className="size-4 accent-[#7a5c14]"
            checked={settings.enabled}
            onChange={(e) => {
              update({ ...settings, enabled: e.target.checked });
              if (e.target.checked) void refresh();
            }}
          />
          Use direct printing on this computer
        </label>

        {settings.enabled && (
          <>
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Printer">
              {(p) => (
                <div className="flex gap-2">
                  <Select
                    {...p}
                    className="flex-1"
                    value={settings.printer ?? ''}
                    disabled={!printers?.length}
                    onChange={(e) => {
                      update({ ...settings, printer: e.target.value || null });
                      toast('success', 'Printer saved', e.target.value);
                    }}
                  >
                    {!printers?.length && <option value="">{settings.printer ?? 'No printers found'}</option>}
                    {printers?.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </Select>
                  <Button variant="secondary" className="w-11 shrink-0 px-0" aria-label="Find printers" loading={status === 'checking'} onClick={refresh}>
                    <RefreshCw className="size-4" />
                  </Button>
                </div>
              )}
            </Field>
            <p className="flex items-start gap-2 text-xs text-muted">
              <Printer className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Saved on this computer only. Each computer that prints needs QZ Tray and its own printer choice.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
